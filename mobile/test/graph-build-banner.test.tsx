import { renderAsync, screen } from '@testing-library/react-native';

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

test('build banner separates status badge, steps, and the current paper line', async () => {
  await renderAsync(<BuildProgressBanner progress={base as never} />);

  // The skeleton state is a compact badge, not a sentence prefix.
  expect(screen.getByText('✓ Fast map ready')).toBeTruthy();
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
  expect(screen.getByText('10 of 12 ready · 4 analyzed')).toBeTruthy();
});

test('metadata phase shows no skeleton badge and the mapping verb', async () => {
  await renderAsync(
    <BuildProgressBanner
      progress={{ ...base, phase: 'metadata', graphStage: null } as never}
    />,
  );
  expect(screen.queryByText('✓ Fast map ready')).toBeNull();
  expect(screen.getByText('Mapping references')).toBeTruthy();
});

test('marquee renders its full text and exposes it to accessibility', async () => {
  await renderAsync(<Marquee text="Short title" />);
  expect(screen.getByText('Short title')).toBeTruthy();
  expect(screen.getByLabelText('Short title')).toBeTruthy();
});
