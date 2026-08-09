import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import type { BgsmAgentTurnResult } from '@/bgsm-agent/turn-protocol';
import { useI18n } from '@/i18n';
import type {
  BgsmAgentClientController,
  BgsmAgentClientControllerOptions,
  BgsmAgentClientLabels,
  BgsmAgentClientSnapshot,
} from '@/ui/agent-client-controller';
import { createBgsmAgentClientController } from '@/ui/agent-client-controller';
import type { BgsmAgentChatMessage } from '@/ui/bgsm-agent-session-projection';
import type { BgsmAgentSessionSummary, AgentRetryDraft } from '@/storage/agent-session-store';
import type {
  BgsmAgentContextLimitRecovery,
  BgsmAgentStatus,
  BgsmAgentToolActivity,
  AgentTurnPhase,
} from '@/ui/agent-turn-state';
import type { BgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';

export type BgsmAgentHookState = Readonly<{
  sessionId: string;
  sessionReady: boolean;
  sessionOperationPending: boolean;
  sessionInitializationError: string | null;
  activeSessionId: string;
  sessions: readonly BgsmAgentSessionSummary[];
  messages: readonly BgsmAgentChatMessage[];
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  phase: AgentTurnPhase;
  running: boolean;
  status: BgsmAgentStatus | null;
  error: string | null;
  errorCategory: BgsmAgentClientSnapshot['turnState']['errorCategory'];
  lastTurnResult: BgsmAgentTurnResult | null;
  contextLimitRecovery: BgsmAgentContextLimitRecovery | null;
  draftRecovery: string | null;
  durableRetryDraft: AgentRetryDraft | null;
  canRetryLastTurn: boolean;
  transientSafeResendPrompt: string | null;
  toolActivities: readonly BgsmAgentToolActivity[];
  conversationBinding: BgsmAgentConversationBinding | null;
  startTurn: BgsmAgentClientController['startTurn'];
  stopTurn: BgsmAgentClientController['stopTurn'];
  editContextLimitedPrompt: BgsmAgentClientController['editContextLimitedPrompt'];
  clearTransientSafeResend: BgsmAgentClientController['clearTransientSafeResend'];
  createSession: BgsmAgentClientController['createSession'];
  switchSession: BgsmAgentClientController['switchSession'];
  deleteSession: BgsmAgentClientController['deleteSession'];
  invalidateDeletedSessions: BgsmAgentClientController['invalidateDeletedSessions'];
  loadEarlierMessages: BgsmAgentClientController['loadEarlierMessages'];
  resetConversation: BgsmAgentClientController['resetConversation'];
  retrySessionHydration: BgsmAgentClientController['retrySessionHydration'];
}>;

/** React/localization adapter over one page-local external client controller. */
export function useBgsmAgent(
  onDataChanged?: () => void,
  candidateContract?: BgsmAgentConversationCandidate,
): BgsmAgentHookState {
  const { m } = useI18n();
  const labels = labelsFromCatalog(m.agentPanel);
  const options: BgsmAgentClientControllerOptions = {
    labels,
    candidateContract,
    onDataChanged,
  };
  const controllerRef = useRef<BgsmAgentClientController | null>(null);
  if (!controllerRef.current) controllerRef.current = createBgsmAgentClientController(options);
  const controller = controllerRef.current;
  controller.updateOptions(options);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => controller.activate(), [controller]);

  return useMemo(() => projectHookState(
    snapshot,
    controller,
    m.agentPanel.sessionLoadFailed,
  ), [controller, m.agentPanel.sessionLoadFailed, snapshot]);
}

function projectHookState(
  snapshot: BgsmAgentClientSnapshot,
  controller: BgsmAgentClientController,
  sessionLoadFailed: string,
): BgsmAgentHookState {
  const { turnState } = snapshot;
  return {
    sessionId: snapshot.activeSessionId,
    sessionReady: snapshot.sessionReady && snapshot.hydratedActiveTurn === null,
    sessionOperationPending: snapshot.sessionOperationPending,
    sessionInitializationError: snapshot.sessionInitializationFailed ? sessionLoadFailed : null,
    activeSessionId: snapshot.activeSessionId,
    sessions: snapshot.sessions,
    messages: snapshot.messages,
    hasEarlierMessages: snapshot.nextBeforeSequence !== null,
    loadingEarlierMessages: snapshot.loadingEarlierMessages,
    phase: turnState.phase,
    running: turnState.running,
    status: turnState.status,
    error: turnState.error,
    errorCategory: turnState.errorCategory,
    lastTurnResult: turnState.lastTurnResult,
    contextLimitRecovery: turnState.contextLimitRecovery,
    draftRecovery: turnState.draftRecovery,
    durableRetryDraft: snapshot.durableRetryDraft,
    canRetryLastTurn: controller.getCanRetryLastTurn(),
    transientSafeResendPrompt: controller.getTransientSafeResendPrompt(),
    toolActivities: turnState.toolActivities,
    conversationBinding: snapshot.conversationBinding,
    startTurn: controller.startTurn,
    stopTurn: controller.stopTurn,
    editContextLimitedPrompt: controller.editContextLimitedPrompt,
    clearTransientSafeResend: controller.clearTransientSafeResend,
    createSession: controller.createSession,
    switchSession: controller.switchSession,
    deleteSession: controller.deleteSession,
    invalidateDeletedSessions: controller.invalidateDeletedSessions,
    loadEarlierMessages: controller.loadEarlierMessages,
    resetConversation: controller.resetConversation,
    retrySessionHydration: controller.retrySessionHydration,
  };
}

function labelsFromCatalog(
  labels: Readonly<{
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
  }>,
): BgsmAgentClientLabels {
  return {
    agentCompacting: labels.agentCompacting,
    agentDone: labels.agentDone,
    agentQueued: labels.agentQueued,
    agentStarting: labels.agentStarting,
    agentStopped: labels.agentStopped,
    agentThinking: labels.agentThinking,
    agentWriting: labels.agentWriting,
    agentReadingData: labels.agentReadingData,
    agentPreparingOrganizationScope: labels.agentPreparingOrganizationScope,
    agentApplyingChanges: labels.agentApplyingChanges,
    attemptResumeStateUnknown: labels.attemptResumeStateUnknown,
    attemptStateLost: labels.attemptStateLost,
    turnFailed: labels.turnFailed,
  };
}
