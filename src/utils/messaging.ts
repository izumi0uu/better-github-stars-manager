/** Typed message bridge between UI surfaces and the background SW; bgCall
 * unwraps the { ok, data | error } envelope. */
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  normalizeOnboardingStage,
  stageMarksOnboardingSeen,
} from '@/onboarding/state';
import { normalizeBackfillMap, selectActiveBackfillId } from '@/upgrades/backfill-state';
import type { BgsmAgentTurnInput } from '@/bgsm-agent/session';
import type {
  AgentRetryDraft,
  AgentSessionTranscriptPage,
  AgentSessionCatalogInspection,
  AgentSessionCommitResult,
  LoadedAgentSession,
} from '@/storage/agent-session-store';
import {
  validateAgentSessionLaunchIdentity,
  type AgentSessionLaunchDigest,
} from '@/bgsm-agent/session-transport';
import {
  parseBgsmAgentTurnServerMessage,
  type BgsmAgentActiveTurn,
  type BgsmAgentTurnAck,
  type BgsmAgentTurnClientMessage,
  type BgsmAgentTurnError,
  type BgsmAgentTurnEvent,
  type BgsmAgentTurnLaunch,
  type BgsmAgentTurnResult,
  type BgsmAgentTurnServerMessage,
} from '@/bgsm-agent/turn-protocol';
import type {
  OrganizeJobRunEvent,
  OrganizeJobRunCoverageSummary,
  OrganizeJobRunIdentity,
  OrganizeJobRunSnapshot,
} from '@/bgsm-agent/events';
import type { ProposalAction } from '@/bgsm-agent/proposal';
import {
  COMMIT_RECEIPT_OUTCOMES,
  COMMIT_RECEIPT_REASONS,
  type CommitReceiptOutcome,
  type CommitReceiptReason,
} from '@/bgsm-agent/receipt';
import {
  validateOrganizeJobRunCoverageSummary,
  validateOrganizeJobRunEvent,
  validateOrganizeJobRunIdentity,
  validateOrganizeJobRunSnapshot,
} from '@/bgsm-agent/events';
import {
  isControllerId,
  isProposalId,
  isRunId,
  type ControllerId,
  type ProposalId,
  type RunId,
} from '@/bgsm-agent/identity';
import {
  isContinuationCursorToken,
  isPreflightToken,
  type ContinuationCursorToken,
  type PreflightToken,
} from '@/bgsm-agent/scope';
import type { BackfillId, BackfillMap, OnboardingStage, OrganizeJobStatus } from '@/types';

export interface SyncStatus {
  progress: {
    phase: 'idle' | 'full' | 'incremental' | 'rescan' | 'gist';
    done: number;
    total: number | null;
    message: string;
  };
  hasToken: boolean;
  onboardingStage: OnboardingStage;
  /** Whether the first-run onboarding card has been dismissed. */
  seenOnboarding: boolean;
  /** Bitmask of one-time action-button coachmarks shown (bit0=Sync, 1=Push, 2=Pull). */
  seenTooltips: number;
  /** One-shot data backfills keyed by feature, not app version. */
  backfills: BackfillMap;
  /** Highest-priority backfill that still needs user attention. */
  activeBackfillId: BackfillId | null;
  /** True while the background is still holding an active serialized job. */
  inFlight: boolean;
  /** Authoritative durable Organize job activity from the background store. */
  organizeJobActive: boolean;
}

export interface ManagerSurfaceBadgeCounts {
  watchUnreadCount: number;
  radarUnseenCount: number;
}


export type BgsmAgentTurnHandlers = {
  onEvent?: (event: BgsmAgentTurnEvent) => void;
  onResult?: (result: BgsmAgentTurnResult) => void;
  onError?: (error: BgsmAgentTurnError) => void;
};

export type BgsmAgentTurnStartOptions = Readonly<{
  expectedExecutionEpochId?: string;
  resumeOnly?: true;
}>;


export type BgsmOrganizeJobControllerIdentity = Readonly<{
  controllerId: ControllerId;
  sessionId: string;
}>;
export const BGSM_ORGANIZE_CONTROL_ROLES = Object.freeze([
  'owner',
  'observer',
  'owner_lost',
] as const);
export type BgsmOrganizeControlRole = typeof BGSM_ORGANIZE_CONTROL_ROLES[number];


export type BgsmOrganizeJobPreflightIdentity = BgsmOrganizeJobControllerIdentity & Readonly<{
  requestId: string;
}>;

export type BgsmOrganizeJobPresentation = OrganizeJobRunIdentity & Readonly<{
  jobId: string;
  originAgentSessionId: string;
  revision: number;
  status: OrganizeJobStatus;
  scopeLabel: string;
  scopeCount: number;
  capturedAt: number;
  proposalId: ProposalId;
  coverage: OrganizeJobRunCoverageSummary;
  selectedRepositories: number;
  selectedActions: number;
  apply: Readonly<{
    applyId: string;
    total: number;
    settled: number;
    changed: number;
    unchanged: number;
    skipped: number;
    failed: number;
  }> | null;
}>;

export type BgsmOrganizeReviewRow = Readonly<{
  position: number;
  proposalRowId: string;
  repositoryId: string;
  proposedActions: readonly ProposalAction[];
  selected: boolean;
}>;

export type BgsmOrganizeReceiptRow = Readonly<{
  position: number;
  proposalRowId: string;
  repositoryId: string;
  outcome: CommitReceiptOutcome;
  reason: CommitReceiptReason | null;
}>;

export type BgsmOrganizeJobClientMessage =
  | (BgsmOrganizeJobPreflightIdentity & Readonly<{
      type: 'requestBgsmOrganizeJobPreflight';
      taskInstruction: string;
    }>)
  | (BgsmOrganizeJobControllerIdentity & Readonly<{
      type: 'startBgsmOrganizeJob';
      requestId: string;
      preflightToken: PreflightToken;
      taskInstruction: string;
    }>)
  | (BgsmOrganizeJobPreflightIdentity & Readonly<{
      type: 'cancelBgsmOrganizeJobPreflight';
    }>)
  | (BgsmOrganizeJobControllerIdentity & Readonly<{ type: 'requestBgsmActiveOrganizeJob' }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'takeControlBgsmOrganizeJob';
      requestId: string;
      jobId: string;
      expectedRevision: number;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'requestBgsmOrganizeReviewPage';
      requestId: string;
      jobId: string;
      rowOffset: number;
      limit: number;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'updateBgsmOrganizeSelection';
      requestId: string;
      jobId: string;
      expectedRevision: number;
      rowOffset: number;
      selections: readonly Readonly<{ position: number; selected: boolean }>[];
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'setAllBgsmOrganizeSelections';
      requestId: string;
      jobId: string;
      expectedRevision: number;
      rowOffset: number;
      selected: boolean;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'applyBgsmOrganizeSelection';
      requestId: string;
      jobId: string;
      expectedRevision: number;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'resumeBgsmOrganizeApply';
      requestId: string;
      jobId: string;
      expectedRevision: number;
    }>)
  | (BgsmOrganizeJobControllerIdentity & Readonly<{
      type: 'dismissBgsmTerminalOrganizeJob';
      jobId: string;
      expectedRevision: number;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'requestBgsmOrganizeReceiptPage';
      requestId: string;
      jobId: string;
      applyId: string;
      rowOffset: number;
      limit: number;
      filter: 'all' | 'changed_or_failed';
    }>)
  | (OrganizeJobRunIdentity & Readonly<{ type: 'requestBgsmOrganizeJobSnapshot' }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'stopBgsmOrganizeJob';
      requestId: string;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'continueBgsmOrganizeJob';
      continuationCursor: ContinuationCursorToken;
    }>)
  | Readonly<{
      type: 'disconnectBgsmOrganizeJob';
      controllerId: ControllerId;
      sessionId: string;
    }>;

export type BgsmOrganizeJobPreflightResult =
  | (BgsmOrganizeJobPreflightIdentity & Readonly<{
      type: 'bgsmOrganizeJobRunPreflightResult';
      status: 'ready';
      preflightToken: PreflightToken;
      label: string;
      count: number;
    }>)
  | (BgsmOrganizeJobPreflightIdentity & Readonly<{
      type: 'bgsmOrganizeJobRunPreflightResult';
      status: 'no_work';
      preflightToken: null;
      label: string;
      count: 0;
    }>);

export type BgsmOrganizeJobResult = OrganizeJobRunIdentity & Readonly<{
  type: 'bgsmOrganizeJobRunResult';
  snapshot: OrganizeJobRunSnapshot;
}>;

export type BgsmOrganizeJobError = Readonly<{
  type: 'bgsmOrganizeJobRunError';
  controllerId: ControllerId;
  sessionId: string;
  runId: RunId | null;
  generation: number | null;
  reason: BgsmOrganizeJobErrorReason;
  message: string;
  requestId?: string;
}>;

export type BgsmOrganizeJobDisconnected = Readonly<{
  type: 'bgsmOrganizeJobRunDisconnected';
  controllerId: ControllerId;
  sessionId: string;
  runId: RunId | null;
  generation: number | null;
}>;

export type BgsmOrganizeJobConnectionReady = BgsmOrganizeJobControllerIdentity & Readonly<{
  type: 'bgsmOrganizeJobRunConnectionReady';
}>;

export type BgsmOrganizeJobState = BgsmOrganizeJobControllerIdentity & Readonly<{
  type: 'bgsmOrganizeJobState';
  presentation: BgsmOrganizeJobPresentation | null;
  role: BgsmOrganizeControlRole | null;
}>;

export type BgsmAgentSessionDeleted = BgsmOrganizeJobControllerIdentity & Readonly<{
  type: 'bgsmAgentSessionDeleted';
  deletedSessionId: string;
}>;

export type BgsmOrganizeJobAnalysisProgress = OrganizeJobRunIdentity & Readonly<{
  type: 'bgsmOrganizeJobAnalysisProgress';
  processed: number;
  total: number;
}>;

export type BgsmOrganizeJobServerMessage =
  | BgsmOrganizeJobConnectionReady
  | BgsmOrganizeJobState
  | BgsmAgentSessionDeleted
  | BgsmOrganizeJobAnalysisProgress
  | BgsmOrganizeJobPreflightResult
  | Readonly<{ type: 'bgsmOrganizeJobRunEvent'; event: OrganizeJobRunEvent }>
  | Readonly<{ type: 'bgsmOrganizeJobRunSnapshot'; snapshot: OrganizeJobRunSnapshot }>
  | BgsmOrganizeJobResult
  | BgsmOrganizeJobError
  | BgsmOrganizeJobDisconnected
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'bgsmOrganizeReviewPage';
      requestId: string;
      jobId: string;
      revision: number;
      proposalId: ProposalId;
      totalRows: number;
      selectedRepositories: number;
      selectedActions: number;
      rowOffset: number;
      rows: readonly BgsmOrganizeReviewRow[];
      nextRowOffset: number | null;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'bgsmOrganizeReceiptPage';
      requestId: string;
      applyId: string;
      rowOffset: number;
      rows: readonly BgsmOrganizeReceiptRow[];
      nextRowOffset: number | null;
    }>);

export const BGSM_ORGANIZE_JOB_DELIVERY_KINDS = Object.freeze([
  'live',
  'replay',
  'authoritative_snapshot',
] as const);
export type BgsmOrganizeJobDeliveryKind = typeof BGSM_ORGANIZE_JOB_DELIVERY_KINDS[number];

export type BgsmOrganizeJobDeliveryEnvelope = Readonly<{
  type: 'bgsmOrganizeJobRunDelivery';
  connectionEpochId: string;
  deliverySequence: number;
  deliveryKind: BgsmOrganizeJobDeliveryKind;
  durableRevision: number | null;
  message: BgsmOrganizeJobServerMessage;
}>;

export type BgsmOrganizeJobDomainMessage = BgsmOrganizeJobClientMessage | BgsmOrganizeJobServerMessage;
export type BgsmOrganizeJobPortMessage = BgsmOrganizeJobDomainMessage;
export type BgsmOrganizeJobTransportMessage = BgsmOrganizeJobClientMessage | BgsmOrganizeJobDeliveryEnvelope;

export const BGSM_ORGANIZE_JOB_CONTROL_FAILURE_REASONS = Object.freeze([
  'not_owner',
  'owner_connected',
  'revision_conflict',
  'already_started',
  'job_unavailable',
] as const);
export type BgsmOrganizeJobControlFailureReason =
  typeof BGSM_ORGANIZE_JOB_CONTROL_FAILURE_REASONS[number];

export const BGSM_ORGANIZE_JOB_ERROR_REASONS = Object.freeze([
  'invalid_message',
  'preflight_invalid',
  'preflight_stale',
  'preflight_replayed',
  'no_work',
  'stale_generation',
  'disclosure_required',
  'host_permission_missing',
  'host_permission_denied',
  'credential_ineligible',
  'capability_not_ready',
  ...BGSM_ORGANIZE_JOB_CONTROL_FAILURE_REASONS,
  'budget_exhausted',
  'interrupted',
  'internal_error',
] as const);
export type BgsmOrganizeJobErrorReason = typeof BGSM_ORGANIZE_JOB_ERROR_REASONS[number];

const ORGANIZE_JOB_STATUSES = Object.freeze([
  'analyzing',
  'analysis_blocked',
  'paused',
  'review',
  'apply_sealed',
  'applying',
  'completed',
  'cancelled',
] as const satisfies readonly OrganizeJobStatus[]);

export function validateBgsmOrganizeJobMessageIdentity(
  message: BgsmOrganizeJobDomainMessage,
): void {
  assertExactMessageKeys(message as unknown as Record<string, unknown>);
  if ('controllerId' in message) {
    assertControllerSession(message.controllerId, message.sessionId);
  }
  if ('runId' in message) {
    if (message.runId === null) {
      if (!('generation' in message) || message.generation !== null) {
        throw new TypeError('OrganizeJobRun message runId and generation must both be null or both present.');
      }
    } else {
      if (!isRunId(message.runId) || !('generation' in message)) {
        throw new TypeError('OrganizeJobRun message run identity is malformed.');
      }
      assertGeneration(message.generation);
    }
  }
  if ('preflightToken' in message && !isPreflightToken(message.preflightToken)) {
    if (message.preflightToken !== null) {
      throw new TypeError('OrganizeJobRun message preflightToken is malformed.');
    }
  }
  if ('continuationCursor' in message && !isContinuationCursorToken(message.continuationCursor)) {
    throw new TypeError('OrganizeJobRun message continuationCursor is malformed.');
  }
  if ('proposalId' in message && !isProposalId(message.proposalId)) {
    throw new TypeError('OrganizeJobRun message proposalId is malformed.');
  }
  if ('snapshot' in message) {
    validateOrganizeJobRunSnapshot(message.snapshot);
    if (
      'runId' in message &&
      message.runId !== null &&
      (message.snapshot.controllerId !== message.controllerId ||
        message.snapshot.sessionId !== message.sessionId ||
        message.snapshot.runId !== message.runId ||
        message.snapshot.generation !== message.generation)
    ) {
      throw new TypeError('OrganizeJobRun result identity must match its snapshot.');
    }
  }
  if ('event' in message) {
    validateOrganizeJobRunEvent(message.event);
  }
  if (
    'jobId' in message
    && (typeof message.jobId !== 'string' || !message.jobId || message.jobId.trim() !== message.jobId)
  ) {
    throw new TypeError('Organize jobId must be trimmed and nonempty.');
  }
  if ('rowOffset' in message) assertNonnegativeCount(message.rowOffset, 'organize rowOffset');
  if ('processed' in message) {
    assertNonnegativeCount(message.processed, 'organize analyzed progress');
    assertNonnegativeCount(message.total, 'organize analyzed progress total');
    if (message.processed > message.total) {
      throw new RangeError('Organize analyzed progress cannot exceed its total.');
    }
  }
  if ('limit' in message && (!Number.isSafeInteger(message.limit) || message.limit < 1 || message.limit > 100)) {
    throw new RangeError('Organize page limit must be between 1 and 100.');
  }
  if ('expectedRevision' in message) assertNonnegativeCount(message.expectedRevision, 'organize revision');
  if (message.type === 'setAllBgsmOrganizeSelections' && typeof message.selected !== 'boolean') {
    throw new TypeError('Organize select-all value must be boolean.');
  }
  if (
    message.type === 'requestBgsmOrganizeReceiptPage' &&
    message.filter !== 'all' &&
    message.filter !== 'changed_or_failed'
  ) {
    throw new TypeError('Organize receipt filter is invalid.');
  }
  if (
    'applyId' in message
    && (typeof message.applyId !== 'string' || !message.applyId || message.applyId.trim() !== message.applyId)
  ) {
    throw new TypeError('Organize applyId must be trimmed and nonempty.');
  }
  if ('selections' in message) {
    if (!Array.isArray(message.selections) || message.selections.length < 1 || message.selections.length > 100) {
      throw new RangeError('Organize selection mutation must contain 1 to 100 rows.');
    }
    const positions = new Set<number>();
    for (const selection of message.selections) {
      if (!selection || typeof selection !== 'object') throw new TypeError('Organize selection is malformed.');
      const entry = selection as { position?: unknown; selected?: unknown };
      assertExactKeys(entry as Record<string, unknown>, ['position', 'selected']);
      assertNonnegativeCount(entry.position, 'organize selection position');
      if (typeof entry.selected !== 'boolean') throw new TypeError('Organize selection value must be boolean.');
      if (positions.has(entry.position as number)) throw new TypeError('Organize selection positions must be unique.');
      positions.add(entry.position as number);
    }
  }
  if ('presentation' in message) validateOrganizeState(message);
  if (
    'deletedSessionId' in message
    && (
      typeof message.deletedSessionId !== 'string'
      || !message.deletedSessionId
      || message.deletedSessionId.trim() !== message.deletedSessionId
    )
  ) {
    throw new TypeError('Deleted Agent sessionId must be trimmed and nonempty.');
  }
  if (message.type === 'bgsmOrganizeReviewPage') validateOrganizeReviewPageMessage(message);
  if (message.type === 'bgsmOrganizeReceiptPage') validateOrganizeReceiptPageMessage(message);
  if (message.type === 'bgsmOrganizeJobRunPreflightResult') {
    assertNonnegativeCount(message.count, 'preflight count');
    if (
      (message.status === 'ready' &&
        (!isPreflightToken(message.preflightToken) || message.count === 0)) ||
      (message.status === 'no_work' && (message.preflightToken !== null || message.count !== 0))
    ) {
      throw new TypeError('OrganizeJobRun preflight result status/token/count are inconsistent.');
    }
  }
  if ('requestId' in message && (!message.requestId || message.requestId.trim() !== message.requestId)) {
    throw new TypeError('OrganizeJobRun requestId must be trimmed and nonempty.');
  }
  if ('label' in message) assertBoundedText(message.label, 'OrganizeJobRun label', false);
  if ('taskInstruction' in message) assertBoundedText(message.taskInstruction, 'OrganizeJobRun taskInstruction', true);
  if (message.type === 'bgsmOrganizeJobRunError') {
    if (!BGSM_ORGANIZE_JOB_ERROR_REASONS.includes(message.reason)) {
      throw new TypeError('OrganizeJobRun error reason is invalid.');
    }
    if (!message.message || message.message.trim() !== message.message) {
      throw new TypeError('OrganizeJobRun error message must be trimmed and nonempty.');
    }
    if (new TextEncoder().encode(message.message).byteLength > 4_096) {
      throw new RangeError('OrganizeJobRun error message exceeds 4,096 UTF-8 bytes.');
    }
  }
}

export function validateBgsmOrganizeJobDeliveryEnvelope(
  envelope: unknown,
): asserts envelope is BgsmOrganizeJobDeliveryEnvelope {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('OrganizeJobRun delivery envelope must be an object.');
  }
  const candidate = envelope as BgsmOrganizeJobDeliveryEnvelope;
  assertExactKeys(envelope as unknown as Record<string, unknown>, [
    'type',
    'connectionEpochId',
    'deliverySequence',
    'deliveryKind',
    'durableRevision',
    'message',
  ]);
  if (candidate.type !== 'bgsmOrganizeJobRunDelivery') {
    throw new TypeError('OrganizeJobRun delivery envelope type is invalid.');
  }
  if (
    typeof candidate.connectionEpochId !== 'string'
    || candidate.connectionEpochId.trim() !== candidate.connectionEpochId
    || !candidate.connectionEpochId
  ) {
    throw new TypeError('OrganizeJobRun connection epoch is malformed.');
  }
  assertNonnegativeCount(candidate.deliverySequence, 'OrganizeJobRun delivery sequence');
  if (!BGSM_ORGANIZE_JOB_DELIVERY_KINDS.includes(candidate.deliveryKind)) {
    throw new TypeError('OrganizeJobRun delivery kind is invalid.');
  }
  if (candidate.durableRevision !== null) {
    assertNonnegativeCount(candidate.durableRevision, 'OrganizeJobRun durable revision');
  }
  validateBgsmOrganizeJobMessageIdentity(candidate.message);
  if (
    candidate.message.type === 'bgsmOrganizeJobRunConnectionReady'
    && (candidate.deliveryKind !== 'live' || candidate.durableRevision !== null)
  ) {
    throw new TypeError('OrganizeJobRun connection handshake must be a live, non-durable delivery.');
  }
  if (
    candidate.message.type === 'bgsmAgentSessionDeleted'
    && (candidate.deliveryKind !== 'live' || candidate.durableRevision !== null)
  ) {
    throw new TypeError('Agent session deletion invalidation must be a live, non-durable delivery.');
  }
  if (candidate.message.type === 'bgsmOrganizeJobState') {
    if (
      candidate.message.presentation === null
      && (candidate.deliveryKind !== 'authoritative_snapshot' || candidate.durableRevision !== null)
    ) {
      throw new TypeError('OrganizeJobRun no-job state must be an authoritative, non-durable delivery.');
    }
    if (
      candidate.message.presentation !== null
      && candidate.durableRevision !== candidate.message.presentation.revision
    ) {
      throw new TypeError('OrganizeJobRun state delivery revision must match its presentation.');
    }
  }
}

function assertControllerSession(controllerId: unknown, sessionId: unknown): void {
  if (!isControllerId(controllerId)) throw new TypeError('OrganizeJobRun controllerId is malformed.');
  if (typeof sessionId !== 'string' || !sessionId || sessionId.trim() !== sessionId) {
    throw new TypeError('OrganizeJobRun sessionId is malformed.');
  }
}

function validateOrganizePresentation(value: BgsmOrganizeJobPresentation): void {
  assertExactKeys(value as unknown as Record<string, unknown>, [
    'controllerId',
    'sessionId',
    'runId',
    'generation',
    'jobId',
    'revision',
    'originAgentSessionId',
    'status',
    'scopeLabel',
    'scopeCount',
    'capturedAt',
    'proposalId',
    'coverage',
    'selectedRepositories',
    'selectedActions',
    'apply',
  ]);
  validateOrganizeJobRunIdentity(value);
  if (
    !value.jobId
    || value.jobId.trim() !== value.jobId
    || !isProposalId(value.proposalId)
  ) {
    throw new TypeError('Organize presentation authority is malformed.');
  }
  if (
    !value.originAgentSessionId
    || value.originAgentSessionId.trim() !== value.originAgentSessionId
  ) {
    throw new TypeError('Organize origin Agent sessionId must be trimmed and nonempty.');
  }
  assertNonnegativeCount(value.revision, 'organize revision');
  if (!ORGANIZE_JOB_STATUSES.includes(value.status)) {
    throw new TypeError('Organize presentation status is invalid.');
  }
  assertBoundedText(value.scopeLabel, 'organize scope label', true);
  assertNonnegativeCount(value.scopeCount, 'organize scope count');
  assertNonnegativeCount(value.capturedAt, 'organize capture time');
  assertNonnegativeCount(value.selectedRepositories, 'organize selected repositories');
  assertNonnegativeCount(value.selectedActions, 'organize selected actions');
  validateOrganizeJobRunCoverageSummary(value.coverage);
  if (value.coverage.total !== value.scopeCount || value.selectedRepositories > value.coverage.actionable) {
    throw new TypeError('Organize presentation counts are inconsistent.');
  }
  if (value.apply) {
    assertExactKeys(value.apply as unknown as Record<string, unknown>, [
      'applyId',
      'total',
      'settled',
      'changed',
      'unchanged',
      'skipped',
      'failed',
    ]);
    if (!value.apply.applyId.trim()) throw new TypeError('Organize Apply identity is malformed.');
    for (const field of ['total', 'settled', 'changed', 'unchanged', 'skipped', 'failed'] as const) {
      assertNonnegativeCount(value.apply[field], `organize Apply ${field}`);
    }
    if (
      value.apply.settled !== value.apply.changed + value.apply.unchanged + value.apply.skipped + value.apply.failed ||
      value.apply.settled > value.apply.total
    ) throw new TypeError('Organize Apply progress counts are inconsistent.');
  }
}

function validateOrganizeState(message: BgsmOrganizeJobState): void {
  const { presentation, role } = message;
  if (role !== null && !BGSM_ORGANIZE_CONTROL_ROLES.includes(role)) {
    throw new TypeError('Organize control role is invalid.');
  }
  if (presentation === null) {
    if (role !== null) throw new TypeError('Organize no-job state cannot carry a control role.');
    return;
  }
  validateOrganizePresentation(presentation);
  const terminal = presentation.status === 'completed' || presentation.status === 'cancelled';
  if ((terminal && role !== null) || (!terminal && role === null)) {
    throw new TypeError('Organize presentation status and control role are inconsistent.');
  }
}

function validateOrganizeReviewPageMessage(
  message: Extract<BgsmOrganizeJobServerMessage, { type: 'bgsmOrganizeReviewPage' }>,
): void {
  if (!isProposalId(message.proposalId)) throw new TypeError('Organize review proposalId is malformed.');
  assertNonnegativeCount(message.revision, 'organize review revision');
  assertNonnegativeCount(message.totalRows, 'organize review totalRows');
  assertNonnegativeCount(message.selectedRepositories, 'organize review selectedRepositories');
  assertNonnegativeCount(message.selectedActions, 'organize review selectedActions');
  if (!Array.isArray(message.rows) || message.rows.length > 100) {
    throw new RangeError('Organize review page exceeds 100 rows.');
  }
  if (
    message.selectedRepositories > message.totalRows ||
    message.selectedActions < message.selectedRepositories ||
    message.rowOffset + message.rows.length > message.totalRows
  ) {
    throw new TypeError('Organize review page counts are inconsistent.');
  }
  const positions = new Set<number>();
  const proposalRowIds = new Set<string>();
  const repositoryIds = new Set<string>();
  for (const row of message.rows) {
    assertExactKeys(row as unknown as Record<string, unknown>, [
      'position',
      'proposalRowId',
      'repositoryId',
      'proposedActions',
      'selected',
    ]);
    assertNonnegativeCount(row.position, 'organize review position');
    if (!row.proposalRowId.trim() || !row.repositoryId.trim() || typeof row.selected !== 'boolean') {
      throw new TypeError('Organize review row is malformed.');
    }
    if (
      row.proposalRowId !== `${message.proposalId}:row:${row.position}` ||
      positions.has(row.position) ||
      proposalRowIds.has(row.proposalRowId) ||
      repositoryIds.has(row.repositoryId)
    ) {
      throw new TypeError('Organize review row identities must be canonical and unique.');
    }
    positions.add(row.position);
    proposalRowIds.add(row.proposalRowId);
    repositoryIds.add(row.repositoryId);
    if (!Array.isArray(row.proposedActions) || row.proposedActions.length < 1) {
      throw new TypeError('Organize review row requires proposed actions.');
    }
    for (const action of row.proposedActions) {
      assertExactKeys(action as unknown as Record<string, unknown>, ['kind', 'tag', 'evidence']);
      if (
        !['add_existing_tag', 'propose_new_tag'].includes(action.kind) ||
        !action.tag.trim() ||
        !action.evidence.trim()
      ) throw new TypeError('Organize review action is malformed.');
    }
  }
  if (message.nextRowOffset !== null) {
    assertNonnegativeCount(message.nextRowOffset, 'organize next rowOffset');
    if (message.nextRowOffset !== message.rowOffset + message.rows.length) {
      throw new TypeError('Organize review next rowOffset is inconsistent.');
    }
  }
}

function validateOrganizeReceiptPageMessage(
  message: Extract<BgsmOrganizeJobServerMessage, { type: 'bgsmOrganizeReceiptPage' }>,
): void {
  if (!Array.isArray(message.rows) || message.rows.length > 100) {
    throw new RangeError('Organize receipt page exceeds 100 rows.');
  }
  const positions = new Set<number>();
  const proposalRowIds = new Set<string>();
  const repositoryIds = new Set<string>();
  for (const row of message.rows) {
    assertExactKeys(row as unknown as Record<string, unknown>, [
      'position',
      'proposalRowId',
      'repositoryId',
      'outcome',
      'reason',
    ]);
    assertNonnegativeCount(row.position, 'organize receipt position');
    if (!row.proposalRowId.trim() || !row.repositoryId.trim()) {
      throw new TypeError('Organize receipt row identity is malformed.');
    }
    if (
      positions.has(row.position) ||
      proposalRowIds.has(row.proposalRowId) ||
      repositoryIds.has(row.repositoryId)
    ) {
      throw new TypeError('Organize receipt row identities must be unique.');
    }
    positions.add(row.position);
    proposalRowIds.add(row.proposalRowId);
    repositoryIds.add(row.repositoryId);
    if (!COMMIT_RECEIPT_OUTCOMES.includes(row.outcome)) {
      throw new TypeError('Organize receipt outcome is invalid.');
    }
    if (row.reason !== null && !COMMIT_RECEIPT_REASONS.includes(row.reason)) {
      throw new TypeError('Organize receipt reason is invalid.');
    }
    if (
      (row.outcome === 'changed' && row.reason !== null) ||
      (row.outcome === 'unchanged' && row.reason !== 'no_change') ||
      (row.outcome === 'skipped' && ![
        'missing',
        'tombstoned',
        'excluded_tag',
        'stale_source',
        'taxonomy_conflict',
        'policy_failure',
      ].includes(row.reason ?? '')) ||
      (row.outcome === 'failed' && !['transaction_failure', 'policy_failure'].includes(row.reason ?? ''))
    ) {
      throw new TypeError('Organize receipt outcome and reason are inconsistent.');
    }
  }
  if (message.nextRowOffset !== null) {
    assertNonnegativeCount(message.nextRowOffset, 'organize receipt next rowOffset');
    if (message.nextRowOffset !== message.rowOffset + message.rows.length) {
      throw new TypeError('Organize receipt next rowOffset is inconsistent.');
    }
  }
}

function assertGeneration(generation: unknown): void {
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new TypeError('OrganizeJobRun generation is malformed.');
  }
}

function assertNonnegativeCount(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}

function assertBoundedText(value: unknown, field: string, requireNonempty: boolean): void {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    (requireNonempty && value.length === 0)
  ) {
    throw new TypeError(`${field} must be a trimmed${requireNonempty ? ' nonempty' : ''} string.`);
  }
  if (new TextEncoder().encode(value).byteLength > 4_096) {
    throw new RangeError(`${field} exceeds 4,096 UTF-8 bytes.`);
  }
}

function assertExactMessageKeys(message: Record<string, unknown>): void {
  const controller = ['type', 'controllerId', 'sessionId'];
  const run = [...controller, 'runId', 'generation'];
  const preflight = [...controller, 'requestId'];
  let expected: string[];
  switch (message.type) {
    case 'requestBgsmOrganizeJobPreflight':
      expected = [...preflight, 'taskInstruction'];
      break;
    case 'startBgsmOrganizeJob':
      expected = [...controller, 'requestId', 'preflightToken', 'taskInstruction'];
      break;
    case 'cancelBgsmOrganizeJobPreflight':
      expected = preflight;
      break;
    case 'requestBgsmOrganizeJobSnapshot':
      expected = run;
      break;
    case 'stopBgsmOrganizeJob':
      expected = [...run, 'requestId'];
      break;
    case 'requestBgsmActiveOrganizeJob':
      expected = controller;
      break;
    case 'takeControlBgsmOrganizeJob':
      expected = [...run, 'requestId', 'jobId', 'expectedRevision'];
      break;
    case 'requestBgsmOrganizeReviewPage':
      expected = [...run, 'requestId', 'jobId', 'rowOffset', 'limit'];
      break;
    case 'updateBgsmOrganizeSelection':
      expected = [...run, 'requestId', 'jobId', 'expectedRevision', 'rowOffset', 'selections'];
      break;
    case 'setAllBgsmOrganizeSelections':
      expected = [...run, 'requestId', 'jobId', 'expectedRevision', 'rowOffset', 'selected'];
      break;
    case 'applyBgsmOrganizeSelection':
    case 'resumeBgsmOrganizeApply':
      expected = [...run, 'requestId', 'jobId', 'expectedRevision'];
      break;
    case 'dismissBgsmTerminalOrganizeJob':
      expected = [...controller, 'jobId', 'expectedRevision'];
      break;
    case 'requestBgsmOrganizeReceiptPage':
      expected = [...run, 'requestId', 'jobId', 'applyId', 'rowOffset', 'limit', 'filter'];
      break;
    case 'continueBgsmOrganizeJob':
      expected = [...run, 'continuationCursor'];
      break;
    case 'disconnectBgsmOrganizeJob':
      expected = controller;
      break;
    case 'bgsmOrganizeJobRunConnectionReady':
      expected = controller;
      break;
    case 'bgsmAgentSessionDeleted':
      expected = [...controller, 'deletedSessionId'];
      break;
    case 'bgsmOrganizeJobAnalysisProgress':
      expected = [...run, 'processed', 'total'];
      break;
    case 'bgsmOrganizeJobRunPreflightResult':
      expected = [...preflight, 'status', 'preflightToken', 'label', 'count'];
      break;
    case 'bgsmOrganizeJobRunEvent':
      expected = ['type', 'event'];
      break;
    case 'bgsmOrganizeJobRunSnapshot':
      expected = ['type', 'snapshot'];
      break;
    case 'bgsmOrganizeJobRunResult':
      expected = [...run, 'snapshot'];
      break;
    case 'bgsmOrganizeJobRunError':
      expected = [
        ...run,
        ...('requestId' in message ? ['requestId'] : []),
        'reason',
        'message',
      ];
      break;
    case 'bgsmOrganizeJobRunDisconnected':
      expected = run;
      break;
    case 'bgsmOrganizeJobState':
      expected = [...controller, 'presentation', 'role'];
      break;
    case 'bgsmOrganizeReviewPage':
      expected = [
        ...run,
        'requestId',
        'jobId',
        'revision',
        'proposalId',
        'totalRows',
        'selectedRepositories',
        'selectedActions',
        'rowOffset',
        'rows',
        'nextRowOffset',
      ];
      break;
    case 'bgsmOrganizeReceiptPage':
      expected = [...run, 'requestId', 'applyId', 'rowOffset', 'rows', 'nextRowOffset'];
      break;
    default:
      throw new TypeError('Unsupported BGSM OrganizeJobRun Port message type.');
  }
  const actual = Object.keys(message).sort();
  const wanted = expected.sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected BGSM OrganizeJobRun message keys: ${actual.join(', ')}.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected contract keys: ${actual.join(', ')}.`);
  }
}


const BGSM_AGENT_TURN_RECONNECT_LIMIT = 2;
type BgsmAgentTurnTerminalMessage = Extract<
  BgsmAgentTurnServerMessage,
  { type: 'bgsmAgentTurnResult' | 'bgsmAgentTurnError' }
>;

type BgsmAgentTurnReplayFingerprint = Promise<string | null>;

function fingerprintBgsmAgentTerminalReplay(
  message: BgsmAgentTurnTerminalMessage,
): BgsmAgentTurnReplayFingerprint {
  const semanticPayload = message.type === 'bgsmAgentTurnResult' && message.result.commit
    ? {
        type: message.type,
        result: {
          ...message.result,
          commit: {
            ...message.result.commit,
            // A durable replay changes only this delivery marker; it does not change the commit.
            idempotent: undefined,
          },
        },
      }
    : message.type === 'bgsmAgentTurnResult'
      ? { type: message.type, result: message.result }
      : { type: message.type, error: message.error };
  return sha256Base64Url(canonicalJson(semanticPayload))
    .then((digest) => `atrf:v1:${digest}`)
    .catch(() => null);
}

function snapshotBgsmAgentAcknowledgement(ack: BgsmAgentTurnAck): BgsmAgentTurnAck {
  return ack.disposition === 'applied'
    ? Object.freeze({ disposition: 'applied', appliedRevision: ack.appliedRevision })
    : Object.freeze({ disposition: ack.disposition, appliedRevision: null });
}


function toBgsmAgentTurnLaunch(
  input: BgsmAgentTurnInput | BgsmAgentTurnLaunch,
): BgsmAgentTurnLaunch {
  const launch: BgsmAgentTurnLaunch = {
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    prompt: input.prompt,
    ...('retrySourceAttemptId' in input && input.retrySourceAttemptId !== undefined
      ? { retrySourceAttemptId: input.retrySourceAttemptId }
      : {}),
    ...(input.candidateContract === undefined
      ? {}
      : { candidateContract: structuredClone(input.candidateContract) }),
  };
  validateAgentSessionLaunchIdentity(launch);
  return launch;
}

export function startBgsmAgentTurn(
  input: BgsmAgentTurnInput | BgsmAgentTurnLaunch,
  handlers: BgsmAgentTurnHandlers,
  options: BgsmAgentTurnStartOptions = {},
): {
  stop: () => void;
  detach: () => void;
  acknowledge: (ack: BgsmAgentTurnAck) => void;
} {
  const launch = toBgsmAgentTurnLaunch(input);
  let finished = false;
  let stopRequested = false;
  let acknowledgementSent = false;
  let pendingAcknowledgement: BgsmAgentTurnAck | null = null;
  let executionEpochId: string | null = null;
  let activeExecutionEpochId: string | null = null;
  let activePort: chrome.runtime.Port | null = null;
  let activePortReady = false;
  let reconnectAttempts = 0;
  let expectedSequence = 0;
  let sawAgentDone = false;
  let terminalPresented = false;
  let connectionTerminalReceived = false;
  let presentedTerminalFingerprint: BgsmAgentTurnReplayFingerprint | null = null;

  const finishWithError = (error: BgsmAgentTurnError) => {
    if (finished) return;
    finished = true;
    handlers.onError?.(error);
  };

  const finishWithReplayMismatch = (port: chrome.runtime.Port) => {
    finishWithError({
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      message: "Cubby's recovered result did not match the result already shown. Try again.",
      category: 'other',
      code: 'agent_session_corrupt',
    });
    disconnect(port);
  };

  const disconnect = (port: chrome.runtime.Port) => {
    try {
      port.disconnect();
    } catch {
      // Port may already be closed.
    }
  };

  const postStop = () => {
    if (!executionEpochId || !activePort || !activePortReady) return;
    const message: BgsmAgentTurnClientMessage = {
      type: 'stopBgsmAgentTurn',
      executionEpochId,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    };
    try {
      activePort.postMessage(message);
    } catch {
      disconnect(activePort);
    }
  };

  const postAcknowledgement = () => {
    if (
      !pendingAcknowledgement
      || acknowledgementSent
      || !connectionTerminalReceived
      || !activeExecutionEpochId
      || !activePort
      || !activePortReady
    ) return;
    const message: BgsmAgentTurnClientMessage = pendingAcknowledgement.disposition === 'applied'
      ? {
          type: 'ackBgsmAgentTurnResult',
          executionEpochId: activeExecutionEpochId,
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          disposition: 'applied',
          appliedRevision: pendingAcknowledgement.appliedRevision,
        }
      : {
          type: 'ackBgsmAgentTurnResult',
          executionEpochId: activeExecutionEpochId,
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          disposition: pendingAcknowledgement.disposition,
          appliedRevision: null,
        };
    try {
      activePort.postMessage(message);
    } catch {
      disconnect(activePort);
      return;
    }
    acknowledgementSent = true;
  };

  const connect = () => {
    if (finished) return;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: 'bgsm-agent' });
    } catch (error) {
      if (reconnectAttempts < BGSM_AGENT_TURN_RECONNECT_LIMIT) {
        reconnectAttempts += 1;
        queueMicrotask(connect);
        return;
      }
      finishWithError({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: error instanceof Error ? error.message : 'Cubby could not connect.',
      });
      return;
    }
    activePort = port;
    activePortReady = false;
    let helloReceived = false;

    port.onMessage.addListener(async (rawMessage: unknown) => {
      if (finished || activePort !== port) return;
      let message: BgsmAgentTurnServerMessage;
      try {
        message = parseBgsmAgentTurnServerMessage(rawMessage);
      } catch {
        finishWithError({
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          message: "Cubby's connection returned invalid data. Try again.",
          category: 'other',
        });
        disconnect(port);
        return;
      }
      if (message.type === 'bgsmAgentTurnHello') {
        if (helloReceived) {
          finishWithError({
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            message: "Cubby's connection restarted unexpectedly. Try again.",
            category: 'other',
          });
          disconnect(port);
          return;
        }
        helloReceived = true;
        activeExecutionEpochId = message.executionEpochId;
        if (
          options.expectedExecutionEpochId !== undefined
          && message.executionEpochId !== options.expectedExecutionEpochId
        ) {
          finishWithError({
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            message: "Cubby's active request belongs to a previous extension worker. Try again.",
            category: 'other',
            code: 'agent_turn_resume_epoch_changed',
          });
          disconnect(port);
          return;
        }
        if (executionEpochId !== null && executionEpochId !== message.executionEpochId) {
          expectedSequence = 0;
          sawAgentDone = false;
        }
        executionEpochId = message.executionEpochId;
        activePortReady = true;
        const startMessage: BgsmAgentTurnClientMessage = {
          type: 'startBgsmAgentTurn',
          executionEpochId,
          ...launch,
          ...(options.resumeOnly ? { resumeOnly: true } : {}),
        };
        try {
          port.postMessage(startMessage);
        } catch (error) {
          activePort = null;
          activePortReady = false;
          activeExecutionEpochId = null;
          acknowledgementSent = false;
          disconnect(port);
          if (reconnectAttempts < BGSM_AGENT_TURN_RECONNECT_LIMIT) {
            reconnectAttempts += 1;
            queueMicrotask(connect);
            return;
          }
          finishWithError({
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            message: error instanceof Error
              ? error.message
              : 'Cubby could not start. Try again.',
          });
          return;
        }
        if (stopRequested) postStop();
        postAcknowledgement();
        return;
      }
      if (message.type === 'bgsmAgentTurnAck') {
        if (
          !connectionTerminalReceived
          || !pendingAcknowledgement
          || message.turnAttemptId !== input.turnAttemptId
          || message.sessionId !== input.sessionId
          || message.baseRevision !== input.baseRevision
          || message.disposition !== pendingAcknowledgement.disposition
          || message.appliedRevision !== pendingAcknowledgement.appliedRevision
        ) return;
        finished = true;
        disconnect(port);
        return;
      }
      const acceptTerminalReplay = async (message: BgsmAgentTurnTerminalMessage) => {
        const expectedFingerprint = presentedTerminalFingerprint;
        if (!expectedFingerprint) {
          finishWithReplayMismatch(port);
          return;
        }
        const [expected, actual] = await Promise.all([
          expectedFingerprint,
          fingerprintBgsmAgentTerminalReplay(message),
        ]);
        if (finished || activePort !== port) return;
        if (!expected || !actual || expected !== actual) {
          finishWithReplayMismatch(port);
          return;
        }
        connectionTerminalReceived = true;
        postAcknowledgement();
      };
      const delivery = message.type === 'bgsmAgentTurnEvent'
        ? message.event
        : message.type === 'bgsmAgentTurnResult'
          ? message.result
          : message.error;
      if (
        delivery.sessionId !== input.sessionId
        || delivery.baseRevision !== input.baseRevision
        || delivery.turnAttemptId !== input.turnAttemptId
      ) return;
      if (terminalPresented && message.sequence < expectedSequence) {
        if (message.type !== 'bgsmAgentTurnEvent') await acceptTerminalReplay(message);
        return;
      }
      if (message.sequence < expectedSequence) return;
      if (message.sequence > expectedSequence) {
        finishWithError({
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          message: "Cubby's connection was interrupted. Try again.",
          category: 'other',
        });
        disconnect(port);
        return;
      }
      expectedSequence += 1;
      if (terminalPresented) {
        if (message.type !== 'bgsmAgentTurnEvent') await acceptTerminalReplay(message);
        return;
      }
      if (sawAgentDone && message.type !== 'bgsmAgentTurnResult') {
        finishWithError({
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          message: "Cubby's connection returned unexpected data. Try again.",
          category: 'other',
        });
        disconnect(port);
        return;
      }

      if (message.type === 'bgsmAgentTurnEvent') {
        if (message.event.type === 'agent_done') sawAgentDone = true;
        handlers.onEvent?.(message.event);
        return;
      }
      terminalPresented = true;
      presentedTerminalFingerprint = fingerprintBgsmAgentTerminalReplay(message);
      connectionTerminalReceived = true;
      if (message.type === 'bgsmAgentTurnResult') {
        handlers.onResult?.(message.result);
        if (!handlers.onResult) {
          pendingAcknowledgement = { disposition: 'no_transition', appliedRevision: null };
          postAcknowledgement();
        }
        return;
      }
      handlers.onError?.(message.error);
      if (!handlers.onError) {
        pendingAcknowledgement = { disposition: 'no_transition', appliedRevision: null };
        postAcknowledgement();
      }
    });

    port.onDisconnect.addListener(() => {
      if (finished || activePort !== port) return;
      activePort = null;
      activePortReady = false;
      activeExecutionEpochId = null;
      acknowledgementSent = false;
      connectionTerminalReceived = false;
      if (reconnectAttempts < BGSM_AGENT_TURN_RECONNECT_LIMIT) {
        reconnectAttempts += 1;
        connect();
        return;
      }
      finishWithError({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: chrome.runtime.lastError?.message ?? 'Cubby stopped before finishing. Try again.',
      });
    });
  };

  connect();

  return {
    stop() {
      if (finished) return;
      if (!stopRequested) {
        stopRequested = true;
        postStop();
      }
    },
    detach() {
      if (finished) return;
      finished = true;
      const port = activePort;
      activePort = null;
      activePortReady = false;
      activeExecutionEpochId = null;
      pendingAcknowledgement = null;
      if (port) disconnect(port);
    },
    acknowledge(ack) {
      if (
        finished
        || acknowledgementSent
        || pendingAcknowledgement
        || !terminalPresented
      ) return;
      pendingAcknowledgement = snapshotBgsmAgentAcknowledgement(ack);
      postAcknowledgement();
    },
  };
}


export function mergeProgressStatus(
  current: SyncStatus | null,
  progress: SyncStatus['progress'],
  fallbackHasToken = true,
): SyncStatus {
  const hasToken = current?.hasToken ?? fallbackHasToken;
  const onboardingStage = normalizeOnboardingStage(
    current?.onboardingStage,
    current?.seenOnboarding,
    hasToken,
  );
  const backfills = normalizeBackfillMap(current?.backfills);
  return {
    progress,
    hasToken,
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
    seenTooltips: current?.seenTooltips ?? 0,
    backfills,
    activeBackfillId: selectActiveBackfillId(backfills),
    inFlight: progress.phase !== 'idle',
    organizeJobActive: current?.organizeJobActive ?? false,
  };
}

export function mergeStatusPatch(
  current: SyncStatus | null,
  patch: Partial<SyncStatus>,
  fallbackHasToken = false,
): SyncStatus {
  const base: SyncStatus = current ?? {
    progress: { phase: 'idle', done: 0, total: null, message: '' },
    hasToken: fallbackHasToken,
    onboardingStage: fallbackHasToken ? 'awaiting_sync' : 'needs_token',
    seenOnboarding: false,
    seenTooltips: 0,
    backfills: {},
    activeBackfillId: null,
    inFlight: false,
    organizeJobActive: false,
  };
  const hasToken = patch.hasToken ?? base.hasToken;
  const onboardingStage = normalizeOnboardingStage(
    patch.onboardingStage ?? base.onboardingStage,
    patch.seenOnboarding ?? base.seenOnboarding,
    hasToken,
  );
  const backfills = normalizeBackfillMap(patch.backfills ?? base.backfills);
  return {
    ...base,
    ...patch,
    hasToken,
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
    backfills,
    activeBackfillId: selectActiveBackfillId(patch.backfills ?? base.backfills),
    progress: patch.progress ?? base.progress,
  };
}

export function mergeStatusSnapshot(current: SyncStatus | null, snapshot: SyncStatus | null): SyncStatus | null {
  if (!snapshot) return current;
  const activeProgress = current?.progress;
  const keepLiveProgress =
    !!activeProgress &&
    !!current?.inFlight &&
    activeProgress.phase !== 'idle' &&
    snapshot.progress.phase === 'idle';
  // Preserve the live progress (and seenOnboarding/seenTooltips) from `current`
  // when the snapshot is idle — a fresh getStatus shouldn't clobber an in-flight phase.
  const merged: SyncStatus = {
    ...snapshot,
    progress: keepLiveProgress ? activeProgress : snapshot.progress,
    onboardingStage: normalizeOnboardingStage(
      snapshot.onboardingStage ?? current?.onboardingStage,
      snapshot.seenOnboarding ?? current?.seenOnboarding,
      snapshot.hasToken ?? current?.hasToken ?? false,
    ),
    seenOnboarding: false,
    seenTooltips: snapshot.seenTooltips ?? current?.seenTooltips ?? 0,
    backfills: normalizeBackfillMap(snapshot.backfills ?? current?.backfills),
    activeBackfillId: selectActiveBackfillId(snapshot.backfills ?? current?.backfills),
    inFlight: keepLiveProgress ? true : snapshot.inFlight ?? current?.inFlight ?? snapshot.progress.phase !== 'idle',
    organizeJobActive: snapshot.organizeJobActive ?? current?.organizeJobActive ?? false,
  };
  merged.seenOnboarding = stageMarksOnboardingSeen(merged.onboardingStage);
  return merged;
}

export class BackgroundCallError extends Error {
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, details?: unknown, code: string | null = null) {
    super(message);
    this.name = 'BackgroundCallError';
    this.details = details;
    this.code = code;
  }
}

export async function bgCall<T = unknown>(type: string, extra?: Record<string, unknown>): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ type, ...extra })) as
    | { ok: true; data?: T }
    | { ok: false; error: string; code?: string; details?: unknown };
  if (!res.ok) throw new BackgroundCallError(res.error, res.details, res.code ?? null);
  return (res.data ?? (undefined as unknown)) as T;
}

export function inspectBgsmAgentSessionCatalog(): Promise<AgentSessionCatalogInspection> {
  return bgCall('inspectAgentSessionCatalog');
}
export function getOrCreateInitialDurableBgsmAgentSession(): Promise<LoadedAgentSession> {
  return bgCall('getOrCreateInitialAgentSession');
}


export function inspectActiveBgsmAgentSessionTurn(
  sessionId: string,
): Promise<BgsmAgentActiveTurn | null> {
  return bgCall('inspectActiveAgentSessionTurn', { sessionId });
}

export function createDurableBgsmAgentSession(sessionId?: string): Promise<LoadedAgentSession> {
  return bgCall('createAgentSession', sessionId ? { sessionId } : undefined);
}

export function loadDurableBgsmAgentSession(sessionId: string): Promise<LoadedAgentSession> {
  return bgCall('loadAgentSession', { sessionId });
}

export function loadDurableBgsmAgentSessionCommittedTurn(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  launchDigest: AgentSessionLaunchDigest;
}>): Promise<AgentSessionCommitResult | null> {
  return bgCall('loadCommittedAgentSessionTurn', {
    sessionId: input.sessionId,
    turnAttemptId: input.turnAttemptId,
    launchDigest: input.launchDigest,
  });
}

export async function readDurableAgentRetryDraftCandidate(
  sessionId: string,
): Promise<AgentRetryDraft | null> {
  return bgCall<AgentRetryDraft | null>('readAgentRetryDraftCandidate', { sessionId });
}

export function dismissDurableAgentSessionRetry(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
}>): Promise<boolean> {
  return bgCall('dismissAgentSessionRetry', input);
}
export function abandonDurableAgentSessionUncertainAttempt(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
}>): Promise<boolean> {
  return bgCall('abandonAgentSessionUncertainAttempt', input);
}


export function discardDurableAgentSessionRecovery(sessionId: string): Promise<number> {
  return bgCall('discardDamagedAgentSessionRecovery', { sessionId });
}

export function loadDurableBgsmAgentSessionTranscriptPage(
  sessionId: string,
  beforeSequence: number,
): Promise<AgentSessionTranscriptPage> {
  return bgCall('loadAgentSessionTranscriptPage', { sessionId, beforeSequence });
}

export async function deleteDurableBgsmAgentSession(sessionId: string): Promise<boolean> {
  const result = await bgCall<{ deleted: boolean }>('deleteAgentSession', { sessionId });
  return result.deleted;
}

export function onProgress(cb: (p: SyncStatus['progress']) => void): () => void {
  const listener = (msg: { type?: string; progress?: SyncStatus['progress'] }) => {
    if (msg.type === 'progress' && msg.progress) cb(msg.progress);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
