import type {
  BgsmAgentActiveProjection,
  BgsmAgentConversationBinding,
  BgsmAgentCompactionCheckpoint,
  BgsmAgentSessionMessage,
  BgsmAgentTurnInput,
} from '@/bgsm-agent';
import {
  validateBgsmAgentConversationBinding,
  validateBgsmAgentConversationCandidate,
  validateBgsmAgentSessionHistory,
  verifyBgsmAgentActiveProjections,
  verifyBgsmAgentCheckpoint,
} from '@/bgsm-agent';
import {
  AgentProviderError,
  type AgentErrorCategory,
  type AgentEvent,
  type ModelToolCall,
} from '@/agent-harness';
import type {
  BgsmAgentTurnAckDisposition,
  BgsmAgentTurnResult,
} from '@/utils/messaging';
import type {
  AgentTurnTrace,
  AgentTurnTraceFactory,
} from '@/agent-observability/agent-turn-types';
import {
  observeAgentContentCapture,
  type AgentContentCaptureSink,
  type AgentExecutionTraceSink,
} from '@/agent-harness';
import {
  AGENT_API_KEY_EMPTY,
  AGENT_BASE_URL_EMPTY,
  AGENT_BASE_URL_INVALID,
  AGENT_CONTEXT_CAPABILITY_REQUIRED,
  AGENT_CONTEXT_CAPABILITY_INFEASIBLE,
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_MODEL_EMPTY,
  AGENT_PROVIDER_IDENTITY_CHANGED,
  AGENT_PROVIDER_UNSUPPORTED,
} from '@/api/errors';

type AgentTurnPort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

type AgentTurnServerMessage =
  | { type: 'bgsmAgentTurnHello'; executionEpochId: string }
  | {
      type: 'bgsmAgentTurnAck';
      turnAttemptId: string;
      sessionId: string;
      baseRevision: number;
      disposition: BgsmAgentTurnAckDisposition;
      appliedRevision: number | null;
    }
  | { type: 'bgsmAgentTurnEvent'; sequence: number; event: Record<string, unknown> }
  | { type: 'bgsmAgentTurnResult'; sequence: number; result: BgsmAgentTurnResult }
  | {
      type: 'bgsmAgentTurnError';
      sequence: number;
      error: {
        turnAttemptId: string;
        sessionId: string;
        baseRevision: number;
        message: string;
        category: AgentErrorCategory;
      };
    };

type AgentTurnPublishedMessage =
  | { type: 'bgsmAgentTurnEvent'; event: Record<string, unknown> }
  | { type: 'bgsmAgentTurnResult'; result: BgsmAgentTurnResult }
  | {
      type: 'bgsmAgentTurnError';
      error: {
        turnAttemptId: string;
        sessionId: string;
        baseRevision: number;
        message: string;
        category: AgentErrorCategory;
      };
    };

type AgentTurnSequencedServerMessage = Extract<AgentTurnServerMessage, { sequence: number }>;

type AgentTurnAttempt = {
  input: BgsmAgentTurnInput;
  fingerprint: string;
  controller: AbortController;
  subscribers: Set<AgentTurnPort>;
  deliveries: AgentTurnSequencedServerMessage[];
  terminal: boolean;
  trace?: AgentTurnTrace;
  contentCapture?: AgentContentCaptureSink;
};

type AgentTurnPortTraceState = {
  connectionEpochId: string;
  lastDeliverySequence: number | null;
  attachedAttemptId: string | null;
  attachmentMode: 'attempt' | 'rejected' | null;
  attempt: AgentTurnAttempt | null;
  trace?: AgentTurnTrace;
  disconnected: boolean;
};

export type BgsmAgentTurnRegistry = Readonly<{
  executionEpochId: string;
  attach(port: AgentTurnPort): void;
}>;

export type BgsmAgentTurnRunner = (
  input: BgsmAgentTurnInput,
  options: Readonly<{
    signal: AbortSignal;
    emit(event: AgentEvent): void;
    bind(binding: BgsmAgentConversationBinding): void;
    trace?: AgentExecutionTraceSink;
    contentCapture?: AgentContentCaptureSink;
  }>,
) => Promise<BgsmAgentTurnResult>;

const RECENT_ATTEMPT_TOMBSTONE_LIMIT = 128;

export function createBgsmAgentTurnRegistry(
  dependencies: Readonly<{
    runTurn: BgsmAgentTurnRunner;
    translateError(error: unknown): Promise<string>;
    executionEpochId?: string;
    randomId?: () => string;
    traceFactory?: AgentTurnTraceFactory;
    contentCaptureFactory?: (input: Readonly<{
      rootOperationId: string;
      sessionId: string;
      turnAttemptId: string;
      baseRevision: number;
    }>) => AgentContentCaptureSink | undefined;
    now?: () => number;
  }>,
): BgsmAgentTurnRegistry {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.randomId ?? randomId;
  const executionEpochId = dependencies.executionEpochId
    ?? `bgsm_worker_${createId()}`;
  const attempts = new Map<string, AgentTurnAttempt>();
  const activeAttemptBySession = new Map<string, string>();
  const tombstones = new Map<string, true>();
  const acknowledgedTraceByAttempt = new Map<string, AgentTurnTrace>();
  const highestCompletedBaseRevision = new Map<string, number>();
  const connectionStateByPort = new WeakMap<AgentTurnPort, AgentTurnPortTraceState>();

  const disconnectPort = (port: AgentTurnPort) => {
    try {
      port.disconnect();
    } catch {
      // Delivery failure usually means Chrome already closed the Port.
    }
  };

  const markDisconnected = (port: AgentTurnPort, state: AgentTurnPortTraceState) => {
    if (state.disconnected) return;
    state.disconnected = true;
    state.attempt?.subscribers.delete(port);
    if (!state.trace || state.attachmentMode === null) return;
    observeTrace(() => state.trace?.recordDisconnect({
      connectionEpochId: state.connectionEpochId,
      lastDeliverySequence: state.lastDeliverySequence,
      attemptState: state.attachmentMode === 'rejected'
        ? 'rejected'
        : state.attempt?.terminal ? 'terminal' : 'active',
    }));
  };

  const postSequenced = (
    port: AgentTurnPort,
    delivery: AgentTurnSequencedServerMessage,
    trace: AgentTurnTrace | undefined,
    deliveryKind: 'live' | 'replay',
  ): boolean => {
    const state = connectionStateByPort.get(port);
    if (!safePost(port, delivery)) {
      if (state) markDisconnected(port, state);
      disconnectPort(port);
      return false;
    }
    if (state) state.lastDeliverySequence = delivery.sequence;
    observeTrace(() => trace?.recordDelivery({
      connectionEpochId: state?.connectionEpochId ?? executionEpochId,
      deliverySequence: delivery.sequence,
      deliveryKind,
    }));
    return true;
  };

  const publish = (attempt: AgentTurnAttempt, message: AgentTurnPublishedMessage) => {
    const delivery = {
      ...message,
      sequence: attempt.deliveries.length,
    } as AgentTurnSequencedServerMessage;
    attempt.deliveries.push(delivery);
    for (const subscriber of [...attempt.subscribers]) {
      if (!postSequenced(subscriber, delivery, attempt.trace, 'live')) {
        attempt.subscribers.delete(subscriber);
        continue;
      }
    }
  };

  const finishAttempt = (attempt: AgentTurnAttempt, result: BgsmAgentTurnResult) => {
    if (attempt.terminal) return;
    attempt.terminal = true;
    publish(attempt, {
      type: 'bgsmAgentTurnResult',
      result: {
        ...result,
        turnAttemptId: attempt.input.turnAttemptId,
        sessionId: attempt.input.sessionId,
        baseRevision: attempt.input.baseRevision,
      },
    });
    observeTrace(() => attempt.trace?.finish(
      result.reason === 'final_answer' ? 'completed'
        : result.reason === 'aborted' ? 'cancelled'
          : result.reason === 'attempt_state_lost' ? 'attempt_state_lost'
            : 'failed',
      result.contextFailureReason ?? result.reason,
    ));
    observeAgentContentCapture(attempt.contentCapture, (capture) => {
      capture.finish(result.contextFailureReason ?? result.reason);
    });
  };

  const failAttempt = async (attempt: AgentTurnAttempt, error: unknown) => {
    if (attempt.terminal) return;
    let message = 'BGSM Agent turn failed.';
    try {
      message = await dependencies.translateError(error);
    } catch {
      // Translation must not prevent the attempt from reaching a replayable terminal state.
    }
    if (attempt.terminal) return;
    attempt.terminal = true;
    publish(attempt, {
      type: 'bgsmAgentTurnError',
      error: {
        turnAttemptId: attempt.input.turnAttemptId,
        sessionId: attempt.input.sessionId,
        baseRevision: attempt.input.baseRevision,
        message,
        category: classifyTurnError(error),
      },
    });
    observeTrace(() => attempt.trace?.finish('failed', classifyTurnError(error)));
    observeAgentContentCapture(attempt.contentCapture, (capture) => {
      capture.finish(classifyTurnError(error));
    });
  };

  const createTrace = (
    input: BgsmAgentTurnInput,
    resumeExisting: boolean,
  ): AgentTurnTrace | undefined => {
    let trace: AgentTurnTrace | undefined;
    try {
      trace = dependencies.traceFactory?.({
        rootOperationId: `agent_turn:${input.turnAttemptId}`,
        sessionId: input.sessionId,
        turnAttemptId: input.turnAttemptId,
        baseRevision: input.baseRevision,
        executionEpochId,
        startedAt: now(),
        resumeExisting,
      });
    } catch {
      // Development tracing cannot prevent a turn from starting or being rejected.
    }
    return trace;
  };

  const start = (input: BgsmAgentTurnInput): AgentTurnAttempt => {
    const trace = createTrace(input, false);
    const rootOperationId = `agent_turn:${input.turnAttemptId}`;
    let contentCapture: AgentContentCaptureSink | undefined;
    try {
      contentCapture = dependencies.contentCaptureFactory?.({
        rootOperationId,
        sessionId: input.sessionId,
        turnAttemptId: input.turnAttemptId,
        baseRevision: input.baseRevision,
      });
    } catch {
      // Development content capture cannot prevent a turn from starting.
    }
    const attempt: AgentTurnAttempt = {
      input,
      fingerprint: turnLaunchFingerprint(input),
      controller: new AbortController(),
      subscribers: new Set(),
      deliveries: [],
      terminal: false,
      ...(trace ? { trace } : {}),
      ...(contentCapture ? { contentCapture } : {}),
    };
    attempts.set(input.turnAttemptId, attempt);
    activeAttemptBySession.set(input.sessionId, input.turnAttemptId);
    publish(attempt, {
      type: 'bgsmAgentTurnEvent',
      event: deliveryEvent(input, { type: 'agent_queued' }),
    });
    void dependencies.runTurn(input, {
      signal: attempt.controller.signal,
      trace: attempt.trace
        ? {
            emit: (event) => observeTrace(() => attempt.trace?.execution.emit(event)),
          }
        : undefined,
      contentCapture: attempt.contentCapture,
      emit: (event) => {
        if (!attempt.terminal) {
          observeTrace(() => attempt.trace?.recordAgentEvent(event));
          publish(attempt, {
            type: 'bgsmAgentTurnEvent',
            event: deliveryEvent(input, event),
          });
        }
      },
      bind: (binding) => {
        if (!attempt.terminal) {
          publish(attempt, {
            type: 'bgsmAgentTurnEvent',
            event: deliveryEvent(input, { type: 'conversation_bound', binding }),
          });
        }
      },
    }).then(
      (result) => finishAttempt(attempt, result),
      (error) => {
        if (isContextCapabilityFailure(error)) {
          finishAttempt(attempt, {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            reason: 'context_limit',
            contextFailureReason: 'capability_unresolved',
            changed: false,
            changedCount: 0,
            newMessages: [],
          });
          return;
        }
        void failAttempt(attempt, error);
      },
    );
    return attempt;
  };

  const rejectAttempt = (
    port: AgentTurnPort,
    input: BgsmAgentTurnInput,
    reason: Parameters<AgentTurnTrace['recordAttemptRejected']>[0],
    options: Readonly<{
      trace?: AgentTurnTrace;
      identityConflict?: boolean;
      reuseTraceOnly?: boolean;
      terminateTrace?: boolean;
    }> = {},
  ): AgentTurnTrace | undefined => {
    const trace = options.reuseTraceOnly
      ? options.trace
      : options.trace ?? createTrace(input, true);
    const connectionState = connectionStateByPort.get(port);
    if (connectionState) connectionState.trace = trace;
    observeTrace(() => trace?.recordAttemptRejected(reason));
    const delivery: AgentTurnSequencedServerMessage = options.identityConflict
      ? {
          type: 'bgsmAgentTurnError',
          sequence: 0,
          error: {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            message: 'BGSM Agent turnAttemptId was reused with conflicting launch data.',
            category: 'other',
          },
        }
      : {
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'attempt_state_lost',
        changed: false,
        changedCount: 0,
        newMessages: [],
      },
        };
    postSequenced(port, delivery, trace, 'live');
    if (!options.identityConflict && options.terminateTrace !== false) {
      observeTrace(() => trace?.finish('attempt_state_lost', 'attempt_state_lost'));
    }
    return trace;
  };

  const acknowledge = (
    port: AgentTurnPort,
    message: Record<string, unknown>,
    attemptId: string | null,
  ) => {
    if (!isAckMessage(message, executionEpochId) || message.turnAttemptId !== attemptId) return;
    const attempt = attempts.get(message.turnAttemptId);
    if (!attempt) {
      confirmAcknowledgement(port, message);
      return;
    }
    if (!attempt.terminal || !sameTurnIdentity(attempt.input, message)) return;
    attempts.delete(message.turnAttemptId);
    if (activeAttemptBySession.get(message.sessionId) === message.turnAttemptId) {
      activeAttemptBySession.delete(message.sessionId);
    }
    tombstones.delete(message.turnAttemptId);
    tombstones.set(message.turnAttemptId, true);
    observeTrace(() => attempt.trace?.recordAcknowledgement({
      disposition: message.disposition,
      appliedRevision: message.appliedRevision,
    }));
    if (attempt.trace) acknowledgedTraceByAttempt.set(message.turnAttemptId, attempt.trace);
    while (tombstones.size > RECENT_ATTEMPT_TOMBSTONE_LIMIT) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
      acknowledgedTraceByAttempt.delete(oldest);
    }
    if (message.disposition === 'applied') {
      highestCompletedBaseRevision.set(
        message.sessionId,
        Math.max(
          highestCompletedBaseRevision.get(message.sessionId) ?? -1,
          message.baseRevision,
        ),
      );
    }
    confirmAcknowledgement(port, message);
    for (const subscriber of attempt.subscribers) {
      if (subscriber === port) continue;
      try {
        subscriber.disconnect();
      } catch {
        // Subscriber may already be closed.
      }
    }
    attempt.subscribers.clear();
  };

  const registry: BgsmAgentTurnRegistry = {
    executionEpochId,
    attach(port) {
      const connectionEpochId = dependencies.traceFactory
        ? `bgsm_agent_connection_${createId()}`
        : executionEpochId;
      const connectionState: AgentTurnPortTraceState = {
        connectionEpochId,
        lastDeliverySequence: null,
        attachedAttemptId: null,
        attachmentMode: null,
        attempt: null,
        disconnected: false,
      };
      connectionStateByPort.set(port, connectionState);
      if (!safePost(port, { type: 'bgsmAgentTurnHello', executionEpochId })) {
        disconnectPort(port);
        return;
      }
      port.onDisconnect.addListener(() => {
        markDisconnected(port, connectionState);
      });
      port.onMessage.addListener((rawMessage: unknown) => {
        if (!isRecord(rawMessage)) return;
        if (rawMessage.type === 'ackBgsmAgentTurnResult') {
          if (
            connectionState.attachmentMode === 'rejected'
            && isAckMessage(rawMessage, executionEpochId)
            && rawMessage.turnAttemptId === connectionState.attachedAttemptId
          ) {
            confirmAcknowledgement(port, rawMessage);
          } else if (connectionState.attachmentMode === 'attempt') {
            acknowledge(port, rawMessage, connectionState.attachedAttemptId);
          }
          return;
        }
        if (rawMessage.type === 'stopBgsmAgentTurn') {
          if (!isStopMessage(rawMessage, executionEpochId)) return;
          const attempt = attempts.get(rawMessage.turnAttemptId as string);
          if (attempt && sameTurnIdentity(attempt.input, rawMessage)) {
            observeTrace(() => attempt.trace?.recordCancellation('user'));
            attempt.controller.abort();
          }
          return;
        }
        if (rawMessage.type !== 'startBgsmAgentTurn' || connectionState.attachedAttemptId) return;
        const parsed = parseStartMessage(rawMessage);
        if (!parsed) {
          port.disconnect();
          return;
        }
        if (rawMessage.executionEpochId !== executionEpochId) {
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'rejected';
          connectionState.trace = rejectAttempt(port, parsed, 'execution_epoch_mismatch');
          return;
        }
        const completedRevision = highestCompletedBaseRevision.get(parsed.sessionId);
        if (tombstones.has(parsed.turnAttemptId)) {
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'rejected';
          connectionState.trace = rejectAttempt(port, parsed, 'acknowledged_attempt', {
            trace: acknowledgedTraceByAttempt.get(parsed.turnAttemptId),
            reuseTraceOnly: true,
            terminateTrace: false,
          });
          return;
        }
        if (completedRevision !== undefined && parsed.baseRevision <= completedRevision) {
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'rejected';
          connectionState.trace = rejectAttempt(port, parsed, 'completed_revision');
          return;
        }
        let attempt = attempts.get(parsed.turnAttemptId);
        const activeAttemptId = activeAttemptBySession.get(parsed.sessionId);
        if (activeAttemptId && activeAttemptId !== parsed.turnAttemptId) {
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'rejected';
          connectionState.trace = rejectAttempt(port, parsed, 'active_session_conflict');
          return;
        }
        if (attempt && attempt.fingerprint !== turnLaunchFingerprint(parsed)) {
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'rejected';
          connectionState.attempt = attempt;
          connectionState.trace = rejectAttempt(port, parsed, 'identity_conflict', {
            trace: attempt.trace,
            identityConflict: true,
          });
          return;
        }
        attempt ??= start(parsed);
        connectionState.attachedAttemptId = parsed.turnAttemptId;
        connectionState.attachmentMode = 'attempt';
        connectionState.attempt = attempt;
        connectionState.trace = attempt.trace;
        attempt.subscribers.add(port);
        for (const delivery of attempt.deliveries) {
          if (!postSequenced(port, delivery, attempt.trace, 'replay')) {
            attempt.subscribers.delete(port);
            break;
          }
        }
      });
    },
  };
  return registry;
}

export function createDeferredBgsmAgentTurnTraceFactory(
  factoryPromise: Promise<AgentTurnTraceFactory>,
): AgentTurnTraceFactory {
  return (input) => {
    const target = factoryPromise.then((factory) => factory(input)).catch(() => null);
    const forward = (call: (trace: AgentTurnTrace) => void): void => {
      void target
        .then((trace) => {
          if (trace) call(trace);
        })
        .catch(() => {
          // A deferred development observer cannot affect its turn.
        });
    };
    return {
      execution: {
        emit(event) {
          forward((trace) => trace.execution.emit(event));
        },
      },
      recordAgentEvent(event) {
        forward((trace) => trace.recordAgentEvent(event));
      },
      recordDelivery(delivery) {
        forward((trace) => trace.recordDelivery(delivery));
      },
      recordAcknowledgement(acknowledgement) {
        forward((trace) => trace.recordAcknowledgement(acknowledgement));
      },
      recordCancellation(source) {
        forward((trace) => trace.recordCancellation(source));
      },
      recordAttemptRejected(reason) {
        forward((trace) => trace.recordAttemptRejected(reason));
      },
      recordDisconnect(disconnect) {
        forward((trace) => trace.recordDisconnect(disconnect));
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

function observeTrace(work: () => void): void {
  try {
    work();
  } catch {
    // Development observation cannot affect Port delivery or execution.
  }
}

function confirmAcknowledgement(
  port: AgentTurnPort,
  message: Readonly<{
    turnAttemptId: string;
    sessionId: string;
    baseRevision: number;
    disposition: BgsmAgentTurnAckDisposition;
    appliedRevision: number | null;
  }>,
): void {
  safePost(port, {
    type: 'bgsmAgentTurnAck',
    turnAttemptId: message.turnAttemptId,
    sessionId: message.sessionId,
    baseRevision: message.baseRevision,
    disposition: message.disposition,
    appliedRevision: message.appliedRevision,
  });
}

export function attachBgsmAgentTurnPort(
  port: AgentTurnPort,
  dependencies: BgsmAgentTurnRegistry | Readonly<{
    runTurn: BgsmAgentTurnRunner;
    translateError(error: unknown): Promise<string>;
  }>,
): void {
  const registry = 'attach' in dependencies
    ? dependencies
    : createBgsmAgentTurnRegistry(dependencies);
  registry.attach(port);
}

function safePost(port: AgentTurnPort, message: AgentTurnServerMessage): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function deliveryEvent(
  input: BgsmAgentTurnInput,
  event: AgentEvent | Readonly<{
    type: 'conversation_bound';
    binding: BgsmAgentConversationBinding;
  }> | Readonly<{ type: 'agent_queued' }>,
): Record<string, unknown> {
  return {
    ...event,
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
  };
}

function turnLaunchFingerprint(input: BgsmAgentTurnInput): string {
  return JSON.stringify({
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    prompt: input.prompt,
    history: input.history,
    checkpoint: input.checkpoint ?? null,
    candidateContract: input.candidateContract ?? null,
    binding: input.binding ?? null,
  });
}

function sameTurnIdentity(
  input: Pick<BgsmAgentTurnInput, 'turnAttemptId' | 'sessionId' | 'baseRevision'>,
  value: Record<string, unknown>,
): boolean {
  return value.turnAttemptId === input.turnAttemptId
    && value.sessionId === input.sessionId
    && value.baseRevision === input.baseRevision;
}

function isStopMessage(value: Record<string, unknown>, executionEpochId: string): boolean {
  return hasExactKeys(value, [
    'type',
    'executionEpochId',
    'turnAttemptId',
    'sessionId',
    'baseRevision',
  ])
    && value.executionEpochId === executionEpochId
    && isNonemptyString(value.turnAttemptId)
    && isNonemptyString(value.sessionId)
    && Number.isSafeInteger(value.baseRevision)
    && Number(value.baseRevision) >= 0;
}

function isAckMessage(value: Record<string, unknown>, executionEpochId: string): value is Record<string, unknown> & {
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
  disposition: BgsmAgentTurnAckDisposition;
  appliedRevision: number | null;
} {
  if (!hasExactKeys(value, [
    'type',
    'executionEpochId',
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'disposition',
    'appliedRevision',
  ])) return false;
  if (
    value.executionEpochId !== executionEpochId
    || !isNonemptyString(value.turnAttemptId)
    || !isNonemptyString(value.sessionId)
    || !Number.isSafeInteger(value.baseRevision)
    || Number(value.baseRevision) < 0
  ) return false;
  if (value.disposition !== 'applied') {
    return ['no_transition', 'transition_rejected', 'detached'].includes(String(value.disposition))
      && value.appliedRevision === null;
  }
  return value.disposition === 'applied'
    && Number.isSafeInteger(value.appliedRevision)
    && Number(value.appliedRevision) === Number(value.baseRevision) + 1;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isContextCapabilityFailure(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error);
  return code === AGENT_CONTEXT_CAPABILITY_REQUIRED ||
    code === AGENT_CONTEXT_CAPABILITY_INFEASIBLE;
}

function parseStartMessage(value: unknown): BgsmAgentTurnInput | null {
  if (!isRecord(value)) return null;
  const expectedKeys = [
    'type',
    'executionEpochId',
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'prompt',
    'history',
    ...(value.checkpoint === undefined ? [] : ['checkpoint']),
    ...(value.activeProjections === undefined ? [] : ['activeProjections']),
    ...(value.candidateContract === undefined ? [] : ['candidateContract']),
    ...(value.binding === undefined ? [] : ['binding']),
  ];
  if (
    value.type !== 'startBgsmAgentTurn'
    || !hasExactKeys(value, expectedKeys)
    || !isNonemptyString(value.executionEpochId)
    || !isNonemptyString(value.turnAttemptId)
    || !isNonemptyString(value.sessionId)
    || !Number.isSafeInteger(value.baseRevision)
    || Number(value.baseRevision) < 0
    || !isNonemptyString(value.prompt)
    || !Array.isArray(value.history)
    || !value.history.every(isSessionMessage)
    || (value.candidateContract === undefined) === (value.binding === undefined)
  ) return null;

  const history = value.history as BgsmAgentSessionMessage[];
  try {
    validateBgsmAgentSessionHistory(history);
    if (value.checkpoint !== undefined) {
      if (!isCheckpoint(value.checkpoint)) return null;
      verifyBgsmAgentCheckpoint(history, value.checkpoint);
    }
    if (value.activeProjections !== undefined) {
      if (
        !Array.isArray(value.activeProjections)
        || !value.activeProjections.every(isActiveProjection)
      ) return null;
      verifyBgsmAgentActiveProjections(
        history,
        value.activeProjections as BgsmAgentActiveProjection[],
        value.checkpoint,
      );
    }
    if (value.candidateContract !== undefined) {
      validateBgsmAgentConversationCandidate(value.candidateContract);
      if (
        Number(value.baseRevision) !== 0
        || history.length !== 0
        || value.checkpoint !== undefined
        || value.activeProjections !== undefined
      ) {
        return null;
      }
    }
    if (value.binding !== undefined) {
      validateBgsmAgentConversationBinding(value.binding);
    }
  } catch {
    return null;
  }

  return {
    turnAttemptId: value.turnAttemptId,
    sessionId: value.sessionId,
    baseRevision: Number(value.baseRevision),
    prompt: value.prompt,
    history,
    ...(value.checkpoint === undefined
      ? {}
      : { checkpoint: value.checkpoint as BgsmAgentCompactionCheckpoint }),
    ...(value.activeProjections === undefined
      ? {}
      : {
          activeProjections: (value.activeProjections as BgsmAgentActiveProjection[])
            .map((projection) => ({ ...projection })),
        }),
    ...(value.candidateContract === undefined
      ? {}
      : { candidateContract: value.candidateContract }),
    ...(value.binding === undefined
      ? {}
      : { binding: value.binding }),
  };
}

function isSessionMessage(value: unknown): value is BgsmAgentSessionMessage {
  if (!isRecord(value)
    || !isNonemptyString(value.id)
    || !['user', 'agent', 'tool'].includes(String(value.role))
    || typeof value.content !== 'string'
    || !Number.isFinite(value.createdAt)
  ) return false;

  const baseKeys = ['id', 'role', 'content', 'createdAt'];
  if (value.role === 'user') return hasExactKeys(value, baseKeys);
  if (value.role === 'agent') {
    if (value.toolCalls === undefined) return hasExactKeys(value, baseKeys);
    return hasExactKeys(value, [...baseKeys, 'toolCalls'])
      && Array.isArray(value.toolCalls)
      && value.toolCalls.every(isModelToolCall);
  }
  return hasExactKeys(value, [...baseKeys, 'toolCallId', 'toolName'])
    && isNonemptyString(value.toolCallId)
    && isNonemptyString(value.toolName);
}

function isModelToolCall(value: unknown): value is ModelToolCall {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'name', 'arguments'])
    && isNonemptyString(value.id)
    && isNonemptyString(value.name);
}

function isCheckpoint(value: unknown): value is BgsmAgentCompactionCheckpoint {
  return isRecord(value)
    && hasExactKeys(value, [
      'schemaVersion',
      'summary',
      'summarizedMessageCount',
      'summarizedThroughMessageId',
    ])
    && value.schemaVersion === 1
    && typeof value.summary === 'string'
    && Number.isSafeInteger(value.summarizedMessageCount)
    && Number(value.summarizedMessageCount) > 0
    && isNonemptyString(value.summarizedThroughMessageId);
}

function isActiveProjection(value: unknown): value is BgsmAgentActiveProjection {
  return isRecord(value)
    && hasExactKeys(value, [
      'schemaVersion',
      'currentUserMessageId',
      'summarizedThroughMessageId',
      'retainedSuffixFirstMessageId',
      'rawMessageCountAtCreation',
      'rawTailMessageIdAtCreation',
      'capabilityRevision',
      'policyRevision',
      'summary',
    ])
    && value.schemaVersion === 1
    && isNonemptyString(value.currentUserMessageId)
    && isNonemptyString(value.summarizedThroughMessageId)
    && (value.retainedSuffixFirstMessageId === null || isNonemptyString(value.retainedSuffixFirstMessageId))
    && Number.isSafeInteger(value.rawMessageCountAtCreation)
    && Number(value.rawMessageCountAtCreation) > 0
    && isNonemptyString(value.rawTailMessageIdAtCreation)
    && isNonemptyString(value.capabilityRevision)
    && isNonemptyString(value.policyRevision)
    && isNonemptyString(value.summary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function classifyTurnError(error: unknown): AgentErrorCategory {
  if (error instanceof AgentProviderError) {
    return error.status === 401 || error.status === 403 ? 'authentication' : 'provider';
  }
  const code = error instanceof Error ? error.message : String(error);
  if (code === AGENT_DATA_DISCLOSURE_REQUIRED) return 'disclosure';
  if (code === AGENT_HOST_PERMISSION_DENIED) return 'permission';
  if (
    code === AGENT_PROVIDER_IDENTITY_CHANGED ||
    code === AGENT_CONTEXT_CAPABILITY_REQUIRED ||
    code === AGENT_CONTEXT_CAPABILITY_INFEASIBLE
  ) return 'capability';
  if ([
    AGENT_API_KEY_EMPTY,
    AGENT_BASE_URL_EMPTY,
    AGENT_BASE_URL_INVALID,
    AGENT_MODEL_EMPTY,
    AGENT_PROVIDER_UNSUPPORTED,
  ].includes(code)) return 'configuration';
  return 'other';
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
