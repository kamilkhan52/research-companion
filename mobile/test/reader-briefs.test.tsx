// DR-140 — reading assistants for the project papers cited by a response. Kamil's design:
// prompt with check marks so the reader picks the papers,
// a simple status per assistant while they read, and the briefs viewable but collapsed.

import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { ReaderBrief, ReaderCandidate, ReaderJob } from '@/api/types';
import {
  ReaderBriefsTrail,
  ReaderOfferCard,
  ReaderOfferLink,
  ReaderOfferSheet,
  ReaderProgressCard,
  ReaderProgressIndicator,
  readerHandoffLine,
  readerProgressTitle,
} from '@/components/ReaderBriefs';
import { fonts } from '@/theme/tokens';

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
    briefs: [{ slug: 'h3', title: 'H3: HBM-side staging', text: 'H3 proposes a staging buffer.' }],
    waiting: false,
    stopped_reason: null,
    analysis_job_id: null,
    analysis_error: null,
    started_at: '2026-09-04T00:00:00+00:00',
    finished_at: null,
    ...overrides,
  };
}

describe('the pass, after the review of #492', () => {
  test('a pass waiting for a reply the reader sent meanwhile says so', () => {
    const screen = render(<ReaderProgressCard job={job({ waiting: true })} />);
    expect(screen.getByText(/Waiting for the current response to finish/)).toBeTruthy();
  });

  test('briefs that never reached the agent stay readable on the card', () => {
    const orphan = job({
      status: 'done',
      finished_at: '2026-09-04T00:01:00+00:00',
      targets: [{ slug: 'h3', title: 'H3: HBM-side staging', status: 'done', error: null }],
      analysis_error: 'provider down',
    });
    const screen = render(<ReaderProgressCard job={orphan} onDismiss={jest.fn()} />);
    expect(screen.getByText('Read 1 paper for this response')).toBeTruthy();
    // Once the follow-up is on its way, the response itself will carry them.
    const handed = job({ status: 'done', finished_at: 'x', analysis_job_id: 'c1' });
    const later = render(<ReaderProgressCard job={handed} />);
    expect(later.queryByTestId('reader-briefs-trail')).toBeNull();
  });
});

describe('the offer', () => {
  test('lists every cited unread paper with a check mark; unfetched ones cannot be picked', () => {
    const onToggle = jest.fn();
    const screen = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3', 'memexplorer'])}
        maxTargets={8}
        onToggle={onToggle}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        starting={false}
      />,
    );
    expect(screen.getByText('Seminar would like to read these related works.')).toBeTruthy();
    expect(screen.queryByText(/nobody|agent described|reading assistant/i)).toBeNull();
    expect(screen.getByText('H3: HBM-side staging (2025)')).toBeTruthy();
    expect(screen.getByTestId('reader-candidate-h3').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('reader-candidate-ghost').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('reader-candidate-h3'));
    expect(onToggle).toHaveBeenCalledWith('h3');
    fireEvent.press(screen.getByTestId('reader-candidate-ghost'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  // DR-145 (Kamil): "I also don't see an option to fetch at the moment… On first thought I
  // assumed I just couldn't select the unselected papers due to a bug."
  test('an unfetched paper says what is happening to it and can be asked for again', () => {
    const onFetch = jest.fn();
    const idle = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set()}
        maxTargets={8}
        onToggle={jest.fn()}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        onFetch={onFetch}
        starting={false}
      />,
    );
    fireEvent.press(idle.getByTestId('reader-fetch-ghost'));
    expect(onFetch).toHaveBeenCalledWith('ghost');
    // Only the paper that has no text offers one.
    expect(idle.queryByTestId('reader-fetch-h3')).toBeNull();

    const running = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set()}
        maxTargets={8}
        onToggle={jest.fn()}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        onFetch={onFetch}
        fetching={{ ghost: { status: 'running' } }}
        starting={false}
      />,
    );
    expect(running.getByText('Fetching its text…')).toBeTruthy();
    // Nothing to press while it is already being fetched.
    expect(running.queryByTestId('reader-fetch-ghost')).toBeNull();

    const failed = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set()}
        maxTargets={8}
        onToggle={jest.fn()}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        onFetch={onFetch}
        fetching={{ ghost: { status: 'error', error: 'No PDF found for it.' } }}
        starting={false}
      />,
    );
    expect(failed.getByText('No PDF found for it.')).toBeTruthy();
    expect(failed.getByText('Try again')).toBeTruthy();
    expect(failed.getByLabelText(/Ghost paper\. No PDF found for it\./)).toBeTruthy();
  });

  // DR-145 (Kamil): "All fonts should be smaller in the prompt. Maybe similar sizes mostly to
  // the chat font size which is a setting."
  test('its type follows the discussion face and the reader\'s text-size setting', () => {
    const screen = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3'])}
        maxTargets={8}
        onToggle={jest.fn()}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        starting={false}
        textScale={1.2}
      />,
    );
    const heading = screen.getByText('Seminar would like to read these related works.');
    const headingStyle = StyleSheet.flatten(heading.props.style);
    expect(headingStyle.fontFamily).toBe(fonts.serifMedium);
    const title = screen.getByText('H3: HBM-side staging (2025)');
    const titleStyle = StyleSheet.flatten(title.props.style);
    expect(titleStyle.fontFamily).toBe(fonts.serif);
    // The unscaled caption is 12.5; the setting multiplies it rather than being ignored.
    expect(titleStyle.fontSize).toBeCloseTo(15);
  });

  test('the button counts only the picked, readable papers and disables at zero', () => {
    const onStart = jest.fn();
    const one = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3', 'ghost'])}
        maxTargets={8}
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
        maxTargets={8}
        onToggle={jest.fn()}
        onStart={onStart}
        onDismiss={jest.fn()}
        starting={false}
      />,
    );
    expect(none.getByText('Read 0 papers')).toBeTruthy();
    expect(none.getByTestId('reader-start').props.accessibilityState.disabled).toBe(true);
  });

  test('"Not now" closes the window, and a start error stays on the card', () => {
    const onDismiss = jest.fn();
    const screen = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3'])}
        maxTargets={8}
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

// DR-145 (Kamil): "I think the prompt should be a window on top instead of inside the chat. I
// should be able to just dismiss it and come back to it later, using a little indicator at the
// bottom of the message… They can read the summary and reopen the prompt or just forget about it."
describe('the offer window and its indicator', () => {
  const cardProps = {
    candidates: CANDIDATES,
    selected: new Set(['h3']),
    maxTargets: 8,
    onToggle: jest.fn(),
    onStart: jest.fn(),
    onDismiss: jest.fn(),
    starting: false,
  };

  test('the offer renders in a sheet, not in the transcript, and closing it reports back', () => {
    const onClose = jest.fn();
    const hidden = render(<ReaderOfferSheet visible={false} onClose={onClose} {...cardProps} />);
    expect(hidden.queryByTestId('reader-offer')).toBeNull();

    const shown = render(<ReaderOfferSheet visible onClose={onClose} {...cardProps} />);
    expect(shown.getByTestId('reader-offer')).toBeTruthy();
    fireEvent.press(shown.getByLabelText('Dismiss test bottom sheet'));
    expect(onClose).toHaveBeenCalled();
  });

  test('the indicator names the papers and reopens the window', () => {
    const onOpen = jest.fn();
    const one = render(<ReaderOfferLink count={1} onOpen={onOpen} />);
    expect(one.getByText('Seminar would like to read this related work.')).toBeTruthy();
    expect(one.getByLabelText('Seminar would like to read this related work. Tap to open.')).toBeTruthy();

    const many = render(<ReaderOfferLink count={3} onOpen={onOpen} textScale={1.2} />);
    const label = many.getByText('Seminar would like to read these related works.');
    expect(StyleSheet.flatten(label.props.style).fontSize).toBeCloseTo(15);
    fireEvent.press(many.getByTestId('reader-offer-link'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('the pass', () => {
  test('stays a header icon until opened, and the sheet can be hidden without losing it', () => {
    const screen = render(
      <ReaderProgressIndicator
        job={job()}
        onCancel={jest.fn()}
        onDismiss={jest.fn()}
        textScale={1.2}
      />,
    );
    expect(screen.getByTestId('reader-progress-indicator')).toBeTruthy();
    expect(screen.queryByTestId('reader-progress')).toBeNull();

    fireEvent.press(screen.getByTestId('reader-progress-trigger'));
    expect(screen.getByTestId('reader-progress')).toBeTruthy();
    const title = screen.getByText('Reading 2 papers… 1 of 2 read');
    const titleStyle = StyleSheet.flatten(title.props.style);
    expect(titleStyle.fontFamily).toBe(fonts.serifMedium);
    expect(titleStyle.fontSize).toBeCloseTo(15);

    fireEvent.press(screen.getByLabelText('Dismiss test bottom sheet'));
    expect(screen.queryByTestId('reader-progress')).toBeNull();
    expect(screen.getByTestId('reader-progress-indicator')).toBeTruthy();
  });

  test('the sheet forwards Stop and a terminal Dismiss clears the pass', () => {
    const onCancel = jest.fn();
    const running = render(
      <ReaderProgressIndicator job={job()} onCancel={onCancel} onDismiss={jest.fn()} />,
    );
    fireEvent.press(running.getByTestId('reader-progress-trigger'));
    fireEvent.press(running.getByText('Stop after this paper'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    const onDismiss = jest.fn();
    const failed = job({ status: 'error', error: 'down', finished_at: 'x' });
    const terminal = render(
      <ReaderProgressIndicator job={failed} onCancel={jest.fn()} onDismiss={onDismiss} />,
    );
    fireEvent.press(terminal.getByTestId('reader-progress-trigger'));
    fireEvent.press(terminal.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(terminal.queryByTestId('reader-progress')).toBeNull();
  });

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

// Opus review of #503: the Fetch button was laid out past the row's right edge on every
// candidate, which defeats the "option to fetch" DR-145 exists to add. A flex child in Yoga
// defaults to `flexShrink: 0` (unlike on the web), so the checkbox half sized itself to the
// longest title's intrinsic width and pushed its sibling off screen.
//
// RNTL runs no Yoga layout, so this pins the STYLE CONTRACT that makes the layout come out
// right, not the pixels. It is a weaker assertion than a screenshot and is written knowing that:
// what it defends against is the flex being dropped again, which is exactly how this arose.
test('the checkbox half can shrink, so the Fetch button stays on the row', () => {
  const screen = render(
    <ReaderOfferCard
      candidates={[{ slug: 'ghost', title: 'A very long paper title '.repeat(6), year: null, has_text: false }]}
      selected={new Set()}
      maxTargets={8}
      onToggle={() => undefined}
      onStart={() => undefined}
      onDismiss={() => undefined}
      onFetch={() => undefined}
      fetching={{}}
      starting={false}
    />,
  );
  const main = StyleSheet.flatten(screen.getByTestId('reader-candidate-ghost').props.style);
  expect(main.flex).toBe(1);
  const fetch = StyleSheet.flatten(screen.getByTestId('reader-fetch-ghost').props.style);
  expect(fetch.flexShrink).toBe(0);
});

// ------------------------------------------------------------------ DR-155: the pass limit

describe('the offer states the pass limit', () => {
  const many: ReaderCandidate[] = Array.from({ length: 17 }, (_, i) => (
    { slug: `p${i}`, title: `Paper ${i}`, year: null, has_text: true }
  ));

  function offer(selected: string[], maxTargets = 8) {
    return render(
      <ReaderOfferCard
        candidates={many}
        selected={new Set(selected)}
        maxTargets={maxTargets}
        onToggle={jest.fn()}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        starting={false}
      />,
    );
  }

  test('says the cap and the count before it binds, and only when it can bind', () => {
    const screen = offer(['p0', 'p1']);
    expect(screen.getByTestId('reader-cap-note').props.children.join('')).toContain(
      'One pass reads up to 8 — 2 of 17 chosen',
    );
    // The button must never offer more than the pass accepts (it read "Read 17 papers").
    expect(screen.queryByText(/Read 17 papers/)).toBeNull();

    // With fewer candidates than the cap the line is noise, so it is not there at all.
    const small = render(
      <ReaderOfferCard
        candidates={CANDIDATES}
        selected={new Set(['h3'])}
        maxTargets={8}
        onToggle={jest.fn()}
        onStart={jest.fn()}
        onDismiss={jest.fn()}
        starting={false}
      />,
    );
    expect(small.queryByTestId('reader-cap-note')).toBeNull();
  });

  test('at the cap the unchosen rows go inert and say why', () => {
    const chosen = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const screen = offer(chosen);
    expect(screen.getByTestId('reader-cap-note').props.children.join('')).toContain(
      'Untick one to choose another.',
    );

    const unchosen = screen.getByTestId('reader-candidate-p8');
    expect(unchosen.props.accessibilityState.disabled).toBe(true);
    // DR-145's lesson: a row that goes dead has to explain itself where it is, not only in a
    // line the reader may have scrolled past.
    expect(unchosen.props.accessibilityLabel).toContain('One pass reads up to 8 papers');

    // A chosen row stays live — unticking is how you make room.
    expect(screen.getByTestId('reader-candidate-p0').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByText('Read 8 papers')).toBeTruthy();
  });

  test('below the cap every readable row is still selectable', () => {
    const screen = offer(['p0']);
    expect(screen.getByTestId('reader-candidate-p8').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('reader-candidate-p8').props.accessibilityLabel).toBe('Paper 8');
  });
});
