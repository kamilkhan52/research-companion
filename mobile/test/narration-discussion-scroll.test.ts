import { startNarrationLanding } from '@/lib/narrationDiscussionScroll';

test('an unmounted sentence approaches its row, then corrects after measurement', () => {
  const approach = jest.fn();
  const correct = jest.fn();
  const scheduled: Array<() => void> = [];
  let mounted = false;
  const measure = jest.fn((done: (y: number, height: number) => void) => {
    if (!mounted) return false;
    done(420, 36);
    return true;
  });

  startNarrationLanding({
    approach,
    measure,
    correct,
    schedule: (callback) => scheduled.push(callback),
  });
  expect(approach).toHaveBeenCalledTimes(1);
  expect(correct).not.toHaveBeenCalled();
  expect(scheduled).toHaveLength(1);

  mounted = true;
  scheduled.shift()?.();
  expect(correct).toHaveBeenCalledWith(420, 36);
  expect(approach).toHaveBeenCalledTimes(1);
  expect(scheduled).toHaveLength(0);
});

test('a measured sentence corrects once without an approach or retry', () => {
  const approach = jest.fn();
  const correct = jest.fn();
  const schedule = jest.fn();
  startNarrationLanding({
    approach,
    measure: (done) => {
      done(180, 28);
      return true;
    },
    correct,
    schedule,
  });
  expect(correct).toHaveBeenCalledWith(180, 28);
  expect(approach).not.toHaveBeenCalled();
  expect(schedule).not.toHaveBeenCalled();
});

test('a zero-sized native measurement approaches and retries instead of scrolling to zero', () => {
  const approach = jest.fn();
  const correct = jest.fn();
  const scheduled: Array<() => void> = [];
  let valid = false;
  startNarrationLanding({
    approach,
    measure: (done) => {
      done(valid ? 240 : 0, valid ? 30 : 0);
      return true;
    },
    correct,
    schedule: (callback) => scheduled.push(callback),
  });

  expect(approach).toHaveBeenCalledTimes(1);
  expect(correct).not.toHaveBeenCalled();
  expect(scheduled).toHaveLength(1);
  valid = true;
  scheduled.shift()?.();
  expect(correct).toHaveBeenCalledWith(240, 30);
});

test('cancellation prevents a delayed correction from fighting the reader', () => {
  const correct = jest.fn();
  const scheduled: Array<() => void> = [];
  const cancel = startNarrationLanding({
    approach: jest.fn(),
    measure: () => false,
    correct,
    schedule: (callback) => scheduled.push(callback),
  });
  cancel();
  scheduled.shift()?.();
  expect(correct).not.toHaveBeenCalled();
});

test('an anchor that never mounts retries a bounded number of times', () => {
  const scheduled: Array<() => void> = [];
  const measure = jest.fn(() => false);
  startNarrationLanding({
    approach: jest.fn(),
    measure,
    correct: jest.fn(),
    schedule: (callback) => scheduled.push(callback),
  });
  while (scheduled.length) scheduled.shift()?.();
  expect(measure).toHaveBeenCalledTimes(3);
});
