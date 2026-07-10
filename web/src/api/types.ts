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
}

export interface ProjectState {
  project: { id: string; name: string } & Partial<Project>;
  has_key: boolean;
  model: string | null;
  narration_model: string | null;
  speech_provider: string | null;
  has_openai_key: boolean;
  papers: Paper[];
}
