import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createBackfillConfigStore,
  getBackfillTask,
} from '../../../src/background/backfill-config';
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
});
