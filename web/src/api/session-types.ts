export interface SessionTurn {
  role: 'user' | 'assistant';
  text?: string;
  canonical?: string;
  state_signal?: string;
  proposed_commit?: unknown;
  narration?: string;
  assistant_index?: number;
  delivery_mode?: 'reading' | 'listening';
}

export interface SessionPaper {
  slug: string;
  title: string;
  retrieved: boolean;
  list_status: string;
}

export interface Session {
  paper: SessionPaper;
  state: string | null;
  transcript: SessionTurn[];
  model?: string;
  reading_mode: import('./types').ReadingMode;
  accepted_drafts?: { kind: 'reply' | 'revision'; text: string }[];
}

export interface OpeningDraft {
  title: string;
  prompt: string;
  model: string | null;
}

export interface TurnDelta {
  type: 'delta';
  text: string;
}

export interface TurnDone {
  type: 'done';
  turn: SessionTurn;
}

export interface TurnError {
  type: 'error';
  detail: string;
}

export type StreamEvent = TurnDelta | TurnDone | TurnError;

export interface ReviewResponse {
  title: string;
  summary: string;
  notes_block?: string;
  synthesis_proposed: string;
  synthesis_current: string;
}
