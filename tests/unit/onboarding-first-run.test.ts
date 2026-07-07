import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  isOnboardingCardStage,
  normalizeOnboardingStage,
  resolveOnboardingStageAfterSync,
  shouldTrackOnboardingSync,
} from '@/onboarding/state';
import { mergeStatusPatch, mergeStatusSnapshot, type SyncStatus } from '@/utils/messaging';
import type { OnboardingStage } from '@/types';

function status(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    progress: { phase: 'idle', done: 0, total: null, message: '' },
    hasToken: false,
    onboardingStage: 'needs_token',
    seenOnboarding: false,
    seenTooltips: 0,
    backfills: {},
    activeBackfillId: null,
    inFlight: false,
    ...patch,
  };
}

describe('onboarding first-run invariants', () => {
  it('normalizes terminal seen/done before token branching', () => {
    assert.equal(normalizeOnboardingStage('syncing', true, true), 'done');
    assert.equal(normalizeOnboardingStage('done', false, false), 'done');
    assert.equal(normalizeOnboardingStage('done', false, true), 'done');
  });

  it('normalizes token-aware first-run stages without completing onboarding', () => {
    assert.equal(normalizeOnboardingStage(null, false, false), 'needs_token');
    assert.equal(normalizeOnboardingStage(undefined, false, true), 'awaiting_sync');
    assert.equal(normalizeOnboardingStage('syncing', false, true), 'syncing');
    assert.equal(normalizeOnboardingStage('sync_failed', false, true), 'sync_failed');
    assert.equal(normalizeOnboardingStage('coach', false, true), 'coach');
    assert.equal(normalizeOnboardingStage('empty_library', false, true), 'empty_library');
  });

  it('resolves post-sync first-run branch from token and library size', () => {
    assert.equal(resolveOnboardingStageAfterSync(false, 99), 'needs_token');
    assert.equal(resolveOnboardingStageAfterSync(true, 0), 'empty_library');
    assert.equal(resolveOnboardingStageAfterSync(true, 1), 'coach');
  });

  it('keeps exactly the card stages and tracks sync until done', () => {
    const cardStages: OnboardingStage[] = ['needs_token', 'awaiting_sync', 'syncing', 'sync_failed'];
    const nonCardStages: OnboardingStage[] = ['empty_library', 'coach', 'done'];
    for (const stage of cardStages) assert.equal(isOnboardingCardStage(stage), true, stage);
    for (const stage of nonCardStages) assert.equal(isOnboardingCardStage(stage), false, stage);
    assert.equal(shouldTrackOnboardingSync('done'), false);
    assert.equal(shouldTrackOnboardingSync('syncing'), true);
    assert.equal(shouldTrackOnboardingSync('coach'), true);
  });

  it('preserves live syncing progress when a restored idle snapshot arrives', () => {
    const current = status({
      progress: { phase: 'full', done: 3, total: 10, message: 'Syncing' },
      hasToken: true,
      onboardingStage: 'syncing',
      inFlight: true,
    });
    const snapshot = status({
      progress: { phase: 'idle', done: 0, total: null, message: '' },
      hasToken: true,
      onboardingStage: 'syncing',
      inFlight: false,
    });

    const merged = mergeStatusSnapshot(current, snapshot);
    assert.deepEqual(merged?.progress, current.progress);
    assert.equal(merged?.onboardingStage, 'syncing');
    assert.equal(merged?.inFlight, true);
  });

  it('turns onboarding stage patches into normalized terminal/runtime status', () => {
    const syncing = status({
      progress: { phase: 'full', done: 2, total: 10, message: 'Syncing' },
      hasToken: true,
      onboardingStage: 'syncing',
      inFlight: true,
    });

    const failed = mergeStatusPatch(syncing, { onboardingStage: 'sync_failed', inFlight: false });
    assert.equal(failed.onboardingStage, 'sync_failed');
    assert.equal(failed.seenOnboarding, false);
    assert.equal(failed.inFlight, false);
    assert.deepEqual(failed.progress, syncing.progress);

    const done = mergeStatusPatch(failed, { onboardingStage: 'done' });
    assert.equal(done.onboardingStage, 'done');
    assert.equal(done.seenOnboarding, true);
  });
});
