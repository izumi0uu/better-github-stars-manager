import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  startBgsmAgentTurn,
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

export type BgsmAgentChatMessage = {
  id: string;
  role: 'assistant' | 'user' | 'tool';
  content: string;
  toolName?: string;
  streaming?: boolean;
};

export type BgsmAgentStatus = {
  kind: 'idle' | 'queued' | 'working' | 'compacting' | 'tool' | 'done' | 'stopped' | 'error';
  text: string;
};

export type BgsmAgentToolActivity = {
  callId: string;
  toolName: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
};

type BgsmAgentActionableContextFailureReason =
  | 'capability_unresolved'
  | 'current_turn_too_large'
  | 'provider_context_overflow_repeated'
  | 'provider_request_byte_limit_repeated';

export type BgsmAgentContextLimitRecovery = {
  prompt: string;
  reason: BgsmAgentActionableContextFailureReason;
};

type PendingCompactionUi = {
  previousStatus: BgsmAgentStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
  visible: boolean;
};

type PendingTurn = {
  token: string;
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
  writeMayHaveCommitted: boolean;
  stop: (options?: Readonly<{ detach?: boolean }>) => void;
  acknowledge: (ack: Readonly<
    | { disposition: 'applied'; appliedRevision: number }
    | { disposition: 'not_applied'; appliedRevision: null }
  >) => void;
  resolve: (result: BgsmAgentTurnResult | null) => void;
  compactionUi: PendingCompactionUi | null;
};


export function useBgsmAgent(
  onDataChanged?: () => void,
  candidateContract?: BgsmAgentConversationCandidate,
) {
  const { m } = useI18n();
  const [messages, setMessages] = useState<BgsmAgentChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<BgsmAgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCategory, setErrorCategory] = useState<AgentErrorCategory | null>(null);
  const [lastTurnResult, setLastTurnResult] = useState<BgsmAgentTurnResult | null>(null);
  const [contextLimitRecovery, setContextLimitRecovery] = useState<BgsmAgentContextLimitRecovery | null>(null);
  const [draftRecovery, setDraftRecovery] = useState<string | null>(null);
  const [canRetryLastTurn, setCanRetryLastTurn] = useState(true);
  const [toolActivities, setToolActivities] = useState<BgsmAgentToolActivity[]>([]);
  const [conversationBinding, setConversationBinding] = useState<BgsmAgentConversationBinding | null>(null);
  const sessionRef = useRef<BgsmAgentSession | null>(null);
  const runningRef = useRef(false);
  const statusRef = useRef<BgsmAgentStatus | null>(null);
  const turnHadErrorRef = useRef(false);
  const pendingTurnRef = useRef<PendingTurn | null>(null);
  const turnSequenceRef = useRef(0);
  if (!sessionRef.current) sessionRef.current = createBgsmAgentSession();
  const sessionId = sessionRef.current.id;

  const setAgentStatus = useCallback((next: BgsmAgentStatus | null) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const clearCompactionUi = useCallback((pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    if (!compaction) return;
    if (compaction.timer !== null) clearTimeout(compaction.timer);
    pending.compactionUi = null;
  }, []);

  const startCompactionUi = useCallback((pending: PendingTurn) => {
    if (pending.compactionUi) return;
    const compaction: PendingCompactionUi = {
      previousStatus: statusRef.current,
      timer: null,
      visible: false,
    };
    pending.compactionUi = compaction;
    compaction.timer = setTimeout(() => {
      if (pendingTurnRef.current !== pending || pending.compactionUi !== compaction) return;
      compaction.timer = null;
      compaction.visible = true;
      setAgentStatus({ kind: 'compacting', text: m.agentPanel.agentCompacting });
    }, 300);
  }, [m.agentPanel.agentCompacting, setAgentStatus]);

  const finishCompactionUi = useCallback((pending: PendingTurn) => {
    const compaction = pending.compactionUi;
    clearCompactionUi(pending);
    if (!compaction?.visible || pendingTurnRef.current !== pending) return;
    setAgentStatus(compaction.previousStatus ?? {
      kind: 'working',
      text: m.agentPanel.agentThinking,
    });
  }, [clearCompactionUi, m.agentPanel.agentThinking, setAgentStatus]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => () => {
    const pending = pendingTurnRef.current;
    pendingTurnRef.current = null;
    runningRef.current = false;
    if (pending) clearCompactionUi(pending);
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
    setToolActivities((current) => {
      const index = current.findIndex((item) => item.callId === activity.callId);
      if (index === -1) return [...current, activity];
      return current.map((item, itemIndex) => itemIndex === index ? activity : item);
    });
  }, []);

  const failOpenToolActivities = useCallback(() => {
    setToolActivities((current) => current.map((activity) => (
      activity.state === 'queued' || activity.state === 'running'
        ? { ...activity, state: 'failed' }
        : activity
    )));
  }, []);

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
    pendingTurnRef.current = null;
    runningRef.current = false;
    setRunning(false);
    if (result) {
      setLastTurnResult(result);
      if (result.reason === 'aborted') {
        setAgentStatus({ kind: 'stopped', text: m.agentPanel.agentStopped });
      } else if (!turnHadErrorRef.current && result.reason === 'final_answer') {
        setAgentStatus({ kind: 'done', text: m.agentPanel.agentDone });
      }
      if (result.changed) onDataChanged?.();
    }
    pending.resolve(result);
  }, [clearCompactionUi, m.agentPanel.agentDone, m.agentPanel.agentStopped, onDataChanged, setAgentStatus]);

  const handleEvent = useCallback((event: BgsmAgentTurnEvent, pending: PendingTurn) => {
    if (!isCurrentDelivery(pending, event)) return;
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
          sessionRef.current = bindBgsmAgentSession(session, event.binding);
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
        if (event.risk === 'write') pending.writeMayHaveCommitted = true;
        updateToolActivity({
          callId: event.callId,
          toolName: event.toolName,
          state: 'running',
        });
        setAgentStatus({ kind: 'tool', text: toolStatusText(event.risk, m.agentPanel) });
        break;
      case 'tool_execution_end':
        updateToolActivity({
          callId: event.callId,
          toolName: event.toolName,
          state: event.ok ? 'completed' : 'failed',
        });
        if (!event.ok) turnHadErrorRef.current = true;
        setAgentStatus({
          kind: event.ok ? 'working' : 'error',
          text: event.ok ? m.agentPanel.agentThinking : m.agentPanel.turnFailed,
        });
        break;
      case 'agent_error':
        turnHadErrorRef.current = true;
        failOpenToolActivities();
        setErrorCategory(event.category ?? 'other');
        setError(event.message);
        setAgentStatus({ kind: 'error', text: event.message });
        appendAssistantError(event.message, pending);
        break;
      case 'approval_required':
        turnHadErrorRef.current = true;
        failOpenToolActivities();
        setErrorCategory('other');
        setError(event.summary);
        setAgentStatus({ kind: 'error', text: event.summary });
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
          rollbackPendingMessages(pending);
          failOpenToolActivities();
          setDraftRecovery(pending.prompt);
          setCanRetryLastTurn(!pending.writeMayHaveCommitted);
          setAgentStatus({ kind: 'stopped', text: m.agentPanel.agentStopped });
        } else if (!turnHadErrorRef.current) {
          setAgentStatus({ kind: 'done', text: m.agentPanel.agentDone });
        }
        break;
    }
  }, [
    appendAgentMessage,
    appendAssistantError,
    appendStreamDelta,
    clearCurrentStreamMessage,
    failOpenToolActivities,
    finishCompactionUi,
    isCurrentDelivery,
    m.agentPanel,
    rollbackPendingMessages,
    setAgentStatus,
    startCompactionUi,
    updateToolActivity,
  ]);

  const resetConversation = useCallback(() => {
    const pending = pendingTurnRef.current;
    if (pending) clearCompactionUi(pending);
    pendingTurnRef.current = null;
    runningRef.current = false;
    pending?.resolve(null);
    pending?.stop({ detach: true });
    sessionRef.current = createBgsmAgentSession();
    turnHadErrorRef.current = false;
    setMessages([]);
    setRunning(false);
    setAgentStatus(null);
    setError(null);
    setErrorCategory(null);
    setLastTurnResult(null);
    setContextLimitRecovery(null);
    setDraftRecovery(null);
    setCanRetryLastTurn(true);
    setToolActivities([]);
    setConversationBinding(null);
  }, [clearCompactionUi, setAgentStatus]);

  const stopTurn = useCallback(() => {
    const pending = pendingTurnRef.current;
    if (!pending) return;
    clearCompactionUi(pending);
    pending.stop();
    rollbackPendingMessages(pending);
    failOpenToolActivities();
    setDraftRecovery(pending.prompt);
    setCanRetryLastTurn(!pending.writeMayHaveCommitted);
    setAgentStatus({ kind: 'stopped', text: m.agentPanel.agentStopped });
  }, [clearCompactionUi, failOpenToolActivities, m.agentPanel.agentStopped, rollbackPendingMessages, setAgentStatus]);

  const editContextLimitedPrompt = useCallback(() => {
    setContextLimitRecovery(null);
    setAgentStatus(null);
  }, [setAgentStatus]);

  const startTurn = useCallback((prompt: string): Promise<BgsmAgentTurnResult | null> => {
    const clean = prompt.trim();
    if (!clean || runningRef.current) return Promise.resolve(null);
    const session = sessionRef.current;
    if (!session) return Promise.resolve(null);

    const turnSequence = ++turnSequenceRef.current;
    const token = `${session.id}:turn:${turnSequence}`;
    const optimisticMessageId = `${token}:user`;

    runningRef.current = true;
    turnHadErrorRef.current = false;
    setRunning(true);
    setError(null);
    setLastTurnResult(null);
    setErrorCategory(null);
    setContextLimitRecovery(null);
    setDraftRecovery(null);
    setCanRetryLastTurn(true);
    setToolActivities([]);
    setAgentStatus({ kind: 'queued', text: m.agentPanel.agentQueued });
    setMessages((current) => [
      ...current,
      {
        id: optimisticMessageId,
        role: 'user',
        content: clean,
      },
    ]);

    return new Promise((resolve) => {
      const pending: PendingTurn = {
        token,
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
        writeMayHaveCommitted: false,
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
              pending.acknowledge({ disposition: 'not_applied', appliedRevision: null });
              rollbackPendingMessages(pending);
              failOpenToolActivities();
              turnHadErrorRef.current = true;
              setDraftRecovery(pending.prompt);
              setCanRetryLastTurn(!pending.writeMayHaveCommitted);
              setError(m.agentPanel.attemptStateLost);
              setErrorCategory('other');
              setAgentStatus({ kind: 'error', text: m.agentPanel.attemptStateLost });
              appendAssistantError(m.agentPanel.attemptStateLost, pending);
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
                    pending.acknowledge({ disposition: 'not_applied', appliedRevision: null });
                    finishTurn(pending, null);
                    return;
                  }
                  sessionRef.current = transition.session;
                  appliedRevision = transition.session.revision;
                  if (result.newMessages.length > 0) reconcileFinalMessages(pending, result);
                }
                pending.acknowledge(appliedRevision === null
                  ? { disposition: 'not_applied', appliedRevision: null }
                  : { disposition: 'applied', appliedRevision });
              } catch (error) {
                pending.acknowledge({ disposition: 'not_applied', appliedRevision: null });
                const message = error instanceof Error ? error.message : m.agentPanel.turnFailed;
                turnHadErrorRef.current = true;
                rollbackPendingMessages(pending);
                failOpenToolActivities();
                setDraftRecovery(pending.prompt);
                setCanRetryLastTurn(!pending.writeMayHaveCommitted);
                setError(message);
                setErrorCategory('other');
                setAgentStatus({ kind: 'error', text: message });
                appendAssistantError(message, pending);
                finishTurn(pending, null);
                return;
              }
              if (result.newMessages.length === 0) rollbackPendingMessages(pending);
              failOpenToolActivities();
              setCanRetryLastTurn(!pending.writeMayHaveCommitted);
              if (isActionableContextFailure(result.contextFailureReason)) {
                setError(null);
                setErrorCategory(null);
                setAgentStatus(null);
                setContextLimitRecovery({
                  prompt,
                  reason: result.contextFailureReason,
                });
              } else {
                turnHadErrorRef.current = true;
                setDraftRecovery(pending.prompt);
                setError(m.agentPanel.turnFailed);
                setErrorCategory('provider');
                setAgentStatus({ kind: 'error', text: m.agentPanel.turnFailed });
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
                  pending.acknowledge({ disposition: 'not_applied', appliedRevision: null });
                  finishTurn(pending, null);
                  return;
                }
                sessionRef.current = transition.session;
                appliedRevision = transition.session.revision;
                if (result.reason === 'final_answer' || result.newMessages.length > 0) {
                  reconcileFinalMessages(pending, result);
                }
                if (result.reason === 'final_answer') {
                  setDraftRecovery(null);
                  setCanRetryLastTurn(true);
                }
              }
              pending.acknowledge(appliedRevision === null
                ? { disposition: 'not_applied', appliedRevision: null }
                : { disposition: 'applied', appliedRevision });
            } catch (error) {
              pending.acknowledge({ disposition: 'not_applied', appliedRevision: null });
              const message = error instanceof Error ? error.message : m.agentPanel.turnFailed;
              turnHadErrorRef.current = true;
              rollbackPendingMessages(pending);
              failOpenToolActivities();
              setDraftRecovery(pending.prompt);
              setCanRetryLastTurn(!pending.writeMayHaveCommitted);
              setError(message);
              setErrorCategory('other');
              setAgentStatus({ kind: 'error', text: message });
              appendAssistantError(message, pending);
              finishTurn(pending, null);
              return;
            }
            if (
              result.reason !== 'final_answer'
              && !result.candidateCheckpoint
              && result.candidateActiveProjection === undefined
            ) {
              if (result.newMessages.length === 0) rollbackPendingMessages(pending);
              failOpenToolActivities();
              setDraftRecovery(pending.prompt);
              setCanRetryLastTurn(!pending.writeMayHaveCommitted);
            }
            finishTurn(pending, result);
          },
          onError: (delivery) => {
            if (!isCurrentDelivery(pending, delivery)) return;
            pending.acknowledge({ disposition: 'not_applied', appliedRevision: null });
            const text = delivery.message || m.agentPanel.turnFailed;
            turnHadErrorRef.current = true;
            rollbackPendingMessages(pending);
            failOpenToolActivities();
            setDraftRecovery(pending.prompt);
            setCanRetryLastTurn(!pending.writeMayHaveCommitted);
            setError(text);
            setErrorCategory(delivery.category ?? 'other');
            setAgentStatus({ kind: 'error', text });
            appendAssistantError(text, pending);
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
        turnHadErrorRef.current = true;
        rollbackPendingMessages(pending);
        failOpenToolActivities();
        setDraftRecovery(pending.prompt);
        setCanRetryLastTurn(!pending.writeMayHaveCommitted);
        setError(message);
        setErrorCategory('other');
        setAgentStatus({ kind: 'error', text: message });
        appendAssistantError(message, pending);
        finishTurn(pending, null);
      }
    });
  }, [
    appendAssistantError,
    candidateContract,
    failOpenToolActivities,
    finishTurn,
    handleEvent,
    isCurrentDelivery,
    m.agentPanel,
    reconcileFinalMessages,
    rollbackPendingMessages,
    setAgentStatus,
  ]);

  return useMemo(() => ({
    sessionId,
    messages,
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
    resetConversation,
  }), [
    contextLimitRecovery,
    canRetryLastTurn,
    draftRecovery,
    editContextLimitedPrompt,
    errorCategory,
    error,
    lastTurnResult,
    messages,
    resetConversation,
    running,
    sessionId,
    startTurn,
    status,
    stopTurn,
    toolActivities,
    conversationBinding,
  ]);
}

function toChatMessage(
  message: BgsmAgentTurnResult['newMessages'][number],
): BgsmAgentChatMessage {
  return {
    id: message.id,
    role: message.role === 'agent' ? 'assistant' : message.role,
    content: message.content,
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
    || reason === 'provider_context_overflow_repeated'
    || reason === 'provider_request_byte_limit_repeated';
}


function toolStatusText(
  risk: 'read' | 'suggest' | 'write',
  labels: {
    agentReadingData: string;
    agentApplyingChanges: string;
  },
): string {
  return risk === 'write'
    ? labels.agentApplyingChanges
    : labels.agentReadingData;
}
