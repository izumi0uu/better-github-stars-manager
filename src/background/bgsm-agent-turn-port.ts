import type {
  BgsmAgentConversationBinding,
} from '@/bgsm-agent';
import {
  AgentProviderError,
  type AgentErrorCategory,
  type AgentEvent,
} from '@/agent-harness';
import {
  type BgsmAgentTurnAckDisposition,
  type BgsmAgentTurnLaunch,
  type BgsmAgentTurnResult,
} from '@/utils/messaging';
import {
  assertAgentSessionTransportPayloadSize,
  assertAgentTurnTransportIdentifier,
  normalizeAgentTurnErrorCode,
  validateAgentSessionLaunchIdentity,
  type AgentActiveTurnTransport,
  type AgentTurnErrorCode,
} from '@/bgsm-agent/session-transport';
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

type AgentTurnErrorDelivery = {
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
  message: string;
  category: AgentErrorCategory;
  code?: AgentTurnErrorCode;
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
      error: AgentTurnErrorDelivery;
    };

type AgentTurnPublishedMessage =
  | { type: 'bgsmAgentTurnEvent'; event: Record<string, unknown> }
  | { type: 'bgsmAgentTurnResult'; result: BgsmAgentTurnResult }
  | {
      type: 'bgsmAgentTurnError';
      error: AgentTurnErrorDelivery;
    };

type AgentTurnSequencedServerMessage = Extract<AgentTurnServerMessage, { sequence: number }>;

type AgentTurnAttempt = {
  input: BgsmAgentTurnLaunch;
  fingerprint: string;
  controller: AbortController;
  subscribers: Set<AgentTurnPort>;
  deliveries: AgentTurnSequencedServerMessage[];
  terminal: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  finalization: Promise<boolean> | null;
  acknowledgementRecorded: boolean;
  trace?: AgentTurnTrace;
  contentCapture?: AgentContentCaptureSink;
};

type AgentTurnPortTraceState = {
  connectionEpochId: string;
  lastDeliverySequence: number | null;
  attachedAttemptId: string | null;
  attachmentMode: 'attempt' | 'rejected' | null;
  pendingLaunch: BgsmAgentTurnLaunch | null;
  stopRequested: boolean;
  attempt: AgentTurnAttempt | null;
  trace?: AgentTurnTrace;
  disconnected: boolean;
};

export type BgsmAgentTurnRegistry = Readonly<{
  executionEpochId: string;
  inspectActiveTurn(sessionId: string): AgentActiveTurnTransport | null;
  attach(port: AgentTurnPort): void;
}>;

export type BgsmAgentTurnRunner = (
  input: BgsmAgentTurnLaunch,
  options: Readonly<{
    signal: AbortSignal;
    emit(event: AgentEvent): void;
    bind(binding: BgsmAgentConversationBinding): void;
    trace?: AgentExecutionTraceSink;
    contentCapture?: AgentContentCaptureSink;
  }>,
) => Promise<BgsmAgentTurnResult>;

const RECENT_ATTEMPT_TOMBSTONE_LIMIT = 128;
const TERMINAL_ATTEMPT_ACK_GRACE_MS = 5_000;

export function createBgsmAgentTurnRegistry(
  dependencies: Readonly<{
    runTurn: BgsmAgentTurnRunner;
    translateError(error: unknown): Promise<string>;
    executionEpochId?: string;
    randomId?: () => string;
    traceFactory?: AgentTurnTraceFactory;
    releaseTurnLease?: (input: Readonly<{
      sessionId: string;
      turnAttemptId: string;
      executionEpochId: string;
    }>) => Promise<unknown> | unknown;
    contentCaptureFactory?: (input: Readonly<{
      rootOperationId: string;
      sessionId: string;
      turnAttemptId: string;
      baseRevision: number;
    }>) => AgentContentCaptureSink | undefined;
    now?: () => number;
    terminalAttemptAckGraceMs?: number;
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
  const terminalAttemptAckGraceMs = dependencies.terminalAttemptAckGraceMs
    ?? TERMINAL_ATTEMPT_ACK_GRACE_MS;

  const rememberFinalizedAttempt = (attempt: AgentTurnAttempt) => {
    tombstones.delete(attempt.input.turnAttemptId);
    tombstones.set(attempt.input.turnAttemptId, true);
    if (attempt.trace) acknowledgedTraceByAttempt.set(attempt.input.turnAttemptId, attempt.trace);
    while (tombstones.size > RECENT_ATTEMPT_TOMBSTONE_LIMIT) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
      acknowledgedTraceByAttempt.delete(oldest);
    }
  };

  const finalizeAttempt = (attempt: AgentTurnAttempt): Promise<boolean> => {
    if (attempt.finalization) return attempt.finalization;
    if (attempt.cleanupTimer !== null) {
      clearTimeout(attempt.cleanupTimer);
      attempt.cleanupTimer = null;
    }
    const finalization = Promise.resolve()
      .then(() => dependencies.releaseTurnLease?.({
        sessionId: attempt.input.sessionId,
        turnAttemptId: attempt.input.turnAttemptId,
        executionEpochId,
      }))
      .then(() => {
        if (attempts.get(attempt.input.turnAttemptId) === attempt) {
          attempts.delete(attempt.input.turnAttemptId);
        }
        if (
          activeAttemptBySession.get(attempt.input.sessionId)
          === attempt.input.turnAttemptId
        ) {
          activeAttemptBySession.delete(attempt.input.sessionId);
        }
        rememberFinalizedAttempt(attempt);
        return true;
      })
      .catch(() => false)
      .then((released) => {
        if (!released && attempt.finalization === finalization) {
          attempt.finalization = null;
          scheduleOrphanCleanup(attempt);
        }
        return released;
      });
    attempt.finalization = finalization;
    return finalization;
  };

  const scheduleOrphanCleanup = (attempt: AgentTurnAttempt) => {
    if (
      !attempt.terminal
      || attempt.subscribers.size > 0
      || attempt.cleanupTimer !== null
      || attempt.finalization
    ) return;
    attempt.cleanupTimer = setTimeout(() => {
      attempt.cleanupTimer = null;
      if (attempt.subscribers.size === 0) void finalizeAttempt(attempt);
    }, terminalAttemptAckGraceMs);
  };

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
    if (state.attempt) scheduleOrphanCleanup(state.attempt);
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
    assertAgentSessionTransportPayloadSize(delivery, 'Agent turn delivery');
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
    try {
      assertAgentSessionTransportPayloadSize({
        type: 'bgsmAgentTurnResult',
        sequence: attempt.deliveries.length,
        result,
      }, 'Agent turn result delivery');
    } catch (error) {
      void failAttempt(attempt, error);
      return;
    }
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
    scheduleOrphanCleanup(attempt);
  };

  const failAttempt = async (attempt: AgentTurnAttempt, error: unknown) => {
    if (attempt.terminal) return;
    let message = 'Cubby turn failed.';
    try {
      message = await dependencies.translateError(error);
    } catch {
      // Translation must not prevent the attempt from reaching a replayable terminal state.
    }
    if (attempt.terminal) return;
    const failureCode = normalizeAgentTurnErrorCode(error);
    attempt.terminal = true;
    publish(attempt, {
      type: 'bgsmAgentTurnError',
      error: {
        turnAttemptId: attempt.input.turnAttemptId,
        sessionId: attempt.input.sessionId,
        baseRevision: attempt.input.baseRevision,
        message,
        category: classifyTurnError(error),
        ...(failureCode ? { code: failureCode } : {}),
      },
    });
    observeTrace(() => attempt.trace?.finish('failed', classifyTurnError(error)));
    observeAgentContentCapture(attempt.contentCapture, (capture) => {
      capture.finish(classifyTurnError(error));
    });
    scheduleOrphanCleanup(attempt);
  };

  const createTrace = (
    input: BgsmAgentTurnLaunch,
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

  const createAttempt = (input: BgsmAgentTurnLaunch): AgentTurnAttempt => {
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
      cleanupTimer: null,
      finalization: null,
      acknowledgementRecorded: false,
      ...(trace ? { trace } : {}),
      ...(contentCapture ? { contentCapture } : {}),
    };
    attempts.set(input.turnAttemptId, attempt);
    activeAttemptBySession.set(input.sessionId, input.turnAttemptId);
    return attempt;
  };

  const start = (input: BgsmAgentTurnLaunch): AgentTurnAttempt => {
    const attempt = createAttempt(input);
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
            commit: null,
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
    input: BgsmAgentTurnLaunch,
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
    if (connectionState) {
      connectionState.pendingLaunch = null;
      connectionState.trace = trace;
    }
    observeTrace(() => trace?.recordAttemptRejected(reason));
    const delivery: AgentTurnSequencedServerMessage = options.identityConflict
      ? {
          type: 'bgsmAgentTurnError',
          sequence: 0,
          error: {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            message: 'Cubby turnAttemptId was reused with conflicting launch data.',
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
        commit: null,
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
    if (!attempt.acknowledgementRecorded) {
      attempt.acknowledgementRecorded = true;
      observeTrace(() => attempt.trace?.recordAcknowledgement({
        disposition: message.disposition,
        appliedRevision: message.appliedRevision,
      }));
      if (message.disposition === 'applied') {
        highestCompletedBaseRevision.set(
          message.sessionId,
          Math.max(
            highestCompletedBaseRevision.get(message.sessionId) ?? -1,
            message.baseRevision,
          ),
        );
      }
      // The ACK is a transport confirmation, while releasing the durable turn
      // lease is asynchronous cleanup. Remember the attempt before confirming
      // so an immediate reconnect cannot replay an acknowledged result.
      rememberFinalizedAttempt(attempt);
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
    void finalizeAttempt(attempt);
  };

  const registry: BgsmAgentTurnRegistry = {
    executionEpochId,
    inspectActiveTurn(sessionId) {
      const attemptId = activeAttemptBySession.get(sessionId);
      const attempt = attemptId ? attempts.get(attemptId) : undefined;
      if (
        !attempt
        || attempt.finalization
        || attempt.acknowledgementRecorded
        || tombstones.has(attempt.input.turnAttemptId)
      ) return null;
      return {
        executionEpochId,
        launch: structuredClone(attempt.input),
      };
    },
    attach(port) {
      const connectionEpochId = dependencies.traceFactory
        ? `bgsm_agent_connection_${createId()}`
        : executionEpochId;
      const connectionState: AgentTurnPortTraceState = {
        connectionEpochId,
        lastDeliverySequence: null,
        attachedAttemptId: null,
        attachmentMode: null,
        pendingLaunch: null,
        stopRequested: false,
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
            observeTrace(() => connectionState.trace?.recordAcknowledgement({
              disposition: rawMessage.disposition,
              appliedRevision: rawMessage.appliedRevision,
            }));
            confirmAcknowledgement(port, rawMessage);
          } else if (connectionState.attachmentMode === 'attempt') {
            acknowledge(port, rawMessage, connectionState.attachedAttemptId);
          }
          return;
        }
        if (rawMessage.type === 'stopBgsmAgentTurn') {
          if (!isStopMessage(rawMessage, executionEpochId)) return;
          if (
            connectionState.pendingLaunch
            && sameTurnIdentity(connectionState.pendingLaunch, rawMessage)
          ) {
            connectionState.stopRequested = true;
          }
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
        if (rawMessage.resumeOnly === true) {
          const attempt = attempts.get(parsed.turnAttemptId);
          if (
            !attempt
            || attempt.finalization
            || attempt.acknowledgementRecorded
            || tombstones.has(parsed.turnAttemptId)
            || activeAttemptBySession.get(parsed.sessionId) !== parsed.turnAttemptId
            || attempt.fingerprint !== turnLaunchFingerprint(parsed)
          ) {
            connectionState.attachedAttemptId = parsed.turnAttemptId;
            connectionState.attachmentMode = 'rejected';
            connectionState.trace = rejectAttempt(port, parsed, 'active_session_conflict');
            return;
          }
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'attempt';
          connectionState.attempt = attempt;
          connectionState.trace = attempt.trace;
          attempt.subscribers.add(port);
          if (attempt.cleanupTimer !== null) {
            clearTimeout(attempt.cleanupTimer);
            attempt.cleanupTimer = null;
          }
          for (const delivery of attempt.deliveries) {
            if (!postSequenced(port, delivery, attempt.trace, 'replay')) {
              attempt.subscribers.delete(port);
              break;
            }
          }
          return;
        }
        // Admission can await terminal lease cleanup. Claim the connection now
        // so a second start message cannot open another admission path meanwhile.
        connectionState.attachedAttemptId = parsed.turnAttemptId;
        connectionState.pendingLaunch = parsed;
        const admit = async () => {
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
            const activeAttempt = attempts.get(activeAttemptId);
            if (
              activeAttempt?.terminal
              && (activeAttempt.finalization || activeAttempt.subscribers.size === 0)
            ) {
              const released = await finalizeAttempt(activeAttempt);
              if (!released) {
                connectionState.attachedAttemptId = parsed.turnAttemptId;
                connectionState.attachmentMode = 'rejected';
                connectionState.trace = rejectAttempt(port, parsed, 'active_session_conflict');
                return;
              }
            } else {
              connectionState.attachedAttemptId = parsed.turnAttemptId;
              connectionState.attachmentMode = 'rejected';
              connectionState.trace = rejectAttempt(port, parsed, 'active_session_conflict');
              return;
            }
          }
          if (connectionState.disconnected && !connectionState.stopRequested) {
            connectionState.pendingLaunch = null;
            return;
          }
          const admittedAttemptId = activeAttemptBySession.get(parsed.sessionId);
          if (admittedAttemptId && admittedAttemptId !== parsed.turnAttemptId) {
            connectionState.attachedAttemptId = parsed.turnAttemptId;
            connectionState.attachmentMode = 'rejected';
            connectionState.trace = rejectAttempt(port, parsed, 'active_session_conflict');
            return;
          }
          // Admission may have awaited another attempt's lease cleanup. A peer
          // can claim this exact attempt ID while that await is pending, so the
          // pre-await lookup is no longer authoritative here.
          attempt = attempts.get(parsed.turnAttemptId);
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
          if (!attempt && connectionState.stopRequested) {
            attempt = createAttempt(parsed);
            finishAttempt(attempt, {
              turnAttemptId: parsed.turnAttemptId,
              sessionId: parsed.sessionId,
              baseRevision: parsed.baseRevision,
              reason: 'aborted',
              changed: false,
              changedCount: 0,
              commit: null,
            });
          } else {
            attempt ??= start(parsed);
            if (connectionState.stopRequested && !attempt.terminal) {
              const runningAttempt = attempt;
              observeTrace(() => runningAttempt.trace?.recordCancellation('user'));
              runningAttempt.controller.abort();
            }
          }
          connectionState.pendingLaunch = null;
          if (connectionState.disconnected) return;
          connectionState.attachmentMode = 'attempt';
          connectionState.attempt = attempt;
          connectionState.trace = attempt.trace;
          attempt.subscribers.add(port);
          if (attempt.cleanupTimer !== null) {
            clearTimeout(attempt.cleanupTimer);
            attempt.cleanupTimer = null;
          }
          for (const delivery of attempt.deliveries) {
            if (!postSequenced(port, delivery, attempt.trace, 'replay')) {
              attempt.subscribers.delete(port);
              break;
            }
          }
        };
        void admit();
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
  input: BgsmAgentTurnLaunch,
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

function turnLaunchFingerprint(input: BgsmAgentTurnLaunch): string {
  return JSON.stringify({
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    prompt: input.prompt,
    candidateContract: input.candidateContract ?? null,
  });
}

function sameTurnIdentity(
  input: Pick<BgsmAgentTurnLaunch, 'turnAttemptId' | 'sessionId' | 'baseRevision'>,
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
    && hasBoundedTurnControlIdentity(value, 'Agent turn stop delivery')
    && value.executionEpochId === executionEpochId;
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
    !hasBoundedTurnControlIdentity(value, 'Agent turn acknowledgement delivery')
    || value.executionEpochId !== executionEpochId
  ) return false;
  if (value.disposition !== 'applied') {
    return ['no_transition', 'transition_rejected', 'detached'].includes(String(value.disposition))
      && value.appliedRevision === null;
  }
  return value.disposition === 'applied'
    && Number.isSafeInteger(value.appliedRevision)
    && Number(value.appliedRevision) === Number(value.baseRevision) + 1;
}

function hasBoundedTurnControlIdentity(
  value: Record<string, unknown>,
  label: string,
): value is Record<string, unknown> & {
  executionEpochId: string;
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
} {
  try {
    assertAgentTurnTransportIdentifier(value.executionEpochId, 'Agent execution epoch ID');
    assertAgentTurnTransportIdentifier(value.turnAttemptId, 'Agent turn attempt ID');
    assertAgentTurnTransportIdentifier(value.sessionId, 'Agent session ID');
    assertAgentSessionTransportPayloadSize(value, label);
  } catch {
    return false;
  }
  return Number.isSafeInteger(value.baseRevision) && Number(value.baseRevision) >= 0;
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

function parseStartMessage(value: unknown): BgsmAgentTurnLaunch | null {
  if (!isRecord(value)) return null;
  const expectedKeys = [
    'type',
    'executionEpochId',
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'prompt',
    ...(value.retrySourceAttemptId === undefined ? [] : ['retrySourceAttemptId']),
    ...(value.candidateContract === undefined ? [] : ['candidateContract']),
    ...(value.resumeOnly === undefined ? [] : ['resumeOnly']),
  ];
  if (
    value.type !== 'startBgsmAgentTurn'
    || !hasExactKeys(value, expectedKeys)
    || (value.resumeOnly !== undefined && value.resumeOnly !== true)
  ) return null;

  const launch = {
    turnAttemptId: value.turnAttemptId,
    sessionId: value.sessionId,
    baseRevision: value.baseRevision,
    prompt: value.prompt,
    ...(value.retrySourceAttemptId === undefined
      ? {}
      : { retrySourceAttemptId: value.retrySourceAttemptId }),
    ...(value.candidateContract === undefined
      ? {}
      : { candidateContract: value.candidateContract }),
  };
  try {
    assertAgentTurnTransportIdentifier(value.executionEpochId, 'Agent execution epoch ID');
    validateAgentSessionLaunchIdentity(launch);
    assertAgentSessionTransportPayloadSize(value, 'Agent turn start delivery');
  } catch {
    return null;
  }
  return launch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
