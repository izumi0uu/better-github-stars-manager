import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createBackfillExecutor } from '../../../src/background/backfill-executor';
import { createSerializedRunner } from '../../../src/background/serialized-runner';
import type { BackfillState } from '../../../src/types';

describe('Background queue regressions', () => {
  it('serializes three fan-in jobs one at a time after the first resolves', async () => {
    const runner = createSerializedRunner();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runner.run(async () => {
      events.push('A:start');
      await firstDone;
      events.push('A:end');
      return 'A';
    });

    const second = runner.run(async () => {
      events.push('B:start');
      await Promise.resolve();
      events.push('B:end');
      return 'B';
    });

    const third = runner.run(async () => {
      events.push('C:start');
      await Promise.resolve();
      events.push('C:end');
      return 'C';
    });

    await Promise.resolve();
    assert.deepEqual(events, ['A:start']);
    assert.equal(runner.isRunning(), true);

    releaseFirst?.();
    assert.deepEqual(await Promise.all([first, second, third]), ['A', 'B', 'C']);
    assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end']);
    assert.equal(runner.isRunning(), false);
  });

  it('continues the queue after a rejected job', async () => {
    const runner = createSerializedRunner();
    const events: string[] = [];

    const first = runner.run(async () => {
      events.push('A:start');
      throw new Error('boom');
    });
    const second = runner.run(async () => {
      events.push('B:start');
      return 'B';
    });

    await assert.rejects(first, /boom/);
    assert.equal(await second, 'B');
    assert.deepEqual(events, ['A:start', 'B:start']);
    assert.equal(runner.isRunning(), false);
  });

  it('starts the backfill state machine only when its queued job begins', async () => {
    const jobQueue = createSerializedRunner();
    const states: BackfillState['status'][] = [];
    let releaseFirst!: () => void;
    let releaseFullSync!: () => void;
    let fullSyncStarted!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fullSyncStartedPromise = new Promise<void>((resolve) => {
      fullSyncStarted = resolve;
    });
    const fullSyncDone = new Promise<void>((resolve) => {
      releaseFullSync = resolve;
    });
    const backfillExecutor = createBackfillExecutor({
      jobQueue,
      async setBackfillState(_id, mutate) {
        const next = mutate(undefined, `t${states.length + 1}`);
        states.push(next.status);
        return next;
      },
      async performFullSyncJob() {
        fullSyncStarted();
        await fullSyncDone;
        return { added: 1, updated: 1 };
      },
    });

    const first = jobQueue.run(async () => {
      await firstDone;
    });
    const backfill = backfillExecutor.runBackfill({ id: 'repo_data_sync_v1' }, String);

    await Promise.resolve();
    assert.deepEqual(states, []);

    releaseFirst();
    await fullSyncStartedPromise;
    assert.deepEqual(states, ['running']);

    releaseFullSync();
    assert.deepEqual(await backfill, {
      ok: true,
      data: { id: 'repo_data_sync_v1', added: 1, updated: 1, tagged: 0 },
    });
    await first;
    assert.deepEqual(states, ['running', 'done']);
  });

  it('joins duplicate backfill requests onto one queued promise', async () => {
    const jobQueue = createSerializedRunner();
    let fullSyncCalls = 0;
    let releaseFullSync!: () => void;
    const fullSyncDone = new Promise<void>((resolve) => {
      releaseFullSync = resolve;
    });
    const backfillExecutor = createBackfillExecutor({
      jobQueue,
      async setBackfillState(_id, mutate) {
        return mutate(undefined, 'now');
      },
      async performFullSyncJob() {
        fullSyncCalls++;
        await fullSyncDone;
        return { added: 2, updated: 2 };
      },
    });

    const first = backfillExecutor.runBackfill({ id: 'repo_data_sync_v1' }, String);
    const second = backfillExecutor.runBackfill({ id: 'repo_data_sync_v1' }, String);
    assert.equal(first, second);

    releaseFullSync();
    assert.deepEqual(await Promise.all([first, second]), [
      { ok: true, data: { id: 'repo_data_sync_v1', added: 2, updated: 2, tagged: 0 } },
      { ok: true, data: { id: 'repo_data_sync_v1', added: 2, updated: 2, tagged: 0 } },
    ]);
    assert.equal(fullSyncCalls, 1);
  });

  it('records failed backfills and leaves the serialized queue usable', async () => {
    const jobQueue = createSerializedRunner();
    const states: Array<{ status: BackfillState['status']; error: string | null }> = [];
    const backfillExecutor = createBackfillExecutor({
      jobQueue,
      async setBackfillState(_id, mutate) {
        const next = mutate(undefined, `t${states.length + 1}`);
        states.push({ status: next.status, error: next.error });
        return next;
      },
      async performFullSyncJob() {
        throw new Error('sync failed');
      },
    });

    await assert.rejects(
      () => backfillExecutor.runBackfill({ id: 'repo_data_sync_v1' }, () => 'translated failure'),
      /sync failed/,
    );
    assert.deepEqual(states, [
      { status: 'running', error: null },
      { status: 'failed', error: 'translated failure' },
    ]);
    assert.equal(await jobQueue.run(async () => 'after'), 'after');
  });

  it('allows the same backfill id to retry after a failed execution settles', async () => {
    const jobQueue = createSerializedRunner();
    const states: BackfillState['status'][] = [];
    let fullSyncCalls = 0;
    const backfillExecutor = createBackfillExecutor({
      jobQueue,
      async setBackfillState(_id, mutate) {
        const next = mutate(undefined, `t${states.length + 1}`);
        states.push(next.status);
        return next;
      },
      async performFullSyncJob() {
        fullSyncCalls++;
        if (fullSyncCalls === 1) throw new Error('first attempt failed');
        return { added: 3, updated: 0 };
      },
    });

    await assert.rejects(
      () => backfillExecutor.runBackfill({ id: 'repo_data_sync_v1' }, () => 'translated failure'),
      /first attempt failed/,
    );

    assert.deepEqual(
      await backfillExecutor.runBackfill({ id: 'repo_data_sync_v1' }, String),
      { ok: true, data: { id: 'repo_data_sync_v1', added: 3, updated: 0, tagged: 0 } },
    );
    assert.equal(fullSyncCalls, 2);
    assert.deepEqual(states, ['running', 'failed', 'running', 'done']);
  });
});
