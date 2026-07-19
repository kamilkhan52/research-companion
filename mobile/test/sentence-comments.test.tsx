import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import { SentenceCommentComposer } from '@/components/chat/SentenceCommentComposer';
import {
  removeSentenceComment,
  upsertSentenceComment,
  type PendingSentenceComment,
} from '@/lib/sentenceComments';

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

test('queue helpers add, edit in place, and remove by response plus quote', () => {
  expect(upsertSentenceComment([], first)).toEqual([first]);
  expect(upsertSentenceComment([first, second], {
    ...first,
    comment: 'Updated question',
  })).toEqual([{ ...first, comment: 'Updated question' }, second]);
  expect(removeSentenceComment([first, second], first)).toEqual([second]);
});

test('inline editor saves a sentence comment', async () => {
  const onChangeDraft = jest.fn();
  const onSave = jest.fn();
  await renderAsync(
    <SentenceCommentComposer
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
