import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  startBgsmAgentTurn,
  type BgsmAgentTurnAck,
  type BgsmAgentTurnEvent,
  type BgsmAgentTurnResult,
} from '@/utils/messaging';
import {
  applyBgsmAgentSessionTransition,
  bindBgsmAgentSession,
  createBgsmAgentSession,
  createBgsmAgentTurnInput,
  type BgsmAgentSession,
} from '@/bgsm-agent/session';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import type { BgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';
import { useI18n } from '@/i18n';
import type { AgentErrorCategory } from '@/agent-harness';
import { getBgsmAgentToolDefinition } from '@/bgsm-agent/tool-catalog';
import {
  createAgentTurnState,
  reduceAgentTurn,
  type BgsmAgentActionableContextFailureReason,
  type BgsmAgentStatus,
  type BgsmAgentToolActivity,
  type AgentTurnAction,
} from '@/ui/agent-turn-state';

export type {
  BgsmAgentContextLimitRecovery,
  BgsmAgentStatus,
  BgsmAgentToolActivity,
} from '@/ui/agent-turn-state';

export type BgsmAgentChatMessage = {
  id: string;
  role: 'assistant' | 'user' | 'tool';
  content: string;
  createdAt: number;
  toolName?: string;
  streaming?: boolean;
};

export type BgsmAgentSessionSummary = Readonly<{
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}>;

type PendingCompactionUi = {
  timer: ReturnType<typeof setTimeout> | null;
  visible: boolean;
};

type PendingTurn = {
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
  writeOutcomes: Map<string, 'in_flight' | 'committed' | 'failed' | 'unknown'>;
  stopRequested: boolean;
  stopFallbackTimer: ReturnType<typeof setTimeout> | null;
  stop: (options?: Readonly<{ detach?: boolean }>) => void;
  acknowledge: (ack: BgsmAgentTurnAck) => void;
  resolve: (result: BgsmAgentTurnResult | null) => void;
  compactionUi: PendingCompactionUi | null;
};

type AgentSessionRecord = {
  summary: BgsmAgentSessionSummary;
  session: BgsmAgentSession;
  messages: BgsmAgentChatMessage[];
  conversationBinding: BgsmAgentConversationBinding | null;
};

type AgentSessionStore = {
  records: Map<string, AgentSessionRecord>;
  activeSessionId: string;
};

const SESSION_TITLE_MAX_LENGTH = 32;

const STOP_SETTLE_TIMEOUT_MS = 3_000;

function canReplayPendingTurn(pending: Pick<PendingTurn, 'writeOutcomes'>): boolean {
  return [...pending.writeOutcomes.values()].every((outcome) => outcome === 'failed');
}

export function useBgsmAgent(
  onDataChanged?: () => void,
  candidateContract?: BgsmAgentConversationCandidate,
) {
  const { m } = useI18n();
  const sessionStoreRef = useRef<AgentSessionStore | null>(null);
  if (!sessionStoreRef.current) {
    const session = createBgsmAgentSession();
    const now = Date.now();
    const record: AgentSessionRecord = {
      summary: {
        id: session.id,
        title: '',
        createdAt: now,
        updatedAt: now,
      },
      session,
      messages: [],
      conversationBinding: null,
    };
    sessionStoreRef.current = {
      records: new Map([[session.id, record]]),
      activeSessionId: session.id,
    };
  }
  const sessionStore = sessionStoreRef.current!;
  const initialRecord = sessionStore.records.get(sessionStore.activeSessionId)!;
  const [activeSessionId, setActiveSessionId] = useState(sessionStore.activeSessionId);
  const [sessionList, setSessionList] = useState<BgsmAgentSessionSummary[]>(() => (
    [...sessionStore.records.values()].map((record) => record.summary)
  ));
  const [messages, setMessages] = useState<BgsmAgentChatMessage[]>(initialRecord.messages);
  const [turnState, dispatchTurn] = useReducer(
    reduceAgentTurn,
    undefined,
    createAgentTurnState,
  );
  const {
    running,
    status,
    error,
    errorCategory,
    lastTurnResult,
    contextLimitRecovery,
    draftRecovery,
    canRetryLastTurn,
    toolActivities,
  } = turnState;
  const [conversationBinding, setConversationBinding] = useState<BgsmAgentConversationBinding | null>(
    initialRecord.conversationBinding,
  );
  const sessionRef = useRef<BgsmAgentSession>(initialRecord.session);
  const messagesRef = useRef(messages);
  const conversationBindingRef = useRef(conversationBinding);
  const turnStateRef = useRef(turnState);
  turnStateRef.current = turnState;
  const pendingTurnRef = useRef<PendingTurn | null>(null);
  const turnSequenceRef = useRef(0);
  const sessionId = activeSessionId;

  const dispatchTurnTracked = useCallback((action: AgentTurnAction) => {
    turnStateRef.current = reduceAgentTurn(turnStateRef.current, action);
    dispatchTurn(action);
  }, []);

  const publishSessionList = useCallback(() => {
    const store = sessionStoreRef.current;
    if (!store) return;
    setSessionList([...store.records.values()].map((record) => record.summary));
  }, []);

  const syncActiveSessionRecord = useCallback(() => {
    const store = sessionStoreRef.current;
    if (!store) return;
    const record = store.records.get(store.activeSessionId);
    if (!record) return;
    record.session = sessionRef.current;
    record.messages = messagesRef.current;
    record.conversationBinding = conversationBindingRef.current;
  }, []);

  const updateCurrentSession = useCallback((session: BgsmAgentSession) => {
    sessionRef.current = session;
    const store = sessionStoreRef.current;
    const record = store?.records.get(store.activeSessionId);
    if (record) record.session = session;
  }, []);

  const setAgentStatus = useCallback((next: BgsmAgentStatus | null) => {
    dispatchTurnTracked({ type: 'status_changed', status: next });
  }, [dispatchTurnTracked]);

  const clearCompactionUi = useCallback((pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    if (!compaction) return;
    if (compaction.timer !== null) clearTimeout(compaction.timer);
    pending.compactionUi = null;
  }, []);

  const startCompactionUi = useCallback((pending: PendingTurn) => {
    if (pending.compactionUi) return;
    const compaction: PendingCompactionUi = {
      timer: null,
      visible: false,
    };
    pending.compactionUi = compaction;
    dispatchTurnTracked({ type: 'compaction_started' });
    compaction.timer = setTimeout(() => {
      if (pendingTurnRef.current !== pending || pending.compactionUi !== compaction) return;
      compaction.timer = null;
      compaction.visible = true;
      dispatchTurnTracked({
        type: 'compaction_shown',
        status: { kind: 'compacting', text: m.agentPanel.agentCompacting },
      });
    }, 300);
  }, [dispatchTurnTracked, m.agentPanel.agentCompacting]);

  const finishCompactionUi = useCallback((pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    clearCompactionUi(pending);
    if (!compaction || pendingTurnRef.current !== pending) return;
    dispatchTurnTracked({
      type: 'compaction_finished',
      restore: compaction.visible,
      fallbackStatus: { kind: 'working', text: m.agentPanel.agentThinking },
    });
  }, [clearCompactionUi, dispatchTurnTracked, m.agentPanel.agentThinking]);

  useEffect(() => {
    messagesRef.current = messages;
    const store = sessionStoreRef.current;
    const record = store?.records.get(store.activeSessionId);
    if (record) record.messages = messages;
  }, [messages]);

  useEffect(() => {
    conversationBindingRef.current = conversationBinding;
    const store = sessionStoreRef.current;
    const record = store?.records.get(store.activeSessionId);
    if (record) record.conversationBinding = conversationBinding;
  }, [conversationBinding]);

  useEffect(() => () => {
    const pending = pendingTurnRef.current;
    pendingTurnRef.current = null;
    if (pending) {
      clearCompactionUi(pending);
      if (pending.stopFallbackTimer !== null) clearTimeout(pending.stopFallbackTimer);
    }
    pending?.resolve(null);
    pending?.stop({ detach: true });
  }, [clearCompactionUi]);

  const appendAssistantError = useCallback((content: string, pending: PendingTurn) => {
    const id = `${pending.token}:error:${pending.transientMessageIds.size + 1}`;
    pending.transientMessageIds.add(id);
    setMessages((current) => [
      ...current,
      {
        id,
        role: 'assistant',
        content,
        createdAt: Date.now(),
      },
    ]);
  }, []);

  const appendAgentMessage = useCallback((
    message: BgsmAgentTurnResult['newMessages'][number],
    pending: PendingTurn,
  ) => {
    if (message.role === 'user') return;
    if (isEmptyToolCallEnvelope(message)) return;
    pending.transientMessageIds.add(message.id);
    setMessages((current) => {
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
    const rollbackIds = new Set([
      pending.optimisticMessageId,
      ...pending.transientMessageIds,
    ]);
    pending.streamMessageId = null;
    pending.streamStep = null;
    pending.streamContent = '';
    pending.streamFlushScheduled = false;
    setMessages((current) => current.filter((message) => !rollbackIds.has(message.id)));
  }, []);

  const reconcileFinalMessages = useCallback((
    pending: PendingTurn,
    result: BgsmAgentTurnResult,
  ) => {
    const rollbackIds = new Set([
      pending.optimisticMessageId,
      ...pending.transientMessageIds,
    ]);
    const committed = result.newMessages
      .filter((message) => !isEmptyToolCallEnvelope(message))
      .map(toChatMessage);
    setMessages((current) => [
      ...current.filter((message) => !rollbackIds.has(message.id)),
      ...committed,
    ]);
  }, []);

  const failPendingTurn = useCallback((
    pending: PendingTurn,
    message: string,
    category: AgentErrorCategory,
    result: BgsmAgentTurnResult | null = null,
  ) => {
    rollbackPendingMessages(pending);
    dispatchTurnTracked({
      type: 'turn_failed',
      result,
      message,
      category,
      status: { kind: 'error', text: message },
      prompt: pending.prompt,
      canRetry: canReplayPendingTurn(pending),
    });
    appendAssistantError(message, pending);
  }, [appendAssistantError, dispatchTurnTracked, rollbackPendingMessages]);

  const appendStreamDelta = useCallback((
    pending: PendingTurn,
    step: number,
    delta: string,
  ) => {
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
      if (pendingTurnRef.current !== pending || !pending.streamMessageId) return;
      const messageId = pending.streamMessageId;
      const content = pending.streamContent;
      setMessages((current) => {
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
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      queueMicrotask(flush);
    }
  }, []);

  const clearCurrentStreamMessage = useCallback((pending: PendingTurn) => {
    const streamMessageId = pending.streamMessageId;
    if (!streamMessageId) return;
    setMessages((current) => current.filter((message) => message.id !== streamMessageId));
    pending.streamMessageId = null;
    pending.streamStep = null;
    pending.streamContent = '';
    pending.streamFlushScheduled = false;
  }, []);

  const updateToolActivity = useCallback((activity: BgsmAgentToolActivity) => {
    dispatchTurnTracked({ type: 'tool_activity_updated', activity });
  }, [dispatchTurnTracked]);

  const removeToolActivity = useCallback((callId: string) => {
    dispatchTurnTracked({ type: 'tool_activity_removed', callId });
  }, [dispatchTurnTracked]);

  const isCurrentDelivery = useCallback((
    pending: PendingTurn,
    delivery: { turnAttemptId: string; sessionId: string; baseRevision: number },
  ) => {
    const session = sessionRef.current;
    return pendingTurnRef.current === pending &&
      delivery.sessionId === pending.sessionId &&
      delivery.baseRevision === pending.baseRevision &&
      delivery.turnAttemptId === pending.turnAttemptId &&
      session?.id === pending.sessionId &&
      session.revision === pending.baseRevision;
  }, []);

  const finishTurn = useCallback((pending: PendingTurn, result: BgsmAgentTurnResult | null) => {
    if (pendingTurnRef.current !== pending) return;
    clearCompactionUi(pending);
    if (pending.stopFallbackTimer !== null) {
      clearTimeout(pending.stopFallbackTimer);
      pending.stopFallbackTimer = null;
    }
    pendingTurnRef.current = null;
    if (turnStateRef.current.running) {
      if (result) {
        dispatchTurnTracked({
          type: 'turn_finished',
          result,
          prompt: pending.prompt,
          canRetry: canReplayPendingTurn(pending),
          doneStatus: { kind: 'done', text: m.agentPanel.agentDone },
          stoppedStatus: { kind: 'stopped', text: m.agentPanel.agentStopped },
          failureStatus: { kind: 'error', text: m.agentPanel.turnFailed },
          failureMessage: m.agentPanel.turnFailed,
          failureCategory: result.reason === 'provider_error' || result.reason === 'context_limit'
            ? 'provider'
            : 'other',
        });
      } else {
        dispatchTurnTracked({ type: 'turn_detached' });
      }
    }
    if (result?.changed) onDataChanged?.();
    pending.resolve(result);
  }, [clearCompactionUi, dispatchTurnTracked, m.agentPanel, onDataChanged]);

  const handleEvent = useCallback((event: BgsmAgentTurnEvent, pending: PendingTurn) => {
    if (!isCurrentDelivery(pending, event)) return;
    if (pending.stopRequested && event.type !== 'agent_done') return;
    if (!['context_compaction_start', 'context_compaction_end', 'context_diagnostic'].includes(event.type)) {
      finishCompactionUi(pending);
    }

    switch (event.type) {
      case 'agent_queued':
        setAgentStatus({ kind: 'queued', text: m.agentPanel.agentQueued });
        break;
      case 'conversation_bound': {
        const session = sessionRef.current;
        if (session) {
          updateCurrentSession(bindBgsmAgentSession(session, event.binding));
          setConversationBinding(event.binding);
        }
        break;
      }
      case 'agent_start':
        setAgentStatus({ kind: 'working', text: m.agentPanel.agentStarting });
        break;
      case 'turn_start':
        setAgentStatus({ kind: 'working', text: m.agentPanel.agentThinking });
        break;
      case 'assistant_stream_start':
        setAgentStatus({ kind: 'working', text: m.agentPanel.agentWriting });
        break;
      case 'assistant_text_delta':
        appendStreamDelta(pending, event.step, event.delta);
        setAgentStatus({ kind: 'working', text: m.agentPanel.agentWriting });
        break;
      case 'message_update':
        if (event.message.role === 'agent') clearCurrentStreamMessage(pending);
        appendAgentMessage(event.message, pending);
        if (event.message.role === 'agent' && event.message.content.trim()) {
          setAgentStatus({ kind: 'working', text: m.agentPanel.agentWriting });
        }
        break;
      case 'tool_execution_queued':
        updateToolActivity({
          callId: event.callId,
          toolName: event.toolName,
          state: 'queued',
        });
        break;
      case 'tool_execution_start':
        if (event.risk === 'write') pending.writeOutcomes.set(event.callId, 'in_flight');
        updateToolActivity({
          callId: event.callId,
          toolName: event.toolName,
          state: 'running',
        });
        setAgentStatus({
          kind: 'tool',
          text: toolStatusText(event.toolName, event.risk, m.agentPanel),
        });
        break;
      case 'tool_execution_end':
        if (event.risk === 'write') {
          pending.writeOutcomes.set(
            event.callId,
            event.writeOutcome === 'not_applicable' ? 'unknown' : event.writeOutcome,
          );
        }
        if (!event.ok) {
          // Tool failures remain available in diagnostics and model history. They
          // are recoverable while the turn is alive, so do not flash a terminal
          // failure in the product transcript before retry or compaction.
          removeToolActivity(event.callId);
          setAgentStatus({ kind: 'working', text: m.agentPanel.agentThinking });
          break;
        }
        updateToolActivity({
          callId: event.callId,
          toolName: event.toolName,
          state: 'completed',
        });
        setAgentStatus({ kind: 'working', text: m.agentPanel.agentThinking });
        break;
      case 'agent_error':
        dispatchTurnTracked({
          type: 'error_observed',
          message: event.message,
          category: event.category ?? 'other',
          status: { kind: 'error', text: event.message },
        });
        appendAssistantError(event.message, pending);
        break;
      case 'approval_required':
        dispatchTurnTracked({
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
          dispatchTurnTracked({
            type: 'stop_requested',
            prompt: pending.prompt,
            canRetry: canReplayPendingTurn(pending),
            status: { kind: 'stopped', text: m.agentPanel.agentStopped },
          });
        }
        break;
    }
  }, [
    appendAgentMessage,
    appendAssistantError,
    appendStreamDelta,
    clearCurrentStreamMessage,
    dispatchTurnTracked,
    finishCompactionUi,
    isCurrentDelivery,
    m.agentPanel,
    removeToolActivity,
    rollbackPendingMessages,
    setAgentStatus,
    startCompactionUi,
    updateCurrentSession,
    updateToolActivity,
  ]);

  const clearSessionUi = useCallback(() => {
    dispatchTurnTracked({ type: 'session_cleared' });
  }, [dispatchTurnTracked]);

  const createSession = useCallback(() => {
    if (pendingTurnRef.current) return null;
    const store = sessionStoreRef.current;
    if (!store) return null;
    syncActiveSessionRecord();
    const session = createBgsmAgentSession();
    const now = Date.now();
    const record: AgentSessionRecord = {
      summary: {
        id: session.id,
        title: '',
        createdAt: now,
        updatedAt: now,
      },
      session,
      messages: [],
      conversationBinding: null,
    };
    store.records.set(session.id, record);
    store.activeSessionId = session.id;
    sessionRef.current = session;
    messagesRef.current = [];
    conversationBindingRef.current = null;
    setActiveSessionId(session.id);
    setMessages([]);
    setConversationBinding(null);
    clearSessionUi();
    publishSessionList();
    return session.id;
  }, [clearSessionUi, publishSessionList, syncActiveSessionRecord]);

  const switchSession = useCallback((nextSessionId: string) => {
    if (pendingTurnRef.current) return false;
    const store = sessionStoreRef.current;
    if (!store || store.activeSessionId === nextSessionId) return false;
    const target = store.records.get(nextSessionId);
    if (!target) return false;
    syncActiveSessionRecord();
    store.activeSessionId = nextSessionId;
    sessionRef.current = target.session;
    messagesRef.current = target.messages;
    conversationBindingRef.current = target.conversationBinding;
    setActiveSessionId(nextSessionId);
    setMessages(target.messages);
    setConversationBinding(target.conversationBinding);
    clearSessionUi();
    return true;
  }, [clearSessionUi, syncActiveSessionRecord]);

  const deleteSession = useCallback((sessionIdToDelete: string) => {
    if (pendingTurnRef.current) return false;
    const store = sessionStoreRef.current;
    if (!store || store.records.size <= 1 || !store.records.has(sessionIdToDelete)) return false;
    syncActiveSessionRecord();
    const deletingActive = store.activeSessionId === sessionIdToDelete;
    store.records.delete(sessionIdToDelete);
    if (!deletingActive) {
      publishSessionList();
      return true;
    }
    const nextRecord = [...store.records.values()].sort((left, right) => (
      right.summary.updatedAt - left.summary.updatedAt
    ))[0];
    if (!nextRecord) return false;
    store.activeSessionId = nextRecord.session.id;
    sessionRef.current = nextRecord.session;
    messagesRef.current = nextRecord.messages;
    conversationBindingRef.current = nextRecord.conversationBinding;
    setActiveSessionId(nextRecord.session.id);
    setMessages(nextRecord.messages);
    setConversationBinding(nextRecord.conversationBinding);
    clearSessionUi();
    publishSessionList();
    return true;
  }, [clearSessionUi, publishSessionList, syncActiveSessionRecord]);

  const resetConversation = useCallback(() => {
    const pending = pendingTurnRef.current;
    if (pending) {
      clearCompactionUi(pending);
      if (pending.stopFallbackTimer !== null) clearTimeout(pending.stopFallbackTimer);
    }
    pendingTurnRef.current = null;
    pending?.resolve(null);
    pending?.stop({ detach: true });
    createSession();
  }, [clearCompactionUi, createSession]);

  const stopTurn = useCallback(() => {
    const pending = pendingTurnRef.current;
    if (!pending || pending.stopRequested) return;
    pending.stopRequested = true;
    clearCompactionUi(pending);
    pending.stop();
    rollbackPendingMessages(pending);
    dispatchTurnTracked({
      type: 'stop_requested',
      prompt: pending.prompt,
      canRetry: canReplayPendingTurn(pending),
      status: { kind: 'stopped', text: m.agentPanel.agentStopped },
    });
    if (pending.stopFallbackTimer === null) {
      pending.stopFallbackTimer = setTimeout(() => {
        if (pendingTurnRef.current !== pending) return;
        pending.stop({ detach: true });
        finishTurn(pending, null);
      }, STOP_SETTLE_TIMEOUT_MS);
    }
  }, [
    clearCompactionUi,
    dispatchTurnTracked,
    finishTurn,
    m.agentPanel.agentStopped,
    rollbackPendingMessages,
  ]);

  const editContextLimitedPrompt = useCallback(() => {
    dispatchTurnTracked({ type: 'context_recovery_dismissed' });
  }, [dispatchTurnTracked]);

  const startTurn = useCallback((prompt: string): Promise<BgsmAgentTurnResult | null> => {
    const clean = prompt.trim();
    if (!clean || pendingTurnRef.current) return Promise.resolve(null);
    const session = sessionRef.current;
    if (!session) return Promise.resolve(null);

    const turnSequence = ++turnSequenceRef.current;
    const token = `${session.id}:turn:${turnSequence}`;
    const optimisticMessageId = `${token}:user`;
    const startedAt = Date.now();
    const store = sessionStoreRef.current;
    const record = store?.records.get(session.id);
    if (record) {
      record.summary = {
        ...record.summary,
        title: record.summary.title || truncateSessionTitle(clean),
        updatedAt: startedAt,
      };
      publishSessionList();
    }

    dispatchTurnTracked({
      type: 'turn_started',
      status: { kind: 'queued', text: m.agentPanel.agentQueued },
    });
    setMessages((current) => [
      ...current,
      {
        id: optimisticMessageId,
        role: 'user',
        content: clean,
        createdAt: startedAt,
      },
    ]);

    return new Promise((resolve) => {
      const pending: PendingTurn = {
        token,
        startedAt,
        turnAttemptId: token,
        sessionId: session.id,
        baseRevision: session.revision,
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
        acknowledge: () => {},
        resolve,
      };
      pendingTurnRef.current = pending;

      try {
        const control = startBgsmAgentTurn(createBgsmAgentTurnInput(
          session,
          clean,
          candidateContract,
          () => token,
        ), {
          onEvent: (event) => handleEvent(event, pending),
          onResult: (result) => {
            if (!isCurrentDelivery(pending, result)) return;

            if (result.reason === 'attempt_state_lost') {
              pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
              failPendingTurn(pending, m.agentPanel.attemptStateLost, 'other');
              finishTurn(pending, null);
              return;
            }

            if (result.reason === 'context_limit' || result.contextFailureReason) {
              const currentSession = sessionRef.current;
              if (!currentSession) return;
              try {
                let appliedRevision: number | null = null;
                if (
                  result.newMessages.length > 0
                  || result.candidateCheckpoint
                  || result.candidateActiveProjection !== undefined
                ) {
                  const transition = applyBgsmAgentSessionTransition(currentSession, {
                    sessionId: result.sessionId,
                    baseRevision: result.baseRevision,
                    candidateCheckpoint: result.candidateCheckpoint,
                    candidateActiveProjection: result.candidateActiveProjection,
                    messageDelta: result.newMessages,
                  });
                  if (!transition.applied) {
                    throw new Error(m.agentPanel.turnFailed);
                  }
                  updateCurrentSession(transition.session);
                  appliedRevision = transition.session.revision;
                  if (result.newMessages.length > 0) reconcileFinalMessages(pending, result);
                }
                pending.acknowledge(appliedRevision === null
                  ? { disposition: 'no_transition', appliedRevision: null }
                  : { disposition: 'applied', appliedRevision });
              } catch (error) {
                pending.acknowledge({ disposition: 'transition_rejected', appliedRevision: null });
                const message = error instanceof Error ? error.message : m.agentPanel.turnFailed;
                failPendingTurn(pending, message, 'other');
                finishTurn(pending, null);
                return;
              }
              if (result.newMessages.length === 0) rollbackPendingMessages(pending);
              if (isActionableContextFailure(result.contextFailureReason)) {
                dispatchTurnTracked({
                  type: 'context_recovery_required',
                  result,
                  recovery: {
                    prompt,
                    reason: result.contextFailureReason,
                  },
                  prompt: pending.prompt,
                  canRetry: canReplayPendingTurn(pending),
                });
              } else {
                dispatchTurnTracked({
                  type: 'turn_failed',
                  result,
                  message: m.agentPanel.turnFailed,
                  category: 'provider',
                  status: { kind: 'error', text: m.agentPanel.turnFailed },
                  prompt: pending.prompt,
                  canRetry: canReplayPendingTurn(pending),
                });
                appendAssistantError(m.agentPanel.turnFailed, pending);
              }
              finishTurn(pending, result);
              return;
            }

            const currentSession = sessionRef.current;
            if (!currentSession) return;
            try {
              let appliedRevision: number | null = null;
              if (
                result.newMessages.length > 0
                || result.candidateCheckpoint
                || result.candidateActiveProjection !== undefined
              ) {
                const transition = applyBgsmAgentSessionTransition(currentSession, {
                  sessionId: result.sessionId,
                  baseRevision: result.baseRevision,
                  candidateCheckpoint: result.candidateCheckpoint,
                  candidateActiveProjection: result.candidateActiveProjection,
                  messageDelta: result.newMessages,
                });
                if (!transition.applied) {
                  throw new Error(m.agentPanel.turnFailed);
                }
                updateCurrentSession(transition.session);
                appliedRevision = transition.session.revision;
                if (result.reason === 'final_answer' || result.newMessages.length > 0) {
                  reconcileFinalMessages(pending, result);
                }
              }
              pending.acknowledge(appliedRevision === null
                ? { disposition: 'no_transition', appliedRevision: null }
                : { disposition: 'applied', appliedRevision });
            } catch (error) {
              pending.acknowledge({ disposition: 'transition_rejected', appliedRevision: null });
              const message = error instanceof Error ? error.message : m.agentPanel.turnFailed;
              failPendingTurn(pending, message, 'other');
              finishTurn(pending, null);
              return;
            }
            if (
              result.reason !== 'final_answer'
              && !result.candidateCheckpoint
              && result.candidateActiveProjection === undefined
            ) {
              if (result.newMessages.length === 0) rollbackPendingMessages(pending);
            }
            finishTurn(pending, result);
          },
          onError: (delivery) => {
            if (!isCurrentDelivery(pending, delivery)) return;
            pending.acknowledge({ disposition: 'no_transition', appliedRevision: null });
            if (pending.stopRequested) {
              finishTurn(pending, null);
              return;
            }
            const text = delivery.message || m.agentPanel.turnFailed;
            failPendingTurn(pending, text, delivery.category ?? 'other');
            finishTurn(pending, null);
          },
        });
        if (pendingTurnRef.current === pending) {
          pending.stop = control.stop;
          pending.acknowledge = control.acknowledge;
        } else {
          control.stop();
        }
      } catch (error) {
        if (pendingTurnRef.current !== pending) return;
        const message = error instanceof Error ? error.message : m.agentPanel.turnFailed;
        failPendingTurn(pending, message, 'other');
        finishTurn(pending, null);
      }
    });
  }, [
    appendAssistantError,
    candidateContract,
    dispatchTurnTracked,
    failPendingTurn,
    finishTurn,
    handleEvent,
    isCurrentDelivery,
    m.agentPanel,
    publishSessionList,
    reconcileFinalMessages,
    rollbackPendingMessages,
    updateCurrentSession,
  ]);

  return useMemo(() => ({
    sessionId,
    activeSessionId,
    sessions: sessionList,
    messages,
    phase: turnState.phase,
    running,
    status,
    error,
    errorCategory,
    lastTurnResult,
    contextLimitRecovery,
    draftRecovery,
    canRetryLastTurn,
    toolActivities,
    conversationBinding,
    startTurn,
    stopTurn,
    editContextLimitedPrompt,
    createSession,
    switchSession,
    deleteSession,
    resetConversation,
  }), [
    activeSessionId,
    contextLimitRecovery,
    canRetryLastTurn,
    draftRecovery,
    editContextLimitedPrompt,
    errorCategory,
    error,
    createSession,
    deleteSession,
    lastTurnResult,
    messages,
    resetConversation,
    running,
    sessionList,
    sessionId,
    startTurn,
    status,
    turnState.phase,
    stopTurn,
    switchSession,
    toolActivities,
    conversationBinding,
  ]);
}

function truncateSessionTitle(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, ' ');
  const characters = [...clean];
  if (characters.length <= SESSION_TITLE_MAX_LENGTH) return clean;
  return `${characters.slice(0, SESSION_TITLE_MAX_LENGTH - 1).join('').trimEnd()}…`;
}

function toChatMessage(
  message: BgsmAgentTurnResult['newMessages'][number],
): BgsmAgentChatMessage {
  return {
    id: message.id,
    role: message.role === 'agent' ? 'assistant' : message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.toolName ? { toolName: message.toolName } : {}),
  };
}

function isEmptyToolCallEnvelope(
  message: BgsmAgentTurnResult['newMessages'][number],
): boolean {
  return message.role === 'agent'
    && message.content.trim().length === 0
    && (message.toolCalls?.length ?? 0) > 0;
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
  labels: {
    agentReadingData: string;
    agentPreparingOrganizationScope: string;
    agentApplyingChanges: string;
  },
): string {
  if (getBgsmAgentToolDefinition(toolName)?.presentation === 'organization') {
    return labels.agentPreparingOrganizationScope;
  }
  return risk === 'write'
    ? labels.agentApplyingChanges
    : labels.agentReadingData;
}
