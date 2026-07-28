/** Typed message bridge between UI surfaces and the background SW; bgCall
 * unwraps the { ok, data | error } envelope. */
import {
  normalizeOnboardingStage,
  stageMarksOnboardingSeen,
} from '@/onboarding/state';
import { normalizeBackfillMap, selectActiveBackfillId } from '@/upgrades/backfill-state';
import type {
  BgsmAgentActiveProjection,
  BgsmAgentCompactionCheckpoint,
  BgsmAgentSessionMessage,
  BgsmAgentTurnInput,
} from '@/bgsm-agent/session';
import {
  validateBgsmAgentConversationBinding,
  type BgsmAgentConversationBinding,
} from '@/bgsm-agent/conversation-binding';
import {
  type AgentContextFailureReason,
  type AgentErrorCategory,
  type AgentStopReason,
  type ToolRisk,
} from '@/agent-harness';
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
}

export interface BgsmAgentTurnResult {
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
  reason: AgentStopReason;
  changed: boolean;
  changedCount: number;
  newMessages: BgsmAgentSessionMessage[];
  candidateCheckpoint?: BgsmAgentCompactionCheckpoint;
  candidateActiveProjection?: BgsmAgentActiveProjection | null;
  contextFailureReason?: AgentContextFailureReason;
}

type BgsmAgentDeliveryIdentity = {
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
};

type BgsmAgentTurnEventPayload =
  | { type: 'agent_queued' }
  | { type: 'conversation_bound'; binding: BgsmAgentConversationBinding }
  | { type: 'agent_start' }
  | { type: 'turn_start'; step: number }
  | { type: 'assistant_stream_start'; step: number }
  | { type: 'assistant_text_delta'; step: number; delta: string }
  | { type: 'message_update'; message: BgsmAgentSessionMessage }
  | { type: 'tool_execution_queued'; toolName: string; callId: string }
  | { type: 'tool_execution_start'; toolName: string; callId: string; risk: ToolRisk }
  | {
      type: 'tool_execution_end';
      toolName: string;
      callId: string;
      risk: ToolRisk;
      ok: boolean;
      writeOutcome: 'not_applicable' | 'committed' | 'failed' | 'unknown';
    }
  | { type: 'approval_required'; callId: string; summary: string }
  | { type: 'context_compaction_start' }
  | {
      type: 'context_diagnostic';
      stage: 'preflight' | 'tool_allowance' | 'post_tool' | 'compaction';
      providerWindow: number;
      workingWindow: number;
      softLimit: number;
      hardLimit: number;
      capabilitySource: 'builtin-official' | 'provider-verified' | 'user-declared';
      capabilityRevision: string;
      policyRevision: string;
      inputTokens?: number;
      deterministicInputTokens?: number;
      usageAdjustmentTokens?: number;
      observedPrefixTokens?: number | null;
      contextRemainingTokens?: number;
      toolAllowanceBytes?: number;
      toolMemoryRemainingBytes?: number;
      toolProviderResultCeilingBytes?: number;
      toolBudgetLimitedBy?: 'context' | 'memory' | 'provider' | 'multiple';
      toolResultBytes?: number;
      toolResultReduced?: boolean;
      action?: 'triggered' | 'summary_retry' | 'fallback' | 'terminal';
      trigger?: 'pre_turn_soft_limit' | 'pre_turn_byte_limit' | 'completed_tool_envelope_soft_limit' | 'completed_tool_envelope_byte_limit' | 'forced_completed_tool_envelope' | 'provider_context_overflow' | 'provider_request_byte_limit';
      category?: 'succeeded' | 'current_turn_too_large' | 'no_candidate' | 'summary_provider_failed' | 'summary_invalid' | 'fallback_too_large' | 'final_preflight_failed' | 'capability_unresolved' | 'provider_context_overflow' | 'provider_context_overflow_repeated' | 'provider_request_byte_limit' | 'provider_request_byte_limit_repeated';
    }
  | {
      type: 'context_compaction_end';
      ok: boolean;
      summarizedMessageCount: number;
    }
  | { type: 'agent_error'; message: string; category?: AgentErrorCategory }
  | {
      type: 'agent_done';
      reason: AgentStopReason;
      contextFailureReason?: AgentContextFailureReason;
    };

export type BgsmAgentTurnEvent = BgsmAgentTurnEventPayload & BgsmAgentDeliveryIdentity;

export type BgsmAgentTurnError = BgsmAgentDeliveryIdentity & {
  message: string;
  category?: AgentErrorCategory;
};

export type BgsmAgentTurnHandlers = {
  onEvent?: (event: BgsmAgentTurnEvent) => void;
  onResult?: (result: BgsmAgentTurnResult) => void;
  onError?: (error: BgsmAgentTurnError) => void;
};

export type BgsmAgentTurnAck = Readonly<
  | { disposition: 'applied'; appliedRevision: number }
  | { disposition: 'not_applied'; appliedRevision: null }
>;

export type BgsmOrganizeJobControllerIdentity = Readonly<{
  controllerId: ControllerId;
  sessionId: string;
}>;

export type BgsmOrganizeJobPreflightIdentity = BgsmOrganizeJobControllerIdentity & Readonly<{
  requestId: string;
}>;

export type BgsmOrganizeJobPresentation = OrganizeJobRunIdentity & Readonly<{
  jobId: string;
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
    }>)
  | (BgsmOrganizeJobControllerIdentity & Readonly<{
      type: 'startBgsmOrganizeJob';
      preflightToken: PreflightToken;
      taskInstruction: string;
    }>)
  | (BgsmOrganizeJobPreflightIdentity & Readonly<{
      type: 'cancelBgsmOrganizeJobPreflight';
    }>)
  | (BgsmOrganizeJobControllerIdentity & Readonly<{ type: 'requestBgsmActiveOrganizeJob' }>)
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
      jobId: string;
      expectedRevision: number;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'resumeBgsmOrganizeApply';
      jobId: string;
      expectedRevision: number;
    }>)
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'dismissBgsmOrganizeReceipt';
      jobId: string;
      applyId: string;
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
  | (OrganizeJobRunIdentity & Readonly<{ type: 'stopBgsmOrganizeJob' }>)
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

export type BgsmOrganizeJobServerMessage =
  | BgsmOrganizeJobConnectionReady
  | BgsmOrganizeJobPreflightResult
  | Readonly<{ type: 'bgsmOrganizeJobRunEvent'; event: OrganizeJobRunEvent }>
  | Readonly<{ type: 'bgsmOrganizeJobRunSnapshot'; snapshot: OrganizeJobRunSnapshot }>
  | BgsmOrganizeJobResult
  | BgsmOrganizeJobError
  | BgsmOrganizeJobDisconnected
  | (OrganizeJobRunIdentity & Readonly<{
      type: 'bgsmOrganizeJobState';
      presentation: BgsmOrganizeJobPresentation;
    }>)
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
  'already_started',
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
  if ('jobId' in message && (typeof message.jobId !== 'string' || !message.jobId.trim())) {
    throw new TypeError('Organize jobId must be nonempty.');
  }
  if ('rowOffset' in message) assertNonnegativeCount(message.rowOffset, 'organize rowOffset');
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
  if ('applyId' in message && (typeof message.applyId !== 'string' || !message.applyId.trim())) {
    throw new TypeError('Organize applyId must be nonempty.');
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
  if ('presentation' in message) validateOrganizePresentation(message.presentation, message);
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
}

function assertControllerSession(controllerId: unknown, sessionId: unknown): void {
  if (!isControllerId(controllerId)) throw new TypeError('OrganizeJobRun controllerId is malformed.');
  if (typeof sessionId !== 'string' || !sessionId || sessionId.trim() !== sessionId) {
    throw new TypeError('OrganizeJobRun sessionId is malformed.');
  }
}

function validateOrganizePresentation(
  value: BgsmOrganizeJobPresentation,
  envelope: OrganizeJobRunIdentity,
): void {
  assertExactKeys(value as unknown as Record<string, unknown>, [
    'controllerId',
    'sessionId',
    'runId',
    'generation',
    'jobId',
    'revision',
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
    value.controllerId !== envelope.controllerId ||
    value.sessionId !== envelope.sessionId ||
    value.runId !== envelope.runId ||
    value.generation !== envelope.generation
  ) throw new TypeError('Organize presentation identity must match its envelope.');
  if (!value.jobId.trim() || !isProposalId(value.proposalId)) {
    throw new TypeError('Organize presentation authority is malformed.');
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
      expected = preflight;
      break;
    case 'startBgsmOrganizeJob':
      expected = [...controller, 'preflightToken', 'taskInstruction'];
      break;
    case 'cancelBgsmOrganizeJobPreflight':
      expected = preflight;
      break;
    case 'requestBgsmOrganizeJobSnapshot':
    case 'stopBgsmOrganizeJob':
      expected = run;
      break;
    case 'requestBgsmActiveOrganizeJob':
      expected = controller;
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
      expected = [...run, 'jobId', 'expectedRevision'];
      break;
    case 'dismissBgsmOrganizeReceipt':
      expected = [...run, 'jobId', 'applyId'];
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
      expected = [...run, 'reason', 'message'];
      break;
    case 'bgsmOrganizeJobRunDisconnected':
      expected = run;
      break;
    case 'bgsmOrganizeJobState':
      expected = [...run, 'presentation'];
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

type BgsmAgentTurnPortMessage =
  | { type: 'bgsmAgentTurnHello'; executionEpochId: string }
  | {
      type: 'bgsmAgentTurnAck';
      turnAttemptId: string;
      sessionId: string;
      baseRevision: number;
      disposition: 'applied' | 'not_applied';
      appliedRevision: number | null;
    }
  | { type: 'bgsmAgentTurnEvent'; sequence: number; event: BgsmAgentTurnEvent }
  | { type: 'bgsmAgentTurnResult'; sequence: number; result: BgsmAgentTurnResult }
  | { type: 'bgsmAgentTurnError'; sequence: number; error: BgsmAgentTurnError };

const BGSM_AGENT_TURN_RECONNECT_LIMIT = 2;

export function startBgsmAgentTurn(
  input: BgsmAgentTurnInput,
  handlers: BgsmAgentTurnHandlers,
): {
  stop: (options?: Readonly<{ detach?: boolean }>) => void;
  acknowledge: (ack: BgsmAgentTurnAck) => void;
} {
  let finished = false;
  let detached = false;
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
  let terminalDeliveryReceived = false;

  const finishWithError = (error: BgsmAgentTurnError) => {
    if (finished) return;
    finished = true;
    if (!detached) handlers.onError?.(error);
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
    try {
      activePort.postMessage({
        type: 'stopBgsmAgentTurn',
        executionEpochId,
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      });
    } catch {
      disconnect(activePort);
    }
  };

  const postAcknowledgement = () => {
    if (
      !pendingAcknowledgement
      || acknowledgementSent
      || !terminalDeliveryReceived
      || !activeExecutionEpochId
      || !activePort
      || !activePortReady
    ) return;
    try {
      activePort.postMessage({
        type: 'ackBgsmAgentTurnResult',
        executionEpochId: activeExecutionEpochId,
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        disposition: pendingAcknowledgement.disposition,
        appliedRevision: pendingAcknowledgement.appliedRevision,
      });
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
        message: error instanceof Error ? error.message : 'BGSM Agent could not connect.',
      });
      return;
    }
    activePort = port;
    activePortReady = false;
    let helloReceived = false;

    port.onMessage.addListener((rawMessage: unknown) => {
      if (finished || activePort !== port) return;
      let message: BgsmAgentTurnPortMessage;
      try {
        message = parseBgsmAgentTurnPortMessage(rawMessage);
      } catch {
        finishWithError({
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          message: 'BGSM Agent received an invalid background delivery.',
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
            message: 'BGSM Agent received a duplicate worker handshake.',
            category: 'other',
          });
          disconnect(port);
          return;
        }
        helloReceived = true;
        activeExecutionEpochId = message.executionEpochId;
        if (executionEpochId === null) {
          executionEpochId = message.executionEpochId;
        } else if (executionEpochId !== message.executionEpochId) {
          expectedSequence = 0;
          sawAgentDone = false;
        }
        activePortReady = true;
        try {
          port.postMessage({
            type: 'startBgsmAgentTurn',
            executionEpochId,
            ...input,
          });
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
              : 'BGSM Agent could not start the background turn.',
          });
          return;
        }
        if (stopRequested) postStop();
        postAcknowledgement();
        return;
      }
      if (message.type === 'bgsmAgentTurnAck') {
        if (
          !terminalDeliveryReceived
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
      if (terminalDeliveryReceived) return;
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
      if (message.sequence < expectedSequence) return;
      if (message.sequence > expectedSequence) {
        finishWithError({
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          message: 'BGSM Agent background deliveries arrived out of order.',
          category: 'other',
        });
        disconnect(port);
        return;
      }
      expectedSequence += 1;
      if (sawAgentDone && message.type !== 'bgsmAgentTurnResult') {
        finishWithError({
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          message: 'BGSM Agent delivered data after its terminal event.',
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
      terminalDeliveryReceived = true;
      if (message.type === 'bgsmAgentTurnResult') {
        if (!detached) handlers.onResult?.(message.result);
        if (detached || !handlers.onResult) {
          pendingAcknowledgement = { disposition: 'not_applied', appliedRevision: null };
          postAcknowledgement();
        }
        return;
      }
      if (!detached) handlers.onError?.(message.error);
      if (detached || !handlers.onError) {
        pendingAcknowledgement = { disposition: 'not_applied', appliedRevision: null };
        postAcknowledgement();
      }
    });

    port.onDisconnect.addListener(() => {
      if (finished || activePort !== port) return;
      activePort = null;
      activePortReady = false;
      activeExecutionEpochId = null;
      acknowledgementSent = false;
      if (reconnectAttempts < BGSM_AGENT_TURN_RECONNECT_LIMIT) {
        reconnectAttempts += 1;
        connect();
        return;
      }
      finishWithError({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: chrome.runtime.lastError?.message ?? 'BGSM Agent stopped before finishing.',
      });
    });
  };

  connect();

  return {
    stop(options) {
      if (finished) return;
      if (options?.detach) detached = true;
      if (!stopRequested) {
        stopRequested = true;
        postStop();
      }
    },
    acknowledge(ack) {
      if (
        finished
        || acknowledgementSent
        || pendingAcknowledgement
        || !terminalDeliveryReceived
      ) return;
      pendingAcknowledgement = ack;
      postAcknowledgement();
    },
  };
}

function parseBgsmAgentTurnPortMessage(value: unknown): BgsmAgentTurnPortMessage {
  if (!isAgentRecord(value)) throw new TypeError('Agent Port message must be an object.');
  if (value.type === 'bgsmAgentTurnHello') {
    assertAgentExactKeys(value, ['type', 'executionEpochId']);
    assertAgentText(value.executionEpochId, 'executionEpochId', 512, true);
    return value as unknown as BgsmAgentTurnPortMessage;
  }
  if (value.type === 'bgsmAgentTurnAck') {
    assertAgentExactKeys(value, [
      'type',
      'turnAttemptId',
      'sessionId',
      'baseRevision',
      'disposition',
      'appliedRevision',
    ]);
    validateAgentDeliveryIdentity(value);
    if (value.disposition === 'not_applied') {
      if (value.appliedRevision !== null) {
        throw new TypeError('Agent acknowledgement revision is invalid.');
      }
    } else if (
      value.disposition !== 'applied'
      || !Number.isSafeInteger(value.appliedRevision)
      || Number(value.appliedRevision) !== Number(value.baseRevision) + 1
    ) {
      throw new TypeError('Agent acknowledgement revision is invalid.');
    }
    return value as unknown as BgsmAgentTurnPortMessage;
  }
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) {
    throw new TypeError('Agent Port sequence is invalid.');
  }
  if (value.type === 'bgsmAgentTurnEvent') {
    assertAgentExactKeys(value, ['type', 'sequence', 'event']);
    validateAgentTurnEvent(value.event);
    return value as unknown as BgsmAgentTurnPortMessage;
  }
  if (value.type === 'bgsmAgentTurnResult') {
    assertAgentExactKeys(value, ['type', 'sequence', 'result']);
    validateAgentTurnResult(value.result);
    return value as unknown as BgsmAgentTurnPortMessage;
  }
  if (value.type === 'bgsmAgentTurnError') {
    assertAgentExactKeys(value, ['type', 'sequence', 'error']);
    validateAgentTurnError(value.error);
    return value as unknown as BgsmAgentTurnPortMessage;
  }
  throw new TypeError('Unsupported Agent Port message type.');
}

function validateAgentTurnEvent(value: unknown): asserts value is BgsmAgentTurnEvent {
  if (!isAgentRecord(value)) throw new TypeError('Agent event must be an object.');
  validateAgentDeliveryIdentity(value);
  const base = ['type', 'turnAttemptId', 'sessionId', 'baseRevision'];
  let keys: string[];
  switch (value.type) {
    case 'agent_queued':
    case 'agent_start':
      keys = base;
      break;
    case 'conversation_bound':
      keys = [...base, 'binding'];
      validateBgsmAgentConversationBinding(value.binding);
      break;
    case 'turn_start':
    case 'assistant_stream_start':
      keys = [...base, 'step'];
      assertAgentSequenceNumber(value.step, 'step');
      break;
    case 'assistant_text_delta':
      keys = [...base, 'step', 'delta'];
      assertAgentSequenceNumber(value.step, 'step');
      assertAgentText(value.delta, 'delta', 256 * 1024, false);
      break;
    case 'message_update':
      keys = [...base, 'message'];
      validateAgentSessionMessage(value.message);
      break;
    case 'tool_execution_queued':
      keys = [...base, 'toolName', 'callId'];
      assertAgentText(value.toolName, 'toolName', 256, true);
      assertAgentText(value.callId, 'callId', 512, true);
      break;
    case 'tool_execution_start':
      keys = [...base, 'toolName', 'callId', 'risk'];
      assertAgentText(value.toolName, 'toolName', 256, true);
      assertAgentText(value.callId, 'callId', 512, true);
      validateToolRisk(value.risk);
      break;
    case 'tool_execution_end':
      keys = [...base, 'toolName', 'callId', 'risk', 'ok', 'writeOutcome'];
      assertAgentText(value.toolName, 'toolName', 256, true);
      assertAgentText(value.callId, 'callId', 512, true);
      validateToolRisk(value.risk);
      if (typeof value.ok !== 'boolean') throw new TypeError('Agent tool result is invalid.');
      if (!['not_applicable', 'committed', 'failed', 'unknown'].includes(String(value.writeOutcome))) {
        throw new TypeError('Agent tool write outcome is invalid.');
      }
      if ((value.risk === 'write') === (value.writeOutcome === 'not_applicable')) {
        throw new TypeError('Agent tool write outcome does not match its risk.');
      }
      break;
    case 'approval_required':
      keys = [...base, 'callId', 'summary'];
      assertAgentText(value.callId, 'callId', 512, true);
      assertAgentText(value.summary, 'summary', 4_096, true);
      break;
    case 'context_compaction_start':
      keys = base;
      break;
    case 'context_diagnostic':
      keys = [
        ...base,
        'stage',
        'providerWindow',
        'workingWindow',
        'softLimit',
        'hardLimit',
        'capabilitySource',
        'capabilityRevision',
        'policyRevision',
        ...(value.inputTokens === undefined ? [] : ['inputTokens']),
        ...(value.deterministicInputTokens === undefined ? [] : ['deterministicInputTokens']),
        ...(value.usageAdjustmentTokens === undefined ? [] : ['usageAdjustmentTokens']),
        ...(value.observedPrefixTokens === undefined ? [] : ['observedPrefixTokens']),
        ...(value.contextRemainingTokens === undefined ? [] : ['contextRemainingTokens']),
        ...(value.toolAllowanceBytes === undefined ? [] : ['toolAllowanceBytes']),
        ...(value.toolMemoryRemainingBytes === undefined ? [] : ['toolMemoryRemainingBytes']),
        ...(value.toolProviderResultCeilingBytes === undefined
          ? []
          : ['toolProviderResultCeilingBytes']),
        ...(value.toolBudgetLimitedBy === undefined ? [] : ['toolBudgetLimitedBy']),
        ...(value.toolResultBytes === undefined ? [] : ['toolResultBytes']),
        ...(value.toolResultReduced === undefined ? [] : ['toolResultReduced']),
        ...(value.action === undefined ? [] : ['action']),
        ...(value.trigger === undefined ? [] : ['trigger']),
        ...(value.category === undefined ? [] : ['category']),
      ];
      if (!['preflight', 'tool_allowance', 'post_tool', 'compaction'].includes(String(value.stage))) {
        throw new TypeError('Agent context diagnostic stage is invalid.');
      }
      for (const field of ['providerWindow', 'workingWindow', 'softLimit', 'hardLimit'] as const) {
        assertAgentSequenceNumber(value[field], field);
      }
      if (!['builtin-official', 'provider-verified', 'user-declared'].includes(String(value.capabilitySource))) {
        throw new TypeError('Agent context capability source is invalid.');
      }
      assertAgentText(value.capabilityRevision, 'capabilityRevision', 512, true);
      assertAgentText(value.policyRevision, 'policyRevision', 1_024, true);
      for (const field of [
        'inputTokens',
        'deterministicInputTokens',
        'usageAdjustmentTokens',
        'contextRemainingTokens',
        'toolAllowanceBytes',
        'toolMemoryRemainingBytes',
        'toolProviderResultCeilingBytes',
        'toolResultBytes',
      ] as const) {
        if (value[field] !== undefined) assertAgentSequenceNumber(value[field], field);
      }
      if (value.observedPrefixTokens !== undefined && value.observedPrefixTokens !== null) {
        assertAgentSequenceNumber(value.observedPrefixTokens, 'observedPrefixTokens');
      }
      if (value.toolBudgetLimitedBy !== undefined &&
        !['context', 'memory', 'provider', 'multiple'].includes(String(value.toolBudgetLimitedBy))) {
        throw new TypeError('Agent tool budget limiting factor is invalid.');
      }
      if (value.toolResultReduced !== undefined && typeof value.toolResultReduced !== 'boolean') {
        throw new TypeError('Agent tool result reduction flag is invalid.');
      }
      if (value.action !== undefined &&
        !['triggered', 'summary_retry', 'fallback', 'terminal'].includes(String(value.action))) {
        throw new TypeError('Agent context diagnostic action is invalid.');
      }
      if (value.trigger !== undefined && ![
        'pre_turn_soft_limit',
        'pre_turn_byte_limit',
        'completed_tool_envelope_soft_limit',
        'completed_tool_envelope_byte_limit',
        'forced_completed_tool_envelope',
        'provider_context_overflow',
        'provider_request_byte_limit',
      ].includes(String(value.trigger))) {
        throw new TypeError('Agent compaction trigger is invalid.');
      }
      if (value.category !== undefined && ![
        'succeeded',
        'current_turn_too_large',
        'no_candidate',
        'summary_provider_failed',
        'summary_invalid',
        'fallback_too_large',
        'final_preflight_failed',
        'capability_unresolved',
        'provider_context_overflow',
        'provider_context_overflow_repeated',
        'provider_request_byte_limit',
        'provider_request_byte_limit_repeated',
      ].includes(String(value.category))) {
        throw new TypeError('Agent context diagnostic category is invalid.');
      }
      break;
    case 'context_compaction_end':
      keys = [...base, 'ok', 'summarizedMessageCount'];
      if (typeof value.ok !== 'boolean') throw new TypeError('Agent compaction result is invalid.');
      assertAgentSequenceNumber(value.summarizedMessageCount, 'summarizedMessageCount');
      break;
    case 'agent_error':
      keys = [...base, 'message', ...(value.category === undefined ? [] : ['category'])];
      assertAgentText(value.message, 'message', 4_096, true);
      validateAgentErrorCategory(value.category);
      break;
    case 'agent_done':
      keys = [
        ...base,
        'reason',
        ...(value.contextFailureReason === undefined ? [] : ['contextFailureReason']),
      ];
      validateAgentStopReason(value.reason);
      if (value.contextFailureReason !== undefined) {
        validateAgentContextFailureReason(value.contextFailureReason);
      }
      break;
    default:
      throw new TypeError('Unsupported Agent event type.');
  }
  assertAgentExactKeys(value, keys);
}

function validateAgentTurnResult(value: unknown): asserts value is BgsmAgentTurnResult {
  if (!isAgentRecord(value)) throw new TypeError('Agent result must be an object.');
  validateAgentDeliveryIdentity(value);
  const keys = [
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'reason',
    'changed',
    'changedCount',
    'newMessages',
    ...(value.candidateCheckpoint === undefined ? [] : ['candidateCheckpoint']),
    ...(value.candidateActiveProjection === undefined ? [] : ['candidateActiveProjection']),
    ...(value.contextFailureReason === undefined ? [] : ['contextFailureReason']),
  ];
  assertAgentExactKeys(value, keys);
  validateAgentStopReason(value.reason);
  if (value.contextFailureReason !== undefined) {
    validateAgentContextFailureReason(value.contextFailureReason);
  }
  if (typeof value.changed !== 'boolean') throw new TypeError('Agent changed flag is invalid.');
  assertAgentSequenceNumber(value.changedCount, 'changedCount');
  if ((Number(value.changedCount) > 0) !== value.changed) {
    throw new TypeError('Agent changed count does not match its changed flag.');
  }
  if (!Array.isArray(value.newMessages)) throw new TypeError('Agent result messages are invalid.');
  value.newMessages.forEach(validateAgentSessionMessage);
  if (value.candidateCheckpoint !== undefined) {
    validateAgentCheckpoint(value.candidateCheckpoint);
  }
  if (value.candidateActiveProjection !== undefined && value.candidateActiveProjection !== null) {
    validateAgentActiveProjection(value.candidateActiveProjection);
  }
}

function validateAgentTurnError(value: unknown): asserts value is BgsmAgentTurnError {
  if (!isAgentRecord(value)) throw new TypeError('Agent error must be an object.');
  validateAgentDeliveryIdentity(value);
  assertAgentExactKeys(value, [
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'message',
    ...(value.category === undefined ? [] : ['category']),
  ]);
  assertAgentText(value.message, 'message', 4_096, true);
  validateAgentErrorCategory(value.category);
}

function validateAgentDeliveryIdentity(value: Record<string, unknown>): void {
  assertAgentText(value.turnAttemptId, 'turnAttemptId', 512, true);
  assertAgentText(value.sessionId, 'sessionId', 512, true);
  assertAgentSequenceNumber(value.baseRevision, 'baseRevision');
}

function validateAgentSessionMessage(value: unknown): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent session message must be an object.');
  const baseKeys = ['id', 'role', 'content', 'createdAt'];
  assertAgentText(value.id, 'message.id', 512, true);
  assertAgentText(value.content, 'message.content', 512 * 1024, false);
  if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) {
    throw new TypeError('Agent session message timestamp is invalid.');
  }
  if (value.role === 'user') {
    assertAgentExactKeys(value, baseKeys);
    return;
  }
  if (value.role === 'agent') {
    const keys = value.toolCalls === undefined ? baseKeys : [...baseKeys, 'toolCalls'];
    assertAgentExactKeys(value, keys);
    if (value.toolCalls !== undefined) {
      if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0 || value.toolCalls.length > 64) {
        throw new TypeError('Agent message tool calls are invalid.');
      }
      value.toolCalls.forEach(validateAgentToolCall);
    }
    return;
  }
  if (value.role === 'tool') {
    assertAgentExactKeys(value, [...baseKeys, 'toolCallId', 'toolName']);
    assertAgentText(value.toolCallId, 'message.toolCallId', 512, true);
    assertAgentText(value.toolName, 'message.toolName', 256, true);
    return;
  }
  throw new TypeError('Agent session message role is invalid.');
}

function validateAgentToolCall(value: unknown): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent tool call must be an object.');
  assertAgentExactKeys(value, ['id', 'name', 'arguments']);
  assertAgentText(value.id, 'toolCall.id', 512, true);
  assertAgentText(value.name, 'toolCall.name', 256, true);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value.arguments);
  } catch {
    throw new TypeError('Agent tool call arguments are not serializable.');
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 256 * 1024) {
    throw new RangeError('Agent tool call arguments are too large.');
  }
}

function validateAgentCheckpoint(value: unknown): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent checkpoint must be an object.');
  assertAgentExactKeys(value, [
    'schemaVersion',
    'summary',
    'summarizedMessageCount',
    'summarizedThroughMessageId',
  ]);
  if (value.schemaVersion !== 1) throw new TypeError('Agent checkpoint version is invalid.');
  assertAgentText(value.summary, 'checkpoint.summary', 64 * 1024, true);
  if (!Number.isSafeInteger(value.summarizedMessageCount) || Number(value.summarizedMessageCount) <= 0) {
    throw new TypeError('Agent checkpoint message count is invalid.');
  }
  assertAgentText(value.summarizedThroughMessageId, 'checkpoint.cursor', 512, true);
}

function validateAgentActiveProjection(value: unknown): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent active projection must be an object.');
  assertAgentExactKeys(value, [
    'schemaVersion',
    'currentUserMessageId',
    'summarizedThroughMessageId',
    'retainedSuffixFirstMessageId',
    'rawMessageCountAtCreation',
    'rawTailMessageIdAtCreation',
    'capabilityRevision',
    'policyRevision',
    'summary',
  ]);
  if (value.schemaVersion !== 1) throw new TypeError('Agent active projection version is invalid.');
  assertAgentText(value.currentUserMessageId, 'active projection user cursor', 512, true);
  assertAgentText(value.summarizedThroughMessageId, 'active projection summary cursor', 512, true);
  if (value.retainedSuffixFirstMessageId !== null) {
    assertAgentText(value.retainedSuffixFirstMessageId, 'active projection suffix cursor', 512, true);
  }
  if (!Number.isSafeInteger(value.rawMessageCountAtCreation) || Number(value.rawMessageCountAtCreation) <= 0) {
    throw new TypeError('Agent active projection raw message count is invalid.');
  }
  assertAgentText(value.rawTailMessageIdAtCreation, 'active projection raw tail cursor', 512, true);
  assertAgentText(value.capabilityRevision, 'active projection capability revision', 512, true);
  assertAgentText(value.policyRevision, 'active projection policy revision', 512, true);
  assertAgentText(value.summary, 'active projection summary', 64 * 1024, true);
}

function validateAgentErrorCategory(value: unknown): void {
  if (value === undefined) return;
  if (!['authentication', 'configuration', 'permission', 'disclosure', 'capability', 'provider', 'other'].includes(String(value))) {
    throw new TypeError('Agent error category is invalid.');
  }
}

function validateToolRisk(value: unknown): asserts value is ToolRisk {
  if (!['read', 'suggest', 'write'].includes(String(value))) {
    throw new TypeError('Agent tool risk is invalid.');
  }
}

function validateAgentStopReason(value: unknown): void {
  if (!['final_answer', 'approval_required', 'interaction_required', 'protocol_error', 'step_budget_reached', 'context_limit', 'provider_error', 'attempt_state_lost', 'aborted'].includes(String(value))) {
    throw new TypeError('Agent stop reason is invalid.');
  }
}

function validateAgentContextFailureReason(
  value: unknown,
): asserts value is AgentContextFailureReason {
  if (![
    'capability_unresolved',
    'current_turn_too_large',
    'no_candidate',
    'summary_provider_failed',
    'summary_invalid',
    'fallback_too_large',
    'final_preflight_failed',
    'provider_context_overflow',
    'provider_context_overflow_repeated',
    'provider_request_byte_limit',
    'provider_request_byte_limit_repeated',
  ].includes(String(value))) {
    throw new TypeError('Agent context failure reason is invalid.');
  }
}

function assertAgentText(
  value: unknown,
  field: string,
  maxBytes: number,
  requireNonempty: boolean,
): void {
  if (typeof value !== 'string' || (requireNonempty && value.length === 0)) {
    throw new TypeError(`Agent ${field} is invalid.`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`Agent ${field} is too large.`);
  }
}

function assertAgentSequenceNumber(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`Agent ${field} is invalid.`);
  }
}

function assertAgentExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError('Agent Port message has unexpected fields.');
  }
}

function isAgentRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  };
  merged.seenOnboarding = stageMarksOnboardingSeen(merged.onboardingStage);
  return merged;
}

export class BackgroundCallError extends Error {
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'BackgroundCallError';
    this.details = details;
  }
}

export async function bgCall<T = unknown>(type: string, extra?: Record<string, unknown>): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ type, ...extra })) as
    | { ok: true; data?: T }
    | { ok: false; error: string; details?: unknown };
  if (!res.ok) throw new BackgroundCallError(res.error, res.details);
  return (res.data ?? (undefined as unknown)) as T;
}

export function onProgress(cb: (p: SyncStatus['progress']) => void): () => void {
  const listener = (msg: { type?: string; progress?: SyncStatus['progress'] }) => {
    if (msg.type === 'progress' && msg.progress) cb(msg.progress);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
