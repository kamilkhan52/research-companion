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

/** A modest, readable unicode approximation of TeX — NOT a renderer. Good enough that a
 * formula on the pre-rebuild client reads as math rather than markup. */
export function texToPlain(tex: string): string {
  let s = tex;
  // Structural commands first, innermost-out for nesting.
  for (let pass = 0; pass < 4; pass++) {
    const before = s;
    s = s
      .replace(/\\(?:operatorname|text|mathrm|mathbf|mathit|mathcal|boldsymbol)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
    if (s === before) break;
  }
  s = s
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b\.?/g, '')
    .replace(/\\[,;:!]|\\quad|\\qquad/g, ' ')
    .replace(/\\\|/g, '‖')
    .replace(/\\\\/g, '; ')
    .replace(/\\(?:arg)\s*\\?(min|max)/gi, 'arg $1')
    .replace(/[\^]\{([^{}]*)\}/g, (_m, body: string) => toScript(body, SUPERSCRIPTS, '^'))
    .replace(/_\{([^{}]*)\}/g, (_m, body: string) => toScript(body, SUBSCRIPTS, '_'))
    .replace(/\^(\S)/g, (_m, c: string) => SUPERSCRIPTS[c] ?? `^${c}`)
    .replace(/_(\S)/g, (_m, c: string) => SUBSCRIPTS[c] ?? `_${c}`)
    .replace(/\\([a-zA-Z]+)/g, (_m, name: string) => GREEK[name] ?? SYMBOLS[name] ?? name)
    .replace(/[{}]/g, '')
    .replace(/\s{2,}/g, ' ');
  return s.trim();
}

function toScript(body: string, map: Record<string, string>, prefix: string): string {
  const chars = [...body];
  if (chars.length && chars.every((c) => map[c] !== undefined)) {
    return chars.map((c) => map[c]).join('');
  }
  return `${prefix}(${body})`;
}
