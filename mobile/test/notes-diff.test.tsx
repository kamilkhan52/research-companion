import { fireEventAsync, renderAsync } from '@testing-library/react-native';
import { Text as RNText } from 'react-native';

import { PaperIndexContext } from '@/components/Markdown';
import { diffLines, draftedWordCount, NotesDiff, notesAgentPhase } from '@/components/NotesDiff';

test('produces a real line-level added and removed diff', () => {
  expect(diffLines('keep\nold claim\ntail', 'keep\nnew claim\ntail')).toEqual([
    { kind: 'same', text: 'keep' },
    { kind: 'add', text: 'new claim' },
    { kind: 'remove', text: 'old claim' },
    { kind: 'same', text: 'tail' },
  ]);
});

test('proposal paper references remain tappable inside the diff', async () => {
  const onLinkPress = jest.fn();
  const screen = await renderAsync(
    <PaperIndexContext.Provider value={[{ title: 'Activation-aware Weight Quantization', slug: 'awq' }]}>
      <NotesDiff
        before="Old wording"
        after="Activation-aware Weight Quantization improves this."
        onLinkPress={onLinkPress}
      />
    </PaperIndexContext.Provider>,
  );

  const link = screen.UNSAFE_getAllByType(RNText).find((node) => typeof node.props.onPress === 'function');
  expect(link).toBeTruthy();
  await fireEventAsync.press(link!);
  expect(onLinkPress).toHaveBeenCalledWith('rc-paper:awq', 'Activation-aware Weight Quantization');
});

// DR-059 — Kamil: "I still don't see diff for the working notes." Diagnosed: an empty `before`
// (a project's first synthesis, or a paper's first notes) diffs as every line added, which is
// a real diff but reads as a wall of green text with nothing to contrast it against.

test('a first draft (empty before) is labeled, not just a wall of added lines', async () => {
  // Multi-paragraph, matching the real shape (agent._parse's NOTES_BLOCK/SYNTHESIS output is
  // never a single bare line) — a single-line `after` with no blank line hits a pre-existing
  // diffLines quirk (before's one empty-string line pairs against nothing, emitting a stray
  // removed row) that a real first draft never actually produces.
  const screen = await renderAsync(
    <NotesDiff before="" after={'Brand new notes.\n\nA second paragraph, freshly drafted.'} />,
  );
  expect(screen.getByText('First draft — everything below is new')).toBeTruthy();
  // The label sits above real content, not above nothing.
  expect(screen.getByText('Brand new notes.')).toBeTruthy();
  expect(screen.getByText('A second paragraph, freshly drafted.')).toBeTruthy();
  expect(screen.queryByLabelText('Removed line')).toBeNull();
});

test('an ordinary revision with real prior content carries no first-draft label', async () => {
  const screen = await renderAsync(<NotesDiff before="Old text." after="Old text. More." />);
  expect(screen.queryByText('First draft — everything below is new')).toBeNull();
});

test('an empty before with no proposed change still reads as "no changes", not a first draft', async () => {
  const screen = await renderAsync(<NotesDiff before="" after="" />);
  expect(screen.getByText('No text changes proposed.')).toBeTruthy();
  expect(screen.queryByText('First draft — everything below is new')).toBeNull();
});

test('progress reports real phases and words rather than characters', () => {
  const items = [
    { kind: 'tool' as const, name: 'paper_search', detail: 'Checking citations' },
    { kind: 'text' as const, text: 'One  two\nthree' },
  ];
  expect(draftedWordCount(items)).toBe(3);
  expect(notesAgentPhase(items)).toBe('Drafting revision…');
  expect(notesAgentPhase(items.slice(0, 1))).toBe('Checking citations');
});
