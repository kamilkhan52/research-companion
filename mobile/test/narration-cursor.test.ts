import { narrationCursorSnapshot } from '@/audio/useNarrationCursor';

test('a post-seek snapshot resolves the requested full-track sentence past pre-roll', () => {
  const narration = 'First sentence. Second sentence. Third sentence.';
  const target = narrationCursorSnapshot(
    { id: 'p:s:0#ctag', narration },
    [],
    { position: 9.25, duration: 30 },
    0.8,
  );
  expect(target.activeIndex).toBe(1);
});

test('progressive playback maps the active segment back into the whole narration', () => {
  const first = 'First sentence. Second sentence.';
  const second = 'Third sentence. Fourth sentence.';
  const narration = `${first} ${second}`;
  const slotId = 'p:s:0#ctag';
  const queue = [
    { id: 'seg-0', slotId, narration, segmentIndex: 0, sentenceText: first },
    { id: 'seg-1', slotId, narration, segmentIndex: 1, sentenceText: second },
  ];
  const target = narrationCursorSnapshot(
    queue[1],
    queue,
    { position: 0, duration: 20 },
    0.8,
  );
  expect(target.progressive).toBe(true);
  expect(target.activeIndex).toBe(2);
});

test('a progressive track waits for queue metadata instead of using incompatible scales', () => {
  const target = narrationCursorSnapshot(
    {
      id: 'seg-1',
      slotId: 'p:s:0#ctag',
      narration: 'First sentence. Second sentence.',
      segmentIndex: 1,
      sentenceText: 'Second sentence.',
    },
    [],
    { position: 3, duration: 10 },
  );
  expect(target.activeIndex).toBe(-1);
});
