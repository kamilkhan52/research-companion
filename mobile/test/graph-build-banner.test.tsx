import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import { BuildProgressBanner } from '@/app/(tabs)/graph';
import { Marquee } from '@/ui/Marquee';

const base = {
  phase: 'extraction',
  graphStage: 'skeleton' as const,
  total: 12,
  ready: 10,
  done: 4,
  currentTitle: 'A Very Long Paper Title That Never Fit On One Line Before',
  retrievalCandidates: {},
  retrievalErrors: {},
};

test('build banner separates status hint, steps, and the current paper line', async () => {
  await renderAsync(<BuildProgressBanner progress={base as never} />);

  // The skeleton becoming usable is a transient hint (U.11), not a permanent badge.
  expect(
    screen.getByText('Fast map ready — explore it now; enrichment keeps improving it in the background.'),
  ).toBeTruthy();
  expect(screen.getByText('Building map…')).toBeTruthy();

  // Discovery-style steps.
  expect(screen.getByText('Mapped')).toBeTruthy();
  expect(screen.getByText('Retrieved')).toBeTruthy();
  expect(screen.getByText('Enriched')).toBeTruthy();

  // The paper being enriched sits on its own line (marquee), labeled by the phase verb.
  expect(screen.getByText('Enriching')).toBeTruthy();
  expect(
    screen.getByLabelText(`Enriching ${base.currentTitle}`),
  ).toBeTruthy();
  expect(screen.getByText('10 of 12 ready')).toBeTruthy();
  expect(screen.getByText('4 analyzed')).toBeTruthy();
});

test('metadata phase shows no skeleton hint and the mapping verb', async () => {
  await renderAsync(
    <BuildProgressBanner
      progress={{ ...base, phase: 'metadata', graphStage: null } as never}
    />,
  );
  expect(screen.queryByText(/Fast map ready/)).toBeNull();
  expect(screen.getByText('Mapping references')).toBeTruthy();
});

test('tapping a build step explains what the stage does', async () => {
  await renderAsync(
    <BuildProgressBanner progress={{ ...base, graphStage: null } as never} />,
  );
  await fireEventAsync.press(screen.getByLabelText('What does Retrieved mean?'));
  expect(screen.getByText(/full text fetched so citations can actually be verified/)).toBeTruthy();
  // A newer hint replaces it; tapping the hint dismisses.
  await fireEventAsync.press(screen.getByLabelText('What does Enriched mean?'));
  expect(screen.queryByText(/full text fetched/)).toBeNull();
  await fireEventAsync.press(screen.getByLabelText('Dismiss hint'));
  expect(screen.queryByText(/read in full to verify/)).toBeNull();
});

test('marquee renders its full text and exposes it to accessibility', async () => {
  await renderAsync(<Marquee text="Short title" />);
  expect(screen.getByText('Short title')).toBeTruthy();
  expect(screen.getByLabelText('Short title')).toBeTruthy();
});

test('build details collapse while the live ready count remains in the header', async () => {
  const first = await renderAsync(
    <BuildProgressBanner progress={base as never} projectId="project-a" />,
  );
  expect(screen.getByText('10 of 12 ready')).toBeTruthy();
  expect(screen.getByText('Mapped')).toBeTruthy();

  await fireEventAsync.press(screen.getByLabelText('Collapse map build details'));
  expect(screen.getByText('10 of 12 ready')).toBeTruthy();
  expect(screen.queryByText('Mapped')).toBeNull();
  expect(screen.queryByLabelText(`Enriching ${base.currentTitle}`)).toBeNull();
  await first.unmountAsync();

  const view = await renderAsync(
    <BuildProgressBanner progress={base as never} projectId="project-a" />,
  );
  await waitFor(() => expect(screen.queryByText('Mapped')).toBeNull());
  await view.rerenderAsync(
    <BuildProgressBanner progress={base as never} projectId="project-b" />,
  );
  await waitFor(() => expect(screen.getByText('Mapped')).toBeTruthy());
});
