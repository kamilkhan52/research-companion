import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { ScrollView, StyleSheet, Text as RNText } from 'react-native';
import { Stop } from 'react-native-svg';
import type { ReactTestInstance } from 'react-test-renderer';

import {
  CHIPS_FADE_WIDTH,
  SentenceCommentComposer,
} from '@/components/chat/SentenceCommentComposer';
import {
  composeSentenceReply,
  removeSentenceComment,
  sentenceCommentPayload,
  sentenceCommentsDraftKey,
  upsertSentenceComment,
  type PendingSentenceComment,
} from '@/lib/sentenceComments';
import { control } from '@/theme/tokens';

/** Walks up from a host text node to the nearest ancestor carrying the given prop — the exact
 *  composite depth between a rendered Text and its wrapping Pressable isn't a contract worth
 *  hard-coding. */
function nearestAncestorWith(node: ReactTestInstance, prop: string): ReactTestInstance | null {
  let current: ReactTestInstance | null = node;
  while (current) {
    if (current.props[prop] !== undefined) return current;
    current = current.parent;
  }
  return null;
}

/** Walks up from a host text node to the nearest ancestor whose flattened style declares a
 *  minHeight — real layout, unlike hitSlop, which a parent's bounds can silently clip away. */
function minHeightOf(node: ReactTestInstance): number {
  let current: ReactTestInstance | null = node;
  while (current) {
    const style = StyleSheet.flatten(current.props.style) as { minHeight?: number } | undefined;
    if (style?.minHeight) return style.minHeight;
    current = current.parent;
  }
  return 0;
}

const first: PendingSentenceComment = {
  assistantIndex: 1,
  quote: 'First claim.',
  comment: 'Why?',
};
const second: PendingSentenceComment = {
  assistantIndex: 2,
  quote: 'Second claim.',
  comment: 'Compare this.',
};

test('pending sentence comments are isolated by discussion thread', () => {
  expect(sentenceCommentsDraftKey('project', 'paper', 'main')).toBe(
    'rc.draft.v1:project:comments:paper',
  );
  expect(sentenceCommentsDraftKey('project', 'paper', 'thread-a')).not.toBe(
    sentenceCommentsDraftKey('project', 'paper', 'thread-b'),
  );
});

test('queue helpers add, edit in place, and remove by response plus quote', () => {
  expect(upsertSentenceComment([], first)).toEqual([first]);
  expect(upsertSentenceComment([first, second], {
    ...first,
    comment: 'Updated question',
  })).toEqual([{ ...first, comment: 'Updated question' }, second]);
  expect(removeSentenceComment([first, second], first)).toEqual([second]);
});

test('reply payload drops UI identity and optimistic text matches the server format', () => {
  expect(sentenceCommentPayload([first])).toEqual([{
    quote: 'First claim.',
    comment: 'Why?',
  }]);
  expect(composeSentenceReply([first], 'Also compare the baseline.')).toBe(
    'Regarding specific passages of your last response:\n\n'
    + '> “First claim.”\n>\n> — Why?\n\n'
    + 'Also compare the baseline.',
  );
  expect(composeSentenceReply([], '  plain text  ')).toBe('  plain text  ');
});

test('inline editor saves a sentence comment', async () => {
  const onChangeDraft = jest.fn();
  const onSave = jest.fn();
  await renderAsync(
    <SentenceCommentComposer
      active
      comments={[]}
      selected={{ assistantIndex: 1, quote: first.quote }}
      draft="Explain the evidence"
      onChangeDraft={onChangeDraft}
      onSave={onSave}
      onCancelSelection={jest.fn()}
      onOpen={jest.fn()}
      onRemove={jest.fn()}
      onDone={jest.fn()}
    />,
  );

  expect(screen.getByText('“First claim.”')).toBeTruthy();
  await fireEventAsync.changeText(screen.getByLabelText('Sentence comment'), 'New comment');
  expect(onChangeDraft).toHaveBeenCalledWith('New comment');
  await fireEventAsync.press(screen.getByText('OK'));
  expect(onSave).toHaveBeenCalled();
});

test('attached-comment chips reopen and remove queued comments', async () => {
  const onOpen = jest.fn();
  const onRemove = jest.fn();
  const onDone = jest.fn();
  await renderAsync(
    <SentenceCommentComposer
      active={false}
      comments={[first, second]}
      selected={null}
      draft=""
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancelSelection={jest.fn()}
      onOpen={onOpen}
      onRemove={onRemove}
      onDone={onDone}
    />,
  );

  await fireEventAsync.press(screen.getByLabelText('Edit comment on: First claim.'));
  expect(onOpen).toHaveBeenCalledWith(first);
  await fireEventAsync.press(screen.getByLabelText('Remove comment on: Second claim.'));
  expect(onRemove).toHaveBeenCalledWith(second);
  await fireEventAsync.press(screen.getByTestId('sentence-comment-collapse'));
  expect(onDone).toHaveBeenCalled();
});

// DR-108 — Kamil: "The 'Done' button on the Comments Attachment view doesn't do anything. Can't
// tell if it even registers the press." It did register; it only left sentence-SELECTION mode,
// and with comments attached the tray was unchanged afterwards. Done now collapses the tray to
// one "N comments" chip, which is both a visible result and the reading space he asked back for.
test('Done collapses the attached comments to a single chip, and the chip brings them back', async () => {
  const onDone = jest.fn();
  await renderAsync(
    <SentenceCommentComposer
      active={false}
      comments={[first, second]}
      selected={null}
      draft=""
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancelSelection={jest.fn()}
      onOpen={jest.fn()}
      onRemove={jest.fn()}
      onDone={onDone}
    />,
  );
  expect(screen.getByTestId('sentence-comment-queue')).toBeTruthy();

  await fireEventAsync.press(screen.getByTestId('sentence-comment-collapse'));
  expect(onDone).toHaveBeenCalled();                       // still exits annotation mode
  expect(screen.queryByTestId('sentence-comment-queue')).toBeNull();
  // DR-130 — the chip is the COUNT plus the speech-bubble glyph, not "2 comments".
  expect(screen.getByText('2')).toBeTruthy();
  expect(screen.queryByText(/comments?$/)).toBeNull();

  await fireEventAsync.press(screen.getByTestId('sentence-comment-chip'));
  expect(screen.getByTestId('sentence-comment-queue')).toBeTruthy();
});

// DR-130 — Kamil: "instead of saying 'N comments' when minimized, we should just have the number
// and the icon. No 'comments' needed." The word must be gone from the VISIBLE label while the
// accessibility label keeps the whole sentence — a screen reader hearing "2" alone learns
// nothing. Asserting both halves, because dropping the word from both would also pass a
// visible-text-only check.
test('the collapsed chip shows the bare count, and still SAYS "comments" to a screen reader', async () => {
  const props = {
    active: false, selected: null, draft: '', onChangeDraft: jest.fn(), onSave: jest.fn(),
    onCancelSelection: jest.fn(), onOpen: jest.fn(), onRemove: jest.fn(), onDone: jest.fn(),
  };
  await renderAsync(<SentenceCommentComposer {...props} comments={[first, second]} />);
  await fireEventAsync.press(screen.getByTestId('sentence-comment-collapse'));

  const chip = screen.getByTestId('sentence-comment-chip');
  expect(chip.props.accessibilityLabel).toBe('2 comments attached. Tap to show them.');
  // Every string the chip actually paints: the count, and nothing else.
  const painted = screen.UNSAFE_getAllByType(RNText)
    .map((n) => n.props.children)
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
  expect(painted).toEqual(['2']);
});

// DR-130 — the reported defect: with more chips than fit, the strip ended at a hard vertical
// seam against the tray's opaque fill, which reads as a panel sitting ON TOP of a comment
// ("the minimize arrow seems to have no transparency and overlaps the comments more than it
// should"). The fix is a gradient to that same fill, so the boundary dissolves.
test('the chip strip fades out at its trailing edge instead of being cut off', async () => {
  const props = {
    active: false, selected: null, draft: '', onChangeDraft: jest.fn(), onSave: jest.fn(),
    onCancelSelection: jest.fn(), onOpen: jest.fn(), onRemove: jest.fn(), onDone: jest.fn(),
  };
  await renderAsync(<SentenceCommentComposer {...props} comments={[first, second]} />);

  const fade = screen.getByTestId('sentence-comment-chips-fade', { includeHiddenElements: true });
  expect(fade.props.pointerEvents).toBe('none');           // never eats a tap meant for a chip
  expect(fade.props.width).toBe(CHIPS_FADE_WIDTH);

  // Transparent where the comment is, opaque where the control is — the other way round would
  // paint a solid block over the chips, which is the very thing being fixed.
  const stops = screen.UNSAFE_getAllByType(Stop);
  expect(stops.map((s) => s.props.stopOpacity)).toEqual([0, 1]);

  // And the strip can scroll clear of the fade rather than parking half-dissolved under it.
  const strip = screen.UNSAFE_getAllByType(ScrollView)
    .find((s) => s.props.horizontal);
  const pad = StyleSheet.flatten(strip?.props.contentContainerStyle) as { paddingRight?: number };
  expect(pad.paddingRight).toBeGreaterThanOrEqual(CHIPS_FADE_WIDTH);
});

test('a newly attached comment re-opens the tray so the reader sees it land', async () => {
  const props = {
    active: false, selected: null, draft: '', onChangeDraft: jest.fn(), onSave: jest.fn(),
    onCancelSelection: jest.fn(), onOpen: jest.fn(), onRemove: jest.fn(), onDone: jest.fn(),
  };
  const view = await renderAsync(<SentenceCommentComposer {...props} comments={[first]} />);
  await fireEventAsync.press(screen.getByTestId('sentence-comment-collapse'));
  expect(screen.queryByTestId('sentence-comment-queue')).toBeNull();

  await view.rerenderAsync(<SentenceCommentComposer {...props} comments={[first, second]} />);
  expect(screen.getByTestId('sentence-comment-queue')).toBeTruthy();
  expect(screen.queryByTestId('sentence-comment-chip')).toBeNull();
});

test('the collapsed chip carries no count header row above it — that space is the point', async () => {
  await renderAsync(
    <SentenceCommentComposer
      active={false}
      comments={[first]}
      selected={null}
      draft=""
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancelSelection={jest.fn()}
      onOpen={jest.fn()}
      onRemove={jest.fn()}
      onDone={jest.fn()}
    />,
  );
  expect(screen.queryByText(/comments? attached/)).toBeNull();
});

test('annotation mode explains the next step before a sentence is selected', async () => {
  const onDone = jest.fn();
  await renderAsync(
    <SentenceCommentComposer
      active
      comments={[]}
      selected={null}
      draft=""
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancelSelection={jest.fn()}
      onOpen={jest.fn()}
      onRemove={jest.fn()}
      onDone={onDone}
    />,
  );

  expect(screen.getByText('Select a sentence in the response')).toBeTruthy();
  await fireEventAsync.press(screen.getByText('Done'));
  expect(onDone).toHaveBeenCalled();
});

// DR-053 §2 — Kamil: "I also can't really click it and it doesn't do anything." The design
// doc (comment-mode-polish-design.md) names this as the one already-identifiable defect: both
// Done controls are a bare Pressable around a Text with no hitSlop and no minimum size, while
// the queued chips already carry minHeight: 54. RNTL's fireEvent.press bypasses real touch
// geometry entirely (it calls onPress directly, hitSlop or not), so this can only be tested as
// a style/prop assertion — the actual tap-target fix is unverifiable in Jest, same as the
// design doc says.
//
// Opus review, PR #379: asserting only that `hitSlop` is DEFINED passed even when it produced
// no real tap-target gain — Android clips a Pressable's touch area to its PARENT's bounds, and
// neither `hint` nor `queueHead` had the height for the slop to extend into, so a 12px slop on
// a ~16px text row only ever reached ~40px, still short of control.minTouch (48). `minHeight`
// is real layout (the surrounding row grows to fit it), not a clippable invisible region, so
// that's the property actually worth asserting.

test('both Done controls meet the real minimum touch target, not just a hitSlop prop', async () => {
  const hintScreen = await renderAsync(
    <SentenceCommentComposer
      active
      comments={[]}
      selected={null}
      draft=""
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancelSelection={jest.fn()}
      onOpen={jest.fn()}
      onRemove={jest.fn()}
      onDone={jest.fn()}
    />,
  );
  expect(minHeightOf(hintScreen.getByText('Done'))).toBeGreaterThanOrEqual(control.minTouch);
  expect(nearestAncestorWith(hintScreen.getByText('Done'), 'hitSlop')).toBeTruthy();

  const queueScreen = await renderAsync(
    <SentenceCommentComposer
      active={false}
      comments={[first]}
      selected={null}
      draft=""
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancelSelection={jest.fn()}
      onOpen={jest.fn()}
      onRemove={jest.fn()}
      onDone={jest.fn()}
    />,
  );
  // DR-108 replaced the tray's text "Done" with the collapse control beside the chips; it is
  // sized as real layout for the same reason (a hitSlop is clipped to its parent's bounds).
  const collapse = queueScreen.getByTestId('sentence-comment-collapse');
  const collapseStyle = StyleSheet.flatten(collapse.props.style) as
    { minHeight?: number; width?: number };
  expect(collapseStyle.minHeight).toBeGreaterThanOrEqual(control.minTouch);
  expect(collapseStyle.width).toBeGreaterThanOrEqual(control.minTouch);
});

test('the attached-comments tray has a real surface, not text floating with no background', async () => {
  await renderAsync(
    <SentenceCommentComposer
      active={false}
      comments={[first]}
      selected={null}
      draft=""
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancelSelection={jest.fn()}
      onOpen={jest.fn()}
      onRemove={jest.fn()}
      onDone={jest.fn()}
    />,
  );
  // Walk up from the queue head text to the nearest ancestor whose flattened style actually
  // paints a surface — the exact composite depth to the tray View isn't a contract worth
  // hard-coding.
  let node: ReactTestInstance | null = screen.getByTestId('sentence-comment-queue');
  let style: Record<string, unknown> = {};
  while (node) {
    style = (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
    if (style.backgroundColor) break;
    node = node.parent;
  }
  expect(style.backgroundColor).toBeTruthy();
  expect(style.borderWidth ?? style.borderTopWidth).toBeTruthy();
});
