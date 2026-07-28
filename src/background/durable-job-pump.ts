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
}>;

/** Runs one durable claim/checkpoint loop without owning domain state. */
export function createDurableJobPump<
  TClaim extends DurableJobClaim,
  TSettlement extends DurableJobSettlement,
>(dependencies: DurableJobPumpDependencies<TClaim, TSettlement>) {
  const executions = new Map<string, Promise<void>>();

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
      .catch(async (error) => {
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
        executions.delete(operationId);
        try {
          if (await dependencies.shouldRestart(operationId)) void start(operationId);
        } catch {
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
