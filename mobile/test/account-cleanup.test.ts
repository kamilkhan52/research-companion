import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearDeletedAccountStorage } from '@/auth/accountCleanup';

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
  ])).toEqual([
    ['rc.activeProject', null],
    ['rc.draft.v1:project-a:paper', null],
    ['rc.lastThread.v1:project-a:paper', null],
    ['rc.paperSort.v1:project-a', null],
    ['rc.eligibleListeningHandoffs', null],
    ['rc.handledAudioHandoffs', null],
  ]);
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
