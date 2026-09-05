import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import {
  createQueuedAgentGlobalTagDeletionWriter,
  createQueuedAgentManualTagWriter,
  createQueuedAgentVisibleTagRemovalWriter,
} from '@/background/agent-manual-tag-writer';
import { createSerializedRunner } from '@/background/serialized-runner';

describe('Agent cancellation during the asynchronous Apply gate', () => {
  for (const mutation of ['add', 'remove', 'delete'] as const) {
    it(`does not start ${mutation} after Stop while the gate is pending`, async () => {
      const runner = createSerializedRunner();
      const controller = new AbortController();
      let releaseGate!: (blocked: boolean) => void;
      let enteredGate!: () => void;
      const entered = new Promise<void>((resolve) => { enteredGate = resolve; });
      const gate = new Promise<boolean>((resolve) => { releaseGate = resolve; });
      const markWriteStarted = vi.fn();
      const write = vi.fn(async () => {
        throw new Error('Cancelled mutation reached storage.');
      });
      const dependencies = {
        runSerialized: runner.run,
        isBlocked: () => { enteredGate(); return gate; },
        write,
      };
      const context = {
        sessionId: 'session-gate',
        callId: 'call-gate',
        signal: controller.signal,
        markWriteStarted,
      };
      const pending = mutation === 'add'
        ? createQueuedAgentManualTagWriter(dependencies)('owner/repo', ['tag'], context)
        : mutation === 'remove'
          ? createQueuedAgentVisibleTagRemovalWriter(dependencies)(
              [{ full_name: 'owner/repo', tags: ['tag'] }], context,
            )
          : createQueuedAgentGlobalTagDeletionWriter(dependencies)(['tag'], context);
      await entered;
      controller.abort();
      releaseGate(false);
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(markWriteStarted.mock.calls.length, 0);
      assert.equal(write.mock.calls.length, 0);
      assert.equal(await runner.run(async () => 'queue released'), 'queue released');
    });
  }
});

describe('background Agent manual-tag writer', () => {
  it('runs a previously authorized write only after an active Apply completes', async () => {
    const runner = createSerializedRunner();
    let releaseApply!: () => void;
    let applyActive = true;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const apply = runner.run(async () => {
      await applyGate;
      applyActive = false;
    });
    const write = vi.fn(async (_fullName: string, _tags: readonly string[]) => ({
      manualTags: ['queued'],
      changed: true,
      reason: null,
    }));
    const queuedWriter = createQueuedAgentManualTagWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => applyActive,
      write,
    });

    const queuedWrite = queuedWriter(
      'owner/repo',
      ['queued'],
      { sessionId: 'session', callId: 'call' },
    );
    await Promise.resolve();
    assert.equal(write.mock.calls.length, 0);

    releaseApply();
    await apply;
    assert.deepEqual(await queuedWrite, {
      manualTags: ['queued'],
      changed: true,
      reason: null,
    });
    assert.equal(write.mock.calls.length, 1);
  });

  it('rechecks Apply state when the queued write reaches the front', async () => {
    const runner = createSerializedRunner();
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const blocker = runner.run(() => queueGate);
    const write = vi.fn(async (_fullName: string, _tags: readonly string[]) => ({
      manualTags: ['blocked'],
      changed: true,
      reason: null,
    }));
    const queuedWriter = createQueuedAgentManualTagWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => true,
      write,
    });

    const queuedWrite = queuedWriter(
      'owner/repo',
      ['blocked'],
      { sessionId: 'session', callId: 'call' },
    );
    releaseQueue();
    await blocker;
    await assert.rejects(
      queuedWrite,
      /unavailable while full-library tag changes are being applied/u,
    );
    assert.equal(write.mock.calls.length, 0);
  });

  it('does not mark a queued write started when cancellation removes it before the queue front', async () => {
    const runner = createSerializedRunner();
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const blocker = runner.run(() => queueGate);
    const controller = new AbortController();
    const markStarted = vi.fn();
    const write = vi.fn(async () => ({ manualTags: ['never'], changed: true, reason: null }));
    const queuedWriter = createQueuedAgentManualTagWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => false,
      write,
    });

    const queuedWrite = queuedWriter('owner/repo', ['never'], {
      sessionId: 'session',
      callId: 'call',
      signal: controller.signal,
      markWriteStarted: markStarted,
    });
    controller.abort();
    releaseQueue();
    await blocker;
    await assert.rejects(queuedWrite);
    assert.equal(markStarted.mock.calls.length, 0);
    assert.equal(write.mock.calls.length, 0);
  });

  it('marks the durable-write boundary immediately before the injected writer', async () => {
    const runner = createSerializedRunner();
    const markStarted = vi.fn();
    const write = vi.fn(async () => ({ manualTags: ['written'], changed: true, reason: null }));
    const queuedWriter = createQueuedAgentManualTagWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => false,
      write,
    });
    await queuedWriter('owner/repo', ['written'], {
      sessionId: 'session',
      callId: 'call',
      markWriteStarted: markStarted,
    });
    assert.equal(markStarted.mock.calls.length, 1);
    assert.equal(write.mock.calls.length, 1);
  });
});

describe('background Agent destructive-tag writers', () => {
  it('serializes one atomic repository-tag removal batch and delegates the write boundary', async () => {
    const runner = createSerializedRunner();
    const markStarted = vi.fn();
    const write = vi.fn(async (_changes: readonly Readonly<{
      full_name: string;
      tags: readonly string[];
    }>[]) => ({
      requested: 3,
      changed: 2,
      skipped: 1,
      repositoriesChanged: 2,
    }));
    const queuedWriter = createQueuedAgentVisibleTagRemovalWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => false,
      write,
    });
    const changes = [
      { full_name: 'owner/one', tags: ['legacy', 'unused'] },
      { full_name: 'owner/two', tags: ['legacy'] },
    ];

    assert.deepEqual(await queuedWriter(changes, {
      sessionId: 'session',
      callId: 'call',
      markWriteStarted: markStarted,
    }), {
      requested: 3,
      changed: 2,
      skipped: 1,
      repositoriesChanged: 2,
    });
    assert.deepEqual(write.mock.calls[0]?.[0], changes);
    assert.equal(markStarted.mock.calls.length, 1);
  });

  it('deletes a batch of global tags inside one serialized queue operation', async () => {
    const runner = createSerializedRunner();
    const markStarted = vi.fn();
    const write = vi.fn(async (_tags: readonly string[]) => ({
      requestedTags: 2,
      assignmentsRemoved: 4,
      repositoriesChanged: 3,
    }));
    const queuedWriter = createQueuedAgentGlobalTagDeletionWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => false,
      write,
    });

    assert.deepEqual(await queuedWriter(['legacy', 'unused'], {
      sessionId: 'session',
      callId: 'call',
      markWriteStarted: markStarted,
    }), {
      requestedTags: 2,
      assignmentsRemoved: 4,
      repositoriesChanged: 3,
    });
    assert.deepEqual(write.mock.calls[0]?.[0], ['legacy', 'unused']);
    assert.equal(write.mock.calls.length, 1);
    assert.equal(markStarted.mock.calls.length, 1);
  });

  it('rechecks the Organize Apply lock before destructive writes reach storage', async () => {
    const runner = createSerializedRunner();
    const remove = vi.fn(async () => ({
      requested: 1,
      changed: 1,
      skipped: 0,
      repositoriesChanged: 1,
    }));
    const del = vi.fn(async () => ({
      requestedTags: 1,
      assignmentsRemoved: 1,
      repositoriesChanged: 1,
    }));
    const removalWriter = createQueuedAgentVisibleTagRemovalWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => true,
      write: remove,
    });
    const deletionWriter = createQueuedAgentGlobalTagDeletionWriter({
      runSerialized: (operation, options) => runner.run(operation, options),
      isBlocked: () => true,
      write: del,
    });

    await assert.rejects(
      removalWriter([{ full_name: 'owner/repo', tags: ['legacy'] }], {
        sessionId: 'session', callId: 'remove',
      }),
      /unavailable while full-library tag changes are being applied/u,
    );
    await assert.rejects(
      deletionWriter(['legacy'], { sessionId: 'session', callId: 'delete' }),
      /unavailable while full-library tag changes are being applied/u,
    );
    assert.equal(remove.mock.calls.length, 0);
    assert.equal(del.mock.calls.length, 0);
  });
});
