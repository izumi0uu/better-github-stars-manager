export type OrganizeApplyPumpClaim = Readonly<{
  leaseToken: string;
  rows: readonly Readonly<{
    jobId: string;
    position?: number;
    attemptCount?: number;
  }>[];
}>;

export type OrganizeApplyPumpSettlement = Readonly<{
  complete: boolean;
  rows?: readonly Readonly<{
    position: number;
    state: 'changed' | 'unchanged' | 'skipped' | 'failed';
  }>[];
}>;

export type OrganizeApplyPumpLifecycleEvent =
  | Readonly<{ type: 'attempt_started'; applyId: string; executionId: string }>
  | Readonly<{
      type: 'attempt_idle';
      applyId: string;
      executionId: string;
      jobId: string | null;
    }>
  | Readonly<{
      type: 'chunk_claimed';
      applyId: string;
      executionId: string;
      chunkSequence: number;
      jobId: string;
      positionStart: number | null;
      positionEnd: number | null;
      rowCount: number;
      maxAttemptCount: number | null;
    }>
  | Readonly<{
      type: 'chunk_settled';
      applyId: string;
      executionId: string;
      chunkSequence: number;
      jobId: string;
      positionStart: number | null;
      positionEnd: number | null;
      rowCount: number;
      changed: number;
      unchanged: number;
      skipped: number;
      failed: number;
      complete: boolean;
    }>
  | Readonly<{ type: 'attempt_completed'; applyId: string; executionId: string; jobId: string }>
  | Readonly<{
      type: 'attempt_failed';
      applyId: string;
      executionId: string;
      jobId: string | null;
      chunkSequence: number | null;
    }>;

export type OrganizeApplyPumpDependencies = Readonly<{
  runSerialized: <T>(fn: () => Promise<T>) => Promise<T>;
  claim: (applyId: string) => Promise<OrganizeApplyPumpClaim | null>;
  settle: (applyId: string, leaseToken: string) => Promise<OrganizeApplyPumpSettlement>;
  onProgress: (jobId: string) => Promise<void>;
  onComplete: (jobId: string) => void;
  onFailure: (input: Readonly<{
    applyId: string;
    jobId: string | null;
    error: unknown;
  }>) => Promise<void>;
  shouldRestart: (applyId: string) => Promise<boolean>;
  onLifecycle?: (event: OrganizeApplyPumpLifecycleEvent) => void;
  createExecutionId?: () => string;
}>;

export function createOrganizeApplyPump(dependencies: OrganizeApplyPumpDependencies) {
  type ApplyClaim = OrganizeApplyPumpClaim & Readonly<{ jobId: string }>;
  const emitLifecycle = (event: OrganizeApplyPumpLifecycleEvent): void => {
    try {
      dependencies.onLifecycle?.(event);
    } catch {
      // Apply tracing is observational and cannot affect durable mutations.
    }
  };
  const durablePump = createDurableJobPump<ApplyClaim, OrganizeApplyPumpSettlement>({
    runSerialized: dependencies.runSerialized,
    async claim(applyId) {
      const claim = await dependencies.claim(applyId);
      if (!claim) return null;
      const jobId = claim.rows[0]?.jobId ?? null;
      if (!jobId || claim.rows.some((row) => row.jobId !== jobId)) {
        throw new TypeError('Organize Apply claim has inconsistent job authority.');
      }
      return { ...claim, jobId };
    },
    settle(applyId, claim) {
      return dependencies.settle(applyId, claim.leaseToken);
    },
    onStarted({ operationId: applyId, executionId }) {
      emitLifecycle({ type: 'attempt_started', applyId, executionId });
    },
    onIdle({ operationId: applyId, executionId, jobId }) {
      emitLifecycle({ type: 'attempt_idle', applyId, executionId, jobId });
    },
    onClaimed(claim, { operationId: applyId, executionId, sequence: chunkSequence }) {
      const positions = claim.rows.flatMap((row) => row.position === undefined ? [] : [row.position]);
      const attemptCounts = claim.rows.flatMap((row) => row.attemptCount === undefined ? [] : [row.attemptCount]);
      emitLifecycle({
        type: 'chunk_claimed',
        applyId,
        executionId,
        chunkSequence,
        jobId: claim.jobId,
        positionStart: positions.length > 0 ? Math.min(...positions) : null,
        positionEnd: positions.length > 0 ? Math.max(...positions) + 1 : null,
        rowCount: claim.rows.length,
        maxAttemptCount: attemptCounts.length > 0 ? Math.max(...attemptCounts) : null,
      });
    },
    onSettled(claim, settled, {
      operationId: applyId,
      executionId,
      sequence: chunkSequence,
    }) {
      const settledRows = settled.rows ?? [];
      const settledPositions = settledRows.map((row) => row.position);
      emitLifecycle({
        type: 'chunk_settled',
        applyId,
        executionId,
        chunkSequence,
        jobId: claim.jobId,
        positionStart: settledPositions.length > 0 ? Math.min(...settledPositions) : null,
        positionEnd: settledPositions.length > 0 ? Math.max(...settledPositions) + 1 : null,
        rowCount: settledRows.length,
        changed: settledRows.filter((row) => row.state === 'changed').length,
        unchanged: settledRows.filter((row) => row.state === 'unchanged').length,
        skipped: settledRows.filter((row) => row.state === 'skipped').length,
        failed: settledRows.filter((row) => row.state === 'failed').length,
        complete: settled.complete,
      });
    },
    onProgress(jobId) {
      return dependencies.onProgress(jobId);
    },
    onComplete(jobId, _claim, _settlement, { operationId: applyId, executionId }) {
      dependencies.onComplete(jobId);
      emitLifecycle({ type: 'attempt_completed', applyId, executionId, jobId });
    },
    async onFailure({ operationId: applyId, jobId, executionId, sequence, error }) {
      emitLifecycle({
        type: 'attempt_failed',
        applyId,
        executionId,
        jobId,
        chunkSequence: sequence,
      });
      await dependencies.onFailure({ applyId, jobId, error });
    },
    shouldRestart: dependencies.shouldRestart,
    createExecutionId: dependencies.createExecutionId,
  });

  return Object.freeze({
    pump: durablePump.start,
    isRunning: durablePump.isRunning,
  });
}
import { createDurableJobPump } from './durable-job-pump';
