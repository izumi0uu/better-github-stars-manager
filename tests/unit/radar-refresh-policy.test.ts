import { describe, expect, it } from 'vitest';
import { selectRadarRefreshPlan } from '@/background/radar-refresh-policy';
import type { RadarStateRecord } from '@/radar/radar-model';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');
const CREDENTIAL = 'viewer:identity-a:true';

function stableState(overrides: Partial<RadarStateRecord> = {}): RadarStateRecord {
  return {
    id: 'singleton',
    accountLogin: 'viewer',
    lastAttemptAt: new Date(NOW - 1_000).toISOString(),
    lastSuccessfulAt: new Date(NOW - 1_000).toISOString(),
    windowDays: 60,
    lastRefreshMode: 'full',
    lastIncrementalAt: null,
    lastFullReconciledAt: new Date(NOW - 2 * 24 * 60 * 60 * 1_000).toISOString(),
    credentialIdentity: CREDENTIAL,
    errorCode: null,
    nextAllowedAt: null,
    activityCount: 2,
    followingCount: 2,
    scannedFollowingCount: 2,
    batchCount: 1,
    partialReasons: [],
    rateLimitRemaining: 4_000,
    rateLimitResetAt: null,
    ...overrides,
  };
}

function plan(overrides: Partial<Parameters<typeof selectRadarRefreshPlan>[0]> = {}) {
  return selectRadarRefreshPlan({
    nowMillis: NOW,
    selectedWindowDays: 60,
    credentialIdentity: CREDENTIAL,
    state: stableState(),
    ...overrides,
  });
}

describe('Radar refresh policy', () => {
  it.each([
    ['no state', null],
    ['no full reconciliation timestamp', stableState({ lastFullReconciledAt: null })],
  ])('routes %s to a selected-window full reconciliation', (_label, state) => {
    expect(plan({ state })).toMatchObject({ mode: 'full', lookbackDays: 60 });
  });

  it('routes a failed previous attempt to full', () => {
    expect(plan({ state: stableState({ errorCode: 'network_error' }) }))
      .toMatchObject({ mode: 'full', lookbackDays: 60, reason: 'last_attempt_failed' });
  });

  it('keeps a partial baseline on the incremental path', () => {
    expect(plan({ state: stableState({ partialReasons: ['github_star_list_truncated'] }) }))
      .toMatchObject({ mode: 'incremental', lookbackDays: 7, reason: 'stable_baseline' });
  });

  it('routes a selected-window expansion to full', () => {
    expect(plan({ selectedWindowDays: 90 })).toMatchObject({ mode: 'full', lookbackDays: 90 });
  });
  it('routes a selected-window contraction to full', () => {
    expect(plan({ selectedWindowDays: 30 })).toMatchObject({ mode: 'full', lookbackDays: 30 });
  });

  it('routes a credential identity change to full', () => {
    expect(plan({ credentialIdentity: 'viewer:identity-b:true' }))
      .toMatchObject({ mode: 'full', lookbackDays: 60 });
  });

  it.each([7, 8])('routes a full reconciliation at %s days to full', (ageDays) => {
    expect(plan({
      state: stableState({
        lastFullReconciledAt: new Date(NOW - ageDays * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    })).toMatchObject({ mode: 'full', lookbackDays: 60 });
  });

  it('routes a recent stable baseline to a fixed seven-day incremental refresh', () => {
    expect(plan()).toMatchObject({ mode: 'incremental', lookbackDays: 7 });
  });

  it('lets an explicit full command override a stable incremental plan', () => {
    expect(plan({ forceFull: true })).toMatchObject({ mode: 'full', lookbackDays: 60 });
  });
  it('treats an invalid full provenance timestamp as no baseline', () => {
    expect(plan({ state: stableState({ lastFullReconciledAt: 'not-a-timestamp' }) }))
      .toMatchObject({ mode: 'full', lookbackDays: 60, reason: 'no_baseline' });
  });

  it('uses full reconciliation age instead of the latest incremental success age', () => {
    expect(plan({
      state: stableState({
        lastSuccessfulAt: new Date(NOW - 14 * 24 * 60 * 60 * 1_000).toISOString(),
        lastIncrementalAt: new Date(NOW - 14 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    })).toMatchObject({ mode: 'incremental', lookbackDays: 7, reason: 'stable_baseline' });
  });
});
