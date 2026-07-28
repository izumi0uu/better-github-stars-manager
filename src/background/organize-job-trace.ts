import type { OrganizeJobId } from '@/bgsm-agent/identity';
import type { OrganizeJobRunSnapshot } from '@/bgsm-agent/events';
import type {
  OrganizeJobRunTrace,
  OrganizeJobRunTraceFactory,
  OrganizeJobRunTraceStart,
} from '@/agent-observability/organize-job-types';
import type { DevTraceEventDataByKind } from '@/agent-observability/contracts';

export type OrganizeJobRunPreflightTraceState = DevTraceEventDataByKind['organize_preflight_state']['state'];

export function createBgsmOrganizeJobTraceCoordinator(input: Readonly<{
  executionEpochId: string;
  traceFactory?: OrganizeJobRunTraceFactory;
  now?: () => number;
}>): Readonly<{
  begin(jobId: OrganizeJobId): void;
  resume(jobId: OrganizeJobId): void;
  recordPreflight(input: Readonly<{
    jobId: OrganizeJobId;
    state: OrganizeJobRunPreflightTraceState;
    repositoryCount: number;
  }>): void;
  recordGeneration(jobId: OrganizeJobId, snapshot: OrganizeJobRunSnapshot, input: Readonly<{
    state: DevTraceEventDataByKind['organize_generation_state']['state'];
    cause: DevTraceEventDataByKind['organize_generation_state']['cause'];
    parentRunId: OrganizeJobRunSnapshot['runId'] | null;
    parentGeneration: number | null;
  }>): void;
  recordBatch(jobId: OrganizeJobId, input: DevTraceEventDataByKind['organize_batch_state']): void;
  recordProviderAttempt(jobId: OrganizeJobId, input: DevTraceEventDataByKind['organize_provider_attempt']): void;
  recordWatchdog(jobId: OrganizeJobId, input: DevTraceEventDataByKind['watchdog_state']): void;
  recordDurableState(jobId: OrganizeJobId, input: Readonly<{
    revision: number;
    source: DevTraceEventDataByKind['organize_durable_state']['source'];
  }>): void;
  recordReview(jobId: OrganizeJobId, input: DevTraceEventDataByKind['organize_review_state']): void;
  recordSelection(jobId: OrganizeJobId, input: DevTraceEventDataByKind['organize_selection_state']): void;
  recordApply(jobId: OrganizeJobId, input: DevTraceEventDataByKind['organize_apply_state']): void;
  recordApplyChunk(jobId: OrganizeJobId, input: DevTraceEventDataByKind['organize_apply_chunk']): void;
  recordReceipt(
    jobId: OrganizeJobId,
    input: DevTraceEventDataByKind['organize_receipt_state'],
    terminal?: Readonly<{
      state: 'completed' | 'failed';
      reasonCode: string;
    }>,
  ): void;
  completeNoChanges(jobId: OrganizeJobId): void;
  cancelFamily(
    jobId: OrganizeJobId,
    reasonCode: string,
    source: 'user' | 'port' | 'runtime' | 'scenario',
  ): void;
  recordRunTerminal(
    jobId: OrganizeJobId,
    state: 'completed' | 'cancelled' | 'failed' | 'interrupted',
    reason: string,
  ): void;
  failPreflight(jobId: OrganizeJobId): void;
  flush(jobId: OrganizeJobId): Promise<void>;
}> {
  const now = input.now ?? Date.now;
  const traces = new Map<OrganizeJobId, OrganizeJobRunTrace>();

  const ensure = (jobId: OrganizeJobId, resumeExisting: boolean): OrganizeJobRunTrace | null => {
    const existing = traces.get(jobId);
    if (existing) return existing;
    if (!input.traceFactory) return null;
    const trace = input.traceFactory({
      jobId,
      executionEpochId: input.executionEpochId,
      startedAt: now(),
      resumeExisting,
    });
    traces.set(jobId, trace);
    return trace;
  };

  const finishProvisional = (
    jobId: OrganizeJobId,
    trace: OrganizeJobRunTrace,
    state: Exclude<OrganizeJobRunPreflightTraceState, 'requested' | 'ready' | 'started'>,
  ): void => {
    if (state === 'no_work') {
      trace.finish('completed', 'no_work');
      void releaseTrace(jobId, trace);
      return;
    }
    if (state === 'worker_lost') {
      trace.finish('attempt_state_lost', 'worker_state_lost');
      void releaseTrace(jobId, trace);
      return;
    }
    const source = state === 'cancelled' ? 'user' : state === 'disconnected' ? 'port' : 'runtime';
    trace.recordCancellation(source);
    trace.finish('cancelled', `preflight_${state}`);
    void releaseTrace(jobId, trace);
  };

  const releaseTrace = async (jobId: OrganizeJobId, trace: OrganizeJobRunTrace): Promise<void> => {
    try {
      await trace.flush();
    } finally {
      if (traces.get(jobId) === trace) {
        traces.delete(jobId);
      }
    }
  };

  return {
    begin(jobId) {
      ensure(jobId, false)?.recordPreflight('requested', null);
    },

    resume(jobId) {
      ensure(jobId, true);
    },

    recordPreflight(event) {
      const trace = ensure(event.jobId, true);
      if (!trace) return;
      trace.recordPreflight(event.state, event.repositoryCount);
      if (!['requested', 'ready', 'started'].includes(event.state)) {
        finishProvisional(event.jobId, trace, event.state as Exclude<OrganizeJobRunPreflightTraceState, 'requested' | 'ready' | 'started'>);
      }
    },

    recordGeneration(jobId, snapshot, generation) {
      ensure(jobId, true)?.recordGeneration({
        runId: snapshot.runId,
        generation: snapshot.generation,
        ...generation,
        repositoryCount: snapshot.frozenScope.count,
      });
    },

    recordBatch(jobId, event) {
      ensure(jobId, true)?.recordBatch(event);
    },

    recordProviderAttempt(jobId, event) {
      ensure(jobId, true)?.recordProviderAttempt(event);
    },

    recordWatchdog(jobId, event) {
      ensure(jobId, true)?.recordWatchdog(event);
    },

    recordDurableState(jobId, event) {
      ensure(jobId, true)?.recordDurableState(event);
    },

    recordReview(jobId, event) {
      ensure(jobId, true)?.recordReview(event);
    },

    recordSelection(jobId, event) {
      ensure(jobId, true)?.recordSelection(event);
    },

    recordApply(jobId, event) {
      ensure(jobId, true)?.recordApply(event);
    },

    recordApplyChunk(jobId, event) {
      ensure(jobId, true)?.recordApplyChunk(event);
    },

    recordReceipt(jobId, event, terminal) {
      const trace = ensure(jobId, true);
      if (!trace) return;
      trace.recordReceipt(event);
      if (terminal) {
        trace.finish(terminal.state, terminal.reasonCode);
      }
      void releaseTrace(jobId, trace);
    },

    completeNoChanges(jobId) {
      const trace = ensure(jobId, true);
      if (!trace) return;
      trace.finish('completed', 'no_changes');
      void releaseTrace(jobId, trace);
    },

    cancelFamily(jobId, reasonCode, source) {
      const trace = ensure(jobId, true);
      if (!trace) return;
      trace.recordCancellation(source);
      trace.finish('cancelled', reasonCode);
      void releaseTrace(jobId, trace);
    },

    recordRunTerminal(jobId, state, reason) {
      if (state !== 'cancelled') return;
      const trace = ensure(jobId, true);
      if (!trace) return;
      trace.recordCancellation(reason === 'port_disconnected' ? 'port' : 'user');
      trace.finish('cancelled', reason);
      void releaseTrace(jobId, trace);
    },

    failPreflight(jobId) {
      const trace = ensure(jobId, true);
      if (!trace) return;
      trace.finish('failed', 'preflight_failed');
      void releaseTrace(jobId, trace);
    },

    async flush(jobId) {
      await traces.get(jobId)?.flush();
    },
  };
}

export function createDeferredBgsmOrganizeJobTraceFactory(
  factoryPromise: Promise<OrganizeJobRunTraceFactory>,
): OrganizeJobRunTraceFactory {
  return (start: OrganizeJobRunTraceStart) => {
    const target = factoryPromise.then((factory) => factory(start)).catch(() => null);
    const forward = (call: (trace: OrganizeJobRunTrace) => void): void => {
      void target.then((trace) => {
        if (trace) call(trace);
      }).catch(() => {
        // A deferred development observer cannot affect OrganizeJobRun.
      });
    };
    return {
      recordPreflight(state, repositoryCount) {
        forward((trace) => trace.recordPreflight(state, repositoryCount));
      },
      recordGeneration(generation) {
        forward((trace) => trace.recordGeneration(generation));
      },
      recordBatch(batch) {
        forward((trace) => trace.recordBatch(batch));
      },
      recordProviderAttempt(attempt) {
        forward((trace) => trace.recordProviderAttempt(attempt));
      },
      recordWatchdog(watchdog) {
        forward((trace) => trace.recordWatchdog(watchdog));
      },
      recordDurableState(event) {
        forward((trace) => trace.recordDurableState(event));
      },
      recordReview(event) {
        forward((trace) => trace.recordReview(event));
      },
      recordSelection(event) {
        forward((trace) => trace.recordSelection(event));
      },
      recordApply(event) {
        forward((trace) => trace.recordApply(event));
      },
      recordApplyChunk(event) {
        forward((trace) => trace.recordApplyChunk(event));
      },
      recordReceipt(event) {
        forward((trace) => trace.recordReceipt(event));
      },
      recordCancellation(source) {
        forward((trace) => trace.recordCancellation(source));
      },
      finish(state, reasonCode) {
        forward((trace) => trace.finish(state, reasonCode));
      },
      async flush() {
        await (await target)?.flush();
      },
    };
  };
}
