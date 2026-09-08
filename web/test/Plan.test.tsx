import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanUsage, percentLabel, percentValue, remainingFraction, resetLabel } from '@/components/Plan';

const api = vi.hoisted(() => ({ getPlan: vi.fn() }));
vi.mock('@/api/endpoints', () => api);

const GIGA = 1_000_000_000;

function plan(overrides: Record<string, unknown> = {}) {
  return {
    plan: { name: 'basic', summary: '20 papers a month, with narration to match', monthly_credits: 2500 },
    limit_nanousd: 100 * GIGA,
    spent_nanousd: 20 * GIGA,
    held_nanousd: 0,
    remaining_nanousd: 80 * GIGA,
    spent_fraction: 0.2,
    warn: false,
    warn_at_fraction: 0.8,
    at_capacity: false,
    period_ends: '2026-10-01T00:00:00+00:00',
    enforced: true,
    usage_available: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getPlan.mockResolvedValue(plan());
});

afterEach(() => vi.restoreAllMocks());

describe('remainingFraction', () => {
  it('is derived from spend alone, never from remaining_nanousd', () => {
    // remaining_nanousd subtracts holds too. A reader with several jobs running would be told
    // most of their month is gone when they have barely spent anything.
    const busy = plan({ held_nanousd: 60 * GIGA, remaining_nanousd: 20 * GIGA });
    expect(remainingFraction(busy)).toBeCloseTo(0.8);
  });

  it('clamps rather than reporting a negative or over-full month', () => {
    expect(remainingFraction({ limit_nanousd: 100, spent_nanousd: 140 })).toBe(0);
    expect(remainingFraction({ limit_nanousd: 100, spent_nanousd: -5 })).toBe(1);
  });

  it('reports nothing remaining when there is no limit to divide by', () => {
    expect(remainingFraction({ limit_nanousd: 0, spent_nanousd: 0 })).toBe(0);
  });

  it('renders an empty bar rather than a NaN width for a malformed figure', () => {
    expect(remainingFraction({ limit_nanousd: Number.NaN, spent_nanousd: 10 })).toBe(0);
    expect(remainingFraction({ limit_nanousd: 100, spent_nanousd: Number.NaN })).toBe(0);
    expect(remainingFraction({ limit_nanousd: Number.POSITIVE_INFINITY, spent_nanousd: 0 })).toBe(0);
  });
});

describe('percentLabel', () => {
  it('never rounds a real value to a false absolute', () => {
    // The server sends the fraction unrounded precisely so these stay distinguishable.
    expect(percentLabel(0.0001)).toBe('<1%');
    expect(percentLabel(0.9999)).toBe('>99%');
    expect(percentLabel(0)).toBe('0%');
    expect(percentLabel(1)).toBe('100%');
  });

  it('rounds the ordinary middle', () => {
    expect(percentLabel(0.804)).toBe('80%');
    expect(percentLabel(0.5)).toBe('50%');
  });
});

describe('percentValue', () => {
  it('never contradicts the label beside it', () => {
    // A bar announcing 100 next to a label reading ">99%" reports an untouched month that is
    // not untouched — the assistive-technology reading and the visible one must agree.
    for (const fraction of [0, 0.0001, 0.004, 0.5, 0.995, 0.9999, 1]) {
      const label = percentLabel(fraction);
      const value = percentValue(fraction);
      if (label === '0%') expect(value).toBe(0);
      else if (label === '100%') expect(value).toBe(100);
      else expect(value).toBeGreaterThanOrEqual(1);
      if (label !== '100%') expect(value).toBeLessThan(100);
      if (label !== '0%') expect(value).toBeGreaterThan(0);
    }
  });
});

describe('resetLabel', () => {
  it('names the UTC boundary day, not the local one', () => {
    // `period_ends` is the UTC start of the next month. Formatting it locally shows the day
    // before for every reader west of Greenwich — a date on which nothing resets.
    const label = resetLabel('2026-10-01T00:00:00Z');
    expect(label).toMatch(/October|Oct/);
    expect(label).not.toMatch(/September|Sep/);
    expect(label).not.toMatch(/2026-10-01|T00:00/);
    expect(label).not.toMatch(/day/i);
  });

  it('says nothing rather than "Invalid Date" for a value it cannot read', () => {
    expect(resetLabel('not-a-date')).toBe('');
  });
});

describe('PlanUsage', () => {
  it('shows what remains, the reset date, and the plan promise verbatim', async () => {
    render(<PlanUsage onClose={vi.fn()} />);

    expect(await screen.findByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/of this month's allowance remaining/)).toBeInTheDocument();
    expect(screen.getByText(/Resets/)).toBeInTheDocument();
    expect(screen.getByText('20 papers a month, with narration to match')).toBeInTheDocument();
  });

  it('keeps held work off the bar and out of its accessible name', async () => {
    api.getPlan.mockResolvedValue(plan({ held_nanousd: 60 * GIGA, remaining_nanousd: 20 * GIGA }));
    render(<PlanUsage onClose={vi.fn()} />);

    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '80');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar.getAttribute('aria-label')).toBe("80% of this month's allowance remaining.");
  });

  it('gives live work its own card, with no percentage on it', async () => {
    api.getPlan.mockResolvedValue(plan({ held_nanousd: 5 * GIGA }));
    render(<PlanUsage onClose={vi.fn()} />);

    const card = await screen.findByLabelText(/Some allowance is temporarily set aside/);
    expect(card).toHaveTextContent('In progress now');
    expect(card.textContent).not.toMatch(/%/);
  });

  it('says nothing about live work when none is running', async () => {
    render(<PlanUsage onClose={vi.fn()} />);
    await screen.findByText('80%');
    expect(screen.queryByText('In progress now')).not.toBeInTheDocument();
  });

  it('warns from spend alone, so a narration in flight cannot cry wolf', async () => {
    // `warn` is true here because it counts holds — that is what lets it precede a refusal. The
    // month is three quarters intact, so this screen must stay quiet.
    api.getPlan.mockResolvedValue(plan({
      spent_fraction: 0.76, spent_nanousd: 76 * GIGA, held_nanousd: 5 * GIGA,
      warn: true, at_capacity: true,
    }));
    render(<PlanUsage onClose={vi.fn()} />);

    await screen.findByText('24%');
    expect(screen.queryByText('A little room remains')).not.toBeInTheDocument();
  });

  it('shows the approaching card once spend itself passes the soft line', async () => {
    api.getPlan.mockResolvedValue(plan({ spent_fraction: 0.85, spent_nanousd: 85 * GIGA }));
    render(<PlanUsage onClose={vi.fn()} />);

    expect(await screen.findByText('A little room remains')).toBeInTheDocument();
  });

  it('stops calling it "approaching" once the allowance is actually spent', async () => {
    api.getPlan.mockResolvedValue(plan({ spent_fraction: 1, spent_nanousd: 100 * GIGA }));
    render(<PlanUsage onClose={vi.fn()} />);

    await screen.findByText('0%');
    expect(screen.queryByText('A little room remains')).not.toBeInTheDocument();
  });

  it('does not show a confident balance when the usage read itself failed', async () => {
    // The ceiling can be live while this particular read is down. A full bar here once sat
    // beside every job failing closed — the most misleading pair the endpoint can produce.
    api.getPlan.mockResolvedValue(plan({ usage_available: false }));
    render(<PlanUsage onClose={vi.fn()} />);

    expect(await screen.findByRole('status')).toHaveTextContent('could not be read');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // The plan itself is still known, so it is still shown.
    expect(screen.getByText('20 papers a month, with narration to match')).toBeInTheDocument();
  });

  it('leaves rather than showing a zero when nothing is enforced', async () => {
    api.getPlan.mockResolvedValue(plan({ enforced: false }));
    const onClose = vi.fn();
    render(<PlanUsage onClose={onClose} />);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/allowance remaining/)).not.toBeInTheDocument();
  });

  it('offers a retry when the request fails outright', async () => {
    api.getPlan.mockRejectedValue(new Error('Network error'));
    render(<PlanUsage onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
