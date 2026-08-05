export type DurableJobClaim = Readonly<{
  jobId: string;
}>;

export type DurableJobSettlement = Readonly<{
  complete: boolean;
}>;

export type DurableJobPumpContext = Readonly<{
  operationId: string;
  executionId: string;
  sequence: number;
  jobId: string | null;
}>;

export type DurableJobPumpDependencies<
  TClaim extends DurableJobClaim,
  TSettlement extends DurableJobSettlement,
> = Readonly<{
  runSerialized: <T>(fn: () => Promise<T>) => Promise<T>;
  claim(operationId: string): Promise<TClaim | null>;
  settle(
    operationId: string,
    claim: TClaim,
    context: DurableJobPumpContext,
  ): Promise<TSettlement>;
  onStarted?(context: DurableJobPumpContext): void;
  onIdle?(context: DurableJobPumpContext): void;
  onClaimed?(claim: TClaim, context: DurableJobPumpContext): void;
  onSettled?(
    claim: TClaim,
    settlement: TSettlement,
    context: DurableJobPumpContext,
  ): void;
  onProgress(
    jobId: string,
    claim: TClaim,
    settlement: TSettlement,
    context: DurableJobPumpContext,
  ): Promise<void>;
  onComplete(
    jobId: string,
    claim: TClaim,
    settlement: TSettlement,
    context: DurableJobPumpContext,
  ): void;
  onFailure(input: Readonly<{
    operationId: string;
    jobId: string | null;
    executionId: string;
    sequence: number | null;
    error: unknown;
  }>): Promise<void>;
  shouldRestart(operationId: string): Promise<boolean>;
  createExecutionId?: () => string;
  delayBeforeRestart?(consecutiveFailures: number): Promise<void>;
}>;

const RESTART_BACKOFF_BASE_MS = 250;
const RESTART_BACKOFF_MAX_MS = 30_000;

function defaultDelayBeforeRestart(consecutiveFailures: number): Promise<void> {
  const exponent = Math.max(0, Math.min(7, consecutiveFailures - 1));
  const delay = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * (2 ** exponent));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Runs one durable claim/checkpoint loop without owning domain state. */
export function createDurableJobPump<
  TClaim extends DurableJobClaim,
  TSettlement extends DurableJobSettlement,
>(dependencies: DurableJobPumpDependencies<TClaim, TSettlement>) {
  const executions = new Map<string, Promise<void>>();
  const consecutiveFailures = new Map<string, number>();

  const start = (operationId: string): Promise<void> => {
    const existing = executions.get(operationId);
    if (existing) return existing;
    let currentJobId: string | null = null;
    let sequence = 0;
    const executionId = dependencies.createExecutionId?.() ?? crypto.randomUUID();
    const context = (): DurableJobPumpContext => Object.freeze({
      operationId,
      executionId,
      sequence,
      jobId: currentJobId,
    });

    dependencies.onStarted?.(context());
    const serialized = dependencies.runSerialized(async () => {
      while (true) {
        const claim = await dependencies.claim(operationId);
        if (!claim) {
          dependencies.onIdle?.(context());
          return;
        }
        currentJobId = claim.jobId;
        sequence += 1;
        dependencies.onClaimed?.(claim, context());
        const settlement = await dependencies.settle(operationId, claim, context());
        dependencies.onSettled?.(claim, settlement, context());
        await dependencies.onProgress(currentJobId, claim, settlement, context());
        if (settlement.complete) {
          dependencies.onComplete(currentJobId, claim, settlement, context());
          return;
        }
      }
    });

    const execution = serialized
      .then(() => {
        consecutiveFailures.delete(operationId);
      })
      .catch(async (error) => {
        consecutiveFailures.set(operationId, (consecutiveFailures.get(operationId) ?? 0) + 1);
        try {
          await dependencies.onFailure({
            operationId,
            jobId: currentJobId,
            executionId,
            sequence: sequence || null,
            error,
          });
        } catch {
          // The lease remains durable when best-effort failure handling fails.
        }
      })
      .finally(async () => {
        try {
          // Keep this execution registered while restart authority and backoff are
          // being resolved. A recovery wake during that window must join the
          // existing restart reservation instead of starting a second chain.
          if (!(await dependencies.shouldRestart(operationId))) {
            if (executions.get(operationId) === execution) executions.delete(operationId);
            consecutiveFailures.delete(operationId);
            return;
          }
          const failures = consecutiveFailures.get(operationId) ?? 0;
          if (failures > 0) {
            await (dependencies.delayBeforeRestart ?? defaultDelayBeforeRestart)(failures);
          }
          // The durable operation may have completed while the backoff timer was
          // pending, so do not restart from the stale pre-delay decision.
          if (!(await dependencies.shouldRestart(operationId))) {
            if (executions.get(operationId) === execution) executions.delete(operationId);
            consecutiveFailures.delete(operationId);
            return;
          }
          if (executions.get(operationId) !== execution) return;
          // Replace the reservation atomically before starting the next attempt.
          // JavaScript does not yield between these two synchronous operations.
          executions.delete(operationId);
          void start(operationId);
        } catch {
          if (executions.get(operationId) === execution) executions.delete(operationId);
          consecutiveFailures.delete(operationId);
          // A later wake or attach can rediscover the durable operation.
        }
      });
    executions.set(operationId, execution);
    return execution;
  };

  return Object.freeze({
    start,
    isRunning: (operationId: string) => executions.has(operationId),
  });
}
