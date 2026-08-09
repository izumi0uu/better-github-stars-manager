import type { AgentTurnPhase } from '@/ui/agent-turn-state';
import {
  CONNECTION_INTERRUPTED_COPY,
  PREFLIGHT_INCOMPLETE_COPY,
  WORKER_LOST_COPY,
  canContinueOrganizeJobRun,
  currentWorkbenchRunIdentity,
  currentOrganizeJobState,
  displayedAnalyzedRepositoryCount,
  hasCompleteAnalysisCoverage,
  type AgentWorkbenchState,
  type CurrentOrganizeJobState,
} from '@/ui/agent-workbench-state';

export const ORGANIZE_WORKBENCH_PHASES = [
  'idle',
  'scope_requesting',
  'scope_ready',
  'scope_starting',
  'scope_failed',
  'scope_empty',
  'analyzing',
  'reconnecting',
  'analysis_blocked',
  'review_loading',
  'review_failed',
  'review_ready',
  'review_invalid',
  'applying',
  'paused',
  'receipt',
  'completed_no_changes',
  'cancelled',
  'interrupted',
  'failed',
] as const;

export type OrganizeWorkbenchPhase = typeof ORGANIZE_WORKBENCH_PHASES[number];

export type AgentMascotState =
  | 'idle'
  | 'queued'
  | 'working'
  | 'compacting'
  | 'tool'
  | 'waiting'
  | 'done'
  | 'stopped'
  | 'error';

export type AgentProgress = Readonly<{
  kind: 'analysis' | 'apply';
  completed: number;
  total: number;
  remaining: number;
}>;

export type OrganizeWorkbenchCapabilities = Readonly<{
  canConfirmPreflight: boolean;
  canCancelPreflight: boolean;
  canStop: boolean;
  canPause: boolean;
  canResumeAnalysis: boolean;
  canResumeApply: boolean;
  canReadReview: boolean;
  canEditReview: boolean;
  canApplySelection: boolean;
  canRetryReviewPage: boolean;
  canReadReceipt: boolean;
  canRetryReceiptPage: boolean;
  canRestart: boolean;
  canDiscard: boolean;
  canDismissTerminal: boolean;
  canTakeControl: boolean;
  canCreateSession: boolean;
  canSwitchSession: boolean;
  canDeleteSession: boolean;
  canChat: boolean;
}>;

export type OrganizeWorkbenchError = Readonly<{
  kind:
    | 'connection_interrupted'
    | 'worker_lost'
    | 'preflight_incomplete'
    | 'organize_already_running'
    | 'run_state_refreshed'
    | 'server_failure'
    | 'other';
  message: string;
}>;

export type OrganizeWorkbenchView = Readonly<{
  phase: OrganizeWorkbenchPhase;
  runState: CurrentOrganizeJobState | null;
  runIdentity: Readonly<{ runId: string; generation: number }> | null;
  progress: AgentProgress;
  analysisProgress: AgentProgress;
  applyProgress: AgentProgress | null;
  rawSubphase: CurrentOrganizeJobState | NonNullable<AgentWorkbenchState['preflight']>['status'] | null;
  scopeLabel: string | null;
  coverageComplete: boolean;
  failedCount: number;
  selectedCount: number;
  hasReceipt: boolean;
  receiptCounts: Readonly<{
    changed: number;
    unchanged: number;
    skipped: number;
    failed: number;
  }> | null;
  role: AgentWorkbenchState['role'];
  controlNotice: 'controlled_elsewhere' | 'owner_disconnected' | null;
  takeControlFailure: AgentWorkbenchState['takeControlFailure'];
  active: boolean;
  error: OrganizeWorkbenchError | null;
  capabilities: OrganizeWorkbenchCapabilities;
  revisionKey: string;
}>;

export type AgentChatPresentationInput = Readonly<{
  phase: AgentTurnPhase;
  hasError: boolean;
  hasContextRecovery: boolean;
  unsafeReplayBlocked: boolean;
  revisionKey?: string;
}>;

export type AgentDominantPhase =
  | OrganizeWorkbenchPhase
  | 'chat_queued'
  | 'chat_working'
  | 'chat_compacting'
  | 'chat_tool'
  | 'chat_done'
  | 'chat_stopped'
  | 'chat_failed'
  | 'context_recovery';

export type AgentStopbarAction = 'stop_chat' | 'cancel_preflight' | 'stop_analysis' | 'pause_apply';

export type AgentUiPresentation = Readonly<{
  dominantPhase: AgentDominantPhase;
  active: boolean;
  header: Readonly<{ kind: AgentDominantPhase; progress: AgentProgress | null }>;
  toolbar: Readonly<{ kind: AgentDominantPhase; progress: AgentProgress | null; active: boolean }>;
  mascot: AgentMascotState;
  composer: Readonly<{
    disabled: boolean;
    mode:
      | 'default'
      | 'context_recovery'
      | 'write_retry_blocked'
      | 'scope_pending'
      | 'scope_ready'
      | 'review_follow_up'
      | 'applying'
      | 'receipt';
  }>;
  stopbar: Readonly<{ action: AgentStopbarAction }> | null;
  sessionPolicy: Readonly<{
    canCreateSession: boolean;
    canSwitchSession: boolean;
    canDeleteSession: boolean;
  }>;
  scrollKey: string;
}>;

const RUN_PHASES = {
  frozen: 'analyzing',
  prepared: 'analyzing',
  checking_provider: 'analyzing',
  analyzing: 'analyzing',
  analysis_blocked: 'analysis_blocked',
  review: 'review_loading',
  apply_sealed: 'applying',
  applying: 'applying',
  paused: 'paused',
  completed: 'completed_no_changes',
  budget_exhausted: 'analysis_blocked',
  cancelled: 'cancelled',
  failed: 'failed',
  interrupted: 'interrupted',
} as const satisfies Record<CurrentOrganizeJobState, OrganizeWorkbenchPhase>;

const ACTIVE_PHASES = new Set<OrganizeWorkbenchPhase>([
  'scope_requesting',
  'scope_starting',
  'analyzing',
  'reconnecting',
  'applying',
]);


const ACTIVE_CHAT_PHASES = new Set<AgentTurnPhase>([
  'queued',
  'working',
  'tool',
  'compacting',
  'stopping',
  'settling_error',
]);

const STOPPABLE_CHAT_PHASES = new Set<AgentTurnPhase>([
  'queued',
  'working',
  'tool',
  'compacting',
]);

const ORGANIZE_MASCOT = {
  idle: 'idle',
  scope_requesting: 'queued',
  scope_ready: 'waiting',
  scope_starting: 'queued',
  scope_failed: 'error',
  scope_empty: 'done',
  analyzing: 'working',
  reconnecting: 'queued',
  analysis_blocked: 'waiting',
  review_loading: 'queued',
  review_failed: 'error',
  review_ready: 'waiting',
  review_invalid: 'error',
  applying: 'tool',
  paused: 'waiting',
  receipt: 'done',
  completed_no_changes: 'done',
  cancelled: 'stopped',
  interrupted: 'error',
  failed: 'error',
} as const satisfies Record<OrganizeWorkbenchPhase, AgentMascotState>;

export function selectOrganizeWorkbenchView(
  state: AgentWorkbenchState,
  displayedProcessed = displayedAnalyzedRepositoryCount(state),
): OrganizeWorkbenchView {
  const runState = currentOrganizeJobState(state.snapshot, state.organizeJob);
  const coverageComplete = hasCompleteAnalysisCoverage(state);
  const hasReceipt = state.organizeJob?.status === 'completed' && state.organizeJob.apply !== null;
  const phase = selectOrganizePhase(state, runState, coverageComplete, hasReceipt);
  const analysisTotal = state.organizeJob?.scopeCount
    ?? state.snapshot?.frozenScope.count
    ?? state.preflight?.count
    ?? 0;
  const analysisCompleted = clampProgress(
    Math.max(displayedAnalyzedRepositoryCount(state), displayedProcessed),
    analysisTotal,
  );
  const apply = state.organizeJob?.apply;
  const analysisProgress = createProgress('analysis', analysisCompleted, analysisTotal);
  const applyProgress = apply ? createProgress('apply', apply.settled, apply.total) : null;
  const progress = applyProgress && ['applying', 'paused', 'receipt'].includes(phase)
    ? applyProgress
    : analysisProgress;
  const connected = state.transport === 'connected';
  const commandReady = state.pendingCommand === null;
  const connectedOwner = connected && state.role === 'owner';
  const terminal = state.role === null
    && state.organizeJob !== null
    && ['completed', 'cancelled'].includes(state.organizeJob.status);
  const canResumeAnalysis = connectedOwner
    && commandReady
    && ['analysis_blocked', 'failed'].includes(phase)
    && canContinueOrganizeJobRun(state.snapshot);
  const active = ACTIVE_PHASES.has(phase);
  const capabilities: OrganizeWorkbenchCapabilities = {
    canConfirmPreflight: connectedOwner && commandReady && phase === 'scope_ready',
    canCancelPreflight: connectedOwner && commandReady && [
      'scope_requesting',
      'scope_ready',
      'scope_starting',
      'scope_empty',
    ].includes(phase),
    canStop: connectedOwner && commandReady && phase === 'analyzing',
    canPause: connectedOwner && commandReady && phase === 'applying',
    canResumeAnalysis,
    canResumeApply: connectedOwner && commandReady && phase === 'paused' && apply !== null,
    canReadReview: connected && ['review_loading', 'review_failed', 'review_ready'].includes(phase),
    canEditReview: connectedOwner && commandReady && phase === 'review_ready',
    canApplySelection: connectedOwner && commandReady && phase === 'review_ready',
    canRetryReviewPage: connected && phase === 'review_failed',
    canReadReceipt: connected && phase === 'receipt',
    canRetryReceiptPage: connected && phase === 'receipt' && state.organizeReceiptError !== null,
    canRestart: connectedOwner && commandReady && [
      'analysis_blocked',
      'review_invalid',
      'failed',
      'interrupted',
    ].includes(phase),
    canDiscard: connectedOwner && commandReady && !active && !terminal && phase !== 'reconnecting',
    canDismissTerminal: connected && commandReady && terminal,
    canTakeControl: connected
      && commandReady
      && state.role === 'owner_lost'
      && state.organizeJob !== null
      && !terminal,
    canCreateSession: state.role !== 'owner',
    canSwitchSession: state.role !== 'owner',
    canDeleteSession: state.role !== 'owner',
    canChat: true,
  };
  const identity = currentWorkbenchRunIdentity(state);
  const error = phase === 'reconnecting'
    ? null
    : selectWorkbenchError(state.error, state.organizeFailureReason);
  const failedCount = state.organizeJob?.coverage.analysisFailed
    ?? state.snapshot?.coverage?.analysisFailed
    ?? 0;

  return {
    phase,
    runState,
    runIdentity: identity ? { runId: identity.runId, generation: identity.generation } : null,
    progress,
    analysisProgress,
    applyProgress,
    rawSubphase: state.preflight?.status ?? runState,
    scopeLabel: state.organizeJob?.scopeLabel
      ?? state.snapshot?.frozenScope.label
      ?? state.preflight?.label
      ?? null,
    coverageComplete,
    failedCount,
    selectedCount: state.organizeJob?.selectedRepositories ?? state.selectedProposalRowIds.size,
    hasReceipt,
    receiptCounts: hasReceipt && state.organizeJob?.apply
      ? {
          changed: state.organizeJob.apply.changed,
          unchanged: state.organizeJob.apply.unchanged,
          skipped: state.organizeJob.apply.skipped,
          failed: state.organizeJob.apply.failed,
        }
      : null,
    role: state.role,
    controlNotice: state.role === 'observer'
      ? 'controlled_elsewhere'
      : state.role === 'owner_lost'
        ? 'owner_disconnected'
        : null,
    takeControlFailure: state.takeControlFailure,
    active,
    error,
    capabilities,
    revisionKey: [
      state.role ?? '',
      state.transport,
      state.pendingCommand?.id ?? '',
      state.takeControlFailure ?? '',
      state.organizeFailureReason ?? '',
      phase,
      identity?.runId ?? '',
      identity?.generation ?? '',
      state.organizeJob?.revision ?? '',
      progress.completed,
      progress.total,
      state.organizeReviewRequestId ?? '',
      state.organizeReceiptRequestId ?? '',
      error?.message ?? '',
    ].join(':'),
  };
}

export function resolveAgentUiPresentation(
  chat: AgentChatPresentationInput,
  organize: OrganizeWorkbenchView,
): AgentUiPresentation {
  const dominantPhase = selectDominantPhase(chat, organize);
  const chatDominates = dominantPhase.startsWith('chat_') || dominantPhase === 'context_recovery';
  const chatActive = ACTIVE_CHAT_PHASES.has(chat.phase);
  const active = chatActive || (!chatDominates && organize.active);
  const progress = chatDominates ? null : organize.progress;
  const mascot = chatActive
    ? chatMascot(chat.phase)
    : dominantPhase === 'context_recovery'
      ? 'waiting'
      : dominantPhase === 'chat_failed'
        ? 'error'
        : dominantPhase === 'chat_stopped'
          ? 'stopped'
          : dominantPhase === 'chat_done'
            ? 'done'
            : ORGANIZE_MASCOT[organize.phase];
  const composerDisabled = chatActive || chat.hasContextRecovery;

  return {
    dominantPhase,
    active,
    header: { kind: dominantPhase, progress },
    toolbar: { kind: dominantPhase, progress, active },
    mascot,
    composer: {
      disabled: composerDisabled,
      mode: selectComposerMode(chat, organize),
    },
    stopbar: selectStopbar(chat, organize),
    sessionPolicy: {
      canCreateSession: !chatActive && organize.capabilities.canCreateSession,
      canSwitchSession: !chatActive && organize.capabilities.canSwitchSession,
      canDeleteSession: !chatActive && organize.capabilities.canDeleteSession,
    },
    scrollKey: `${dominantPhase}:${organize.revisionKey}:${chat.revisionKey ?? ''}`,
  };
}

function selectOrganizePhase(
  state: AgentWorkbenchState,
  runState: CurrentOrganizeJobState | null,
  coverageComplete: boolean,
  hasReceipt: boolean,
): OrganizeWorkbenchPhase {
  if (state.transport === 'disconnected' && state.role === 'owner') return 'reconnecting';
  if (state.preflight?.status === 'requesting') return 'scope_requesting';
  if (state.preflight?.status === 'ready') return 'scope_ready';
  if (state.preflight?.status === 'starting') return 'scope_starting';
  if (state.preflight?.status === 'no_work') return 'scope_empty';
  if (state.continuationPending) return 'analyzing';
  if (runState === 'review') {
    if (!coverageComplete) return 'review_invalid';
    if (state.organizeReviewError) return 'review_failed';
    if (state.organizeReviewRequestId !== null || !state.proposal) return 'review_loading';
    return 'review_ready';
  }
  if (runState === 'completed') return hasReceipt ? 'receipt' : 'completed_no_changes';
  if (runState) return RUN_PHASES[runState];
  return state.error ? 'scope_failed' : 'idle';
}


function selectWorkbenchError(
  message: string | null,
  reason: AgentWorkbenchState['organizeFailureReason'],
): OrganizeWorkbenchError | null {
  if (reason === 'already_started') {
    return { kind: 'organize_already_running', message: message ?? reason };
  }
  if (reason === 'stale_generation' || reason === 'revision_conflict') {
    return { kind: 'run_state_refreshed', message: message ?? reason };
  }
  if (reason === 'preflight_invalid' || reason === 'preflight_stale' || reason === 'preflight_replayed') {
    return { kind: 'preflight_incomplete', message: message ?? reason };
  }
  if (reason !== null) return { kind: 'server_failure', message: message ?? reason };
  if (!message) return null;
  if (message === CONNECTION_INTERRUPTED_COPY) return { kind: 'connection_interrupted', message };
  if (message === WORKER_LOST_COPY) return { kind: 'worker_lost', message };
  if (message === PREFLIGHT_INCOMPLETE_COPY) return { kind: 'preflight_incomplete', message };
  return { kind: 'other', message };
}

function selectDominantPhase(
  chat: AgentChatPresentationInput,
  organize: OrganizeWorkbenchView,
): AgentDominantPhase {
  if (ACTIVE_CHAT_PHASES.has(chat.phase)) return chatDominantPhase(chat.phase);
  if (chat.hasContextRecovery) return 'context_recovery';
  if (organize.phase !== 'idle') return organize.phase;
  if (chat.hasError || chat.phase === 'failed') return 'chat_failed';
  if (chat.phase === 'stopped') return 'chat_stopped';
  if (chat.phase === 'done') return 'chat_done';
  return 'idle';
}

function chatDominantPhase(phase: AgentTurnPhase): AgentDominantPhase {
  switch (phase) {
    case 'queued':
      return 'chat_queued';
    case 'working':
      return 'chat_working';
    case 'tool':
      return 'chat_tool';
    case 'compacting':
      return 'chat_compacting';
    case 'stopping':
    case 'stopped':
      return 'chat_stopped';
    case 'settling_error':
    case 'failed':
      return 'chat_failed';
    case 'done':
      return 'chat_done';
    case 'context_recovery':
      return 'context_recovery';
    case 'idle':
      return 'idle';
  }
}

function chatMascot(phase: AgentTurnPhase): AgentMascotState {
  switch (phase) {
    case 'queued':
      return 'queued';
    case 'working':
      return 'working';
    case 'tool':
      return 'tool';
    case 'compacting':
      return 'compacting';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'settling_error':
    case 'failed':
      return 'error';
    case 'done':
      return 'done';
    case 'context_recovery':
      return 'waiting';
    case 'idle':
      return 'idle';
  }
}

function selectComposerMode(
  chat: AgentChatPresentationInput,
  organize: OrganizeWorkbenchView,
): AgentUiPresentation['composer']['mode'] {
  if (chat.hasContextRecovery) return 'context_recovery';
  if (chat.unsafeReplayBlocked) return 'write_retry_blocked';
  if (organize.phase === 'applying') return 'applying';
  if (organize.phase === 'scope_requesting' || organize.phase === 'scope_starting') {
    return 'scope_pending';
  }
  if (organize.phase === 'scope_ready') return 'scope_ready';
  if (organize.phase === 'review_ready') return 'review_follow_up';
  if (organize.phase === 'receipt') return 'receipt';
  return 'default';
}

function selectStopbar(
  chat: AgentChatPresentationInput,
  organize: OrganizeWorkbenchView,
): AgentUiPresentation['stopbar'] {
  if (STOPPABLE_CHAT_PHASES.has(chat.phase)) {
    return { action: 'stop_chat' };
  }
  if (
    organize.capabilities.canCancelPreflight
    && (organize.phase === 'scope_requesting' || organize.phase === 'scope_starting')
  ) return { action: 'cancel_preflight' };
  if (organize.capabilities.canPause) return { action: 'pause_apply' };
  if (organize.capabilities.canStop) return { action: 'stop_analysis' };
  return null;
}

function createProgress(kind: AgentProgress['kind'], completed: number, total: number): AgentProgress {
  const normalizedTotal = Math.max(0, total);
  const normalizedCompleted = clampProgress(completed, normalizedTotal);
  return {
    kind,
    completed: normalizedCompleted,
    total: normalizedTotal,
    remaining: Math.max(0, normalizedTotal - normalizedCompleted),
  };
}

function clampProgress(value: number, total: number): number {
  return Math.min(Math.max(0, total), Math.max(0, value));
}
