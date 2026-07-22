import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearLastThread, loadLastThread, saveLastThread } from '@/lib/lastThread';

afterEach(() => AsyncStorage.clear());

test('remembers the last-opened thread per project and paper', async () => {
  saveLastThread('proj-a', 'paper-1', 'thread-xyz');
  await expect(loadLastThread('proj-a', 'paper-1')).resolves.toBe('thread-xyz');
  // Other papers/projects are unaffected.
  await expect(loadLastThread('proj-a', 'paper-2')).resolves.toBeNull();
  await expect(loadLastThread('proj-b', 'paper-1')).resolves.toBeNull();

  clearLastThread('proj-a', 'paper-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(loadLastThread('proj-a', 'paper-1')).resolves.toBeNull();
});

test('slugs and pids with delimiter characters cannot collide', async () => {
  saveLastThread('a:b', 'c', 'first');
  saveLastThread('a', 'b:c', 'second');
  await expect(loadLastThread('a:b', 'c')).resolves.toBe('first');
  await expect(loadLastThread('a', 'b:c')).resolves.toBe('second');
});
