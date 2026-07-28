import type {
  AgentContextDiagnosticTrigger,
  AgentExecutionTraceEvent,
} from '@/agent-harness';
import type { DevTraceEventInput } from './event-builders';
import {
  createDevTraceRecorder,
  type DevTraceRecorder,
  type DevTraceRootContext,
} from './recorder';
import type {
  AgentTurnTrace,
  AgentTurnTraceFactory,
  AgentTurnTraceStart,
} from './agent-turn-types';

type ActiveReduction = {
  episode: number;
  providerStep: number | null;
  spanId: string;
  outcome: 'summary' | 'corrected_summary' | 'fallback' | 'failed' | 'cancelled';
};

export function createDevAgentTurnTraceFactory(input: Readonly<{
  recorder?: DevTraceRecorder;
  randomId?: () => string;
  observeExecutionEvent?: (input: Readonly<{
    rootOperationId: string;
    event: AgentExecutionTraceEvent;
  }>) => void;
}> = {}): AgentTurnTraceFactory {
  const recorder = input.recorder ?? createDevTraceRecorder();
  const randomId = input.randomId ?? defaultRandomId;
  return (start) => createAgentTurnTrace(
    recorder,
    start,
    randomId,
    input.observeExecutionEvent,
  );
}

function createAgentTurnTrace(
  recorder: DevTraceRecorder,
  start: AgentTurnTraceStart,
  randomId: () => string,
  observeExecutionEvent?: (input: Readonly<{
    rootOperationId: string;
    event: AgentExecutionTraceEvent;
  }>) => void,
): AgentTurnTrace {
  const rootPromise = recorder.startRoot({
    rootOperationId: start.rootOperationId,
    operationKind: 'agent_turn',
    sessionId: start.sessionId,
    executionEpochId: start.executionEpochId,
    attemptId: start.turnAttemptId,
    baseRevision: start.baseRevision,
    startedAt: start.startedAt,
    resumeExisting: start.resumeExisting,
  });
  const providerSpans = new Map<string, string>();
  const toolSpans = new Map<string, string>();
  const continuationSpans = new Map<number, string>();
  const openSpans = new Set<string>();
  let tail = Promise.resolve();
  let terminalScheduled = false;
  let cancellationRecorded = false;
  let currentPhase: string | null = 'started';
  let currentProviderStep: number | null = null;
  let reductionEpisode = 0;
  let pendingReductionTrigger: ReturnType<typeof reductionTrigger> = 'threshold';
  let activeReduction: ActiveReduction | null = null;

  const schedule = (
    work: (root: DevTraceRootContext) => Promise<void>,
    allowAfterTerminal = false,
  ): void => {
    if (terminalScheduled && !allowAfterTerminal) return;
    tail = tail.then(async () => work(await rootPromise)).catch(() => {
      // Recorder failures are observational and cannot escape into product work.
    });
  };

  const startSpan = async (
    root: DevTraceRootContext,
    spanId: string,
    spanKind: string,
  ): Promise<void> => {
    if (openSpans.has(spanId)) return;
    openSpans.add(spanId);
    await recorder.startSpan(root, {
      spanId,
      parentSpanId: root.rootSpanId,
      spanKind,
    });
  };

  const emit = async (
    root: DevTraceRootContext,
    spanId: string,
    event: DevTraceEventInput,
  ): Promise<void> => {
    await recorder.emit(
      root,
      spanId,
      spanId === root.rootSpanId ? null : root.rootSpanId,
      event,
    );
  };

  const closeSpan = async (spanId: string): Promise<void> => {
    if (!openSpans.delete(spanId)) return;
    await recorder.finishSpan(spanId);
  };

  const phase = (nextPhase: string): void => {
    const previousPhase = currentPhase;
    currentPhase = nextPhase;
    schedule((root) => emit(root, root.rootSpanId, {
      kind: 'phase_changed',
      data: { phase: nextPhase, previousPhase },
    }));
  };

  const beginReduction = (): void => {
    if (activeReduction) return;
    const episode = ++reductionEpisode;
    const spanId = `${start.rootOperationId}:reduction:${randomId()}`;
    const providerStep = currentProviderStep;
    activeReduction = { episode, providerStep, spanId, outcome: 'summary' };
    schedule(async (root) => {
      await startSpan(root, spanId, 'context_reduction');
      await emit(root, spanId, {
        kind: 'context_reduction_started',
        data: {
          providerStep,
          episode,
          trigger: pendingReductionTrigger,
          splitActiveTurn: null,
        },
      });
    });
  };

  const finishReduction = (outcome?: ActiveReduction['outcome']): void => {
    const reduction = activeReduction;
    if (!reduction) return;
    activeReduction = null;
    schedule(async (root) => {
      await emit(root, reduction.spanId, {
        kind: 'context_reduction_finished',
        data: {
          providerStep: reduction.providerStep,
          episode: reduction.episode,
          outcome: outcome ?? reduction.outcome,
          projectedTokens: null,
          projectedBytes: null,
        },
      });
      await closeSpan(reduction.spanId);
    });
  };

  const trace: AgentTurnTrace = {
    execution: {
      emit(event) {
        try {
          observeExecutionEvent?.({ rootOperationId: start.rootOperationId, event });
        } catch {
          // Development observation cannot change Agent execution.
        }
        const reductionSpanId = activeReduction?.spanId ?? null;
        schedule(async (root) => recordExecutionEvent(
          recorder,
          root,
          event,
          providerSpans,
          toolSpans,
          continuationSpans,
          openSpans,
          randomId,
          reductionSpanId,
        ));
      },
    },

    recordAgentEvent(event) {
      switch (event.type) {
        case 'agent_start':
          phase('agent_started');
          break;
        case 'turn_start':
          currentProviderStep = event.step;
          phase(`provider_step_${event.step}`);
          break;
        case 'approval_required':
          phase('awaiting_approval');
          break;
        case 'context_compaction_start':
          phase('context_reduction');
          beginReduction();
          break;
        case 'context_compaction_end':
          break;
        case 'context_diagnostic':
          if (event.action === 'triggered' && event.trigger) {
            pendingReductionTrigger = reductionTrigger(event.trigger);
            beginReduction();
          } else if (event.action === 'summary_retry' && activeReduction) {
            activeReduction.outcome = 'corrected_summary';
          } else if (event.action === 'fallback' && activeReduction) {
            activeReduction.outcome = 'fallback';
          } else if (event.action === 'terminal') {
            finishReduction(event.category === 'succeeded' ? undefined : 'failed');
          }
          break;
        case 'agent_done':
          phase('settling_result');
          break;
        case 'assistant_stream_start':
        case 'assistant_text_delta':
        case 'message_update':
        case 'tool_execution_queued':
        case 'tool_execution_start':
        case 'tool_execution_end':
        case 'agent_error':
          break;
      }
    },

    recordDelivery(delivery) {
      schedule((root) => emit(root, root.rootSpanId, {
        kind: 'delivery_state',
        data: {
          ...delivery,
          durableRevision: null,
        },
      }), true);
    },

    recordCancellation(source) {
      if (cancellationRecorded) return;
      cancellationRecorded = true;
      schedule((root) => emit(root, root.rootSpanId, {
        kind: 'root_cancelled',
        data: { source },
      }));
    },

    recordAttemptRejected(reason) {
      schedule((root) => emit(root, root.rootSpanId, {
        kind: 'attempt_rejected',
        data: { reason },
      }), true);
    },

    recordDisconnect(disconnect) {
      schedule((root) => emit(root, root.rootSpanId, {
        kind: 'port_disconnected',
        data: disconnect,
      }), true);
    },

    finish(state, reasonCode) {
      if (terminalScheduled) return;
      finishReduction(
        state === 'cancelled'
          ? 'cancelled'
          : state === 'completed' ? undefined : 'failed',
      );
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

  return trace;
}

async function recordExecutionEvent(
  recorder: DevTraceRecorder,
  root: DevTraceRootContext,
  event: AgentExecutionTraceEvent,
  providerSpans: Map<string, string>,
  toolSpans: Map<string, string>,
  continuationSpans: Map<number, string>,
  openSpans: Set<string>,
  randomId: () => string,
  reductionSpanId: string | null,
): Promise<void> {
  const span = spanForExecutionEvent(
    root,
    event,
    providerSpans,
    toolSpans,
    continuationSpans,
    randomId,
    reductionSpanId,
  );
  if (span.id !== root.rootSpanId && !openSpans.has(span.id)) {
    openSpans.add(span.id);
    await recorder.startSpan(root, {
      spanId: span.id,
      parentSpanId: span.parentSpanId,
      spanKind: span.kind,
    });
  }
  await recorder.emit(root, span.id, span.parentSpanId, executionEventInput(event));
  if (isExecutionSpanTerminal(event)) {
    openSpans.delete(span.id);
    await recorder.finishSpan(span.id);
  }
}

function spanForExecutionEvent(
  root: DevTraceRootContext,
  event: AgentExecutionTraceEvent,
  providerSpans: Map<string, string>,
  toolSpans: Map<string, string>,
  continuationSpans: Map<number, string>,
  randomId: () => string,
  reductionSpanId: string | null,
): { id: string; kind: string; parentSpanId: string | null } {
  if ('requestId' in event) {
    return {
      id: getOrCreate(providerSpans, event.requestId, () => `${root.rootOperationId}:provider:${randomId()}`),
      kind: 'provider_request',
      parentSpanId: event.requestKind === 'turn' || !reductionSpanId
        ? root.rootSpanId
        : reductionSpanId,
    };
  }
  if ('toolCallId' in event) {
    return {
      id: getOrCreate(toolSpans, event.toolCallId, () => `${root.rootOperationId}:tool:${randomId()}`),
      kind: 'tool_execution',
      parentSpanId: root.rootSpanId,
    };
  }
  if (event.kind === 'continuation_started' || event.kind === 'continuation_finished') {
    return {
      id: getOrCreate(
        continuationSpans,
        event.episode,
        () => `${root.rootOperationId}:continuation:${randomId()}`,
      ),
      kind: 'continuation',
      parentSpanId: root.rootSpanId,
    };
  }
  return { id: root.rootSpanId, kind: 'root', parentSpanId: null };
}

function executionEventInput(event: AgentExecutionTraceEvent): DevTraceEventInput {
  switch (event.kind) {
    case 'provider_request_prepared':
      return {
        kind: event.kind,
        data: {
          requestId: event.requestId,
          requestKind: event.requestKind,
          providerStep: event.providerStep,
          requestAttempt: event.requestAttempt,
          providerClass: event.providerClass,
          protocol: event.protocol,
          modelCapabilityRevision: event.modelCapabilityRevision,
          requestBytes: event.requestBytes,
          historyBytes: event.historyBytes,
          estimatedInputTokens: event.estimatedInputTokens,
          maxOutputTokens: event.maxOutputTokens,
        },
      };
    case 'provider_response_started':
      return {
        kind: event.kind,
        data: {
          requestId: event.requestId,
          requestKind: event.requestKind,
          providerStep: event.providerStep,
          requestAttempt: event.requestAttempt,
          latencyMs: event.latencyMs,
        },
      };
    case 'provider_stream_item':
      return {
        kind: event.kind,
        data: {
          requestId: event.requestId,
          requestKind: event.requestKind,
          providerStep: event.providerStep,
          requestAttempt: event.requestAttempt,
          streamClass: event.streamClass,
          utf8Bytes: event.utf8Bytes,
        },
      };
    case 'provider_usage':
      return {
        kind: event.kind,
        data: {
          requestId: event.requestId,
          requestKind: event.requestKind,
          providerStep: event.providerStep,
          requestAttempt: event.requestAttempt,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          source: event.source,
        },
      };
    case 'provider_finished':
      return {
        kind: event.kind,
        data: {
          requestId: event.requestId,
          requestKind: event.requestKind,
          providerStep: event.providerStep,
          requestAttempt: event.requestAttempt,
          finishReason: event.finishReason,
          durationMs: event.durationMs,
        },
      };
    case 'provider_error':
      return {
        kind: event.kind,
        data: {
          requestId: event.requestId,
          requestKind: event.requestKind,
          providerStep: event.providerStep,
          requestAttempt: event.requestAttempt,
          code: event.code,
          status: event.status,
          retryable: event.retryable,
          overflow: event.overflow,
        },
      };
    case 'tool_queued':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          toolName: event.toolName,
          toolClass: event.toolClass,
          risk: event.risk,
          toolCallId: event.toolCallId,
        },
      };
    case 'tool_authorized':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          decision: event.decision,
        },
      };
    case 'tool_started':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          attempt: event.attempt,
        },
      };
    case 'tool_result_admitted':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          originalBytes: event.originalBytes,
          admittedBytes: event.admittedBytes,
          reduction: event.reduction,
        },
      };
    case 'tool_completed':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          outcome: event.outcome,
          durationMs: event.durationMs,
        },
      };
    case 'tool_write_outcome':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          effectCount: event.effectCount,
          state: event.state,
        },
      };
    case 'context_preflight':
      return {
        kind: event.kind,
        data: {
          requestId: event.requestId,
          requestKind: event.requestKind,
          providerStep: event.providerStep,
          requestAttempt: event.requestAttempt,
          workingWindowTokens: event.workingWindowTokens,
          reserveTokens: event.reserveTokens,
          estimatedInputTokens: event.estimatedInputTokens,
          requestBytes: event.requestBytes,
          historyBytes: event.historyBytes,
          decision: event.decision,
          reasonCode: event.reasonCode,
        },
      };
    case 'continuation_started':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          episode: event.episode,
          attempt: event.attempt,
          reason: event.reason,
        },
      };
    case 'continuation_finished':
      return {
        kind: event.kind,
        data: {
          providerStep: event.providerStep,
          episode: event.episode,
          attempt: event.attempt,
          outcome: event.outcome,
        },
      };
    case 'watchdog_state':
      return {
        kind: event.kind,
        data: {
          watchdog: event.watchdog,
          state: event.state,
          limitMs: event.limitMs,
        },
      };
  }
}

function isExecutionSpanTerminal(event: AgentExecutionTraceEvent): boolean {
  return event.kind === 'provider_finished'
    || event.kind === 'provider_error'
    || event.kind === 'tool_completed'
    || event.kind === 'continuation_finished';
}

function reductionTrigger(
  trigger: AgentContextDiagnosticTrigger,
): 'threshold' | 'provider_overflow' | 'history_bytes' | 'request_bytes' {
  if (trigger === 'provider_context_overflow') return 'provider_overflow';
  if (
    trigger === 'pre_turn_byte_limit'
    || trigger === 'completed_tool_envelope_byte_limit'
    || trigger === 'provider_request_byte_limit'
  ) return 'request_bytes';
  return 'threshold';
}

function getOrCreate<Key>(
  map: Map<Key, string>,
  key: Key,
  create: () => string,
): string {
  const existing = map.get(key);
  if (existing) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function defaultRandomId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
