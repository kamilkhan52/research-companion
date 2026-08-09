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

test('progress reports real phases and words rather than characters', () => {
  const items = [
    { kind: 'tool' as const, name: 'paper_search', detail: 'Checking citations' },
    { kind: 'text' as const, text: 'One  two\nthree' },
  ];
  expect(draftedWordCount(items)).toBe(3);
  expect(notesAgentPhase(items)).toBe('Drafting revision…');
  expect(notesAgentPhase(items.slice(0, 1))).toBe('Checking citations');
});
