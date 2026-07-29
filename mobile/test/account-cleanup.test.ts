import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';

import {
  clearAccountDeletionIntent,
  clearDeletedAccountStorage,
  hasAccountDeletionIntent,
  markAccountDeletionIntent,
} from '@/auth/accountCleanup';

jest.mock('expo-image', () => ({
  Image: {
    clearMemoryCache: jest.fn(async () => true),
    clearDiskCache: jest.fn(async () => true),
  },
}));

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('deletion purges account research state but keeps device preferences and server choice', async () => {
  await AsyncStorage.multiSet([
    ['rc.activeProject', 'project-a'],
    ['rc.draft.v1:project-a:paper', '{"value":"private draft"}'],
    ['rc.lastThread.v1:project-a:paper', 'thread-a'],
    ['rc.paperSort.v1:project-a', 'year'],
    ['rc.eligibleListeningHandoffs', '["job-a"]'],
    ['rc.handledAudioHandoffs', '["job-b"]'],
    ['rc.playbackSnapshot.v1', '{"title":"private narration"}'],
    ['rc.continueCard.dismissed.v1', 'project-a memory-paper'],
    ['rc.baseUrl', 'https://staging.example.com'],
    ['rc.themeMode', 'light'],
    ['rc.layoutDensity', 'tight'],
    ['rc.listeningMode', 'true'],
    ['rc.audioPlayback', 'full'],
    ['rc.playbackRate', '1.25'],
    ['rc.graph.allowAllFilter', 'true'],
  ]);

  await clearDeletedAccountStorage();

  expect(await AsyncStorage.multiGet([
    'rc.activeProject',
    'rc.draft.v1:project-a:paper',
    'rc.lastThread.v1:project-a:paper',
    'rc.paperSort.v1:project-a',
    'rc.eligibleListeningHandoffs',
    'rc.handledAudioHandoffs',
    'rc.playbackSnapshot.v1',
    'rc.continueCard.dismissed.v1',
  ])).toEqual([
    ['rc.activeProject', null],
    ['rc.draft.v1:project-a:paper', null],
    ['rc.lastThread.v1:project-a:paper', null],
    ['rc.paperSort.v1:project-a', null],
    ['rc.eligibleListeningHandoffs', null],
    ['rc.handledAudioHandoffs', null],
    ['rc.playbackSnapshot.v1', null],
    ['rc.continueCard.dismissed.v1', null],
  ]);
  expect(Image.clearMemoryCache).toHaveBeenCalledTimes(1);
  expect(Image.clearDiskCache).toHaveBeenCalledTimes(1);
  expect(await AsyncStorage.multiGet([
    'rc.baseUrl',
    'rc.themeMode',
    'rc.layoutDensity',
    'rc.listeningMode',
    'rc.audioPlayback',
    'rc.playbackRate',
    'rc.graph.allowAllFilter',
  ])).toEqual([
    ['rc.baseUrl', 'https://staging.example.com'],
    ['rc.themeMode', 'light'],
    ['rc.layoutDensity', 'tight'],
    ['rc.listeningMode', 'true'],
    ['rc.audioPlayback', 'full'],
    ['rc.playbackRate', '1.25'],
    ['rc.graph.allowAllFilter', 'true'],
  ]);
});

test('deletion intent survives data cleanup until the authenticated flow is finished', async () => {
  await markAccountDeletionIntent();
  await clearDeletedAccountStorage();
  expect(await hasAccountDeletionIntent()).toBe(true);

  await clearAccountDeletionIntent();
  expect(await hasAccountDeletionIntent()).toBe(false);
});
