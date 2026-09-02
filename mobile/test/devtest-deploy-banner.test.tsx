// Kamil, 2026-09-01: "when dispatch implements something, I want there to be an option to deploy
// it. Or for me to just reload the app and for changes to load." A merged PR moves origin/main
// and nothing he can see — DR-116 sat merged and invisible for over an hour, with nothing on the
// phone to explain why reloading did nothing.

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));
jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  dispatchToClaude: jest.fn(),
  resumeDispatch: jest.fn(),
  getDispatchStatus: jest.fn().mockResolvedValue({ dispatch: null }),
  getDeployState: jest.fn(),
  deployNow: jest.fn(),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { DeployBanner } from '@/components/DevTestBubble';
import type { DeployState } from '@/api/endpoints';

const LEVEL: DeployState = {
  target: 'abc', target_subject: 'DR-116: the newest merged thing',
  server: 'abc', server_behind: 0, device: 'abc', device_behind: 0,
  device_worktree: '/w/device-main', device_present: true, needs_npm_ci: false,
  clean: true, deployable: true, last_error: null, active_job: null,
};

const state = (over: Partial<DeployState>): DeployState => ({ ...LEVEL, ...over });

beforeEach(() => jest.clearAllMocks());

test('nothing is shown when the phone is level with main', async () => {
  jest.mocked(api.getDeployState).mockResolvedValue({ deploy: LEVEL });
  const { queryByTestId } = render(<DeployBanner />);
  await waitFor(() => expect(api.getDeployState).toHaveBeenCalled());
  // The normal state. A banner that is always there is a banner nobody reads.
  expect(queryByTestId('devtest-deploy-banner')).toBeNull();
});

test('behind main, it says so and names what is waiting', async () => {
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ device_behind: 2, server_behind: 2, device: 'old', server: 'old' }),
  });
  const { findByText } = render(<DeployBanner />);
  await findByText('2 merged changes not on this phone yet');
  await findByText('DR-116: the newest merged thing');
});

test('one change reads as one, not "1 merged changes"', async () => {
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ device_behind: 1, server_behind: 0, device: 'old' }),
  });
  const { findByText } = render(<DeployBanner />);
  await findByText('1 merged change not on this phone yet');
});

test('deploying tells him the server is restarting when the backend moved', async () => {
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ device_behind: 1, server_behind: 1, device: 'old', server: 'old' }),
  });
  jest.mocked(api.deployNow).mockResolvedValue({
    deploy: {
      target: 'abc', target_subject: 'x', device_was: 'old', device_now: 'abc',
      server_was: 'old', server_pending: true, server_now: 'old',
      needs_app_reload: true, backend_restarting: true, needs_npm_ci: false,
    },
  });
  const { findByTestId, findByText, queryByTestId } = render(<DeployBanner />);
  fireEvent.press(await findByTestId('devtest-deploy-now'));
  await waitFor(() => expect(api.deployNow).toHaveBeenCalled());
  // The button must not stay live: the server checkout moves a couple of seconds from now, so
  // re-reading immediately would show the OLD state and a second tap would race a second child.
  await findByText(/Deploying… reload the app in a moment/);
  expect(queryByTestId('devtest-deploy-now')).toBeNull();
});

test('a live background job blocks deploying, and says which one', async () => {
  // Deploying restarts the server, and a reload kills every in-flight job (DR-083).
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ device_behind: 3, device: 'old', active_job: 'discover' }),
  });
  const { findByText, queryByTestId } = render(<DeployBanner />);
  await findByText(/Cannot deploy: a background job is running \(discover\)/);
  expect(queryByTestId('devtest-deploy-now')).toBeNull();
});

test('uncommitted work in the server checkout blocks deploying', async () => {
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ device_behind: 1, device: 'old', clean: false }),
  });
  const { findByText, queryByTestId } = render(<DeployBanner />);
  await findByText(/uncommitted changes/);
  expect(queryByTestId('devtest-deploy-now')).toBeNull();
});

test('an unreachable server leaves no banner rather than an error', async () => {
  // Starts null, so prove the catch is what keeps it null: a resolving call DOES render.
  jest.mocked(api.getDeployState).mockResolvedValueOnce({
    deploy: state({ device_behind: 1, device: 'old' }),
  });
  const first = render(<DeployBanner />);
  await first.findByTestId('devtest-deploy-banner');

  jest.mocked(api.getDeployState).mockRejectedValue(new Error('offline'));
  const { queryByTestId } = render(<DeployBanner />);
  await waitFor(() => expect(api.getDeployState).toHaveBeenCalledTimes(2));
  expect(queryByTestId('devtest-deploy-banner')).toBeNull();
});

test('a failure in the deferred half surfaces even when nothing is behind', async () => {
  // The server checkout moves after the response, so its failure has nowhere else to be seen —
  // without this the banner would just say nothing and the phone would stay stale.
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ last_error: "Not possible to fast-forward, aborting." }),
  });
  const { findByText } = render(<DeployBanner />);
  await findByText(/Last deploy failed: Not possible to fast-forward/);
});

test('a lockfile change warns that the bundle needs npm ci', async () => {
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ device_behind: 1, device: 'old', needs_npm_ci: true }),
  });
  const { findByText } = render(<DeployBanner />);
  await findByText(/run `npm ci` in the device worktree/);
});

test('a missing device worktree blocks deploying', async () => {
  jest.mocked(api.getDeployState).mockResolvedValue({
    deploy: state({ device_behind: 2, device: 'old', device_present: false }),
  });
  const { findByText, queryByTestId } = render(<DeployBanner />);
  await findByText(/worktree Metro serves is missing/);
  expect(queryByTestId('devtest-deploy-now')).toBeNull();
});
