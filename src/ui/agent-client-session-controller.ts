import type {
  BgsmAgentActiveTurn,
  BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';
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
} from '@/utils/messaging';
import { createBgsmAgentSession } from '@/bgsm-agent/session';
import type {
  AgentSessionCatalogInspection,
  AgentSessionCommitResult,
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
} from '@/ui/bgsm-agent-session-projection';
import {
  resolveBgsmAgentHydratedRetryState,
  type HydratedActiveTurn,
  type HydratedRetryResolution,
} from '@/ui/bgsm-agent-retry-recovery';
import type {
  BgsmAgentClientStateAccess,
} from './agent-client-controller';
import type { PendingTurn } from './agent-client-turn-controller';

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

export type BgsmAgentClientSessionController = Readonly<{
  activate(generation: number): void;
  deactivate(generation: number): void;
  createSession(): Promise<string | null>;
  switchSession(nextSessionId: string): Promise<boolean>;
  deleteSession(sessionIdToDelete: string): Promise<boolean>;
  invalidateDeletedSessions(deletedSessionIds: ReadonlySet<string>): void;
  loadEarlierMessages(): Promise<boolean>;
  retrySessionHydration(): boolean;
  failSessionPersistence(): void;
  recoverCommittedTurn(pending: PendingTurn): Promise<BgsmAgentTurnResult | null>;
  adoptCommit(committed: AgentSessionCommitResult, pending: PendingTurn): boolean;
  recoverUnavailable(unavailableSessionId: string): Promise<HydratedActiveTurn | null>;
  reconcileCanonical(loaded: LoadedAgentSession): void;
}>;

const resolveHydratedRetryState = (
  loaded: LoadedAgentSession,
  activeTurn: BgsmAgentActiveTurn | null,
): Promise<HydratedRetryResolution> => resolveBgsmAgentHydratedRetryState(
  loaded,
  activeTurn,
  { readCandidate: readDurableAgentRetryDraftCandidate },
);

/**
 * Per-page durable-session authority. The aggregate controller supplies the
 * private mutable cells and emits the only public snapshot.
 */
export function createBgsmAgentClientSessionController(
  access: BgsmAgentClientStateAccess,
): BgsmAgentClientSessionController {
  const { state } = access;
  const deletedSessionIds = new Set<string>();
  let invalidationTail: Promise<void> = Promise.resolve();
  let hydrationInFlight: HydrationGate | null = null;
  let operationId = 0;

  const publishSessionList = () => {
    state.sessionList = [...state.sessionStore.records.values()]
      .map((record) => record.summary)
      .sort(compareAgentSessionSummaries);
  };

  const syncActiveSessionRecord = () => {
    const record = state.sessionStore.records.get(state.sessionStore.activeSessionId);
    if (!record) return;
    record.session = state.activeSession;
    record.messages = state.messages;
    record.nextBeforeSequence = state.nextBeforeSequence;
  };

  const activeRecord = (): AgentSessionCacheRecord | null => (
    state.sessionStore.records.get(state.sessionStore.activeSessionId) ?? null
  );

  const setActiveRetryDraft = access.setActiveRetryDraft;

  const activateSessionRecord = (
    record: AgentSessionCacheRecord,
    { clearTurn = true }: Readonly<{ clearTurn?: boolean }> = {},
  ) => {
    if (!record.session || !record.messages) {
      throw new TypeError('Cannot activate an unloaded Cubby session.');
    }
    state.sessionStore.activeSessionId = record.session.id;
    state.activeSession = record.session;
    state.messages = record.messages;
    state.nextBeforeSequence = record.nextBeforeSequence;
    state.conversationBinding = record.session.binding ?? null;
    const draft = state.durableRetryDraft?.sessionId === record.session.id
      && state.durableRetryDraft.baseRevision === record.session.revision
      ? state.durableRetryDraft
      : null;
    setActiveRetryDraft(draft);
    if (clearTurn) state.turnState = access.createEmptyTurnState();
  };

  const adoptActiveSessionRecord = (record: AgentSessionCacheRecord) => {
    if (!record.session || !record.messages || state.sessionStore.activeSessionId !== record.session.id) {
      throw new TypeError('Cannot adopt a Cubby session outside the active conversation.');
    }
    state.sessionStore.records.set(record.summary.id, record);
    state.activeSession = record.session;
    state.messages = record.messages;
    state.nextBeforeSequence = record.nextBeforeSequence;
    state.conversationBinding = record.session.binding ?? null;
    if (
      state.durableRetryDraft?.sessionId === record.session.id
      && state.durableRetryDraft.baseRevision !== record.session.revision
    ) {
      const pending = state.pendingTurn;
      if (
        pending?.sessionId !== state.durableRetryDraft.sessionId
        || pending.baseRevision !== state.durableRetryDraft.baseRevision
      ) {
        setActiveRetryDraft(null);
      }
    }
    publishSessionList();
  };

  const isCurrent = (generation: number) => access.isActiveGeneration(generation);
  const isCurrentHydration = (gate: HydrationGate) => (
    state.active && state.hydrationGate === gate
  );

  const beginOperation = (generation: number): number | null => {
    if (!isCurrent(generation) || state.sessionOperationPending || state.pendingTurn) return null;
    const currentOperationId = ++operationId;
    state.sessionOperationPending = true;
    access.publish();
    return currentOperationId;
  };

  const finishOperation = (generation: number, currentOperationId: number) => {
    if (!isCurrent(generation) || operationId !== currentOperationId) return;
    state.sessionOperationPending = false;
    state.loadingEarlierMessages = false;
    access.publish();
  };

  const populateCatalogRecords = (
    catalog: AgentSessionCatalogInspection,
    corruptSessionIds: ReadonlySet<string>,
    missingSessionIds: ReadonlySet<string>,
  ): Map<string, AgentSessionCacheRecord> => {
    const records = new Map<string, AgentSessionCacheRecord>(catalog.summaries
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
      if (!sessionId || sessionId.trim() !== sessionId || records.has(sessionId)) continue;
      records.set(sessionId, {
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
    return records;
  };

  const startHydration = () => {
    const gate = state.hydrationGate;
    if (hydrationInFlight === gate || state.sessionReady || !state.active) return;
    hydrationInFlight = gate;
    void (async () => {
      const store = state.sessionStore;
      if (!supportsDurableAgentSessions()) {
        if (!isCurrentHydration(gate)) return;
        store.persistence = 'memory';
        state.sessionInitializationFailed = false;
        state.sessionReady = true;
        publishSessionList();
        access.publish();
        return;
      }
      store.persistence = 'pending';
      state.sessionReady = false;
      state.sessionInitializationFailed = false;
      access.publish();
      try {
        const [catalog, preferredId] = await Promise.all([
          inspectBgsmAgentSessionCatalog(),
          readActiveAgentSessionId(),
        ]);
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
        if (!isCurrentHydration(gate)) return;
        store.records = populateCatalogRecords(catalog, corruptSessionIds, missingSessionIds);
        const record = cacheRecordFromLoaded(loaded);
        store.records.set(record.summary.id, record);
        store.persistence = 'durable';
        activateSessionRecord(record);
        setActiveRetryDraft(retryResolution.draft);
        state.hydratedActiveTurn = retryResolution.activeTurn;
        publishSessionList();
        state.sessionInitializationFailed = false;
        state.sessionReady = true;
        access.publish();
        await writeActiveAgentSessionId(record.summary.id);
      } catch {
        if (!isCurrentHydration(gate)) return;
        store.persistence = 'pending';
        state.sessionReady = false;
        state.sessionInitializationFailed = true;
        access.publish();
      }
    })().finally(() => {
      gate.resolve();
      if (hydrationInFlight === gate) hydrationInFlight = null;
    });
  };

  const recoverCommittedTurn = async (pending: PendingTurn): Promise<BgsmAgentTurnResult | null> => {
    if (state.sessionStore.persistence !== 'durable') return null;
    const generation = state.lifecycleGeneration;
    const loaded = await loadDurableBgsmAgentSession(pending.sessionId);
    if (
      !isCurrent(generation)
      || state.pendingTurn !== pending
      || state.sessionStore.activeSessionId !== pending.sessionId
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
    if (!commit || !isCurrent(generation) || state.pendingTurn !== pending) return null;
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
  };

  const adoptCommit = (committed: AgentSessionCommitResult, pending: PendingTurn): boolean => {
    const current = activeRecord();
    if (
      !current?.session
      || !current.messages
      || current.session.id !== committed.session.id
      || committed.turnAttemptId !== pending.turnAttemptId
    ) return false;
    const committedMessages = committed.transcript.messages
      .filter((message) => !isEmptyToolCallEnvelope(message))
      .map(toChatMessage);
    const presentationMessages = committed.presentationMessages.map(toChatMessage);
    adoptActiveSessionRecord({
      summary: committed.summary,
      session: {
        ...committed.session,
        messages: committed.transcript.messages.map(toCanonicalMessage),
      },
      messages: mergeCommitPresentation(committedMessages, presentationMessages),
      nextBeforeSequence: committed.transcript.nextBeforeSequence,
    });
    access.publish();
    return true;
  };

  const reconcileCanonical = (loaded: LoadedAgentSession) => {
    if (state.sessionStore.activeSessionId !== loaded.session.id) return;
    adoptActiveSessionRecord(cacheRecordFromLoaded(loaded));
    access.publish();
  };

  const failSessionPersistence = () => {
    state.sessionStore.persistence = 'pending';
    state.sessionReady = false;
    state.sessionInitializationFailed = true;
    access.publish();
  };

  const retrySessionHydration = () => {
    if (state.pendingTurn || state.sessionOperationPending) return false;
    state.hydrationGate = createHydrationGate();
    state.sessionReady = false;
    state.sessionInitializationFailed = false;
    state.lifecycleGeneration += 1;
    access.publish();
    if (state.active) startHydration();
    return true;
  };

  const loadEarlierMessages = async (): Promise<boolean> => {
    const gate = state.hydrationGate;
    await gate.promise;
    const generation = state.lifecycleGeneration;
    const beforeSequence = state.nextBeforeSequence;
    if (
      !isCurrent(generation)
      || gate !== state.hydrationGate
      || !state.sessionReady
      || state.sessionStore.persistence !== 'durable'
      || beforeSequence === null
      || state.pendingTurn
      || state.sessionOperationPending
      || state.loadingEarlierMessages
    ) return false;
    const requestedSessionId = state.sessionStore.activeSessionId;
    const currentOperationId = beginOperation(generation);
    if (currentOperationId === null) return false;
    state.loadingEarlierMessages = true;
    access.publish();
    try {
      const page = await loadDurableBgsmAgentSessionTranscriptPage(requestedSessionId, beforeSequence);
      const current = activeRecord();
      if (
        !isCurrent(generation)
        || operationId !== currentOperationId
        || state.sessionStore.activeSessionId !== requestedSessionId
        || page.sessionId !== requestedSessionId
        || !current?.session
        || !current.messages
      ) return false;
      const earlierMessages = page.messages
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
        messages: mergeChatMessages(earlierMessages, current.messages),
        nextBeforeSequence: page.nextBeforeSequence,
      });
      access.publish();
      return true;
    } catch {
      return false;
    } finally {
      finishOperation(generation, currentOperationId);
    }
  };

  const recoverUnavailable = async (unavailableSessionId: string): Promise<HydratedActiveTurn | null> => {
    const generation = state.lifecycleGeneration;
    if (!isCurrent(generation) || state.sessionStore.persistence !== 'durable') return null;
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
    const activeTurn = await inspectActiveBgsmAgentSessionTurn(loaded.session.id);
    const retryResolution = await resolveHydratedRetryState(loaded, activeTurn);
    if (!isCurrent(generation)) return null;
    state.sessionStore.records = populateCatalogRecords(catalog, corruptSessionIds, missingSessionIds);
    const record = cacheRecordFromLoaded(loaded);
    state.sessionStore.records.set(record.summary.id, record);
    activateSessionRecord(record);
    setActiveRetryDraft(retryResolution.draft);
    state.hydratedActiveTurn = retryResolution.activeTurn;
    publishSessionList();
    access.publish();
    await writeActiveAgentSessionId(record.summary.id);
    return retryResolution.activeTurn;
  };

  const createSession = async (): Promise<string | null> => {
    const gate = state.hydrationGate;
    await gate.promise;
    const generation = state.lifecycleGeneration;
    if (
      !isCurrent(generation)
      || gate !== state.hydrationGate
      || !state.sessionReady
      || state.pendingTurn
      || state.sessionOperationPending
    ) return null;
    const currentOperationId = beginOperation(generation);
    if (currentOperationId === null) return null;
    try {
      syncActiveSessionRecord();
      let record: AgentSessionCacheRecord;
      if (state.sessionStore.persistence === 'durable') {
        const candidateSessionId = createBgsmAgentSession().id;
        try {
          record = cacheRecordFromLoaded(await createDurableBgsmAgentSession(candidateSessionId));
        } catch (error) {
          try {
            record = cacheRecordFromLoaded(await loadDurableBgsmAgentSession(candidateSessionId));
          } catch {
            throw error;
          }
        }
      } else {
        record = createMemorySessionRecord();
      }
      if (!isCurrent(generation) || operationId !== currentOperationId) return null;
      state.sessionStore.records.set(record.summary.id, record);
      activateSessionRecord(record);
      state.hydratedActiveTurn = null;
      setActiveRetryDraft(null);
      publishSessionList();
      access.publish();
      await writeActiveAgentSessionId(record.summary.id);
      return isCurrent(generation) && operationId === currentOperationId ? record.summary.id : null;
    } catch {
      return null;
    } finally {
      finishOperation(generation, currentOperationId);
    }
  };

  const switchSession = async (nextSessionId: string): Promise<boolean> => {
    const gate = state.hydrationGate;
    await gate.promise;
    const generation = state.lifecycleGeneration;
    if (
      !isCurrent(generation)
      || gate !== state.hydrationGate
      || !state.sessionReady
      || state.pendingTurn
      || state.sessionOperationPending
      || state.sessionStore.activeSessionId === nextSessionId
      || deletedSessionIds.has(nextSessionId)
    ) return false;
    const target = state.sessionStore.records.get(nextSessionId);
    if (!target || target.summary.corrupt) return false;
    const currentOperationId = beginOperation(generation);
    if (currentOperationId === null) return false;
    try {
      syncActiveSessionRecord();
      let record = target;
      let retryResolution: HydratedRetryResolution = { draft: null, activeTurn: null };
      if (state.sessionStore.persistence === 'durable' || !record.session || !record.messages) {
        const loaded = await loadDurableBgsmAgentSession(nextSessionId);
        if (state.sessionStore.persistence === 'durable') {
          retryResolution = await resolveHydratedRetryState(
            loaded,
            await inspectActiveBgsmAgentSessionTurn(nextSessionId),
          );
        }
        if (!isCurrent(generation) || operationId !== currentOperationId) return false;
        if (deletedSessionIds.has(nextSessionId)) {
          state.sessionStore.records.delete(nextSessionId);
          publishSessionList();
          access.publish();
          return false;
        }
        record = cacheRecordFromLoaded(loaded);
        state.sessionStore.records.set(nextSessionId, record);
      }
      activateSessionRecord(record);
      setActiveRetryDraft(retryResolution.draft);
      state.hydratedActiveTurn = retryResolution.activeTurn;
      publishSessionList();
      access.publish();
      await writeActiveAgentSessionId(nextSessionId);
      return isCurrent(generation) && operationId === currentOperationId;
    } catch (error) {
      if (!isCurrent(generation) || operationId !== currentOperationId) return false;
      const failure = classifySessionLoadFailure(error);
      if (failure === 'corrupt') {
        target.summary = { ...target.summary, corrupt: true };
        target.session = null;
        target.messages = null;
      } else if (failure === 'not_found') {
        state.sessionStore.records.delete(nextSessionId);
      }
      publishSessionList();
      access.publish();
      return false;
    } finally {
      finishOperation(generation, currentOperationId);
    }
  };

  const deleteSession = async (sessionIdToDelete: string): Promise<boolean> => {
    const gate = state.hydrationGate;
    await gate.promise;
    const generation = state.lifecycleGeneration;
    if (
      !isCurrent(generation)
      || gate !== state.hydrationGate
      || !state.sessionReady
      || state.pendingTurn
      || state.sessionOperationPending
      || state.sessionStore.records.size <= 1
      || !state.sessionStore.records.has(sessionIdToDelete)
    ) return false;
    const currentOperationId = beginOperation(generation);
    if (currentOperationId === null) return false;
    try {
      syncActiveSessionRecord();
      const deletingActive = state.sessionStore.activeSessionId === sessionIdToDelete;
      let replacement: AgentSessionCacheRecord | null = null;
      let retryResolution: HydratedRetryResolution = { draft: null, activeTurn: null };
      if (deletingActive) {
        const candidates = [...state.sessionStore.records.values()]
          .filter((record) => record.summary.id !== sessionIdToDelete && !record.summary.corrupt)
          .sort((left, right) => compareAgentSessionSummaries(left.summary, right.summary));
        for (const candidate of candidates) {
          if (state.sessionStore.persistence !== 'durable' && candidate.session && candidate.messages) {
            replacement = candidate;
            break;
          }
          try {
            const loaded = await loadDurableBgsmAgentSession(candidate.summary.id);
            const activeTurn = await inspectActiveBgsmAgentSessionTurn(candidate.summary.id);
            retryResolution = await resolveHydratedRetryState(loaded, activeTurn);
            replacement = cacheRecordFromLoaded(loaded);
            state.sessionStore.records.set(candidate.summary.id, replacement);
            break;
          } catch (error) {
            const failure = classifySessionLoadFailure(error);
            if (failure === 'corrupt') {
              candidate.summary = { ...candidate.summary, corrupt: true };
              candidate.session = null;
              candidate.messages = null;
            } else if (failure === 'not_found') {
              state.sessionStore.records.delete(candidate.summary.id);
            }
          }
        }
        if (!replacement) {
          publishSessionList();
          access.publish();
          return false;
        }
      }
      if (state.sessionStore.persistence === 'durable') {
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
      if (!isCurrent(generation) || operationId !== currentOperationId) return false;
      state.sessionStore.records.delete(sessionIdToDelete);
      if (state.durableRetryDraft?.sessionId === sessionIdToDelete) setActiveRetryDraft(null);
      if (replacement) {
        activateSessionRecord(replacement);
        setActiveRetryDraft(retryResolution.draft);
        state.hydratedActiveTurn = retryResolution.activeTurn;
        await writeActiveAgentSessionId(replacement.summary.id);
      }
      publishSessionList();
      access.publish();
      return true;
    } catch (error) {
      if (
        error instanceof BackgroundCallError
        && (error.code === 'agent_session_deletion_blocked' || error.code === 'agent_session_turn_active')
      ) return false;
      throw error;
    } finally {
      finishOperation(generation, currentOperationId);
    }
  };

  const invalidateDeletedSessions = (sessionIds: ReadonlySet<string>) => {
    for (const sessionId of sessionIds) deletedSessionIds.add(sessionId);
    const invalidationGeneration = state.lifecycleGeneration;
    operationId += 1;
    if (state.sessionOperationPending || state.loadingEarlierMessages) {
      state.sessionOperationPending = false;
      state.loadingEarlierMessages = false;
      access.publish();
    }
    invalidationTail = invalidationTail.then(async () => {
      const generation = state.lifecycleGeneration;
      await state.hydrationGate.promise;
      if (!isCurrent(generation)) return;
      const deletingActive = deletedSessionIds.has(state.sessionStore.activeSessionId);
      for (const sessionId of deletedSessionIds) state.sessionStore.records.delete(sessionId);
      if (state.durableRetryDraft && deletedSessionIds.has(state.durableRetryDraft.sessionId)) {
        setActiveRetryDraft(null);
      }
      if (!deletingActive) {
        publishSessionList();
        access.publish();
        return;
      }
      let replacement: AgentSessionCacheRecord | null = null;
      let retryResolution: HydratedRetryResolution = { draft: null, activeTurn: null };
      const candidates = [...state.sessionStore.records.values()]
        .filter((record) => !record.summary.corrupt)
        .sort((left, right) => compareAgentSessionSummaries(left.summary, right.summary));
      for (const candidate of candidates) {
        if (deletedSessionIds.has(candidate.summary.id)) continue;
        if (state.sessionStore.persistence !== 'durable' && candidate.session && candidate.messages) {
          replacement = candidate;
          break;
        }
        try {
          const loaded = await loadDurableBgsmAgentSession(candidate.summary.id);
          if (deletedSessionIds.has(loaded.session.id)) continue;
          retryResolution = await resolveHydratedRetryState(
            loaded,
            await inspectActiveBgsmAgentSessionTurn(loaded.session.id),
          );
          replacement = cacheRecordFromLoaded(loaded);
          break;
        } catch (error) {
          const failure = classifySessionLoadFailure(error);
          if (failure === 'corrupt') {
            candidate.summary = { ...candidate.summary, corrupt: true };
            candidate.session = null;
            candidate.messages = null;
          } else if (failure === 'not_found') {
            state.sessionStore.records.delete(candidate.summary.id);
          }
        }
      }
      if (!replacement) {
        replacement = state.sessionStore.persistence === 'durable'
          ? cacheRecordFromLoaded(await createDurableBgsmAgentSession())
          : createMemorySessionRecord();
        retryResolution = { draft: null, activeTurn: null };
      }
      if (!isCurrent(generation) || deletedSessionIds.has(replacement.summary.id)) return;
      state.sessionStore.records.set(replacement.summary.id, replacement);
      activateSessionRecord(replacement);
      setActiveRetryDraft(retryResolution.draft);
      state.hydratedActiveTurn = retryResolution.activeTurn;
      publishSessionList();
      access.publish();
      await writeActiveAgentSessionId(replacement.summary.id);
    }).catch(() => {
      if (!state.active || state.lifecycleGeneration !== invalidationGeneration) return;
      state.sessionReady = false;
      state.sessionInitializationFailed = true;
      access.publish();
    });
  };

  return {
    activate(generation) {
      if (!access.isActiveGeneration(generation)) return;
      startHydration();
    },
    deactivate(generation) {
      if (state.lifecycleGeneration !== generation || state.active) return;
      operationId += 1;
      state.sessionOperationPending = false;
      state.loadingEarlierMessages = false;
      access.publish();
    },
    createSession,
    switchSession,
    deleteSession,
    invalidateDeletedSessions,
    loadEarlierMessages,
    retrySessionHydration,
    failSessionPersistence,
    recoverCommittedTurn,
    adoptCommit,
    recoverUnavailable,
    reconcileCanonical,
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
