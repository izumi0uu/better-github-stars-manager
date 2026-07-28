import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { createQueuedAgentManualTagWriter } from '@/background/agent-manual-tag-writer';
import { createSerializedRunner } from '@/background/serialized-runner';

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
    const write = vi.fn(async () => ({
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
    const write = vi.fn(async () => ({
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
