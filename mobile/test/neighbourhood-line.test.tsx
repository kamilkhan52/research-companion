// DR-052 PR 4 — the shared neighbourhood freshness line's pure logic: coarse relative age,
// the summary string, and the not-mapped / stale distinctions.

import { render } from '@testing-library/react-native';

import type { Neighbourhood } from '@/api/endpoints';
import {
  NeighbourhoodLine,
  neighbourhoodSummary,
  relativeAge,
} from '@/components/NeighbourhoodLine';

const base: Neighbourhood = {
  last_swept: '2026-08-21T15:00:00+00:00',
  age_seconds: 7200,
  monitored: 20,
  total_papers: 34,
  composition_stale: 14,
  time_stale: false,
  ever_swept: true,
};

describe('relativeAge', () => {
  it.each([
    [30, 'just now'],
    [300, '5 min ago'],
    [7200, '2h ago'],
    [90000, '1d ago'],
    [7 * 86400, '1w ago'],
    [40 * 86400, '1mo ago'],
    [null, ''],
  ])('%s → %s', (s, expected) => {
    expect(relativeAge(s as number | null)).toBe(expected);
  });
});

describe('neighbourhoodSummary', () => {
  it('names the age and the monitored fraction when swept', () => {
    expect(neighbourhoodSummary(base)).toBe('Neighbourhood checked 2h ago · 20 of 34 papers');
  });
  it('reads as an offer, not loss, when never mapped (DR-046)', () => {
    expect(neighbourhoodSummary({ ...base, ever_swept: false, monitored: 0, age_seconds: null }))
      .toBe('Neighbourhood not mapped yet');
  });
});

describe('NeighbourhoodLine', () => {
  it('renders the composition-stale hint as information, not a warning', () => {
    const { getByText } = render(<NeighbourhoodLine neighbourhood={base} />);
    expect(getByText('14 newer papers join on the next run')).toBeTruthy();
  });
  it('renders nothing without data', () => {
    const { toJSON } = render(<NeighbourhoodLine neighbourhood={undefined} />);
    expect(toJSON()).toBeNull();
  });
  it('shows the refresh action label and disables it while refreshing', () => {
    const { getByText, rerender } = render(
      <NeighbourhoodLine neighbourhood={base} onRefresh={() => {}} refreshLabel="Rebuild" />,
    );
    expect(getByText('Rebuild')).toBeTruthy();
    rerender(
      <NeighbourhoodLine neighbourhood={base} onRefresh={() => {}} refreshLabel="Rebuild" refreshing />,
    );
    expect(getByText('Refreshing…')).toBeTruthy();
  });
});
