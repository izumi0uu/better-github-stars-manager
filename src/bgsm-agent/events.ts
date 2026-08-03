import {
  isControllerId,
  isProposalId,
  isRunId,
  type ControllerId,
  type ProposalId,
  type RunId,
} from './identity';
import {
  BUDGET_EXHAUSTION_REASON_PRIORITY,
  validateRunBudget,
  validateRunBudgetUsage,
  type BudgetExhaustionReason,
  type RunBudget,
  type RunBudgetUsage,
} from './policy';
import {
  validateProposalReviewSummary,
  type ActionableProposalRow,
  type AnalyzedFrozenPosition,
  type NonActionableAnalysisOutcome,
  type ProposalReviewSummary,
} from './proposal';
import {
  isContinuationCursorToken,
  validateFrozenScopeProjection,
  type ContinuationCursorToken,
  type FrozenScopeProjection,
} from './scope';

export const ORGANIZE_JOB_STATES = Object.freeze([
  'frozen',
  'prepared',
  'checking_provider',
  'analyzing',
  'analysis_blocked',
  'review',
  'completed',
  'budget_exhausted',
  'cancelled',
  'failed',
  'interrupted',
] as const);
export type OrganizeJobRunState = typeof ORGANIZE_JOB_STATES[number];
export const ACTIVE_NON_APPLY_RUN_STATES = Object.freeze([
  'frozen',
  'prepared',
  'checking_provider',
  'analyzing',
  'analysis_blocked',
  'review',
] as const);
export type ActiveNonApplyRunState = typeof ACTIVE_NON_APPLY_RUN_STATES[number];
export type TerminalRunState = 'completed' | 'cancelled' | 'failed' | 'interrupted';

export const RUN_TERMINAL_REASONS = Object.freeze([
  'completed',
  'no_changes',
  'partial_failure',
  'user_stopped',
  'user_aborted',
  'timeout',
  'provider_error',
  'provider_response_too_large',
  'protocol_error',
  'invalid_state',
  'port_disconnected',
  'worker_lost',
  'internal_error',
] as const);
export type RunTerminalReason = typeof RUN_TERMINAL_REASONS[number];

export type OrganizeJobRunIdentity = Readonly<{
  controllerId: ControllerId;
  sessionId: string;
  runId: RunId;
  generation: number;
}>;

export type OrganizeJobRunEventIdentity = OrganizeJobRunIdentity & Readonly<{
  eventId: string;
}>;

export type OrganizeJobRunCoverageSummary = Readonly<{
  total: number;
  analyzed: number;
  actionable: number;
  unchanged: number;
  insufficientEvidence: number;
  missing: number;
  tombstoned: number;
  analysisFailed: number;
}>;

export type OrganizeJobRunEvent =
  | (OrganizeJobRunEventIdentity & Readonly<{ type: 'run_state_changed'; state: ActiveNonApplyRunState }>)
  | (OrganizeJobRunEventIdentity & Readonly<{
      type: 'run_terminal';
      state: TerminalRunState;
      reason: RunTerminalReason;
    }>)
  | (OrganizeJobRunEventIdentity & Readonly<{
      type: 'budget_usage_changed';
      budget: RunBudget;
      usage: RunBudgetUsage;
    }>)
  | (OrganizeJobRunEventIdentity & Readonly<{
      type: 'budget_exhausted';
      state: 'budget_exhausted';
      reason: BudgetExhaustionReason;
      budget: RunBudget;
      usage: RunBudgetUsage;
      continuationCursor: ContinuationCursorToken;
    }>)
  | (OrganizeJobRunEventIdentity & Readonly<{
      type: 'proposal_summary_ready';
      state: 'review';
      proposalId: ProposalId;
      actionableCount: number;
      nonActionableCount: number;
      proposalReviewSummary: ProposalReviewSummary;
      coverage: OrganizeJobRunCoverageSummary;
    }>);

export type OrganizeJobRunSnapshot = OrganizeJobRunIdentity & Readonly<{
  state: OrganizeJobRunState;
  terminalReason: RunTerminalReason | BudgetExhaustionReason | 'analysis_failed' | null;
  frozenScope: FrozenScopeProjection;
  budget: RunBudget;
  usage: RunBudgetUsage;
  proposalId: ProposalId | null;
  proposalReviewSummary?: ProposalReviewSummary | null;
  continuationCursor: ContinuationCursorToken | null;
  coverage?: OrganizeJobRunCoverageSummary;
}>;

export function createOrganizeJobRunCoverageSummary(input: Readonly<{
  total: number;
  analyzedFrozenPositions: readonly AnalyzedFrozenPosition[];
  nonActionableAnalysisOutcomes: readonly NonActionableAnalysisOutcome[];
  actionableProposalRows: readonly ActionableProposalRow[];
}>): OrganizeJobRunCoverageSummary {
  const counts = {
    unchanged: 0,
    insufficientEvidence: 0,
    missing: 0,
    tombstoned: 0,
    analysisFailed: 0,
  };
  for (const row of input.nonActionableAnalysisOutcomes) {
    if (row.kind === 'unchanged') counts.unchanged += 1;
    else if (row.kind === 'insufficient_evidence') counts.insufficientEvidence += 1;
    else if (row.kind === 'missing') counts.missing += 1;
    else if (row.kind === 'tombstoned') counts.tombstoned += 1;
    else counts.analysisFailed += 1;
  }
  const summary = Object.freeze({
    total: input.total,
    analyzed: input.analyzedFrozenPositions.length,
    actionable: input.actionableProposalRows.length,
    ...counts,
  });
  validateOrganizeJobRunCoverageSummary(summary);
  return summary;
}

export function validateOrganizeJobRunCoverageSummary(
  value: unknown,
): asserts value is OrganizeJobRunCoverageSummary {
  if (!isRecord(value)) throw new TypeError('OrganizeJobRun coverage must be an object.');
  assertExactKeys(value, [
    'total',
    'analyzed',
    'actionable',
    'unchanged',
    'insufficientEvidence',
    'missing',
    'tombstoned',
    'analysisFailed',
  ]);
  for (const field of [
    'total',
    'analyzed',
    'actionable',
    'unchanged',
    'insufficientEvidence',
    'missing',
    'tombstoned',
    'analysisFailed',
  ] as const) {
    assertNonnegativeSafeInteger(value[field], `OrganizeJobRun coverage ${field}`);
  }
  const coverage = value as unknown as OrganizeJobRunCoverageSummary;
  const classified = coverage.actionable + coverage.unchanged + coverage.insufficientEvidence +
    coverage.missing + coverage.tombstoned + coverage.analysisFailed;
  if (classified !== coverage.analyzed || coverage.analyzed > coverage.total) {
    throw new TypeError('OrganizeJobRun coverage categories must exactly partition analyzed rows within total.');
  }
}

export function validateOrganizeJobRunEventIdentity(
  value: unknown,
): asserts value is OrganizeJobRunEventIdentity {
  if (!isRecord(value)) throw new TypeError('OrganizeJobRun event identity must be an object.');
  if (!isControllerId(value.controllerId)) {
    throw new TypeError('OrganizeJobRun event controllerId is malformed.');
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.trim() !== value.sessionId || !value.sessionId) {
    throw new TypeError('OrganizeJobRun event sessionId is malformed.');
  }
  if (!isRunId(value.runId)) throw new TypeError('OrganizeJobRun event runId is malformed.');
  const generation = value.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new TypeError('OrganizeJobRun event generation is malformed.');
  }
  if (typeof value.eventId !== 'string' || value.eventId.trim() !== value.eventId || !value.eventId) {
    throw new TypeError('OrganizeJobRun event eventId is malformed.');
  }
}

export function validateOrganizeJobRunIdentity(value: unknown): asserts value is OrganizeJobRunIdentity {
  if (!isRecord(value)) throw new TypeError('OrganizeJobRun identity must be an object.');
  if (!isControllerId(value.controllerId)) throw new TypeError('OrganizeJobRun controllerId is malformed.');
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.trim() !== value.sessionId) {
    throw new TypeError('OrganizeJobRun sessionId is malformed.');
  }
  if (!isRunId(value.runId)) throw new TypeError('OrganizeJobRun runId is malformed.');
  assertNonnegativeSafeInteger(value.generation, 'OrganizeJobRun generation');
}

export function validateOrganizeJobRunEvent(value: unknown): asserts value is OrganizeJobRunEvent {
  validateOrganizeJobRunEventIdentity(value);
  const event = value as unknown as Record<string, unknown>;
  if (event.type === 'run_state_changed') {
    assertExactKeys(event, eventKeys('state'));
    if (!ACTIVE_NON_APPLY_RUN_STATES.includes(event.state as ActiveNonApplyRunState)) {
      throw new TypeError('Terminal state events require their dedicated reason contract.');
    }
    return;
  }
  if (event.type === 'run_terminal') {
    assertExactKeys(event, eventKeys('state', 'reason'));
    if (!isTerminalStateReason(event.state, event.reason)) {
      throw new TypeError('Run terminal state and reason are inconsistent.');
    }
    return;
  }
  if (event.type === 'budget_usage_changed') {
    assertExactKeys(event, eventKeys('budget', 'usage'));
    validateRunBudget(event.budget);
    validateRunBudgetUsage(event.usage);
    return;
  }
  if (event.type === 'budget_exhausted') {
    assertExactKeys(event, eventKeys('state', 'reason', 'budget', 'usage', 'continuationCursor'));
    if (
      event.state !== 'budget_exhausted' ||
      !BUDGET_EXHAUSTION_REASON_PRIORITY.includes(event.reason as BudgetExhaustionReason) ||
      !isContinuationCursorToken(event.continuationCursor)
    ) {
      throw new TypeError('Budget exhaustion event is malformed.');
    }
    validateRunBudget(event.budget);
    validateRunBudgetUsage(event.usage);
    return;
  }
  if (event.type === 'proposal_summary_ready') {
    assertExactKeys(event, eventKeys(
      'state',
      'proposalId',
      'actionableCount',
      'nonActionableCount',
      'proposalReviewSummary',
      'coverage',
    ));
    if (event.state !== 'review' || !isProposalId(event.proposalId)) {
      throw new TypeError('Proposal-summary-ready event is malformed.');
    }
    assertNonnegativeSafeInteger(event.actionableCount, 'actionableCount');
    assertNonnegativeSafeInteger(event.nonActionableCount, 'nonActionableCount');
    validateProposalReviewSummary(event.proposalReviewSummary);
    validateOrganizeJobRunCoverageSummary(event.coverage);
    if (
      event.proposalReviewSummary.proposalId !== event.proposalId ||
      event.proposalReviewSummary.runId !== event.runId ||
      event.proposalReviewSummary.generation !== event.generation ||
      event.proposalReviewSummary.totalRows !== event.actionableCount ||
      event.coverage.total !== event.coverage.analyzed ||
      event.coverage.analysisFailed !== 0 ||
      event.coverage.actionable !== event.actionableCount ||
      event.coverage.analyzed - event.coverage.actionable !== event.nonActionableCount
    ) {
      throw new TypeError('Proposal summary must match complete failure-free coverage.');
    }
    return;
  }
  throw new TypeError('Unsupported OrganizeJobRun event type.');
}

export function validateOrganizeJobRunSnapshot(value: unknown): asserts value is OrganizeJobRunSnapshot {
  validateOrganizeJobRunIdentity(value);
  const snapshot = value as unknown as Record<string, unknown>;
  assertExactKeys(snapshot, [
    'controllerId',
    'sessionId',
    'runId',
    'generation',
    'state',
    'terminalReason',
    'frozenScope',
    'budget',
    'usage',
    'proposalId',
    ...('proposalReviewSummary' in snapshot ? ['proposalReviewSummary'] : []),
    'continuationCursor',
    ...('coverage' in snapshot ? ['coverage'] : []),
  ]);
  if (!ORGANIZE_JOB_STATES.includes(snapshot.state as OrganizeJobRunState)) {
    throw new TypeError('OrganizeJobRun snapshot state is invalid.');
  }
  if (snapshot.state === 'budget_exhausted') {
    if (!BUDGET_EXHAUSTION_REASON_PRIORITY.includes(snapshot.terminalReason as BudgetExhaustionReason)) {
      throw new TypeError('Budget-exhausted snapshot requires one frozen budget reason.');
    }
  } else if (snapshot.state === 'analysis_blocked') {
    if (snapshot.terminalReason !== 'analysis_failed') {
      throw new TypeError('Analysis-blocked snapshot requires the analysis_failed reason.');
    }
  } else if (['completed', 'cancelled', 'failed', 'interrupted'].includes(snapshot.state as string)) {
    if (!isTerminalStateReason(snapshot.state, snapshot.terminalReason)) {
      throw new TypeError('Terminal snapshot state and reason are inconsistent.');
    }
  } else if (snapshot.terminalReason !== null) {
    throw new TypeError('Nonterminal snapshots cannot carry a terminal reason.');
  }
  validateFrozenScopeProjection(snapshot.frozenScope);
  validateRunBudget(snapshot.budget);
  validateRunBudgetUsage(snapshot.usage);
  if ('coverage' in snapshot) {
    validateOrganizeJobRunCoverageSummary(snapshot.coverage);
    const coverage = snapshot.coverage;
    if (
      coverage.total !== snapshot.frozenScope.count
    ) {
      throw new TypeError('OrganizeJobRun snapshot coverage must match its frozen scope.');
    }
    if (
      snapshot.state === 'review' &&
      (coverage.analyzed !== coverage.total || coverage.analysisFailed !== 0)
    ) {
      throw new TypeError('Review coverage must be complete and failure-free.');
    }
    if (snapshot.state === 'analysis_blocked' && coverage.analysisFailed === 0) {
      throw new TypeError('Analysis-blocked coverage requires at least one analysis failure.');
    }
  }
  if (snapshot.proposalId !== null && !isProposalId(snapshot.proposalId)) {
    throw new TypeError('OrganizeJobRun snapshot proposalId is malformed.');
  }
  if ('proposalReviewSummary' in snapshot && snapshot.proposalReviewSummary !== null) {
    validateProposalReviewSummary(snapshot.proposalReviewSummary);
  }
  const hasReviewAuthority = 'proposalReviewSummary' in snapshot && snapshot.proposalReviewSummary !== null;
  if ((snapshot.proposalId !== null) !== hasReviewAuthority) {
    throw new TypeError(
      'OrganizeJobRun snapshot proposalId is non-null if and only if paged review authority exists.',
    );
  }
  const proposalReviewSummary = snapshot.proposalReviewSummary as ProposalReviewSummary | null | undefined;
  if (
    proposalReviewSummary != null &&
    (
      proposalReviewSummary.proposalId !== snapshot.proposalId ||
      proposalReviewSummary.runId !== snapshot.runId ||
      proposalReviewSummary.generation !== snapshot.generation
    )
  ) {
    throw new TypeError('OrganizeJobRun snapshot review summary identity is inconsistent.');
  }
  if (
    snapshot.state === 'review' &&
    !hasReviewAuthority
  ) {
    throw new TypeError('Review snapshots require review authority.');
  }
  if (
    ['frozen', 'prepared', 'checking_provider', 'analyzing', 'analysis_blocked', 'budget_exhausted']
      .includes(snapshot.state as string) &&
    hasReviewAuthority
  ) {
    throw new TypeError('Pre-review snapshots cannot expose review authority.');
  }
  if (snapshot.continuationCursor !== null && !isContinuationCursorToken(snapshot.continuationCursor)) {
    throw new TypeError('OrganizeJobRun snapshot continuationCursor is malformed.');
  }
  if (snapshot.state === 'budget_exhausted' && snapshot.continuationCursor === null) {
    throw new TypeError('A budget-exhausted snapshot requires a continuation cursor.');
  }
}

function isTerminalStateReason(state: unknown, reason: unknown): boolean {
  if (state === 'completed') {
    return ['completed', 'no_changes', 'partial_failure'].includes(reason as string);
  }
  if (state === 'cancelled') {
    return ['user_stopped', 'user_aborted'].includes(reason as string);
  }
  if (state === 'failed') {
    return [
      'timeout',
      'provider_error',
      'provider_response_too_large',
      'protocol_error',
      'invalid_state',
      'internal_error',
    ].includes(reason as string);
  }
  if (state === 'interrupted') {
    return ['port_disconnected', 'worker_lost'].includes(reason as string);
  }
  return false;
}

function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected contract keys: ${actual.join(', ')}.`);
  }
}

function eventKeys(...extra: string[]): string[] {
  return ['type', 'controllerId', 'sessionId', 'runId', 'generation', 'eventId', ...extra];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
