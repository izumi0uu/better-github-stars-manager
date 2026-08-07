import type { AgentErrorCategory } from '@/agent-harness';
import type { BgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';
import {
  bindBgsmAgentSession,
  createBgsmAgentTurnInput,
  type BgsmAgentSessionMessage,
} from '@/bgsm-agent/session';
import { getBgsmAgentToolDefinition } from '@/bgsm-agent/tool-catalog';
import type {
  BgsmAgentTurnAck,
  BgsmAgentTurnEvent,
  BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';
import type {
  AgentRetryDraft,
  AgentRetryDraftKind,
} from '@/storage/agent-session-store';
import {
  canSafelyRetryPendingTurn,
  canSafelyRetrySettledPendingTurn,
  retryDraftKindForResult,
  sameRetryDraft,
  trackPendingWriteOutcome,
  type PendingRetryAuthority,
  type PendingWriteOutcome,
} from '@/ui/bgsm-agent-retry-policy';
import { classifySessionLoadFailure, isEmptyToolCallEnvelope } from '@/ui/bgsm-agent-session-projection';
import type { BgsmAgentChatMessage } from '@/ui/bgsm-agent-session-projection';
import type { HydratedActiveTurn } from '@/ui/bgsm-agent-retry-recovery';
import {
  reduceAgentTurn,
  type AgentTurnAction,
  type BgsmAgentActionableContextFailureReason,
  type BgsmAgentStatus,
  type BgsmAgentToolActivity,
} from '@/ui/agent-turn-state';
import {
  loadDurableBgsmAgentSession,
  readDurableAgentRetryDraftCandidate,
  startBgsmAgentTurn,
  type BgsmAgentTurnHandlers,
} from '@/utils/messaging';
import type { BgsmAgentClientStateAccess } from './agent-client-controller';
import type { BgsmAgentClientSessionController } from './agent-client-session-controller';

type PendingCompactionUi = {
  timer: ReturnType<typeof setTimeout> | null;
  visible: boolean;
};

export type PendingTurn = {
  token: string;
  startedAt: number;
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
  prompt: string;
  optimisticMessageId: string;
  transientMessageIds: Set<string>;
  streamStep: number | null;
  streamMessageId: string | null;
  streamContent: string;
  streamFlushScheduled: boolean;
  streamFrame: number | null;
  writeOutcomes: Map<string, PendingWriteOutcome>;
  stopRequested: boolean;
  stopFallbackTimer: ReturnType<typeof setTimeout> | null;
  stop: () => void;
  detach: () => void;
  acknowledge: (ack: BgsmAgentTurnAck) => void;
  resolve: (result: BgsmAgentTurnResult | null) => void;
  compactionUi: PendingCompactionUi | null;
  binding: BgsmAgentConversationBinding | null;
  retryAuthority: PendingRetryAuthority;
  sourceRetryDraft: AgentRetryDraft | null;
};

export type BgsmAgentTurnStartOptions = Readonly<{
  retrySourceAttemptId?: string;
  resumedTurn?: HydratedActiveTurn;
}>;

export type BgsmAgentClientTurnController = Readonly<{
  startTurn(prompt: string, options?: BgsmAgentTurnStartOptions): Promise<BgsmAgentTurnResult | null>;
  stopTurn(): void;
  stopAndDetachPendingTurn(): void;
  deactivate(): void;
  resumeHydratedTurn(turn: HydratedActiveTurn | null): void;
  editContextLimitedPrompt(): void;
}>;

const STOP_SETTLE_TIMEOUT_MS = 3_000;

/** Owns the one page-local Agent turn Port and all transient delivery state. */
export function createBgsmAgentClientTurnController(
  access: BgsmAgentClientStateAccess,
  sessionController: BgsmAgentClientSessionController,
): BgsmAgentClientTurnController {
  const { state } = access;
  let turnSequence = 0;
  let resumeSequence = 0;
  let resumingTurn: HydratedActiveTurn | null = null;

  const syncActiveRecord = () => {
    const record = state.sessionStore.records.get(state.sessionStore.activeSessionId);
    if (!record?.session) return;
    record.session = state.activeSession;
    record.messages = state.messages;
    record.nextBeforeSequence = state.nextBeforeSequence;
  };

  const updateMessages = (updater: (current: readonly BgsmAgentChatMessage[]) => BgsmAgentChatMessage[]) => {
    const next = updater(state.messages);
    if (next === state.messages) return;
    state.messages = next;
    syncActiveRecord();
    access.publish();
  };

  const dispatchTurn = (action: AgentTurnAction) => {
    const next = reduceAgentTurn(state.turnState, action);
    if (next === state.turnState) return;
    state.turnState = next;
    access.publish();
  };

  const clearCompactionUi = (pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    if (!compaction) return;
    if (compaction.timer !== null) clearTimeout(compaction.timer);
    pending.compactionUi = null;
  };

  const clearStreamFlush = (pending: PendingTurn) => {
    if (pending.streamFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.streamFrame);
    }
    pending.streamFrame = null;
    pending.streamFlushScheduled = false;
  };

  const startCompactionUi = (pending: PendingTurn) => {
    if (pending.compactionUi) return;
    const labels = access.getOptions().labels;
    const compaction: PendingCompactionUi = { timer: null, visible: false };
    pending.compactionUi = compaction;
    dispatchTurn({ type: 'compaction_started' });
    compaction.timer = setTimeout(() => {
      if (state.pendingTurn !== pending || pending.compactionUi !== compaction) return;
      compaction.timer = null;
      compaction.visible = true;
      dispatchTurn({
        type: 'compaction_shown',
        status: { kind: 'compacting', text: labels.agentCompacting },
      });
    }, 300);
  };

  const finishCompactionUi = (pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    clearCompactionUi(pending);
    if (!compaction || state.pendingTurn !== pending) return;
    dispatchTurn({
      type: 'compaction_finished',
      restore: compaction.visible,
      fallbackStatus: { kind: 'working', text: access.getOptions().labels.agentThinking },
    });
  };

  const appendAssistantError = (content: string, pending: PendingTurn) => {
    const id = `${pending.token}:error:${pending.transientMessageIds.size + 1}`;
    pending.transientMessageIds.add(id);
    updateMessages((current) => [
      ...current,
      { id, role: 'assistant', content, createdAt: Date.now() },
    ]);
  };

  const appendAgentMessage = (message: BgsmAgentSessionMessage, pending: PendingTurn) => {
    if (message.role === 'user' || isEmptyToolCallEnvelope(message)) return;
    pending.transientMessageIds.add(message.id);
    updateMessages((current) => {
      const next: BgsmAgentChatMessage = {
        id: message.id,
        role: message.role === 'agent' ? 'assistant' : 'tool',
        content: message.content,
        createdAt: message.createdAt,
        toolName: message.toolName,
      };
      const index = current.findIndex((item) => item.id === next.id);
      return index === -1
        ? [...current, next]
        : current.map((item, itemIndex) => itemIndex === index ? next : item);
    });
  };

  const rollbackPendingMessages = (pending: PendingTurn) => {
    const rollbackIds = new Set([pending.optimisticMessageId, ...pending.transientMessageIds]);
    clearStreamFlush(pending);
    pending.streamMessageId = null;
    pending.streamStep = null;
    pending.streamContent = '';
    updateMessages((current) => current.filter((message) => !rollbackIds.has(message.id)));
  };

  const restoreCommittedBinding = () => {
    state.conversationBinding = state.activeSession.binding ?? null;
    access.publish();
  };

  const setAgentStatus = (status: BgsmAgentStatus | null) => {
    dispatchTurn({ type: 'status_changed', status });
  };

  const updateToolActivity = (activity: BgsmAgentToolActivity) => {
    dispatchTurn({ type: 'tool_activity_updated', activity });
  };

  const removeToolActivity = (callId: string) => {
    dispatchTurn({ type: 'tool_activity_removed', callId });
  };

  const appendStreamDelta = (pending: PendingTurn, step: number, delta: string) => {
    const previousId = pending.streamMessageId;
    if (pending.streamStep !== step || !pending.streamMessageId) {
      pending.streamStep = step;
      pending.streamMessageId = `${pending.token}:assistant-stream:${step}`;
      pending.streamContent = '';
      pending.transientMessageIds.add(pending.streamMessageId);
    }
    pending.streamContent += delta;
    if (pending.streamFlushScheduled) return;
    pending.streamFlushScheduled = true;
    const flush = () => {
      pending.streamFrame = null;
      pending.streamFlushScheduled = false;
      if (state.pendingTurn !== pending || !pending.streamMessageId) return;
      const messageId = pending.streamMessageId;
      const content = pending.streamContent;
      updateMessages((current) => {
        const withoutPrevious = previousId && previousId !== messageId
          ? current.filter((message) => message.id !== previousId)
          : current;
        const index = withoutPrevious.findIndex((message) => message.id === messageId);
        const next: BgsmAgentChatMessage = {
          id: messageId,
          role: 'assistant',
          content,
          createdAt: pending.startedAt,
          streaming: true,
        };
        return index === -1
          ? [...withoutPrevious, next]
          : withoutPrevious.map((message, messageIndex) => messageIndex === index ? next : message);
      });
    };
    if (typeof requestAnimationFrame === 'function') {
      pending.streamFrame = requestAnimationFrame(flush);
    } else {
      queueMicrotask(flush);
    }
  };

  const clearCurrentStreamMessage = (pending: PendingTurn) => {
    const streamMessageId = pending.streamMessageId;
    if (!streamMessageId) return;
    clearStreamFlush(pending);
    updateMessages((current) => current.filter((message) => message.id !== streamMessageId));
    pending.streamMessageId = null;
    pending.streamStep = null;
    pending.streamContent = '';
  };

  const isCurrentDelivery = (
    pending: PendingTurn,
    delivery: { turnAttemptId: string; sessionId: string; baseRevision: number },
  ) => (
    state.pendingTurn === pending
    && delivery.sessionId === pending.sessionId
    && delivery.baseRevision === pending.baseRevision
    && delivery.turnAttemptId === pending.turnAttemptId
    && state.activeSession.id === pending.sessionId
    && state.activeSession.revision === pending.baseRevision
  );

  const markRetryAttemptAccepted = (pending: PendingTurn) => {
    if (!pending.sourceRetryDraft) return;
    pending.retryAuthority = 'recovered_retry';
    pending.sourceRetryDraft = null;
    if (state.sessionStore.activeSessionId === pending.sessionId) {
      access.setActiveRetryDraft(null);
      access.publish();
    }
  };

  const setRetryDraft = (
    pending: Pick<PendingTurn, 'sessionId' | 'turnAttemptId' | 'baseRevision' | 'prompt'>,
    kind: AgentRetryDraftKind,
    canRetry: boolean,
    settlement: AgentRetryDraft['settlement'] = 'retryable',
  ) => {
    const draft: AgentRetryDraft = {
      sessionId: pending.sessionId,
      turnAttemptId: pending.turnAttemptId,
      baseRevision: pending.baseRevision,
      prompt: pending.prompt,
      kind,
      settlement,
      updatedAt: Date.now(),
    };
    if (state.sessionStore.persistence === 'memory') {
      if (state.sessionStore.activeSessionId === pending.sessionId) {
        access.setActiveRetryDraft(canRetry ? draft : { ...draft, settlement: 'stop_pending' });
        access.publish();
      }
      return;
    }
    if (state.sessionStore.activeSessionId === pending.sessionId) {
      access.setActiveRetryDraft({ ...draft, settlement: 'stop_pending' });
      access.publish();
    }
    refreshDurableRetryDraft(pending.sessionId);
  };

  const refreshDurableRetryDraft = (sessionId: string) => {
    if (state.sessionStore.persistence !== 'durable') return;
    const sequence = access.reserveRetryDraftPresentation(sessionId);
    void readDurableAgentRetryDraftCandidate(sessionId).then((draft) => {
      if (
        !state.active
        || state.retryPresentationSequences.get(sessionId) !== sequence
        || state.sessionStore.activeSessionId !== sessionId
        || state.activeSession.id !== sessionId
      ) return;
      access.setActiveRetryDraft(
        draft?.baseRevision === state.activeSession.revision ? draft : null,
      );
      access.publish();
    }).catch(() => {
      // Keep optimistic retry presentation until the next authoritative read.
    });
  };

  const forgetRetryDraft = (sessionId: string, expected?: AgentRetryDraft) => {
    const current = state.durableRetryDraft;
    if (
      state.sessionStore.activeSessionId !== sessionId
      || (expected && !sameRetryDraft(current, expected))
    ) return;
    access.setActiveRetryDraft(null);
    access.publish();
  };

  const failPendingTurn = (
    pending: PendingTurn,
    message: string,
    category: AgentErrorCategory,
    result: BgsmAgentTurnResult | null = null,
    canRetry = canSafelyRetryPendingTurn(pending),
  ) => {
    if (state.activeSession.id !== pending.sessionId) return;
    rollbackPendingMessages(pending);
    restoreCommittedBinding();
    dispatchTurn({
      type: 'turn_failed',
      result,
      message,
      category,
      status: { kind: 'error', text: message },
      prompt: pending.prompt,
      canRetry,
    });
    setRetryDraft(pending, 'failed', canRetry);
    appendAssistantError(message, pending);
  };

  const finishTurn = (
    pending: PendingTurn,
    result: BgsmAgentTurnResult | null,
    canRetryOverride?: boolean,
  ) => {
    if (state.pendingTurn !== pending) return false;
    clearCompactionUi(pending);
    clearStreamFlush(pending);
    if (pending.stopFallbackTimer !== null) {
      clearTimeout(pending.stopFallbackTimer);
      pending.stopFallbackTimer = null;
    }
    state.pendingTurn = null;
    if (state.turnState.running) {
      if (result) {
        const labels = access.getOptions().labels;
        dispatchTurn({
          type: 'turn_finished',
          result,
          prompt: pending.prompt,
          canRetry: canRetryOverride ?? canSafelyRetryPendingTurn(pending),
          doneStatus: { kind: 'done', text: labels.agentDone },
          stoppedStatus: { kind: 'stopped', text: labels.agentStopped },
          failureStatus: { kind: 'error', text: labels.turnFailed },
          failureMessage: labels.turnFailed,
          failureCategory: result.reason === 'provider_error' || result.reason === 'context_limit'
            ? 'provider'
            : 'other',
        });
      } else {
        dispatchTurn({ type: 'turn_detached' });
      }
    }
    if (result?.changed) access.getOptions().onDataChanged?.();
    pending.resolve(result);
    return true;
  };

  const handleEvent = (event: BgsmAgentTurnEvent, pending: PendingTurn) => {
    if (!isCurrentDelivery(pending, event)) return;
    const labels = access.getOptions().labels;
    if (event.type === 'agent_start') markRetryAttemptAccepted(pending);
    const writeOutcomeChanged = trackPendingWriteOutcome(pending, event);
    if (pending.stopRequested && event.type !== 'agent_done') {
      if (writeOutcomeChanged) {
        const canPreserveDraft = canSafelyRetrySettledPendingTurn(pending);
        if (!pending.sourceRetryDraft) {
          setRetryDraft(pending, 'stopped', canPreserveDraft, 'stop_pending');
        }
        dispatchTurn({
          type: 'stop_requested',
          prompt: pending.prompt,
          canRetry: false,
          status: { kind: 'stopped', text: labels.agentStopped },
        });
      }
      return;
    }
    if (!['context_compaction_start', 'context_compaction_end', 'context_diagnostic'].includes(event.type)) {
      finishCompactionUi(pending);
    }
    switch (event.type) {
      case 'agent_queued':
        setAgentStatus({ kind: 'queued', text: labels.agentQueued });
        break;
      case 'conversation_bound':
        bindBgsmAgentSession(state.activeSession, event.binding);
        pending.binding = event.binding;
        state.conversationBinding = event.binding;
        syncActiveRecord();
        access.publish();
        break;
      case 'agent_start':
        setAgentStatus({ kind: 'working', text: labels.agentStarting });
        break;
      case 'turn_start':
        setAgentStatus({ kind: 'working', text: labels.agentThinking });
        break;
      case 'assistant_stream_start':
        setAgentStatus({ kind: 'working', text: labels.agentWriting });
        break;
      case 'assistant_text_delta':
        appendStreamDelta(pending, event.step, event.delta);
        setAgentStatus({ kind: 'working', text: labels.agentWriting });
        break;
      case 'message_update':
        if (event.message.role === 'agent') clearCurrentStreamMessage(pending);
        appendAgentMessage(event.message, pending);
        if (event.message.role === 'agent' && event.message.content.trim()) {
          setAgentStatus({ kind: 'working', text: labels.agentWriting });
        }
        break;
      case 'tool_execution_queued':
        updateToolActivity({ callId: event.callId, toolName: event.toolName, state: 'queued' });
        break;
      case 'tool_execution_start':
        updateToolActivity({ callId: event.callId, toolName: event.toolName, state: 'running' });
        setAgentStatus({
          kind: 'tool',
          text: toolStatusText(event.toolName, event.risk, labels),
        });
        break;
      case 'tool_execution_end':
        if (!event.ok) {
          removeToolActivity(event.callId);
          setAgentStatus({ kind: 'working', text: labels.agentThinking });
          break;
        }
        updateToolActivity({ callId: event.callId, toolName: event.toolName, state: 'completed' });
        setAgentStatus({ kind: 'working', text: labels.agentThinking });
        break;
      case 'agent_error':
        dispatchTurn({
          type: 'error_observed',
          message: event.message,
          category: event.category ?? 'other',
          status: { kind: 'error', text: event.message },
        });
        appendAssistantError(event.message, pending);
        break;
      case 'approval_required':
        dispatchTurn({
          type: 'error_observed',
          message: event.summary,
          category: 'other',
          status: { kind: 'error', text: event.summary },
        });
        appendAssistantError(event.summary, pending);
        break;
      case 'context_compaction_start':
        clearCurrentStreamMessage(pending);
        startCompactionUi(pending);
        break;
      case 'context_diagnostic':
        break;
      case 'context_compaction_end':
        finishCompactionUi(pending);
        break;
      case 'agent_done':
        if (event.reason === 'aborted') {
          pending.stopRequested = true;
          rollbackPendingMessages(pending);
          const canPreserveDraft = canSafelyRetrySettledPendingTurn(pending);
          if (!pending.sourceRetryDraft) {
            setRetryDraft(pending, 'stopped', canPreserveDraft, 'stop_pending');
          }
          dispatchTurn({
            type: 'stop_requested',
            prompt: pending.prompt,
            canRetry: false,
            status: { kind: 'stopped', text: labels.agentStopped },
          });
        }
        break;
    }
  };

  const stopTurn = () => {
    const pending = state.pendingTurn;
    if (!pending || pending.stopRequested) return;
    pending.stopRequested = true;
    clearCompactionUi(pending);
    pending.stop();
    rollbackPendingMessages(pending);
    restoreCommittedBinding();
    const canRetry = canSafelyRetrySettledPendingTurn(pending);
    setRetryDraft(pending, 'stopped', canRetry, 'stop_pending');
    dispatchTurn({
      type: 'stop_requested',
      prompt: pending.prompt,
      canRetry: false,
      status: { kind: 'stopped', text: access.getOptions().labels.agentStopped },
    });
    if (pending.stopFallbackTimer === null) {
      pending.stopFallbackTimer = setTimeout(() => {
        if (state.pendingTurn !== pending) return;
        pending.detach();
        finishTurn(pending, null);
      }, STOP_SETTLE_TIMEOUT_MS);
    }
  };

  const startTurn = async (
    prompt: string,
    startOptions: BgsmAgentTurnStartOptions = {},
  ): Promise<BgsmAgentTurnResult | null> => {
    const resumedTurn = startOptions.resumedTurn;
    const gate = state.hydrationGate;
    await gate.promise;
    const generation = state.lifecycleGeneration;
    const clean = prompt.trim();
    if (
      !access.isActiveGeneration(generation)
      || gate !== state.hydrationGate
      || !state.sessionReady
      || state.sessionInitializationFailed
      || !clean
      || state.pendingTurn
      || state.sessionOperationPending
      || (state.hydratedActiveTurn !== null && !resumedTurn)
    ) return null;
    const session = state.activeSession;
    if (
      resumedTurn
      && (
        resumedTurn.turn.launch.sessionId !== session.id
        || resumedTurn.turn.launch.baseRevision !== session.revision
        || resumedTurn.turn.launch.prompt.trim() !== clean
      )
    ) return null;
    const activeDraft = state.durableRetryDraft;
    const sourceRetryDraft = resumedTurn?.sourceRetryDraft ?? (
      activeDraft?.sessionId === session.id
      && activeDraft.baseRevision === session.revision
      && activeDraft.settlement === 'retryable'
      && activeDraft.prompt.trim() === clean
        ? activeDraft
        : null
    );
    if (!resumedTurn && !sourceRetryDraft && activeDraft?.sessionId === session.id) {
      forgetRetryDraft(session.id, activeDraft);
    }
    const entropy = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}_${++turnSequence}_${Math.random().toString(36).slice(2)}`;
    const token = resumedTurn?.turn.launch.turnAttemptId ?? `${session.id}:turn:${entropy}`;
    let retryAuthority: PendingRetryAuthority = resumedTurn?.retryAuthority ?? 'fresh';
    if (!resumedTurn && sourceRetryDraft && state.sessionStore.persistence === 'durable') {
      retryAuthority = 'recovered_retry';
    }
    const optimisticMessageId = `${token}:user`;
    const startedAt = Date.now();
    state.turnState = reduceAgentTurn(state.turnState, {
      type: 'turn_started',
      status: { kind: 'queued', text: access.getOptions().labels.agentQueued },
    });
    if (!state.messages.some((message) => message.id === optimisticMessageId)) {
      state.messages = [...state.messages, {
        id: optimisticMessageId,
        role: 'user',
        content: clean,
        createdAt: startedAt,
      }];
      syncActiveRecord();
    }
    access.publish();

    return new Promise((resolve) => {
      const pending: PendingTurn = {
        token,
        startedAt,
        turnAttemptId: token,
        sessionId: session.id,
        baseRevision: resumedTurn?.turn.launch.baseRevision ?? session.revision,
        prompt,
        optimisticMessageId,
        transientMessageIds: new Set(),
        streamStep: null,
        streamMessageId: null,
        streamContent: '',
        streamFlushScheduled: false,
        streamFrame: null,
        writeOutcomes: new Map(),
        stopRequested: false,
        stopFallbackTimer: null,
        compactionUi: null,
        stop: () => {},
        detach: () => {},
        acknowledge: () => {},
        resolve,
        binding: session.binding ?? null,
        retryAuthority,
        sourceRetryDraft,
      };
      state.pendingTurn = pending;
      const turnInput = resumedTurn?.turn.launch ?? (
        state.sessionStore.persistence === 'durable'
          ? {
              turnAttemptId: token,
              sessionId: session.id,
              baseRevision: session.revision,
              prompt: clean,
              ...(startOptions.retrySourceAttemptId
                ? { retrySourceAttemptId: startOptions.retrySourceAttemptId }
                : {}),
              ...(!session.binding && access.getOptions().candidateContract
                ? { candidateContract: access.getOptions().candidateContract }
                : {}),
            }
          : createBgsmAgentTurnInput(
              session,
              clean,
              access.getOptions().candidateContract,
              () => token,
            )
      );
      const processResult = async (deliveredResult: BgsmAgentTurnResult): Promise<void> => {
        if (!isCurrentDelivery(pending, deliveredResult)) return;
        let result = deliveredResult;
        const labels = access.getOptions().labels;
        if (result.reason === 'attempt_state_lost') {
          try {
            const recovered = await sessionController.recoverCommittedTurn(pending);
            if (state.pendingTurn !== pending) return;
            if (recovered) result = recovered;
            else {
              pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
              const canRetry = canSafelyRetryPendingTurn(pending);
              failPendingTurn(
                pending,
                pending.retryAuthority !== 'fresh' ? labels.attemptResumeStateUnknown : labels.attemptStateLost,
                'other',
                null,
                canRetry,
              );
              finishTurn(pending, null);
              return;
            }
          } catch {
            if (state.pendingTurn !== pending) return;
            sessionController.failSessionPersistence();
            pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
            failPendingTurn(pending, labels.attemptResumeStateUnknown, 'other', null, false);
            finishTurn(pending, null);
            return;
          }
        }
        if (result.commit) {
          sessionController.adoptCommit(result.commit, pending);
          pending.acknowledge({ disposition: 'applied', appliedRevision: result.commit.appliedRevision });
        } else {
          pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
          rollbackPendingMessages(pending);
          restoreCommittedBinding();
        }
        const retryKind = retryDraftKindForResult(result);
        const memoryRetryAvailable = state.sessionStore.persistence === 'memory'
          && canSafelyRetrySettledPendingTurn(pending);
        const retryAvailable = retryKind !== null && (
          state.sessionStore.persistence === 'durable' || memoryRetryAvailable
        );
        if (retryKind) {
          setRetryDraft(pending, retryKind, memoryRetryAvailable);
        } else {
          const draft = state.durableRetryDraft?.sessionId === pending.sessionId
            ? state.durableRetryDraft
            : null;
          if (draft) forgetRetryDraft(pending.sessionId, draft);
          refreshDurableRetryDraft(pending.sessionId);
        }
        if (result.reason === 'context_limit' || result.contextFailureReason) {
          if (isActionableContextFailure(result.contextFailureReason)) {
            dispatchTurn({
              type: 'context_recovery_required',
              result,
              recovery: { prompt, reason: result.contextFailureReason },
              prompt: pending.prompt,
              canRetry: retryAvailable,
            });
          } else {
            dispatchTurn({
              type: 'turn_failed',
              result,
              message: labels.turnFailed,
              category: 'provider',
              status: { kind: 'error', text: labels.turnFailed },
              prompt: pending.prompt,
              canRetry: retryAvailable,
            });
            appendAssistantError(labels.turnFailed, pending);
          }
          finishTurn(pending, result, retryAvailable);
          return;
        }
        finishTurn(pending, result, retryAvailable);
      };
      const handlers: BgsmAgentTurnHandlers = {
        onEvent: (event) => handleEvent(event, pending),
        onResult: processResult,
        onError: async (delivery) => {
          if (!isCurrentDelivery(pending, delivery)) return;
          let recoveredHydratedTurn: HydratedActiveTurn | null | undefined;
          const finishAfterRecovery = () => {
            if (finishTurn(pending, null) && recoveredHydratedTurn !== undefined) {
              state.hydratedActiveTurn = recoveredHydratedTurn;
              access.publish();
            }
          };
          if (pending.retryAuthority !== 'fresh' || pending.sourceRetryDraft !== null) {
            try {
              const recovered = await sessionController.recoverCommittedTurn(pending);
              if (state.pendingTurn !== pending) return;
              if (recovered) {
                await processResult(recovered);
                return;
              }
            } catch {
              if (state.pendingTurn !== pending) return;
              sessionController.failSessionPersistence();
            }
          }
          pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
          refreshDurableRetryDraft(pending.sessionId);
          if (
            delivery.code === 'agent_session_not_found'
            || delivery.code === 'agent_session_revision_conflict'
            || delivery.code === 'agent_session_corrupt'
          ) {
            try {
              if (delivery.code === 'agent_session_not_found' || delivery.code === 'agent_session_corrupt') {
                recoveredHydratedTurn = await sessionController.recoverUnavailable(pending.sessionId);
              } else {
                sessionController.reconcileCanonical(await loadDurableBgsmAgentSession(pending.sessionId));
              }
            } catch (error) {
              if (['not_found', 'corrupt'].includes(classifySessionLoadFailure(error))) {
                try {
                  recoveredHydratedTurn = await sessionController.recoverUnavailable(pending.sessionId);
                } catch {
                  sessionController.failSessionPersistence();
                }
              } else {
                sessionController.failSessionPersistence();
              }
            }
          }
          if (state.pendingTurn !== pending) return;
          if (pending.stopRequested) {
            finishAfterRecovery();
            return;
          }
          const message = delivery.message || access.getOptions().labels.turnFailed;
          failPendingTurn(
            pending,
            message,
            delivery.category ?? 'other',
            null,
            canSafelyRetryPendingTurn(pending),
          );
          finishAfterRecovery();
        },
      };
      try {
        const control = resumedTurn
          ? startBgsmAgentTurn(turnInput, handlers, {
              expectedExecutionEpochId: resumedTurn.turn.executionEpochId,
              resumeOnly: true,
            })
          : startBgsmAgentTurn(turnInput, handlers);
        if (state.pendingTurn === pending) {
          pending.stop = control.stop;
          pending.detach = typeof control.detach === 'function' ? control.detach : () => {};
          pending.acknowledge = control.acknowledge;
          if (pending.retryAuthority === 'recovered_stop') {
            pending.stopRequested = true;
            pending.stop();
            rollbackPendingMessages(pending);
            restoreCommittedBinding();
            dispatchTurn({
              type: 'stop_requested',
              prompt: pending.prompt,
              canRetry: false,
              status: { kind: 'stopped', text: access.getOptions().labels.agentStopped },
            });
            pending.stopFallbackTimer = setTimeout(() => {
              if (state.pendingTurn !== pending) return;
              pending.detach();
              finishTurn(pending, null);
            }, STOP_SETTLE_TIMEOUT_MS);
          }
        } else if (typeof control.detach === 'function') {
          control.detach();
        }
      } catch (error) {
        if (state.pendingTurn !== pending) return;
        if (pending.retryAuthority === 'recovered_stop') {
          rollbackPendingMessages(pending);
          restoreCommittedBinding();
          dispatchTurn({
            type: 'stop_requested',
            prompt: pending.prompt,
            canRetry: false,
            status: { kind: 'stopped', text: access.getOptions().labels.agentStopped },
          });
          finishTurn(pending, null);
          return;
        }
        const message = error instanceof Error ? error.message : access.getOptions().labels.turnFailed;
        failPendingTurn(pending, message, 'other', null, canSafelyRetryPendingTurn(pending));
        finishTurn(pending, null);
      }
    });
  };

  const stopAndDetachPendingTurn = () => {
    const pending = state.pendingTurn;
    state.pendingTurn = null;
    if (!pending) return;
    clearCompactionUi(pending);
    clearStreamFlush(pending);
    if (pending.stopFallbackTimer !== null) clearTimeout(pending.stopFallbackTimer);
    pending.resolve(null);
    pending.stop();
    pending.detach();
  };

  const deactivate = () => {
    resumeSequence += 1;
    resumingTurn = null;
    const pending = state.pendingTurn;
    state.pendingTurn = null;
    if (!pending) return;
    clearCompactionUi(pending);
    clearStreamFlush(pending);
    if (pending.stopFallbackTimer !== null) clearTimeout(pending.stopFallbackTimer);
    pending.resolve(null);
    pending.detach();
    if (state.turnState.running) {
      state.turnState = reduceAgentTurn(state.turnState, { type: 'turn_detached' });
      access.publish();
    }
  };

  const resumeHydratedTurn = (turn: HydratedActiveTurn | null) => {
    if (
      !turn
      || !state.active
      || !state.sessionReady
      || state.sessionOperationPending
      || state.pendingTurn
      || state.hydratedActiveTurn !== turn
      || resumingTurn === turn
    ) return;
    const currentResume = ++resumeSequence;
    resumingTurn = turn;
    void startTurn(turn.turn.launch.prompt, { resumedTurn: turn }).finally(() => {
      if (currentResume !== resumeSequence) return;
      resumingTurn = null;
      if (state.active && state.hydratedActiveTurn === turn) {
        state.hydratedActiveTurn = null;
        access.publish();
      }
    });
  };

  return {
    startTurn,
    stopTurn,
    stopAndDetachPendingTurn,
    deactivate,
    resumeHydratedTurn,
    editContextLimitedPrompt() {
      dispatchTurn({ type: 'context_recovery_dismissed' });
    },
  };
}

function isActionableContextFailure(
  reason: BgsmAgentTurnResult['contextFailureReason'],
): reason is BgsmAgentActionableContextFailureReason {
  return reason === 'capability_unresolved'
    || reason === 'current_turn_too_large'
    || reason === 'tool_result_memory_limit'
    || reason === 'provider_context_overflow_repeated'
    || reason === 'provider_request_byte_limit_repeated';
}

function toolStatusText(
  toolName: string,
  risk: 'read' | 'suggest' | 'write',
  labels: Readonly<{
    agentReadingData: string;
    agentPreparingOrganizationScope: string;
    agentApplyingChanges: string;
  }>,
): string {
  if (getBgsmAgentToolDefinition(toolName)?.presentation === 'organization') {
    return labels.agentPreparingOrganizationScope;
  }
  return risk === 'write' ? labels.agentApplyingChanges : labels.agentReadingData;
}
