import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { SentenceCommentComposer } from '@/components/chat/SentenceCommentComposer';
import {
  composeSentenceReply,
  removeSentenceComment,
  sentenceCommentPayload,
  sentenceCommentsDraftKey,
  upsertSentenceComment,
  type PendingSentenceComment,
} from '@/lib/sentenceComments';

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

  expect(screen.getByText('2 comments attached')).toBeTruthy();
  await fireEventAsync.press(screen.getByLabelText('Edit comment on: First claim.'));
  expect(onOpen).toHaveBeenCalledWith(first);
  await fireEventAsync.press(screen.getByLabelText('Remove comment on: Second claim.'));
  expect(onRemove).toHaveBeenCalledWith(second);
  await fireEventAsync.press(screen.getByText('Done'));
  expect(onDone).toHaveBeenCalled();
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

test('both Done controls carry a real hit-target extension, not a bare text tap', async () => {
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
  expect(nearestAncestorWith(queueScreen.getByText('Done'), 'hitSlop')).toBeTruthy();
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
  let node: ReactTestInstance | null = screen.getByText('1 comment attached');
  let style: Record<string, unknown> = {};
  while (node) {
    style = (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
    if (style.backgroundColor) break;
    node = node.parent;
  }
  expect(style.backgroundColor).toBeTruthy();
  expect(style.borderWidth ?? style.borderTopWidth).toBeTruthy();
});
