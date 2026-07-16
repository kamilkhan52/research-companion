// R6.8 — a finished agentic message carries a collapsed "what the agent did" trail: one quiet
// summary row by default, the full tool/thought list on tap. The answer bubble itself never
// contains trail content.

import { fireEvent, render } from '@testing-library/react-native';

import type { AgentTrailItem } from '@/api/types';
import { AgentTrail } from '@/components/AgentTrail';

const TRAIL: AgentTrailItem[] = [
  { kind: 'thought', text: 'Let me search for recent work on this.' },
  { kind: 'tool', name: 'web_search', detail: 'high-bandwidth flash LLM inference' },
  { kind: 'tool', name: 'web_fetch', detail: 'https://example.com/paper' },
];

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
