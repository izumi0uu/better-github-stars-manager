import { useEffect, useMemo, useRef } from 'react';
import { canonicalJson } from '@/agent-harness/canonical-json';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import type { LaunchCandidateContract } from '@/bgsm-agent/scope';
import { useI18n } from '@/i18n';
import { AgentPanel } from '@/ui/components/AgentPanel';
import { useBgsmAgent } from '@/ui/hooks/use-bgsm-agent';
import { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';
import {
  resolveAgentUiPresentation,
  selectOrganizeWorkbenchView,
  type AgentUiPresentation,
} from '@/ui/agent-ui-presentation';
import type { MessageCatalog } from '@/i18n';

export type AgentToolbarStatusKind =
  | 'working'
  | 'analyzing'
  | 'blocked'
  | 'review'
  | 'applying'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export type AgentHostPresentation = Readonly<{
  status: string | null;
  statusKind: AgentToolbarStatusKind | null;
  active: boolean;
}>;

export function AgentHost({
  open,
  onHide,
  onOpenOptions,
  onDataChanged,
  onPresentationChange,
  defaultCandidate,
  chatCandidate,
  scopeCount,
  handoff,
  onDismissHandoff,
}: {
  open: boolean;
  onHide: () => void;
  onOpenOptions?: () => void;
  onDataChanged?: () => void;
  onPresentationChange: (presentation: AgentHostPresentation) => void;
  defaultCandidate: LaunchCandidateContract;
  chatCandidate: BgsmAgentConversationCandidate;
  scopeCount?: number;
  handoff?: { remainingUntagged: number; autoTagged: number } | null;
  onDismissHandoff?: () => void;
}) {
  const { m } = useI18n();
  const agent = useBgsmAgent(onDataChanged, chatCandidate);
  const workbench = useBgsmAgentWorkbench(onDataChanged, agent.sessionId, agent.sessionReady);
  useEffect(() => {
    if (workbench.state.deletedSessionIds.size > 0) {
      agent.invalidateDeletedSessions(workbench.state.deletedSessionIds);
    }
  }, [agent.invalidateDeletedSessions, workbench.state.deletedSessionIds]);
  const organizeView = useMemo(() => selectOrganizeWorkbenchView(
    workbench.state,
    workbench.displayedProcessed,
  ), [workbench.displayedProcessed, workbench.state]);
  const uiPresentation = useMemo(() => {
    return resolveAgentUiPresentation({
      phase: agent.phase,
      hasError: agent.error !== null,
      hasContextRecovery: agent.contextLimitRecovery !== null,
      unsafeReplayBlocked: false,
    }, organizeView);
  }, [
    agent.contextLimitRecovery,
    agent.error,
    agent.phase,
    organizeView,
  ]);
  const presentation = useMemo<AgentHostPresentation>(() => {
    const toolbar = resolveToolbarStatus(uiPresentation, agent.status?.text ?? null, m.agentPanel);
    return {
      status: toolbar.text,
      statusKind: toolbar.kind,
      active: uiPresentation.toolbar.active,
    };
  }, [
    agent.status?.text,
    m.agentPanel,
    uiPresentation,
  ]);
  const candidateContextKey = useMemo(
    () => conversationCandidateContextKey(chatCandidate),
    [chatCandidate],
  );
  const previousCandidateContextKeyRef = useRef(candidateContextKey);
  const pendingCandidateContextKeyRef = useRef<string | null>(candidateContextKey);
  const pendingContextKey = candidateContextKey !== previousCandidateContextKeyRef.current
    ? candidateContextKey
    : pendingCandidateContextKeyRef.current;
  const boundContextKey = useMemo(() => agent.conversationBinding
    ? conversationCandidateContextKey(agent.conversationBinding.candidateContract)
    : null, [agent.conversationBinding]);
  // Organize ownership implies !canSwitchSession; while a candidate is blocked,
  // the effect cannot consume its pending switch before ownership releases and rerenders.
  const blockedConversationCandidate = agent.conversationBinding
    && !organizeView.capabilities.canSwitchSession
    && pendingContextKey !== null
    && pendingContextKey !== boundContextKey
    ? chatCandidate
    : null;

  useEffect(() => {
    if (candidateContextKey !== previousCandidateContextKeyRef.current) {
      previousCandidateContextKeyRef.current = candidateContextKey;
      pendingCandidateContextKeyRef.current = candidateContextKey;
    }

    const queuedCandidateContextKey = pendingCandidateContextKeyRef.current;
    if (!queuedCandidateContextKey) return;
    if (!agent.conversationBinding) {
      if (agent.sessionReady && uiPresentation.sessionPolicy.canSwitchSession) {
        pendingCandidateContextKeyRef.current = null;
      }
      return;
    }
    if (conversationCandidateContextKey(agent.conversationBinding.candidateContract)
      === queuedCandidateContextKey) {
      pendingCandidateContextKeyRef.current = null;
      return;
    }
    if (!uiPresentation.sessionPolicy.canSwitchSession) return;
    void agent.createSession().then((createdSessionId) => {
      if (
        createdSessionId !== null
        && pendingCandidateContextKeyRef.current === queuedCandidateContextKey
      ) pendingCandidateContextKeyRef.current = null;
    });
  }, [
    agent.activeSessionId,
    agent.conversationBinding,
    agent.createSession,
    agent.sessionReady,
    candidateContextKey,
    uiPresentation.sessionPolicy.canSwitchSession,
  ]);

  useEffect(() => {
    onPresentationChange(presentation);
  }, [onPresentationChange, presentation]);

  return (
    <AgentPanel
      open={open}
      onHide={onHide}
      onOpenOptions={onOpenOptions}
      agent={agent}
      workbench={workbench}
      defaultCandidate={defaultCandidate}
      blockedConversationCandidate={blockedConversationCandidate}
      scopeCount={scopeCount}
      handoff={handoff}
      onDismissHandoff={onDismissHandoff}
    />
  );
}

function conversationCandidateContextKey(candidate: BgsmAgentConversationCandidate): string {
  return canonicalJson(candidate);
}

function resolveToolbarStatus(
  presentation: AgentUiPresentation,
  chatStatus: string | null,
  labels: MessageCatalog['agentPanel'],
): { text: string | null; kind: AgentToolbarStatusKind | null } {
  const { kind, progress, active } = presentation.toolbar;
  const text = (value: string | null, statusKind: AgentToolbarStatusKind | null) => (
    { text: value, kind: statusKind }
  );
  switch (kind) {
    case 'chat_queued':
    case 'chat_working':
    case 'chat_compacting':
    case 'chat_tool':
    case 'chat_done':
    case 'chat_stopped':
    case 'chat_failed':
      return active ? text(chatStatus ?? labels.chatWorking, 'working') : text(null, null);
    case 'scope_requesting':
      return text(labels.resolvingScopeHeader, null);
    case 'scope_ready':
      return text(labels.scopeReady, null);
    case 'scope_starting':
      return text(labels.workbench.startingAnalysis, 'analyzing');
    case 'scope_failed':
      return text(null, null);
    case 'analyzing':
      return text(
        progress && progress.total > 0
          ? `${progress.completed}/${progress.total}`
          : labels.runStateLabel('analyzing'),
        'analyzing',
      );
    case 'reconnecting':
      return text(labels.toolbarInterrupted, 'interrupted');
    case 'analysis_blocked':
    case 'review_invalid':
      return text(labels.runStateLabel('analysis_blocked'), 'blocked');
    case 'review_loading':
    case 'review_ready':
      return text(labels.toolbarReview, 'review');
    case 'review_failed':
      return text(null, null);
    case 'applying':
      return text(labels.toolbarApplying, 'applying');
    case 'paused':
      return text(labels.runStateLabel('paused'), 'paused');
    case 'receipt':
    case 'completed_no_changes':
      return text(labels.runStateLabel('completed'), 'completed');
    case 'cancelled':
      return text(labels.runStateLabel('cancelled'), 'cancelled');
    case 'interrupted':
      return text(labels.toolbarInterrupted, 'interrupted');
    case 'failed':
      return text(labels.runStateLabel('failed'), 'failed');
    case 'context_recovery':
    case 'scope_empty':
    case 'idle':
      return text(null, null);
  }
}
