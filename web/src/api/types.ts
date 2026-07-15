export interface Project {
  id: string;
  name: string;
  created_at: string | null;
  paper_count: number;
  read_count: number;
}

export type SessionState =
  | 'unread'
  | 'retrieving'
  | 'in_discussion'
  | 'notes_drafted'
  | 'committed'
  | null;

export interface Paper {
  slug: string;
  title: string;
  group: string;
  list_status: 'unread' | 'read';
  cites: string[];
  retrieved: boolean;
  has_notes: boolean;
  session_state: SessionState;
  kind?: string;
  arxiv_id?: string;
  /** Publication year — explicit `<!-- year -->` comment or derived from the arXiv id. */
  year?: number | null;
}

export type ReadingMode = 'balanced' | 'background' | 'technical' | 'detailed';

export interface RecentSession {
  project_id: string;
  project_name: string;
  slug: string;
  title: string;
  kind: 'paper' | 'review';
  state: SessionState;
  updated_at: string;
}

export interface ModelOption { id: string; name: string; }
export interface FavoriteModel { id: string; label: string; }

export interface ProjectState {
  project: { id: string; name: string } & Partial<Project>;
  has_key: boolean;
  model: string | null;
  narration_model: string | null;
  preview_model?: string | null;
  speech_provider: string | null;
  has_openai_key: boolean;
  papers: Paper[];
}
