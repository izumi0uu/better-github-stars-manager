import type {
  OrganizeJobRunEvent,
  OrganizeJobRunSnapshot,
  OrganizeJobRunState,
} from '@/bgsm-agent/events';
import type { ProposalReviewProjection } from '@/bgsm-agent/proposal';
import { isMonotonicRunBudgetUsage } from '@/bgsm-agent/policy';
import type { PreflightToken } from '@/bgsm-agent/scope';
import type { RunId } from '@/bgsm-agent/identity';
import type {
  BgsmOrganizeControlRole,
  BgsmOrganizeJobPresentation,
  BgsmOrganizeJobPreflightResult,
  BgsmOrganizeJobErrorReason,
  BgsmOrganizeJobServerMessage,
} from '@/utils/messaging';

export const CONNECTION_INTERRUPTED_COPY = 'BGSM_AGENT_CONNECTION_INTERRUPTED';
export const WORKER_LOST_COPY = 'BGSM_AGENT_WORKER_LOST';
export const PREFLIGHT_INCOMPLETE_COPY = 'BGSM_AGENT_PREFLIGHT_INCOMPLETE';
export const REVIEW_REQUEST_FAILED_COPY = 'BGSM_AGENT_REVIEW_REQUEST_FAILED';
export const RECEIPT_REQUEST_FAILED_COPY = 'BGSM_AGENT_RECEIPT_REQUEST_FAILED';

export type WorkbenchPreflight = Readonly<{
  requestId: string;
  status: 'requesting' | 'ready' | 'starting' | 'no_work';
  taskInstruction: string;
  label: string;
  count: number;
  preflightToken: PreflightToken | null;
}>;

export type WorkbenchProposalSummary = Readonly<{
  proposalId: string;
  actionableCount: number;
  nonActionableCount: number;
  review: ProposalReviewProjection;
}>;

export type WorkbenchOrganizeReviewPage = Extract<
  BgsmOrganizeJobServerMessage,
  { type: 'bgsmOrganizeReviewPage' }
>;

export type WorkbenchOrganizeReceiptPage = Extract<
  BgsmOrganizeJobServerMessage,
  { type: 'bgsmOrganizeReceiptPage' }
>;

export type WorkbenchTimelineItem = Readonly<{
  id: string;
  state: OrganizeJobRunState | 'preflight';
  label: string;
}>;

export type WorkbenchUsageOffset = Readonly<{
  consumedFrozenPositions: number;
  analyzerBatches: number;
  providerAttempts: number;
}>;

export type WorkbenchConversationAnchor = Readonly<{
  messageId: string | null;
  createdAt: number;
}>;

export type WorkbenchPendingCommand = Readonly<{
  id: string;
  kind: 'stop_analysis' | 'pause_apply' | 'apply_selection' | 'resume_apply' | 'take_control';
  runId: RunId;
  generation: number;
  jobId: string | null;
  baselineRevision: number | null;
}>;

export type WorkbenchTakeControlFailure =
  | 'owner_connected'
  | 'revision_conflict'
  | 'job_unavailable'
  | 'other';

export type AgentWorkbenchState = Readonly<{
  controllerId: string;
  sessionId: string;
  role: BgsmOrganizeControlRole | null;
  preflight: WorkbenchPreflight | null;
  snapshot: OrganizeJobRunSnapshot | null;
  proposal: WorkbenchProposalSummary | null;
  selectedProposalRowIds: ReadonlySet<string>;
  organizeJob: BgsmOrganizeJobPresentation | null;
  organizeReviewPage: WorkbenchOrganizeReviewPage | null;
  organizeReceiptPage: WorkbenchOrganizeReceiptPage | null;
  organizeReviewRequestId: string | null;
  organizeReviewError: string | null;
  organizeReceiptRequestId: string | null;
  organizeReceiptError: string | null;
  usageOffset: WorkbenchUsageOffset;
  continuationPending: boolean;
  pendingCommand: WorkbenchPendingCommand | null;
  takeControlFailure: WorkbenchTakeControlFailure | null;
  organizeFailureReason: BgsmOrganizeJobErrorReason | null;
  deletedSessionIds: ReadonlySet<string>;
  /** A failed-suffix retry rewinds repository progress, unlike a budget continuation. */
  retryingFailedSuffix: boolean;
  conversationAnchor: WorkbenchConversationAnchor | null;
  analysisProgress: Readonly<{
    runId: RunId;
    generation: number;
    processed: number;
    total: number;
  }> | null;
  transport: 'connected' | 'disconnected';
  error: string | null;
  timeline: readonly WorkbenchTimelineItem[];
  seenEventIds: ReadonlySet<string>;
}>;

export type AgentWorkbenchAction =
  | Readonly<{
      type: 'preflight_requested';
      requestId: string;
      taskInstruction: string;
      conversationAnchor: WorkbenchConversationAnchor;
    }>
  | Readonly<{
      type: 'whole_library_restart_requested';
      requestId: string;
      taskInstruction: string;
      conversationAnchor: WorkbenchConversationAnchor;
    }>
  | Readonly<{ type: 'preflight_start_requested' }>
  | Readonly<{ type: 'preflight_start_failed'; message: string }>
  | Readonly<{ type: 'preflight_cancelled' }>
  | Readonly<{ type: 'continue_requested' }>
  | Readonly<{ type: 'continue_send_failed' }>
  | Readonly<{ type: 'organize_command_requested'; command: WorkbenchPendingCommand }>
  | Readonly<{ type: 'organize_command_send_failed'; commandId: string }>
  | Readonly<{ type: 'organize_review_page_requested'; requestId: string }>
  | Readonly<{ type: 'organize_review_request_failed'; requestId: string }>
  | Readonly<{ type: 'organize_receipt_page_requested'; requestId: string }>
  | Readonly<{ type: 'organize_receipt_request_failed'; requestId: string }>
  | Readonly<{
      type: 'server_message';
      message: BgsmOrganizeJobServerMessage;
      authoritative?: boolean;
    }>
  | Readonly<{ type: 'transport_disconnected' }>
  | Readonly<{ type: 'session_rebound'; controllerId: string; sessionId: string }>
  | Readonly<{ type: 'clear_terminal' }>;

export type CurrentOrganizeJobState = OrganizeJobRunState | BgsmOrganizeJobPresentation['status'];

export function isDurableOrganizeJobAuthoritative(
  snapshot: Pick<OrganizeJobRunSnapshot, 'runId' | 'generation'> | null,
  presentation: Pick<BgsmOrganizeJobPresentation, 'runId' | 'generation' | 'status'> | null,
): boolean {
  if (!presentation) return false;
  if (!snapshot) return true;
  if (presentation.generation !== snapshot.generation) {
    return presentation.generation > snapshot.generation;
  }
  if (presentation.runId !== snapshot.runId) return false;

  // Runtime snapshots carry finer-grained analysis failures while the durable job
  // remains in its broad analyzing phase. Later durable phases are authoritative.
  return presentation.status !== 'analyzing';
}

export function currentOrganizeJobState(
  snapshot: Pick<OrganizeJobRunSnapshot, 'runId' | 'generation' | 'state'> | null,
  presentation: Pick<BgsmOrganizeJobPresentation, 'runId' | 'generation' | 'status'> | null,
): CurrentOrganizeJobState | null {
  if (isDurableOrganizeJobAuthoritative(snapshot, presentation)) {
    return presentation!.status;
  }
  return snapshot?.state ?? presentation?.status ?? null;
}

export function createAgentWorkbenchState(
  controllerId: string,
  sessionId: string,
): AgentWorkbenchState {
  return {
    controllerId,
    sessionId,
    role: null,
    preflight: null,
    snapshot: null,
    proposal: null,
    selectedProposalRowIds: new Set(),
    organizeJob: null,
    organizeReviewPage: null,
    organizeReceiptPage: null,
    organizeReviewRequestId: null,
    organizeReviewError: null,
    organizeReceiptRequestId: null,
    organizeReceiptError: null,
    usageOffset: emptyUsageOffset(),
    continuationPending: false,
    pendingCommand: null,
    takeControlFailure: null,
    organizeFailureReason: null,
    deletedSessionIds: new Set(),
    retryingFailedSuffix: false,
    conversationAnchor: null,
    analysisProgress: null,
    transport: 'connected',
    error: null,
    timeline: [],
    seenEventIds: new Set(),
  };
}

export function reduceAgentWorkbench(
  state: AgentWorkbenchState,
  action: AgentWorkbenchAction,
): AgentWorkbenchState {
  if (action.type === 'session_rebound') {
    return { ...state, controllerId: action.controllerId, sessionId: action.sessionId };
  }
  if (action.type === 'whole_library_restart_requested') {
    return {
      ...createAgentWorkbenchState(state.controllerId, state.sessionId),
      transport: state.transport,
      role: 'owner',
      conversationAnchor: action.conversationAnchor,
      preflight: {
        requestId: action.requestId,
        status: 'requesting',
        taskInstruction: action.taskInstruction,
        label: '',
        count: 0,
        preflightToken: null,
      },
    };
  }
  if (action.type === 'preflight_requested') {
    const reset = createAgentWorkbenchState(state.controllerId, state.sessionId);
    return {
      ...reset,
      transport: state.transport,
      role: 'owner',
      conversationAnchor: action.conversationAnchor,
      preflight: {
        requestId: action.requestId,
        status: 'requesting',
        taskInstruction: action.taskInstruction,
        label: '',
        count: 0,
        preflightToken: null,
      },
      error: null,
    };
  }
  if (action.type === 'preflight_start_requested') {
    if (state.preflight?.status !== 'ready') return state;
    return {
      ...state,
      preflight: { ...state.preflight, status: 'starting' },
      error: null,
    };
  }
  if (action.type === 'preflight_start_failed') {
    return {
      ...state,
      preflight: null,
      conversationAnchor: null,
      role: state.organizeJob ? state.role : null,
      error: action.message,
    };
  }
  if (action.type === 'preflight_cancelled') {
    return {
      ...state,
      preflight: null,
      conversationAnchor: null,
      role: state.organizeJob ? state.role : null,
      timeline: [],
    };
  }
  if (action.type === 'continue_requested') {
    if (!state.snapshot || state.continuationPending) return state;
    const retryingFailedSuffix = state.snapshot.state === 'analysis_blocked'
      || state.organizeJob?.status === 'analysis_blocked';
    return {
      ...state,
      continuationPending: true,
      retryingFailedSuffix: state.retryingFailedSuffix || retryingFailedSuffix,
      analysisProgress: retryingFailedSuffix ? null : state.analysisProgress,
      error: null,
    };
  }
  if (action.type === 'continue_send_failed') {
    if (!state.continuationPending) return state;
    return {
      ...state,
      continuationPending: false,
      retryingFailedSuffix: false,
      error: CONNECTION_INTERRUPTED_COPY,
    };
  }
  if (action.type === 'organize_command_requested') {
    if (state.pendingCommand) return state;
    return {
      ...state,
      pendingCommand: action.command,
      takeControlFailure: null,
      organizeFailureReason: null,
      error: null,
    };
  }
  if (action.type === 'organize_command_send_failed') {
    if (state.pendingCommand?.id !== action.commandId) return state;
    const takeControlFailed = state.pendingCommand.kind === 'take_control';
    return {
      ...state,
      pendingCommand: null,
      takeControlFailure: takeControlFailed ? 'other' : state.takeControlFailure,
      error: takeControlFailed ? null : CONNECTION_INTERRUPTED_COPY,
    };
  }
  if (action.type === 'organize_review_page_requested') {
    return {
      ...state,
      organizeReviewRequestId: action.requestId,
      organizeReviewError: null,
    };
  }
  if (action.type === 'organize_review_request_failed') {
    if (state.organizeReviewRequestId !== action.requestId) return state;
    return {
      ...state,
      organizeReviewRequestId: null,
      organizeReviewError: REVIEW_REQUEST_FAILED_COPY,
    };
  }
  if (action.type === 'organize_receipt_page_requested') {
    return {
      ...state,
      organizeReceiptRequestId: action.requestId,
      organizeReceiptError: null,
    };
  }
  if (action.type === 'organize_receipt_request_failed') {
    if (state.organizeReceiptRequestId !== action.requestId) return state;
    return {
      ...state,
      organizeReceiptRequestId: null,
      organizeReceiptError: RECEIPT_REQUEST_FAILED_COPY,
    };
  }
  if (action.type === 'clear_terminal') {
    return createAgentWorkbenchState(state.controllerId, state.sessionId);
  }
  if (action.type === 'transport_disconnected') {
    return {
      ...state,
      transport: 'disconnected',
      error: null,
      continuationPending: false,
      pendingCommand: null,
      takeControlFailure: null,
      organizeFailureReason: null,
      organizeReviewRequestId: null,
      organizeReceiptRequestId: null,
      timeline: appendTimeline(state.timeline, {
        id: 'transport-disconnected',
        state: state.snapshot?.state ?? 'interrupted',
        label: 'Cubby connection interrupted',
      }),
    };
  }

  const message = action.message;
  if (!matchesController(state, message)) return state;
  if (message.type === 'bgsmOrganizeJobRunConnectionReady') return state;
  if (message.type === 'bgsmAgentSessionDeleted') {
    if (state.deletedSessionIds.has(message.deletedSessionId)) return state;
    const deletedSessionIds = new Set(state.deletedSessionIds);
    deletedSessionIds.add(message.deletedSessionId);
    return { ...state, deletedSessionIds };
  }
  if (message.type === 'bgsmOrganizeJobState' && message.presentation === null) {
    const reset = createAgentWorkbenchState(state.controllerId, state.sessionId);
    return {
      ...reset,
      deletedSessionIds: state.deletedSessionIds,
      preflight: state.preflight,
      role: state.preflight ? state.role : null,
      conversationAnchor: state.preflight ? state.conversationAnchor : null,
      transport: 'connected',
    };
  }
  if (message.type === 'bgsmOrganizeJobRunPreflightResult') {
    return reducePreflight(state, message);
  }
  if (message.type === 'bgsmOrganizeJobRunError') {
    if (
      message.requestId
      && message.requestId === state.organizeReviewRequestId
      && state.organizeJob?.status === 'review'
    ) {
      return {
        ...state,
        organizeReviewRequestId: null,
        organizeReviewError: REVIEW_REQUEST_FAILED_COPY,
      };
    }
    if (
      message.requestId
      && message.requestId === state.organizeReceiptRequestId
      && state.organizeJob?.status === 'completed'
      && state.organizeJob.apply
    ) {
      return {
        ...state,
        organizeReceiptRequestId: null,
        organizeReceiptError: RECEIPT_REQUEST_FAILED_COPY,
      };
    }
    if (
      message.runId === null
      && message.generation === null
      && (
        message.requestId
          ? state.preflight?.requestId !== message.requestId
          : state.preflight?.status !== 'starting'
      )
    ) return state;
    if (!matchesActiveRun(state, message.runId, message.generation)) return state;
    const matchesPendingCommand = !!message.requestId
      && message.requestId === state.pendingCommand?.id;
    const takeControlFailed = matchesPendingCommand && state.pendingCommand?.kind === 'take_control';
    const takeControlFailure = takeControlFailed
      ? message.reason === 'owner_connected'
        || message.reason === 'revision_conflict'
        || message.reason === 'job_unavailable'
        ? message.reason
        : 'other'
      : state.takeControlFailure;
    if (message.requestId && message.runId !== null && !matchesPendingCommand) return state;
    if (
      message.reason === 'internal_error'
      && state.organizeJob?.status === 'analyzing'
      && state.continuationPending
      && state.snapshot?.state === 'budget_exhausted'
    ) return state;
    return {
      ...state,
      preflight: message.runId === null ? null : state.preflight,
      conversationAnchor: message.runId === null ? null : state.conversationAnchor,
      continuationPending: false,
      pendingCommand: matchesPendingCommand ? null : state.pendingCommand,
      takeControlFailure,
      organizeFailureReason: takeControlFailed
        ? state.organizeFailureReason
        : message.reason,
      error: takeControlFailed ? null : message.message,
    };
  }
  if (message.type === 'bgsmOrganizeJobRunDisconnected') {
    if (state.transport === 'disconnected' && action.authoritative !== true) return state;
    if (!matchesActiveRun(state, message.runId, message.generation)) return state;
    const reset = createAgentWorkbenchState(state.controllerId, state.sessionId);
    const interruptedSnapshot = state.snapshot
      && state.snapshot.runId === message.runId
      && state.snapshot.generation === message.generation
      ? { ...state.snapshot, state: 'interrupted' as const, terminalReason: 'worker_lost' as const }
      : null;
    return {
      ...reset,
      transport: 'connected',
      error: WORKER_LOST_COPY,
      snapshot: interruptedSnapshot,
      conversationAnchor: state.conversationAnchor,
      timeline: appendTimeline(state.timeline, {
        id: `worker-lost:${message.runId ?? 'none'}:${message.generation ?? 'none'}`,
        state: 'interrupted',
        label: 'Run interrupted because the extension worker restarted',
      }),
    };
  }
  if (message.type === 'bgsmOrganizeJobAnalysisProgress') {
    const snapshot = state.snapshot;
    if (
      !snapshot
      || snapshot.state !== 'analyzing'
      || snapshot.runId !== message.runId
      || snapshot.generation !== message.generation
      || snapshot.frozenScope.count !== message.total
    ) return state;
    const durable = analyzedRepositoryCount(state);
    const processed = Math.min(message.total, Math.max(durable, message.processed));
    const current = state.analysisProgress;
    if (
      current
      && current.runId === message.runId
      && current.generation === message.generation
      && current.total === message.total
      && current.processed >= processed
    ) return state;
    if (!current && processed <= durable) return state;
    return {
      ...state,
      analysisProgress: {
        runId: message.runId,
        generation: message.generation,
        processed,
        total: message.total,
      },
    };
  }
  if (message.type === 'bgsmOrganizeJobRunSnapshot' || message.type === 'bgsmOrganizeJobRunResult') {
    return reduceSnapshot(state, message.snapshot, action.authoritative === true);
  }
  if (message.type === 'bgsmOrganizeJobState') {
    const presentation = message.presentation;
    if (presentation === null) return state;
    const currentJob = state.organizeJob;
    const changedJob = currentJob?.jobId !== presentation.jobId;
    const sameJob = !!currentJob && !changedJob;
    if (sameJob && presentation.revision < currentJob.revision) {
      return state;
    }
    if (sameJob && presentation.generation < currentJob.generation) return state;
    const snapshotMismatch = !!state.snapshot && (
      state.snapshot.runId !== presentation.runId
      || state.snapshot.generation !== presentation.generation
    );
    if (snapshotMismatch) {
      if (!sameJob) return state;
      if (presentation.generation <= state.snapshot!.generation) return state;
    }
    const leftReview = presentation.status !== 'review';
    const changedReviewRevision = sameJob
      && presentation.status === 'review'
      && presentation.revision !== currentJob.revision;
    const leftReceipt = presentation.status !== 'completed';
    const continuationPending = presentation.status === 'analyzing'
      ? state.continuationPending || snapshotMismatch
      : false;
    const retryingFailedSuffix = ['review', 'completed', 'cancelled'].includes(presentation.status)
      ? false
      : state.retryingFailedSuffix || (
        presentation.status === 'analyzing'
        && snapshotMismatch
        && state.snapshot?.state === 'analysis_blocked'
      );
    const progressMatchesPresentation = state.analysisProgress?.runId === presentation.runId
      && state.analysisProgress.generation === presentation.generation;
    return {
      ...state,
      role: message.role,
      takeControlFailure: null,
      organizeFailureReason: null,
      organizeJob: presentation,
      organizeReviewPage: changedJob || leftReview ? null : state.organizeReviewPage,
      organizeReceiptPage: changedJob || leftReceipt ? null : state.organizeReceiptPage,
      organizeReviewRequestId: changedJob || leftReview ? null : state.organizeReviewRequestId,
      organizeReviewError: changedJob || leftReview || changedReviewRevision
        ? null
        : state.organizeReviewError,
      organizeReceiptRequestId: changedJob || leftReceipt ? null : state.organizeReceiptRequestId,
      organizeReceiptError: changedJob || leftReceipt ? null : state.organizeReceiptError,
      proposal: leftReview ? null : state.proposal,
      selectedProposalRowIds: leftReview ? new Set() : state.selectedProposalRowIds,
      continuationPending,
      pendingCommand: reconcilePendingCommandWithPresentation(
        state.pendingCommand,
        presentation,
      ),
      retryingFailedSuffix,
      conversationAnchor: changedJob && !state.preflight && !state.snapshot
        ? fallbackConversationAnchor(presentation.capturedAt)
        : state.conversationAnchor ?? fallbackConversationAnchor(presentation.capturedAt),
      analysisProgress: presentation.status === 'analyzing' && progressMatchesPresentation
        ? state.analysisProgress
        : null,
      transport: action.authoritative === true ? 'connected' : state.transport,
      error: null,
    };
  }
  if (message.type === 'bgsmOrganizeReviewPage') {
    if (
      state.organizeJob?.jobId !== message.jobId ||
      state.organizeReviewRequestId !== message.requestId ||
      state.organizeJob.revision !== message.revision ||
      state.organizeJob.runId !== message.runId ||
      state.organizeJob.generation !== message.generation
    ) return state;
    const review: ProposalReviewProjection = {
      version: 1,
      proposalId: message.proposalId,
      runId: message.runId,
      generation: message.generation,
      rows: message.rows.map((row) => ({
        proposalRowId: row.proposalRowId,
        frozenIndex: row.position,
        repositoryId: row.repositoryId,
        proposedActions: row.proposedActions,
        preselected: row.selected,
      })),
    };
    return {
      ...state,
      organizeReviewPage: message,
      organizeReviewRequestId: null,
      organizeReviewError: null,
      proposal: {
        proposalId: message.proposalId,
        actionableCount: message.totalRows,
        nonActionableCount: Math.max(0, state.organizeJob.coverage.analyzed - message.totalRows),
        review,
      },
      selectedProposalRowIds: new Set(
        message.rows.filter((row) => row.selected).map((row) => row.proposalRowId),
      ),
      error: null,
    };
  }
  if (message.type === 'bgsmOrganizeReceiptPage') {
    if (
      state.organizeJob?.apply?.applyId !== message.applyId ||
      state.organizeReceiptRequestId !== message.requestId ||
      state.organizeJob.runId !== message.runId ||
      state.organizeJob.generation !== message.generation
    ) return state;
    return {
      ...state,
      organizeReceiptPage: message,
      organizeReceiptRequestId: null,
      organizeReceiptError: null,
      error: null,
    };
  }
  return reduceEvent(state, message.event);
}

function reducePreflight(
  state: AgentWorkbenchState,
  message: BgsmOrganizeJobPreflightResult,
): AgentWorkbenchState {
  if (!state.preflight || message.requestId !== state.preflight.requestId) return state;
  return {
    ...state,
    preflight: {
      requestId: message.requestId,
      status: message.status,
      taskInstruction: state.preflight.taskInstruction,
      label: message.label,
      count: message.count,
      preflightToken: message.preflightToken,
    },
    timeline: appendTimeline(state.timeline, {
      id: `preflight:${message.requestId}`,
      state: 'preflight',
      label: message.status === 'ready'
        ? `${message.label}: ${message.count} repositories`
        : `${message.label}: no repositories`,
    }),
  };
}

function reduceSnapshot(
  state: AgentWorkbenchState,
  snapshot: OrganizeJobRunSnapshot,
  authoritative = false,
): AgentWorkbenchState {
  if (!canAcceptSnapshot(state, snapshot, authoritative)) return state;
  const childRun = state.snapshot?.runId !== snapshot.runId;
  const continuationChild = childRun && (
    state.continuationPending
    || (
      !!state.snapshot
      && state.organizeJob?.runId === snapshot.runId
      && state.organizeJob.generation === snapshot.generation
      && snapshot.generation > state.snapshot.generation
    )
    || (authoritative && state.organizeJob?.status === 'analyzing')
  );
  const retryingFailedSuffix = state.retryingFailedSuffix || (
    continuationChild && state.snapshot?.state === 'analysis_blocked'
  );
  const keepsProgress = ['frozen', 'prepared', 'checking_provider', 'analyzing']
    .includes(snapshot.state);
  const previousDisplayed = displayedAnalyzedRepositoryCount(state);
  const carriedContinuationProgress = continuationChild
    && !retryingFailedSuffix
    && keepsProgress
    && previousDisplayed > 0
    ? {
        runId: snapshot.runId,
        generation: snapshot.generation,
        processed: Math.min(snapshot.frozenScope.count, previousDisplayed),
        total: snapshot.frozenScope.count,
      }
    : null;
  const sameRunDurableRestore = authoritative
    && keepsProgress
    && state.organizeJob?.status === 'analyzing'
    && state.organizeJob.runId === snapshot.runId
    && state.organizeJob.generation === snapshot.generation;
  const cancelledMatchingJob = snapshot.state === 'cancelled'
    && !!state.organizeJob
    && (
      (
        state.organizeJob.runId === snapshot.runId
        && state.organizeJob.generation === snapshot.generation
      )
      || snapshot.generation > state.organizeJob.generation
    );
  return {
    ...state,
    snapshot,
    organizeJob: cancelledMatchingJob ? null : state.organizeJob,
    organizeReviewPage: cancelledMatchingJob ? null : state.organizeReviewPage,
    organizeReceiptPage: cancelledMatchingJob ? null : state.organizeReceiptPage,
    organizeReviewRequestId: cancelledMatchingJob ? null : state.organizeReviewRequestId,
    organizeReceiptRequestId: cancelledMatchingJob ? null : state.organizeReceiptRequestId,
    proposal: cancelledMatchingJob ? null : state.proposal,
    selectedProposalRowIds: cancelledMatchingJob ? new Set() : state.selectedProposalRowIds,
    analysisProgress: carriedContinuationProgress
      ?? (sameRunDurableRestore || (!authoritative && !childRun && keepsProgress)
        ? state.analysisProgress
        : null),
    preflight: childRun ? null : state.preflight,
    usageOffset: continuationChild && state.snapshot
      ? addUsageOffset(state.usageOffset, state.snapshot)
      : childRun ? emptyUsageOffset() : state.usageOffset,
    continuationPending: false,
    pendingCommand: reconcilePendingCommandWithSnapshot(state.pendingCommand, snapshot),
    retryingFailedSuffix: ['review', 'completed', 'cancelled'].includes(snapshot.state)
      ? false
      : retryingFailedSuffix,
    conversationAnchor: state.conversationAnchor
      ?? fallbackConversationAnchor(snapshot.frozenScope.capturedAt),
    transport: authoritative ? 'connected' : state.transport,
    error: null,
    timeline: appendTimeline(state.timeline, {
      id: `snapshot:${snapshot.runId}:${snapshot.generation}:${snapshot.state}`,
      state: snapshot.state,
      label: runStateLabel(snapshot.state),
    }),
  };
}

function fallbackConversationAnchor(createdAt: number): WorkbenchConversationAnchor {
  return { messageId: null, createdAt };
}

function reduceEvent(state: AgentWorkbenchState, event: OrganizeJobRunEvent): AgentWorkbenchState {
  if (!matchesCurrentRun(state, event.runId, event.generation)) return state;
  if (state.seenEventIds.has(event.eventId)) return state;
  if (
    event.type === 'budget_usage_changed' &&
    state.snapshot &&
    !isMonotonicRunBudgetUsage(state.snapshot.usage, event.usage)
  ) return state;
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(event.eventId);
  const next = { ...state, seenEventIds, error: null };
  const snapshot = updateSnapshotFromEvent(next.snapshot, event);
  const timeline = appendTimeline(next.timeline, {
    id: event.eventId,
    state: eventState(event),
    label: eventLabel(event),
  });

  if (event.type === 'budget_exhausted') {
    return {
      ...next,
      snapshot,
      timeline,
      continuationPending: event.usage.consumedFrozenPositions > 0,
      pendingCommand: reconcilePendingCommandWithSnapshot(next.pendingCommand, snapshot),
    };
  }
  return {
    ...next,
    snapshot,
    timeline,
    pendingCommand: reconcilePendingCommandWithSnapshot(next.pendingCommand, snapshot),
  };
}

function reconcilePendingCommandWithPresentation(
  command: WorkbenchPendingCommand | null,
  presentation: BgsmOrganizeJobPresentation,
): WorkbenchPendingCommand | null {
  if (!command) return null;
  if (
    presentation.runId !== command.runId
    || presentation.generation !== command.generation
    || (command.jobId !== null && presentation.jobId !== command.jobId)
  ) return null;
  if (command.kind === 'stop_analysis') return command;
  if (
    command.baselineRevision !== null
    && presentation.revision <= command.baselineRevision
  ) return command;
  if (command.kind === 'take_control') return null;
  if (command.kind === 'apply_selection') {
    return presentation.status === 'review' ? command : null;
  }
  if (command.kind === 'resume_apply') {
    return presentation.status === 'paused' ? command : null;
  }
  return ['paused', 'completed', 'cancelled'].includes(presentation.status)
    ? null
    : command;
}

function reconcilePendingCommandWithSnapshot(
  command: WorkbenchPendingCommand | null,
  snapshot: Pick<OrganizeJobRunSnapshot, 'runId' | 'generation' | 'state'> | null,
): WorkbenchPendingCommand | null {
  if (!command || command.kind !== 'stop_analysis' || snapshot === null) return command;
  if (snapshot.runId !== command.runId || snapshot.generation !== command.generation) return null;
  return ['completed', 'cancelled', 'failed', 'interrupted'].includes(snapshot.state)
    ? null
    : command;
}

function updateSnapshotFromEvent(
  snapshot: OrganizeJobRunSnapshot | null,
  event: OrganizeJobRunEvent,
): OrganizeJobRunSnapshot | null {
  if (!snapshot) return null;
  if (
    event.type === 'run_state_changed' ||
    event.type === 'proposal_summary_ready'
  ) {
    return {
      ...snapshot,
      state: event.state,
      proposalId: event.type === 'proposal_summary_ready'
        ? event.proposalId
        : snapshot.proposalId,
      ...(event.type === 'proposal_summary_ready'
        ? { proposalReviewSummary: event.proposalReviewSummary }
        : {}),
    };
  }
  if (event.type === 'run_terminal') {
    return { ...snapshot, state: event.state, terminalReason: event.reason };
  }
  if (event.type === 'budget_usage_changed') {
    return { ...snapshot, budget: event.budget, usage: event.usage };
  }
  if (event.type === 'budget_exhausted') {
    return {
      ...snapshot,
      state: 'budget_exhausted',
      terminalReason: event.reason,
      budget: event.budget,
      usage: event.usage,
      continuationCursor: event.continuationCursor,
    };
  }
  return snapshot;
}

function matchesCurrentRun(state: AgentWorkbenchState, runId: string, generation: number): boolean {
  if (!state.snapshot) return true;
  return state.snapshot.runId === runId && state.snapshot.generation === generation;
}

function canAcceptSnapshot(
  state: AgentWorkbenchState,
  snapshot: OrganizeJobRunSnapshot,
  authoritative: boolean,
): boolean {
  if (matchesCurrentRun(state, snapshot.runId, snapshot.generation)) return true;
  if (
    state.organizeJob?.runId === snapshot.runId
    && state.organizeJob.generation === snapshot.generation
    && (!state.snapshot || snapshot.generation > state.snapshot.generation)
  ) return true;
  if (authoritative && state.snapshot && snapshot.generation > state.snapshot.generation) {
    return true;
  }
  return state.continuationPending &&
    !!state.snapshot &&
    snapshot.runId !== state.snapshot.runId &&
    snapshot.generation > state.snapshot.generation &&
    snapshot.state === 'prepared';
}

function matchesActiveRun(
  state: AgentWorkbenchState,
  runId: string | null,
  generation: number | null,
): boolean {
  if (runId === null && generation === null) {
    return state.snapshot === null && state.organizeJob === null;
  }
  const active = currentWorkbenchRunIdentity(state);
  return !!active && active.runId === runId && active.generation === generation;
}

export function currentWorkbenchRunIdentity(
  state: AgentWorkbenchState,
): Pick<OrganizeJobRunSnapshot, 'runId' | 'generation'> | null {
  const snapshot = state.snapshot;
  const durable = state.organizeJob;
  if (!durable) return snapshot;
  if (!snapshot || durable.generation >= snapshot.generation) return durable;
  return snapshot;
}

function matchesController(
  state: AgentWorkbenchState,
  message: BgsmOrganizeJobServerMessage,
): boolean {
  if (message.type === 'bgsmOrganizeJobRunEvent' || message.type === 'bgsmOrganizeJobRunSnapshot') {
    const value = message.type === 'bgsmOrganizeJobRunEvent' ? message.event : message.snapshot;
    return value.controllerId === state.controllerId && value.sessionId === state.sessionId;
  }
  return message.controllerId === state.controllerId && message.sessionId === state.sessionId;
}

function appendTimeline(
  timeline: readonly WorkbenchTimelineItem[],
  item: WorkbenchTimelineItem,
): readonly WorkbenchTimelineItem[] {
  if (timeline.some((current) => current.id === item.id)) return timeline;
  return [...timeline, item].slice(-12);
}

function eventState(event: OrganizeJobRunEvent): OrganizeJobRunState {
  if (event.type === 'budget_usage_changed') return 'analyzing';
  return event.state;
}

function eventLabel(event: OrganizeJobRunEvent): string {
  if (event.type === 'budget_usage_changed') {
    return `Analyzed ${event.usage.consumedFrozenPositions} repositories`;
  }
  if (event.type === 'budget_exhausted') return `Budget exhausted: ${formatReason(event.reason)}`;
  if (event.type === 'proposal_summary_ready') {
    return `${event.actionableCount} actionable suggestions ready`;
  }
  if (event.type === 'run_terminal') return formatReason(event.reason);
  return runStateLabel(event.state);
}

function runStateLabel(state: OrganizeJobRunState): string {
  return formatReason(state);
}

export function formatReason(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./u, (character) => character.toUpperCase());
}

export function canContinueOrganizeJobRun(
  snapshot: Pick<OrganizeJobRunSnapshot, 'state' | 'continuationCursor'> | null,
): boolean {
  return !!snapshot?.continuationCursor &&
    ['analysis_blocked', 'budget_exhausted', 'completed', 'failed'].includes(snapshot.state);
}

export function cumulativeOrganizeJobRunUsage(state: AgentWorkbenchState): WorkbenchUsageOffset {
  const usage = state.snapshot?.usage;
  return {
    consumedFrozenPositions:
      state.usageOffset.consumedFrozenPositions + (usage?.consumedFrozenPositions ?? 0),
    analyzerBatches: state.usageOffset.analyzerBatches + (usage?.analyzerBatches ?? 0),
    providerAttempts: state.usageOffset.providerAttempts + (usage?.providerAttempts ?? 0),
  };
}

export function hasCompleteAnalysisCoverage(state: AgentWorkbenchState): boolean {
  const durableCoverage = state.organizeJob?.coverage;
  if (durableCoverage) {
    return durableCoverage.analyzed === durableCoverage.total
      && durableCoverage.analysisFailed === 0;
  }
  const coverage = state.snapshot?.coverage;
  if (coverage) {
    return coverage.analyzed === coverage.total && coverage.analysisFailed === 0;
  }
  const total = state.snapshot?.frozenScope.count;
  return typeof total === 'number'
    && cumulativeOrganizeJobRunUsage(state).consumedFrozenPositions >= total;
}

export function analyzedRepositoryCount(state: AgentWorkbenchState): number {
  const snapshotCount = state.snapshot?.coverage?.analyzed ?? 0;
  const usageCount = cumulativeOrganizeJobRunUsage(state).consumedFrozenPositions;
  const durableJobCount = state.organizeJob?.coverage.analyzed ?? 0;
  if (state.retryingFailedSuffix) {
    const successfulSnapshotCount = state.snapshot?.coverage
      ? state.snapshot.coverage.analyzed - state.snapshot.coverage.analysisFailed
      : 0;
    const successfulDurableJobCount = state.organizeJob?.coverage
      ? state.organizeJob.coverage.analyzed - state.organizeJob.coverage.analysisFailed
      : 0;
    return Math.max(0, successfulSnapshotCount, successfulDurableJobCount);
  }
  return Math.max(snapshotCount, usageCount, durableJobCount);
}

export function displayedAnalyzedRepositoryCount(state: AgentWorkbenchState): number {
  const durable = analyzedRepositoryCount(state);
  const progress = state.analysisProgress;
  const snapshot = state.snapshot;
  if (
    !progress
    || !snapshot
    || progress.runId !== snapshot.runId
    || progress.generation !== snapshot.generation
    || progress.total !== snapshot.frozenScope.count
  ) return durable;
  return Math.min(progress.total, Math.max(durable, progress.processed));
}

function emptyUsageOffset(): WorkbenchUsageOffset {
  return {
    consumedFrozenPositions: 0,
    analyzerBatches: 0,
    providerAttempts: 0,
  };
}

function addUsageOffset(
  offset: WorkbenchUsageOffset,
  snapshot: OrganizeJobRunSnapshot,
): WorkbenchUsageOffset {
  return {
    consumedFrozenPositions:
      offset.consumedFrozenPositions + snapshot.usage.consumedFrozenPositions,
    analyzerBatches: offset.analyzerBatches + snapshot.usage.analyzerBatches,
    providerAttempts: offset.providerAttempts + snapshot.usage.providerAttempts,
  };
}
