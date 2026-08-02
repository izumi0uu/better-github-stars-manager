import type { DevTraceEventInput } from './event-builders';
import { DevTraceDB } from './dev-trace-db';
import type { DevTraceEventDataByKind } from './contracts';
import {
  createDevTraceRecorder,
  type DevTraceRecorder,
  type DevTraceRootContext,
} from './recorder';
import {
  organizeJobRunRootOperationId,
  type OrganizeJobRunTrace,
  type OrganizeJobRunTraceFactory,
  type OrganizeJobRunTraceStart,
} from './organize-job-types';
import { parseOrganizeJobId } from '@/bgsm-agent/identity';

export function createDevOrganizeJobRunTraceFactory(input: Readonly<{
  recorder?: DevTraceRecorder;
}> = {}): OrganizeJobRunTraceFactory {
  const recorder = input.recorder ?? createDevTraceRecorder();
  return (start) => createOrganizeJobRunTrace(recorder, start);
}

export async function reconcileDevOrganizeJobRunProvisionalRoots(input: Readonly<{
  executionEpochId: string;
  durableJobIds: ReadonlySet<string>;
  db?: DevTraceDB;
}>): Promise<number> {
  const db = input.db ?? new DevTraceDB();
  const ownsDb = !input.db;
  let reconciled = 0;
  try {
    const roots = await db.roots
      .where('operationKind')
      .equals('organize_job')
      .filter((root) => root.endedAt === null)
      .toArray();
    const recorder = createDevTraceRecorder({ db });
    const factory = createDevOrganizeJobRunTraceFactory({ recorder });
    for (const root of roots) {
      const prefix = 'organize_job:';
      if (!root.rootOperationId.startsWith(prefix)) continue;
      const jobId = parseOrganizeJobId(root.rootOperationId.slice(prefix.length));
      if (input.durableJobIds.has(jobId)) continue;
      const started = await db.events
        .where('[rootOperationId+sequence]')
        .equals([root.rootOperationId, 1])
        .first();
      if (started?.kind !== 'root_started') continue;
      const startedData = started.data as DevTraceEventDataByKind['root_started'];
      if (startedData.executionEpochId === input.executionEpochId) continue;
      const trace = factory({
        jobId,
        executionEpochId: input.executionEpochId,
        startedAt: root.startedAt,
        resumeExisting: true,
      });
      trace.recordPreflight('worker_lost', null);
      trace.recordCancellation('runtime');
      trace.finish('attempt_state_lost', 'worker_state_lost');
      await trace.flush();
      reconciled += 1;
    }
    return reconciled;
  } finally {
    if (ownsDb) db.close();
  }
}

function createOrganizeJobRunTrace(
  recorder: DevTraceRecorder,
  start: OrganizeJobRunTraceStart,
): OrganizeJobRunTrace {
  const rootPromise = recorder.startRoot({
    rootOperationId: organizeJobRunRootOperationId(start.jobId),
    operationKind: 'organize_job',
    sessionId: null,
    executionEpochId: start.executionEpochId,
    attemptId: null,
    baseRevision: null,
    startedAt: start.startedAt,
    resumeExisting: start.resumeExisting,
  });
  const traceInstanceId = crypto.randomUUID();
  const batchSpans = new Map<string, string>();
  const providerSpans = new Map<string, string>();
  const applyAttemptSpans = new Map<string, string>();
  const applyChunkSpans = new Map<string, string>();
  const openSpans = new Set<string>();
  const recordedGenerations = new Set<string>();
  let tail = Promise.resolve();
  let terminalScheduled = false;
  let cancellationRecorded = false;
  let durableRevisionHighWater: number | null | undefined;
  let receiptSpanSequence = 0;
  let transitionSpanSequence = 0;

  const schedule = (
    work: (root: DevTraceRootContext) => Promise<void>,
    allowAfterTerminal = false,
  ): void => {
    if (terminalScheduled && !allowAfterTerminal) return;
    tail = tail.then(async () => work(await rootPromise)).catch(() => {
      // Development tracing is observational and cannot affect OrganizeJobRun.
    });
  };

  const startSpan = async (
    root: DevTraceRootContext,
    spanId: string,
    parentSpanId: string,
    spanKind: string,
  ): Promise<void> => {
    if (openSpans.has(spanId)) return;
    openSpans.add(spanId);
    await recorder.startSpan(root, { spanId, parentSpanId, spanKind });
  };

  const closeSpan = async (spanId: string): Promise<void> => {
    if (!openSpans.delete(spanId)) return;
    await recorder.finishSpan(spanId);
  };

  const emit = async (
    root: DevTraceRootContext,
    event: DevTraceEventInput,
    spanId = root.rootSpanId,
    parentSpanId: string | null = null,
  ): Promise<void> => {
    await recorder.emit(root, spanId, parentSpanId, event);
  };

  const batchKey = (input: Readonly<{
    runId: string;
    generation: number;
    batchStart: number;
    batchEnd: number;
  }>): string => `${input.runId}:${input.generation}:${input.batchStart}:${input.batchEnd}`;

  const ensureBatchSpan = async (
    root: DevTraceRootContext,
    input: DevTraceEventDataByKind['organize_batch_state'] | DevTraceEventDataByKind['organize_provider_attempt'],
  ): Promise<string> => {
    const key = batchKey(input);
    const existing = batchSpans.get(key);
    if (existing) return existing;
    const spanId = `${root.rootOperationId}:batch:${key}`;
    batchSpans.set(key, spanId);
    await startSpan(root, spanId, root.rootSpanId, 'organize_batch');
    return spanId;
  };

  return {
    recordPreflight(state, repositoryCount) {
      schedule((root) => emit(root, {
        kind: 'organize_preflight_state',
        data: { state, repositoryCount },
      }));
    },

    recordGeneration(generation) {
      const key = `${generation.runId}:${generation.generation}:${generation.state}:${generation.cause}`;
      if (recordedGenerations.has(key)) return;
      recordedGenerations.add(key);
      schedule((root) => emit(root, {
        kind: 'organize_generation_state',
        data: generation,
      }));
    },

    recordBatch(batch) {
      schedule(async (root) => {
        const spanId = await ensureBatchSpan(root, batch);
        await emit(root, { kind: 'organize_batch_state', data: batch }, spanId, root.rootSpanId);
        if (['split', 'local_only_completed', 'provider_completed', 'analysis_failed', 'budget_exhausted', 'cancelled'].includes(batch.state)) {
          await closeSpan(spanId);
        }
      });
    },

    recordProviderAttempt(attempt) {
      schedule(async (root) => {
        const batchSpanId = await ensureBatchSpan(root, attempt);
        const key = `${batchKey(attempt)}:${attempt.attempt}`;
        let spanId = providerSpans.get(key);
        if (!spanId) {
          spanId = `${batchSpanId}:provider:${attempt.attempt}`;
          providerSpans.set(key, spanId);
          await startSpan(root, spanId, batchSpanId, 'organize_provider_attempt');
        }
        await emit(root, { kind: 'organize_provider_attempt', data: attempt }, spanId, batchSpanId);
        if (['succeeded', 'failed', 'budget_exhausted', 'cancelled'].includes(attempt.state)) {
          await closeSpan(spanId);
        }
      });
    },

    recordWatchdog(watchdog) {
      schedule((root) => emit(root, {
        kind: 'watchdog_state',
        data: watchdog,
      }));
    },

    recordDurableState(input) {
      schedule(async (root) => {
        if (durableRevisionHighWater === undefined) {
          const previous = await recorder.findLatestEvent(root.rootOperationId, 'organize_durable_state');
          durableRevisionHighWater = previous
            ? (previous.data as DevTraceEventDataByKind['organize_durable_state']).revision
            : null;
        }
        const previousRevision = durableRevisionHighWater;
        const gap = previousRevision !== null && input.revision > previousRevision + 1;
        const observation = previousRevision === null
          ? 'initial'
          : input.revision === previousRevision
            ? 'duplicate'
            : input.revision < previousRevision
              ? 'stale'
              : gap
                ? 'gap_reconciled'
                : 'advanced';
        await emit(root, {
          kind: 'organize_durable_state',
          data: {
            revision: input.revision,
            previousRevision,
            observation,
            missingFromRevision: gap ? previousRevision + 1 : null,
            missingToRevision: gap ? input.revision - 1 : null,
            source: input.source,
          },
        });
        if (previousRevision === null || input.revision > previousRevision) {
          durableRevisionHighWater = input.revision;
        }
      });
    },

    recordRestore(restore) {
      schedule((root) => emit(root, {
        kind: 'organize_restore_state',
        data: restore,
      }));
    },

    recordReview(review) {
      schedule(async (root) => {
        const spanId = `${root.rootOperationId}:review:${traceInstanceId}:${++transitionSpanSequence}`;
        await startSpan(root, spanId, root.rootSpanId, 'organize_review');
        await emit(root, { kind: 'organize_review_state', data: review }, spanId, root.rootSpanId);
        await closeSpan(spanId);
      });
    },

    recordSelection(selection) {
      schedule(async (root) => {
        const spanId = `${root.rootOperationId}:selection:${traceInstanceId}:${++transitionSpanSequence}`;
        await startSpan(root, spanId, root.rootSpanId, 'organize_selection');
        await emit(root, { kind: 'organize_selection_state', data: selection }, spanId, root.rootSpanId);
        await closeSpan(spanId);
      });
    },

    recordApply(apply) {
      schedule(async (root) => {
        if (apply.executionId) {
          let spanId = applyAttemptSpans.get(apply.executionId);
          if (!spanId) {
            spanId = `${root.rootOperationId}:apply:${apply.applyId}:${apply.executionId}`;
            applyAttemptSpans.set(apply.executionId, spanId);
            await startSpan(root, spanId, root.rootSpanId, 'organize_apply_attempt');
          }
          await emit(root, { kind: 'organize_apply_state', data: apply }, spanId, root.rootSpanId);
          if (['attempt_idle', 'attempt_completed', 'attempt_failed'].includes(apply.state)) {
            for (const [key, chunkSpanId] of applyChunkSpans) {
              if (key.startsWith(`${apply.executionId}:`)) await closeSpan(chunkSpanId);
            }
            await closeSpan(spanId);
          }
          return;
        }
        const spanId = `${root.rootOperationId}:apply-transition:${traceInstanceId}:${++transitionSpanSequence}`;
        await startSpan(root, spanId, root.rootSpanId, 'organize_apply_transition');
        await emit(root, { kind: 'organize_apply_state', data: apply }, spanId, root.rootSpanId);
        await closeSpan(spanId);
      });
    },

    recordApplyChunk(chunk) {
      schedule(async (root) => {
        let attemptSpanId = applyAttemptSpans.get(chunk.executionId);
        if (!attemptSpanId) {
          attemptSpanId = `${root.rootOperationId}:apply:${chunk.applyId}:${chunk.executionId}`;
          applyAttemptSpans.set(chunk.executionId, attemptSpanId);
          await startSpan(root, attemptSpanId, root.rootSpanId, 'organize_apply_attempt');
        }
        const key = `${chunk.executionId}:${chunk.chunkSequence}`;
        let spanId = applyChunkSpans.get(key);
        if (!spanId) {
          spanId = `${attemptSpanId}:chunk:${chunk.chunkSequence}`;
          applyChunkSpans.set(key, spanId);
          await startSpan(root, spanId, attemptSpanId, 'organize_apply_chunk');
        }
        await emit(root, { kind: 'organize_apply_chunk', data: chunk }, spanId, attemptSpanId);
        if (chunk.state === 'settled') await closeSpan(spanId);
      });
    },

    recordReceipt(receipt) {
      const afterTerminal = terminalScheduled;
      schedule(async (root) => {
        if (afterTerminal || root.terminalStateAtStart) {
          await emit(root, { kind: 'organize_receipt_state', data: receipt });
          return;
        }
        const spanId = `${root.rootOperationId}:receipt:${traceInstanceId}:${++receiptSpanSequence}`;
        await startSpan(root, spanId, root.rootSpanId, 'organize_receipt');
        await emit(root, { kind: 'organize_receipt_state', data: receipt }, spanId, root.rootSpanId);
        await closeSpan(spanId);
      }, true);
    },

    recordCancellation(source) {
      if (cancellationRecorded) return;
      cancellationRecorded = true;
      schedule((root) => emit(root, {
        kind: 'root_cancelled',
        data: { source },
      }));
    },

    finish(state, reasonCode) {
      if (terminalScheduled) return;
      terminalScheduled = true;
      tail = tail.then(async () => {
        const root = await rootPromise;
        for (const spanId of [...openSpans]) await closeSpan(spanId);
        await recorder.finishRoot(root, state, reasonCode);
      }).catch(() => {
        // Terminal trace persistence cannot replace the product result.
      });
    },

    flush() {
      return tail.then(
        async () => { await rootPromise; },
        async () => { await rootPromise.catch(() => undefined); },
      );
    },
  };
}
