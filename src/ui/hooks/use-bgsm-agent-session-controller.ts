import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  createDurableBgsmAgentSession,
  deleteDurableBgsmAgentSession,
  inspectActiveBgsmAgentSessionTurn,
  inspectBgsmAgentSessionCatalog,
  loadDurableBgsmAgentSession,
  loadDurableBgsmAgentSessionCommittedTurn,
  loadDurableBgsmAgentSessionTranscriptPage,
  readDurableAgentRetryDraftCandidate,
  BackgroundCallError,
  type BgsmAgentActiveTurn,
  type BgsmAgentTurnResult,
} from '@/utils/messaging';
import {
  createBgsmAgentSession,
  type BgsmAgentSession,
} from '@/bgsm-agent/session';
import type { BgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';
import type {
  AgentRetryDraft,
  AgentSessionCommitResult,
  BgsmAgentSessionSummary,
  LoadedAgentSession,
} from '@/storage/agent-session-store';
import {
  cacheRecordFromLoaded,
  classifySessionLoadFailure,
  compareAgentSessionSummaries,
  isEmptyToolCallEnvelope,
  mergeCanonicalMessages,
  mergeChatMessages,
  mergeCommitPresentation,
  toCanonicalMessage,
  toChatMessage,
  type AgentSessionCacheRecord,
  type BgsmAgentChatMessage,
} from '@/ui/bgsm-agent-session-projection';
import {
  resolveBgsmAgentHydratedRetryState,
  type HydratedActiveTurn,
  type HydratedRetryResolution,
} from '@/ui/bgsm-agent-retry-recovery';
import type { PendingTurn } from '@/ui/hooks/use-bgsm-agent-turn-controller';

export const ACTIVE_AGENT_SESSION_STORAGE_KEY = 'gsm_agent_active_session_id';

export type AgentSessionStore = {
  records: Map<string, AgentSessionCacheRecord>;
  activeSessionId: string;
  persistence: 'pending' | 'durable' | 'memory';
};

export type HydrationGate = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

type SessionControllerRefs = Readonly<{
  hydrationGateRef: MutableRefObject<HydrationGate | null>;
  sessionStoreRef: MutableRefObject<AgentSessionStore | null>;
  sessionRef: MutableRefObject<BgsmAgentSession>;
  messagesRef: MutableRefObject<BgsmAgentChatMessage[]>;
  nextBeforeSequenceRef: MutableRefObject<number | null>;
  loadingEarlierMessagesRef: MutableRefObject<boolean>;
  conversationBindingRef: MutableRefObject<BgsmAgentConversationBinding | null>;
  retryDraftRef: MutableRefObject<AgentRetryDraft | null>;
  pendingTurnRef: MutableRefObject<PendingTurn | null>;
  sessionOperationRef: MutableRefObject<boolean>;
}>;

type SessionControllerState = Readonly<{
  messages: BgsmAgentChatMessage[];
  nextBeforeSequence: number | null;
  conversationBinding: BgsmAgentConversationBinding | null;
  sessionReady: boolean;
  hydrationAttempt: number;
}>;

type SessionControllerPresentation = Readonly<{
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  setSessionList: Dispatch<SetStateAction<BgsmAgentSessionSummary[]>>;
  setMessages: Dispatch<SetStateAction<BgsmAgentChatMessage[]>>;
  setNextBeforeSequence: Dispatch<SetStateAction<number | null>>;
  setLoadingEarlierMessages: Dispatch<SetStateAction<boolean>>;
  setSessionReady: Dispatch<SetStateAction<boolean>>;
  setSessionOperationPending: Dispatch<SetStateAction<boolean>>;
  setSessionInitializationFailed: Dispatch<SetStateAction<boolean>>;
  setHydratedActiveTurn: Dispatch<SetStateAction<HydratedActiveTurn | null>>;
  setHydrationAttempt: Dispatch<SetStateAction<number>>;
  setConversationBinding: Dispatch<SetStateAction<BgsmAgentConversationBinding | null>>;
  clearSessionUi: () => void;
}>;

type SessionControllerRetry = Readonly<{
  setActive: (draft: AgentRetryDraft | null) => void;
}>;

export type UseBgsmAgentSessionControllerOptions = Readonly<{
  refs: SessionControllerRefs;
  state: SessionControllerState;
  presentation: SessionControllerPresentation;
  retry: SessionControllerRetry;
}>;

export type BgsmAgentSessionController = Readonly<{
  createSession: () => Promise<string | null>;
  switchSession: (nextSessionId: string) => Promise<boolean>;
  deleteSession: (sessionIdToDelete: string) => Promise<boolean>;
  loadEarlierMessages: () => Promise<boolean>;
  retrySessionHydration: () => boolean;
  failSessionPersistence: () => void;
  recoverCommittedTurn: (pending: PendingTurn) => Promise<BgsmAgentTurnResult | null>;
  adoptCommit: (committed: AgentSessionCommitResult, pending: PendingTurn) => boolean;
  recoverUnavailable: (unavailableSessionId: string) => Promise<HydratedActiveTurn | null>;
  reconcileCanonical: (loaded: LoadedAgentSession) => void;
}>;

const resolveHydratedRetryState = (
  loaded: LoadedAgentSession,
  activeTurn: BgsmAgentActiveTurn | null,
): Promise<HydratedRetryResolution> => resolveBgsmAgentHydratedRetryState(
  loaded,
  activeTurn,
  { readCandidate: readDurableAgentRetryDraftCandidate },
);

export function useBgsmAgentSessionController(
  options: UseBgsmAgentSessionControllerOptions,
): BgsmAgentSessionController {
  const {
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
  } = options.refs;
  const {
    messages,
    nextBeforeSequence,
    conversationBinding,
    sessionReady,
    hydrationAttempt,
  } = options.state;
  const {
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
  } = options.presentation;
  const { setActive: setActiveRetryDraft } = options.retry;

  const publishSessionList = useCallback(() => {
    const store = sessionStoreRef.current;
    if (!store) return;
    setSessionList([...store.records.values()]
      .map((record) => record.summary)
      .sort(compareAgentSessionSummaries));
  }, [sessionStoreRef, setSessionList]);

  const syncActiveSessionRecord = useCallback(() => {
    const store = sessionStoreRef.current;
    if (!store) return;
    const record = store.records.get(store.activeSessionId);
    if (!record) return;
    record.session = sessionRef.current;
    record.messages = messagesRef.current;
    record.nextBeforeSequence = nextBeforeSequenceRef.current;
  }, [messagesRef, nextBeforeSequenceRef, sessionRef, sessionStoreRef]);

  useEffect(() => {
    messagesRef.current = messages;
    const store = sessionStoreRef.current;
    const record = store?.records.get(store.activeSessionId);
    if (record?.session) record.messages = messages;
  }, [messages, messagesRef, sessionStoreRef]);

  useEffect(() => {
    nextBeforeSequenceRef.current = nextBeforeSequence;
    const store = sessionStoreRef.current;
    const record = store?.records.get(store.activeSessionId);
    if (record?.session) record.nextBeforeSequence = nextBeforeSequence;
  }, [nextBeforeSequence, nextBeforeSequenceRef, sessionStoreRef]);

  useEffect(() => {
    conversationBindingRef.current = conversationBinding;
  }, [conversationBinding, conversationBindingRef]);

  const activateSessionRecord = useCallback((record: AgentSessionCacheRecord) => {
    if (!record.session || !record.messages) {
      throw new TypeError('Cannot activate an unloaded Cubby session.');
    }
    const store = sessionStoreRef.current;
    if (!store) return;
    store.activeSessionId = record.session.id;
    sessionRef.current = record.session;
    messagesRef.current = record.messages;
    nextBeforeSequenceRef.current = record.nextBeforeSequence;
    const binding = record.session.binding ?? null;
    conversationBindingRef.current = binding;
    setActiveSessionId(record.session.id);
    setMessages(record.messages);
    setNextBeforeSequence(record.nextBeforeSequence);
    setConversationBinding(binding);
    const draft = retryDraftRef.current?.sessionId === record.session.id
      && retryDraftRef.current.baseRevision === record.session.revision
      ? retryDraftRef.current
      : null;
    setActiveRetryDraft(draft);
    clearSessionUi();
  }, [
    clearSessionUi,
    conversationBindingRef,
    messagesRef,
    nextBeforeSequenceRef,
    retryDraftRef,
    sessionRef,
    sessionStoreRef,
    setActiveRetryDraft,
    setActiveSessionId,
    setConversationBinding,
    setMessages,
    setNextBeforeSequence,
  ]);

  const adoptActiveSessionRecord = useCallback((record: AgentSessionCacheRecord) => {
    const store = sessionStoreRef.current;
    if (!store || store.activeSessionId !== record.session!.id) {
      throw new TypeError('Cannot adopt a Cubby session outside the active conversation.');
    }
    store.records.set(record.summary.id, record);
    sessionRef.current = record.session!;
    messagesRef.current = record.messages!;
    nextBeforeSequenceRef.current = record.nextBeforeSequence;
    const binding = record.session!.binding ?? null;
    conversationBindingRef.current = binding;
    setMessages(record.messages!);
    setNextBeforeSequence(record.nextBeforeSequence);
    setConversationBinding(binding);
    if (
      retryDraftRef.current?.sessionId === record.session!.id
      && retryDraftRef.current.baseRevision !== record.session!.revision
    ) {
      const stale = retryDraftRef.current;
      const activePending = pendingTurnRef.current;
      if (
        activePending?.sessionId !== stale.sessionId
        || activePending.baseRevision !== stale.baseRevision
      ) {
        setActiveRetryDraft(null);
      }
    }
    publishSessionList();
  }, [
    conversationBindingRef,
    messagesRef,
    nextBeforeSequenceRef,
    pendingTurnRef,
    publishSessionList,
    retryDraftRef,
    sessionRef,
    sessionStoreRef,
    setConversationBinding,
    setMessages,
    setNextBeforeSequence,
  ]);

  const adoptCanonicalSession = useCallback((loaded: LoadedAgentSession) => {
    adoptActiveSessionRecord(cacheRecordFromLoaded(loaded));
  }, [adoptActiveSessionRecord]);

  const reconcileCanonicalSession = useCallback((loaded: LoadedAgentSession) => {
    // A reload is a new canonical recent-page snapshot. Merging it with an old
    // partial cache can hide a sequence gap after another tab appends messages.
    adoptCanonicalSession(loaded);
  }, [adoptCanonicalSession]);

  const recoverCommittedPendingTurn = useCallback(async (
    pending: PendingTurn,
  ): Promise<BgsmAgentTurnResult | null> => {
    const store = sessionStoreRef.current;
    if (store?.persistence !== 'durable') return null;
    const loaded = await loadDurableBgsmAgentSession(pending.sessionId);
    if (
      pendingTurnRef.current !== pending
      || sessionStoreRef.current?.activeSessionId !== pending.sessionId
    ) return null;
    const receipt = loaded.appliedTurnReceipts.find(
      ({ turnAttemptId }) => turnAttemptId === pending.turnAttemptId,
    );
    if (!receipt || receipt.appliedRevision <= pending.baseRevision) return null;
    const commit = await loadDurableBgsmAgentSessionCommittedTurn({
      sessionId: pending.sessionId,
      turnAttemptId: pending.turnAttemptId,
      launchDigest: receipt.launchDigest,
    });
    if (!commit) return null;
    return {
      turnAttemptId: pending.turnAttemptId,
      sessionId: pending.sessionId,
      baseRevision: pending.baseRevision,
      reason: receipt.outcome.reason,
      changed: receipt.outcome.changed,
      changedCount: receipt.outcome.changedCount,
      commit,
      ...(receipt.outcome.contextFailureReason
        ? { contextFailureReason: receipt.outcome.contextFailureReason }
        : {}),
      ...(receipt.outcome.organizeLibraryAction
        ? {
            organizeLibraryHandoff: {
              type: 'organize_whole_library' as const,
              action: receipt.outcome.organizeLibraryAction,
              instruction: pending.prompt,
            },
          }
        : {}),
    };
  }, [pendingTurnRef, sessionStoreRef]);

  const adoptCommitReceipt = useCallback((
    committed: AgentSessionCommitResult,
    pending: PendingTurn,
  ): boolean => {
    const store = sessionStoreRef.current;
    const current = store?.records.get(store.activeSessionId);
    if (
      !current?.session
      || !current.messages
      || current.session.id !== committed.session.id
      || committed.turnAttemptId !== pending.turnAttemptId
    ) {
      return false;
    }
    const committedChatMessages = committed.transcript.messages
      .filter((message) => !isEmptyToolCallEnvelope(message))
      .map(toChatMessage);
    const presentationMessages = committed.presentationMessages.map((message) =>
      toChatMessage(message),
    );
    const projectedChatMessages = mergeCommitPresentation(
      committedChatMessages,
      presentationMessages,
    );
    adoptActiveSessionRecord({
      summary: committed.summary,
      session: {
        ...committed.session,
        messages: committed.transcript.messages.map(toCanonicalMessage),
      },
      messages: projectedChatMessages,
      nextBeforeSequence: committed.transcript.nextBeforeSequence,
    });
    return true;
  }, [adoptActiveSessionRecord, sessionStoreRef]);

  useEffect(() => {
    let cancelled = false;
    const gate = hydrationGateRef.current!;
    void (async () => {
      const store = sessionStoreRef.current;
      if (!store) return;
      if (!supportsDurableAgentSessions()) {
        store.persistence = 'memory';
        if (!cancelled) {
          setSessionInitializationFailed(false);
          setSessionReady(true);
        }
        return;
      }
      store.persistence = 'pending';
      if (!cancelled) {
        setSessionReady(false);
        setSessionInitializationFailed(false);
      }
      try {
        const catalog = await inspectBgsmAgentSessionCatalog();
        const preferredId = await readActiveAgentSessionId();
        const corruptSessionIds = new Set<string>();
        const missingSessionIds = new Set<string>();
        const candidates = [
          ...(preferredId ? [preferredId] : []),
          ...catalog.summaries.map((summary) => summary.id),
        ].filter((id, index, values) => values.indexOf(id) === index);
        let loaded: LoadedAgentSession | null = null;
        for (const candidate of candidates) {
          if (!catalog.summaries.some((summary) => summary.id === candidate)) continue;
          try {
            loaded = await loadDurableBgsmAgentSession(candidate);
            break;
          } catch (error) {
            const failure = classifySessionLoadFailure(error);
            if (failure === 'corrupt') {
              corruptSessionIds.add(candidate);
              continue;
            }
            if (failure === 'not_found') {
              missingSessionIds.add(candidate);
              continue;
            }
            throw error;
          }
        }
        loaded ??= await createDurableBgsmAgentSession();
        const activeTurn = await inspectActiveBgsmAgentSessionTurn(loaded.session.id);
        const retryResolution = await resolveHydratedRetryState(loaded, activeTurn);
        if (cancelled) return;
        store.records = new Map(catalog.summaries
          .filter((summary) => !missingSessionIds.has(summary.id))
          .map((summary) => [summary.id, {
            summary: corruptSessionIds.has(summary.id)
              ? { ...summary, corrupt: true as const }
              : summary,
            session: null,
            messages: null,
            nextBeforeSequence: null,
          }]));
        for (const corruption of catalog.corruptions) {
          const sessionId = corruption.sessionId;
          if (!sessionId || sessionId.trim() !== sessionId || store.records.has(sessionId)) continue;
          store.records.set(sessionId, {
            summary: {
              id: sessionId,
              title: '',
              createdAt: 0,
              updatedAt: 0,
              corrupt: true,
            },
            session: null,
            messages: null,
            nextBeforeSequence: null,
          });
        }
        const activeRecord = cacheRecordFromLoaded(loaded);
        store.records.set(activeRecord.summary.id, activeRecord);
        store.persistence = 'durable';
        activateSessionRecord(activeRecord);
        setActiveRetryDraft(retryResolution.draft);
        setHydratedActiveTurn(retryResolution.activeTurn);
        publishSessionList();
        setSessionInitializationFailed(false);
        setSessionReady(true);
        await writeActiveAgentSessionId(activeRecord.summary.id);
      } catch {
        store.persistence = 'pending';
        if (!cancelled) {
          setSessionReady(false);
          setSessionInitializationFailed(true);
        }
      }
    })().finally(gate.resolve);
    return () => {
      cancelled = true;
    };
  }, [
    activateSessionRecord,
    hydrationAttempt,
    hydrationGateRef,
    publishSessionList,
    sessionStoreRef,
    setActiveRetryDraft,
    setHydratedActiveTurn,
    setSessionInitializationFailed,
    setSessionReady,
  ]);

  const retrySessionHydration = useCallback(() => {
    if (pendingTurnRef.current || sessionOperationRef.current) return false;
    hydrationGateRef.current = createHydrationGate();
    setSessionInitializationFailed(false);
    setSessionReady(false);
    setHydrationAttempt((attempt) => attempt + 1);
    return true;
  }, [
    hydrationGateRef,
    pendingTurnRef,
    sessionOperationRef,
    setHydrationAttempt,
    setSessionInitializationFailed,
    setSessionReady,
  ]);

  const failSessionPersistence = useCallback(() => {
    const store = sessionStoreRef.current;
    if (store) store.persistence = 'pending';
    setSessionReady(false);
    setSessionInitializationFailed(true);
  }, [sessionStoreRef, setSessionInitializationFailed, setSessionReady]);

  const loadEarlierMessages = useCallback(async () => {
    await hydrationGateRef.current!.promise;
    const beforeSequence = nextBeforeSequenceRef.current;
    const store = sessionStoreRef.current;
    if (
      !sessionReady
      || store?.persistence !== 'durable'
      || beforeSequence === null
      || pendingTurnRef.current
      || sessionOperationRef.current
      || loadingEarlierMessagesRef.current
    ) return false;
    const requestedSessionId = store.activeSessionId;
    loadingEarlierMessagesRef.current = true;
    sessionOperationRef.current = true;
    setLoadingEarlierMessages(true);
    setSessionOperationPending(true);
    try {
      const page = await loadDurableBgsmAgentSessionTranscriptPage(
        requestedSessionId,
        beforeSequence,
      );
      const currentStore = sessionStoreRef.current;
      const current = currentStore?.records.get(requestedSessionId);
      if (
        !currentStore
        || currentStore.activeSessionId !== requestedSessionId
        || page.sessionId !== requestedSessionId
        || !current?.session
        || !current.messages
      ) return false;
      const earlierChatMessages = page.messages
        .filter((message) => !isEmptyToolCallEnvelope(message))
        .map(toChatMessage);
      adoptActiveSessionRecord({
        ...current,
        session: {
          ...current.session,
          messages: mergeCanonicalMessages(
            page.messages.map(toCanonicalMessage),
            current.session.messages,
          ),
        },
        messages: mergeChatMessages(earlierChatMessages, current.messages),
        nextBeforeSequence: page.nextBeforeSequence,
      });
      return true;
    } catch {
      return false;
    } finally {
      loadingEarlierMessagesRef.current = false;
      sessionOperationRef.current = false;
      setLoadingEarlierMessages(false);
      setSessionOperationPending(false);
    }
  }, [
    adoptActiveSessionRecord,
    hydrationGateRef,
    loadingEarlierMessagesRef,
    nextBeforeSequenceRef,
    pendingTurnRef,
    sessionOperationRef,
    sessionReady,
    sessionStoreRef,
    setLoadingEarlierMessages,
    setSessionOperationPending,
  ]);

  const recoverUnavailableActiveSession = useCallback(async (
    unavailableSessionId: string,
  ): Promise<HydratedActiveTurn | null> => {
    const store = sessionStoreRef.current;
    if (!store || store.persistence !== 'durable') return null;
    const catalog = await inspectBgsmAgentSessionCatalog();
    const corruptSessionIds = new Set<string>();
    const missingSessionIds = new Set([unavailableSessionId]);
    let loaded: LoadedAgentSession | null = null;
    for (const summary of catalog.summaries) {
      if (missingSessionIds.has(summary.id)) continue;
      try {
        loaded = await loadDurableBgsmAgentSession(summary.id);
        break;
      } catch (error) {
        const failure = classifySessionLoadFailure(error);
        if (failure === 'corrupt') {
          corruptSessionIds.add(summary.id);
          continue;
        }
        if (failure === 'not_found') {
          missingSessionIds.add(summary.id);
          continue;
        }
        throw error;
      }
    }
    loaded ??= await createDurableBgsmAgentSession();
    store.records = new Map(catalog.summaries
      .filter((summary) => !missingSessionIds.has(summary.id))
      .map((summary) => [summary.id, {
        summary: corruptSessionIds.has(summary.id)
          ? { ...summary, corrupt: true as const }
          : summary,
        session: null,
        messages: null,
        nextBeforeSequence: null,
      }]));
    for (const corruption of catalog.corruptions) {
      const sessionId = corruption.sessionId;
      if (!sessionId || sessionId.trim() !== sessionId || store.records.has(sessionId)) continue;
      store.records.set(sessionId, {
        summary: {
          id: sessionId,
          title: '',
          createdAt: 0,
          updatedAt: 0,
          corrupt: true,
        },
        session: null,
        messages: null,
        nextBeforeSequence: null,
      });
    }
    const activeTurn = await inspectActiveBgsmAgentSessionTurn(loaded.session.id);
    const retryResolution = await resolveHydratedRetryState(loaded, activeTurn);
    const activeRecord = cacheRecordFromLoaded(loaded);
    store.records.set(activeRecord.summary.id, activeRecord);
    activateSessionRecord(activeRecord);
    setActiveRetryDraft(retryResolution.draft);
    publishSessionList();
    await writeActiveAgentSessionId(activeRecord.summary.id);
    return retryResolution.activeTurn;
  }, [
    activateSessionRecord,
    publishSessionList,
    sessionStoreRef,
    setActiveRetryDraft,
  ]);

  const createSession = useCallback(async () => {
    await hydrationGateRef.current!.promise;
    if (!sessionReady || pendingTurnRef.current || sessionOperationRef.current) return null;
    const store = sessionStoreRef.current;
    if (!store) return null;
    sessionOperationRef.current = true;
    setSessionOperationPending(true);
    try {
      syncActiveSessionRecord();
      let record: AgentSessionCacheRecord;
      if (store.persistence === 'durable') {
        const candidateSessionId = createBgsmAgentSession().id;
        try {
          record = cacheRecordFromLoaded(
            await createDurableBgsmAgentSession(candidateSessionId),
          );
        } catch (error) {
          try {
            record = cacheRecordFromLoaded(
              await loadDurableBgsmAgentSession(candidateSessionId),
            );
          } catch {
            throw error;
          }
        }
      } else {
        record = createMemorySessionRecord();
      }
      store.records.set(record.summary.id, record);
      activateSessionRecord(record);
      setHydratedActiveTurn(null);
      publishSessionList();
      await writeActiveAgentSessionId(record.summary.id);
      return record.summary.id;
    } catch {
      return null;
    } finally {
      sessionOperationRef.current = false;
      setSessionOperationPending(false);
    }
  }, [
    activateSessionRecord,
    hydrationGateRef,
    pendingTurnRef,
    publishSessionList,
    sessionOperationRef,
    sessionReady,
    sessionStoreRef,
    setHydratedActiveTurn,
    setSessionOperationPending,
    syncActiveSessionRecord,
  ]);

  const switchSession = useCallback(async (nextSessionId: string) => {
    await hydrationGateRef.current!.promise;
    if (!sessionReady || pendingTurnRef.current || sessionOperationRef.current) return false;
    const store = sessionStoreRef.current;
    if (!store || store.activeSessionId === nextSessionId) return false;
    const target = store.records.get(nextSessionId);
    if (!target || target.summary.corrupt) return false;
    sessionOperationRef.current = true;
    setSessionOperationPending(true);
    try {
      syncActiveSessionRecord();
      let loadedTarget = target;
      let retryResolution: HydratedRetryResolution = { draft: null, activeTurn: null };
      if (
        store.persistence === 'durable'
        || !loadedTarget.session
        || !loadedTarget.messages
      ) {
        const loaded = await loadDurableBgsmAgentSession(nextSessionId);
        if (store.persistence === 'durable') {
          const activeTurn = await inspectActiveBgsmAgentSessionTurn(nextSessionId);
          retryResolution = await resolveHydratedRetryState(loaded, activeTurn);
        }
        loadedTarget = cacheRecordFromLoaded(loaded);
        store.records.set(nextSessionId, loadedTarget);
      }
      activateSessionRecord(loadedTarget);
      setActiveRetryDraft(retryResolution.draft);
      setHydratedActiveTurn(retryResolution.activeTurn);
      publishSessionList();
      await writeActiveAgentSessionId(nextSessionId);
      return true;
    } catch (error) {
      const failure = classifySessionLoadFailure(error);
      if (failure === 'corrupt') {
        target.summary = { ...target.summary, corrupt: true };
        target.session = null;
        target.messages = null;
      } else if (failure === 'not_found') {
        store.records.delete(nextSessionId);
      }
      publishSessionList();
      return false;
    } finally {
      sessionOperationRef.current = false;
      setSessionOperationPending(false);
    }
  }, [
    activateSessionRecord,
    hydrationGateRef,
    pendingTurnRef,
    publishSessionList,
    sessionOperationRef,
    sessionReady,
    sessionStoreRef,
    setActiveRetryDraft,
    setHydratedActiveTurn,
    setSessionOperationPending,
    syncActiveSessionRecord,
  ]);

  const deleteSession = useCallback(async (sessionIdToDelete: string) => {
    await hydrationGateRef.current!.promise;
    if (!sessionReady || pendingTurnRef.current || sessionOperationRef.current) return false;
    const store = sessionStoreRef.current;
    if (!store || store.records.size <= 1 || !store.records.has(sessionIdToDelete)) return false;
    sessionOperationRef.current = true;
    setSessionOperationPending(true);
    try {
      syncActiveSessionRecord();
      const deletingActive = store.activeSessionId === sessionIdToDelete;
      let nextRecord: AgentSessionCacheRecord | null = null;
      let nextRetryResolution: HydratedRetryResolution = { draft: null, activeTurn: null };
      if (deletingActive) {
        const candidates = [...store.records.values()]
          .filter((record) => record.summary.id !== sessionIdToDelete)
          .filter((record) => !record.summary.corrupt)
          .sort((left, right) => compareAgentSessionSummaries(left.summary, right.summary));
        for (const candidate of candidates) {
          if (
            store.persistence !== 'durable'
            && candidate.session
            && candidate.messages
          ) {
            nextRecord = candidate;
            break;
          }
          try {
            const loaded = await loadDurableBgsmAgentSession(candidate.summary.id);
            const activeTurn = await inspectActiveBgsmAgentSessionTurn(candidate.summary.id);
            nextRetryResolution = await resolveHydratedRetryState(loaded, activeTurn);
            nextRecord = cacheRecordFromLoaded(loaded);
            store.records.set(candidate.summary.id, nextRecord);
            break;
          } catch (error) {
            const failure = classifySessionLoadFailure(error);
            if (failure === 'corrupt') {
              candidate.summary = { ...candidate.summary, corrupt: true };
              candidate.session = null;
              candidate.messages = null;
            } else if (failure === 'not_found') {
              store.records.delete(candidate.summary.id);
            }
          }
        }
        if (!nextRecord) {
          publishSessionList();
          return false;
        }
      }
      if (store.persistence === 'durable') {
        try {
          await deleteDurableBgsmAgentSession(sessionIdToDelete);
        } catch (error) {
          if (error instanceof BackgroundCallError) throw error;
          const catalog = await inspectBgsmAgentSessionCatalog();
          const stillExists = catalog.summaries.some(({ id }) => id === sessionIdToDelete)
            || catalog.corruptions.some(({ sessionId }) => sessionId === sessionIdToDelete);
          if (stillExists) throw error;
        }
      }
      store.records.delete(sessionIdToDelete);
      if (retryDraftRef.current?.sessionId === sessionIdToDelete) {
        setActiveRetryDraft(null);
      }
      if (nextRecord) {
        activateSessionRecord(nextRecord);
        setActiveRetryDraft(nextRetryResolution.draft);
        setHydratedActiveTurn(nextRetryResolution.activeTurn);
        await writeActiveAgentSessionId(nextRecord.summary.id);
      }
      publishSessionList();
      return true;
    } catch (error) {
      if (
        error instanceof BackgroundCallError
        && (
          error.code === 'agent_session_deletion_blocked'
          || error.code === 'agent_session_turn_active'
        )
      ) return false;
      throw error;
    } finally {
      sessionOperationRef.current = false;
      setSessionOperationPending(false);
    }
  }, [
    activateSessionRecord,
    hydrationGateRef,
    pendingTurnRef,
    publishSessionList,
    sessionOperationRef,
    sessionReady,
    sessionStoreRef,
    setActiveRetryDraft,
    setHydratedActiveTurn,
    setSessionOperationPending,
    syncActiveSessionRecord,
  ]);

  return {
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
  };
}

export function createHydrationGate(): HydrationGate {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createMemorySessionRecord(): AgentSessionCacheRecord {
  const session = createBgsmAgentSession();
  const now = Date.now();
  return {
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
}

function supportsDurableAgentSessions(): boolean {
  return typeof globalThis.chrome?.runtime?.sendMessage === 'function';
}

async function readActiveAgentSessionId(): Promise<string | null> {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.get) return null;
  try {
    const stored = await storage.get(ACTIVE_AGENT_SESSION_STORAGE_KEY);
    const value = stored[ACTIVE_AGENT_SESSION_STORAGE_KEY];
    return typeof value === 'string' && value.trim() === value && value.length > 0
      ? value
      : null;
  } catch {
    return null;
  }
}

async function writeActiveAgentSessionId(sessionId: string): Promise<void> {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.set) return;
  try {
    await storage.set({ [ACTIVE_AGENT_SESSION_STORAGE_KEY]: sessionId });
  } catch {
    // The durable session remains authoritative even if this lightweight hint fails.
  }
}
