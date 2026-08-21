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
  unmonitored: 14,
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
  it('reads as an offer, not loss, when never scanned (DR-046)', () => {
    expect(neighbourhoodSummary({ ...base, ever_swept: false, monitored: 0, age_seconds: null }))
      .toBe('Neighbourhood not scanned yet');
  });
  it('never renders a dangling separator when the age is unknown', () => {
    // ever_swept true but a malformed stored timestamp → age_seconds null.
    const s = neighbourhoodSummary({ ...base, age_seconds: null });
    expect(s).toBe('Neighbourhood checked recently · 20 of 34 papers');
    expect(s).not.toContain('  ');
  });
});

describe('NeighbourhoodLine', () => {
  it('renders the summary, and no misleading "newer papers" hint', () => {
    const { getByText, queryByText } = render(<NeighbourhoodLine neighbourhood={base} />);
    expect(getByText('Neighbourhood checked 2h ago · 20 of 34 papers')).toBeTruthy();
    expect(queryByText(/newer paper/)).toBeNull();
  });
  it('renders nothing without data', () => {
    const { toJSON } = render(<NeighbourhoodLine neighbourhood={undefined} />);
    expect(toJSON()).toBeNull();
  });
  it('shows a refresh action only when given one (Discover), not read-only (Map)', () => {
    const withRefresh = render(<NeighbourhoodLine neighbourhood={base} onRefresh={() => {}} refreshLabel="Refresh" />);
    expect(withRefresh.getByText('Refresh')).toBeTruthy();
    const readOnly = render(<NeighbourhoodLine neighbourhood={base} />);
    expect(readOnly.queryByText('Refresh')).toBeNull();
  });
});
