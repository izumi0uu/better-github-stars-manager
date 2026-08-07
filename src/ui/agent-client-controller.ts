import {
  createBgsmAgentSession,
  type BgsmAgentSession,
} from '@/bgsm-agent/session';
import type {
  BgsmAgentConversationBinding,
  BgsmAgentConversationCandidate,
} from '@/bgsm-agent/conversation-binding';
import type { BgsmAgentTurnResult } from '@/bgsm-agent/turn-protocol';
import type {
  AgentRetryDraft,
  BgsmAgentSessionSummary,
} from '@/storage/agent-session-store';
import {
  createAgentTurnState,
  type AgentTurnState,
} from '@/ui/agent-turn-state';
import type {
  AgentSessionCacheRecord,
  BgsmAgentChatMessage,
} from '@/ui/bgsm-agent-session-projection';
import type { HydratedActiveTurn } from '@/ui/bgsm-agent-retry-recovery';
import {
  createBgsmAgentClientSessionController,
  createHydrationGate,
  type AgentSessionStore,
  type HydrationGate,
} from './agent-client-session-controller';
import {
  createBgsmAgentClientTurnController,
  type BgsmAgentClientTurnController,
  type BgsmAgentTurnStartOptions,
  type PendingTurn,
} from './agent-client-turn-controller';

export type BgsmAgentClientLabels = Readonly<{
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

export type BgsmAgentClientControllerOptions = Readonly<{
  labels: BgsmAgentClientLabels;
  candidateContract?: BgsmAgentConversationCandidate;
  onDataChanged?: () => void;
}>;

export type BgsmAgentClientSnapshot = Readonly<{
  activeSessionId: string;
  sessions: readonly BgsmAgentSessionSummary[];
  messages: readonly BgsmAgentChatMessage[];
  nextBeforeSequence: number | null;
  loadingEarlierMessages: boolean;
  sessionReady: boolean;
  sessionOperationPending: boolean;
  sessionInitializationFailed: boolean;
  hydratedActiveTurn: HydratedActiveTurn | null;
  durableRetryDraft: AgentRetryDraft | null;
  conversationBinding: BgsmAgentConversationBinding | null;
  turnState: AgentTurnState;
}>;

export type BgsmAgentClientController = Readonly<{
  getSnapshot(): BgsmAgentClientSnapshot;
  subscribe(listener: () => void): () => void;
  updateOptions(options: BgsmAgentClientControllerOptions): void;
  activate(): () => void;
  startTurn(prompt: string, options?: BgsmAgentTurnStartOptions): Promise<BgsmAgentTurnResult | null>;
  stopTurn(): void;
  editContextLimitedPrompt(): void;
  createSession(): Promise<string | null>;
  switchSession(sessionId: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  invalidateDeletedSessions(sessionIds: ReadonlySet<string>): void;
  loadEarlierMessages(): Promise<boolean>;
  resetConversation(): Promise<boolean>;
  retrySessionHydration(): boolean;
  getCanRetryLastTurn(): boolean;
}>;

/** Private mutable cells shared only by the three controller owners. */
export type BgsmAgentClientMutableState = {
  active: boolean;
  lifecycleGeneration: number;
  hydrationGate: HydrationGate;
  sessionStore: AgentSessionStore;
  activeSession: BgsmAgentSession;
  sessionList: BgsmAgentSessionSummary[];
  messages: BgsmAgentChatMessage[];
  nextBeforeSequence: number | null;
  loadingEarlierMessages: boolean;
  sessionReady: boolean;
  sessionOperationPending: boolean;
  sessionInitializationFailed: boolean;
  hydratedActiveTurn: HydratedActiveTurn | null;
  durableRetryDraft: AgentRetryDraft | null;
  conversationBinding: BgsmAgentConversationBinding | null;
  turnState: AgentTurnState;
  pendingTurn: PendingTurn | null;
  retryPresentationSequences: Map<string, number>;
};

export type BgsmAgentClientStateAccess = Readonly<{
  state: BgsmAgentClientMutableState;
  getOptions(): BgsmAgentClientControllerOptions;
  publish(): void;
  reserveRetryDraftPresentation(sessionId: string): number;
  setActiveRetryDraft(draft: AgentRetryDraft | null): void;
  isActiveGeneration(generation: number): boolean;
  createEmptyTurnState(): AgentTurnState;
}>;

type SnapshotSources = Readonly<{
  activeSessionId: string;
  sessions: readonly BgsmAgentSessionSummary[];
  messages: readonly BgsmAgentChatMessage[];
  nextBeforeSequence: number | null;
  loadingEarlierMessages: boolean;
  sessionReady: boolean;
  sessionOperationPending: boolean;
  sessionInitializationFailed: boolean;
  hydratedActiveTurn: HydratedActiveTurn | null;
  durableRetryDraft: AgentRetryDraft | null;
  conversationBinding: BgsmAgentConversationBinding | null;
  turnState: AgentTurnState;
}>;

/**
 * Creates one side-effect-free page controller. Chrome, storage and Port work
 * begin only from `activate`, so React Strict Mode can safely construct it.
 */
export function createBgsmAgentClientController(
  initialOptions: BgsmAgentClientControllerOptions,
): BgsmAgentClientController {
  let options = initialOptions;
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
  const state: BgsmAgentClientMutableState = {
    active: false,
    lifecycleGeneration: 0,
    hydrationGate: createHydrationGate(),
    sessionStore: {
      records: new Map([[session.id, record]]),
      activeSessionId: session.id,
      persistence: 'pending',
    },
    activeSession: session,
    sessionList: [record.summary],
    messages: [],
    nextBeforeSequence: null,
    loadingEarlierMessages: false,
    sessionReady: false,
    sessionOperationPending: false,
    sessionInitializationFailed: false,
    hydratedActiveTurn: null,
    durableRetryDraft: null,
    conversationBinding: session.binding ?? null,
    turnState: createAgentTurnState(),
    pendingTurn: null,
    retryPresentationSequences: new Map(),
  };
  const subscribers = new Set<() => void>();
  let sources = snapshotSources(state);
  let snapshot = createSnapshot(sources);
  let turnController: BgsmAgentClientTurnController | null = null;

  const publish = () => {
    const nextSources = snapshotSources(state);
    if (sameSnapshotSources(sources, nextSources)) {
      if (state.active) turnController?.resumeHydratedTurn(state.hydratedActiveTurn);
      return;
    }
    sources = nextSources;
    snapshot = createSnapshot(nextSources);
    for (const listener of [...subscribers]) listener();
    if (state.active) turnController?.resumeHydratedTurn(state.hydratedActiveTurn);
  };

  const reserveRetryDraftPresentation = (sessionId: string): number => {
    const sequence = (state.retryPresentationSequences.get(sessionId) ?? 0) + 1;
    state.retryPresentationSequences.set(sessionId, sequence);
    return sequence;
  };
  const setActiveRetryDraft = (draft: AgentRetryDraft | null) => {
    const sessionId = state.sessionStore.activeSessionId || draft?.sessionId;
    if (sessionId) reserveRetryDraftPresentation(sessionId);
    state.durableRetryDraft = draft;
  };
  const access: BgsmAgentClientStateAccess = {
    state,
    getOptions: () => options,
    publish,
    reserveRetryDraftPresentation,
    setActiveRetryDraft,
    isActiveGeneration: (generation) => state.active && state.lifecycleGeneration === generation,
    createEmptyTurnState: createAgentTurnState,
  };
  const sessionController = createBgsmAgentClientSessionController(access);
  turnController = createBgsmAgentClientTurnController(access, sessionController);

  const activate = (): (() => void) => {
    if (state.active) return () => {};
    state.active = true;
    state.lifecycleGeneration += 1;
    const generation = state.lifecycleGeneration;
    sessionController.activate(generation);
    turnController?.resumeHydratedTurn(state.hydratedActiveTurn);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (state.lifecycleGeneration !== generation) return;
      state.active = false;
      turnController?.deactivate();
      // Strict Mode immediately reactivates after its probe cleanup. Deferring
      // only session cancellation lets that activation join the same hydration.
      queueMicrotask(() => {
        if (!state.active && state.lifecycleGeneration === generation) {
          sessionController.deactivate(generation);
        }
      });
    };
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    updateOptions(nextOptions) {
      options = nextOptions;
    },
    activate,
    startTurn: (prompt, startOptions) => turnController!.startTurn(prompt, startOptions),
    stopTurn: () => turnController!.stopTurn(),
    editContextLimitedPrompt: () => turnController!.editContextLimitedPrompt(),
    createSession: () => sessionController.createSession(),
    switchSession: (sessionId) => sessionController.switchSession(sessionId),
    deleteSession: (sessionId) => sessionController.deleteSession(sessionId),
    invalidateDeletedSessions: (sessionIds) => sessionController.invalidateDeletedSessions(sessionIds),
    loadEarlierMessages: () => sessionController.loadEarlierMessages(),
    async resetConversation() {
      turnController!.stopAndDetachPendingTurn();
      return (await sessionController.createSession()) !== null;
    },
    retrySessionHydration: () => sessionController.retrySessionHydration(),
    getCanRetryLastTurn: () => state.turnState.canRetryLastTurn && (
      state.sessionStore.persistence === 'memory'
      || state.durableRetryDraft?.settlement === 'retryable'
    ),
  });
}

function snapshotSources(state: BgsmAgentClientMutableState): SnapshotSources {
  return {
    activeSessionId: state.sessionStore.activeSessionId,
    sessions: state.sessionList,
    messages: state.messages,
    nextBeforeSequence: state.nextBeforeSequence,
    loadingEarlierMessages: state.loadingEarlierMessages,
    sessionReady: state.sessionReady,
    sessionOperationPending: state.sessionOperationPending,
    sessionInitializationFailed: state.sessionInitializationFailed,
    hydratedActiveTurn: state.hydratedActiveTurn,
    durableRetryDraft: state.durableRetryDraft,
    conversationBinding: state.conversationBinding,
    turnState: state.turnState,
  };
}

function sameSnapshotSources(left: SnapshotSources, right: SnapshotSources): boolean {
  return left.activeSessionId === right.activeSessionId
    && left.sessions === right.sessions
    && left.messages === right.messages
    && left.nextBeforeSequence === right.nextBeforeSequence
    && left.loadingEarlierMessages === right.loadingEarlierMessages
    && left.sessionReady === right.sessionReady
    && left.sessionOperationPending === right.sessionOperationPending
    && left.sessionInitializationFailed === right.sessionInitializationFailed
    && left.hydratedActiveTurn === right.hydratedActiveTurn
    && left.durableRetryDraft === right.durableRetryDraft
    && left.conversationBinding === right.conversationBinding
    && left.turnState === right.turnState;
}

function createSnapshot(sources: SnapshotSources): BgsmAgentClientSnapshot {
  return Object.freeze({
    activeSessionId: sources.activeSessionId,
    sessions: Object.freeze(sources.sessions.map((summary) => Object.freeze({ ...summary }))),
    messages: Object.freeze(sources.messages.map((message) => Object.freeze({ ...message }))),
    nextBeforeSequence: sources.nextBeforeSequence,
    loadingEarlierMessages: sources.loadingEarlierMessages,
    sessionReady: sources.sessionReady,
    sessionOperationPending: sources.sessionOperationPending,
    sessionInitializationFailed: sources.sessionInitializationFailed,
    hydratedActiveTurn: sources.hydratedActiveTurn,
    durableRetryDraft: sources.durableRetryDraft && Object.freeze({ ...sources.durableRetryDraft }),
    conversationBinding: sources.conversationBinding,
    turnState: Object.freeze({
      ...sources.turnState,
      toolActivities: Object.freeze(sources.turnState.toolActivities.map((activity) => (
        Object.freeze({ ...activity })
      ))),
    }),
  });
}
