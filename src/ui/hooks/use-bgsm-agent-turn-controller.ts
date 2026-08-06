import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { AgentErrorCategory } from '@/agent-harness';
import {
  bindBgsmAgentSession,
  createBgsmAgentTurnInput,
  type BgsmAgentSession,
  type BgsmAgentSessionMessage,
} from '@/bgsm-agent/session';
import type { BgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import { getBgsmAgentToolDefinition } from '@/bgsm-agent/tool-catalog';
import type {
  AgentRetryDraft,
  AgentRetryDraftKind,
  AgentSessionCommitResult,
  LoadedAgentSession,
} from '@/storage/agent-session-store';
import {
  canSafelyRetryPendingTurn,
  canSafelyRetrySettledPendingTurn,
  retryDraftKindForResult,
  trackPendingWriteOutcome,
  type PendingRetryAuthority,
  type PendingWriteOutcome,
} from '@/ui/bgsm-agent-retry-policy';
import { classifySessionLoadFailure, isEmptyToolCallEnvelope } from '@/ui/bgsm-agent-session-projection';
import type { BgsmAgentChatMessage } from '@/ui/bgsm-agent-session-projection';
import type { HydratedActiveTurn } from '@/ui/bgsm-agent-retry-recovery';
import type {
  AgentTurnAction,
  AgentTurnState,
  BgsmAgentActionableContextFailureReason,
  BgsmAgentStatus,
  BgsmAgentToolActivity,
} from '@/ui/agent-turn-state';
import {
  loadDurableBgsmAgentSession,
  startBgsmAgentTurn,
  type BgsmAgentTurnAck,
  type BgsmAgentTurnEvent,
  type BgsmAgentTurnHandlers,
  type BgsmAgentTurnResult,
} from '@/utils/messaging';

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

type TurnLabels = Readonly<{
  agentCompacting: string;
  agentDone: string;
  agentQueued: string;
  agentStarting: string;
  agentStopped: string;
  agentThinking: string;
  agentWriting: string;
  agentReadingData: string;
  agentPreparingOrganizationScope: string;
  agentApplyingChanges: string;
  attemptResumeStateUnknown: string;
  attemptStateLost: string;
  turnFailed: string;
}>;

type TurnSessionAdapter = Readonly<{
  sessionRef: MutableRefObject<BgsmAgentSession>;
  conversationBindingRef: MutableRefObject<BgsmAgentConversationBinding | null>;
  getHydrationPromise: () => Promise<void>;
  getPersistence: () => 'pending' | 'durable' | 'memory';
  getActiveSessionId: () => string;
  isOperationPending: () => boolean;
  ready: boolean;
  initializationFailed: boolean;
  recoverCommittedTurn: (pending: PendingTurn) => Promise<BgsmAgentTurnResult | null>;
  adoptCommit: (committed: AgentSessionCommitResult, pending: PendingTurn) => void;
  failPersistence: () => void;
  recoverUnavailable: (sessionId: string) => Promise<HydratedActiveTurn | null>;
  publishHydratedTurn: (turn: HydratedActiveTurn | null) => void;
  reconcileCanonical: (loaded: LoadedAgentSession) => void;
}>;

type TurnRetryAdapter = Readonly<{
  draftRef: MutableRefObject<AgentRetryDraft | null>;
  setActive: (draft: AgentRetryDraft | null) => void;
  forget: (sessionId: string, expected?: AgentRetryDraft) => void;
  settle: (
    pending: Pick<PendingTurn, 'sessionId' | 'turnAttemptId' | 'baseRevision' | 'prompt'>,
    kind: AgentRetryDraftKind,
    canRetry: boolean,
    settlement?: AgentRetryDraft['settlement'],
  ) => void;
  refresh: (sessionId: string) => void;
}>;

type TurnPresentationAdapter = Readonly<{
  turnStateRef: MutableRefObject<AgentTurnState>;
  dispatch: (action: AgentTurnAction) => void;
  setMessages: Dispatch<SetStateAction<BgsmAgentChatMessage[]>>;
  setConversationBinding: Dispatch<SetStateAction<BgsmAgentConversationBinding | null>>;
}>;

export type UseBgsmAgentTurnControllerOptions = Readonly<{
  pendingTurnRef: MutableRefObject<PendingTurn | null>;
  session: TurnSessionAdapter;
  retry: TurnRetryAdapter;
  presentation: TurnPresentationAdapter;
  labels: TurnLabels;
  candidateContract?: BgsmAgentConversationCandidate;
  hydratedActiveTurn: HydratedActiveTurn | null;
  onHydratedTurnSettled: (turn: HydratedActiveTurn) => void;
  onDataChanged?: () => void;
}>;

export type BgsmAgentTurnStartOptions = Readonly<{
  retrySourceAttemptId?: string;
  resumedTurn?: HydratedActiveTurn;
}>;

export type BgsmAgentTurnController = Readonly<{
  startTurn: (
    prompt: string,
    options?: BgsmAgentTurnStartOptions,
  ) => Promise<BgsmAgentTurnResult | null>;
  stopTurn: () => void;
  stopAndDetachPendingTurn: () => void;
  editContextLimitedPrompt: () => void;
}>;

const STOP_SETTLE_TIMEOUT_MS = 3_000;

export function useBgsmAgentTurnController(
  options: UseBgsmAgentTurnControllerOptions,
): BgsmAgentTurnController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const turnSequenceRef = useRef(0);

  const clearCompactionUi = useCallback((pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    if (!compaction) return;
    if (compaction.timer !== null) clearTimeout(compaction.timer);
    pending.compactionUi = null;
  }, []);

  const startCompactionUi = useCallback((pending: PendingTurn) => {
    if (pending.compactionUi) return;
    const { pendingTurnRef, presentation, labels } = optionsRef.current;
    const compaction: PendingCompactionUi = { timer: null, visible: false };
    pending.compactionUi = compaction;
    presentation.dispatch({ type: 'compaction_started' });
    compaction.timer = setTimeout(() => {
      if (pendingTurnRef.current !== pending || pending.compactionUi !== compaction) return;
      compaction.timer = null;
      compaction.visible = true;
      presentation.dispatch({
        type: 'compaction_shown',
        status: { kind: 'compacting', text: labels.agentCompacting },
      });
    }, 300);
  }, []);

  const finishCompactionUi = useCallback((pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    clearCompactionUi(pending);
    const { pendingTurnRef, presentation, labels } = optionsRef.current;
    if (!compaction || pendingTurnRef.current !== pending) return;
    presentation.dispatch({
      type: 'compaction_finished',
      restore: compaction.visible,
      fallbackStatus: { kind: 'working', text: labels.agentThinking },
    });
  }, [clearCompactionUi]);

  const appendAssistantError = useCallback((content: string, pending: PendingTurn) => {
    const id = `${pending.token}:error:${pending.transientMessageIds.size + 1}`;
    pending.transientMessageIds.add(id);
    optionsRef.current.presentation.setMessages((current) => [
      ...current,
      { id, role: 'assistant', content, createdAt: Date.now() },
    ]);
  }, []);

  const appendAgentMessage = useCallback((
    message: BgsmAgentSessionMessage,
    pending: PendingTurn,
  ) => {
    if (message.role === 'user' || isEmptyToolCallEnvelope(message)) return;
    pending.transientMessageIds.add(message.id);
    optionsRef.current.presentation.setMessages((current) => {
      const nextMessage: BgsmAgentChatMessage = {
        id: message.id,
        role: message.role === 'agent' ? 'assistant' : 'tool',
        content: message.content,
        createdAt: message.createdAt,
        toolName: message.toolName,
      };
      const existingIndex = current.findIndex((item) => item.id === nextMessage.id);
      if (existingIndex === -1) return [...current, nextMessage];
      return current.map((item, index) => (index === existingIndex ? nextMessage : item));
    });
  }, []);

  const rollbackPendingMessages = useCallback((pending: PendingTurn) => {
    const rollbackIds = new Set([pending.optimisticMessageId, ...pending.transientMessageIds]);
    pending.streamMessageId = null;
    pending.streamStep = null;
    pending.streamContent = '';
    pending.streamFlushScheduled = false;
    optionsRef.current.presentation.setMessages(
      (current) => current.filter((message) => !rollbackIds.has(message.id)),
    );
  }, []);

  const restoreCommittedBinding = useCallback(() => {
    const { session, presentation } = optionsRef.current;
    const binding = session.sessionRef.current.binding ?? null;
    session.conversationBindingRef.current = binding;
    presentation.setConversationBinding(binding);
  }, []);

  const setAgentStatus = useCallback((status: BgsmAgentStatus | null) => {
    optionsRef.current.presentation.dispatch({ type: 'status_changed', status });
  }, []);

  const updateToolActivity = useCallback((activity: BgsmAgentToolActivity) => {
    optionsRef.current.presentation.dispatch({ type: 'tool_activity_updated', activity });
  }, []);

  const removeToolActivity = useCallback((callId: string) => {
    optionsRef.current.presentation.dispatch({ type: 'tool_activity_removed', callId });
  }, []);

  const appendStreamDelta = useCallback((pending: PendingTurn, step: number, delta: string) => {
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
      pending.streamFlushScheduled = false;
      const { pendingTurnRef, presentation } = optionsRef.current;
      if (pendingTurnRef.current !== pending || !pending.streamMessageId) return;
      const messageId = pending.streamMessageId;
      const content = pending.streamContent;
      presentation.setMessages((current) => {
        const withoutPrevious = previousId && previousId !== messageId
          ? current.filter((message) => message.id !== previousId)
          : current;
        const index = withoutPrevious.findIndex((message) => message.id === messageId);
        const nextMessage: BgsmAgentChatMessage = {
          id: messageId,
          role: 'assistant',
          content,
          createdAt: pending.startedAt,
          streaming: true,
        };
        if (index === -1) return [...withoutPrevious, nextMessage];
        return withoutPrevious.map((message, messageIndex) => (
          messageIndex === index ? nextMessage : message
        ));
      });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else queueMicrotask(flush);
  }, []);

  const clearCurrentStreamMessage = useCallback((pending: PendingTurn) => {
    const streamMessageId = pending.streamMessageId;
    if (!streamMessageId) return;
    optionsRef.current.presentation.setMessages(
      (current) => current.filter((message) => message.id !== streamMessageId),
    );
    pending.streamMessageId = null;
    pending.streamStep = null;
    pending.streamContent = '';
    pending.streamFlushScheduled = false;
  }, []);

  const isCurrentDelivery = useCallback((
    pending: PendingTurn,
    delivery: { turnAttemptId: string; sessionId: string; baseRevision: number },
  ) => {
    const { pendingTurnRef, session } = optionsRef.current;
    const currentSession = session.sessionRef.current;
    return pendingTurnRef.current === pending
      && delivery.sessionId === pending.sessionId
      && delivery.baseRevision === pending.baseRevision
      && delivery.turnAttemptId === pending.turnAttemptId
      && currentSession.id === pending.sessionId
      && currentSession.revision === pending.baseRevision;
  }, []);

  const markRetryAttemptAccepted = useCallback((pending: PendingTurn) => {
    if (!pending.sourceRetryDraft) return;
    pending.retryAuthority = 'recovered_retry';
    // Admission consumed the source inside the background transaction. Clear
    // only the local projection; subsequent state comes from a read.
    pending.sourceRetryDraft = null;
    const { retry, session } = optionsRef.current;
    if (session.getActiveSessionId() === pending.sessionId) retry.setActive(null);
  }, []);

  const failPendingTurn = useCallback((
    pending: PendingTurn,
    message: string,
    category: AgentErrorCategory,
    result: BgsmAgentTurnResult | null = null,
    canRetry = canSafelyRetryPendingTurn(pending),
  ) => {
    const { session, presentation, retry } = optionsRef.current;
    // Recovery may replace the active session while this callback is awaiting.
    if (session.sessionRef.current.id !== pending.sessionId) return;
    rollbackPendingMessages(pending);
    restoreCommittedBinding();
    presentation.dispatch({
      type: 'turn_failed',
      result,
      message,
      category,
      status: { kind: 'error', text: message },
      prompt: pending.prompt,
      canRetry,
    });
    retry.settle(pending, 'failed', canRetry);
    appendAssistantError(message, pending);
  }, [appendAssistantError, restoreCommittedBinding, rollbackPendingMessages]);

  const finishTurn = useCallback((
    pending: PendingTurn,
    result: BgsmAgentTurnResult | null,
    canRetryOverride?: boolean,
  ) => {
    const { pendingTurnRef, presentation, labels, onDataChanged } = optionsRef.current;
    if (pendingTurnRef.current !== pending) return false;
    clearCompactionUi(pending);
    if (pending.stopFallbackTimer !== null) {
      clearTimeout(pending.stopFallbackTimer);
      pending.stopFallbackTimer = null;
    }
    pendingTurnRef.current = null;
    if (presentation.turnStateRef.current.running) {
      if (result) {
        presentation.dispatch({
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
        presentation.dispatch({ type: 'turn_detached' });
      }
    }
    if (result?.changed) onDataChanged?.();
    pending.resolve(result);
    return true;
  }, [clearCompactionUi]);

  const handleEvent = useCallback((event: BgsmAgentTurnEvent, pending: PendingTurn) => {
    if (!isCurrentDelivery(pending, event)) return;
    const { labels, presentation, retry, session } = optionsRef.current;
    if (event.type === 'agent_start') markRetryAttemptAccepted(pending);
    const writeOutcomeChanged = trackPendingWriteOutcome(pending, event);
    if (pending.stopRequested && event.type !== 'agent_done') {
      if (writeOutcomeChanged) {
        const canPreserveDraft = canSafelyRetrySettledPendingTurn(pending);
        if (!pending.sourceRetryDraft) {
          retry.settle(pending, 'stopped', canPreserveDraft, 'stop_pending');
        }
        presentation.dispatch({
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
        bindBgsmAgentSession(session.sessionRef.current, event.binding);
        pending.binding = event.binding;
        session.conversationBindingRef.current = event.binding;
        presentation.setConversationBinding(event.binding);
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
          // Tool failures remain available to the model while the turn continues.
          removeToolActivity(event.callId);
          setAgentStatus({ kind: 'working', text: labels.agentThinking });
          break;
        }
        updateToolActivity({ callId: event.callId, toolName: event.toolName, state: 'completed' });
        setAgentStatus({ kind: 'working', text: labels.agentThinking });
        break;
      case 'agent_error':
        presentation.dispatch({
          type: 'error_observed',
          message: event.message,
          category: event.category ?? 'other',
          status: { kind: 'error', text: event.message },
        });
        appendAssistantError(event.message, pending);
        break;
      case 'approval_required':
        presentation.dispatch({
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
            retry.settle(pending, 'stopped', canPreserveDraft, 'stop_pending');
          }
          presentation.dispatch({
            type: 'stop_requested',
            prompt: pending.prompt,
            canRetry: false,
            status: { kind: 'stopped', text: labels.agentStopped },
          });
        }
        break;
    }
  }, [
    appendAgentMessage,
    appendAssistantError,
    appendStreamDelta,
    clearCurrentStreamMessage,
    finishCompactionUi,
    isCurrentDelivery,
    markRetryAttemptAccepted,
    removeToolActivity,
    rollbackPendingMessages,
    setAgentStatus,
    startCompactionUi,
    updateToolActivity,
  ]);

  const stopTurn = useCallback(() => {
    const { pendingTurnRef, presentation, retry, labels } = optionsRef.current;
    const pending = pendingTurnRef.current;
    if (!pending || pending.stopRequested) return;
    pending.stopRequested = true;
    clearCompactionUi(pending);
    pending.stop();
    rollbackPendingMessages(pending);
    restoreCommittedBinding();
    const canRetry = canSafelyRetrySettledPendingTurn(pending);
    retry.settle(pending, 'stopped', canRetry, 'stop_pending');
    presentation.dispatch({
      type: 'stop_requested',
      prompt: pending.prompt,
      canRetry: false,
      status: { kind: 'stopped', text: labels.agentStopped },
    });
    if (pending.stopFallbackTimer === null) {
      pending.stopFallbackTimer = setTimeout(() => {
        if (optionsRef.current.pendingTurnRef.current !== pending) return;
        pending.detach();
        finishTurn(pending, null);
      }, STOP_SETTLE_TIMEOUT_MS);
    }
  }, [clearCompactionUi, finishTurn, restoreCommittedBinding, rollbackPendingMessages]);

  const startTurn = useCallback(async (
    prompt: string,
    startOptions: BgsmAgentTurnStartOptions = {},
  ): Promise<BgsmAgentTurnResult | null> => {
    const resumedTurn = startOptions.resumedTurn;
    await optionsRef.current.session.getHydrationPromise();
    const options = optionsRef.current;
    const clean = prompt.trim();
    if (
      !options.session.ready
      || options.session.initializationFailed
      || !clean
      || options.pendingTurnRef.current
      || options.session.isOperationPending()
      || (options.hydratedActiveTurn !== null && !resumedTurn)
    ) return null;

    const session = options.session.sessionRef.current;
    if (
      resumedTurn
      && (
        resumedTurn.turn.launch.sessionId !== session.id
        || resumedTurn.turn.launch.baseRevision !== session.revision
        || resumedTurn.turn.launch.prompt.trim() !== clean
      )
    ) return null;
    const activeDraft = options.retry.draftRef.current;
    const sourceRetryDraft = resumedTurn?.sourceRetryDraft ?? (
      activeDraft?.sessionId === session.id
      && activeDraft.baseRevision === session.revision
      && activeDraft.settlement === 'retryable'
      && activeDraft.prompt.trim() === clean
        ? activeDraft
        : null
    );
    if (!resumedTurn && !sourceRetryDraft && activeDraft?.sessionId === session.id) {
      options.retry.forget(session.id, activeDraft);
    }
    const turnSequence = ++turnSequenceRef.current;
    const turnEntropy = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}_${turnSequence}_${Math.random().toString(36).slice(2)}`;
    const token = resumedTurn?.turn.launch.turnAttemptId ?? `${session.id}:turn:${turnEntropy}`;
    let retryAuthority: PendingRetryAuthority = resumedTurn?.retryAuthority ?? 'fresh';
    if (!resumedTurn && sourceRetryDraft && options.session.getPersistence() === 'durable') {
      // Background admission atomically transfers this retry authority to the
      // new attempt, avoiding a reload gap with no recoverable owner.
      retryAuthority = 'recovered_retry';
    }
    const optimisticMessageId = `${token}:user`;
    const startedAt = Date.now();
    options.presentation.dispatch({
      type: 'turn_started',
      status: { kind: 'queued', text: options.labels.agentQueued },
    });
    options.presentation.setMessages((current) => (
      current.some((message) => message.id === optimisticMessageId)
        ? current
        : [...current, {
            id: optimisticMessageId,
            role: 'user',
            content: clean,
            createdAt: startedAt,
          }]
    ));

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
      options.pendingTurnRef.current = pending;

      try {
        const turnInput = resumedTurn?.turn.launch ?? (
          options.session.getPersistence() === 'durable'
            ? {
                turnAttemptId: token,
                sessionId: session.id,
                baseRevision: session.revision,
                prompt: clean,
                ...(startOptions.retrySourceAttemptId
                  ? { retrySourceAttemptId: startOptions.retrySourceAttemptId }
                  : {}),
                ...(!session.binding && options.candidateContract
                  ? { candidateContract: options.candidateContract }
                  : {}),
              }
            : createBgsmAgentTurnInput(
                session,
                clean,
                options.candidateContract,
                () => token,
              )
        );
        const processResult = async (deliveredResult: BgsmAgentTurnResult): Promise<void> => {
          if (!isCurrentDelivery(pending, deliveredResult)) return;
          let result = deliveredResult;
          const currentOptions = optionsRef.current;

          if (result.reason === 'attempt_state_lost') {
            try {
              const recovered = await currentOptions.session.recoverCommittedTurn(pending);
              if (currentOptions.pendingTurnRef.current !== pending) return;
              if (recovered) result = recovered;
              else {
                pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
                const canRetry = canSafelyRetryPendingTurn(pending);
                failPendingTurn(
                  pending,
                  pending.retryAuthority !== 'fresh'
                    ? currentOptions.labels.attemptResumeStateUnknown
                    : currentOptions.labels.attemptStateLost,
                  'other',
                  null,
                  canRetry,
                );
                finishTurn(pending, null);
                return;
              }
            } catch {
              if (currentOptions.pendingTurnRef.current !== pending) return;
              currentOptions.session.failPersistence();
              pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
              failPendingTurn(
                pending,
                currentOptions.labels.attemptResumeStateUnknown,
                'other',
                null,
                false,
              );
              finishTurn(pending, null);
              return;
            }
          }

          const committed = result.commit;
          if (committed) {
            // The background commit is authoritative even if local projection
            // adoption discovers that another render already applied it.
            currentOptions.session.adoptCommit(committed, pending);
            pending.acknowledge({
              disposition: 'applied',
              appliedRevision: committed.appliedRevision,
            });
          } else {
            pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
            rollbackPendingMessages(pending);
            restoreCommittedBinding();
          }

          const retryDraftKind = retryDraftKindForResult(result);
          const memoryRetryAvailable = currentOptions.session.getPersistence() === 'memory'
            && canSafelyRetrySettledPendingTurn(pending);
          // A durable result remains pending until the background projection is
          // read. The draft gate prevents a retry without a source identity.
          const retryAvailable = retryDraftKind !== null && (
            currentOptions.session.getPersistence() === 'durable' || memoryRetryAvailable
          );
          if (retryDraftKind) {
            currentOptions.retry.settle(pending, retryDraftKind, memoryRetryAvailable);
          } else {
            const draft = currentOptions.retry.draftRef.current?.sessionId === pending.sessionId
              ? currentOptions.retry.draftRef.current
              : null;
            if (draft) currentOptions.retry.forget(pending.sessionId, draft);
            currentOptions.retry.refresh(pending.sessionId);
          }

          if (result.reason === 'context_limit' || result.contextFailureReason) {
            if (isActionableContextFailure(result.contextFailureReason)) {
              currentOptions.presentation.dispatch({
                type: 'context_recovery_required',
                result,
                recovery: { prompt, reason: result.contextFailureReason },
                prompt: pending.prompt,
                canRetry: retryAvailable,
              });
            } else {
              currentOptions.presentation.dispatch({
                type: 'turn_failed',
                result,
                message: currentOptions.labels.turnFailed,
                category: 'provider',
                status: { kind: 'error', text: currentOptions.labels.turnFailed },
                prompt: pending.prompt,
                canRetry: retryAvailable,
              });
              appendAssistantError(currentOptions.labels.turnFailed, pending);
            }
            finishTurn(pending, result, retryAvailable);
            return;
          }
          finishTurn(pending, result, retryAvailable);
        };
        const turnHandlers: BgsmAgentTurnHandlers = {
          onEvent: (event) => handleEvent(event, pending),
          onResult: processResult,
          onError: async (delivery) => {
            if (!isCurrentDelivery(pending, delivery)) return;
            const currentOptions = optionsRef.current;
            let recoveredHydratedTurn: HydratedActiveTurn | null | undefined;
            const finishAfterRecovery = () => {
              // Publish a replacement turn only after releasing the old pending
              // ref, otherwise the hydration effect can miss its only wakeup.
              if (
                finishTurn(pending, null)
                && recoveredHydratedTurn !== undefined
              ) {
                optionsRef.current.session.publishHydratedTurn(recoveredHydratedTurn);
              }
            };
            if (pending.retryAuthority !== 'fresh' || pending.sourceRetryDraft !== null) {
              try {
                const recovered = await currentOptions.session.recoverCommittedTurn(pending);
                if (currentOptions.pendingTurnRef.current !== pending) return;
                if (recovered) {
                  await processResult(recovered);
                  return;
                }
              } catch {
                if (currentOptions.pendingTurnRef.current !== pending) return;
                currentOptions.session.failPersistence();
              }
            }
            pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
            currentOptions.retry.refresh(pending.sessionId);
            if (
              delivery.code === 'agent_session_not_found'
              || delivery.code === 'agent_session_revision_conflict'
              || delivery.code === 'agent_session_corrupt'
            ) {
              try {
                if (
                  delivery.code === 'agent_session_not_found'
                  || delivery.code === 'agent_session_corrupt'
                ) {
                  recoveredHydratedTurn = await currentOptions.session.recoverUnavailable(
                    pending.sessionId,
                  );
                } else {
                  currentOptions.session.reconcileCanonical(
                    await loadDurableBgsmAgentSession(pending.sessionId),
                  );
                }
              } catch (recoveryError) {
                if (['not_found', 'corrupt'].includes(classifySessionLoadFailure(recoveryError))) {
                  try {
                    recoveredHydratedTurn = await currentOptions.session.recoverUnavailable(
                      pending.sessionId,
                    );
                  } catch {
                    currentOptions.session.failPersistence();
                  }
                } else {
                  currentOptions.session.failPersistence();
                }
              }
            }
            if (optionsRef.current.pendingTurnRef.current !== pending) return;
            if (pending.stopRequested) {
              finishAfterRecovery();
              return;
            }
            const text = delivery.message || currentOptions.labels.turnFailed;
            failPendingTurn(
              pending,
              text,
              delivery.category ?? 'other',
              null,
              canSafelyRetryPendingTurn(pending),
            );
            finishAfterRecovery();
          },
        };
        const control = resumedTurn
          ? startBgsmAgentTurn(turnInput, turnHandlers, {
              expectedExecutionEpochId: resumedTurn.turn.executionEpochId,
              resumeOnly: true,
            })
          : startBgsmAgentTurn(turnInput, turnHandlers);
        if (optionsRef.current.pendingTurnRef.current === pending) {
          pending.stop = control.stop;
          pending.detach = typeof control.detach === 'function' ? control.detach : () => {};
          pending.acknowledge = control.acknowledge;
          if (pending.retryAuthority === 'recovered_stop') {
            const currentOptions = optionsRef.current;
            pending.stopRequested = true;
            pending.stop();
            rollbackPendingMessages(pending);
            restoreCommittedBinding();
            currentOptions.presentation.dispatch({
              type: 'stop_requested',
              prompt: pending.prompt,
              canRetry: false,
              status: { kind: 'stopped', text: currentOptions.labels.agentStopped },
            });
            pending.stopFallbackTimer = setTimeout(() => {
              if (optionsRef.current.pendingTurnRef.current !== pending) return;
              pending.detach();
              finishTurn(pending, null);
            }, STOP_SETTLE_TIMEOUT_MS);
          }
        } else {
          control.detach();
        }
      } catch (error) {
        if (optionsRef.current.pendingTurnRef.current !== pending) return;
        const currentOptions = optionsRef.current;
        if (pending.retryAuthority === 'recovered_stop') {
          rollbackPendingMessages(pending);
          restoreCommittedBinding();
          currentOptions.presentation.dispatch({
            type: 'stop_requested',
            prompt: pending.prompt,
            canRetry: false,
            status: { kind: 'stopped', text: currentOptions.labels.agentStopped },
          });
          finishTurn(pending, null);
          return;
        }
        const message = error instanceof Error ? error.message : currentOptions.labels.turnFailed;
        failPendingTurn(pending, message, 'other', null, canSafelyRetryPendingTurn(pending));
        finishTurn(pending, null);
      }
    });
  }, [
    appendAssistantError,
    failPendingTurn,
    finishTurn,
    handleEvent,
    isCurrentDelivery,
    restoreCommittedBinding,
    rollbackPendingMessages,
  ]);

  const editContextLimitedPrompt = useCallback(() => {
    optionsRef.current.presentation.dispatch({ type: 'context_recovery_dismissed' });
  }, []);

  const stopAndDetachPendingTurn = useCallback(() => {
    const { pendingTurnRef } = optionsRef.current;
    const pending = pendingTurnRef.current;
    pendingTurnRef.current = null;
    if (!pending) return;
    clearCompactionUi(pending);
    if (pending.stopFallbackTimer !== null) clearTimeout(pending.stopFallbackTimer);
    pending.resolve(null);
    pending.stop();
    pending.detach();
  }, [clearCompactionUi]);

  useEffect(() => () => {
    const { pendingTurnRef } = optionsRef.current;
    const pending = pendingTurnRef.current;
    pendingTurnRef.current = null;
    if (!pending) return;
    clearCompactionUi(pending);
    if (pending.stopFallbackTimer !== null) clearTimeout(pending.stopFallbackTimer);
    pending.resolve(null);
    pending.detach();
  }, [clearCompactionUi]);

  const hydratedActiveTurn = options.hydratedActiveTurn;
  const sessionReady = options.session.ready;
  useEffect(() => {
    if (!hydratedActiveTurn || !sessionReady || optionsRef.current.pendingTurnRef.current) return;
    let settled = false;
    void startTurn(hydratedActiveTurn.turn.launch.prompt, {
      resumedTurn: hydratedActiveTurn,
    }).finally(() => {
      if (!settled) optionsRef.current.onHydratedTurnSettled(hydratedActiveTurn);
    });
    return () => {
      settled = true;
    };
  }, [hydratedActiveTurn, sessionReady, startTurn]);

  return { startTurn, stopTurn, stopAndDetachPendingTurn, editContextLimitedPrompt };
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
  labels: Pick<
    TurnLabels,
    'agentReadingData' | 'agentPreparingOrganizationScope' | 'agentApplyingChanges'
  >,
): string {
  if (getBgsmAgentToolDefinition(toolName)?.presentation === 'organization') {
    return labels.agentPreparingOrganizationScope;
  }
  return risk === 'write' ? labels.agentApplyingChanges : labels.agentReadingData;
}
