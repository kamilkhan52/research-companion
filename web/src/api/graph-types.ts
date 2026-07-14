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
  provenance?: Array<'reading_list' | 'full_text' | 'semantic_scholar'>;
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
  provenance?: Array<'full_text' | 'semantic_scholar'>;
  full_text_verified?: boolean;
  provider_evidence?: {
    semantic_scholar?: {
      paper_id: string | null;
      contexts: string[];
      intents: string[];
      is_influential: boolean;
    };
  };
}

export interface ReferenceGraph {
  built_at: string;
  revision: string;
  model: string;
  stage: 'skeleton' | 'enriched';
  completeness: GraphCompleteness;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout?: { width: number; height: number };
}

export interface GraphCompleteness {
  total_papers: number;
  metadata_papers: number;
  ready_papers: number;
  analyzed_papers: number;
  metadata_only_edges: number;
  full_text_edges: number;
}

export interface GraphStatus {
  has_graph: boolean;
  built_at: string | null;
  model: string | null;
  graph_revision: string | null;
  graph_stage: 'skeleton' | 'enriched' | null;
  graph_completeness: GraphCompleteness | null;
  graph_needs_enrichment: boolean;
  total_papers: number;
  retrievable_papers: number;
  stale_papers: string[];
  missing_text_papers: string[];
  semantic_scholar_enabled: boolean;
  semantic_scholar_papers: number;
  semantic_scholar_stale_papers: string[];
  retrieval_candidates: Record<string, GraphRetrievalCandidate[]>;
  retrieval_errors: Record<string, string>;
}

export interface GraphRetrievalCandidate {
  arxiv_id: string;
  title: string;
  score: number;
  pdf_url?: string;
}

export interface GraphBuildPaperStatus {
  status:
    | 'metadata' | 'metadata_cached' | 'retrieving' | 'retrieval_cached'
    | 'needs_confirmation' | 'extracting' | 'cached' | 'done' | 'not_found' | 'error';
  error: string | null;
}

export interface GraphBuildJob {
  status: 'running' | 'done' | 'error';
  phase: 'preparing' | 'metadata' | 'skeleton_ready' | 'retrieval' | 'extraction' | 'complete';
  total: number;
  ready: number;
  done: number;
  current_slug: string | null;
  current_title: string | null;
  per_paper: Record<string, GraphBuildPaperStatus>;
  retrieval_candidates: Record<string, GraphRetrievalCandidate[]>;
  graph_stage: 'skeleton' | 'enriched' | null;
  graph_completeness: GraphCompleteness | null;
  graph_revision: string | null;
  graph_updated_at: string | null;
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
