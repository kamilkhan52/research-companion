import {
  alignNarrationToDiscussion,
  discussionAssistantIndexForAudio,
  discussionJumpAction,
  discussionNarrationIndex,
  isContentQualifiedAudioId,
} from '@/audio/discussionFollow';

const anchors = [
  { id: 'b0.s0', text: 'First claim explains the baseline.' },
  { id: 'b1.s0', text: 'Second claim reports the improvement.' },
];

test('exact spoken sentences map to their stable discussion anchors', () => {
  expect(alignNarrationToDiscussion(
    'First claim explains the baseline. Second claim reports the improvement.',
    anchors,
  )).toEqual(['b0.s0', 'b1.s0']);
});

test('an added spoken heading stays a gap without shifting later matches', () => {
  expect(alignNarrationToDiscussion(
    'Overview. First claim explains the baseline. Second claim reports the improvement.',
    anchors,
  )).toEqual([null, 'b0.s0', 'b1.s0']);
});

test('two spoken fragments can point to one longer source sentence', () => {
  expect(alignNarrationToDiscussion(
    'It retrieves candidates. Then it reranks them.',
    [{ id: 'b0.s0', text: 'It retrieves candidates, then it reranks them.' }],
  )).toEqual(['b0.s0', 'b0.s0']);
});

test('weak unrelated prose remains unmapped instead of highlighting confidently', () => {
  expect(alignNarrationToDiscussion(
    'The weather changed overnight. Bananas ripen on the counter.',
    anchors,
  )).toEqual([null, null]);
});

test('a long same-order response stays aligned across the bounded search band', () => {
  const longAnchors = Array.from({ length: 80 }, (_, index) => ({
    id: `b${index}.s0`,
    text: `Claim number ${index} reports result ${index}.`,
  }));
  expect(alignNarrationToDiscussion(
    longAnchors.map((anchor) => anchor.text).join(' '),
    longAnchors,
  )).toEqual(longAnchors.map((anchor) => anchor.id));
});

test('only content-qualified narration ids are eligible for Discussion following', () => {
  expect(isContentQualifiedAudioId('project:paper:2#cabc123')).toBe(true);
  expect(isContentQualifiedAudioId('project:paper:2')).toBe(false);
  expect(isContentQualifiedAudioId('preview:job')).toBe(false);
});

test('audio identity must match the exact project, paper, and side thread', () => {
  const id = 'project-a:paper-a--abcdef123456:2#ctag';
  expect(discussionAssistantIndexForAudio(id, 'project-a', 'paper-a', 'abcdef123456')).toBe(2);
  expect(discussionAssistantIndexForAudio(id, 'project-b', 'paper-a', 'abcdef123456')).toBeNull();
  expect(discussionAssistantIndexForAudio(id, 'project-a', 'paper-b', 'abcdef123456')).toBeNull();
  expect(discussionAssistantIndexForAudio(id, 'project-a', 'paper-a', 'main')).toBeNull();
  expect(discussionAssistantIndexForAudio('project-a:paper-a:2', 'project-a', 'paper-a', 'main'))
    .toBeNull();
});

test('an exact-slot explicit landing wins over the passive cursor previous poll', () => {
  expect(discussionNarrationIndex(
    'project:paper:0#ctag',
    3,
    { slotId: 'project:paper:0#ctag', activeIndex: 4 },
  )).toBe(4);
  expect(discussionNarrationIndex(
    'project:paper:0#ctag',
    3,
    { slotId: 'project:other:0#ctag', activeIndex: 8 },
  )).toBe(3);
});

test('an explicit request waits for its focused conversation, then lands exactly once', () => {
  const jump = { nonce: 7, slotId: 'project:paper:0#ctag' };
  const base = {
    enabled: true,
    focused: true,
    jump,
    cursorSlotId: jump.slotId,
    conversationMatched: true,
    targetNonce: 7,
    passiveIndex: 3,
    jumpIndex: 4,
    alreadyLanded: false,
    passiveIndexAtLanding: null,
  };
  expect(discussionJumpAction({ ...base, focused: false })).toBe('wait');
  expect(discussionJumpAction({ ...base, cursorSlotId: 'project:other:0#ctag' })).toBe('wait');
  expect(discussionJumpAction(base)).toBe('land');
  // Keep the explicit landing authoritative while a paused player still reports the same
  // passive sentence. Retire it only after playback produces a real boundary transition.
  expect(discussionJumpAction({
    ...base,
    alreadyLanded: true,
    passiveIndexAtLanding: 3,
  })).toBe('wait');
  expect(discussionJumpAction({
    ...base,
    passiveIndex: 4,
    alreadyLanded: true,
    passiveIndexAtLanding: 3,
  })).toBe('consume');
  expect(discussionJumpAction({
    ...base,
    passiveIndex: 2,
    alreadyLanded: true,
    passiveIndexAtLanding: 3,
  })).toBe('consume');
  expect(discussionJumpAction({ ...base, passiveIndex: 4 })).toBe('land-and-consume');
  // A matching conversation with no safe alignment retires the request instead of leaving a
  // stale force-jump that might fire on a later passive boundary.
  expect(discussionJumpAction({ ...base, targetNonce: null })).toBe('consume');
  expect(discussionJumpAction({ ...base, enabled: false })).toBe('consume');
});
