export interface GraphNode {
  id: string;
  kind: 'project' | 'external';
  slug: string | null;
  title: string;
  authors: string[];
  venue: string;
  year: number | null;
  arxiv_id: string | null;
  doi: string | null;
  url: string | null;
  group: string | null;
  list_status: 'unread' | 'read' | null;
  cited_by_project_count: number;
  significant_cited_by_count: number;
  cites_count: number;
  citation_count?: number | null;
  x?: number;
  y?: number;
}

export interface GraphRecommendation extends GraphNode {
  recommend_score: number;
  recommend_reasons: string[];
  betweenness_centrality: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  significant: boolean;
  reason: string;
  contexts: string[];
  confidence: number;
  raw_text: string;
}

export interface ReferenceGraph {
  built_at: string;
  model: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout?: { width: number; height: number };
}

export interface GraphStatus {
  has_graph: boolean;
  built_at: string | null;
  model: string | null;
  total_papers: number;
  retrievable_papers: number;
  stale_papers: string[];
  missing_text_papers: string[];
}

export interface GraphBuildPaperStatus {
  status: 'extracting' | 'cached' | 'done' | 'error';
  error: string | null;
}

export interface GraphBuildJob {
  status: 'running' | 'done' | 'error';
  total: number;
  done: number;
  current_slug: string | null;
  current_title: string | null;
  per_paper: Record<string, GraphBuildPaperStatus>;
  graph: ReferenceGraph | null;
  recommendations: GraphRecommendation[] | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface GraphResponse {
  graph: ReferenceGraph | null;
  recommendations: GraphRecommendation[];
  status: GraphStatus;
  build: GraphBuildJob | null;
}
