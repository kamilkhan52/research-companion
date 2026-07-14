// A small from-scratch force-directed layout (no d3/graph-library dependency, so the graph
// screen ships as pure JS with zero new native surface). At this app's scale — a project's
// papers plus their external references, realistically tens to a couple hundred nodes — a
// synchronous O(n^2 * iterations) spring simulation computed once (memoized) and re-run only
// when the graph's shape actually changes is comfortably fast on-device.

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

export interface LayoutResult {
  positions: Record<string, LayoutPoint>;
  width: number;
  height: number;
  /** True when positions carry the server layout's meaning (X = time, Y = citation impact) —
   *  the canvas only draws its axis legend then; a client force-sim fallback has no axes. */
  semantic?: boolean;
}

interface ForceLayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
  seed?: number;
}

/** Deterministic PRNG so identical input always lays out identically (no visual jitter
 * across re-renders/re-fetches of the same graph shape). */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPULSION = 20000;
const SPRING_LENGTH = 170;
const SPRING_STRENGTH = 0.02;
const CENTER_STRENGTH = 0.006;
const STEP = 0.6;

export function computeForceLayout(
  nodeIds: string[],
  edges: LayoutEdgeInput[],
  options: ForceLayoutOptions = {},
): LayoutResult {
  const width = options.width ?? 1600;
  const height = options.height ?? 1600;
  const iterations = options.iterations ?? 220;
  const rand = mulberry32(options.seed ?? 42);
  const n = nodeIds.length;
  if (n === 0) return { positions: {}, width, height };

  const indexOf: Record<string, number> = {};
  nodeIds.forEach((id, i) => (indexOf[id] = i));

  const cx = width / 2;
  const cy = height / 2;
  const ringRadius = Math.min(width, height) * 0.35;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const angle = (i / Math.max(n, 1)) * Math.PI * 2;
    const jitter = (rand() - 0.5) * 24;
    x[i] = cx + Math.cos(angle) * ringRadius + jitter;
    y[i] = cy + Math.sin(angle) * ringRadius + jitter;
  }

  const edgePairs: Array<[number, number]> = [];
  for (const e of edges) {
    const a = indexOf[e.source];
    const b = indexOf[e.target];
    if (a !== undefined && b !== undefined && a !== b) edgePairs.push([a, b]);
  }

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  for (let iter = 0; iter < iterations; iter++) {
    fx.fill(0);
    fy.fill(0);
    const damp = 1 - iter / iterations;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i] - x[j];
        let dy = y[i] - y[j];
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const dist = Math.sqrt(distSq);
        const force = REPULSION / distSq;
        const ux = dx / dist;
        const uy = dy / dist;
        fx[i] += ux * force;
        fy[i] += uy * force;
        fx[j] -= ux * force;
        fy[j] -= uy * force;
      }
    }

    for (const [a, b] of edgePairs) {
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const displacement = dist - SPRING_LENGTH;
      const force = displacement * SPRING_STRENGTH;
      const ux = dx / dist;
      const uy = dy / dist;
      fx[a] += ux * force;
      fy[a] += uy * force;
      fx[b] -= ux * force;
      fy[b] -= uy * force;
    }

    for (let i = 0; i < n; i++) {
      fx[i] += (cx - x[i]) * CENTER_STRENGTH;
      fy[i] += (cy - y[i]) * CENTER_STRENGTH;
    }

    for (let i = 0; i < n; i++) {
      x[i] += fx[i] * damp * STEP;
      y[i] += fy[i] * damp * STEP;
    }
  }

  const positions: Record<string, LayoutPoint> = {};
  nodeIds.forEach((id, i) => {
    positions[id] = { x: x[i], y: y[i] };
  });
  return { positions, width, height };
}
