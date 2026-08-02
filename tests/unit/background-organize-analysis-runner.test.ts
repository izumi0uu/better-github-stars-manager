import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createFrozenScopeCursor,
  createFrozenScope,
  createProductionRunBudget,
  parseControllerId,
  parseContinuationCursorToken,
  parseOrganizeJobId,
  parseProposalId,
  parseRunId,
  parseScopeFingerprintV1,
  parseSourceFingerprintV1,
  parseTaxonomyFingerprintV1,
  projectFrozenScope,
  type BudgetExhaustionReason,
  type OrganizeJobRunSnapshot,
  type RunBudgetUsage,
} from '@/bgsm-agent';
import { issueContinuationCursor } from '@/bgsm-agent/continuation-cursor';
import type {
  AnalyzerReservationDecision,
  AnalyzerRunResult,
  PreparedAnalyzerAttempt,
  SemanticAnalyzerBatch,
} from '@/bgsm-agent/organize-proposal-analyzer';
import { AnalyzerAttemptError } from '@/bgsm-agent/organize-proposal-analyzer';
import { AgentProviderError, type AgentProviderErrorCode } from '@/agent-harness/provider';
import type { OrganizeJobRunPagePosition } from '@/bgsm-agent/organize-job';
import { createBgsmAgentController } from '@/background/organize-job-controller';
import {
  createBgsmOrganizeJobScheduler,
  type BgsmOrganizeJobSchedulerTraceEvent,
} from '@/background/organize-analysis-runner';

type AnalyzerMode =
  | 'success'
  | 'retry_success'
  | 'retry_prepare_failure'
  | 'double_failure'
  | 'retry_blocked_on_seventh';
type ProviderAttemptTraceEvent = Extract<BgsmOrganizeJobSchedulerTraceEvent, { type: 'provider_attempt' }>;
type WatchdogTraceEvent = Extract<BgsmOrganizeJobSchedulerTraceEvent, { type: 'watchdog_state' }>;

function providerAttemptTraceEvents(
  events: readonly BgsmOrganizeJobSchedulerTraceEvent[],
): ProviderAttemptTraceEvent[] {
  return events.filter((event): event is ProviderAttemptTraceEvent => event.type === 'provider_attempt');
}

function watchdogTraceEvents(
  events: readonly BgsmOrganizeJobSchedulerTraceEvent[],
): WatchdogTraceEvent[] {
  return events.filter((event): event is WatchdogTraceEvent => event.type === 'watchdog_state');
}

function createHarness(input: Readonly<{
  scopeCount: number;
  requestedWindowSize?: number;
  pageKind: 'missing' | 'live';
  analyzerMode?: AnalyzerMode;
  requestBytes?: number;
  requestedTokens?: number;
  onLoadPage?: (readCount: number) => void;
  setTimer?: (callback: () => void, delay: number) => unknown;
  analyzerGate?: Promise<void>;
  heartbeat?: (identity: Readonly<{
    controllerId: string;
    sessionId: string;
    runId: string;
    generation: number;
  }>) => void;
  setHeartbeatInterval?: (callback: () => void, delay: number) => unknown;
  clearHeartbeatInterval?: (timer: unknown) => void;
  durable?: boolean;
  durableAttemptError?: Error;
  traceThrows?: boolean;
  splitFailureRanges?: readonly string[];
  providerFailureCode?: AgentProviderErrorCode;
}>) {
  const runId = parseRunId(`run:v1:scheduler-${Math.random()}`);
  const identity = {
    controllerId: parseControllerId('controller:v1:scheduler'),
    sessionId: 'scheduler-session',
    runId,
    generation: 1,
  } as const;
  const repositoryIds = Array.from({ length: input.scopeCount }, (_, index) => `owner/repo-${index}`);
  const frozenScope = createFrozenScope({
    kind: 'all_live_stars',
    label: 'All stars',
    filterSnapshot: 'all',
    repositoryIds,
    capturedAt: 1,
    fingerprint: parseScopeFingerprintV1(`fs:v1:${'A'.repeat(43)}`),
  });
  const counters = {
    reads: 0,
    reservations: 0,
    executes: 0,
    exhaustions: 0,
    completions: 0,
    continuations: 0,
  };
  const publishedSnapshots: OrganizeJobRunSnapshot[] = [];
  const durableCalls: string[] = [];
  const traceEvents: BgsmOrganizeJobSchedulerTraceEvent[] = [];
  const loadedRanges: string[] = [];
  let usage: RunBudgetUsage = {
    firstAnalyzerRequestAt: null,
    consumedFrozenPositions: 0,
    analyzerBatches: 0,
    providerAttempts: 0,
    serializedOutboundRequestBytes: 0,
    requestedOutputTokens: 0,
  };
  let reason: BudgetExhaustionReason | null = null;
  let nextFrozenIndex: number | null = null;
  let analyzerBatchCount = 0;
  const controller = {
    setRunState: () => ({} as never),
    getExecutionContext: () => ({
      jobId: parseOrganizeJobId(`organize-job:v1:${runId}`),
      frozenScope,
      budget: createProductionRunBudget(),
      usage,
      taskInstruction: 'Classify repositories.',
      startFrozenIndex: 0,
    }),
    updateUsage: (_identity: typeof identity, next: RunBudgetUsage) => {
      usage = next;
      return {} as never;
    },
    updateAnalysisProgress: (_identity: typeof identity, next: RunBudgetUsage) => {
      usage = next;
      return {} as never;
    },
    blockAnalysis: (_identity: typeof identity, next: RunBudgetUsage, coverage: OrganizeJobRunSnapshot['coverage'], cursor: unknown) => {
      usage = next;
      return {
        ...identity,
        state: 'analysis_blocked',
        terminalReason: 'analysis_failed',
        frozenScope: projectFrozenScope(frozenScope),
        budget: createProductionRunBudget(),
        usage,
        coverage,
        proposalId: null,
        continuationCursor: cursor,
      } as never;
    },
    registerDurableProposal: () => ({} as never),
    completeWithoutProposal: (_identity: typeof identity, next: RunBudgetUsage) => {
      usage = next;
      counters.completions += 1;
      return {} as never;
    },
    exhaustBudget: (
      _identity: typeof identity,
      next: RunBudgetUsage,
      exhaustedReason: BudgetExhaustionReason,
      _cursor: unknown,
    ) => {
      usage = next;
      reason = exhaustedReason;
      counters.exhaustions += 1;
      nextFrozenIndex = usage.consumedFrozenPositions;
      return {} as never;
    },
    continueRun: (
      _parentIdentity: typeof identity,
      _startFrozenIndex: number,
    ): OrganizeJobRunSnapshot => {
      counters.continuations += 1;
      if (input.durable) durableCalls.push('continue');
      return {
        ...identity,
        runId: parseRunId(`run:v1:continuation-${counters.continuations}`),
        generation: identity.generation + counters.continuations,
        state: 'prepared',
        terminalReason: null,
        frozenScope: projectFrozenScope(frozenScope),
        budget: createProductionRunBudget(),
        usage: {
          firstAnalyzerRequestAt: null,
          consumedFrozenPositions: 0,
          analyzerBatches: 0,
          providerAttempts: 0,
          serializedOutboundRequestBytes: 0,
          requestedOutputTokens: 0,
        },
        proposalId: null,
        continuationCursor: null,
      };
    },
    failRun: () => ({} as never),
  };

  const reserveOnce = async (
    batch: SemanticAnalyzerBatch,
    reserve: (attempt: PreparedAnalyzerAttempt) => AnalyzerReservationDecision | Promise<AnalyzerReservationDecision>,
  ) => {
    counters.reservations += 1;
    const decision = await reserve({
      attempt: 1,
      batch,
      serializedRequestBytes: input.requestBytes ?? 1,
      requestedOutputTokens: input.requestedTokens ?? 1,
      serializedRequestBody: '{}',
      execute: async () => { throw new Error('not used by the scheduler harness'); },
    } as PreparedAnalyzerAttempt);
    if (decision.status === 'budget_exhausted') {
      return { decision, result: null } as const;
    }
    counters.executes += 1;
    return {
      decision,
      result: {
        status: 'success',
        attempts: 1,
        value: {
          proposal: {
            version: 1,
            runId: batch.runId,
            generation: batch.generation,
            scopeFingerprint: batch.scopeFingerprint,
            rows: batch.repositories.map((repository) => ({
              frozenIndex: repository.frozenIndex,
              repositoryId: repository.repositoryId,
              sourceFingerprint: repository.sourceFingerprint,
              classifications: [{ kind: 'unchanged', evidence: 'No useful change.' }],
            })),
          },
          telemetry: { inputTokens: null, outputTokens: null, totalTokens: null },
        },
      } satisfies AnalyzerRunResult,
    } as const;
  };

  const analyzer = {
    requestedOutputTokens: input.requestedTokens ?? 1,
    requestedOutputTokensForRepositoryCount(repositoryCount: number) {
      assert.equal(repositoryCount > 0 && repositoryCount <= 50, true);
      return input.requestedTokens ?? 1;
    },
    async analyzeWithSingleRetry(
      batch: SemanticAnalyzerBatch,
      reserve: (attempt: PreparedAnalyzerAttempt) => AnalyzerReservationDecision | Promise<AnalyzerReservationDecision>,
    ): Promise<AnalyzerRunResult> {
      analyzerBatchCount += 1;
      const first = await reserveOnce(batch, reserve);
      if (first.decision.status === 'budget_exhausted') {
        return { status: 'budget_exhausted', attempts: 0, reason: first.decision.reason };
      }
      await input.analyzerGate;
      if (first.decision.status === 'admitted' && first.decision.signal?.aborted) {
        throw new Error('analyzer aborted');
      }
      if (input.analyzerMode === 'success' || input.analyzerMode === undefined ||
        (input.analyzerMode === 'retry_blocked_on_seventh' && analyzerBatchCount < 7)) {
        const start = batch.repositories[0]!.frozenIndex;
        const end = batch.repositories.at(-1)!.frozenIndex + 1;
        if (!input.splitFailureRanges?.includes(`${start}-${end}`)) return first.result!;
      } else if (!input.splitFailureRanges) {
        // Existing failure modes settle the page directly instead of exercising split recovery.
      } else {
        return first.result!;
      }
      if (input.analyzerMode === 'retry_prepare_failure') {
        return {
          status: 'analysis_failed',
          attempts: 1,
          firstError: new AnalyzerAttemptError('Analyzer output contract failed.'),
          secondError: new AnalyzerAttemptError(
            'Analyzer Provider preparation failed.',
            new AgentProviderError(
              'provider_request_too_large',
              'Prepared analyzer request exceeded the Provider boundary.',
            ),
            'provider',
          ),
        };
      }
      counters.reservations += 1;
      const second = await reserve({
        attempt: 2,
        batch,
        serializedRequestBytes: input.requestBytes ?? 1,
        requestedOutputTokens: input.requestedTokens ?? 1,
        serializedRequestBody: '{}',
        execute: async () => { throw new Error('not used by the scheduler harness'); },
      } as PreparedAnalyzerAttempt);
      if (second.status === 'budget_exhausted') {
        return { status: 'budget_exhausted', attempts: 1, reason: second.reason };
      }
      counters.executes += 1;
      if (input.analyzerMode === 'retry_success') {
        return { ...first.result!, attempts: 2 };
      }
      const providerCause = input.providerFailureCode
        ? new AgentProviderError(input.providerFailureCode, 'Provider failed.', 429)
        : undefined;
      const failure = new AnalyzerAttemptError(
        'Analyzer attempt failed.',
        providerCause,
        providerCause ? 'provider' : 'output_contract',
      );
      return {
        status: 'analysis_failed',
        attempts: 2,
        firstError: input.splitFailureRanges ? failure : new Error('first') as never,
        secondError: input.splitFailureRanges ? failure : new Error('second') as never,
      };
    },
  };
  let durableRevision = 1;

  const scheduler = createBgsmOrganizeJobScheduler({
    controller,
    createAnalyzer: async () => analyzer,
    requestedWindowSize: input.requestedWindowSize,
    createProposalId: () => parseProposalId(`proposal:v1:${runId}`),
    publishSnapshot: (snapshot) => publishedSnapshots.push(snapshot),
    issueContinuationCursor: async (_identity, index) => {
      nextFrozenIndex = index;
      return parseContinuationCursorToken(`cursor:v1:${runId}-${index}`);
    },
    setTimer: input.setTimer,
    clearTimer: () => {},
    heartbeat: input.heartbeat,
    setHeartbeatInterval: input.setHeartbeatInterval,
    clearHeartbeatInterval: input.clearHeartbeatInterval,
    now: () => 1_000,
    trace(event) {
      traceEvents.push(event);
      if (input.traceThrows) throw new Error('trace sink unavailable');
    },
    ...(input.durable ? {
      async initializeDurableRun({ state }: { state: { nextFrozenIndex: number } }) {
        durableCalls.push(`initialize:${state.nextFrozenIndex}`);
      },
      async reserveDurablePage({ startFrozenIndex, endFrozenIndexExclusive }: {
        startFrozenIndex: number;
        endFrozenIndexExclusive: number;
      }) {
        durableCalls.push(`reserve:${startFrozenIndex}-${endFrozenIndexExclusive}`);
        durableRevision += 1;
        return { leaseToken: `lease:${startFrozenIndex}`, revision: durableRevision };
      },
      async reserveDurableProviderAttempt({ state, previousUsage, lease }: {
        state: { usage: RunBudgetUsage };
        previousUsage: RunBudgetUsage;
        lease: { leaseToken: string; revision: number };
      }) {
        durableCalls.push(
          `attempt:${lease.leaseToken}:${previousUsage.providerAttempts}->${state.usage.providerAttempts}`,
        );
        if (input.durableAttemptError) throw input.durableAttemptError;
        durableRevision += 1;
        return { ...lease, revision: durableRevision };
      },
      async releaseDurablePage({ lease }: { lease: { leaseToken: string } }) {
        durableCalls.push(`release:${lease.leaseToken}`);
      },
      async checkpointDurablePage({ state, positions, lease }: {
        state: { nextFrozenIndex: number };
        positions: readonly OrganizeJobRunPagePosition[];
        lease: { leaseToken: string };
      }) {
        durableCalls.push(
          `checkpoint:${lease.leaseToken}:${positions[0]?.frozenIndex}-${state.nextFrozenIndex}`,
        );
      },
      async splitDurablePage({ state, lease }: {
        state: { analysisPendingRanges: readonly { startFrozenIndex: number; endFrozenIndexExclusive: number }[] };
        lease: { leaseToken: string };
      }) {
        durableCalls.push(
          `split:${lease.leaseToken}:${state.analysisPendingRanges
            .map((range) => `${range.startFrozenIndex}-${range.endFrozenIndexExclusive}`)
            .join(',')}`,
        );
        durableRevision += 1;
      },
    } : {}),
    async loadPage({ startFrozenIndex, endFrozenIndexExclusive }) {
      counters.reads += 1;
      loadedRanges.push(`${startFrozenIndex}-${endFrozenIndexExclusive}`);
      input.onLoadPage?.(counters.reads);
      const positions: OrganizeJobRunPagePosition[] = repositoryIds
        .slice(startFrozenIndex, endFrozenIndexExclusive)
        .map((repositoryId, offset) => {
          const frozenIndex = startFrozenIndex + offset;
          if (input.pageKind === 'missing') return { frozenIndex, repositoryId, kind: 'missing' };
          return {
            frozenIndex,
            repositoryId,
            kind: 'live',
            repository: {
              frozenIndex,
              repositoryId,
              sourceFingerprint: parseSourceFingerprintV1(`sf:v1:${'B'.repeat(43)}`),
              fullName: repositoryId,
              description: '',
              language: null,
              topics: [],
              stargazersCount: 0,
              pushedAt: null,
              createdAt: null,
              fork: false,
              archived: false,
              starredAt: '2026-01-01T00:00:00Z',
              tags: { manual: [], automatic: [] },
            },
          };
        });
      return {
        positions,
        taxonomy: { version: 1, entries: [] },
        policyTaxonomy: { version: 1, entries: [] },
        taxonomyFingerprint: parseTaxonomyFingerprintV1(`tf:v1:${'C'.repeat(43)}`),
      };
    },
  });
  return {
    scheduler,
    identity,
    counters,
    publishedSnapshots,
    durableCalls,
    loadedRanges,
    traceEvents,
    get reason() { return reason; },
    get nextIndex() { return nextFrozenIndex; },
  };
}

describe('production BGSM OrganizeJobRun scheduler call boundaries', () => {
  it('leases and checkpoints each exact scheduler page before admitting the next page', async () => {
    const run = createHarness({
      scopeCount: 75,
      requestedWindowSize: 50,
      pageKind: 'missing',
      durable: true,
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(run.durableCalls, [
      'initialize:0',
      'reserve:0-50',
      'checkpoint:lease:0:0-50',
      'reserve:50-75',
      'checkpoint:lease:50:50-75',
    ]);
    assert.equal(run.counters.reads, 2);
    assert.equal(run.counters.completions, 1);
  });

  it('keeps the extension worker active while a provider attempt is pending', async () => {
    let pulse: (() => void) | null = null;
    let releaseAnalyzer!: () => void;
    const analyzerGate = new Promise<void>((resolve) => {
      releaseAnalyzer = resolve;
    });
    const heartbeats: unknown[] = [];
    const cleared: unknown[] = [];
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      analyzerGate,
      heartbeat: (identity) => heartbeats.push(identity),
      setHeartbeatInterval(callback, delay) {
        assert.equal(delay, 20_000);
        pulse = callback;
        return 'organize-heartbeat';
      },
      clearHeartbeatInterval(timer) {
        cleared.push(timer);
      },
    });

    const pending = run.scheduler.schedule(run.identity);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(pulse);
    (pulse as () => void)();
    assert.deepEqual(heartbeats, [run.identity]);

    releaseAnalyzer();
    await pending;
    assert.deepEqual(cleared, ['organize-heartbeat']);
    assert.deepEqual(
      watchdogTraceEvents(run.traceEvents).map((event) => [event.watchdog, event.state, event.limitMs]),
      [
        ['organize_heartbeat', 'armed', 20_000],
        ['organize_wall_deadline', 'armed', 300_000],
        ['organize_heartbeat', 'progress', 20_000],
        ['organize_wall_deadline', 'cancelled', 300_000],
        ['organize_heartbeat', 'cancelled', 20_000],
      ],
    );
  });

  it('durably reserves both provider attempts before checkpointing a retry page', async () => {
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      analyzerMode: 'double_failure',
      durable: true,
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(run.durableCalls, [
      'initialize:0',
      'reserve:0-1',
      'attempt:lease:0:0->1',
      'attempt:lease:0:1->2',
      'checkpoint:lease:0:0-1',
    ]);
    assert.equal(run.counters.executes, 2);
  });

  it('isolates an output-contract failure with depth-first sibling ranges', async () => {
    const run = createHarness({
      scopeCount: 25,
      pageKind: 'live',
      durable: true,
      splitFailureRanges: ['0-25', '0-12', '0-6', '0-3'],
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(run.loadedRanges, [
      '0-25',
      '0-12',
      '0-6',
      '0-3',
      '0-1',
      '1-3',
      '3-6',
      '6-12',
      '12-25',
    ]);
    assert.equal(run.scheduler.getState(run.identity.runId)?.status, 'review');
    assert.equal(run.counters.completions, 1);
    assert.equal(
      run.traceEvents.filter((event) => event.type === 'batch_state' && event.state === 'split').length,
      4,
    );
    assert.ok(run.durableCalls.some((call) => call.startsWith('split:lease:0:0-12,12-25')));
  });

  it('degrades an isolated output-contract singleton and finishes every sibling range', async () => {
    const run = createHarness({
      scopeCount: 25,
      pageKind: 'live',
      durable: true,
      splitFailureRanges: ['0-25', '0-12', '0-6', '0-3', '0-1'],
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(run.loadedRanges, [
      '0-25',
      '0-12',
      '0-6',
      '0-3',
      '0-1',
      '1-3',
      '3-6',
      '6-12',
      '12-25',
    ]);
    const state = run.scheduler.getState(run.identity.runId);
    assert.equal(state?.status, 'review');
    assert.equal(state?.nextFrozenIndex, 25);
    assert.equal(
      state?.nonActionableAnalysisOutcomes.filter((row) => row.kind === 'insufficient_evidence').length,
      1,
    );
    assert.equal(state?.nonActionableAnalysisOutcomes.some((row) => row.kind === 'analysis_failed'), false);
    assert.equal(run.counters.completions, 1);
  });

  it('does not split authentication, rate-limit, or network failures', async () => {
    for (const code of ['http_error', 'network_error'] as const) {
      const run = createHarness({
        scopeCount: 25,
        pageKind: 'live',
        splitFailureRanges: ['0-25'],
        providerFailureCode: code,
      });
      await run.scheduler.schedule(run.identity);
      assert.deepEqual(run.loadedRanges, ['0-25']);
      assert.equal(run.scheduler.getState(run.identity.runId)?.status, 'analysis_blocked');
      assert.equal(
        run.traceEvents.some((event) => event.type === 'batch_state' && event.state === 'split'),
        false,
      );
    }
  });

  it('releases the durable page when attempt reservation fails before network execution', async () => {
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      durable: true,
      durableAttemptError: new Error('stale lease'),
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(run.durableCalls, [
      'initialize:0',
      'reserve:0-1',
      'attempt:lease:0:0->1',
      'release:lease:0',
    ]);
    assert.equal(run.counters.executes, 0);
  });

  it('traces a local-only batch from scheduling through completion', async () => {
    const run = createHarness({ scopeCount: 1, pageKind: 'missing' });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(
      run.traceEvents.map((event) => [event.type, event.state]),
      [
        ['batch_state', 'scheduled'],
        ['batch_state', 'loaded'],
        ['batch_state', 'local_only_completed'],
      ],
    );
  });

  it('traces a successful Provider batch with exact attempt ordering', async () => {
    const run = createHarness({ scopeCount: 1, pageKind: 'live' });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(
      run.traceEvents.map((event) => [event.type, event.state]),
      [
        ['batch_state', 'scheduled'],
        ['batch_state', 'loaded'],
        ['provider_attempt', 'prepared'],
        ['watchdog_state', 'armed'],
        ['provider_attempt', 'admitted'],
        ['provider_attempt', 'succeeded'],
        ['batch_state', 'provider_completed'],
        ['watchdog_state', 'cancelled'],
      ],
    );
    const succeeded = providerAttemptTraceEvents(run.traceEvents).find((event) => event.state === 'succeeded');
    assert.equal(succeeded?.attempt, 1);
    assert.equal(succeeded?.requestBytes, 1);
    assert.equal(succeeded?.requestedOutputTokens, 1);
  });

  it('closes the first Provider attempt before a successful retry', async () => {
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      analyzerMode: 'retry_success',
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(
      providerAttemptTraceEvents(run.traceEvents)
        .map((event) => [event.attempt, event.state, event.reasonCode]),
      [
        [1, 'prepared', null],
        [1, 'admitted', null],
        [1, 'failed', 'invalid_or_failed'],
        [2, 'prepared', null],
        [2, 'admitted', null],
        [2, 'succeeded', null],
      ],
    );
  });

  it('traces both terminal Provider failures and the failed batch', async () => {
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      analyzerMode: 'double_failure',
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(
      providerAttemptTraceEvents(run.traceEvents)
        .filter((event) => event.state === 'failed')
        .map((event) => [event.attempt, event.reasonCode]),
      [[1, 'invalid_or_failed'], [2, 'invalid_or_failed']],
    );
    assert.equal(
      run.traceEvents.filter((event) => event.type === 'batch_state').at(-1)?.state,
      'analysis_failed',
    );
  });

  it('terminalizes the executed attempt when retry preparation fails before reservation', async () => {
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      analyzerMode: 'retry_prepare_failure',
    });

    await run.scheduler.schedule(run.identity);

    assert.deepEqual(
      providerAttemptTraceEvents(run.traceEvents)
        .map((event) => [event.attempt, event.state, event.reasonCode]),
      [
        [1, 'prepared', null],
        [1, 'admitted', null],
        [1, 'failed', 'invalid_or_failed'],
      ],
    );
    assert.equal(
      run.traceEvents.filter((event) => event.type === 'batch_state').at(-1)?.state,
      'analysis_failed',
    );
  });

  it('traces reservation budget exhaustion before any Provider execution', async () => {
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      requestBytes: 8_388_609,
    });

    await run.scheduler.schedule(run.identity);

    assert.equal(run.counters.executes, 0);
    assert.deepEqual(
      providerAttemptTraceEvents(run.traceEvents)
        .map((event) => [event.state, event.reasonCode]),
      [['prepared', null], ['budget_exhausted', 'outbound_request_bytes']],
    );
    assert.equal(run.traceEvents.at(-1)?.state, 'budget_exhausted');
  });

  it('traces cancellation without converting it into a Provider failure', async () => {
    let releaseAnalyzer!: () => void;
    const analyzerGate = new Promise<void>((resolve) => {
      releaseAnalyzer = resolve;
    });
    const run = createHarness({ scopeCount: 1, pageKind: 'live', analyzerGate });
    const pending = run.scheduler.schedule(run.identity);
    await Promise.resolve();
    await Promise.resolve();

    run.scheduler.abort(run.identity.runId);
    releaseAnalyzer();
    await pending;

    assert.equal(
      providerAttemptTraceEvents(run.traceEvents).find((event) => event.state === 'cancelled')?.reasonCode,
      'aborted',
    );
    assert.deepEqual(
      watchdogTraceEvents(run.traceEvents).map((event) => [event.watchdog, event.state]),
      [
        ['organize_wall_deadline', 'armed'],
        ['organize_wall_deadline', 'cancelled'],
      ],
    );
  });

  it('keeps scheduler outcomes unchanged when the trace sink throws', async () => {
    const run = createHarness({ scopeCount: 1, pageKind: 'missing', traceThrows: true });

    await run.scheduler.schedule(run.identity);

    assert.equal(run.counters.completions, 1);
    assert.equal(run.counters.reads, 1);
  });

  it('stops after no-work completion and terminal rescheduling is idempotent', async () => {
    const run = createHarness({ scopeCount: 1, pageKind: 'missing' });
    await run.scheduler.schedule(run.identity);
    const settled = { ...run.counters };
    await run.scheduler.schedule(run.identity);
    assert.deepEqual(run.counters, settled);
    assert.deepEqual(settled, {
      reads: 1,
      reservations: 0,
      executes: 0,
      exhaustions: 0,
      completions: 1,
      continuations: 0,
    });
  });

  it('automatically publishes a continuation after a progressing generation exhausts its budget', async () => {
    const run = createHarness({
      scopeCount: 200,
      pageKind: 'live',
      analyzerMode: 'success',
      requestedTokens: 4_096,
    });
    await run.scheduler.schedule(run.identity);
    assert.equal(run.reason, 'requested_output_tokens');
    assert.equal(run.nextIndex, 175);
    assert.equal(run.counters.continuations, 1);
    assert.equal(run.publishedSnapshots.length, 1);
    assert.equal(run.publishedSnapshots[0]?.state, 'prepared');
  });

  it('reuses one provider runtime across internal continuation generations', async () => {
    const repositoryIds = Array.from({ length: 76 }, (_, index) => `owner/repo-${index}`);
    const scheduled: Promise<void>[] = [];
    let scheduler!: ReturnType<typeof createBgsmOrganizeJobScheduler>;
    let createAnalyzerCalls = 0;
    let providerExecutions = 0;
    let randomId = 0;
    const controller = createBgsmAgentController({
      resolveCandidate: async () => ({
        contract: { kind: 'all_live_stars' },
        repositoryIds,
        label: 'Current view',
        filterSnapshot: 'all',
      }),
      scheduleRun(identity) {
        const pending = scheduler.schedule(identity);
        scheduled.push(pending);
        return pending;
      },
      now: () => 1_000,
      randomId: () => `scheduler-continuation-${++randomId}`,
    });
    scheduler = createBgsmOrganizeJobScheduler({
      controller,
      requestedWindowSize: 25,
      async createAnalyzer() {
        createAnalyzerCalls += 1;
        if (createAnalyzerCalls > 1) {
          throw new Error('A continuation must not recreate its provider runtime.');
        }
        return createTwoAttemptAnalyzer(() => { providerExecutions += 1; });
      },
      issueContinuationCursor: (identity, nextFrozenIndex) => issueContinuationCursor(
        createFrozenScopeCursor(identity.runId, identity.generation, nextFrozenIndex),
        'scheduler-continuation-auth-key',
      ),
      createProposalId: () => parseProposalId(`proposal:v1:scheduler-continuation-${++randomId}`),
      now: () => 1_000,
      async loadPage({ startFrozenIndex, endFrozenIndexExclusive }) {
        const positions: OrganizeJobRunPagePosition[] = repositoryIds
          .slice(startFrozenIndex, endFrozenIndexExclusive)
          .map((repositoryId, offset) => {
            const frozenIndex = startFrozenIndex + offset;
            return {
              frozenIndex,
              repositoryId,
              kind: 'live',
              repository: {
                frozenIndex,
                repositoryId,
                sourceFingerprint: parseSourceFingerprintV1(`sf:v1:${'D'.repeat(43)}`),
                fullName: repositoryId,
                description: '',
                language: null,
                topics: [],
                stargazersCount: 0,
                pushedAt: null,
                createdAt: null,
                fork: false,
                archived: false,
                starredAt: '2026-01-01T00:00:00Z',
                tags: { manual: [], automatic: [] },
              },
            };
          });
        return {
          positions,
          taxonomy: { version: 1, entries: [] },
          policyTaxonomy: { version: 1, entries: [] },
          taxonomyFingerprint: parseTaxonomyFingerprintV1(`tf:v1:${'E'.repeat(43)}`),
        };
      },
    });

    const identity = {
      controllerId: parseControllerId('controller:v1:scheduler-continuation'),
      sessionId: 'scheduler-continuation-session',
    } as const;
    const preflight = await controller.issuePreflight(identity);
    assert.ok(preflight.preflightToken);
    controller.startRun(identity, preflight.preflightToken);

    for (let round = 0; round < 10; round += 1) {
      await Promise.resolve();
      await Promise.all([...scheduled]);
      await Promise.resolve();
      const latest = controller.findLatestSnapshot(identity);
      if (latest && ['completed', 'failed', 'review'].includes(latest.state)) break;
    }

    const latest = controller.findLatestSnapshot(identity);
    assert.ok(latest);
    assert.equal(latest.state, 'completed');
    assert.equal(latest.generation, 2);
    assert.equal(createAnalyzerCalls, 1);
    assert.equal(providerExecutions, 9);
  });

  it('does not auto-continue a wall deadline that made no repository progress', async () => {
    let deadline: (() => void) | null = null;
    let releaseAnalyzer!: () => void;
    const analyzerGate = new Promise<void>((resolve) => {
      releaseAnalyzer = resolve;
    });
    const run = createHarness({
      scopeCount: 1,
      pageKind: 'live',
      analyzerGate,
      setTimer(callback) {
        deadline = callback;
        return 1;
      },
    });
    const pending = run.scheduler.schedule(run.identity);
    await Promise.resolve();
    await Promise.resolve();
    const deadlineCallback: unknown = deadline;
    if (typeof deadlineCallback !== 'function') throw new Error('expected wall deadline timer');
    deadlineCallback();
    releaseAnalyzer();
    await pending;
    assert.equal(run.reason, 'wall_deadline');
    assert.equal(run.nextIndex, 0);
    assert.equal(run.counters.continuations, 0);
    assert.equal(run.publishedSnapshots.length, 0);
    assert.deepEqual(
      watchdogTraceEvents(run.traceEvents).map((event) => [event.watchdog, event.state, event.limitMs]),
      [
        ['organize_wall_deadline', 'armed', 300_000],
        ['organize_wall_deadline', 'expired', 300_000],
      ],
    );
  });

  it.each([
    ['consumed_positions', { scopeCount: 501, requestedWindowSize: 50, pageKind: 'missing' as const }, 10],
    ['analyzer_batches', { scopeCount: 21, requestedWindowSize: 1, pageKind: 'missing' as const }, 20],
  ] as const)('performs zero reads after %s exhaustion', async (expected, config, reads) => {
    const run = createHarness(config);
    await run.scheduler.schedule(run.identity);
    assert.equal(run.reason, expected);
    assert.equal(run.counters.reads, reads);
    const settled = { ...run.counters };
    await run.scheduler.schedule(run.identity);
    assert.deepEqual(run.counters, settled);
  });

  it.each([
    ['outbound_request_bytes', { analyzerMode: 'success' as const, requestBytes: 786_432, requestedTokens: 1 }, 11, 11, 10],
    ['requested_output_tokens', { analyzerMode: 'success' as const, requestBytes: 1, requestedTokens: 4_096 }, 7, 7, 7],
  ] as const)('blocks provider work after %s exhaustion', async (expected, analyzer, reads, reservations, executes) => {
    const run = createHarness({ scopeCount: 600, pageKind: 'live', ...analyzer });
    await run.scheduler.schedule(run.identity);
    assert.equal(run.reason, expected);
    assert.equal(run.counters.reads, reads);
    assert.equal(run.counters.reservations, reservations);
    assert.equal(run.counters.executes, executes);
    const settled = { ...run.counters };
    await run.scheduler.schedule(run.identity);
    assert.deepEqual(run.counters, settled);
  });

  it('blocks after the analyzer retry fails without pretending the full scope was covered', async () => {
    const run = createHarness({
      scopeCount: 600,
      pageKind: 'live',
      analyzerMode: 'double_failure',
      requestBytes: 1,
      requestedTokens: 1,
    });
    await run.scheduler.schedule(run.identity);

    assert.equal(run.reason, null);
    assert.equal(run.counters.reads, 1);
    assert.equal(run.counters.reservations, 2);
    assert.equal(run.counters.executes, 2);
    assert.equal(run.scheduler.getState(run.identity.runId)?.status, 'analysis_blocked');
    assert.equal(run.publishedSnapshots[0]?.state, 'analysis_blocked');
    assert.equal(run.publishedSnapshots[0]?.coverage?.analysisFailed, 25);
  });

  it('retains bounded terminal analysis state for continuation validation until release', async () => {
    const run = createHarness({
      scopeCount: 600,
      pageKind: 'live',
      analyzerMode: 'success',
      requestedTokens: 4_096,
    });
    await run.scheduler.schedule(run.identity);
    assert.equal(run.scheduler.getState(run.identity.runId)?.status, 'budget_exhausted');
    run.scheduler.release(run.identity.runId);
    assert.equal(run.scheduler.getState(run.identity.runId), null);
  });

  it('keeps a blocked retry page unconsumed with no second execute', async () => {
    const run = createHarness({
      scopeCount: 200,
      pageKind: 'live',
      analyzerMode: 'retry_blocked_on_seventh',
      requestedTokens: 4_096,
      durable: true,
    });
    await run.scheduler.schedule(run.identity);
    assert.equal(run.reason, 'requested_output_tokens');
    assert.equal(run.counters.reads, 7);
    assert.equal(run.counters.reservations, 8);
    assert.equal(run.counters.executes, 7);
    assert.equal(run.nextIndex, 150);
    assert.deepEqual(run.durableCalls.slice(-2), ['release:lease:150', 'continue']);
  });

  it('terminalizes wall expiry during a later DB read without another reservation or execute', async () => {
    let deadline: (() => void) | null = null;
    const run = createHarness({
      scopeCount: 2,
      requestedWindowSize: 1,
      pageKind: 'live',
      analyzerMode: 'success',
      setTimer(callback) {
        deadline = callback;
        return 1;
      },
      onLoadPage(readCount) {
        if (readCount === 2) deadline?.();
      },
    });
    await run.scheduler.schedule(run.identity);
    assert.equal(run.reason, 'wall_deadline');
    assert.equal(run.counters.reads, 2);
    assert.equal(run.counters.reservations, 1);
    assert.equal(run.counters.executes, 1);
    assert.equal(run.nextIndex, 1);
  });
});

function createTwoAttemptAnalyzer(onExecute: () => void) {
  return {
    requestedOutputTokens: 4_096,
    async analyzeWithSingleRetry(
      batch: SemanticAnalyzerBatch,
      reserve: (attempt: PreparedAnalyzerAttempt) => AnalyzerReservationDecision | Promise<AnalyzerReservationDecision>,
    ): Promise<AnalyzerRunResult> {
      for (const attempt of [1, 2] as const) {
        const decision = await reserve({
          attempt,
          batch,
          requestedOutputTokens: 4_096,
          serializedRequestBody: '{}',
          serializedRequestBytes: 1,
          execute: async () => { throw new Error('not used'); },
        });
        if (decision.status === 'budget_exhausted') {
          return { status: 'budget_exhausted', attempts: attempt - 1 as 0 | 1, reason: decision.reason };
        }
        onExecute();
      }
      return {
        status: 'success',
        attempts: 2,
        value: {
          proposal: {
            version: 1,
            runId: batch.runId,
            generation: batch.generation,
            scopeFingerprint: batch.scopeFingerprint,
            rows: batch.repositories.map((repository) => ({
              frozenIndex: repository.frozenIndex,
              repositoryId: repository.repositoryId,
              sourceFingerprint: repository.sourceFingerprint,
              classifications: [{ kind: 'unchanged', evidence: 'No useful change.' }],
            })),
          },
          telemetry: { inputTokens: null, outputTokens: null, totalTokens: null },
        },
      };
    },
  };
}
