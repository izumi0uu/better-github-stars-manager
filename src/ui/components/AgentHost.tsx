import { useEffect, useMemo } from 'react';
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

export type AgentHostPresentation = Readonly<{
  status: string | null;
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
  const presentation = useMemo<AgentHostPresentation>(() => {
    const organizeView = selectOrganizeWorkbenchView(
      workbench.state,
      workbench.displayedProcessed,
    );
    const ui = resolveAgentUiPresentation({
      phase: agent.phase,
      hasError: agent.error !== null,
      hasContextRecovery: agent.contextLimitRecovery !== null,
      unsafeReplayBlocked: false,
    }, organizeView);
    return {
      status: resolveToolbarStatus(ui, agent.status?.text ?? null, m.agentPanel),
      active: ui.toolbar.active,
    };
  }, [
    agent.contextLimitRecovery,
    agent.error,
    agent.phase,
    agent.status?.text,
    m.agentPanel,
    workbench.displayedProcessed,
    workbench.state,
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
      scopeCount={scopeCount}
      handoff={handoff}
      onDismissHandoff={onDismissHandoff}
    />
  );
}

function resolveToolbarStatus(
  presentation: AgentUiPresentation,
  chatStatus: string | null,
  labels: MessageCatalog['agentPanel'],
): string | null {
  const { kind, progress, active } = presentation.toolbar;
  switch (kind) {
    case 'chat_queued':
    case 'chat_working':
    case 'chat_compacting':
    case 'chat_tool':
    case 'chat_done':
    case 'chat_stopped':
    case 'chat_failed':
      return active ? chatStatus ?? labels.chatWorking : null;
    case 'scope_requesting':
      return labels.resolvingScopeHeader;
    case 'scope_ready':
      return labels.scopeReady;
    case 'scope_starting':
      return labels.workbench.startingAnalysis;
    case 'scope_failed':
      return null;
    case 'analyzing':
      return progress && progress.total > 0
        ? `${progress.completed}/${progress.total}`
        : labels.runStateLabel('analyzing');
    case 'reconnecting':
      return labels.toolbarInterrupted;
    case 'analysis_blocked':
    case 'review_invalid':
      return labels.runStateLabel('analysis_blocked');
    case 'review_loading':
    case 'review_ready':
      return labels.toolbarReview;
    case 'review_failed':
      return null;
    case 'applying':
      return labels.toolbarApplying;
    case 'paused':
      return labels.runStateLabel('paused');
    case 'receipt':
    case 'completed_no_changes':
      return labels.runStateLabel('completed');
    case 'cancelled':
      return labels.runStateLabel('cancelled');
    case 'interrupted':
      return labels.toolbarInterrupted;
    case 'failed':
      return labels.runStateLabel('failed');
    case 'context_recovery':
    case 'scope_empty':
    case 'idle':
      return null;
  }
}
