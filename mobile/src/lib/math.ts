// TeX rendering for the scholarly chat (polish plan G.1). Two layers, both degrading
// gracefully:
//
//  - `texToSvg` — MathJax (mathjax-full, pure JS, runs fine under Hermes) converts TeX to a
//    self-contained SVG whose glyphs are paths, so no fonts, no WebView, and it renders as a
//    native view via react-native-svg (fast inside the inverted chat list, crisp at any zoom).
//  - `texToPlain` — a modest unicode approximation used wherever SVG isn't available: the
//    pre-rebuild dev client (react-native-svg's native views aren't linked yet — the
//    `svgNativeLinked` probe below gates on that, not just the JS require), a MathJax failure,
//    or jest.
//
// Never import 'react-native-svg' directly elsewhere — take `SvgXml` from here so the
// availability guard stays in one place.

// react-native-svg's JS resolves even when its NATIVE side isn't linked (e.g. the pre-rebuild
// dev client, which bundles the JS but has no RNSVG native views). Rendering an <SvgXml> then
// hard-crashes at mount — `Can't find ViewManager 'RNSVGPath'`. So the JS `require` succeeding
// is NOT enough; we must confirm the native module is present. On the New Architecture that's
// the TurboModule RNSVGRenderableModule (react-native-svg registers it alongside its view
// managers); on the old bridge it's the legacy view-manager config. Both are non-throwing
// probes — `.get`, not `.getEnforcing` — and reflect the same native lib the RNSVG* views need.
function svgNativeLinked(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RN = require('react-native');
    if (RN?.TurboModuleRegistry?.get) {
      return RN.TurboModuleRegistry.get('RNSVGRenderableModule') != null;
    }
    return !!RN?.UIManager?.hasViewManagerConfig?.('RNSVGPath');
  } catch {
    return false;
  }
}

let cachedSvgXml: unknown | null | undefined;

export function getSvgXml(): unknown | null {
  if (cachedSvgXml === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cachedSvgXml = (svgNativeLinked() ? require('react-native-svg').SvgXml : null) ?? null;
    } catch {
      cachedSvgXml = null;
    }
  }
  return cachedSvgXml ?? null;
}

export interface RenderedMath {
  svg: string;
  /** Layout size in ex units (multiply by the font's ex height in px). */
  widthEx: number;
  heightEx: number;
  /** Downward baseline shift in ex units (MathJax emits it as a negative vertical-align). */
  depthEx: number;
}

export interface MathFit {
  /** Pixel width to draw the SVG at. */
  width: number;
  /** Pixel height to draw the SVG at. */
  height: number;
  /** True when the equation is too wide to shrink readably and should scroll horizontally. */
  scroll: boolean;
}

/**
 * Decide how a display equation lays out against the available column width:
 *   - fits as-is                       → natural size, centered (scroll:false)
 *   - moderately too wide (≥ minScale) → scaled down to fit exactly, centered (scroll:false)
 *   - far too wide (< minScale)        → natural size, horizontal scroll (scroll:true)
 * SVG scales losslessly, so shrinking a *slightly* oversized formula reads better than a scroll
 * strip — a swipe affordance for a 3% overflow is worse than just fitting it. `availW` of 0
 * (pre-layout) renders natural size — the first onLayout settles it.
 *
 * `minScale` is a legibility floor, not a layout preference. Display math renders at fontSize
 * 17, so the old 0.6 floor let anything up to 1.67x the column width shrink to ~10px before it
 * would scroll — which on a phone is the common case for a real equation, and it was reported
 * as equations simply not fitting. 0.9 keeps the smallest shrunk formula at ~15px and sends
 * everything wider to the scroll strip at full size, because reading one line by swiping beats
 * reading all of it too small to parse.
 */
export function fitMathBlock(
  naturalW: number,
  naturalH: number,
  availW: number,
  minScale = 0.9,
): MathFit {
  if (!availW || naturalW <= availW) return { width: naturalW, height: naturalH, scroll: false };
  const scale = availW / naturalW;
  if (scale >= minScale) return { width: availW, height: naturalH * scale, scroll: false };
  return { width: naturalW, height: naturalH, scroll: true };
}

// ---- multi-line wrapping for over-wide display math (DR-098) -------------------------------
//
// MathJax v3 emits one indivisible SVG — it cannot line-break. But the equations LLMs write
// are usually top-level CHAINS (A → B → C, or x = y = z), and those break naturally at their
// own connectives. So before an over-wide equation falls back to the horizontal scroll strip
// (which Kamil read as "cut off"), we try splitting its TeX at top-level arrows/relations and
// stacking the pieces as separate display lines — his explicitly sanctioned "multiple lines".
// The break happens BEFORE the operator (each continuation line leads with its arrow), the
// standard convention for displayed math.

/** Connectives worth breaking at, in preference order: arrows first (sequence/dataflow chains
 *  — splitting a chain at `=` when arrows exist would cut mid-step), then relations. */
const ARROW_COMMANDS = new Set([
  'rightarrow', 'to', 'Rightarrow', 'longrightarrow', 'Longrightarrow', 'mapsto',
  'leftarrow', 'Leftarrow', 'implies', 'iff',
]);
const RELATION_COMMANDS = new Set([
  'approx', 'le', 'leq', 'ge', 'geq', 'neq', 'ne', 'sim', 'simeq', 'propto', 'equiv',
]);
/** Tier-2 operators: the terms of a top-level sum/difference are semantic units, so one per
 *  line is the conventional break for a long expression that has no relation left to break at. */
const OPERATOR_COMMANDS = new Set(['pm', 'mp', 'cdot', 'times', 'oplus', 'otimes']);

export const SPLIT_TIER = {
  ARROW: 0,
  RELATION: 1,
  OPERATOR: 2,
  /** Commas of an argument list exactly one delimiter deep — `\min(a, b, c)`. */
  ARGUMENT: 3,
} as const;
const LAST_TIER = SPLIT_TIER.ARGUMENT;

export interface TexSplit {
  pieces: string[];
  /** Which tier produced these pieces; a piece that is STILL too wide re-splits at tier+1. */
  tier: number;
}

interface Point {
  /** Character index of the break. */
  at: number;
  tier: number;
  /** Break after the character (argument commas) rather than before it (connectives). */
  after?: boolean;
  /** The break sits inside a `\left…\right` group, so the two halves need rebalancing. */
  insideLeft?: boolean;
}

/** Is the character before `i` something a `+`/`-` would be the SIGN of rather than a binary
 *  operator between two terms? A leading or post-operator minus must never start a line. */
function isUnaryPosition(tex: string, i: number): boolean {
  const before = tex.slice(0, i).trimEnd();
  if (!before) return true;
  return /[=+\-*/^_(,[{<>]$/.test(before) || /\\[a-zA-Z]+$/.test(before);
}

/**
 * Find every candidate break in display-math TeX, tagged with the tier it belongs to.
 *
 * Depth is a STACK of delimiter kinds, not a counter, because the tiers care about *which*
 * delimiter encloses a position: `{…}`, `\begin{…}…\end{…}` and `\text{…}` bodies are atomic at
 * every tier, while a `\left(…\right)` or plain `(…)` argument list is breakable at its commas
 * (tier 3) even though it is not top level. Escaped braces (`\{`) are commands, not delimiters.
 */
function scanPoints(tex: string): Point[] {
  const points: Point[] = [];
  const stack: ('brace' | 'left' | 'env' | 'paren')[] = [];
  const top = () => (stack.length === 0);
  const inOneGroup = () =>
    stack.length === 1 && (stack[0] === 'left' || stack[0] === 'paren');
  let i = 0;
  while (i < tex.length) {
    const c = tex[i];
    if (c === '\\') {
      const cmd = /^\\([a-zA-Z]+)/.exec(tex.slice(i));
      if (cmd) {
        const name = cmd[1];
        if (name === 'left' || name === 'right') {
          if (name === 'left') stack.push('left');
          else stack.pop();
          // The delimiter character itself belongs to the command — skipping it keeps a
          // `\left(` from also pushing a 'paren' (and `\right)` from popping twice).
          i += cmd[0].length;
          if (i < tex.length && tex[i] !== '\\') i += 1;
          continue;
        }
        // \begin{env} / \end{env}: the name braces that follow balance themselves, so only the
        // command itself moves the stack.
        if (name === 'begin') stack.push('env');
        else if (name === 'end') stack.pop();
        else if (top() && ARROW_COMMANDS.has(name)) points.push({ at: i, tier: SPLIT_TIER.ARROW });
        else if (top() && RELATION_COMMANDS.has(name)) {
          points.push({ at: i, tier: SPLIT_TIER.RELATION });
        } else if (top() && OPERATOR_COMMANDS.has(name)) {
          points.push({ at: i, tier: SPLIT_TIER.OPERATOR });
        }
        i += cmd[0].length;
        continue;
      }
      i += 2; // an escaped symbol: \{ \} \, \\ …
      continue;
    }
    if (c === '{') stack.push('brace');
    else if (c === '(' || c === '[') stack.push('paren');
    else if (c === '}' || c === ')' || c === ']') stack.pop();
    else if (top() && c === '=') points.push({ at: i, tier: SPLIT_TIER.RELATION });
    else if (top() && (c === '+' || c === '-') && !isUnaryPosition(tex, i)) {
      points.push({ at: i, tier: SPLIT_TIER.OPERATOR });
    } else if (c === ',' && inOneGroup()) {
      points.push({ at: i, tier: SPLIT_TIER.ARGUMENT, after: true, insideLeft: stack[0] === 'left' });
    }
    i++;
  }
  return points;
}

/** Keep at most `target - 1` of `points`, spread evenly by character position, so an argument
 *  list becomes a few balanced lines rather than one line per argument. */
function thin(points: Point[], target: number, length: number): Point[] {
  if (target < 2 || points.length + 1 <= target) return points;
  const kept: Point[] = [];
  for (let k = 1; k < target; k++) {
    const want = (length * k) / target;
    let best = points[0];
    for (const p of points) {
      if (Math.abs(p.at - want) < Math.abs(best.at - want)) best = p;
    }
    if (!kept.includes(best)) kept.push(best);
  }
  return kept.sort((a, b) => a.at - b.at);
}

/**
 * Split over-wide display-math TeX into stacked lines, or return null when there is no safe
 * split left. Tiers are tried in order from `fromTier`: top-level arrows, then top-level
 * relations, then top-level `+`/`-`, then the commas of an argument list one delimiter deep.
 * The caller re-splits any line that is STILL too wide at `tier + 1`, which is what makes a
 * chain like `A = \min(b, c, d, e)` reachable — the first split leaves one enormous line, and
 * only the tier below it can break that line further.
 *
 * `targetPieces` (the caller's overflow ratio) only thins the argument tier: relations and
 * operator terms are semantic units worth their own line, but a six-argument list reads better
 * as two balanced lines than as six stubs.
 */
export function splitTexForLines(
  tex: string,
  fromTier: number = SPLIT_TIER.ARROW,
  targetPieces = 0,
): TexSplit | null {
  if (fromTier > LAST_TIER) return null;
  const all = scanPoints(tex);
  for (let tier = fromTier; tier <= LAST_TIER; tier++) {
    let points = all.filter((p) => p.tier === tier);
    if (points.length === 0) continue;
    if (tier === SPLIT_TIER.ARGUMENT) points = thin(points, targetPieces, tex.length);
    const pieces: string[] = [];
    let start = 0;
    let openedInsideLeft = false;
    for (const p of points) {
      const cut = p.after ? p.at + 1 : p.at;
      let piece = tex.slice(start, cut).trim();
      if (piece) {
        // MathJax REJECTS an unbalanced `\left` outright (`data-mjx-error`), which would drop
        // the whole formula to the plain-text fallback — so a line that opens or closes inside
        // a `\left…\right` group gets the null-delimiter halves that make it balanced alone.
        if (openedInsideLeft) piece = `\\left.${piece}`;
        if (p.insideLeft) piece = `${piece}\\right.`;
        pieces.push(piece);
      }
      openedInsideLeft = !!p.insideLeft;
      start = cut;
    }
    let tail = tex.slice(start).trim();
    if (tail) {
      if (openedInsideLeft) tail = `\\left.${tail}`;
      pieces.push(tail);
    }
    // No tiny-piece guard: this only runs on equations already too wide to fit, where even an
    // uneven split ("A" + a long tail) beats the scroll strip. Short equations never get here.
    if (pieces.length < 2) continue;
    return { pieces, tier };
  }
  return null;
}

// MathJax document, created lazily so app startup never pays the init cost.
let mathDocument: { convert: (tex: string, options: { display: boolean }) => unknown } | null = null;
let mathAdaptor: { outerHTML: (node: unknown) => string; firstChild: (node: unknown) => unknown } | null = null;
let mathJaxBroken = false;

function ensureMathJax(): boolean {
  if (mathJaxBroken) return false;
  if (mathDocument) return true;
  try {
    // mathjax-full/js/components/version.js reads its own version via `eval('require')` at
    // module load. Hermes has no `require` in eval scope, so importing mathjax throws
    // (ReferenceError: Property 'require' doesn't exist) and every equation silently stays on
    // the texToPlain fallback — even once react-native-svg is linked. Pre-defining
    // PACKAGE_VERSION makes version.js take its literal branch and skip the eval entirely (the
    // value is cosmetic — it's only exported as VERSION). `??=` so we never clobber a real one.
    (globalThis as unknown as { PACKAGE_VERSION?: string }).PACKAGE_VERSION ??= '3.2.1';
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { mathjax } = require('mathjax-full/js/mathjax');
    const { TeX } = require('mathjax-full/js/input/tex');
    const { SVG } = require('mathjax-full/js/output/svg');
    const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor');
    const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html');
    // Explicit package requires: the AllPackages bundle drags in several hundred KB we
    // don't need, and each package registers itself on import.
    require('mathjax-full/js/input/tex/ams/AmsConfiguration');
    require('mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration');
    require('mathjax-full/js/input/tex/newcommand/NewcommandConfiguration');
    /* eslint-enable @typescript-eslint/no-var-requires */
    mathAdaptor = liteAdaptor();
    RegisterHTMLHandler(mathAdaptor);
    mathDocument = mathjax.document('', {
      InputJax: new TeX({ packages: ['base', 'ams', 'noundefined', 'newcommand'] }),
      OutputJax: new SVG({ fontCache: 'local' }),
    });
    return true;
  } catch {
    mathJaxBroken = true;
    return false;
  }
}

const svgCache = new Map<string, RenderedMath | null>();
/** Exported for the LRU eviction test, which needs to fill the cache exactly. */
export const SVG_CACHE_MAX = 300;

function attr(svg: string, name: string): number {
  const m = new RegExp(`${name}="([-\\d.]+)ex"`).exec(svg);
  return m ? parseFloat(m[1]) : 0;
}

/** TeX → self-contained SVG. Returns null when MathJax can't handle the input (the caller
 * falls back to `texToPlain`). Cached with LRU eviction — chat lists re-render the same
 * formulas constantly, and eviction must be one-at-a-time: the cache used to CLEAR wholesale
 * when full, and streaming turns mint a fresh key for every partial TeX span as a formula
 * arrives, so one math-heavy turn could wipe the cache and force every visible equation on
 * screen to re-convert at once. */
export function texToSvg(tex: string, display: boolean): RenderedMath | null {
  const key = `${display ? 'D' : 'I'}|${tex}`;
  const hit = svgCache.get(key);
  if (hit !== undefined) {
    // Refresh recency: a Map iterates in insertion order, so re-inserting makes the eviction
    // below drop the least-recently-USED key, not merely the oldest-inserted.
    svgCache.delete(key);
    svgCache.set(key, hit);
    return hit;
  }
  let result: RenderedMath | null = null;
  if (ensureMathJax()) {
    try {
      const node = mathDocument!.convert(tex, { display });
      const svg = mathAdaptor!.outerHTML(mathAdaptor!.firstChild(node));
      if (svg.startsWith('<svg') && !svg.includes('data-mjx-error')) {
        const depth = /vertical-align:\s*(-?[\d.]+)ex/.exec(svg);
        result = {
          svg,
          widthEx: attr(svg, 'width'),
          heightEx: attr(svg, 'height'),
          depthEx: depth ? -parseFloat(depth[1]) : 0,
        };
      }
    } catch {
      result = null;
    }
  }
  while (svgCache.size > 0 && svgCache.size >= SVG_CACHE_MAX) {
    svgCache.delete(svgCache.keys().next().value as string);
  }
  svgCache.set(key, result);
  return result;
}

// ---- plain-text fallback ----

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const SYMBOLS: Record<string, string> = {
  cdot: '·', times: '×', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠',
  ne: '≠', approx: '≈', sim: '~', infty: '∞', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π',
  int: '∫', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
  rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', mapsto: '↦',
  forall: '∀', exists: '∃', propto: '∝', star: '★', ast: '∗', circ: '∘', bullet: '•',
  ldots: '…', cdots: '⋯', dots: '…', prime: '′', ell: 'ℓ', hbar: 'ℏ', angle: '∠',
  sqrt: '√', top: '⊤', bot: '⊥', mid: '|', Vert: '‖', vert: '|',
};

const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸',
  '9': '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ', '*': '*',
};
const SUBSCRIPTS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈',
  '9': '₉', '+': '₊', '-': '₋', i: 'ᵢ', j: 'ⱼ', n: 'ₙ', x: 'ₓ', t: 'ₜ', k: 'ₖ', m: 'ₘ',
};

const ACCENTS: Record<string, string> = {
  hat: '\u0302', bar: '\u0304', tilde: '\u0303', vec: '\u20d7', dot: '\u0307',
  ddot: '\u0308', overline: '\u0305', underline: '\u0332',
};

const DOUBLE_STRUCK: Record<string, string> = {
  C: 'ℂ', E: '𝔼', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ',
};

/** A modest, readable unicode approximation of TeX — NOT a renderer. Good enough that a
 * formula on the pre-rebuild client reads as math rather than markup. */
export function texToPlain(tex: string): string {
  let s = tex;
  // Structural commands first, innermost-out for nesting.
  for (let pass = 0; pass < 4; pass++) {
    const before = s;
    s = s
      .replace(/\\(?:operatorname|text|mathrm|mathbf|mathit|mathcal|boldsymbol)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\mathbb\s*\{([^{}]*)\}/g, (_m, body: string) =>
        [...body].map((c) => DOUBLE_STRUCK[c] ?? c).join(''))
      .replace(/\\(hat|bar|tilde|vec|dot|ddot|overline|underline)\s*\{([^{}]*)\}/g,
        (_m, name: string, body: string) => decorate(body, ACCENTS[name]))
      .replace(/\\binom\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, 'C($1, $2)')
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
    if (s === before) break;
  }
  s = s
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b\.?/g, '')
    .replace(/\\[,;:!]|\\quad|\\qquad/g, ' ')
    .replace(/\\\|/g, '‖')
    .replace(/\\\\/g, '; ')
    // Protect escaped set braces while structural TeX grouping braces are stripped below.
    .replace(/\\\{/g, '\uE000')
    .replace(/\\\}/g, '\uE001')
    .replace(/\\([%#$&_])/g, '$1')
    .replace(/\\(?:arg)\s*\\?(min|max)/gi, 'arg $1')
    .replace(/[\^]\{([^{}]*)\}/g, (_m, body: string) => toScript(body, SUPERSCRIPTS, '^'))
    .replace(/_\{([^{}]*)\}/g, (_m, body: string) => toScript(body, SUBSCRIPTS, '_'))
    .replace(/\^([0-9+\-niT*])/g,
      (_m, c: string) => SUPERSCRIPTS[c] ?? `^${c}`)
    .replace(/_([0-9+\-ijnxtkm])(?![A-Za-z])/g,
      (_m, c: string) => SUBSCRIPTS[c] ?? `_${c}`)
    .replace(/\\([a-zA-Z]+)/g, (_m, name: string) => GREEK[name] ?? SYMBOLS[name] ?? name)
    .replace(/[{}]/g, '')
    .replace(/\uE000/g, '{')
    .replace(/\uE001/g, '}')
    .replace(/\s{2,}/g, ' ');
  return s.trim();
}

function decorate(body: string, mark: string): string {
  return [...body].map((c) => /\s/.test(c) ? c : `${c}${mark}`).join('');
}

function toScript(body: string, map: Record<string, string>, prefix: string): string {
  const normalized = body.replace(/^\\(min|max|sup|inf|lim)$/, '$1');
  const chars = [...normalized];
  if (chars.length && chars.every((c) => map[c] !== undefined)) {
    return chars.map((c) => map[c]).join('');
  }
  if (prefix === '_' && /^[A-Za-z]+$/.test(normalized)) return `_${normalized}`;
  return `${prefix}(${normalized})`;
}
