// R6.8 — a finished agentic message carries a collapsed "what the agent did" trail: one quiet
// summary row by default, the full tool/thought list on tap. The answer bubble itself never
// contains trail content.

import { fireEvent, render } from '@testing-library/react-native';

import type { AgentTrailItem } from '@/api/types';
import { AgentTrail } from '@/components/AgentTrail';

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
// with no way to reach it. This row must be visible WITHOUT expanding the trail, and tapping it
// must go straight to the paper's notes screen, which resumes whatever job is latest regardless
// of what started it.
const NOTES_UPDATE_TRAIL: AgentTrailItem[] = [
  { kind: 'thought', text: "You're right — let me trigger the proposal now." },
  { kind: 'tool', name: 'propose_notes_update', detail: '' },
];

test('a notes-update tool call renders an always-visible link to review it', () => {
  const screen = render(<AgentTrail trail={NOTES_UPDATE_TRAIL} slug="attention-is-all-you-need" />);

  const link = screen.getByText(/Notes update requested from this discussion/);
  expect(link).toBeTruthy();

  fireEvent.press(link);
  expect(mockPush).toHaveBeenCalledWith('/notes/attention-is-all-you-need');
});

test('the notes-update link is absent without a slug, and for trails that never called it', () => {
  const withoutSlug = render(<AgentTrail trail={NOTES_UPDATE_TRAIL} />);
  expect(withoutSlug.queryByText(/Notes update requested/)).toBeNull();

  const unrelated = render(<AgentTrail trail={TRAIL} slug="attention-is-all-you-need" />);
  expect(unrelated.queryByText(/Notes update requested/)).toBeNull();
});

test('the link reads the same on a message from the past, not just a just-finished one', () => {
  // Opus review, PR #371: this trail comes straight from the persisted transcript with no live
  // job-status check, so a turn from last week whose proposal was reviewed days ago renders
  // identically to one from seconds ago. The copy must not claim an in-progress state it can't
  // verify either way — this test exists so a future "is drafting"/"is ready" regression fails
  // here instead of only being caught by re-reading old messages on device.
  const screen = render(<AgentTrail trail={NOTES_UPDATE_TRAIL} slug="attention-is-all-you-need" />);
  expect(screen.queryByText(/is drafting/)).toBeNull();
  expect(screen.queryByText(/is ready/)).toBeNull();
});
