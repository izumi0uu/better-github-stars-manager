import {
  createEmptyRunBudgetUsage,
  validateRunBudget,
  validateRunBudgetUsage,
  type BudgetExhaustionReason,
  type RunBudget,
  type RunBudgetUsage,
} from './policy';
import {
  validateAnalyzerBatchProposal,
  validateRowUniverses,
  type ActionableProposalRow,
  type AnalyzedFrozenPosition,
  type AnalyzerBatchProposal,
  type OrganizeProposal,
  type NonActionableAnalysisOutcome,
  type ProposalAction,
  type ProposalReviewProjection,
  type TaxonomyFingerprintV1,
} from './proposal';
import { isProposalId, isRunId, type ProposalId, type RunId } from './identity';
import {
  validateFrozenScope,
  type FrozenScope,
} from './scope';
import type {
  PreparedAnalyzerAttempt,
  SemanticAnalyzerBatch,
} from './organize-proposal-analyzer';
import type {
  SemanticRepositoryDto,
  SemanticTaxonomyDto,
} from './semantic-dto';
import {
  consumeFrozenPositions,
  reserveAnalyzerBatch,
  reserveProviderAttempt,
} from './run-budget';

export type OrganizeJobRunAnalysisStatus =
  | 'analyzing'
  | 'review'
  | 'budget_exhausted'
  | 'analysis_blocked'
  | 'stopped';

export type OrganizeJobRunAnalysisRange = Readonly<{
  startFrozenIndex: number;
  endFrozenIndexExclusive: number;
  depth: number;
}>;

export type OrganizeJobRunAnalysisState = Readonly<{
  runId: RunId;
  generation: number;
  proposalId: ProposalId;
  frozenScope: FrozenScope;
  budget: RunBudget;
  usage: RunBudgetUsage;
  startFrozenIndex: number;
  nextFrozenIndex: number;
  pendingBatchEndFrozenIndex: number | null;
  analysisPendingRanges: readonly OrganizeJobRunAnalysisRange[];
  status: OrganizeJobRunAnalysisStatus;
  stopReason: BudgetExhaustionReason | 'proposal_limit' | 'scope_complete' | 'analysis_failed' | 'user_stopped' | null;
  analyzedFrozenPositions: readonly AnalyzedFrozenPosition[];
  nonActionableAnalysisOutcomes: readonly NonActionableAnalysisOutcome[];
  actionableProposalRows: readonly ActionableProposalRow[];
}>;

export type OrganizeJobRunPagePosition =
  | Readonly<{
      frozenIndex: number;
      repositoryId: string;
      kind: 'missing' | 'tombstoned';
    }>
  | Readonly<{
      frozenIndex: number;
      repositoryId: string;
      kind: 'live';
      repository: SemanticRepositoryDto;
    }>;

export type PlannedOrganizeJobRunBatch = Readonly<{
  state: OrganizeJobRunAnalysisState;
  startFrozenIndex: number;
  endFrozenIndexExclusive: number;
}>;

export type OrganizeJobRunScheduleDecision =
  | Readonly<{ status: 'batch'; batch: PlannedOrganizeJobRunBatch }>
  | Readonly<{
      status: 'budget_exhausted';
      state: OrganizeJobRunAnalysisState;
      reason: BudgetExhaustionReason;
      nextFrozenIndex: number;
    }>
  | Readonly<{ status: 'review'; state: OrganizeJobRunAnalysisState }>
  | Readonly<{ status: 'stopped'; state: OrganizeJobRunAnalysisState }>;

export type ProviderReservationForRun =
  | Readonly<{ status: 'reserved'; state: OrganizeJobRunAnalysisState }>
  | Readonly<{
      status: 'budget_exhausted';
      state: OrganizeJobRunAnalysisState;
      reason: BudgetExhaustionReason;
      nextFrozenIndex: number;
    }>;

export type FinalizedBatch = Readonly<{
  state: OrganizeJobRunAnalysisState;
  continuationRequired: boolean;
  nextFrozenIndex: number;
}>;

export function restoreOrganizeJobRunAnalysisState(input: Readonly<{
  runId: RunId;
  generation: number;
  proposalId: ProposalId;
  frozenScope: FrozenScope;
  budget: RunBudget;
  usage: RunBudgetUsage;
  startFrozenIndex?: number;
  nextFrozenIndex: number;
  analysisPendingRanges?: readonly OrganizeJobRunAnalysisRange[];
  status: 'analyzing' | 'analysis_blocked' | 'review';
  analyzedFrozenPositions: readonly AnalyzedFrozenPosition[];
  nonActionableAnalysisOutcomes: readonly NonActionableAnalysisOutcome[];
  actionableProposalRows: readonly ActionableProposalRow[];
}>): OrganizeJobRunAnalysisState {
  const base = createOrganizeJobRunAnalysisState({
    runId: input.runId,
    generation: input.generation,
    proposalId: input.proposalId,
    frozenScope: input.frozenScope,
    budget: input.budget,
    startFrozenIndex: input.startFrozenIndex ?? 0,
  });
  validateRunBudgetUsage(input.usage);
  assertNonnegativeSafeInteger(input.nextFrozenIndex, 'Restored OrganizeJobRun nextFrozenIndex');
  if (input.nextFrozenIndex > input.frozenScope.count) {
    throw new RangeError('Restored OrganizeJobRun cursor exceeds its FrozenScope.');
  }
  const restored = freezeState({
    ...base,
    usage: input.usage,
    nextFrozenIndex: input.nextFrozenIndex,
    pendingBatchEndFrozenIndex: null,
    analysisPendingRanges: input.analysisPendingRanges ?? [],
    status: input.status,
    stopReason: input.status === 'review'
      ? 'scope_complete'
      : input.status === 'analysis_blocked'
        ? 'analysis_failed'
        : null,
    analyzedFrozenPositions: input.analyzedFrozenPositions,
    nonActionableAnalysisOutcomes: input.nonActionableAnalysisOutcomes,
    actionableProposalRows: input.actionableProposalRows,
  });
  validateAnalysisUniverses(restored);
  if (restored.status === 'review') assertReviewReady(restored);
  if (restored.status === 'analysis_blocked' && !hasAnalysisFailures(restored)) {
    throw new TypeError('Restored blocked analysis requires a failed row.');
  }
  return restored;
}

export function createOrganizeJobRunAnalysisState(input: Readonly<{
  runId: RunId;
  generation: number;
  proposalId: ProposalId;
  frozenScope: FrozenScope;
  budget: RunBudget;
  startFrozenIndex?: number;
}>): OrganizeJobRunAnalysisState {
  if (!isRunId(input.runId)) throw new TypeError('OrganizeJobRun runId is malformed.');
  if (!isProposalId(input.proposalId)) throw new TypeError('OrganizeJobRun proposalId is malformed.');
  assertNonnegativeSafeInteger(input.generation, 'OrganizeJobRun generation');
  validateFrozenScope(input.frozenScope);
  validateRunBudget(input.budget);
  const startFrozenIndex = input.startFrozenIndex ?? 0;
  assertNonnegativeSafeInteger(startFrozenIndex, 'OrganizeJobRun startFrozenIndex');
  if (startFrozenIndex > input.frozenScope.count) {
    throw new RangeError('OrganizeJobRun startFrozenIndex exceeds FrozenScope count.');
  }
  return freezeState({
    runId: input.runId,
    generation: input.generation,
    proposalId: input.proposalId,
    frozenScope: input.frozenScope,
    budget: input.budget,
    usage: createEmptyRunBudgetUsage(),
    startFrozenIndex,
    nextFrozenIndex: startFrozenIndex,
    pendingBatchEndFrozenIndex: null,
    analysisPendingRanges: [],
    status: input.frozenScope.count === 0 ? 'review' : 'analyzing',
    stopReason: input.frozenScope.count === 0 ? 'scope_complete' : null,
    analyzedFrozenPositions: [],
    nonActionableAnalysisOutcomes: [],
    actionableProposalRows: [],
  });
}

export function resumeOrganizeJobRunAnalysisState(input: Readonly<{
  previous: OrganizeJobRunAnalysisState;
  runId: RunId;
  generation: number;
  proposalId: ProposalId;
  budget: RunBudget;
}>): OrganizeJobRunAnalysisState {
  if (
    input.previous.status !== 'budget_exhausted' &&
    input.previous.status !== 'analysis_blocked'
  ) {
    throw new TypeError('Only a budget-exhausted or analysis-blocked run can seed a continuation generation.');
  }
  const base = createOrganizeJobRunAnalysisState({
    runId: input.runId,
    generation: input.generation,
    proposalId: input.proposalId,
    frozenScope: input.previous.frozenScope,
    budget: input.budget,
    startFrozenIndex: input.previous.startFrozenIndex,
  });
  const retryFrozenIndex = input.previous.status === 'analysis_blocked'
    ? firstAnalysisFailureIndex(input.previous)
    : null;
  const nextFrozenIndex = retryFrozenIndex ?? input.previous.nextFrozenIndex;
  const completedScope =
    retryFrozenIndex === null &&
    hasCompleteFrozenScopeCoverage(input.previous) &&
    !hasAnalysisFailures(input.previous);
  const resumed = freezeState({
    ...base,
    nextFrozenIndex,
    analysisPendingRanges: retryFrozenIndex === null
      ? input.previous.analysisPendingRanges
      : [],
    status: completedScope ? 'review' : 'analyzing',
    stopReason: completedScope ? 'scope_complete' : null,
    analyzedFrozenPositions: input.previous.analyzedFrozenPositions.filter(
      (row) => row.frozenIndex < nextFrozenIndex,
    ),
    nonActionableAnalysisOutcomes: input.previous.nonActionableAnalysisOutcomes.filter(
      (row) => row.frozenIndex < nextFrozenIndex,
    ),
    actionableProposalRows: input.previous.actionableProposalRows.filter(
      (row) => row.frozenIndex < nextFrozenIndex,
    ).map((row) => Object.freeze({
      ...row,
      proposalRowId: `${input.proposalId}:row:${row.frozenIndex}`,
    })),
  });
  validateAnalysisUniverses(resumed);
  return resumed;
}

export function retryBlockedOrganizeJobRunAnalysis(
  state: OrganizeJobRunAnalysisState,
): OrganizeJobRunAnalysisState {
  if (state.status !== 'analysis_blocked') {
    throw new TypeError('Only an analysis-blocked run can retry its failed suffix.');
  }
  const nextFrozenIndex = firstAnalysisFailureIndex(state);
  const retried = freezeState({
    ...state,
    nextFrozenIndex,
    pendingBatchEndFrozenIndex: null,
    status: 'analyzing',
    stopReason: null,
    analyzedFrozenPositions: state.analyzedFrozenPositions.filter(
      (row) => row.frozenIndex < nextFrozenIndex,
    ),
    nonActionableAnalysisOutcomes: state.nonActionableAnalysisOutcomes.filter(
      (row) => row.frozenIndex < nextFrozenIndex,
    ),
    actionableProposalRows: state.actionableProposalRows.filter(
      (row) => row.frozenIndex < nextFrozenIndex,
    ),
  });
  validateAnalysisUniverses(retried);
  return retried;
}

export function planNextBatch(input: Readonly<{
  state: OrganizeJobRunAnalysisState;
  now: number;
  requestedWindowSize?: number;
  nextAttemptRequestedOutputTokens: number;
}>): OrganizeJobRunScheduleDecision {
  const { state } = input;
  if (state.status === 'budget_exhausted') {
    return budgetDecision(state, state.stopReason as BudgetExhaustionReason);
  }
  if (state.status === 'review') return Object.freeze({ status: 'review', state });
  if (state.status === 'analysis_blocked') {
    return Object.freeze({ status: 'stopped', state });
  }
  if (state.status === 'stopped') return Object.freeze({ status: 'stopped', state });
  if (state.pendingBatchEndFrozenIndex !== null) {
    throw new TypeError('OrganizeJobRun cannot schedule another page before the admitted page is finalized.');
  }
  const pendingRange = state.analysisPendingRanges[0];
  const requestedWindowSize = pendingRange
    ? pendingRange.endFrozenIndexExclusive - pendingRange.startFrozenIndex
    : input.requestedWindowSize;
  const reservation = reserveAnalyzerBatch({
    budget: state.budget,
    usage: state.usage,
    now: input.now,
    nextFrozenIndex: state.nextFrozenIndex,
    frozenScopeCount: state.frozenScope.count,
    requestedWindowSize,
    nextAttemptRequestedOutputTokens: input.nextAttemptRequestedOutputTokens,
  });
  if (reservation.status === 'complete') {
    return Object.freeze({ status: 'review', state: finishScope(state) });
  }
  if (reservation.status === 'budget_exhausted') {
    const exhausted = exhaustBudget(state, reservation.reason);
    return budgetDecision(exhausted, reservation.reason);
  }
  const endFrozenIndexExclusive = state.nextFrozenIndex + reservation.windowSize;
  const reservedState = freezeState({
    ...state,
    usage: reservation.usage,
    pendingBatchEndFrozenIndex: endFrozenIndexExclusive,
  });
  return Object.freeze({
    status: 'batch',
    batch: Object.freeze({
      state: reservedState,
      startFrozenIndex: state.nextFrozenIndex,
      endFrozenIndexExclusive,
    }),
  });
}

export function scheduleBgsmOrganizeJob(
  input: Parameters<typeof planNextBatch>[0],
): OrganizeJobRunScheduleDecision {
  return planNextBatch(input);
}

export function reserveRunProviderAttempt(input: Readonly<{
  state: OrganizeJobRunAnalysisState;
  attempt: Pick<PreparedAnalyzerAttempt, 'serializedRequestBytes' | 'requestedOutputTokens'>;
  now: number;
}>): ProviderReservationForRun {
  assertAnalyzing(input.state);
  const result = reserveProviderAttempt({
    budget: input.state.budget,
    usage: input.state.usage,
    now: input.now,
    serializedRequestBytes: input.attempt.serializedRequestBytes,
    requestedOutputTokens: input.attempt.requestedOutputTokens,
  });
  if (result.status === 'budget_exhausted') {
    const state = exhaustBudget(input.state, result.reason);
    return budgetDecision(state, result.reason);
  }
  return Object.freeze({
    status: 'reserved',
    state: freezeState({ ...input.state, usage: result.reservation.usage }),
  });
}

export function finalizeLocalOnlyBatch(
  state: OrganizeJobRunAnalysisState,
  positions: readonly OrganizeJobRunPagePosition[],
): FinalizedBatch {
  if (positions.some((position) => position.kind === 'live')) {
    throw new TypeError('A local-only batch cannot contain live analyzer rows.');
  }
  return finalizeClassifications(state, positions, new Map(), null, null);
}

export function finalizeAnalyzerBatch(input: Readonly<{
  state: OrganizeJobRunAnalysisState;
  positions: readonly OrganizeJobRunPagePosition[];
  proposal: AnalyzerBatchProposal;
  taxonomy: SemanticTaxonomyDto;
  taxonomyFingerprint: TaxonomyFingerprintV1;
}>): FinalizedBatch {
  validateAnalyzerBatchProposal(input.proposal);
  validateAnalyzerIdentity(input.state, input.proposal);
  const live = input.positions.filter(
    (position): position is Extract<OrganizeJobRunPagePosition, { kind: 'live' }> =>
      position.kind === 'live',
  );
  if (input.proposal.rows.length !== live.length) {
    throw new TypeError('Analyzer proposal rows must equal the live rows in the immutable page.');
  }
  const rows = new Map(input.proposal.rows.map((row) => [row.frozenIndex, row]));
  for (const position of live) {
    const row = rows.get(position.frozenIndex);
    if (
      !row ||
      row.repositoryId !== position.repositoryId ||
      row.sourceFingerprint !== position.repository.sourceFingerprint
    ) {
      throw new TypeError('Analyzer proposal row does not match its immutable repository DTO.');
    }
  }
  return finalizeClassifications(
    input.state,
    input.positions,
    rows,
    input.taxonomy,
    input.taxonomyFingerprint,
  );
}

export function finalizeAnalysisFailure(
  state: OrganizeJobRunAnalysisState,
  positions: readonly OrganizeJobRunPagePosition[],
): FinalizedBatch {
  const failed = new Map<number, 'analysis_failed'>();
  for (const position of positions) {
    if (position.kind === 'live') failed.set(position.frozenIndex, 'analysis_failed');
  }
  return finalizeClassifications(state, positions, failed, null, null);
}

export function splitPendingAnalyzerBatch(state: OrganizeJobRunAnalysisState): Readonly<{
  state: OrganizeJobRunAnalysisState;
  pendingRanges: readonly OrganizeJobRunAnalysisRange[];
}> {
  assertAnalyzing(state);
  if (state.pendingBatchEndFrozenIndex === null) {
    throw new TypeError('OrganizeJobRun split requires one admitted analyzer page.');
  }
  const pageSize = state.pendingBatchEndFrozenIndex - state.nextFrozenIndex;
  if (pageSize <= 1) throw new TypeError('A singleton analyzer page cannot be split.');
  const currentRange = state.analysisPendingRanges[0];
  if (
    currentRange
    && (
      currentRange.startFrozenIndex !== state.nextFrozenIndex
      || currentRange.endFrozenIndexExclusive !== state.pendingBatchEndFrozenIndex
    )
  ) {
    throw new TypeError('OrganizeJobRun split page does not match its pending analysis range.');
  }
  const depth = (currentRange?.depth ?? 0) + 1;
  const middle = state.nextFrozenIndex + Math.floor(pageSize / 2);
  const pendingRanges = Object.freeze([
    Object.freeze({
      startFrozenIndex: state.nextFrozenIndex,
      endFrozenIndexExclusive: middle,
      depth,
    }),
    Object.freeze({
      startFrozenIndex: middle,
      endFrozenIndexExclusive: state.pendingBatchEndFrozenIndex,
      depth,
    }),
    ...state.analysisPendingRanges.slice(currentRange ? 1 : 0),
  ]);
  const split = freezeState({
    ...state,
    pendingBatchEndFrozenIndex: null,
    analysisPendingRanges: pendingRanges,
  });
  return Object.freeze({ state: split, pendingRanges });
}

export function stopOrganizeJobRunAnalysis(state: OrganizeJobRunAnalysisState): OrganizeJobRunAnalysisState {
  if (state.status !== 'analyzing') return state;
  return freezeState({ ...state, status: 'stopped', stopReason: 'user_stopped' });
}

export function createOrganizeProposal(state: OrganizeJobRunAnalysisState): OrganizeProposal {
  assertReviewReady(state);
  return Object.freeze({
    version: 1,
    proposalId: state.proposalId,
    runId: state.runId,
    generation: state.generation,
    rows: state.actionableProposalRows,
  });
}

export function createProposalReview(state: OrganizeJobRunAnalysisState): ProposalReviewProjection {
  assertReviewReady(state);
  return Object.freeze({
    version: 1,
    proposalId: state.proposalId,
    runId: state.runId,
    generation: state.generation,
    rows: Object.freeze(state.actionableProposalRows.map((row) => Object.freeze({
      proposalRowId: row.proposalRowId,
      frozenIndex: row.frozenIndex,
      repositoryId: row.repositoryId,
      proposedActions: row.actions,
      preselected: true,
    }))),
  });
}

export function buildSemanticAnalyzerBatch(input: Readonly<{
  state: OrganizeJobRunAnalysisState;
  taskInstruction: string;
  positions: readonly OrganizeJobRunPagePosition[];
  taxonomy: SemanticTaxonomyDto;
}>): SemanticAnalyzerBatch | null {
  validatePage(input.state, input.positions);
  const repositories = input.positions
    .filter((position): position is Extract<OrganizeJobRunPagePosition, { kind: 'live' }> =>
      position.kind === 'live')
    .map((position) => position.repository);
  if (repositories.length === 0) return null;
  return Object.freeze({
    version: 1,
    runId: input.state.runId,
    generation: input.state.generation,
    scopeFingerprint: input.state.frozenScope.fingerprint,
    taskInstruction: input.taskInstruction,
    repositories: Object.freeze(repositories),
    taxonomy: input.taxonomy,
  });
}

function finalizeClassifications(
  state: OrganizeJobRunAnalysisState,
  positions: readonly OrganizeJobRunPagePosition[],
  classifications: ReadonlyMap<number, AnalyzerBatchProposal['rows'][number] | 'analysis_failed'>,
  taxonomy: SemanticTaxonomyDto | null,
  taxonomyFingerprint: TaxonomyFingerprintV1 | null,
): FinalizedBatch {
  assertAnalyzing(state);
  validatePage(state, positions);
  const analyzed = [...state.analyzedFrozenPositions];
  const nonActionable = [...state.nonActionableAnalysisOutcomes];
  const actionable = [...state.actionableProposalRows];
  let accepted = 0;

  for (const position of positions) {
    let proposalRow: ActionableProposalRow | null = null;
    let nonActionableKind: NonActionableAnalysisOutcome['kind'] | null = null;
    if (position.kind === 'missing' || position.kind === 'tombstoned') {
      nonActionableKind = position.kind;
    } else {
      const classification = classifications.get(position.frozenIndex);
      if (classification === 'analysis_failed') {
        nonActionableKind = 'analysis_failed';
      } else if (!classification) {
        throw new TypeError('Every live page position requires one analyzer classification.');
      } else {
        const first = classification.classifications[0];
        if (
          classification.classifications.length === 1 &&
          (first?.kind === 'unchanged' || first?.kind === 'insufficient_evidence')
        ) {
          nonActionableKind = first.kind;
        } else {
          if (!taxonomy || !taxonomyFingerprint) {
            throw new TypeError('Actionable analyzer rows require sealed taxonomy state.');
          }
          const actions = classification.classifications.filter(
            (entry): entry is ProposalAction =>
              entry.kind === 'add_existing_tag' || entry.kind === 'propose_new_tag',
          );
          if (actions.length !== classification.classifications.length) {
            throw new TypeError('Non-actionable classifications cannot be mixed with tag actions.');
          }
          if (!taxonomyActionsAdmissible(actions, taxonomy)) {
            // A schema-valid proposal can still collide with taxonomy entries
            // the analyzer cannot see (user-excluded names are stripped from
            // its view). Settle only this row as analysis_failed; a throw here
            // would surface as an unrecoverable whole-run internal_error.
            nonActionableKind = 'analysis_failed';
          } else {
            proposalRow = Object.freeze({
              proposalRowId: `${state.proposalId}:row:${position.frozenIndex}`,
              frozenIndex: position.frozenIndex,
              repositoryId: position.repositoryId,
              sourceFingerprint: classification.sourceFingerprint,
              taxonomyFingerprint,
              actions: Object.freeze(actions),
            });
          }
        }
      }
    }

    if (proposalRow) actionable.push(proposalRow);
    if (nonActionableKind) {
      nonActionable.push(Object.freeze({
        frozenIndex: position.frozenIndex,
        repositoryId: position.repositoryId,
        kind: nonActionableKind,
      }));
    }
    analyzed.push(Object.freeze({
      frozenIndex: position.frozenIndex,
      repositoryId: position.repositoryId,
      classification: proposalRow ? 'actionable' : 'non_actionable',
    }));
    accepted += 1;
  }

  const nextFrozenIndex = state.nextFrozenIndex + accepted;
  const pendingRange = state.analysisPendingRanges[0];
  if (pendingRange && pendingRange.endFrozenIndexExclusive !== nextFrozenIndex) {
    throw new TypeError('Finalized analyzer page does not match its pending analysis range.');
  }
  const completedScope = nextFrozenIndex === state.frozenScope.count;
  const completedCoverage =
    state.startFrozenIndex === 0 &&
    completedScope &&
    analyzed.length === state.frozenScope.count;
  const analysisBlocked = nonActionable.some((row) => row.kind === 'analysis_failed');
  const nextState = freezeState({
    ...state,
    usage: consumeFrozenPositions(state.budget, state.usage, accepted),
    nextFrozenIndex,
    pendingBatchEndFrozenIndex: null,
    analysisPendingRanges: analysisBlocked
      ? []
      : pendingRange
        ? state.analysisPendingRanges.slice(1)
        : [],
    status: analysisBlocked ? 'analysis_blocked' : completedCoverage ? 'review' : 'analyzing',
    stopReason: analysisBlocked
      ? 'analysis_failed'
      : completedCoverage
        ? 'scope_complete'
        : null,
    analyzedFrozenPositions: analyzed,
    nonActionableAnalysisOutcomes: nonActionable,
    actionableProposalRows: actionable,
  });
  validateAnalysisUniverses(nextState);
  return Object.freeze({
    state: nextState,
    continuationRequired: false,
    nextFrozenIndex,
  });
}

function taxonomyActionsAdmissible(
  classifications: readonly ProposalAction[],
  taxonomy: SemanticTaxonomyDto,
): boolean {
  const entries = new Map(taxonomy.entries.map((entry) => [
    entry.name.toLocaleLowerCase('en-US'),
    entry,
  ]));
  for (const classification of classifications) {
    const entry = entries.get(classification.tag.toLocaleLowerCase('en-US'));
    if (classification.kind === 'add_existing_tag') {
      if (!entry?.exists || entry.excluded) return false;
    } else if (entry?.exists) {
      return false;
    }
  }
  return true;
}

function validateAnalyzerIdentity(
  state: OrganizeJobRunAnalysisState,
  proposal: AnalyzerBatchProposal,
): void {
  if (
    proposal.runId !== state.runId ||
    proposal.generation !== state.generation ||
    proposal.scopeFingerprint !== state.frozenScope.fingerprint
  ) {
    throw new TypeError('Analyzer proposal identity is stale or belongs to another run.');
  }
}

function validatePage(
  state: OrganizeJobRunAnalysisState,
  positions: readonly OrganizeJobRunPagePosition[],
): void {
  assertAnalyzing(state);
  if (!Array.isArray(positions) || positions.length === 0 || positions.length > 50) {
    throw new RangeError('OrganizeJobRun page must contain between one and 50 FrozenScope positions.');
  }
  if (
    state.pendingBatchEndFrozenIndex === null ||
    state.nextFrozenIndex + positions.length !== state.pendingBatchEndFrozenIndex
  ) {
    throw new TypeError('OrganizeJobRun page must equal the one admitted immutable window.');
  }
  positions.forEach((position, offset) => {
    const expectedIndex = state.nextFrozenIndex + offset;
    if (
      position.frozenIndex !== expectedIndex ||
      position.repositoryId !== state.frozenScope.repositoryIds[expectedIndex]
    ) {
      throw new TypeError('OrganizeJobRun page must preserve the exact contiguous FrozenScope order.');
    }
    if (
      position.kind === 'live' &&
      (position.repository.frozenIndex !== expectedIndex ||
        position.repository.repositoryId !== position.repositoryId)
    ) {
      throw new TypeError('Semantic repository DTO identity does not match its FrozenScope position.');
    }
  });
}

function validateAnalysisUniverses(state: OrganizeJobRunAnalysisState): void {
  validateRowUniverses({
    consumedRange: {
      startFrozenIndex: state.startFrozenIndex,
      endFrozenIndexExclusive: state.nextFrozenIndex,
    },
    analyzedFrozenPositions: state.analyzedFrozenPositions,
    nonActionableAnalysisOutcomes: state.nonActionableAnalysisOutcomes,
    actionableProposalRows: state.actionableProposalRows,
  });
}

function exhaustBudget(
  state: OrganizeJobRunAnalysisState,
  reason: BudgetExhaustionReason,
): OrganizeJobRunAnalysisState {
  if (state.status === 'budget_exhausted') return state;
  assertAnalyzing(state);
  return freezeState({ ...state, status: 'budget_exhausted', stopReason: reason });
}

function finishScope(state: OrganizeJobRunAnalysisState): OrganizeJobRunAnalysisState {
  if (state.status === 'review') return state;
  assertAnalyzing(state);
  if (hasAnalysisFailures(state)) {
    return freezeState({ ...state, status: 'analysis_blocked', stopReason: 'analysis_failed' });
  }
  if (!hasCompleteFrozenScopeCoverage(state)) {
    throw new TypeError('OrganizeJobRun cannot enter review without complete FrozenScope coverage.');
  }
  return freezeState({ ...state, status: 'review', stopReason: 'scope_complete' });
}

function assertReviewReady(state: OrganizeJobRunAnalysisState): void {
  if (
    state.status !== 'review' ||
    !hasCompleteFrozenScopeCoverage(state) ||
    hasAnalysisFailures(state)
  ) {
    throw new TypeError('OrganizeJobRun review requires complete FrozenScope coverage without analysis failures.');
  }
}

function hasCompleteFrozenScopeCoverage(state: OrganizeJobRunAnalysisState): boolean {
  return (
    state.startFrozenIndex === 0 &&
    state.nextFrozenIndex === state.frozenScope.count &&
    state.analyzedFrozenPositions.length === state.frozenScope.count
  );
}

function hasAnalysisFailures(state: OrganizeJobRunAnalysisState): boolean {
  return state.nonActionableAnalysisOutcomes.some((row) => row.kind === 'analysis_failed');
}

function firstAnalysisFailureIndex(state: OrganizeJobRunAnalysisState): number {
  const first = state.nonActionableAnalysisOutcomes.find((row) => row.kind === 'analysis_failed');
  if (!first) throw new TypeError('Analysis-blocked state requires an analysis_failed outcome.');
  return first.frozenIndex;
}

function budgetDecision(
  state: OrganizeJobRunAnalysisState,
  reason: BudgetExhaustionReason,
): Extract<OrganizeJobRunScheduleDecision, { status: 'budget_exhausted' }> {
  return Object.freeze({
    status: 'budget_exhausted',
    state,
    reason,
    nextFrozenIndex: state.nextFrozenIndex,
  });
}

function assertAnalyzing(state: OrganizeJobRunAnalysisState): void {
  if (state.status !== 'analyzing') {
    throw new TypeError('OrganizeJobRun analysis state is terminal for scheduling.');
  }
}

function freezeState(input: OrganizeJobRunAnalysisState): OrganizeJobRunAnalysisState {
  validateAnalysisSplitState(input);
  return Object.freeze({
    ...input,
    analysisPendingRanges: Object.freeze(input.analysisPendingRanges.map((range) => Object.freeze({ ...range }))),
    analyzedFrozenPositions: Object.freeze([...input.analyzedFrozenPositions]),
    nonActionableAnalysisOutcomes: Object.freeze([...input.nonActionableAnalysisOutcomes]),
    actionableProposalRows: Object.freeze([...input.actionableProposalRows]),
  });
}

function validateAnalysisSplitState(state: OrganizeJobRunAnalysisState): void {
  if (state.analysisPendingRanges.length > 7) {
    throw new RangeError('OrganizeJobRun analysis pending range worklist is too large.');
  }
  let expectedStart = state.nextFrozenIndex;
  let previousDepth = Number.POSITIVE_INFINITY;
  for (const range of state.analysisPendingRanges) {
    if (
      !Number.isSafeInteger(range.startFrozenIndex)
      || !Number.isSafeInteger(range.endFrozenIndexExclusive)
      || !Number.isSafeInteger(range.depth)
      || range.startFrozenIndex !== expectedStart
      || range.endFrozenIndexExclusive <= range.startFrozenIndex
      || range.endFrozenIndexExclusive > state.frozenScope.count
      || range.depth <= 0
      || range.depth > 6
      || range.depth > previousDepth
    ) {
      throw new RangeError('OrganizeJobRun analysis pending range worklist is invalid.');
    }
    expectedStart = range.endFrozenIndexExclusive;
    previousDepth = range.depth;
  }
  const head = state.analysisPendingRanges[0];
  if (
    head
    && state.pendingBatchEndFrozenIndex !== null
    && state.pendingBatchEndFrozenIndex !== head.endFrozenIndexExclusive
  ) {
    throw new RangeError('OrganizeJobRun admitted page does not match its pending analysis range.');
  }
}

function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}
