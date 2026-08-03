import { describe, expect, it, vi } from 'vitest';
import {
  createOrganizeApplyPump,
  type OrganizeApplyPumpLifecycleEvent,
} from '@/background/organize-apply-pump';
import { createSerializedRunner } from '@/background/serialized-runner';

describe('durable organize Apply pump', () => {
  it('deduplicates callers and drains one logical Apply through every internal chunk', async () => {
    const claims = [100, 100, 37].map((size, index) => ({
      leaseToken: `lease-${index}`,
      rows: Array.from({ length: size }, (_, offset) => ({
        jobId: 'job-1',
        position: index * 100 + offset,
        attemptCount: 1,
      })),
    }));
    const claimByLease = new Map(claims.map((claim) => [claim.leaseToken, claim]));
    const settled: string[] = [];
    const lifecycle: OrganizeApplyPumpLifecycleEvent[] = [];
    const onProgress = vi.fn(async () => {});
    const onComplete = vi.fn();
    const pump = createOrganizeApplyPump({
      runSerialized: async (fn) => fn(),
      claim: async () => claims.shift() ?? null,
      settle: async (_applyId, leaseToken) => {
        settled.push(leaseToken);
        return {
          complete: leaseToken === 'lease-2',
          rows: claimByLease.get(leaseToken)!.rows.map((row) => ({
            position: row.position,
            state: 'changed' as const,
          })),
        };
      },
      onProgress,
      onComplete,
      onFailure: async () => expect.fail('successful Apply must not recover as failed'),
      shouldRestart: async () => false,
      onLifecycle: (event) => lifecycle.push(event),
      createExecutionId: () => 'apply-execution-1',
    });

    const first = pump.pump('apply-1');
    const duplicate = pump.pump('apply-1');
    expect(duplicate).toBe(first);
    await first;

    expect(settled).toEqual(['lease-0', 'lease-1', 'lease-2']);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(pump.isRunning('apply-1')).toBe(false);
    expect(lifecycle.map((event) => event.type)).toEqual([
      'attempt_started',
      'chunk_claimed',
      'chunk_settled',
      'chunk_claimed',
      'chunk_settled',
      'chunk_claimed',
      'chunk_settled',
      'attempt_completed',
    ]);
    expect(lifecycle.find((event) => event.type === 'chunk_claimed')).toMatchObject({
      executionId: 'apply-execution-1',
      chunkSequence: 1,
      positionStart: 0,
      positionEnd: 100,
      rowCount: 100,
      maxAttemptCount: 1,
    });
    expect(lifecycle.findLast((event) => event.type === 'chunk_settled')).toMatchObject({
      chunkSequence: 3,
      positionStart: 200,
      positionEnd: 237,
      rowCount: 37,
      changed: 37,
      complete: true,
    });
  });

  it('contains a failed settlement and delegates durable pause recovery', async () => {
    const failure = new Error('outbox unavailable');
    const onFailure = vi.fn(async () => {});
    const pump = createOrganizeApplyPump({
      runSerialized: async (fn) => fn(),
      claim: async () => ({ leaseToken: 'lease-failed', rows: [{ jobId: 'job-failed' }] }),
      settle: async () => { throw failure; },
      onProgress: async () => expect.fail('failed settlement has no progress publication'),
      onComplete: () => expect.fail('failed settlement cannot complete'),
      onFailure,
      shouldRestart: async () => false,
    });

    await expect(pump.pump('apply-failed')).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith({
      applyId: 'apply-failed',
      jobId: 'job-failed',
      error: failure,
    });
  });

  it('holds the shared mutation queue until the complete logical Apply settles', async () => {
    const queue = createSerializedRunner();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    let claimed = false;
    const pump = createOrganizeApplyPump({
      runSerialized: queue.run,
      claim: async () => {
        if (claimed) return null;
        claimed = true;
        order.push('apply-claimed');
        return { leaseToken: 'lease', rows: [{ jobId: 'job' }] };
      },
      settle: async () => {
        await blocked;
        order.push('apply-settled');
        return { complete: true };
      },
      onProgress: async () => {},
      onComplete: () => { order.push('apply-complete'); },
      onFailure: async () => expect.fail('Apply should not fail'),
      shouldRestart: async () => false,
    });

    const applying = pump.pump('apply');
    await vi.waitFor(() => expect(order).toEqual(['apply-claimed']));
    const pull = queue.run(async () => { order.push('gist-pull'); });
    await Promise.resolve();
    expect(order).toEqual(['apply-claimed']);

    release();
    await Promise.all([applying, pull]);
    expect(order).toEqual(['apply-claimed', 'apply-settled', 'apply-complete', 'gist-pull']);
  });

  it('contains lifecycle observer failures without changing Apply settlement', async () => {
    let claimed = false;
    const onComplete = vi.fn();
    const pump = createOrganizeApplyPump({
      runSerialized: async (fn) => fn(),
      claim: async () => {
        if (claimed) return null;
        claimed = true;
        return { leaseToken: 'lease', rows: [{ jobId: 'job', position: 0, attemptCount: 1 }] };
      },
      settle: async () => ({
        complete: true,
        rows: [{ position: 0, state: 'unchanged' }],
      }),
      onProgress: async () => {},
      onComplete,
      onFailure: async () => expect.fail('observer failure must not fail Apply'),
      shouldRestart: async () => false,
      onLifecycle: () => { throw new Error('trace sink failed'); },
      createExecutionId: () => 'apply-execution-observer-failure',
    });

    await expect(pump.pump('apply')).resolves.toBeUndefined();
    expect(onComplete).toHaveBeenCalledWith('job');
  });

  it('emits completion after progress and domain completion with consistent empty settlement counts', async () => {
    const order: string[] = [];
    let claimed = false;
    const lifecycle: OrganizeApplyPumpLifecycleEvent[] = [];
    const pump = createOrganizeApplyPump({
      runSerialized: async (fn) => fn(),
      claim: async () => {
        if (claimed) return null;
        claimed = true;
        return { leaseToken: 'lease-empty', rows: [{ jobId: 'job-empty', position: 4 }] };
      },
      settle: async () => ({ complete: true, rows: [] }),
      onProgress: async () => { order.push('progress'); },
      onComplete: () => { order.push('domain_complete'); },
      onFailure: async () => expect.fail('empty settlement telemetry must not fail Apply'),
      shouldRestart: async () => false,
      onLifecycle: (event) => {
        lifecycle.push(event);
        if (event.type === 'chunk_settled' || event.type === 'attempt_completed') {
          order.push(event.type);
        }
      },
      createExecutionId: () => 'apply-execution-empty',
    });

    await pump.pump('apply-empty');

    expect(order).toEqual([
      'chunk_settled',
      'progress',
      'domain_complete',
      'attempt_completed',
    ]);
    expect(lifecycle.find((event) => event.type === 'chunk_settled')).toMatchObject({
      rowCount: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
