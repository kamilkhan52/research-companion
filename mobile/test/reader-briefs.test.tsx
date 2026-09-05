// DR-140 — reading assistants for the project papers a response cited without anyone here
// having read them. Kamil's design: prompt with check marks so the reader picks the papers,
// a simple status per assistant while they read, and the briefs viewable but collapsed.

import { fireEvent, render } from '@testing-library/react-native';

import type { ReaderBrief, ReaderCandidate, ReaderJob } from '@/api/types';
import {
  ReaderBriefsTrail,
  ReaderOfferCard,
  ReaderProgressCard,
  readerHandoffLine,
  readerProgressTitle,
} from '@/components/ReaderBriefs';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const CANDIDATES: ReaderCandidate[] = [
  { slug: 'h3', title: 'H3: HBM-side staging', year: 2025, has_text: true },
  { slug: 'memexplorer', title: 'MemExplorer', year: 2026, has_text: true },
  { slug: 'ghost', title: 'Ghost paper', year: null, has_text: false },
];

function job(overrides: Partial<ReaderJob> = {}): ReaderJob {
  return {
    id: 'r1',
    status: 'running',
    error: null,
    slug: 'flint',
    thread_id: 'main',
    assistant_index: 0,
    targets: [
      { slug: 'h3', title: 'H3: HBM-side staging', status: 'done', error: null },
      { slug: 'memexplorer', title: 'MemExplorer', status: 'reading', error: null },
    ],
    current: 'memexplorer',
    delivery_mode: 'reading',
    stopped_reason: null,
    analysis_job_id: null,
    analysis_error: null,
    ...overrides,
  };
}

describe('the offer', () => {
  test('lists every cited unread paper with a check mark; unfetched ones cannot be picked', () => {
    const onToggle = jest.fn();
    const screen = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3', 'memexplorer'])}
        onToggle={onToggle}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        starting={false}
      />,
    );
    expect(screen.getByText(/Read the papers this response cites/)).toBeTruthy();
    expect(screen.getByText('H3: HBM-side staging (2025)')).toBeTruthy();
    expect(screen.getByText(/Not fetched yet/)).toBeTruthy();
    expect(screen.getByTestId('reader-candidate-h3').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('reader-candidate-ghost').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('reader-candidate-h3'));
    expect(onToggle).toHaveBeenCalledWith('h3');
    fireEvent.press(screen.getByTestId('reader-candidate-ghost'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test('the button counts only the picked, readable papers and disables at zero', () => {
    const onStart = jest.fn();
    const one = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3', 'ghost'])}
        onToggle={jest.fn()}
        onStart={onStart}
        onDismiss={jest.fn()}
        starting={false}
      />,
    );
    expect(one.getByText('Read 1 paper')).toBeTruthy();
    fireEvent.press(one.getByTestId('reader-start'));
    expect(onStart).toHaveBeenCalled();

    const none = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set()}
        onToggle={jest.fn()}
        onStart={onStart}
        onDismiss={jest.fn()}
        starting={false}
      />,
    );
    expect(none.getByText('Read 0 papers')).toBeTruthy();
    expect(none.getByTestId('reader-start').props.accessibilityState.disabled).toBe(true);
  });

  test('"Not now" is the reader\'s answer, and a start error stays on the card', () => {
    const onDismiss = jest.fn();
    const screen = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3'])}
        onToggle={jest.fn()}
        onStart={jest.fn()}
        onDismiss={onDismiss}
        starting={false}
        error="A response is already being generated for this paper — wait for it."
      />,
    );
    fireEvent.press(screen.getByText('Not now'));
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.getByText(/already being generated/)).toBeTruthy();
  });
});

describe('the pass', () => {
  test('shows one status per paper while the assistants read', () => {
    const onCancel = jest.fn();
    const screen = render(<ReaderProgressCard job={job()} onCancel={onCancel} />);
    expect(screen.getByText('Reading 2 papers… 1 of 2 read')).toBeTruthy();
    expect(screen.getByLabelText('H3: HBM-side staging: Read')).toBeTruthy();
    expect(screen.getByLabelText('MemExplorer: Reading')).toBeTruthy();
    fireEvent.press(screen.getByText('Stop after this paper'));
    expect(onCancel).toHaveBeenCalled();
  });

  test('a finished pass says the briefs are on their way to the agent', () => {
    const done = job({
      status: 'done',
      targets: [
        { slug: 'h3', title: 'H3: HBM-side staging', status: 'done', error: null },
        { slug: 'memexplorer', title: 'MemExplorer', status: 'error', error: 'provider hiccup' },
      ],
      current: null,
      analysis_job_id: 'c1',
    });
    const screen = render(<ReaderProgressCard job={done} onDismiss={jest.fn()} />);
    expect(screen.getByText('Read 1 of 2 papers')).toBeTruthy();
    expect(screen.getByText('Failed — provider hiccup')).toBeTruthy();
    expect(screen.getByText(/Handing the briefs to the agent/)).toBeTruthy();
    // Nothing to dismiss: the follow-up response replaces this card when it lands.
    expect(screen.queryByText('Dismiss')).toBeNull();
  });

  test('a budget stop names the skipped papers and the reason; a failed pass is dismissible', () => {
    const stopped = job({
      status: 'done',
      targets: [
        { slug: 'h3', title: 'H3: HBM-side staging', status: 'done', error: null },
        { slug: 'memexplorer', title: 'MemExplorer', status: 'skipped', error: 'Monthly allowance used.' },
      ],
      stopped_reason: 'Monthly allowance used.',
      analysis_job_id: 'c1',
    });
    expect(readerHandoffLine(stopped)).toMatch(/Handing the briefs/);
    const screen = render(<ReaderProgressCard job={stopped} />);
    expect(screen.getByText('Skipped — Monthly allowance used.')).toBeTruthy();

    const failed = job({
      status: 'error',
      error: 'None of the papers could be read: down',
      targets: [{ slug: 'h3', title: 'H3: HBM-side staging', status: 'error', error: 'down' }],
    });
    expect(readerProgressTitle(failed)).toBe('Could not read the paper');
    expect(readerHandoffLine(failed)).toBe('None of the papers could be read: down');
    const onDismiss = jest.fn();
    const shown = render(<ReaderProgressCard job={failed} onDismiss={onDismiss} />);
    fireEvent.press(shown.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalled();
  });

  test('a recorded briefing whose follow-up never started says so', () => {
    const orphan = job({
      status: 'done',
      targets: [{ slug: 'h3', title: 'H3: HBM-side staging', status: 'done', error: null }],
      analysis_error: 'The model provider is unreachable.',
    });
    expect(readerHandoffLine(orphan)).toMatch(/follow-up did not start: The model provider/);
  });
});

describe('the briefs on the response', () => {
  const BRIEFS: ReaderBrief[] = [
    { slug: 'h3', title: 'H3: HBM-side staging', text: '## What H3 proposes\n\nA staging buffer.' },
    { slug: 'memexplorer', title: 'MemExplorer', text: 'Concurrent work on heterogeneous memory.' },
  ];

  test('collapsed by default: one quiet row, no brief text', () => {
    const screen = render(<ReaderBriefsTrail briefs={BRIEFS} />);
    expect(screen.getByText('Read 2 papers for this response')).toBeTruthy();
    expect(screen.queryByText('H3: HBM-side staging')).toBeNull();
    expect(screen.queryByText(/staging buffer/)).toBeNull();
  });

  test('expands to the paper list, and each brief opens on its own', async () => {
    const screen = render(<ReaderBriefsTrail briefs={BRIEFS} />);
    fireEvent.press(screen.getByText('Read 2 papers for this response'));
    expect(screen.getByText('H3: HBM-side staging')).toBeTruthy();
    expect(screen.getByText('MemExplorer')).toBeTruthy();
    expect(screen.queryByText(/staging buffer/)).toBeNull();

    fireEvent.press(screen.getByTestId('reader-brief-h3'));
    expect(await screen.findByText('What H3 proposes')).toBeTruthy();
    expect(screen.queryByText(/heterogeneous memory/)).toBeNull();

    fireEvent.press(screen.getByText('Read 2 papers for this response'));
    expect(screen.queryByText('H3: HBM-side staging')).toBeNull();
  });
});
