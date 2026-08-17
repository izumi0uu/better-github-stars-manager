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

  it('tracks queued Stars sync separately from unrelated work', async () => {
    const runner = createSerializedRunner();
    let releaseUnrelated!: () => void;
    const unrelatedDone = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });

    const unrelated = runner.run(() => unrelatedDone);
    const starsSync = runner.run(async () => {}, { kind: 'stars-sync' });

    assert.equal(runner.isRunning(), true);
    assert.equal(runner.isRunning('stars-sync'), true);
    assert.equal(runner.isRunning('progress'), false);

    releaseUnrelated();
    await Promise.all([unrelated, starsSync]);
    assert.equal(runner.isRunning(), false);
    assert.equal(runner.isRunning('stars-sync'), false);
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

  it('does not start a queued job after its signal is aborted', async () => {
    const runner = createSerializedRunner();
    const controller = new AbortController();
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let queuedJobStarted = false;

    const first = runner.run(() => firstDone);
    const queued = runner.run(
      async () => {
        queuedJobStarted = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    releaseFirst();

    await first;
    await assert.rejects(queued, { name: 'AbortError' });
    assert.equal(queuedJobStarted, false);
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
    const backfill = backfillExecutor.runBackfill({ id: 'repo_data_sync' }, String);

    await Promise.resolve();
    assert.deepEqual(states, []);
    assert.equal(jobQueue.isRunning('stars-sync'), true);

    releaseFirst();
    await fullSyncStartedPromise;
    assert.deepEqual(states, ['running']);

    releaseFullSync();
    assert.deepEqual(await backfill, {
      ok: true,
      data: { id: 'repo_data_sync', added: 1, updated: 1, tagged: 0 },
    });
    await first;
    assert.deepEqual(states, ['running', 'done']);
    assert.equal(jobQueue.isRunning('stars-sync'), false);
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

    const first = backfillExecutor.runBackfill({ id: 'repo_data_sync' }, String);
    const second = backfillExecutor.runBackfill({ id: 'repo_data_sync' }, String);
    assert.equal(first, second);

    releaseFullSync();
    assert.deepEqual(await Promise.all([first, second]), [
      { ok: true, data: { id: 'repo_data_sync', added: 2, updated: 2, tagged: 0 } },
      { ok: true, data: { id: 'repo_data_sync', added: 2, updated: 2, tagged: 0 } },
    ]);
    assert.equal(fullSyncCalls, 1);
  });

  it('records failed backfills and leaves the serialized queue usable', async () => {
    const jobQueue = createSerializedRunner();
    const states: Array<{ status: BackfillState['status']; error: string | null; lastAttemptAt: string | null }> = [];
    let currentState: BackfillState | undefined;
    const backfillExecutor = createBackfillExecutor({
      jobQueue,
      async setBackfillState(_id, mutate) {
        const next = mutate(currentState, `t${states.length + 1}`);
        currentState = next;
        states.push({ status: next.status, error: next.error, lastAttemptAt: next.lastAttemptAt });
        return next;
      },
      async performFullSyncJob() {
        throw new Error('sync failed');
      },
    });

    await assert.rejects(
      () => backfillExecutor.runBackfill({ id: 'repo_data_sync' }, () => 'translated failure'),
      /sync failed/,
    );
    assert.deepEqual(states, [
      { status: 'running', error: null, lastAttemptAt: 't1' },
      { status: 'failed', error: 'translated failure', lastAttemptAt: 't1' },
    ]);
    assert.equal(await jobQueue.run(async () => 'after'), 'after');
  });

  it('allows the same backfill id to retry after a failed execution settles', async () => {
    const jobQueue = createSerializedRunner();
    const states: Array<{ status: BackfillState['status']; lastAttemptAt: string | null }> = [];
    let currentState: BackfillState | undefined;
    let fullSyncCalls = 0;
    const backfillExecutor = createBackfillExecutor({
      jobQueue,
      async setBackfillState(_id, mutate) {
        const next = mutate(currentState, `t${states.length + 1}`);
        currentState = next;
        states.push({ status: next.status, lastAttemptAt: next.lastAttemptAt });
        return next;
      },
      async performFullSyncJob() {
        fullSyncCalls++;
        if (fullSyncCalls === 1) throw new Error('first attempt failed');
        return { added: 3, updated: 0 };
      },
    });

    await assert.rejects(
      () => backfillExecutor.runBackfill({ id: 'repo_data_sync' }, () => 'translated failure'),
      /first attempt failed/,
    );

    assert.deepEqual(
      await backfillExecutor.runBackfill({ id: 'repo_data_sync' }, String),
      { ok: true, data: { id: 'repo_data_sync', added: 3, updated: 0, tagged: 0 } },
    );
    assert.equal(fullSyncCalls, 2);
    assert.deepEqual(states, [
      { status: 'running', lastAttemptAt: 't1' },
      { status: 'failed', lastAttemptAt: 't1' },
      { status: 'running', lastAttemptAt: 't3' },
      { status: 'done', lastAttemptAt: 't3' },
    ]);
  });
});
