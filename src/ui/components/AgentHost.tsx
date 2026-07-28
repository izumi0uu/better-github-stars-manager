import { useEffect, useMemo } from 'react';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import type { LaunchCandidateContract } from '@/bgsm-agent/scope';
import { useI18n } from '@/i18n';
import { AgentPanel } from '@/ui/components/AgentPanel';
import { useBgsmAgent } from '@/ui/hooks/use-bgsm-agent';
import { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';

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
  const workbench = useBgsmAgentWorkbench(onDataChanged, agent.sessionId);
  const presentation = useMemo<AgentHostPresentation>(() => {
    const snapshot = workbench.state.snapshot;
    const organizeJob = workbench.state.organizeJob;
    const runState = snapshot?.state;
    const processed = organizeJob?.coverage.analyzed ?? workbench.displayedProcessed;
    const total = organizeJob?.scopeCount ?? snapshot?.frozenScope.count ?? 0;
    const automaticContinuation = workbench.state.continuationPending;
    const analyzing = organizeJob?.status === 'analyzing' || (!!snapshot && (
      ['frozen', 'prepared', 'checking_provider', 'analyzing'].includes(snapshot.state)
      || automaticContinuation
    ));
    const applying = organizeJob?.status === 'apply_sealed'
      || organizeJob?.status === 'applying';
    const status = analyzing && total > 0
      ? `${processed}/${total}`
      : applying
        ? m.agentPanel.toolbarApplying
        : organizeJob?.status === 'paused'
          ? m.agentPanel.runStateLabel('paused')
        : organizeJob?.status === 'completed'
          ? m.agentPanel.runStateLabel('completed')
          : organizeJob?.status === 'review'
          ? m.agentPanel.toolbarReview
          : runState
              ? m.agentPanel.runStateLabel(runState)
              : workbench.state.preflight?.status === 'requesting'
                ? m.agentPanel.resolvingScopeHeader
                : workbench.state.preflight?.status === 'ready'
                  ? m.agentPanel.scopeReady
                  : agent.running
                    ? agent.status?.text ?? m.agentPanel.chatWorking
                    : null;
    const active = agent.running
      || workbench.state.preflight?.status === 'requesting'
      || workbench.state.preflight?.status === 'ready'
      || !!(organizeJob && ['analyzing', 'review', 'apply_sealed', 'applying', 'paused'].includes(organizeJob.status))
      || (!!runState && ![
        'analysis_blocked',
        'completed',
        'budget_exhausted',
        'cancelled',
        'failed',
        'interrupted',
      ].includes(runState));
    return { status, active };
  }, [agent.running, agent.status?.text, m.agentPanel, workbench.displayedProcessed, workbench.state]);

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
