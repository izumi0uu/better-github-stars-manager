import type {
  BgsmAgentConversationBinding,
} from '@/bgsm-agent';
import {
  AgentProviderError,
  type AgentErrorCategory,
  type AgentEvent,
} from '@/agent-harness';
import {
  AGENT_ATTEMPT_STATE_LOST_ERROR_CODE,
  normalizeAgentTurnErrorCode,
  parseBgsmAgentTurnClientMessage,
  parseBgsmAgentTurnServerMessage,
  type BgsmAgentActiveTurn,
  type BgsmAgentDeliveryIdentity,
  type BgsmAgentTurnClientMessage,
  type BgsmAgentTurnEvent,
  type BgsmAgentTurnLaunch,
  type BgsmAgentTurnPublishedMessage,
  type BgsmAgentTurnResult,
  type BgsmAgentTurnSequencedServerMessage,
  type BgsmAgentTurnServerMessage,
} from '@/bgsm-agent/turn-protocol';
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
  AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED,
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


type AgentTurnAttempt = {
  input: BgsmAgentTurnLaunch;
  fingerprint: string;
  controller: AbortController;
  subscribers: Set<AgentTurnPort>;
  deliveries: BgsmAgentTurnSequencedServerMessage[];
  terminal: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  finalization: Promise<boolean> | null;
  acknowledgementRecorded: boolean;
  resumeExisting: boolean;
  durableLeaseAuthorityAcquired: boolean;
  stopRequested: boolean;
  stopPersistence: Promise<void> | null;
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

export type BgsmAgentRecoveryReservation = Readonly<{
  sessionId: string;
  token: symbol;
}>;

export type BgsmAgentTurnRegistry = Readonly<{
  executionEpochId: string;
  inspectActiveTurn(sessionId: string): BgsmAgentActiveTurn | null;
  reserveRecovery(sessionId: string): BgsmAgentRecoveryReservation;
  restoreApprovedTurn(
    launch: BgsmAgentTurnLaunch,
    reservation: BgsmAgentRecoveryReservation,
  ): BgsmAgentActiveTurn;
  releaseRecovery(reservation: BgsmAgentRecoveryReservation): void;
  attach(port: AgentTurnPort): void;
}>;

export type BgsmAgentTurnRunner = (
  input: BgsmAgentTurnLaunch,
  options: Readonly<{
    signal: AbortSignal;
    emit(event: AgentEvent): void;
    onDurableLeaseAcquired(): void | Promise<void>;
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
    }>) => Promise<boolean | void> | boolean | void;
    fenceRestoredTurnFailure?: (input: BgsmAgentTurnLaunch) => Promise<boolean>;
    requestTurnStop?: (launch: BgsmAgentTurnLaunch) => Promise<boolean>;
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
  const recoveryReservations = new Map<string, symbol>();
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
    // Stop can settle a waiter before runTurn reaches durable admission. Only
    // acquired authority may consult the fail-closed durable release contract.
    const finalization = Promise.resolve()
      .then(() => attempt.durableLeaseAuthorityAcquired
        ? dependencies.releaseTurnLease?.({
            sessionId: attempt.input.sessionId,
            turnAttemptId: attempt.input.turnAttemptId,
            executionEpochId,
          })
        : true)
      .then((released) => {
        if (released === false) return false;
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
    delivery: BgsmAgentTurnSequencedServerMessage,
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

  const prepareDelivery = (
    attempt: AgentTurnAttempt,
    message: BgsmAgentTurnPublishedMessage,
  ): BgsmAgentTurnSequencedServerMessage => {
    const delivery = {
      ...message,
      sequence: attempt.deliveries.length,
    } as BgsmAgentTurnSequencedServerMessage;
    parseBgsmAgentTurnServerMessage(delivery);
    return delivery;
  };

  const publish = (
    attempt: AgentTurnAttempt,
    delivery: BgsmAgentTurnSequencedServerMessage,
  ): void => {
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
    let delivery: BgsmAgentTurnSequencedServerMessage;
    try {
      delivery = prepareDelivery(attempt, {
        type: 'bgsmAgentTurnResult',
        result: {
          ...result,
          turnAttemptId: attempt.input.turnAttemptId,
          sessionId: attempt.input.sessionId,
          baseRevision: attempt.input.baseRevision,
        },
      });
    } catch (error) {
      void failAttempt(attempt, error);
      return;
    }
    attempt.terminal = true;
    publish(attempt, delivery);
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
    const delivery = prepareDelivery(attempt, {
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
    attempt.terminal = true;
    publish(attempt, delivery);
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

  const createAttempt = (
    input: BgsmAgentTurnLaunch,
    resumeExisting = false,
  ): AgentTurnAttempt => {
    const trace = createTrace(input, resumeExisting);
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
      resumeExisting,
      durableLeaseAuthorityAcquired: resumeExisting,
      stopRequested: false,
      stopPersistence: null,
      ...(trace ? { trace } : {}),
      ...(contentCapture ? { contentCapture } : {}),
    };
    attempts.set(input.turnAttemptId, attempt);
    activeAttemptBySession.set(input.sessionId, input.turnAttemptId);
    return attempt;
  };

  const requestStop = (attempt: AgentTurnAttempt): Promise<void> => {
    if (attempt.terminal) return Promise.resolve();
    attempt.stopRequested = true;
    if (attempt.stopPersistence) return attempt.stopPersistence;
    // A fresh runner can still be awaiting admission. Its admission callback
    // must persist Stop before allowing any provider or tool work to begin.
    if (!attempt.durableLeaseAuthorityAcquired && dependencies.requestTurnStop) {
      return Promise.resolve();
    }
    const persist = async () => {
      if (dependencies.requestTurnStop && !await dependencies.requestTurnStop(attempt.input)) return;
      if (attempt.terminal) return;
      observeTrace(() => attempt.trace?.recordCancellation('user'));
      attempt.controller.abort();
    };
    attempt.stopPersistence = persist();
    return attempt.stopPersistence;
  };

  const stopFromPort = (attempt: AgentTurnAttempt) => {
    void requestStop(attempt).catch(async (error) => {
      // Persistence failure is not an accepted Stop. Fence local execution and
      // expose the failure rather than publishing a synthetic aborted receipt.
      await failAttempt(attempt, error);
      attempt.controller.abort(error);
    });
  };

  const start = (
    input: BgsmAgentTurnLaunch,
    resumeExisting = false,
  ): AgentTurnAttempt => {
    const attempt = createAttempt(input, resumeExisting);
    publish(attempt, prepareDelivery(attempt, {
      type: 'bgsmAgentTurnEvent',
      event: deliveryEvent(input, { type: 'agent_queued' }),
    }));
    void dependencies.runTurn(input, {
      signal: attempt.controller.signal,
      onDurableLeaseAcquired: () => {
        attempt.durableLeaseAuthorityAcquired = true;
        if (attempt.stopRequested) return requestStop(attempt);
      },
      trace: attempt.trace
        ? {
            emit: (event) => observeTrace(() => attempt.trace?.execution.emit(event)),
          }
        : undefined,
      contentCapture: attempt.contentCapture,
      emit: (event) => {
        if (!attempt.terminal) {
          observeTrace(() => attempt.trace?.recordAgentEvent(event));
          publish(attempt, prepareDelivery(attempt, {
            type: 'bgsmAgentTurnEvent',
            event: deliveryEvent(input, event),
          }));
        }
      },
      bind: (binding) => {
        if (!attempt.terminal) {
          publish(attempt, prepareDelivery(attempt, {
            type: 'bgsmAgentTurnEvent',
            event: deliveryEvent(input, { type: 'conversation_bound', binding }),
          }));
        }
      },
    }).then(
      (result) => finishAttempt(attempt, result),
      (error) => {
        if (!attempt.resumeExisting && isContextCapabilityFailure(error)) {
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
        const settleFailure = async () => {
          let terminalError = error;
          if (attempt.resumeExisting && dependencies.fenceRestoredTurnFailure) {
            try {
              if (await dependencies.fenceRestoredTurnFailure(input)) {
                terminalError = createAttemptStateLostError(error);
              }
            } catch (fenceError) {
              terminalError = createAttemptStateLostError(fenceError);
            }
          }
          await failAttempt(attempt, terminalError);
        };
        void settleFailure();
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
    const typedConflictCode = options.identityConflict
      ? 'agent_session_attempt_conflict' as const
      : reason === 'active_session_conflict'
        ? 'agent_session_turn_active' as const
        : null;
    const delivery: BgsmAgentTurnSequencedServerMessage = typedConflictCode
      ? {
          type: 'bgsmAgentTurnError',
          sequence: 0,
          error: {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            message: options.identityConflict
              ? 'Cubby turnAttemptId was reused with conflicting launch data.'
              : 'Another Cubby turn is already active for this conversation.',
            category: 'other',
            code: typedConflictCode,
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
    parseBgsmAgentTurnServerMessage(delivery);
    postSequenced(port, delivery, trace, 'live');
    if (typedConflictCode && !options.identityConflict) {
      observeTrace(() => trace?.finish('failed', typedConflictCode));
    } else if (!typedConflictCode && options.terminateTrace !== false) {
      observeTrace(() => trace?.finish('attempt_state_lost', 'attempt_state_lost'));
    }
    return trace;
  };

  const acknowledge = (
    port: AgentTurnPort,
    message: Extract<BgsmAgentTurnClientMessage, { type: 'ackBgsmAgentTurnResult' }>,
    attemptId: string | null,
  ) => {
    if (message.executionEpochId !== executionEpochId || message.turnAttemptId !== attemptId) return;
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
    reserveRecovery(sessionId) {
      if (recoveryReservations.has(sessionId)) {
        throw new Error('Agent session recovery is already reserved.');
      }
      const token = Symbol(sessionId);
      recoveryReservations.set(sessionId, token);
      return Object.freeze({ sessionId, token });
    },
    restoreApprovedTurn(launch, reservation) {
      if (
        reservation.sessionId !== launch.sessionId
        || recoveryReservations.get(launch.sessionId) !== reservation.token
      ) throw new Error('Agent turn restore requires the active recovery reservation.');
      const fingerprint = turnLaunchFingerprint(launch);
      const activeAttemptId = activeAttemptBySession.get(launch.sessionId);
      if (activeAttemptId && activeAttemptId !== launch.turnAttemptId) {
        throw new Error('A different Agent turn is already active for this session.');
      }
      const existing = attempts.get(launch.turnAttemptId);
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.input.sessionId !== launch.sessionId) {
          throw new Error('The approved Agent turn restore identity conflicts with the active runner.');
        }
        return { executionEpochId, launch: structuredClone(existing.input) };
      }
      if (tombstones.has(launch.turnAttemptId)) {
        throw new Error('The approved Agent turn restore was already finalized.');
      }
      const attempt = start(structuredClone(launch), true);
      return { executionEpochId, launch: structuredClone(attempt.input) };
    },
    releaseRecovery(reservation) {
      if (recoveryReservations.get(reservation.sessionId) === reservation.token) {
        recoveryReservations.delete(reservation.sessionId);
      }
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
        let message: BgsmAgentTurnClientMessage;
        try {
          message = parseBgsmAgentTurnClientMessage(rawMessage);
        } catch {
          if (
            typeof rawMessage === 'object'
            && rawMessage !== null
            && 'type' in rawMessage
            && rawMessage.type === 'startBgsmAgentTurn'
          ) {
            port.disconnect();
          }
          return;
        }
        if (message.type === 'ackBgsmAgentTurnResult') {
          if (message.executionEpochId !== executionEpochId) return;
          if (
            connectionState.attachmentMode === 'rejected'
            && message.turnAttemptId === connectionState.attachedAttemptId
          ) {
            observeTrace(() => connectionState.trace?.recordAcknowledgement({
              disposition: message.disposition,
              appliedRevision: message.appliedRevision,
            }));
            confirmAcknowledgement(port, message);
          } else if (connectionState.attachmentMode === 'attempt') {
            acknowledge(port, message, connectionState.attachedAttemptId);
          }
          return;
        }
        if (message.type === 'stopBgsmAgentTurn') {
          if (message.executionEpochId !== executionEpochId) return;
          if (
            connectionState.pendingLaunch
            && sameTurnIdentity(connectionState.pendingLaunch, message)
          ) {
            connectionState.stopRequested = true;
          }
          const attempt = attempts.get(message.turnAttemptId);
          if (
            attempt
            && connectionState.attachmentMode !== 'rejected'
            && connectionState.attachedAttemptId === message.turnAttemptId
            && sameTurnIdentity(attempt.input, message)
          ) stopFromPort(attempt);
          return;
        }
        if (connectionState.attachedAttemptId) return;
        const parsed: BgsmAgentTurnLaunch = {
          turnAttemptId: message.turnAttemptId,
          sessionId: message.sessionId,
          baseRevision: message.baseRevision,
          prompt: message.prompt,
          ...(message.retrySourceAttemptId === undefined
            ? {}
            : { retrySourceAttemptId: message.retrySourceAttemptId }),
          ...(message.candidateContract === undefined
            ? {}
            : { candidateContract: message.candidateContract }),
        };
        if (message.executionEpochId !== executionEpochId) {
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'rejected';
          connectionState.trace = rejectAttempt(port, parsed, 'execution_epoch_mismatch');
          return;
        }
        if (recoveryReservations.has(parsed.sessionId)) {
          connectionState.attachedAttemptId = parsed.turnAttemptId;
          connectionState.attachmentMode = 'rejected';
          connectionState.trace = rejectAttempt(port, parsed, 'active_session_conflict');
          return;
        }
        if (message.resumeOnly === true) {
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
          if (recoveryReservations.has(parsed.sessionId)) {
            connectionState.attachedAttemptId = parsed.turnAttemptId;
            connectionState.attachmentMode = 'rejected';
            connectionState.trace = rejectAttempt(port, parsed, 'active_session_conflict');
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
              stopFromPort(attempt);
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
  message: Extract<BgsmAgentTurnClientMessage, { type: 'ackBgsmAgentTurnResult' }>,
): void {
  const confirmation: BgsmAgentTurnServerMessage = message.disposition === 'applied'
    ? {
        type: 'bgsmAgentTurnAck',
        turnAttemptId: message.turnAttemptId,
        sessionId: message.sessionId,
        baseRevision: message.baseRevision,
        disposition: 'applied',
        appliedRevision: message.appliedRevision,
      }
    : {
        type: 'bgsmAgentTurnAck',
        turnAttemptId: message.turnAttemptId,
        sessionId: message.sessionId,
        baseRevision: message.baseRevision,
        disposition: message.disposition,
        appliedRevision: null,
      };
  safePost(port, confirmation);
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

function safePost(port: AgentTurnPort, message: BgsmAgentTurnServerMessage): boolean {
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
): BgsmAgentTurnEvent {
  return {
    ...event,
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
  } as BgsmAgentTurnEvent;
}

function turnLaunchFingerprint(input: BgsmAgentTurnLaunch): string {
  return JSON.stringify({
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    prompt: input.prompt,
    retrySourceAttemptId: input.retrySourceAttemptId ?? null,
    candidateContract: input.candidateContract ?? null,
  });
}

function sameTurnIdentity(
  input: BgsmAgentDeliveryIdentity,
  value: BgsmAgentDeliveryIdentity,
): boolean {
  return value.turnAttemptId === input.turnAttemptId
    && value.sessionId === input.sessionId
    && value.baseRevision === input.baseRevision;
}


function isContextCapabilityFailure(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error);
  return code === AGENT_CONTEXT_CAPABILITY_REQUIRED ||
    code === AGENT_CONTEXT_CAPABILITY_INFEASIBLE;
}

function createAttemptStateLostError(cause: unknown) {
  return Object.assign(
    new Error('Cubby could not safely resume the previous turn.', { cause }),
    { code: AGENT_ATTEMPT_STATE_LOST_ERROR_CODE },
  );
}



function classifyTurnError(error: unknown): AgentErrorCategory {
  if (error instanceof AgentProviderError) {
    return error.status === 401 || error.status === 403 ? 'authentication' : 'provider';
  }
  const code = error instanceof Error ? error.message : String(error);
  if (code === AGENT_DATA_DISCLOSURE_REQUIRED) return 'disclosure';
  if (
    code === AGENT_HOST_PERMISSION_DENIED ||
    code === AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED
  ) return 'permission';
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
