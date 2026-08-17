import type { BackfillId } from '@/types';
import type { BackfillStateMutator } from './backfill-config';
import type { SerializedRunner } from './serialized-runner';

type BackfillTask = {
  id: BackfillId;
};

type BackfillStateWriter = (
  id: BackfillId,
  mutate: BackfillStateMutator,
) => Promise<unknown>;

type BackfillExecutorDeps<TFullSyncResult extends object> = {
  jobQueue: Pick<SerializedRunner, 'run'>;
  setBackfillState: BackfillStateWriter;
  performFullSyncJob: () => Promise<TFullSyncResult>;
};

export type BackfillExecutionResult<TFullSyncResult extends object> = {
  ok: true;
  data: { id: BackfillId; tagged: 0 } & TFullSyncResult;
};

export function createBackfillExecutor<TFullSyncResult extends object>({
  jobQueue,
  setBackfillState,
  performFullSyncJob,
}: BackfillExecutorDeps<TFullSyncResult>) {
  const queuedById = new Map<BackfillId, Promise<BackfillExecutionResult<TFullSyncResult>>>();

  function runBackfill(
    task: BackfillTask,
    translateForState: (error: unknown) => string,
  ): Promise<BackfillExecutionResult<TFullSyncResult>> {
    const existing = queuedById.get(task.id);
    if (existing) return existing;

    const promise = jobQueue.run(async () => {
      await setBackfillState(task.id, (current, now) => ({
        status: 'running',
        queuedAt: current?.queuedAt ?? now,
        lastAttemptAt: now,
        completedAt: null,
        error: null,
      }));

      try {
        // This already runs inside jobQueue.run; calling the queued full-sync
        // wrapper here would re-enter the serialized runner and deadlock.
        const result = await performFullSyncJob();
        await setBackfillState(task.id, (current, now) => ({
          status: 'done',
          queuedAt: current?.queuedAt ?? now,
          lastAttemptAt: current?.lastAttemptAt ?? now,
          completedAt: now,
          error: null,
        }));
        const response: BackfillExecutionResult<TFullSyncResult> = {
          ok: true,
          data: { id: task.id, ...result, tagged: 0 as const },
        };
        return response;
      } catch (error) {
        const msg = translateForState(error);
        await setBackfillState(task.id, (current, now) => ({
          status: 'failed',
          queuedAt: current?.queuedAt ?? now,
          lastAttemptAt: current?.lastAttemptAt ?? now,
          completedAt: null,
          error: msg,
        }));
        throw error;
      }
    }, { kind: 'stars-sync' });

    queuedById.set(task.id, promise);
    promise.finally(() => {
      if (queuedById.get(task.id) === promise) queuedById.delete(task.id);
    }).catch(() => {});
    return promise;
  }

  return { runBackfill };
}
