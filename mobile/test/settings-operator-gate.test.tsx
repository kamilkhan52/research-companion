// The settings screen edits INSTANCE-wide configuration — one OpenRouter key, one model, one
// voice, one set of prompts, shared by every user of the server. Only the named operator may write
// it (RC_OPERATOR_USERS); everyone else gets a 403. These tests pin the two halves of that: the
// shared controls go read-only for a reader, and the reader's own DEVICE-local controls (playback
// mode, theme, density, the map filter, the server URL) keep working.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderAsync, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import SettingsScreen from '@/app/settings';
import * as queries from '@/api/queries';
import { AuthProvider } from '@/auth/AuthProvider';
import { ProjectProvider } from '@/store/project';
import { ListeningProvider } from '@/store/listening';
import { GraphSettingsProvider } from '@/store/graphSettings';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { ToastProvider } from '@/ui/Toast';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));
// Settings stops narration before signing out, so it now consumes the audio context. Mocked
// rather than wrapped in a real AudioProvider: that would pull in TrackPlayer and the whole
// playback stack for a test about which settings fields are editable.
jest.mock('@/audio/AudioProvider', () => ({
  useAudio: () => ({ dismiss: jest.fn(async () => undefined) }),
}));
// The settings screen pulls in AuthProvider (for the sign-out control), which touches expo-linking.
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `researchcompanion://${path}`,
  parse: jest.fn(() => ({ queryParams: {} })),
  getInitialURL: jest.fn(async () => null),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('@/api/config', () => ({
  getBaseUrl: () => 'https://example.test',
  hasBaseUrl: () => true,
  setBaseUrl: jest.fn(),
  // AuthProvider re-bootstraps when the server URL changes, so it subscribes here.
  subscribeBaseUrl: jest.fn(() => jest.fn()),
  setToken: jest.fn(async () => undefined),
}));

const settings = {
  has_key: true, key_hint: 'sk-or-…', model: 'model/a', narration_model: 'model/n',
  preview_model: '', has_openai_key: false, openai_key_hint: '', speech_provider: 'openai',
  tts_model: 'tts-1-hd', tts_voice: 'nova', voices: ['nova', 'alloy'],
  has_parallel_key: false, parallel_key_hint: '', has_firecrawl_key: false, firecrawl_key_hint: '',
  has_semantic_scholar_key: false, semantic_scholar_key_hint: '',
  prior_notes_scope: 'related' as const,
};

function stubQueries(isOperator: boolean | undefined) {
  jest.spyOn(queries, 'useSettings').mockReturnValue({
    data: { ...settings, is_operator: isOperator }, isLoading: false, isError: false,
  } as never);
  jest.spyOn(queries, 'useFavoriteModels').mockReturnValue({ data: [] } as never);
  jest.spyOn(queries, 'usePrompts').mockReturnValue({
    data: [], isLoading: false, isError: false, isFetching: false, refetch: jest.fn(),
  } as never);
  jest.spyOn(queries, 'useUsage').mockReturnValue({
    data: undefined, isLoading: false, isError: false,
  } as never);
  jest.spyOn(queries, 'useSaveSettings').mockReturnValue({
    mutateAsync: jest.fn(), isPending: false, isError: false,
  } as never);
  jest.spyOn(queries, 'useSavePrompt').mockReturnValue({ mutateAsync: jest.fn() } as never);
  jest.spyOn(queries, 'useResetPrompt').mockReturnValue({ mutateAsync: jest.fn() } as never);
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

/** The screen's real provider stack from `_layout.tsx`, minus what it does not touch. */
function renderScreen() {
  return renderAsync(
    <QueryClientProvider client={client}>
      {/* Settings shows a sign-out control, so the screen now needs the auth context. */}
      <AuthProvider>
      <ThemeProvider>
        <ToastProvider>
          <ProjectProvider>
            <ListeningProvider>
              <GraphSettingsProvider>
                <SettingsScreen />
              </GraphSettingsProvider>
            </ListeningProvider>
          </ProjectProvider>
        </ToastProvider>
      </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Whether the toggle carrying `label` refuses interaction. Walks up from the label text to the
 *  nearest node declaring `accessibilityState.disabled`, and THROWS if there is none — a silent
 *  `false` here would let a toggle that lost its accessibility state pass as "enabled". */
function inert(label: string): boolean {
  let node: ReactTestInstance | null = screen.getByText(label).parent;
  while (node) {
    const state = node.props?.accessibilityState as { disabled?: boolean } | undefined;
    if (state && 'disabled' in state) return state.disabled === true;
    node = node.parent;
  }
  throw new Error(`no accessibilityState above the "${label}" toggle`);
}

/** Toggles that write instance-wide settings, and toggles that write only this device. */
const SHARED_TOGGLES = ['Related papers', 'All read papers', 'OpenAI', 'Browser'];
const LOCAL_TOGGLES = [
  'Full track', 'Progressive',            // narration playback (AsyncStorage)
  'System', 'Dim', 'Black', 'Light',      // theme
  'Comfortable', 'Tight',                 // density
  'Hidden', 'Shown',                      // the map's "All" filter
];

test('a reader sees the shared settings read-only, with their device controls still live', async () => {
  stubQueries(false);
  await renderScreen();

  expect(screen.getByText('Shared settings are read-only')).toBeTruthy();

  // Instance-wide text fields: not editable.
  for (const value of ['model/a', 'model/n']) {
    expect(screen.getByDisplayValue(value).props.editable).toBe(false);
  }
  // The server URL belongs to this device and must stay editable even for a reader — it is how
  // they point the app at a different backend in the first place.
  expect(screen.getByDisplayValue('https://example.test').props.editable).toBe(true);

  // Shared toggles inert; device-local toggles live. Getting `local` wrong on any of these is the
  // failure this test exists to catch — a reader who cannot change their own theme or playback
  // mode is worse off than before the gate existed.
  for (const label of SHARED_TOGGLES) expect([label, inert(label)]).toEqual([label, true]);
  for (const label of LOCAL_TOGGLES) expect([label, inert(label)]).toEqual([label, false]);

  // Nothing to submit: the save button posts only shared settings.
  expect(screen.queryByText('Save settings')).toBeNull();
});

// The guard on the test above: an implementation that disabled EVERYTHING for EVERYONE would
// satisfy it completely while making the screen useless for the one person allowed to use it.
test('the operator gets the same screen fully writable', async () => {
  stubQueries(true);
  await renderScreen();

  expect(screen.queryByText('Shared settings are read-only')).toBeNull();
  expect(screen.getByDisplayValue('model/a').props.editable).toBe(true);
  expect(screen.getByText('Save settings')).toBeTruthy();
  for (const label of [...SHARED_TOGGLES, ...LOCAL_TOGGLES]) {
    expect([label, inert(label)]).toEqual([label, false]);
  }
});

// A backend older than the gate omits the flag and accepts the write from anyone, so assuming
// read-only there would lock a user out of settings that the server would happily have taken.
test('a backend that does not report the flag is treated as writable', async () => {
  stubQueries(undefined);
  await renderScreen();

  expect(screen.queryByText('Shared settings are read-only')).toBeNull();
  expect(screen.getByText('Save settings')).toBeTruthy();
});
