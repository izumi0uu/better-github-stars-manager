import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createChromeMock } from '../helpers/chrome-mock';
import { installGitHubCredential } from '../helpers/github-credential';
import { authStore } from '../../src/auth/auth-store';
import { getMessages } from '../../src/i18n';
import { db } from '../../src/storage/db';
import { createStarsSyncUsecase } from '../../src/background/stars-sync-usecase';
import { createGistSyncUsecase } from '../../src/background/gist-sync-usecase';
import { createSerializedRunner } from '../../src/background/serialized-runner';
import { createBackfillExecutor } from '../../src/background/backfill-executor';
import type { StarSource } from '../../src/api/star-source';
import type { SyncProgress } from '../../src/types';

Object.defineProperty(globalThis, 'chrome', { value: createChromeMock().api, configurable: true });
beforeEach(async () => {
  await db.delete();
  await db.open();
  await chrome.storage.local.clear();
  await installGitHubCredential();
  await authStore.update({ onboardingStage: 'syncing', seenOnboarding: false });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.close());

function fixture(reconcileWatchScope: () => Promise<void> = async () => {}) {
  const queue = createSerializedRunner();
  const progress: SyncProgress[] = [];
  const source: StarSource = {
    syncFull: vi.fn(async () => ({ added: 2, updated: 2 })),
    syncIncremental: vi.fn(async () => ({ added: 1 })),
    syncRescan: vi.fn(async () => ({ tombstoned: 1, revived: 0 })),
    syncOwnedPublicRepositories: vi.fn(async () => ({ added: 1, updated: 0 })),
    star: vi.fn(), unstar: vi.fn(), getUsername: vi.fn(),
  };
  const stars = createStarsSyncUsecase({ queue, source, setProgress: (p) => progress.push(p), reconcileWatchScope });
  return { queue, progress, source, stars };
}

describe('Stars and Gist lifecycle ownership', () => {
  it('keeps start and failure terminal inside the queue before the next job starts', async () => {
    const { queue, source, stars, progress } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prior = queue.run(() => gate);
    vi.mocked(source.syncFull).mockRejectedValue(new Error('sync failed'));
    const failed = stars.syncFull(false);
    const rejected = assert.rejects(failed, { message: 'sync failed' });
    const next = queue.run(async () => {
      assert.equal(progress.at(-1)?.phase, 'idle');
      assert.equal((await authStore.getConfig()).onboardingStage, 'sync_failed');
    });
    await Promise.resolve();
    assert.equal(progress.length, 0);
    release();
    await Promise.all([prior, rejected, next]);
    assert.equal(progress[0].phase, 'full');
  });

  it('passes one captured identity and excludes owned rows only when requested', async () => {
    const { source, stars, progress } = fixture();
    await stars.syncFull(false);
    const options = vi.mocked(source.syncFull).mock.calls[0][1];
    assert.equal(options?.includeOwnedPublic, false);
    assert.equal(options?.credential?.accountLogin, 'octocat');
    assert.equal(options?.credential?.mainToken, 'github_pat_synthetic');
    assert.equal(progress.at(-1)?.phase, 'idle');
    assert.equal((await authStore.getConfig()).onboardingStage, 'empty_library');
    await stars.syncIncremental();
    assert.equal(vi.mocked(source.syncIncremental).mock.calls[0][0]?.credential?.mainIdentity, options?.credential?.mainIdentity);
  });

  it('runs a backfill in its existing queue slot without auto-tagging or nested queue entry', async () => {
    const { queue, stars, source } = fixture();
    const run = vi.spyOn(queue, 'run');
    const executor = createBackfillExecutor({ jobQueue: queue, performFullSyncJob: stars.performFullSyncJob,
      setBackfillState: async (_id, mutate) => mutate(undefined, '2026-09-05T00:00:00Z') });
    const result = await executor.runBackfill({ id: 'repo_data_sync' }, String);
    assert.deepEqual(result.data, { id: 'repo_data_sync', added: 2, updated: 2, tagged: 0 });
    assert.equal(run.mock.calls.length, 1);
    assert.equal(vi.mocked(source.syncFull).mock.calls.length, 1);
  });

  it('does not rewrite tracked onboarding during rescan', async () => {
    const { stars } = fixture();
    assert.deepEqual(await stars.syncRescan(), { tombstoned: 1, revived: 0 });
    assert.equal((await authStore.getConfig()).onboardingStage, 'syncing');
  });

  it('ends failed sync progress while retaining the missing-token onboarding state', async () => {
    await authStore.clearToken();
    await authStore.update({ onboardingStage: 'syncing' });
    const { stars, progress } = fixture();
    await assert.rejects(stars.syncIncremental(), { message: 'GH_NO_TOKEN' });
    assert.equal(progress.at(-1)?.phase, 'idle');
    assert.equal((await authStore.getConfig()).onboardingStage, 'needs_token');
  });

  it('never applies an old sync completion or failure to replacement-account onboarding', async () => {
    const { stars, source } = fixture();
    vi.mocked(source.syncFull).mockImplementation(async () => {
      await installGitHubCredential('github_pat_replacement', 'other-account');
      await authStore.update({ onboardingStage: 'awaiting_sync' });
      return { added: 0, updated: 0 };
    });
    await assert.rejects(stars.syncFull(), { message: 'GITHUB_CREDENTIAL_CHANGED' });
    assert.equal((await authStore.getConfig()).onboardingStage, 'awaiting_sync');
  });

  it.each([
    ['syncFull', 'full'],
    ['syncIncremental', 'incremental'],
    ['syncRescan', 'rescan'],
  ] as const)('rejects %s completion when Watch reconciliation replaces the account', async (method, phase) => {
    const messages = getMessages(await authStore.getLocale());
    const { stars, progress } = fixture(async () => {
      await installGitHubCredential('github_pat_replacement', 'other-account');
      await authStore.update({ onboardingStage: 'awaiting_sync', seenOnboarding: false });
    });

    await assert.rejects(stars[method](), { name: 'Error', message: 'GITHUB_CREDENTIAL_CHANGED' });

    assert.equal(progress[0].phase, phase);
    assert.deepEqual(progress.filter((entry) => entry.phase === 'idle'), [{
      phase: 'idle',
      done: 0,
      total: null,
      message: messages.errors.unknown('GITHUB_CREDENTIAL_CHANGED'),
    }]);
    const config = await authStore.getConfig();
    assert.equal(config.username, 'other-account');
    assert.equal(config.onboardingStage, 'awaiting_sync');
    assert.equal(config.seenOnboarding, false);
  });

  it('Gist failure settles progress before queued work begins and preserves success result shape', async () => {
    const queue = createSerializedRunner();
    const progress: SyncProgress[] = [];
    const gist = createGistSyncUsecase({ queue, setProgress: (p) => progress.push(p), tags: {
      syncPush: async () => { throw new Error('Gist failed'); },
      syncPull: async () => ({ merged: 1, total: 2, missing: false }),
    } });
    const failed = assert.rejects(gist.push(), { message: 'Gist failed' });
    const next = queue.run(async () => assert.equal(progress.at(-1)?.phase, 'idle'));
    await Promise.all([failed, next]);
    assert.deepEqual(await gist.pull(), { merged: 1, total: 2, missing: false });
    assert.deepEqual(progress.map((p) => p.phase), ['gist', 'idle', 'gist', 'idle']);
  });
});
