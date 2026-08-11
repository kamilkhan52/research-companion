// DR-047 — the staged-progress helpers for Get profile and the labs pass. Pure functions, so
// what renders is pinned without mounting the screen: the stage mapping must never show a step
// as done before the server has published the later stage, and the labs fraction must stay in
// [0, 1] whatever the snapshot carries.

import { labsFraction, profileSteps } from '@/app/authors';

describe('profileSteps', () => {
  it('shows the first stage active while context is being gathered', () => {
    expect(profileSteps('context').map((s) => s.state)).toEqual(['active', 'pending']);
  });

  it('completes the first stage only once the server publishes writing', () => {
    expect(profileSteps('writing').map((s) => s.state)).toEqual(['done', 'active']);
  });

  it('treats a missing stage as the first stage under way, never as done', () => {
    // A snapshot taken before the worker's first write, or a server predating the field.
    expect(profileSteps('').map((s) => s.state)).toEqual(['active', 'pending']);
  });

  it('keeps stable keys and labels for both steps', () => {
    expect(profileSteps('context').map((s) => s.key)).toEqual(['context', 'writing']);
    for (const step of profileSteps('writing')) {
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});

describe('labsFraction', () => {
  it('is the completed fraction of the pass', () => {
    expect(labsFraction(3, 10)).toBeCloseTo(0.3);
    expect(labsFraction(10, 10)).toBe(1);
  });

  it('is 0 before totals exist, rather than NaN or Infinity', () => {
    expect(labsFraction(0, 0)).toBe(0);
    expect(labsFraction(5, 0)).toBe(0);
    expect(labsFraction(Number.NaN, 10)).toBe(0);
  });

  it('clamps a snapshot that momentarily disagrees with itself', () => {
    expect(labsFraction(11, 10)).toBe(1);
    expect(labsFraction(-1, 10)).toBe(0);
  });
});
