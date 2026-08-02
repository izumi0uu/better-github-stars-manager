import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  createOrganizeJobRunCoverageSummary,
  validateOrganizeJobRunCoverageSummary,
  type OrganizeJobRunCoverageSummary,
  type OrganizeJobRunEvent,
  type OrganizeJobRunSnapshot,
} from '@/bgsm-agent/events';
import {
  createOrganizeJobId,
  parseRunId,
  type ControllerId,
  type OrganizeJobId,
  type RunId,
} from '@/bgsm-agent/identity';
import {
  createEmptyRunBudgetUsage,
  createProductionRunBudget,
  isMonotonicRunBudgetUsage,
  validateRunBudgetUsage,
  type RunBudget,
  type RunBudgetUsage,
  type BudgetExhaustionReason,
} from '@/bgsm-agent/policy';
import {
  validateOrganizeProposal,
  type OrganizeProposal,
  type ProposalReviewSummary,
} from '@/bgsm-agent/proposal';
import type { OrganizeJobRunAnalysisState } from '@/bgsm-agent/organize-job';
import {
  createFrozenScope,
  projectFrozenScope,
  parsePreflightToken,
  parseScopeFingerprintV1,
  type FrozenScope,
  type FrozenScopeKind,
  type PreflightToken,
  type ContinuationCursorToken,
} from '@/bgsm-agent/scope';
import type { ResolvedLaunchCandidate } from './query';

export type OrganizeJobRunControllerIdentity = Readonly<{
  controllerId: ControllerId;
  sessionId: string;
}>;

export type OrganizeRunIdentity = OrganizeJobRunControllerIdentity & Readonly<{
  runId: RunId;
  generation: number;
}>;

export type OrganizeJobRunPreflightResult = Readonly<{
  status: 'ready' | 'no_work';
  jobId: OrganizeJobId;
  preflightToken: PreflightToken | null;
  label: string;
  count: number;
}>;

export type OrganizeJobRunReadyPreflight = Readonly<{
  requestId: string;
  preflightToken: PreflightToken;
  label: string;
  count: number;
}>;

export interface BgsmAgentControllerDependencies {
  resolveCandidate(): Promise<ResolvedLaunchCandidate>;
  scheduleRun?(identity: OrganizeRunIdentity): void | Promise<void>;
  emit?(event: OrganizeJobRunEvent): void;
  onLifecycle?(name: 'preflight_issued' | 'token_consumed_frozen_and_budgeted'): void;
  onPreflightState?(event: Readonly<{
    jobId: OrganizeJobId;
    state: 'ready' | 'no_work' | 'started' | 'cancelled' | 'expired' | 'stale' | 'disconnected';
    repositoryCount: number;
  }>): void;
  preflightTtlMs?: number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
  randomId?: () => string;
  eventEpoch?: string;
}

type PreflightRecord = Readonly<{
  token: PreflightToken;
  requestId: string;
  jobId: OrganizeJobId;
  controllerId: ControllerId;
  sessionId: string;
  candidate: ResolvedLaunchCandidate;
  scopeFingerprint: Awaited<ReturnType<typeof parseScopeFingerprintV1>>;
  capturedAt: number;
  expiresAt: number;
}>;

type PreflightAuthority = Readonly<{
  requestId: string;
  jobId: OrganizeJobId;
}>;

type RunRecord = {
  jobId: OrganizeJobId;
  identity: OrganizeRunIdentity;
  frozenScope: FrozenScope;
  budget: RunBudget;
  taskInstruction: string;
  startFrozenIndex: number;
  state: OrganizeJobRunSnapshot['state'];
  terminalReason: OrganizeJobRunSnapshot['terminalReason'];
  usage: RunBudgetUsage;
  coverage: OrganizeJobRunCoverageSummary;
  proposalReviewSummary: ProposalReviewSummary | null;
  continuationCursor: OrganizeJobRunSnapshot['continuationCursor'];
};

type OrganizeJobRunEventWithoutId = OrganizeJobRunEvent extends infer Event
  ? Event extends { eventId: string }
    ? Omit<Event, 'eventId'>
    : never
  : never;

export interface BgsmAgentController {
  issuePreflight(
    identity: OrganizeJobRunControllerIdentity,
    options?: Readonly<{ requestId?: string; jobId?: OrganizeJobId }>,
  ): Promise<OrganizeJobRunPreflightResult>;
  getPreflightContext(
    identity: OrganizeJobRunControllerIdentity,
    preflightToken: PreflightToken,
  ): Readonly<{
    jobId: OrganizeJobId;
    scopeKind: FrozenScopeKind;
    frozenScope: FrozenScope;
    expiresAt: number;
  }>;
  acknowledgePreflightStarted(
    identity: OrganizeJobRunControllerIdentity,
    preflightToken: PreflightToken,
  ): boolean;
  cancelPreflight(identity: OrganizeJobRunControllerIdentity, requestId: string): boolean;
  findReadyPreflight(identity: OrganizeJobRunControllerIdentity): OrganizeJobRunReadyPreflight | null;
  startRun(
    identity: OrganizeJobRunControllerIdentity,
    preflightToken: PreflightToken,
    taskInstruction?: string,
  ): OrganizeJobRunSnapshot;
  getSnapshot(identity: OrganizeRunIdentity): OrganizeJobRunSnapshot;
  registerDurableProposal(
    identity: OrganizeRunIdentity,
    proposal: OrganizeProposal,
    continuationCursor?: ContinuationCursorToken,
  ): OrganizeJobRunSnapshot;
  restoreAnalysisRun(input: Readonly<{
    jobId: OrganizeJobId;
    identity: OrganizeRunIdentity;
    state: OrganizeJobRunAnalysisState;
    taskInstruction: string;
    continuationCursor?: ContinuationCursorToken | null;
  }>): OrganizeJobRunSnapshot;
  updateUsage(identity: OrganizeRunIdentity, usage: RunBudgetUsage): OrganizeJobRunSnapshot;
  updateAnalysisProgress(
    identity: OrganizeRunIdentity,
    usage: RunBudgetUsage,
    coverage: OrganizeJobRunCoverageSummary,
  ): OrganizeJobRunSnapshot;
  blockAnalysis(
    identity: OrganizeRunIdentity,
    usage: RunBudgetUsage,
    coverage: OrganizeJobRunCoverageSummary,
    continuationCursor: ContinuationCursorToken,
  ): OrganizeJobRunSnapshot;
  stopRun(identity: OrganizeRunIdentity): OrganizeJobRunSnapshot;
  getExecutionContext(identity: OrganizeRunIdentity): Readonly<{
    jobId: OrganizeJobId;
    frozenScope: FrozenScope;
    budget: RunBudget;
    usage: RunBudgetUsage;
    taskInstruction: string;
    startFrozenIndex: number;
  }>;
  setRunState(
    identity: OrganizeRunIdentity,
    state: 'checking_provider' | 'analyzing',
  ): OrganizeJobRunSnapshot;
  completeWithoutProposal(identity: OrganizeRunIdentity, usage: RunBudgetUsage): OrganizeJobRunSnapshot;
  exhaustBudget(
    identity: OrganizeRunIdentity,
    usage: RunBudgetUsage,
    reason: BudgetExhaustionReason,
    continuationCursor: ContinuationCursorToken,
  ): OrganizeJobRunSnapshot;
  failRun(identity: OrganizeRunIdentity, reason?: 'provider_error' | 'internal_error'): OrganizeJobRunSnapshot;
  continueRun(
    parentIdentity: OrganizeRunIdentity,
    nextFrozenIndex: number,
    continuationCursor: ContinuationCursorToken,
  ): OrganizeJobRunSnapshot;
  findLatestSnapshot(identity: OrganizeJobRunControllerIdentity): OrganizeJobRunSnapshot | null;
  disconnectController(identity: OrganizeJobRunControllerIdentity): OrganizeJobRunSnapshot | null;
  releaseController(identity: OrganizeJobRunControllerIdentity): RunId[];
}

export function createBgsmAgentController(
  dependencies: BgsmAgentControllerDependencies,
): BgsmAgentController {
  const now = dependencies.now ?? Date.now;
  const randomId = dependencies.randomId ?? defaultRandomId;
  const eventEpoch = dependencies.eventEpoch ?? defaultRandomId();
  const preflightTtlMs = dependencies.preflightTtlMs ?? 5 * 60_000;
  const setTimer = dependencies.setTimer
    ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer = dependencies.clearTimer
    ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const preflights = new Map<PreflightToken, PreflightRecord>();
  const preflightTimers = new Map<PreflightToken, unknown>();
  const preflightAuthorities = new Map<string, PreflightAuthority>();
  const consumedPreflights = new Set<PreflightToken>();
  const runs = new Map<RunId, RunRecord>();
  const nextGeneration = new Map<string, number>();
  const continuationChildren = new Map<ContinuationCursorToken, RunId>();
  const maxConsumedPreflightTombstones = 256;
  const rememberConsumedPreflight = (token: PreflightToken): void => {
    consumedPreflights.delete(token);
    consumedPreflights.add(token);
    while (consumedPreflights.size > maxConsumedPreflightTombstones) {
      const oldest = consumedPreflights.values().next().value as PreflightToken | undefined;
      if (!oldest) break;
      consumedPreflights.delete(oldest);
    }
  };
  let eventSequence = 0;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(eventEpoch)) {
    throw new TypeError('OrganizeJobRun event epoch is malformed.');
  }

  if (!Number.isSafeInteger(preflightTtlMs) || preflightTtlMs < 1) {
    throw new TypeError('OrganizeJobRun preflight TTL must be a positive safe integer.');
  }

  const closePreflight = (
    record: PreflightRecord,
    state: 'started' | 'cancelled' | 'expired' | 'stale' | 'disconnected',
  ): void => {
    if (preflights.get(record.token) !== record) return;
    preflights.delete(record.token);
    const timer = preflightTimers.get(record.token);
    if (timer !== undefined) clearTimer(timer);
    preflightTimers.delete(record.token);
    const authorityKey = `${record.controllerId}\u0000${record.sessionId}`;
    const authority = preflightAuthorities.get(authorityKey);
    if (authority?.requestId === record.requestId && authority.jobId === record.jobId) {
      preflightAuthorities.delete(authorityKey);
    }
    dependencies.onPreflightState?.({
      jobId: record.jobId,
      state,
      repositoryCount: record.candidate.repositoryIds.length,
    });
  };

  const preflightAuthorityKey = (identity: OrganizeJobRunControllerIdentity): string => (
    `${identity.controllerId}\u0000${identity.sessionId}`
  );

  const beginPreflightRequest = (
    identity: OrganizeJobRunControllerIdentity,
    authority: PreflightAuthority,
  ): void => {
    const key = preflightAuthorityKey(identity);
    const previous = preflightAuthorities.get(key);
    if (previous) {
      const ready = [...preflights.values()].find((record) => (
        record.controllerId === identity.controllerId
        && record.sessionId === identity.sessionId
        && record.requestId === previous.requestId
        && record.jobId === previous.jobId
      ));
      if (ready) closePreflight(ready, 'stale');
      else dependencies.onPreflightState?.({
        jobId: previous.jobId,
        state: 'stale',
        repositoryCount: 0,
      });
    }
    preflightAuthorities.set(key, authority);
  };

  const isCurrentPreflightRequest = (
    identity: OrganizeJobRunControllerIdentity,
    authority: PreflightAuthority,
  ): boolean => preflightAuthorities.get(preflightAuthorityKey(identity)) === authority;

  const clearPreflightRequest = (
    identity: OrganizeJobRunControllerIdentity,
    authority: PreflightAuthority,
  ): void => {
    const key = preflightAuthorityKey(identity);
    if (preflightAuthorities.get(key) === authority) preflightAuthorities.delete(key);
  };

  const materializeEvent = <Event extends OrganizeJobRunEventWithoutId>(
    event: Event,
  ): Event & Readonly<{ eventId: string }> => Object.freeze(Object.assign({}, event, {
    eventId: `event:v1:${eventEpoch}:${++eventSequence}`,
  }));

  const emit = (event: OrganizeJobRunEventWithoutId): void => {
    dependencies.emit?.(materializeEvent(event) as OrganizeJobRunEvent);
  };

  const requireRun = (identity: OrganizeRunIdentity): RunRecord => {
    const record = runs.get(identity.runId);
    if (
      !record ||
      record.identity.controllerId !== identity.controllerId ||
      record.identity.sessionId !== identity.sessionId ||
      record.identity.generation !== identity.generation
    ) {
      throw new TypeError('OrganizeJobRun identity is stale or does not belong to this controller/session.');
    }
    return record;
  };

  const snapshot = (record: RunRecord): OrganizeJobRunSnapshot => Object.freeze({
    ...record.identity,
    state: record.state,
    terminalReason: record.terminalReason,
    frozenScope: projectFrozenScope(record.frozenScope),
    budget: record.budget,
    usage: record.usage,
    coverage: record.coverage,
    proposalId: record.proposalReviewSummary?.proposalId ?? null,
    ...(record.proposalReviewSummary
      ? { proposalReviewSummary: record.proposalReviewSummary }
      : {}),
    continuationCursor: record.continuationCursor,
  });

  return {
    async issuePreflight(identity, options) {
      assertControllerIdentity(identity);
      const jobId = options?.jobId ?? createOrganizeJobId(randomId);
      const requestId = options?.requestId ?? `preflight-request:${randomId()}`;
      if (!requestId.trim()) throw new TypeError('OrganizeJobRun preflight requestId must be nonempty.');
      const authority = Object.freeze({ requestId, jobId });
      beginPreflightRequest(identity, authority);
      let candidate: ResolvedLaunchCandidate;
      try {
        candidate = await dependencies.resolveCandidate();
      } catch (error) {
        clearPreflightRequest(identity, authority);
        throw error;
      }
      if (candidate.contract.kind !== 'all_live_stars') {
        clearPreflightRequest(identity, authority);
        throw new TypeError('OrganizeJobRun only accepts the whole starred library.');
      }
      if (!isCurrentPreflightRequest(identity, authority)) {
        throw new TypeError('OrganizeJobRun preflight request is stale.');
      }
      if (candidate.repositoryIds.length === 0) {
        clearPreflightRequest(identity, authority);
        dependencies.onPreflightState?.({ jobId, state: 'no_work', repositoryCount: 0 });
        return Object.freeze({
          status: 'no_work',
          jobId,
          preflightToken: null,
          label: candidate.label,
          count: 0,
        });
      }
      const capturedAt = now();
      const digest = await sha256Base64Url(canonicalJson({
        controllerId: identity.controllerId,
        sessionId: identity.sessionId,
        contract: candidate.contract,
        repositoryIds: candidate.repositoryIds,
        label: candidate.label,
      }));
      if (!isCurrentPreflightRequest(identity, authority)) {
        throw new TypeError('OrganizeJobRun preflight request is stale.');
      }
      const scopeFingerprint = parseScopeFingerprintV1(`fs:v1:${digest}`);
      const token = parsePreflightToken(`preflight:v1:${randomId()}`);
      const expiresAt = capturedAt + preflightTtlMs;
      preflights.set(token, Object.freeze({
        token,
        requestId,
        jobId,
        controllerId: identity.controllerId,
        sessionId: identity.sessionId,
        candidate: Object.freeze({
          ...candidate,
          repositoryIds: Object.freeze([...candidate.repositoryIds]) as unknown as string[],
        }),
        scopeFingerprint,
        capturedAt,
        expiresAt,
      }));
      const record = preflights.get(token)!;
      preflightTimers.set(token, setTimer(() => closePreflight(record, 'expired'), preflightTtlMs));
      dependencies.onLifecycle?.('preflight_issued');
      dependencies.onPreflightState?.({
        jobId,
        state: 'ready',
        repositoryCount: candidate.repositoryIds.length,
      });
      return Object.freeze({
        status: 'ready',
        jobId,
        preflightToken: token,
        label: candidate.label,
        count: candidate.repositoryIds.length,
      });
    },

    cancelPreflight(identity, requestId) {
      assertControllerIdentity(identity);
      if (!requestId.trim()) throw new TypeError('OrganizeJobRun preflight requestId must be nonempty.');
      const record = [...preflights.values()].find((candidate) => (
        candidate.controllerId === identity.controllerId
        && candidate.sessionId === identity.sessionId
        && candidate.requestId === requestId
      ));
      if (record) {
        closePreflight(record, 'cancelled');
        return true;
      }
      const key = preflightAuthorityKey(identity);
      const authority = preflightAuthorities.get(key);
      if (!authority || authority.requestId !== requestId) return false;
      preflightAuthorities.delete(key);
      dependencies.onPreflightState?.({
        jobId: authority.jobId,
        state: 'cancelled',
        repositoryCount: 0,
      });
      return true;
    },

    findReadyPreflight(identity) {
      assertControllerIdentity(identity);
      const authority = preflightAuthorities.get(preflightAuthorityKey(identity));
      if (!authority) return null;
      const record = [...preflights.values()].find((candidate) => (
        candidate.controllerId === identity.controllerId
        && candidate.sessionId === identity.sessionId
        && candidate.requestId === authority.requestId
        && candidate.jobId === authority.jobId
      ));
      return record ? Object.freeze({
        requestId: record.requestId,
        preflightToken: record.token,
        label: record.candidate.label,
        count: record.candidate.repositoryIds.length,
      }) : null;
    },

    getPreflightContext(identity, preflightToken) {
      assertControllerIdentity(identity);
      const preflight = preflights.get(preflightToken);
      if (!preflight) throw new TypeError('OrganizeJobRun preflight token is invalid or stale.');
      if (
        preflight.controllerId !== identity.controllerId
        || preflight.sessionId !== identity.sessionId
      ) {
        throw new TypeError('OrganizeJobRun preflight token belongs to another controller/session.');
      }
      return Object.freeze({
        jobId: preflight.jobId,
        scopeKind: preflight.candidate.contract.kind,
        frozenScope: createFrozenScope({
          kind: preflight.candidate.contract.kind,
          label: preflight.candidate.label,
          filterSnapshot: preflight.candidate.filterSnapshot,
          repositoryIds: preflight.candidate.repositoryIds,
          capturedAt: preflight.capturedAt,
          fingerprint: preflight.scopeFingerprint,
        }),
        expiresAt: preflight.expiresAt,
      });
    },

    acknowledgePreflightStarted(identity, preflightToken) {
      assertControllerIdentity(identity);
      const preflight = preflights.get(preflightToken);
      if (!preflight) return false;
      if (
        preflight.controllerId !== identity.controllerId
        || preflight.sessionId !== identity.sessionId
      ) {
        throw new TypeError('OrganizeJobRun preflight token belongs to another controller/session.');
      }
      rememberConsumedPreflight(preflightToken);
      closePreflight(preflight, 'started');
      return true;
    },

    startRun(identity, preflightToken, taskInstruction = 'Organize this scope with useful semantic tags.') {
      assertControllerIdentity(identity);
      if (consumedPreflights.has(preflightToken)) {
        throw new TypeError('OrganizeJobRun preflight token was already consumed.');
      }
      const preflight = preflights.get(preflightToken);
      if (!preflight) throw new TypeError('OrganizeJobRun preflight token is invalid or stale.');
      if (
        preflight.controllerId !== identity.controllerId ||
        preflight.sessionId !== identity.sessionId
      ) {
        throw new TypeError('OrganizeJobRun preflight token belongs to another controller/session.');
      }
      if ([...runs.values()].some((run) => (
        run.identity.controllerId === identity.controllerId &&
        !['completed', 'cancelled', 'failed', 'interrupted', 'budget_exhausted'].includes(run.state)
      ))) {
        throw new TypeError('This controller already owns an active OrganizeJobRun.');
      }

      const generationKey = `${identity.controllerId}\u0000${identity.sessionId}`;
      const generation = incrementRunGeneration(nextGeneration.get(generationKey) ?? 0);
      const runId = parseRunId(`run:v1:${randomId()}`);
      const frozenScope = createFrozenScope({
        kind: preflight.candidate.contract.kind,
        label: preflight.candidate.label,
        filterSnapshot: preflight.candidate.filterSnapshot,
        repositoryIds: preflight.candidate.repositoryIds,
        capturedAt: preflight.capturedAt,
        fingerprint: preflight.scopeFingerprint,
      });
      const record: RunRecord = {
        jobId: preflight.jobId,
        identity: Object.freeze({
          controllerId: identity.controllerId,
          sessionId: identity.sessionId,
          runId,
          generation,
        }),
        frozenScope,
        budget: createProductionRunBudget(),
        taskInstruction,
        startFrozenIndex: 0,
        state: 'frozen',
        terminalReason: null,
        usage: createEmptyRunBudgetUsage(),
        coverage: createEmptyCoverage(frozenScope.count),
        proposalReviewSummary: null,
        continuationCursor: null,
      };

      rememberConsumedPreflight(preflightToken);
      closePreflight(preflight, 'started');
      nextGeneration.set(generationKey, generation);
      runs.set(runId, record);
      dependencies.onLifecycle?.('token_consumed_frozen_and_budgeted');
      void Promise.resolve().then(() => dependencies.scheduleRun?.(record.identity));
      return snapshot(record);
    },

    getSnapshot(identity) {
      return snapshot(requireRun(identity));
    },

    registerDurableProposal(identity, proposal, continuationCursor) {
      const record = requireRun(identity);
      validateOrganizeProposal(proposal);
      if (
        proposal.runId !== identity.runId ||
        proposal.generation !== identity.generation ||
        !['frozen', 'prepared', 'checking_provider', 'analyzing'].includes(record.state)
      ) {
        throw new TypeError('Durable proposal identity or run state is invalid.');
      }
      for (const row of proposal.rows) {
        if (record.frozenScope.repositoryIds[row.frozenIndex] !== row.repositoryId) {
          throw new TypeError('Durable proposal row does not belong to its FrozenScope position.');
        }
      }
      if (
        record.coverage.analyzed !== record.coverage.total ||
        record.coverage.analysisFailed !== 0 ||
        record.coverage.actionable !== proposal.rows.length
      ) {
        throw new TypeError('Durable proposal requires complete failure-free FrozenScope coverage.');
      }
      record.proposalReviewSummary = Object.freeze({
        version: 1,
        proposalId: proposal.proposalId,
        runId: proposal.runId,
        generation: proposal.generation,
        totalRows: proposal.rows.length,
      });
      record.continuationCursor = continuationCursor ?? null;
      record.state = 'review';
      record.terminalReason = null;
      emit({
        type: 'proposal_summary_ready',
        ...record.identity,
        state: 'review',
        proposalId: proposal.proposalId,
        actionableCount: proposal.rows.length,
        nonActionableCount: record.coverage.analyzed - proposal.rows.length,
        proposalReviewSummary: record.proposalReviewSummary,
        coverage: record.coverage,
      });
      return snapshot(record);
    },

    restoreAnalysisRun(input) {
      assertControllerIdentity(input.identity);
      const analysis = input.state;
      if (
        analysis.runId !== input.identity.runId ||
        analysis.generation !== input.identity.generation
      ) {
        throw new TypeError('Restored analysis identity does not match its controller run.');
      }
      const coverage = createOrganizeJobRunCoverageSummary({
        total: analysis.frozenScope.count,
        analyzedFrozenPositions: analysis.analyzedFrozenPositions,
        nonActionableAnalysisOutcomes: analysis.nonActionableAnalysisOutcomes,
        actionableProposalRows: analysis.actionableProposalRows,
      });
      if (!['analyzing', 'analysis_blocked', 'review'].includes(analysis.status)) {
        throw new TypeError('Only active, blocked, or review analysis can be restored.');
      }
      const restoredRunState: OrganizeJobRunSnapshot['state'] = analysis.status === 'analysis_blocked'
        ? 'analysis_blocked'
        : analysis.status === 'review'
          ? 'review'
          : 'analyzing';
      const proposalReviewSummary = analysis.status === 'review'
        ? Object.freeze({
            version: 1 as const,
            proposalId: analysis.proposalId,
            runId: analysis.runId,
            generation: analysis.generation,
            totalRows: analysis.actionableProposalRows.length,
          })
        : null;
      const record: RunRecord = {
        jobId: input.jobId,
        identity: Object.freeze({ ...input.identity }),
        frozenScope: analysis.frozenScope,
        budget: analysis.budget,
        taskInstruction: input.taskInstruction,
        startFrozenIndex: analysis.startFrozenIndex,
        state: restoredRunState,
        terminalReason: analysis.status === 'analysis_blocked' ? 'analysis_failed' : null,
        usage: analysis.usage,
        coverage,
        proposalReviewSummary,
        continuationCursor: input.continuationCursor ?? null,
      };
      runs.set(input.identity.runId, record);
      const generationKey = `${input.identity.controllerId}\u0000${input.identity.sessionId}`;
      nextGeneration.set(
        generationKey,
        Math.max(nextGeneration.get(generationKey) ?? 0, input.identity.generation),
      );
      return snapshot(record);
    },

    updateUsage(identity, usage) {
      const record = requireRun(identity);
      validateRunBudgetUsage(usage);
      if (!isMonotonicRunBudgetUsage(record.usage, usage)) {
        throw new TypeError('OrganizeJobRun usage updates must be componentwise monotonic.');
      }
      record.usage = Object.freeze({ ...usage });
      emit({
        type: 'budget_usage_changed',
        ...record.identity,
        budget: record.budget,
        usage: record.usage,
      });
      return snapshot(record);
    },

    updateAnalysisProgress(identity, usage, coverage) {
      const record = requireRun(identity);
      validateRunBudgetUsage(usage);
      validateOrganizeJobRunCoverageSummary(coverage);
      if (!isMonotonicRunBudgetUsage(record.usage, usage)) {
        throw new TypeError('OrganizeJobRun analysis progress usage must be componentwise monotonic.');
      }
      if (coverage.total !== record.frozenScope.count) {
        throw new TypeError('OrganizeJobRun analysis progress must match its FrozenScope count.');
      }
      record.usage = Object.freeze({ ...usage });
      record.coverage = Object.freeze({ ...coverage });
      emit({
        type: 'budget_usage_changed',
        ...record.identity,
        budget: record.budget,
        usage: record.usage,
      });
      return snapshot(record);
    },

    blockAnalysis(identity, usage, coverage, continuationCursor) {
      const record = requireRun(identity);
      validateRunBudgetUsage(usage);
      validateOrganizeJobRunCoverageSummary(coverage);
      if (!isMonotonicRunBudgetUsage(record.usage, usage)) {
        throw new TypeError('Blocked analysis usage must be componentwise monotonic.');
      }
      if (coverage.total !== record.frozenScope.count || coverage.analysisFailed === 0) {
        throw new TypeError('Blocked analysis requires at least one failed FrozenScope row.');
      }
      record.usage = Object.freeze({ ...usage });
      record.coverage = Object.freeze({ ...coverage });
      record.state = 'analysis_blocked';
      record.terminalReason = 'analysis_failed';
      record.continuationCursor = continuationCursor;
      emit({ type: 'run_state_changed', ...record.identity, state: 'analysis_blocked' });
      return snapshot(record);
    },

    stopRun(identity) {
      const record = requireRun(identity);
      if (isTerminalState(record.state)) return snapshot(record);
      record.state = 'cancelled';
      record.terminalReason = 'user_stopped';
      emit({
        type: 'run_terminal',
        ...record.identity,
        state: 'cancelled',
        reason: 'user_stopped',
      });
      return snapshot(record);
    },

    getExecutionContext(identity) {
      const record = requireRun(identity);
      return Object.freeze({
        jobId: record.jobId,
        frozenScope: record.frozenScope,
        budget: record.budget,
        usage: record.usage,
        taskInstruction: record.taskInstruction,
        startFrozenIndex: record.startFrozenIndex,
      });
    },

    setRunState(identity, state) {
      const record = requireRun(identity);
      if (!['frozen', 'prepared', 'checking_provider', 'analyzing'].includes(record.state)) {
        throw new TypeError('OrganizeJobRun cannot enter an analysis state from its current state.');
      }
      record.state = state;
      emit({ type: 'run_state_changed', ...record.identity, state });
      return snapshot(record);
    },

    completeWithoutProposal(identity, usage) {
      const record = requireRun(identity);
      validateRunBudgetUsage(usage);
      if (!isMonotonicRunBudgetUsage(record.usage, usage)) {
        throw new TypeError('OrganizeJobRun completion usage must be monotonic.');
      }
      if (
        record.coverage.analyzed !== record.coverage.total ||
        record.coverage.analysisFailed !== 0 ||
        record.coverage.actionable !== 0
      ) {
        throw new TypeError('No-change completion requires complete failure-free coverage without proposals.');
      }
      record.usage = Object.freeze({ ...usage });
      record.state = 'completed';
      record.terminalReason = 'no_changes';
      emit({
        type: 'run_terminal',
        ...record.identity,
        state: 'completed',
        reason: 'no_changes',
      });
      return snapshot(record);
    },

    exhaustBudget(identity, usage, reason, continuationCursor) {
      const record = requireRun(identity);
      validateRunBudgetUsage(usage);
      if (!isMonotonicRunBudgetUsage(record.usage, usage)) {
        throw new TypeError('OrganizeJobRun exhaustion usage must be monotonic.');
      }
      record.usage = Object.freeze({ ...usage });
      record.state = 'budget_exhausted';
      record.terminalReason = reason;
      record.continuationCursor = continuationCursor;
      emit({
        type: 'budget_exhausted',
        ...record.identity,
        state: 'budget_exhausted',
        reason,
        budget: record.budget,
        usage: record.usage,
        continuationCursor,
      });
      return snapshot(record);
    },

    failRun(identity, reason = 'internal_error') {
      const record = requireRun(identity);
      if (isTerminalState(record.state)) return snapshot(record);
      record.state = 'failed';
      record.terminalReason = reason;
      emit({ type: 'run_terminal', ...record.identity, state: 'failed', reason });
      return snapshot(record);
    },

    continueRun(parentIdentity, nextFrozenIndex, continuationCursor) {
      const parent = requireRun(parentIdentity);
      const existingChildId = continuationChildren.get(continuationCursor);
      if (existingChildId) {
        const existingChild = runs.get(existingChildId);
        if (!existingChild) throw new TypeError('Continuation child authority is unavailable.');
        return snapshot(existingChild);
      }
      if (parent.continuationCursor !== continuationCursor) {
        throw new TypeError('Continuation cursor does not match the authoritative parent run.');
      }
      if (
        parent.continuationCursor === null ||
        !['analysis_blocked', 'budget_exhausted', 'completed', 'failed'].includes(parent.state)
      ) {
        throw new TypeError('Only a stopped OrganizeJobRun with continuation authority can create a child.');
      }
      if ([...runs.values()].some((run) => (
        run.identity.controllerId === parent.identity.controllerId &&
        run.identity.sessionId === parent.identity.sessionId &&
        run.identity.runId !== parent.identity.runId &&
        !isTerminalState(run.state)
      ))) {
        throw new TypeError('This controller already owns a prepared or active continuation.');
      }
      if (
        !Number.isSafeInteger(nextFrozenIndex) ||
        nextFrozenIndex < parent.startFrozenIndex ||
        nextFrozenIndex > parent.frozenScope.count
      ) {
        throw new TypeError('Continuation start index is outside the authoritative FrozenScope.');
      }
      const generationKey = `${parent.identity.controllerId}\u0000${parent.identity.sessionId}`;
      const generation = allocateNextGeneration(generationKey, parent.identity.generation);
      const runId = parseRunId(`run:v1:${randomId()}`);
      const record: RunRecord = {
        jobId: parent.jobId,
        identity: Object.freeze({
          controllerId: parent.identity.controllerId,
          sessionId: parent.identity.sessionId,
          runId,
          generation,
        }),
        frozenScope: parent.frozenScope,
        budget: createProductionRunBudget(),
        taskInstruction: parent.taskInstruction,
        startFrozenIndex: nextFrozenIndex,
        state: 'prepared',
        terminalReason: null,
        usage: createEmptyRunBudgetUsage(),
        coverage: parent.coverage,
        proposalReviewSummary: null,
        continuationCursor: null,
      };
      runs.set(runId, record);
      nextGeneration.set(generationKey, generation);
      continuationChildren.set(continuationCursor, runId);
      return snapshot(record);
    },

    findLatestSnapshot(identity) {
      assertControllerIdentity(identity);
      const matching = [...runs.values()]
        .filter((run) => (
          run.identity.controllerId === identity.controllerId &&
          run.identity.sessionId === identity.sessionId
        ))
        .sort((left, right) => right.identity.generation - left.identity.generation);
      const record = matching[0];
      return record ? snapshot(record) : null;
    },

    disconnectController(identity) {
      assertControllerIdentity(identity);
      const record = [...runs.values()]
        .filter((run) => (
          run.identity.controllerId === identity.controllerId &&
          run.identity.sessionId === identity.sessionId
        ))
        .sort((left, right) => right.identity.generation - left.identity.generation)[0];
      if (!record) return null;
      if (!isTerminalState(record.state)) {
        record.state = 'interrupted';
        record.terminalReason = 'port_disconnected';
        emit({
          type: 'run_terminal',
          ...record.identity,
          state: 'interrupted',
          reason: 'port_disconnected',
        });
      }
      return snapshot(record);
    },
    releaseController(identity) {
      assertControllerIdentity(identity);
      const generationKey = `${identity.controllerId}\u0000${identity.sessionId}`;
      const matchingRuns = [...runs.values()].filter((run) => (
        run.identity.controllerId === identity.controllerId &&
        run.identity.sessionId === identity.sessionId
      ));
      const releasedRunIds = new Set(matchingRuns.map((run) => run.identity.runId));
      const releasedContinuationCursors = new Set(
        matchingRuns
          .map((run) => run.continuationCursor)
          .filter((cursor): cursor is ContinuationCursorToken => cursor !== null),
      );

      for (const preflight of preflights.values()) {
        if (
          preflight.controllerId === identity.controllerId &&
          preflight.sessionId === identity.sessionId
        ) closePreflight(preflight, 'disconnected');
      }
      const authorityKey = preflightAuthorityKey(identity);
      const pendingAuthority = preflightAuthorities.get(authorityKey);
      if (pendingAuthority) {
        preflightAuthorities.delete(authorityKey);
        dependencies.onPreflightState?.({
          jobId: pendingAuthority.jobId,
          state: 'disconnected',
          repositoryCount: 0,
        });
      }
      for (const [cursor, childRunId] of continuationChildren) {
        if (releasedRunIds.has(childRunId) || releasedContinuationCursors.has(cursor)) {
          continuationChildren.delete(cursor);
        }
      }
      for (const runId of releasedRunIds) {
        runs.delete(runId);
      }
      nextGeneration.delete(generationKey);
      return [...releasedRunIds];
    },
  };

  function allocateNextGeneration(generationKey: string, parentGeneration: number): number {
    const current = Math.max(nextGeneration.get(generationKey) ?? 0, parentGeneration);
    return incrementRunGeneration(current);
  }
}

export function incrementRunGeneration(currentGeneration: number): number {
  if (
    !Number.isSafeInteger(currentGeneration) ||
    currentGeneration < 0 ||
    currentGeneration >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError('OrganizeJobRun generation cannot be incremented safely.');
  }
  return currentGeneration + 1;
}

function assertControllerIdentity(identity: OrganizeJobRunControllerIdentity): void {
  if (!identity.controllerId || !identity.sessionId || identity.sessionId.trim() !== identity.sessionId) {
    throw new TypeError('OrganizeJobRun controller/session identity is malformed.');
  }
}

function createEmptyCoverage(total: number): OrganizeJobRunCoverageSummary {
  return createOrganizeJobRunCoverageSummary({
    total,
    analyzedFrozenPositions: [],
    nonActionableAnalysisOutcomes: [],
    actionableProposalRows: [],
  });
}

function defaultRandomId(): string {
  return crypto.randomUUID();
}

function isTerminalState(state: OrganizeJobRunSnapshot['state']): boolean {
  return ['completed', 'budget_exhausted', 'cancelled', 'failed', 'interrupted'].includes(state);
}
