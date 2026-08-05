import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createDurableJobPump } from '@/background/durable-job-pump';

describe('durable job pump', () => {
  it('deduplicates one operation while checkpointing claims until complete', async () => {
    const operations: string[] = [];
    let claimSequence = 0;
    const pump = createDurableJobPump({
      runSerialized: (run) => run(),
      async claim(operationId) {
        claimSequence += 1;
        operations.push(`claim:${operationId}:${claimSequence}`);
        return { jobId: 'job-1', position: claimSequence };
      },
      async settle(_operationId, claim) {
        operations.push(`settle:${claim.position}`);
        return { complete: claim.position === 2 };
      },
      async onProgress(jobId, claim) {
        operations.push(`progress:${jobId}:${claim.position}`);
      },
      onComplete(jobId) {
        operations.push(`complete:${jobId}`);
      },
      async onFailure() {
        operations.push('failure');
      },
      async shouldRestart() {
        return false;
      },
      createExecutionId: () => 'execution-1',
    });

    const first = pump.start('operation-1');
    const duplicate = pump.start('operation-1');
    assert.equal(first, duplicate);
    assert.equal(pump.isRunning('operation-1'), true);
    await first;

    assert.deepEqual(operations, [
      'claim:operation-1:1',
      'settle:1',
      'progress:job-1:1',
      'claim:operation-1:2',
      'settle:2',
      'progress:job-1:2',
      'complete:job-1',
    ]);
    assert.equal(pump.isRunning('operation-1'), false);
  });

  it('reports a bounded execution identity when a durable claim fails', async () => {
    const failures: unknown[] = [];
    const pump = createDurableJobPump({
      runSerialized: (run) => run(),
      async claim() {
        throw new Error('claim failed');
      },
      async settle() {
        return { complete: true };
      },
      async onProgress() {},
      onComplete() {},
      async onFailure(input) {
        failures.push(input);
      },
      async shouldRestart() {
        return false;
      },
      createExecutionId: () => 'execution-failed',
    });

    await pump.start('operation-failed');

    assert.deepEqual(failures, [{
      operationId: 'operation-failed',
      jobId: null,
      executionId: 'execution-failed',
      sequence: null,
      error: new Error('claim failed'),
    }]);
  });

  it('backs off repeated immediate failures before restarting', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const pump = createDurableJobPump({
      runSerialized: (run) => run(),
      async claim() {
        attempts += 1;
        throw new Error(`claim failed ${attempts}`);
      },
      async settle() {
        return { complete: true };
      },
      async onProgress() {},
      onComplete() {},
      async onFailure() {},
      async shouldRestart() {
        return attempts < 3;
      },
      async delayBeforeRestart(consecutiveFailures) {
        delays.push(consecutiveFailures);
      },
      createExecutionId: () => `execution-${attempts + 1}`,
    });

    await pump.start('operation-retry');
    for (let index = 0; index < 20 && attempts < 3; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1, 2]);
  });

  it('keeps a restart reservation during backoff and rechecks authority', async () => {
    let attempts = 0;
    let shouldRestartChecks = 0;
    let releaseBackoff!: () => void;
    let backoffStarted!: () => void;
    const backoffStartedPromise = new Promise<void>((resolve) => {
      backoffStarted = resolve;
    });
    const backoff = new Promise<void>((resolve) => {
      releaseBackoff = resolve;
    });
    const pump = createDurableJobPump({
      runSerialized: (run) => run(),
      async claim() {
        attempts += 1;
        throw new Error('claim failed');
      },
      async settle() {
        return { complete: true };
      },
      async onProgress() {},
      onComplete() {},
      async onFailure() {},
      async shouldRestart() {
        shouldRestartChecks += 1;
        return shouldRestartChecks === 1;
      },
      async delayBeforeRestart() {
        backoffStarted();
        await backoff;
      },
      createExecutionId: () => `execution-${attempts + 1}`,
    });

    const first = pump.start('operation-reservation');
    await backoffStartedPromise;
    assert.equal(pump.isRunning('operation-reservation'), true);
    assert.equal(pump.start('operation-reservation'), first);

    releaseBackoff();
    await first;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(attempts, 1);
    assert.equal(shouldRestartChecks, 2);
    assert.equal(pump.isRunning('operation-reservation'), false);
  });
});
