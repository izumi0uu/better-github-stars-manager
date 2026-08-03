import {
  canDegradeAnalyzerFailure,
  OrganizeProposalAnalyzer,
  shouldSplitAnalyzerFailure,
  type AnalyzerRunResult,
  type PreparedAnalyzerAttempt,
  type SemanticAnalyzerBatch,
} from '@/bgsm-agent/organize-proposal-analyzer';
import {
  buildSemanticAnalyzerBatch,
  createOrganizeProposal,
  createOrganizeJobRunAnalysisState,
  finalizeAnalysisFailure,
  finalizeInsufficientEvidenceBatch,
  finalizeAnalyzerBatch,
  finalizeLocalOnlyBatch,
  resumeOrganizeJobRunAnalysisState,
  reserveRunProviderAttempt,
  scheduleBgsmOrganizeJob,
  splitPendingAnalyzerBatch,
  type OrganizeJobRunAnalysisState,
  type OrganizeJobRunPagePosition,
} from '@/bgsm-agent/organize-job';
import type { OrganizeProposal } from '@/bgsm-agent/proposal';
import type { ProposalId, RunId } from '@/bgsm-agent/identity';
import type { SemanticTaxonomyDto } from '@/bgsm-agent/semantic-dto';
import type { TaxonomyFingerprintV1 } from '@/bgsm-agent/proposal';
import type { BudgetExhaustionReason } from '@/bgsm-agent/policy';
import type { RunBudgetUsage } from '@/bgsm-agent/policy';
import { FROZEN_SCOPE_PAGE_DEFAULT } from '@/bgsm-agent/policy';
import type { ContinuationCursorToken } from '@/bgsm-agent/scope';
import { createOrganizeJobRunCoverageSummary } from '@/bgsm-agent/events';
import type { BgsmAgentController, OrganizeRunIdentity } from './organize-job-controller';

type Analyzer = Pick<OrganizeProposalAnalyzer, 'requestedOutputTokens' | 'analyzeWithSingleRetry'>
  & Partial<Pick<OrganizeProposalAnalyzer, 'requestedOutputTokensForRepositoryCount'>>
  & Readonly<{ providerBinding?: unknown }>;
type ContinuationSeed = Readonly<{
  state: OrganizeJobRunAnalysisState;
  analyzer?: Analyzer;
}>;
const ORGANIZE_JOB_HEARTBEAT_INTERVAL_MS = 20_000;

export type SchedulerPage = Readonly<{
  positions: readonly OrganizeJobRunPagePosition[];
  taxonomy: SemanticTaxonomyDto;
  policyTaxonomy: SemanticTaxonomyDto;
  taxonomyFingerprint: TaxonomyFingerprintV1;
}>;

export interface BgsmOrganizeJobScheduler {
  schedule(identity: OrganizeRunIdentity): Promise<void>;
  continueRun(
    parentIdentity: OrganizeRunIdentity,
    nextFrozenIndex: number,
    continuationCursor: ContinuationCursorToken,
  ): Promise<ReturnType<BgsmAgentController['continueRun']>>;
  abort(runId: RunId): void;
  release(runId: RunId): void;
  getState(runId: RunId): OrganizeJobRunAnalysisState | null;
  seedRestoredState(runId: RunId, state: OrganizeJobRunAnalysisState): void;
  isRunning(runId: RunId): boolean;
}

export type SchedulerAnalysisPageLease = Readonly<{
  leaseToken: string;
  jobId?: string;
  revision: number;
}>;

export type BgsmOrganizeJobSchedulerTraceEvent =
  | Readonly<{
      type: 'batch_state';
      identity: OrganizeRunIdentity;
      batchStart: number;
      batchEnd: number;
      repositoryCount: number;
      localOnlyCount: number;
      providerCount: number;
      state: 'scheduled' | 'loaded' | 'split' | 'local_only_completed' | 'provider_completed' | 'analysis_failed' | 'budget_exhausted' | 'cancelled';
    }>
  | Readonly<{
      type: 'provider_attempt';
      identity: OrganizeRunIdentity;
      batchStart: number;
      batchEnd: number;
      attempt: 1 | 2;
      state: 'prepared' | 'admitted' | 'succeeded' | 'failed' | 'budget_exhausted' | 'cancelled';
      requestBytes: number;
      requestedOutputTokens: number;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      reasonCode: string | null;
    }>
  | Readonly<{
      type: 'watchdog_state';
      identity: OrganizeRunIdentity;
      watchdog: 'organize_heartbeat' | 'organize_wall_deadline';
      state: 'armed' | 'progress' | 'expired' | 'cancelled';
      limitMs: number;
    }>;

export function createBgsmOrganizeJobScheduler(dependencies: Readonly<{
  controller: Pick<
    BgsmAgentController,
    | 'setRunState'
    | 'getExecutionContext'
    | 'updateUsage'
    | 'updateAnalysisProgress'
    | 'blockAnalysis'
    | 'registerDurableProposal'
    | 'completeWithoutProposal'
    | 'exhaustBudget'
    | 'failRun'
    | 'continueRun'
  >;
  createAnalyzer(identity: OrganizeRunIdentity): Promise<Analyzer>;
  loadPage(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    startFrozenIndex: number;
    endFrozenIndexExclusive: number;
  }>): Promise<SchedulerPage>;
  initializeDurableRun?(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    continuation: boolean;
    parentIdentity: OrganizeRunIdentity | null;
    providerBinding: unknown;
  }>): Promise<void>;
  validateDurableProviderBinding?(input: Readonly<{
    identity: OrganizeRunIdentity;
    providerBinding: unknown;
  }>): Promise<void>;
  reserveDurablePage?(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    previousUsage: RunBudgetUsage;
    startFrozenIndex: number;
    endFrozenIndexExclusive: number;
  }>): Promise<SchedulerAnalysisPageLease | null | undefined>;
  reserveDurableProviderAttempt?(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    previousUsage: RunBudgetUsage;
    attempt: PreparedAnalyzerAttempt;
    reservedAt: number;
    lease: SchedulerAnalysisPageLease;
  }>): Promise<SchedulerAnalysisPageLease>;
  releaseDurablePage?(input: Readonly<{
    identity: OrganizeRunIdentity;
    lease: SchedulerAnalysisPageLease;
  }>): Promise<void>;
  checkpointDurablePage?(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    positions: readonly OrganizeJobRunPagePosition[];
    lease: SchedulerAnalysisPageLease;
  }>): Promise<void>;
  splitDurablePage?(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    lease: SchedulerAnalysisPageLease;
  }>): Promise<void>;
  registerDurableReview?(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    proposal: OrganizeProposal;
  }>): Promise<boolean>;
  completeDurableWithoutProposal?(input: Readonly<{
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
  }>): Promise<void>;
  issueContinuationCursor(identity: OrganizeRunIdentity, nextFrozenIndex: number): Promise<ContinuationCursorToken>;
  createProposalId(): ProposalId;
  publishSnapshot?(
    snapshot: ReturnType<BgsmAgentController['continueRun']>,
    parent?: OrganizeRunIdentity,
  ): void;
  publishAnalysisProgress?(identity: OrganizeRunIdentity, processed: number, total: number): void;
  automaticContinuationFailed?(identity: OrganizeRunIdentity, error: unknown): void | Promise<void>;
  providerSetupFailed?(identity: OrganizeRunIdentity, error: unknown): void | Promise<void>;
  executionFailed?(identity: OrganizeRunIdentity, error: unknown): void | Promise<void>;
  requestedWindowSize?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  heartbeat?(identity: OrganizeRunIdentity): void;
  setHeartbeatInterval?: (callback: () => void, delay: number) => unknown;
  clearHeartbeatInterval?: (timer: unknown) => void;
  trace?(event: BgsmOrganizeJobSchedulerTraceEvent): void;
}>): BgsmOrganizeJobScheduler {
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer = dependencies.clearTimer ?? ((timer: unknown) => clearTimeout(timer as number));
  const setHeartbeatInterval = dependencies.setHeartbeatInterval
    ?? ((callback: () => void, delay: number) => setInterval(callback, delay));
  const clearHeartbeatInterval = dependencies.clearHeartbeatInterval
    ?? ((timer: unknown) => clearInterval(timer as number));
  const states = new Map<RunId, OrganizeJobRunAnalysisState>();
  const abortControllers = new Map<RunId, AbortController>();
  const executions = new Map<RunId, Promise<void>>();
  const executionTokens = new Map<RunId, object>();
  const continuationSeeds = new Map<RunId, ContinuationSeed>();
  const continuationPreparations = new Map<
    RunId,
    Promise<ReturnType<BgsmAgentController['continueRun']>>
  >();
  const restoredSeeds = new Map<RunId, OrganizeJobRunAnalysisState>();
  const settledRunIds = new Set<RunId>();
  const maxRetainedSettledRuns = 128;
  let scheduleRun!: (identity: OrganizeRunIdentity) => Promise<void>;
  const trace = (event: BgsmOrganizeJobSchedulerTraceEvent): void => {
    try {
      dependencies.trace?.(event);
    } catch {
      // Development observation cannot alter scheduling or durable admission.
    }
  };

  const rememberSettledRun = (runId: RunId): void => {
    settledRunIds.delete(runId);
    settledRunIds.add(runId);
    while (settledRunIds.size > maxRetainedSettledRuns) {
      const oldest = settledRunIds.values().next().value as RunId | undefined;
      if (!oldest) break;
      settledRunIds.delete(oldest);
      states.delete(oldest);
    }
  };

  const reportAutomaticContinuationFailure = (
    identity: OrganizeRunIdentity,
    error: unknown,
  ): void => {
    try {
      const reporting = dependencies.automaticContinuationFailed?.(identity, error);
      void Promise.resolve(reporting).catch(() => {});
    } catch {
      // Failure observation cannot alter the authoritative run state.
    }
  };

  const reportExecutionFailure = async (
    identity: OrganizeRunIdentity,
    error: unknown,
  ): Promise<void> => {
    try {
      await dependencies.executionFailed?.(identity, error);
    } catch {
      // Failure observation cannot create another unhandled rejection.
    }
  };

  const exhaustAndMaybeContinue = async (
    identity: OrganizeRunIdentity,
    state: OrganizeJobRunAnalysisState,
    reason: BudgetExhaustionReason,
    analyzer: Analyzer,
  ): Promise<void> => {
    try {
      const cursor = await dependencies.issueContinuationCursor(identity, state.nextFrozenIndex);
      dependencies.controller.exhaustBudget(identity, state.usage, reason, cursor);
      const generationStart = dependencies.controller.getExecutionContext(identity).startFrozenIndex;
      if (state.nextFrozenIndex <= generationStart) return;
      await prepareContinuation(identity, state, state.nextFrozenIndex, cursor, analyzer);
    } catch (error) {
      dependencies.controller.failRun(identity, 'internal_error');
      reportAutomaticContinuationFailure(identity, error);
    }
  };

  const prepareContinuation = async (
    parentIdentity: OrganizeRunIdentity,
    parentState: OrganizeJobRunAnalysisState,
    nextFrozenIndex: number,
    continuationCursor: ContinuationCursorToken,
    analyzer?: Analyzer,
  ): Promise<ReturnType<BgsmAgentController['continueRun']>> => {
    const child = dependencies.controller.continueRun(
      parentIdentity,
      nextFrozenIndex,
      continuationCursor,
    );
    const existing = continuationPreparations.get(child.runId);
    if (existing) return existing;

    const preparation = (async () => {
      const identity: OrganizeRunIdentity = {
        controllerId: child.controllerId,
        sessionId: child.sessionId,
        runId: child.runId,
        generation: child.generation,
      };
      const context = dependencies.controller.getExecutionContext(identity);
      const state = resumeOrganizeJobRunAnalysisState({
        previous: parentState,
        runId: identity.runId,
        generation: identity.generation,
        proposalId: dependencies.createProposalId(),
        budget: context.budget,
      });
      if (state.nextFrozenIndex !== context.startFrozenIndex) {
        throw new TypeError('Continuation analysis state does not match the authoritative start index.');
      }
      if (dependencies.initializeDurableRun) {
        await dependencies.initializeDurableRun({
          identity,
          state,
          continuation: true,
          parentIdentity,
          providerBinding: analyzer?.providerBinding ?? null,
        });
      }
      states.set(identity.runId, state);
      continuationSeeds.set(identity.runId, Object.freeze({ state, analyzer }));
      dependencies.publishSnapshot?.(child, parentIdentity);
      void scheduleRun(identity).catch((error: unknown) => {
        void reportExecutionFailure(identity, error);
      });
      return child;
    })().finally(() => {
      continuationPreparations.delete(child.runId);
    });
    continuationPreparations.set(child.runId, preparation);
    return preparation;
  };

  const execute = async (identity: OrganizeRunIdentity): Promise<void> => {
    const abortController = new AbortController();
    abortControllers.set(identity.runId, abortController);
    let providerReady = false;
    let activeAnalyzer: Analyzer | null = null;
    let deadlineTimer: unknown | null = null;
    let heartbeatTimer: unknown | null = null;
    let deadlineExpired = false;
    let deadlineTraceState: 'idle' | 'armed' | 'expired' | 'cancelled' = 'idle';
    let deadlineLimitMs: number | null = null;
    let activeDurableLease: SchedulerAnalysisPageLease | null = null;
    const traceWatchdog = (
      watchdog: 'organize_heartbeat' | 'organize_wall_deadline',
      state: 'armed' | 'progress' | 'expired' | 'cancelled',
      limitMs: number,
    ): void => {
      trace({ type: 'watchdog_state', identity, watchdog, state, limitMs });
    };
    const recordWallDeadlineExpired = (limitMs: number): void => {
      if (deadlineTraceState === 'expired' || deadlineTraceState === 'cancelled') return;
      deadlineTraceState = 'expired';
      deadlineLimitMs = limitMs;
      deadlineExpired = true;
      traceWatchdog('organize_wall_deadline', 'expired', limitMs);
    };
    const expireWallDeadline = (limitMs: number): void => {
      recordWallDeadlineExpired(limitMs);
      abortController.abort();
    };
    const releaseActiveDurablePage = async (): Promise<void> => {
      if (!activeDurableLease || !dependencies.releaseDurablePage) return;
      const lease = activeDurableLease;
      await dependencies.releaseDurablePage({ identity, lease });
      if (activeDurableLease === lease) activeDurableLease = null;
    };

    try {
      if (dependencies.heartbeat) {
        traceWatchdog('organize_heartbeat', 'armed', ORGANIZE_JOB_HEARTBEAT_INTERVAL_MS);
        heartbeatTimer = setHeartbeatInterval(() => {
          traceWatchdog('organize_heartbeat', 'progress', ORGANIZE_JOB_HEARTBEAT_INTERVAL_MS);
          try {
            dependencies.heartbeat?.(identity);
          } catch {
            // Keepalive is best-effort and must not change run authority.
          }
        }, ORGANIZE_JOB_HEARTBEAT_INTERVAL_MS);
      }
      dependencies.controller.setRunState(identity, 'checking_provider');
      const continuationSeed = continuationSeeds.get(identity.runId);
      continuationSeeds.delete(identity.runId);
      const restoredSeed = restoredSeeds.get(identity.runId);
      restoredSeeds.delete(identity.runId);
      const analyzer = continuationSeed?.analyzer ?? await dependencies.createAnalyzer(identity);
      activeAnalyzer = analyzer;
      if (dependencies.validateDurableProviderBinding) {
        await dependencies.validateDurableProviderBinding({
          identity,
          providerBinding: analyzer.providerBinding ?? null,
        });
      }
      providerReady = true;
      if (abortController.signal.aborted) return;
      const context = dependencies.controller.getExecutionContext(identity);
      if (continuationSeed && continuationSeed.state.nextFrozenIndex !== context.startFrozenIndex) {
        throw new TypeError('Continuation analysis seed does not match the authoritative start index.');
      }
      let state = restoredSeed ?? continuationSeed?.state
        ?? createOrganizeJobRunAnalysisState({
            runId: identity.runId,
            generation: identity.generation,
            proposalId: dependencies.createProposalId(),
            frozenScope: context.frozenScope,
            budget: context.budget,
            startFrozenIndex: context.startFrozenIndex,
          });
      states.set(identity.runId, state);
      if (!restoredSeed && !continuationSeed && dependencies.initializeDurableRun) {
        await dependencies.initializeDurableRun({
          identity,
          state,
          continuation: !!continuationSeed,
          parentIdentity: null,
          providerBinding: analyzer.providerBinding ?? null,
        });
      }
      dependencies.controller.setRunState(identity, 'analyzing');

      while (!abortController.signal.aborted) {
        const pendingRange = state.analysisPendingRanges[0];
        const estimatedPageSize = pendingRange
          ? pendingRange.endFrozenIndexExclusive - pendingRange.startFrozenIndex
          : Math.min(
              dependencies.requestedWindowSize ?? FROZEN_SCOPE_PAGE_DEFAULT,
              state.frozenScope.count - state.nextFrozenIndex,
            );
        const nextAttemptRequestedOutputTokens = estimatedPageSize > 0
          ? analyzer.requestedOutputTokensForRepositoryCount?.(estimatedPageSize)
            ?? analyzer.requestedOutputTokens
          : analyzer.requestedOutputTokens;
        const decision = scheduleBgsmOrganizeJob({
          state,
          now: now(),
          requestedWindowSize: dependencies.requestedWindowSize,
          nextAttemptRequestedOutputTokens,
        });
        if (decision.status === 'budget_exhausted') {
          state = decision.state;
          states.set(identity.runId, state);
          if (decision.reason === 'wall_deadline') {
            recordWallDeadlineExpired(state.budget.wallDeadlineMs);
          }
          await exhaustAndMaybeContinue(identity, state, decision.reason, analyzer);
          return;
        }
        if (decision.status === 'review') {
          state = decision.state;
          states.set(identity.runId, state);
          dependencies.controller.updateAnalysisProgress(
            identity,
            state.usage,
            coverageFor(state),
          );
          if (state.actionableProposalRows.length === 0) {
            if (dependencies.completeDurableWithoutProposal) {
              await dependencies.completeDurableWithoutProposal({ identity, state });
            }
            dependencies.controller.completeWithoutProposal(identity, state.usage);
          } else {
            dependencies.controller.updateUsage(identity, state.usage);
            const cursor = state.stopReason === 'proposal_limit'
              ? await dependencies.issueContinuationCursor(identity, state.nextFrozenIndex)
              : undefined;
            const proposal = createOrganizeProposal(state);
            const handled = dependencies.registerDurableReview
              ? await dependencies.registerDurableReview({ identity, state, proposal })
              : false;
            if (!handled) dependencies.controller.registerDurableProposal(identity, proposal, cursor);
          }
          return;
        }
        if (decision.status === 'stopped') {
          if (state.status === 'analysis_blocked') {
            const failed = state.nonActionableAnalysisOutcomes.find(
              (row) => row.kind === 'analysis_failed',
            );
            if (!failed) throw new TypeError('Blocked analysis is missing its failed position.');
            const cursor = await dependencies.issueContinuationCursor(identity, failed.frozenIndex);
            const blocked = dependencies.controller.blockAnalysis(
              identity,
              state.usage,
              coverageFor(state),
              cursor,
            );
            dependencies.publishSnapshot?.(blocked);
          }
          return;
        }

        const previousUsage = state.usage;
        trace({
          type: 'batch_state',
          identity,
          batchStart: decision.batch.startFrozenIndex,
          batchEnd: decision.batch.endFrozenIndexExclusive,
          repositoryCount: decision.batch.endFrozenIndexExclusive - decision.batch.startFrozenIndex,
          localOnlyCount: 0,
          providerCount: 0,
          state: 'scheduled',
        });
        state = decision.batch.state;
        states.set(identity.runId, state);
        dependencies.controller.updateAnalysisProgress(
          identity,
          state.usage,
          coverageFor(state),
        );
        let durableLease = dependencies.reserveDurablePage
          ? await dependencies.reserveDurablePage({
              identity,
              state,
              previousUsage,
              startFrozenIndex: decision.batch.startFrozenIndex,
              endFrozenIndexExclusive: decision.batch.endFrozenIndexExclusive,
            })
          : undefined;
        if (durableLease === null) return;
        activeDurableLease = durableLease ?? null;
        const page = await dependencies.loadPage({
          identity,
          state,
          startFrozenIndex: decision.batch.startFrozenIndex,
          endFrozenIndexExclusive: decision.batch.endFrozenIndexExclusive,
        });
        if (abortController.signal.aborted) {
          trace({
            type: 'batch_state',
            identity,
            batchStart: decision.batch.startFrozenIndex,
            batchEnd: decision.batch.endFrozenIndexExclusive,
            repositoryCount: page.positions.length,
            localOnlyCount: 0,
            providerCount: 0,
            state: deadlineExpired ? 'budget_exhausted' : 'cancelled',
          });
          if (deadlineExpired) {
            await releaseActiveDurablePage();
            await exhaustAndMaybeContinue(identity, state, 'wall_deadline', analyzer);
          }
          return;
        }
        const batch = buildSemanticAnalyzerBatch({
          state,
          taskInstruction: context.taskInstruction,
          positions: page.positions,
          taxonomy: page.taxonomy,
        });
        const providerCount = batch?.repositories.length ?? 0;
        trace({
          type: 'batch_state',
          identity,
          batchStart: decision.batch.startFrozenIndex,
          batchEnd: decision.batch.endFrozenIndexExclusive,
          repositoryCount: page.positions.length,
          localOnlyCount: page.positions.length - providerCount,
          providerCount,
          state: 'loaded',
        });
        if (!batch) {
          state = finalizeLocalOnlyBatch(state, page.positions).state;
          trace({
            type: 'batch_state',
            identity,
            batchStart: decision.batch.startFrozenIndex,
            batchEnd: decision.batch.endFrozenIndexExclusive,
            repositoryCount: page.positions.length,
            localOnlyCount: page.positions.length,
            providerCount: 0,
            state: 'local_only_completed',
          });
        } else {
          const analyzedBeforeBatch = coverageFor(state).analyzed;
          const localOnlyCount = page.positions.length - batch.repositories.length;
          const result = await runAnalyzer({
            analyzer,
            batch,
            getState: () => state,
            setState(next) {
              state = next;
              states.set(identity.runId, state);
              dependencies.controller.updateUsage(identity, state.usage);
            },
            now,
            signal: abortController.signal,
            onProgress: (completedRows) => {
              try {
                dependencies.publishAnalysisProgress?.(
                  identity,
                  Math.min(
                    state.frozenScope.count,
                    analyzedBeforeBatch + localOnlyCount + completedRows,
                  ),
                  state.frozenScope.count,
                );
              } catch {
                // Presentation progress cannot alter Provider execution or durable checkpoints.
              }
            },
            traceAttempt: (attempt) => trace({
              type: 'provider_attempt',
              identity,
              batchStart: decision.batch.startFrozenIndex,
              batchEnd: decision.batch.endFrozenIndexExclusive,
              ...attempt,
            }),
            reserveDurableAttempt: durableLease && dependencies.reserveDurableProviderAttempt
              ? async ({ state: next, previousUsage: before, attempt, reservedAt }) => {
                  const renewed = await dependencies.reserveDurableProviderAttempt!({
                    identity,
                    state: next,
                    previousUsage: before,
                    attempt,
                    reservedAt,
                    lease: durableLease!,
                  });
                  durableLease = renewed;
                  activeDurableLease = renewed;
                }
              : undefined,
            armDeadline(deadlineAt, limitMs) {
              if (deadlineTimer !== null) return;
              deadlineTraceState = 'armed';
              deadlineLimitMs = limitMs;
              traceWatchdog('organize_wall_deadline', 'armed', limitMs);
              deadlineTimer = setTimer(() => {
                expireWallDeadline(limitMs);
              }, Math.max(0, deadlineAt - now()));
            },
          });
          if (abortController.signal.aborted) {
            trace({
              type: 'batch_state',
              identity,
              batchStart: decision.batch.startFrozenIndex,
              batchEnd: decision.batch.endFrozenIndexExclusive,
              repositoryCount: page.positions.length,
              localOnlyCount: page.positions.length - batch.repositories.length,
              providerCount: batch.repositories.length,
              state: deadlineExpired ? 'budget_exhausted' : 'cancelled',
            });
            if (deadlineExpired) {
              await releaseActiveDurablePage();
              await exhaustAndMaybeContinue(identity, state, 'wall_deadline', analyzer);
            }
            return;
          }
          if (result.status === 'budget_exhausted') {
            if (result.reason === 'wall_deadline') {
              recordWallDeadlineExpired(state.budget.wallDeadlineMs);
            }
            trace({
              type: 'batch_state',
              identity,
              batchStart: decision.batch.startFrozenIndex,
              batchEnd: decision.batch.endFrozenIndexExclusive,
              repositoryCount: page.positions.length,
              localOnlyCount: page.positions.length - batch.repositories.length,
              providerCount: batch.repositories.length,
              state: 'budget_exhausted',
            });
            await releaseActiveDurablePage();
            await exhaustAndMaybeContinue(identity, state, result.reason, analyzer);
            return;
          }
          if (
            result.status === 'analysis_failed'
            && batch.repositories.length > 1
            && shouldSplitAnalyzerFailure(result)
          ) {
            const split = splitPendingAnalyzerBatch(state);
            if (durableLease) {
              if (!dependencies.splitDurablePage) {
                throw new TypeError('Durable analyzer batch splitting is not configured.');
              }
              await dependencies.splitDurablePage({
                identity,
                state: split.state,
                lease: durableLease,
              });
              activeDurableLease = null;
            }
            state = split.state;
            states.set(identity.runId, state);
            trace({
              type: 'batch_state',
              identity,
              batchStart: decision.batch.startFrozenIndex,
              batchEnd: decision.batch.endFrozenIndexExclusive,
              repositoryCount: page.positions.length,
              localOnlyCount: page.positions.length - batch.repositories.length,
              providerCount: batch.repositories.length,
              state: 'split',
            });
            dependencies.controller.updateUsage(identity, state.usage);
            continue;
          }
          const degraded = result.status === 'analysis_failed'
            && canDegradeAnalyzerFailure(result);
          state = result.status === 'success'
            ? finalizeAnalyzerBatch({
                state,
                positions: page.positions,
                proposal: result.value.proposal,
                taxonomy: page.policyTaxonomy,
                taxonomyFingerprint: page.taxonomyFingerprint,
              }).state
            : degraded
              ? finalizeInsufficientEvidenceBatch(state, page.positions).state
              : finalizeAnalysisFailure(state, page.positions).state;
          trace({
            type: 'batch_state',
            identity,
            batchStart: decision.batch.startFrozenIndex,
            batchEnd: decision.batch.endFrozenIndexExclusive,
            repositoryCount: page.positions.length,
            localOnlyCount: page.positions.length - batch.repositories.length,
            providerCount: batch.repositories.length,
            state: result.status === 'success' || degraded ? 'provider_completed' : 'analysis_failed',
          });
        }
        states.set(identity.runId, state);
        if (durableLease && dependencies.checkpointDurablePage) {
          await dependencies.checkpointDurablePage({
            identity,
            state,
            positions: page.positions,
            lease: durableLease,
          });
          activeDurableLease = null;
        }
        dependencies.controller.updateUsage(identity, state.usage);
      }
    } catch (error) {
      const state = states.get(identity.runId);
      if (deadlineExpired && state && activeAnalyzer) {
        await releaseActiveDurablePage();
        await exhaustAndMaybeContinue(identity, state, 'wall_deadline', activeAnalyzer);
      }
      else if (!abortController.signal.aborted) {
        try {
          if (providerReady) await dependencies.executionFailed?.(identity, error);
          else await dependencies.providerSetupFailed?.(identity, error);
        } catch {
          // Failure compensation cannot replace the authoritative run failure.
        }
        dependencies.controller.failRun(identity, providerReady ? 'internal_error' : 'provider_error');
      }
    } finally {
      if (activeDurableLease && dependencies.releaseDurablePage) {
        try {
          await releaseActiveDurablePage();
        } catch {
          // The original failure remains authoritative; expired leases are recovered on restore.
        }
      }
      if (deadlineTimer !== null) clearTimer(deadlineTimer);
      if (!deadlineExpired && deadlineLimitMs !== null) {
        deadlineTraceState = 'cancelled';
        traceWatchdog('organize_wall_deadline', 'cancelled', deadlineLimitMs);
      }
      if (heartbeatTimer !== null) {
        clearHeartbeatInterval(heartbeatTimer);
        traceWatchdog('organize_heartbeat', 'cancelled', ORGANIZE_JOB_HEARTBEAT_INTERVAL_MS);
      }
      if (abortControllers.get(identity.runId) === abortController) abortControllers.delete(identity.runId);
    }
  };

  scheduleRun = (identity) => {
    if (settledRunIds.has(identity.runId)) return Promise.resolve();
    const existing = executions.get(identity.runId);
    if (existing) return existing;
    const token = {};
    executionTokens.set(identity.runId, token);
    const execution = execute(identity).finally(() => {
      if (executionTokens.get(identity.runId) !== token) return;
      executionTokens.delete(identity.runId);
      executions.delete(identity.runId);
      rememberSettledRun(identity.runId);
    });
    executions.set(identity.runId, execution);
    return execution;
  };

  return {
    schedule: scheduleRun,
    continueRun(parentIdentity, nextFrozenIndex, continuationCursor) {
      const parentState = states.get(parentIdentity.runId);
      if (!parentState) {
        return Promise.reject(new TypeError('Continuation analysis state is unavailable.'));
      }
      return prepareContinuation(
        parentIdentity,
        parentState,
        nextFrozenIndex,
        continuationCursor,
      );
    },
    abort(runId) {
      abortControllers.get(runId)?.abort();
    },
    release(runId) {
      abortControllers.get(runId)?.abort();
      abortControllers.delete(runId);
      executionTokens.delete(runId);
      states.delete(runId);
      continuationSeeds.delete(runId);
      continuationPreparations.delete(runId);
      restoredSeeds.delete(runId);
      executions.delete(runId);
      settledRunIds.delete(runId);
    },
    getState(runId) {
      return states.get(runId) ?? null;
    },
    seedRestoredState(runId, state) {
      restoredSeeds.set(runId, state);
      states.set(runId, state);
      settledRunIds.delete(runId);
    },
    isRunning(runId) {
      return executions.has(runId);
    },
  };
}

function coverageFor(state: OrganizeJobRunAnalysisState) {
  return createOrganizeJobRunCoverageSummary({
    total: state.frozenScope.count,
    analyzedFrozenPositions: state.analyzedFrozenPositions,
    nonActionableAnalysisOutcomes: state.nonActionableAnalysisOutcomes,
    actionableProposalRows: state.actionableProposalRows,
  });
}

async function runAnalyzer(input: Readonly<{
  analyzer: Analyzer;
  batch: SemanticAnalyzerBatch;
  getState(): OrganizeJobRunAnalysisState;
  setState(state: OrganizeJobRunAnalysisState): void;
  now(): number;
  signal: AbortSignal;
  onProgress?(completedRows: number): void;
  reserveDurableAttempt?(input: Readonly<{
    state: OrganizeJobRunAnalysisState;
    previousUsage: RunBudgetUsage;
    attempt: PreparedAnalyzerAttempt;
    reservedAt: number;
  }>): Promise<void>;
  traceAttempt?(input: Readonly<{
    attempt: 1 | 2;
    state: 'prepared' | 'admitted' | 'succeeded' | 'failed' | 'budget_exhausted' | 'cancelled';
    requestBytes: number;
    requestedOutputTokens: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    reasonCode: string | null;
  }>): void;
  armDeadline(deadlineAt: number, limitMs: number): void;
}>): Promise<AnalyzerRunResult> {
  const attempts = new Map<1 | 2, PreparedAnalyzerAttempt>();
  const terminalAttempts = new Set<1 | 2>();
  const record = (
    attempt: PreparedAnalyzerAttempt,
    state: 'prepared' | 'admitted' | 'succeeded' | 'failed' | 'budget_exhausted' | 'cancelled',
    telemetry: Readonly<{ inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }> | null,
    reasonCode: string | null,
  ): void => {
    if (terminalAttempts.has(attempt.attempt) && state !== 'prepared' && state !== 'admitted') return;
    if (['succeeded', 'failed', 'budget_exhausted', 'cancelled'].includes(state)) {
      terminalAttempts.add(attempt.attempt);
    }
    input.traceAttempt?.({
      attempt: attempt.attempt,
      state,
      requestBytes: attempt.serializedRequestBytes,
      requestedOutputTokens: attempt.requestedOutputTokens,
      inputTokens: telemetry?.inputTokens ?? null,
      outputTokens: telemetry?.outputTokens ?? null,
      totalTokens: telemetry?.totalTokens ?? null,
      reasonCode,
    });
  };

  try {
    const result = await input.analyzer.analyzeWithSingleRetry(input.batch, (attempt: PreparedAnalyzerAttempt) => {
      const first = attempts.get(1);
      if (attempt.attempt === 2 && first && !terminalAttempts.has(1)) {
        record(first, 'failed', null, 'invalid_or_failed');
      }
      attempts.set(attempt.attempt, attempt);
      record(attempt, 'prepared', null, null);
      const previousState = input.getState();
      const reservedAt = input.now();
      const reservation = reserveRunProviderAttempt({
        state: previousState,
        attempt,
        now: reservedAt,
      });
      if (reservation.status === 'budget_exhausted') {
        input.setState(reservation.state);
        record(attempt, 'budget_exhausted', null, reservation.reason);
        return { status: 'budget_exhausted', reason: reservation.reason };
      }
      const admit = () => {
        input.setState(reservation.state);
        const startedAt = reservation.state.usage.firstAnalyzerRequestAt;
        if (startedAt !== null) {
          input.armDeadline(
            startedAt + reservation.state.budget.wallDeadlineMs,
            reservation.state.budget.wallDeadlineMs,
          );
        }
        record(attempt, 'admitted', null, null);
        return { status: 'admitted' as const, signal: input.signal };
      };
      const durable = input.reserveDurableAttempt?.({
        state: reservation.state,
        previousUsage: previousState.usage,
        attempt,
        reservedAt,
      });
      return durable ? durable.then(admit) : admit();
    }, input.onProgress);
    if (result.status === 'success') {
      const attempt = attempts.get(result.attempts);
      if (attempt) record(attempt, 'succeeded', result.value.telemetry, null);
    } else if (result.status === 'analysis_failed') {
      const executedAttempts = result.attempts;
      const attempt = executedAttempts === 0 ? undefined : attempts.get(executedAttempts);
      if (attempt) record(attempt, 'failed', null, 'invalid_or_failed');
    }
    return result;
  } catch (error) {
    const attempt = attempts.get(2) ?? attempts.get(1);
    if (attempt && !terminalAttempts.has(attempt.attempt)) {
      record(attempt, input.signal.aborted ? 'cancelled' : 'failed', null, input.signal.aborted ? 'aborted' : 'attempt_failed');
    }
    throw error;
  }
}
