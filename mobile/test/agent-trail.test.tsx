// R6.8 — a finished agentic message carries a collapsed "what the agent did" trail: one quiet
// summary row by default, the full tool/thought list on tap. The answer bubble itself never
// contains trail content.

import { fireEvent, render } from '@testing-library/react-native';

import type { AgentTrailItem } from '@/api/types';
import { AgentTrail, NotesUpdateLink, startedNotesUpdate } from '@/components/AgentTrail';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const TRAIL: AgentTrailItem[] = [
  { kind: 'thought', text: 'Let me search for recent work on this.' },
  { kind: 'tool', name: 'web_search', detail: 'high-bandwidth flash LLM inference' },
  { kind: 'tool', name: 'web_fetch', detail: 'https://example.com/paper' },
];

beforeEach(() => {
  mockPush.mockReset();
});

test('collapsed by default: summary row only, no step content', () => {
  const screen = render(<AgentTrail trail={TRAIL} />);

  expect(screen.getByText('Researched with 2 tool calls · 3 steps')).toBeTruthy();
  expect(screen.queryByText(/Let me search/)).toBeNull();
  expect(screen.queryByText('Searching the web')).toBeNull();
});

test('expands to the full tool/thought list and collapses again', () => {
  const screen = render(<AgentTrail trail={TRAIL} />);
  const header = screen.getByRole('button');

  fireEvent.press(header);
  expect(screen.getByText('Let me search for recent work on this.')).toBeTruthy();
  expect(screen.getByText('Searching the web')).toBeTruthy();
  expect(screen.getByText('high-bandwidth flash LLM inference')).toBeTruthy();
  expect(screen.getByText('Reading a page')).toBeTruthy();

  fireEvent.press(header);
  expect(screen.queryByText('Searching the web')).toBeNull();
});

// DR-043 reopened, 2026-08-11: a notes draft started from the agent's `propose_notes_update`
// tool (in-conversation, no client-side navigation like the menu button gets) left the reader
// with no way to reach it. DR-105 then moved that row OUT of the trail: it belongs under the
// answer, where the reader finishes reading, not above it where a long analysis buries it.
const NOTES_UPDATE_TRAIL: AgentTrailItem[] = [
  { kind: 'thought', text: "You're right — let me trigger the proposal now." },
  { kind: 'tool', name: 'propose_notes_update', detail: '' },
];

test('the trail itself no longer carries the notes-update link (DR-105)', () => {
  const screen = render(<AgentTrail trail={NOTES_UPDATE_TRAIL} />);
  expect(screen.queryByTestId('notes-update-link')).toBeNull();
});

test('startedNotesUpdate is what the message body asks, and only that tool answers yes', () => {
  expect(startedNotesUpdate(NOTES_UPDATE_TRAIL)).toBe(true);
  expect(startedNotesUpdate(TRAIL)).toBe(false);
  expect(startedNotesUpdate([])).toBe(false);
});

test('the link goes straight to the paper notes screen, which resumes whatever job is latest', () => {
  const screen = render(<NotesUpdateLink slug="attention-is-all-you-need" />);
  fireEvent.press(screen.getByTestId('notes-update-link'));
  expect(mockPush).toHaveBeenCalledWith('/notes/attention-is-all-you-need');
});

test('the finished-turn wording claims no state it cannot verify; only a live turn says preparing', () => {
  // Opus review, PR #371: a persisted trail carries no live job status, so a turn from last week
  // whose proposal was reviewed days ago renders identically to one from seconds ago. This test
  // exists so a future "is drafting"/"is ready" regression fails here rather than only on device.
  const past = render(<NotesUpdateLink slug="attention-is-all-you-need" />);
  expect(past.getByText(/Notes update requested from this discussion/)).toBeTruthy();
  expect(past.queryByText(/is drafting/)).toBeNull();
  expect(past.queryByText(/Preparing/)).toBeNull();

  const live = render(<NotesUpdateLink slug="attention-is-all-you-need" live />);
  expect(live.getByText(/Preparing a notes update/)).toBeTruthy();
});
