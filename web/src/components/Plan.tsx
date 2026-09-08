// The plan & usage surface. Every rule here comes from `docs/plan-usage-surface-spec.md`, and
// several of them are corrections to earlier attempts rather than preferences — the comments say
// which, because the wrong version of each looks perfectly reasonable.

import { useCallback, useEffect, useState } from 'react';
import { getPlan, type Plan } from '@/api/endpoints';
import './Plan.css';

/** What the bar shows: the share of the allowance left after DURABLE spend.
 *
 *  Deliberately not the transport's `remaining_nanousd`, which subtracts holds too — a reader
 *  with several jobs running would be told most of their month is gone when they have barely
 *  spent anything. Holds get their own card with no number on it. */
export function remainingFraction(plan: Pick<Plan, 'limit_nanousd' | 'spent_nanousd'>): number {
  // Finite guards match `mobile/src/app/plan.tsx`: a malformed number must render an empty bar,
  // not a NaN width that collapses the element and reports nothing at all.
  if (!Number.isFinite(plan.limit_nanousd) || plan.limit_nanousd <= 0) return 0;
  if (!Number.isFinite(plan.spent_nanousd)) return 0;
  return Math.max(0, Math.min(1, (plan.limit_nanousd - plan.spent_nanousd) / plan.limit_nanousd));
}

/** A percentage that never rounds a real value to a false absolute. The server sends its
 *  fractions unrounded precisely so that any value strictly between empty and full renders as
 *  neither: a month with a hair of allowance spent reads ">99%" remaining, not "100%", and one
 *  with a hair left reads "<1%", not "0%". Those two states are the ones a reader acts on. */
export function percentLabel(fraction: number): string {
  if (fraction <= 0) return '0%';
  if (fraction >= 1) return '100%';
  const percent = fraction * 100;
  if (percent < 1) return '<1%';
  if (percent > 99) return '>99%';
  return `${Math.round(percent)}%`;
}

/** The same value for `aria-valuenow`, which must not contradict the label beside it: a bar
 *  announcing 100 while its label says ">99%" reports the month as untouched when it is not. */
export function percentValue(fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 100;
  return Math.min(99, Math.max(1, Math.round(fraction * 100)));
}

/** `Resets 1 October`. Never a raw ISO string, and never "days left", which drifts across
 *  midnight and is wrong for whoever reads it in another timezone.
 *
 *  Formatted in UTC on purpose, matching `mobile/src/app/plan.tsx`, which paid for this already:
 *  `period_ends` is `quotas.calendar_month`'s exclusive end — the UTC start of the next month —
 *  so the reset day IS that UTC calendar date. Rendering it in local time moves it a day earlier
 *  for every reader west of Greenwich, naming a date on which nothing resets to the one person
 *  waiting for it. The locale still chooses the order and the language of the month name. */
export function resetLabel(periodEnds: string): string {
  const at = new Date(periodEnds);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

interface Props { onClose: () => void; }

export function PlanUsage({ onClose }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPlan()
      .then((response) => { if (!cancelled) setPlan(response); })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Enforcement went away while the screen was open (sign-out, or a config change). Leave rather
  // than showing a zero: with no ceiling there is no allowance to report, and an empty bar is a
  // statement about the account that is not true.
  useEffect(() => {
    if (plan && !plan.enforced) onClose();
  }, [plan, onClose]);

  return (
    <div className="plan-overlay" role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="plan-sheet" role="dialog" aria-modal="true" aria-label="Plan and usage">
        <div className="plan-head">
          <h2>Plan &amp; usage</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {loading ? <div className="lc-loading"><span className="spinner" /> Loading…</div>
          : error ? <div>
            <p className="build-progress-error" role="alert">{error}</p>
            <button className="btn primary" onClick={refresh}>Retry</button>
          </div>
          : plan && plan.enforced ? <PlanBody plan={plan} /> : null}
      </section>
    </div>
  );
}

function PlanBody({ plan }: { plan: Plan }) {
  // The ceiling is live but this read failed. Reporting a full balance here was once the most
  // misleading pair this endpoint could produce — every job failing closed beside a bar saying
  // the month was untouched. Say what is actually known instead.
  if (!plan.usage_available) {
    return <>
      <PlanCard plan={plan} />
      <p className="muted plan-unavailable" role="status">
        This month's usage could not be read just now. Your allowance is unchanged; the figure will
        be back shortly.
      </p>
    </>;
  }

  const remaining = remainingFraction(plan);
  // The approaching card keys off SPEND ALONE, not the server's `warn`. `warn` includes holds so
  // that it can precede a refusal, which makes it true at 76% spent with one narration in flight —
  // while the month is three quarters intact. Rendering it here would cry wolf every listening
  // session. `warn`/`at_capacity` are not shown on this surface at all.
  const approaching = plan.spent_fraction >= plan.warn_at_fraction && plan.spent_fraction < 1;

  return <>
    <div className="plan-bar-row">
      <strong className="plan-percent">{percentLabel(remaining)}</strong>
      <span className="muted">of this month's allowance remaining</span>
    </div>
    <div
      className="plan-bar"
      role="progressbar"
      aria-valuenow={percentValue(remaining)}
      aria-valuemin={0}
      aria-valuemax={100}
      // Held work is deliberately absent from this label as well as from the bar.
      aria-label={`${percentLabel(remaining)} of this month's allowance remaining.`}
    >
      <div className="plan-bar-fill" style={{ width: `${remaining * 100}%` }} />
    </div>
    {plan.period_ends && <p className="muted plan-reset">Resets {resetLabel(plan.period_ends)}</p>}

    {approaching && (
      <section className="plan-note plan-note-approaching">
        <h3>A little room remains</h3>
        <p className="muted">
          Nothing changes until the allowance reaches zero. Seminar keeps working in the meantime.
        </p>
      </section>
    )}

    {/* Live work gets its own card and NO percentage: it must never share an axis with spend, or
        appear as a second segment of the bar. A hold clears in seconds when its job settles;
        spend does not come back until the period rolls over. */}
    {plan.held_nanousd > 0 && (
      <section className="plan-note plan-note-held"
        aria-label="Work in progress. Some allowance is temporarily set aside and returns when the work finishes.">
        <h3>In progress now</h3>
        <p className="muted">
          A little room is temporarily set aside. It returns as the work finishes.
        </p>
      </section>
    )}

    <PlanCard plan={plan} />
  </>;
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <section className="plan-card">
      {/* Title case for the label; the summary is the server's own sentence, verbatim, because an
          operator override withdraws the plan's quantitative promise server-side and a client
          that re-derived it would state a number the deployment does not honour. */}
      <div className="plan-card-name">{titleCasePlan(plan.plan.name)}</div>
      <p className="muted">{plan.plan.summary}</p>
    </section>
  );
}

function titleCasePlan(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Plan';
}
