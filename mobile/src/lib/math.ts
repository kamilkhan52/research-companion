// TeX rendering for the scholarly chat (polish plan G.1). Two layers, both degrading
// gracefully:
//
//  - `texToSvg` — MathJax (mathjax-full, pure JS, runs fine under Hermes) converts TeX to a
//    self-contained SVG whose glyphs are paths, so no fonts, no WebView, and it renders as a
//    native view via react-native-svg (fast inside the inverted chat list, crisp at any zoom).
//  - `texToPlain` — a modest unicode approximation used wherever SVG isn't available: the
//    pre-rebuild dev client (react-native-svg is a native module — guarded require below,
//    same pattern as lib/haptics), a MathJax failure, or jest.
//
// Never import 'react-native-svg' directly elsewhere — take `SvgXml` from here so the
// availability guard stays in one place.

let cachedSvgXml: unknown | null | undefined;

export function getSvgXml(): unknown | null {
  if (cachedSvgXml === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cachedSvgXml = require('react-native-svg').SvgXml ?? null;
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

// MathJax document, created lazily so app startup never pays the init cost.
let mathDocument: { convert: (tex: string, options: { display: boolean }) => unknown } | null = null;
let mathAdaptor: { outerHTML: (node: unknown) => string; firstChild: (node: unknown) => unknown } | null = null;
let mathJaxBroken = false;

function ensureMathJax(): boolean {
  if (mathJaxBroken) return false;
  if (mathDocument) return true;
  try {
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
const SVG_CACHE_MAX = 300;

function attr(svg: string, name: string): number {
  const m = new RegExp(`${name}="([-\\d.]+)ex"`).exec(svg);
  return m ? parseFloat(m[1]) : 0;
}

/** TeX → self-contained SVG. Returns null when MathJax can't handle the input (the caller
 * falls back to `texToPlain`). Cached — chat lists re-render the same formulas constantly. */
export function texToSvg(tex: string, display: boolean): RenderedMath | null {
  const key = `${display ? 'D' : 'I'}|${tex}`;
  const hit = svgCache.get(key);
  if (hit !== undefined) return hit;
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
  if (svgCache.size >= SVG_CACHE_MAX) svgCache.clear();
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
