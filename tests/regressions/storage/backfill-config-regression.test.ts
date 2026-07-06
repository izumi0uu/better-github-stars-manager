import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createBackfillConfigStore,
  getBackfillTask,
} from '../../../src/background/backfill-config';
import { backfillTasks } from '../../../src/upgrades/tasks';
import type { BackfillMap, Config } from '../../../src/types';

function makeConfig(backfills: BackfillMap): Config {
  return { backfills } as Config;
}

describe('Backfill config regressions', () => {
  it('rejects unknown ids before reading or mutating persisted config', async () => {
    let getConfigCalls = 0;
    let updateCalls = 0;
    const store = createBackfillConfigStore({
      async getConfig() {
        getConfigCalls++;
        return makeConfig({});
      },
      async update() {
        updateCalls++;
      },
    });

    await assert.rejects(
      () => store.setBackfillState('unknown_backfill', () => {
        throw new Error('mutator should not run');
      }),
      /Unknown backfill: unknown_backfill/,
    );
    assert.equal(getConfigCalls, 0);
    assert.equal(updateCalls, 0);
  });

  it('exposes task metadata only for valid backfill ids', () => {
    const task = getBackfillTask('repo_data_sync_v1');

    assert.equal(task?.id, 'repo_data_sync_v1');
    assert.equal(task?.kind, 'full_sync');
    assert.equal(getBackfillTask('missing'), null);
  });

  it('normalizes malformed stored backfill states before mutation', async () => {
    let current = makeConfig({
      repo_data_sync_v1: {
        status: 'bogus',
        queuedAt: '2026-06-22T00:00:00Z',
      } as never,
    });
    const store = createBackfillConfigStore({
      async getConfig() {
        return current;
      },
      async update(patch: Partial<Config>) {
        current = { ...current, ...patch };
      },
    });

    const next = await store.setBackfillState('repo_data_sync_v1', (state, now) => {
      assert.equal(state?.status, 'pending');
      assert.equal(state?.queuedAt, '2026-06-22T00:00:00Z');
      assert.equal(state?.lastAttemptAt, null);
      return {
        status: 'failed',
        queuedAt: state?.queuedAt ?? now,
        lastAttemptAt: now,
        completedAt: null,
        error: 'manual retry failed after malformed storage',
      };
    });

    assert.equal(next.status, 'failed');
    assert.equal(current.backfills.repo_data_sync_v1?.error, 'manual retry failed after malformed storage');
  });

  it('serializes queued mutations against a fresh config snapshot', async () => {
    let current = makeConfig({});
    const written: BackfillMap[] = [];
    const store = createBackfillConfigStore({
      async getConfig() {
        return current;
      },
      async update(patch: Partial<Config>) {
        current = { ...current, ...patch };
        written.push(current.backfills);
      },
    });

    const first = store.setBackfillState('repo_data_sync_v1', (_state, now) => ({
      status: 'running',
      queuedAt: now,
      lastAttemptAt: now,
      completedAt: null,
      error: null,
    }));
    const second = store.setBackfillState('repo_data_sync_v1', (state, now) => {
      assert.equal(state?.status, 'running');
      return {
        status: 'failed',
        queuedAt: state?.queuedAt ?? now,
        lastAttemptAt: now,
        completedAt: null,
        error: 'boom',
      };
    });

    await Promise.all([first, second]);
    assert.equal(written.length, 2);
    assert.equal(current.backfills.repo_data_sync_v1?.status, 'failed');
    assert.equal(current.backfills.repo_data_sync_v1?.queuedAt, written[0].repo_data_sync_v1?.queuedAt);
  });

  it('does not write when reconciliation produces a normalized-equal backfill map', async () => {
    const currentState = {
      status: 'done' as const,
      queuedAt: '2026-06-22T00:00:00Z',
      lastAttemptAt: '2026-06-22T00:01:00Z',
      completedAt: '2026-06-22T00:05:00Z',
      error: null,
    };
    const store = createBackfillConfigStore({
      async getConfig() {
        return makeConfig({ repo_data_sync_v1: currentState });
      },
      async update() {
        throw new Error('normalized-equal reconciliation should not write');
      },
    });

    const next = await store.reconcileStoredBackfills();

    assert.deepEqual(next, { repo_data_sync_v1: currentState });
  });

  it('continues queued backfill config mutations after a rejected update', async () => {
    let current = makeConfig({});
    const writeAttempts: Array<'reject' | 'resolve'> = [];
    const store = createBackfillConfigStore({
      async getConfig() {
        return current;
      },
      async update(patch: Partial<Config>) {
        if (writeAttempts.length === 0) {
          writeAttempts.push('reject');
          throw new Error('storage write rejected');
        }
        writeAttempts.push('resolve');
        current = { ...current, ...patch };
      },
    });

    const rejected = store.setBackfillState('repo_data_sync_v1', (_state, now) => ({
      status: 'running',
      queuedAt: now,
      lastAttemptAt: now,
      completedAt: null,
      error: null,
    }));
    const recovered = store.setBackfillState('repo_data_sync_v1', (_state, now) => ({
      status: 'deferred',
      queuedAt: '2026-06-22T00:00:00Z',
      lastAttemptAt: now,
      completedAt: null,
      error: 'preserved failure reason',
    }));

    await assert.rejects(() => rejected, /storage write rejected/);
    const finalState = await recovered;

    assert.deepEqual(writeAttempts, ['reject', 'resolve']);
    assert.equal(finalState.status, 'deferred');
    assert.equal(finalState.error, 'preserved failure reason');
    assert.equal(current.backfills.repo_data_sync_v1?.status, 'deferred');
  });

  it('serializes a rejected reconciliation before the next queued mutation', async () => {
    const originalDetectNeed = backfillTasks.repo_data_sync_v1.detectNeed;
    let current = makeConfig({});
    const events: string[] = [];
    backfillTasks.repo_data_sync_v1.detectNeed = async () => {
      events.push('detect rejected');
      throw new Error('detect failed');
    };
    const store = createBackfillConfigStore({
      async getConfig() {
        events.push('get');
        return current;
      },
      async update(patch: Partial<Config>) {
        events.push('update');
        current = { ...current, ...patch };
      },
    });

    try {
      const rejected = store.reconcileStoredBackfills();
      const recovered = store.setBackfillState('repo_data_sync_v1', (_state, now) => ({
        status: 'failed',
        queuedAt: now,
        lastAttemptAt: now,
        completedAt: null,
        error: 'manual retry failed',
      }));

      await assert.rejects(() => rejected, /detect failed/);
      const finalState = await recovered;

      assert.deepEqual(events, ['get', 'detect rejected', 'get', 'update']);
      assert.equal(finalState.status, 'failed');
      assert.equal(current.backfills.repo_data_sync_v1?.error, 'manual retry failed');
    } finally {
      backfillTasks.repo_data_sync_v1.detectNeed = originalDetectNeed;
    }
  });
});
