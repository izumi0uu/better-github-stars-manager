import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { readDurableAgentRetryDraftCandidate } from '@/utils/messaging';
import {
  createBgsmAgentSession,
  type BgsmAgentSession,
} from '@/bgsm-agent/session';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import type { BgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';
import { useI18n } from '@/i18n';
import type {
  AgentRetryDraft,
  AgentRetryDraftKind,
  BgsmAgentSessionSummary,
} from '@/storage/agent-session-store';
import {
  createAgentTurnState,
  reduceAgentTurn,
  type AgentTurnAction,
} from '@/ui/agent-turn-state';
import { sameRetryDraft } from '@/ui/bgsm-agent-retry-policy';
import {
  type AgentSessionCacheRecord,
  type BgsmAgentChatMessage,
} from '@/ui/bgsm-agent-session-projection';
import type { HydratedActiveTurn } from '@/ui/bgsm-agent-retry-recovery';
import {
  ACTIVE_AGENT_SESSION_STORAGE_KEY,
  createHydrationGate,
  useBgsmAgentSessionController,
  type AgentSessionStore,
  type HydrationGate,
} from '@/ui/hooks/use-bgsm-agent-session-controller';
import {
  useBgsmAgentTurnController,
  type PendingTurn,
} from '@/ui/hooks/use-bgsm-agent-turn-controller';

export type {
  BgsmAgentContextLimitRecovery,
  BgsmAgentStatus,
  BgsmAgentToolActivity,
} from '@/ui/agent-turn-state';
export type { BgsmAgentChatMessage } from '@/ui/bgsm-agent-session-projection';

export type { BgsmAgentSessionSummary } from '@/storage/agent-session-store';
export { ACTIVE_AGENT_SESSION_STORAGE_KEY };

export function useBgsmAgent(
  onDataChanged?: () => void,
  candidateContract?: BgsmAgentConversationCandidate,
) {
  const { m } = useI18n();
  const hydrationGateRef = useRef<HydrationGate | null>(null);
  if (!hydrationGateRef.current) hydrationGateRef.current = createHydrationGate();
  const sessionStoreRef = useRef<AgentSessionStore | null>(null);
  if (!sessionStoreRef.current) {
    const session = createBgsmAgentSession();
    const now = Date.now();
    const record: AgentSessionCacheRecord = {
      summary: {
        id: session.id,
        title: '',
        createdAt: now,
        updatedAt: now,
      },
      session,
      messages: [],
      nextBeforeSequence: null,
    };
    sessionStoreRef.current = {
      records: new Map([[session.id, record]]),
      activeSessionId: session.id,
      persistence: 'pending',
    };
  }
  const sessionStore = sessionStoreRef.current!;
  const initialRecord = sessionStore.records.get(sessionStore.activeSessionId)!;
  const [activeSessionId, setActiveSessionId] = useState(sessionStore.activeSessionId);
  const [sessionList, setSessionList] = useState<BgsmAgentSessionSummary[]>(() => (
    [...sessionStore.records.values()].map((record) => record.summary)
  ));
  const [messages, setMessages] = useState<BgsmAgentChatMessage[]>(initialRecord.messages ?? []);
  const [nextBeforeSequence, setNextBeforeSequence] = useState<number | null>(
    initialRecord.nextBeforeSequence,
  );
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionOperationPending, setSessionOperationPending] = useState(false);
  const [sessionInitializationFailed, setSessionInitializationFailed] = useState(false);
  const [hydratedActiveTurn, setHydratedActiveTurn] = useState<HydratedActiveTurn | null>(null);
  const [durableRetryDraft, setDurableRetryDraft] = useState<AgentRetryDraft | null>(null);
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
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
    canRetryLastTurn: turnCanRetryLastTurn,
    toolActivities,
  } = turnState;
  const [conversationBinding, setConversationBinding] = useState<BgsmAgentConversationBinding | null>(
    initialRecord.session?.binding ?? null,
  );
  const sessionRef = useRef<BgsmAgentSession>(initialRecord.session!);
  const messagesRef = useRef(messages);
  const nextBeforeSequenceRef = useRef(nextBeforeSequence);
  const loadingEarlierMessagesRef = useRef(false);
  const conversationBindingRef = useRef(conversationBinding);
  const turnStateRef = useRef(turnState);
  turnStateRef.current = turnState;
  const aliveRef = useRef(true);
  const pendingTurnRef = useRef<PendingTurn | null>(null);
  const retryDraftRef = useRef<AgentRetryDraft | null>(null);
  const retryPresentationSequencesRef = useRef(new Map<string, number>());
  const sessionOperationRef = useRef(false);
  const sessionId = activeSessionId;
  const canRetryLastTurn = turnCanRetryLastTurn
    && (
      sessionStore.persistence === 'memory'
      || durableRetryDraft?.settlement === 'retryable'
    );

  const dispatchTurnTracked = useCallback((action: AgentTurnAction) => {
    turnStateRef.current = reduceAgentTurn(turnStateRef.current, action);
    dispatchTurn(action);
  }, []);

  const assignActiveRetryDraft = useCallback((draft: AgentRetryDraft | null) => {
    retryDraftRef.current = draft;
    setDurableRetryDraft(draft);
  }, []);

  const reserveRetryDraftPresentation = useCallback((sessionId: string) => {
    const sequences = retryPresentationSequencesRef.current;
    const sequence = (sequences.get(sessionId) ?? 0) + 1;
    sequences.set(sessionId, sequence);
    return sequence;
  }, []);

  const setActiveRetryDraft = useCallback((draft: AgentRetryDraft | null) => {
    const activeSessionId = sessionStoreRef.current?.activeSessionId ?? draft?.sessionId;
    if (activeSessionId) reserveRetryDraftPresentation(activeSessionId);
    assignActiveRetryDraft(draft);
  }, [assignActiveRetryDraft, reserveRetryDraftPresentation]);

  const refreshDurableRetryDraft = useCallback((sessionId: string) => {
    const store = sessionStoreRef.current;
    if (store?.persistence !== 'durable') return;
    const sequence = reserveRetryDraftPresentation(sessionId);
    void readDurableAgentRetryDraftCandidate(sessionId).then((draft) => {
      if (
        !aliveRef.current
        || retryPresentationSequencesRef.current.get(sessionId) !== sequence
        || sessionStoreRef.current?.activeSessionId !== sessionId
        || sessionRef.current.id !== sessionId
      ) return;
      assignActiveRetryDraft(draft?.baseRevision === sessionRef.current.revision ? draft : null);
    }).catch(() => {
      // Keep an optimistic pending presentation until the next authoritative read.
    });
  }, [assignActiveRetryDraft, reserveRetryDraftPresentation, sessionRef]);

  const forgetRetryDraft = useCallback((sessionId: string, expected?: AgentRetryDraft) => {
    const current = retryDraftRef.current;
    if (
      sessionStoreRef.current?.activeSessionId !== sessionId
      || (expected && !sameRetryDraft(current, expected))
    ) return;
    setActiveRetryDraft(null);
  }, [setActiveRetryDraft]);

  const settleRetryDraft = useCallback((
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
    if (sessionStoreRef.current?.persistence === 'memory') {
      if (sessionStoreRef.current.activeSessionId === pending.sessionId) {
        setActiveRetryDraft(canRetry ? draft : { ...draft, settlement: 'stop_pending' });
      }
      return;
    }
    if (sessionStoreRef.current?.activeSessionId === pending.sessionId) {
      // UI state is pending only; the background attempt row decides eligibility.
      setActiveRetryDraft({ ...draft, settlement: 'stop_pending' });
    }
    refreshDurableRetryDraft(pending.sessionId);
  }, [refreshDurableRetryDraft, setActiveRetryDraft]);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const clearSessionUi = useCallback(() => {
    dispatchTurnTracked({ type: 'session_cleared' });
  }, [dispatchTurnTracked]);

  const sessionController = useBgsmAgentSessionController({
    refs: {
      hydrationGateRef,
      sessionStoreRef,
      sessionRef,
      messagesRef,
      nextBeforeSequenceRef,
      loadingEarlierMessagesRef,
      conversationBindingRef,
      retryDraftRef,
      pendingTurnRef,
      sessionOperationRef,
    },
    state: {
      messages,
      nextBeforeSequence,
      conversationBinding,
      sessionReady,
      hydrationAttempt,
    },
    presentation: {
      setActiveSessionId,
      setSessionList,
      setMessages,
      setNextBeforeSequence,
      setLoadingEarlierMessages,
      setSessionReady,
      setSessionOperationPending,
      setSessionInitializationFailed,
      setHydratedActiveTurn,
      setHydrationAttempt,
      setConversationBinding,
      clearSessionUi,
    },
    retry: { setActive: setActiveRetryDraft },
  });
  const {
    createSession,
    switchSession,
    deleteSession,
    loadEarlierMessages,
    retrySessionHydration,
    failSessionPersistence,
    recoverCommittedTurn: recoverCommittedPendingTurn,
    adoptCommit: adoptCommitReceipt,
    recoverUnavailable: recoverUnavailableActiveSession,
    reconcileCanonical: reconcileCanonicalSession,
  } = sessionController;

  const turnController = useBgsmAgentTurnController({
    pendingTurnRef,
    session: {
      sessionRef,
      conversationBindingRef,
      getHydrationPromise: () => hydrationGateRef.current!.promise,
      getPersistence: () => sessionStoreRef.current?.persistence ?? 'pending',
      getActiveSessionId: () => (
        sessionStoreRef.current?.activeSessionId ?? sessionRef.current.id
      ),
      isOperationPending: () => sessionOperationRef.current,
      ready: sessionReady && !sessionOperationPending,
      initializationFailed: sessionInitializationFailed,
      recoverCommittedTurn: recoverCommittedPendingTurn,
      adoptCommit: adoptCommitReceipt,
      failPersistence: failSessionPersistence,
      recoverUnavailable: recoverUnavailableActiveSession,
      publishHydratedTurn: setHydratedActiveTurn,
      reconcileCanonical: reconcileCanonicalSession,
    },
    retry: {
      draftRef: retryDraftRef,
      setActive: setActiveRetryDraft,
      forget: forgetRetryDraft,
      settle: settleRetryDraft,
      refresh: refreshDurableRetryDraft,
    },
    presentation: {
      turnStateRef,
      dispatch: dispatchTurnTracked,
      setMessages,
      setConversationBinding,
    },
    labels: {
      agentCompacting: m.agentPanel.agentCompacting,
      agentDone: m.agentPanel.agentDone,
      agentQueued: m.agentPanel.agentQueued,
      agentStarting: m.agentPanel.agentStarting,
      agentStopped: m.agentPanel.agentStopped,
      agentThinking: m.agentPanel.agentThinking,
      agentWriting: m.agentPanel.agentWriting,
      agentReadingData: m.agentPanel.agentReadingData,
      agentPreparingOrganizationScope: m.agentPanel.agentPreparingOrganizationScope,
      agentApplyingChanges: m.agentPanel.agentApplyingChanges,
      attemptResumeStateUnknown: m.agentPanel.attemptResumeStateUnknown,
      attemptStateLost: m.agentPanel.attemptStateLost,
      turnFailed: m.agentPanel.turnFailed,
    },
    candidateContract,
    hydratedActiveTurn,
    onHydratedTurnSettled: (turn) => {
      setHydratedActiveTurn((current) => current === turn ? null : current);
    },
    onDataChanged,
  });
  const {
    startTurn,
    stopTurn,
    stopAndDetachPendingTurn,
    editContextLimitedPrompt,
  } = turnController;

  const resetConversation = useCallback(async () => {
    stopAndDetachPendingTurn();
    return (await createSession()) !== null;
  }, [createSession, stopAndDetachPendingTurn]);

  const externallySessionReady = sessionReady && hydratedActiveTurn === null;

  return useMemo(() => ({
    sessionId,
    sessionReady: externallySessionReady,
    sessionOperationPending,
    sessionInitializationError: sessionInitializationFailed
      ? m.agentPanel.sessionLoadFailed
      : null,
    activeSessionId,
    sessions: sessionList,
    messages,
    hasEarlierMessages: nextBeforeSequence !== null,
    loadingEarlierMessages,
    phase: turnState.phase,
    running,
    status,
    error,
    errorCategory,
    lastTurnResult,
    contextLimitRecovery,
    draftRecovery,
    durableRetryDraft,
    canRetryLastTurn,
    toolActivities,
    conversationBinding,
    startTurn,
    stopTurn,
    editContextLimitedPrompt,
    createSession,
    switchSession,
    deleteSession,
    loadEarlierMessages,
    resetConversation,
    retrySessionHydration,
  }), [
    activeSessionId,
    contextLimitRecovery,
    canRetryLastTurn,
    draftRecovery,
    durableRetryDraft,
    editContextLimitedPrompt,
    errorCategory,
    error,
    createSession,
    deleteSession,
    lastTurnResult,
    loadEarlierMessages,
    loadingEarlierMessages,
    m.agentPanel.sessionLoadFailed,
    messages,
    nextBeforeSequence,
    resetConversation,
    retrySessionHydration,
    running,
    sessionInitializationFailed,
    sessionOperationPending,
    externallySessionReady,
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

