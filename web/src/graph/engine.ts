import * as d3 from 'd3';
import type { GraphNode, GraphEdge, GraphRecommendation } from '@/api/graph-types';

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  kind: string;
  isRecommendation: boolean;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  significant: boolean;
}

export interface GraphEngineOptions {
  onNodeClick?: (node: GraphNode | null) => void;
  onNodeHover?: (node: GraphNode | null) => void;
  highlightedNodeIds?: Set<string>;
}

const COLORS = {
  bg: '#07080e',
  projectNode: '#34e7e0',
  projectNodeFill: 'rgba(52, 231, 224, 0.15)',
  externalNode: '#9b7bff',
  externalNodeFill: 'rgba(155, 123, 255, 0.12)',
  linkProject: 'rgba(52, 231, 224, 0.2)',
  linkExternal: 'rgba(155, 123, 255, 0.15)',
  linkSignificant: 'rgba(52, 231, 224, 0.35)',
  selectedStroke: '#ffffff',
  highlightNode: '#ffce6b',
  highlightNodeFill: 'rgba(255, 206, 107, 0.2)',
  labelText: '#e9edf7',
  labelMuted: '#909bb6',
};

export class GraphEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private simNodes: SimNode[] = [];
  private simLinks: SimLink[] = [];
  private recommendations: GraphRecommendation[] = [];
  private nodeMap = new Map<string, GraphNode>();
  private simulation: d3.Simulation<SimNode, undefined> | null = null;
  private transform: d3.ZoomTransform = d3.zoomIdentity;
  private zoomBehavior: d3.ZoomBehavior<HTMLCanvasElement, unknown>;
  private quadtree: d3.Quadtree<SimNode> | null = null;
  private hoveredNode: GraphNode | null = null;
  private selectedNode: GraphNode | null = null;
  private options: GraphEngineOptions = {};
  private animFrame: number | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, options?: GraphEngineOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.options = options || {};

    this.zoomBehavior = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        this.transform = event.transform;
        this.render();
      });

    d3.select(canvas).call(this.zoomBehavior);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('click', (e) => this.onClick(e));
    canvas.addEventListener('mouseleave', () => {
      this.hoveredNode = null;
      this.options.onNodeHover?.(null);
      this.render();
    });
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setData(nodes: GraphNode[], edges: GraphEdge[], recommendations: GraphRecommendation[]) {
    this.recommendations = recommendations;
    this.nodeMap.clear();
    for (const n of nodes) this.nodeMap.set(n.id, n);

    const recIds = new Set(recommendations.map((r) => r.id));

    // Create simulation nodes from graph nodes, using server positions or random
    this.simNodes = nodes.map((n, i) => ({
      id: n.id,
      x: n.x ?? (Math.random() * 800 + 100),
      y: n.y ?? (Math.random() * 600 + 100),
      kind: n.kind,
      isRecommendation: recIds.has(n.id),
      index: i,
      vx: 0,
      vy: 0,
    }));

    // Create simulation links
    const nodeIdx = new Map(this.simNodes.map((n) => [n.id, n]));
    this.simLinks = [];
    for (const e of edges) {
      const source = nodeIdx.get(e.source);
      const target = nodeIdx.get(e.target);
      if (source && target) {
        this.simLinks.push({ source, target, significant: e.significant });
      }
    }

    // Only run simulation if no server layout exists
    const hasLayout = nodes.some((n) => n.x !== undefined && n.y !== undefined);

    if (hasLayout) {
      this.simulation = null;
    } else {
      this.simulation = d3.forceSimulation(this.simNodes)
        .force('link', d3.forceLink(this.simLinks).distance(80))
        .force('charge', d3.forceManyBody().strength(-200))
        .force('center', d3.forceCenter(this.width / 2, this.height / 2))
        .force('collision', d3.forceCollide(24))
        .alphaDecay(0.02)
        .on('tick', () => this.render());
    }

    this.buildQuadtree();
    this.render();
  }

  private buildQuadtree() {
    this.quadtree = d3.quadtree<SimNode>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(this.simNodes.filter((n) => !n.isRecommendation));
  }

  setHighlightedNodes(ids: Set<string>) {
    this.options.highlightedNodeIds = ids;
    this.render();
  }

  setOptions(options: Partial<GraphEngineOptions>) {
    this.options = { ...this.options, ...options };
  }

  private onMouseMove(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - this.transform.x) / this.transform.k;
    const my = (e.clientY - rect.top - this.transform.y) / this.transform.k;

    if (!this.quadtree) return;

    const closest = this.quadtree.find(mx, my, 16);
    if (closest) {
      const dx = (closest.x ?? 0) - mx;
      const dy = (closest.y ?? 0) - my;
      if (dx * dx + dy * dy < 256) {
        const node = this.nodeMap.get(closest.id as string) ?? null;
        if (node !== this.hoveredNode) {
          this.canvas.style.cursor = 'pointer';
          this.hoveredNode = node;
          this.options.onNodeHover?.(node);
          this.render();
        }
        return;
      }
    }
    if (this.hoveredNode) {
      this.canvas.style.cursor = '';
      this.hoveredNode = null;
      this.options.onNodeHover?.(null);
      this.render();
    }
  }

  private onClick(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - this.transform.x) / this.transform.k;
    const my = (e.clientY - rect.top - this.transform.y) / this.transform.k;

    if (!this.quadtree) return;

    const closest = this.quadtree.find(mx, my, 20);
    if (closest) {
      const dx = (closest.x ?? 0) - mx;
      const dy = (closest.y ?? 0) - my;
      if (dx * dx + dy * dy < 400) {
        const node = this.nodeMap.get(closest.id as string) ?? null;
        this.selectedNode = (this.selectedNode?.id === node?.id) ? null : node;
        this.options.onNodeClick?.(this.selectedNode);
        this.render();
        return;
      }
    }
    this.selectedNode = null;
    this.options.onNodeClick?.(null);
    this.render();
  }

  getSelectedNode(): GraphNode | null {
    return this.selectedNode;
  }

  render() {
    const { ctx, width, height, transform, simNodes, nodeMap } = this;
    const highlightedIds = this.options.highlightedNodeIds;
    const recIds = new Set(this.recommendations.map((r) => r.id));

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    // Compute viewport in world coords
    const vx = -transform.x / transform.k;
    const vy = -transform.y / transform.k;
    const vw = width / transform.k;
    const vh = height / transform.k;
    const margin = 80;
    const vLeft = vx - margin;
    const vTop = vy - margin;
    const vRight = vx + vw + margin;
    const vBottom = vy + vh + margin;

    // Draw links (cull if both endpoints outside viewport)
    ctx.lineWidth = 1;
    for (const link of this.simLinks) {
      const sn = link.source as SimNode;
      const tn = link.target as SimNode;
      const sx = sn.x ?? 0;
      const sy = sn.y ?? 0;
      const tx = tn.x ?? 0;
      const ty = tn.y ?? 0;

      // Culling: draw if either endpoint is in viewport
      const sVisible = sx > vLeft && sx < vRight && sy > vTop && sy < vBottom;
      const tVisible = tx > vLeft && tx < vRight && ty > vTop && ty < vBottom;
      if (!sVisible && !tVisible) continue;

    const isSig = link.significant;
    ctx.strokeStyle = isSig ? COLORS.linkSignificant : COLORS.linkExternal;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Draw nodes (viewport culling)
    for (const sn of simNodes) {
      const x = sn.x ?? 0;
      const y = sn.y ?? 0;
      if (x < vLeft || x > vRight || y < vTop || y > vBottom) continue;

      const node = nodeMap.get(sn.id as string);
      if (!node) continue;

      const isProject = sn.id && !(sn.id as string).startsWith('ext:');
      const isSelected = this.selectedNode?.id === node.id;
      const isHovered = this.hoveredNode?.id === node.id;
      const isHighlighted = highlightedIds?.has(node.id);
      const isRec = recIds.has(node.id);

      const r = isProject ? 7 : 6;
      const rScaled = isSelected || isHovered ? r + 2 : isHighlighted ? r + 3 : r;

      ctx.beginPath();
      ctx.arc(x, y, rScaled, 0, Math.PI * 2);

      if (isHighlighted) {
        ctx.fillStyle = COLORS.highlightNodeFill;
        ctx.strokeStyle = COLORS.highlightNode;
        ctx.lineWidth = 2;
      } else if (isSelected) {
        ctx.fillStyle = isProject ? COLORS.projectNodeFill : COLORS.externalNodeFill;
        ctx.strokeStyle = COLORS.selectedStroke;
        ctx.lineWidth = 2;
      } else if (isRec) {
        ctx.fillStyle = 'rgba(255, 206, 107, 0.12)';
        ctx.strokeStyle = COLORS.highlightNode;
        ctx.lineWidth = 1.5;
      } else {
        ctx.fillStyle = isProject ? COLORS.projectNodeFill : COLORS.externalNodeFill;
        ctx.strokeStyle = isProject ? COLORS.projectNode : COLORS.externalNode;
        ctx.lineWidth = isProject ? 1.5 : 1;
      }
      ctx.fill();
      ctx.stroke();
    }

    // Draw labels (only for hovered/selected nodes)
    ctx.font = '11px "Chakra Petch", system-ui';
    ctx.textBaseline = 'middle';
    for (const sn of simNodes) {
      const node = nodeMap.get(sn.id as string);
      if (!node) continue;

      const isSelected = this.selectedNode?.id === node.id;
      const isHovered = this.hoveredNode?.id === node.id;
      const isHighlighted = highlightedIds?.has(node.id);
      if (!isSelected && !isHovered && !isHighlighted) continue;

      const x = sn.x ?? 0;
      const y = sn.y ?? 0;
      const r = node.kind === 'project' ? 7 : 6;

      const label = node.title.length > 40 ? node.title.slice(0, 38) + '…' : node.title;
      const textWidth = ctx.measureText(label).width;
      const labelX = x + r + 6;
      const labelY = y;

      // Background pill
      ctx.fillStyle = 'rgba(7, 8, 14, 0.85)';
      ctx.strokeStyle = 'rgba(125, 145, 200, 0.2)';
      ctx.lineWidth = 1;
      const pad = 4;
      ctx.beginPath();
      ctx.roundRect(labelX - pad, labelY - 8 - pad, textWidth + pad * 2, 16 + pad * 2, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = COLORS.labelText;
      ctx.fillText(label, labelX, labelY);
    }

    ctx.restore();
  }

  destroy() {
    if (this.simulation) this.simulation.stop();
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    window.removeEventListener('resize', () => this.resize());
  }

  zoomToFit() {
    const bounds = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const n of this.simNodes) {
      if ((n.x ?? 0) < bounds.x1) bounds.x1 = n.x ?? 0;
      if ((n.y ?? 0) < bounds.y1) bounds.y1 = n.y ?? 0;
      if ((n.x ?? 0) > bounds.x2) bounds.x2 = n.x ?? 0;
      if ((n.y ?? 0) > bounds.y2) bounds.y2 = n.y ?? 0;
    }
    if (!isFinite(bounds.x1)) return;

    const bw = bounds.x2 - bounds.x1 || 1;
    const bh = bounds.y2 - bounds.y1 || 1;
    const pad = 60;
    const scale = Math.min((this.width - pad * 2) / bw, (this.height - pad * 2) / bh, 2);
    const cx = (bounds.x1 + bounds.x2) / 2;
    const cy = (bounds.y1 + bounds.y2) / 2;

    const t = d3.zoomIdentity
      .translate(this.width / 2, this.height / 2)
      .scale(scale)
      .translate(-cx, -cy);

    d3.select(this.canvas).transition().duration(500).call(this.zoomBehavior.transform, t);
  }
}
