import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  parseControllerId,
  parseContinuationCursorToken,
  parseOrganizeJobId,
  parseProposalId,
  parseRunId,
  parseScopeFingerprintV1,
  parseSourceFingerprintV1,
  parseTaxonomyFingerprintV1,
  validateOrganizeJobRunEvent,
  validateOrganizeJobRunSnapshot,
  type OrganizeProposal,
  type OrganizeJobRunSnapshot,
  type OrganizeJobRunEvent,
} from '@/bgsm-agent';
import { createFrozenScope } from '@/bgsm-agent/scope';
import { createProductionRunBudget } from '@/bgsm-agent/policy';
import { restoreOrganizeJobRunAnalysisState } from '@/bgsm-agent/organize-job';
import {
  createBgsmAgentController,
  incrementRunGeneration,
} from '@/background/organize-job-controller';
import type { ResolvedLaunchCandidate } from '@/background/query';

const controllerId = parseControllerId('controller:v1:test-controller');
const sourceFingerprint = parseSourceFingerprintV1(`sf:v1:${'A'.repeat(43)}`);
const taxonomyFingerprint = parseTaxonomyFingerprintV1(`tf:v1:${'B'.repeat(43)}`);
const candidate: ResolvedLaunchCandidate = {
  contract: { kind: 'all_live_stars' },
  repositoryIds: ['owner/repo'],
  label: 'All starred repositories',
  filterSnapshot: 'All live stars',
};

function proposal(runId: OrganizeProposal['runId'], generation: number): OrganizeProposal {
  return {
    version: 1,
    proposalId: parseProposalId('proposal:v1:test-proposal'),
    runId,
    generation,
    rows: [{
      proposalRowId: 'row-1',
      frozenIndex: 0,
      repositoryId: 'owner/repo',
      sourceFingerprint,
      taxonomyFingerprint,
      actions: [{ kind: 'add_existing_tag', tag: 'react', evidence: 'Repository topics include react.' }],
    }],
  };
}

function recordActionableCoverage(
  controller: ReturnType<typeof createBgsmAgentController>,
  snapshot: OrganizeJobRunSnapshot,
): OrganizeJobRunSnapshot {
  return controller.updateAnalysisProgress(snapshot, {
    ...snapshot.usage,
    consumedFrozenPositions: snapshot.frozenScope.count,
  }, {
    total: snapshot.frozenScope.count,
    analyzed: snapshot.frozenScope.count,
    actionable: snapshot.frozenScope.count,
    unchanged: 0,
    insufficientEvidence: 0,
    missing: 0,
    tombstoned: 0,
    analysisFailed: 0,
  });
}

describe('BGSM Agent background controller', () => {
  it('rejects a resolver that returns anything other than the whole starred library', async () => {
    const controller = createBgsmAgentController({
      resolveCandidate: async () => ({
        contract: { kind: 'selected_repository', selectedRepositoryIdHint: 'owner/repo' },
        repositoryIds: ['owner/repo'],
        label: 'owner/repo',
        filterSnapshot: 'owner/repo',
      }),
    });

    await assert.rejects(
      controller.issuePreflight({ controllerId, sessionId: 'local-scope-rejected' }),
      /only accepts the whole starred library/u,
    );
  });

  it('restores a durable review as summary authority without serializing full rows', () => {
    const restoredRunId = parseRunId('run:v1:restored-review');
    const restoredProposalId = parseProposalId('proposal:v1:restored-review');
    const frozenScope = createFrozenScope({
      kind: 'all_live_stars',
      label: 'All starred repositories',
      filterSnapshot: 'All live stars',
      repositoryIds: ['owner/repo'],
      capturedAt: 1,
      fingerprint: parseScopeFingerprintV1(`fs:v1:${'C'.repeat(43)}`),
    });
    const analysis = restoreOrganizeJobRunAnalysisState({
      runId: restoredRunId,
      generation: 3,
      proposalId: restoredProposalId,
      frozenScope,
      budget: createProductionRunBudget(),
      usage: {
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 1,
        analyzerBatches: 1,
        providerAttempts: 1,
        serializedOutboundRequestBytes: 10,
        requestedOutputTokens: 10,
      },
      nextFrozenIndex: 1,
      status: 'review',
      analyzedFrozenPositions: [{
        frozenIndex: 0,
        repositoryId: 'owner/repo',
        classification: 'actionable',
      }],
      nonActionableAnalysisOutcomes: [],
      actionableProposalRows: [{
        proposalRowId: `${restoredProposalId}:row:0`,
        frozenIndex: 0,
        repositoryId: 'owner/repo',
        sourceFingerprint,
        taxonomyFingerprint,
        actions: [{ kind: 'add_existing_tag', tag: 'react', evidence: 'Repository topic.' }],
      }],
    });
    const controller = createBgsmAgentController({
      resolveCandidate: async () => candidate,
    });
    const snapshot = controller.restoreAnalysisRun({
      jobId: parseOrganizeJobId('organize-job:v1:restored-review'),
      identity: {
        controllerId,
        sessionId: 'restored-session',
        runId: restoredRunId,
        generation: 3,
      },
      state: analysis,
      taskInstruction: 'Organize all tags.',
    });
    validateOrganizeJobRunSnapshot(snapshot);
    assert.equal(snapshot.state, 'review');
    assert.equal(snapshot.proposalReviewSummary?.totalRows, 1);
    assert.equal(JSON.stringify(snapshot).includes('sourceFingerprint'), false);
    assert.equal(JSON.stringify(snapshot).includes('taxonomyFingerprint'), false);
  });

  it('rejects exhausted generations before allocating run authority', () => {
    assert.equal(incrementRunGeneration(0), 1);
    assert.throws(
      () => incrementRunGeneration(Number.MAX_SAFE_INTEGER),
      /cannot be incremented safely/u,
    );
  });

  it('namespaces event IDs by controller epoch while preserving local order', async () => {
    const collectEventIds = async (eventEpoch: string) => {
      const events: OrganizeJobRunEvent[] = [];
      let id = 0;
      const controller = createBgsmAgentController({
        resolveCandidate: async () => candidate,
        emit: (event) => { events.push(event); },
        randomId: () => `event-test-${++id}`,
        eventEpoch,
      });
      const identity = { controllerId, sessionId: `event-session-${eventEpoch}` } as const;
      const issued = await controller.issuePreflight(identity, {
        jobId: parseOrganizeJobId(`organize-job:v1:${eventEpoch}`),
      });
      if (!issued.preflightToken) throw new Error('Expected event test preflight.');
      const snapshot = controller.startRun(identity, issued.preflightToken);
      controller.setRunState(snapshot, 'checking_provider');
      controller.setRunState(snapshot, 'analyzing');
      return events.map((event) => event.eventId);
    };

    assert.deepEqual(await collectEventIds('worker-a'), [
      'event:v1:worker-a:1',
      'event:v1:worker-a:2',
    ]);
    assert.deepEqual(await collectEventIds('worker-b'), [
      'event:v1:worker-b:1',
      'event:v1:worker-b:2',
    ]);
  });

  it('freezes a full candidate and production budget in the same synchronous token-consume mutation', async () => {
    const lifecycle: string[] = [];
    let scheduled = 0;
    let id = 0;
    const controller = createBgsmAgentController({
      resolveCandidate: async () => candidate,
      scheduleRun: () => { scheduled += 1; },
      onLifecycle: (name) => lifecycle.push(name),
      now: () => 100,
      randomId: () => `id-${++id}`,
      setTimer: () => `timer-${id}`,
      clearTimer: () => {},
    });
    const identity = { controllerId, sessionId: 'session-1' } as const;
    const jobId = parseOrganizeJobId('organize-job:v1:preallocated-freeze');
    const issued = await controller.issuePreflight(identity, {
      requestId: 'preflight-request:freeze',
      jobId,
    });
    assert.equal(issued.status, 'ready');
    assert.equal(issued.jobId, jobId);
    assert.equal(scheduled, 0);
    assert.deepEqual(lifecycle, ['preflight_issued']);
    assert.ok(issued.preflightToken);

    const snapshot = controller.startRun(identity, issued.preflightToken);
    validateOrganizeJobRunSnapshot(snapshot);
    assert.equal(snapshot.state, 'frozen');
    assert.equal(snapshot.frozenScope.count, 1);
    assert.equal('repositoryIds' in snapshot.frozenScope, false);
    assert.deepEqual(
      controller.getExecutionContext(snapshot).frozenScope.repositoryIds,
      ['owner/repo'],
    );
    assert.equal(controller.getExecutionContext(snapshot).jobId, jobId);
    assert.equal(snapshot.budget.maxConsumedFrozenPositions, 500);
    assert.deepEqual(lifecycle, ['preflight_issued', 'token_consumed_frozen_and_budgeted']);
    assert.throws(() => controller.startRun(identity, issued.preflightToken!), /already consumed/u);
    await Promise.resolve();
    assert.equal(scheduled, 1);
  });

  it('supersedes, cancels, and expires provisional preflights with their immutable job identity', async () => {
    const lifecycle: Array<Readonly<{ jobId: string; state: string }>> = [];
    const timers: Array<() => void> = [];
    let id = 0;
    const controller = createBgsmAgentController({
      resolveCandidate: async () => candidate,
      randomId: () => `preflight-${++id}`,
      now: () => 100,
      preflightTtlMs: 10,
      setTimer: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimer: () => {},
      onPreflightState: (event) => lifecycle.push(event),
    });
    const identity = { controllerId, sessionId: 'preflight-lifecycle' } as const;
    const first = await controller.issuePreflight(identity, {
      requestId: 'request:first',
      jobId: parseOrganizeJobId('organize-job:v1:first'),
    });
    assert.deepEqual(controller.findReadyPreflight(identity), {
      requestId: 'request:first',
      preflightToken: first.preflightToken,
      label: candidate.label,
      count: candidate.repositoryIds.length,
    });
    const second = await controller.issuePreflight(identity, {
      requestId: 'request:second',
      jobId: parseOrganizeJobId('organize-job:v1:second'),
    });
    assert.ok(first.preflightToken && second.preflightToken);
    assert.equal(controller.findReadyPreflight(identity)?.requestId, 'request:second');
    assert.throws(() => controller.startRun(identity, first.preflightToken!), /invalid or stale/u);
    assert.equal(controller.cancelPreflight(identity, 'request:second'), true);
    assert.equal(controller.findReadyPreflight(identity), null);
    assert.equal(controller.cancelPreflight(identity, 'request:second'), false);

    await controller.issuePreflight(identity, {
      requestId: 'request:third',
      jobId: parseOrganizeJobId('organize-job:v1:third'),
    });
    timers.at(-1)?.();
    assert.equal(controller.findReadyPreflight(identity), null);

    assert.deepEqual(lifecycle.map(({ jobId, state }) => [jobId, state]), [
      ['organize-job:v1:first', 'ready'],
      ['organize-job:v1:first', 'stale'],
      ['organize-job:v1:second', 'ready'],
      ['organize-job:v1:second', 'cancelled'],
      ['organize-job:v1:third', 'ready'],
      ['organize-job:v1:third', 'expired'],
    ]);
  });

  it('acknowledges a consumed preflight idempotently after the in-memory record is closed', async () => {
    const controller = createBgsmAgentController({
      resolveCandidate: async () => candidate,
      now: () => 100,
      setTimer: () => null,
      clearTimer: () => {},
    });
    const identity = { controllerId, sessionId: 'preflight-ack-idempotent' } as const;
    const issued = await controller.issuePreflight(identity, {
      requestId: 'request:ack-idempotent',
      jobId: parseOrganizeJobId('organize-job:v1:ack-idempotent'),
    });
    assert.ok(issued.preflightToken);
    assert.equal(controller.acknowledgePreflightStarted(identity, issued.preflightToken), true);
    assert.equal(controller.acknowledgePreflightStarted(identity, issued.preflightToken), true);
    assert.throws(
      () => controller.acknowledgePreflightStarted(
        { controllerId, sessionId: 'another-session' },
        issued.preflightToken!,
      ),
      /belongs to another controller\/session/u,
    );
  });

  it('keeps request order authoritative when concurrent preflights resolve out of order', async () => {
    let resolveFirst!: (value: ResolvedLaunchCandidate) => void;
    let resolveSecond!: (value: ResolvedLaunchCandidate) => void;
    const candidates = [
      new Promise<ResolvedLaunchCandidate>((resolve) => { resolveFirst = resolve; }),
      new Promise<ResolvedLaunchCandidate>((resolve) => { resolveSecond = resolve; }),
    ];
    const lifecycle: Array<Readonly<{ jobId: string; state: string; repositoryCount: number }>> = [];
    let candidateIndex = 0;
    const controller = createBgsmAgentController({
      resolveCandidate: async () => candidates[candidateIndex++]!,
      setTimer: () => null,
      clearTimer: () => {},
      onPreflightState: (event) => lifecycle.push(event),
    });
    const identity = { controllerId, sessionId: 'preflight-request-order' } as const;
    const first = controller.issuePreflight(identity, {
      requestId: 'request:first-pending',
      jobId: parseOrganizeJobId('organize-job:v1:first-pending'),
    });
    await Promise.resolve();
    const second = controller.issuePreflight(identity, {
      requestId: 'request:second-pending',
      jobId: parseOrganizeJobId('organize-job:v1:second-pending'),
    });

    resolveSecond(candidate);
    const ready = await second;
    resolveFirst(candidate);

    assert.equal(ready.jobId, 'organize-job:v1:second-pending');
    await assert.rejects(first, /preflight request is stale/u);
    assert.deepEqual(lifecycle.map(({ jobId, state, repositoryCount }) => [jobId, state, repositoryCount]), [
      ['organize-job:v1:first-pending', 'stale', 0],
      ['organize-job:v1:second-pending', 'ready', 1],
    ]);
  });

  it('publishes only durable proposal summary authority and validates FrozenScope positions', async () => {
    const events: OrganizeJobRunEvent[] = [];
    let id = 0;
    const controller = createBgsmAgentController({
      resolveCandidate: async () => candidate,
      emit: (event) => { events.push(event); },
      randomId: () => `durable-${++id}`,
    });
    const identity = { controllerId, sessionId: 'durable-review' } as const;
    const preflight = await controller.issuePreflight(identity);
    if (!preflight.preflightToken) throw new Error('expected preflight token');
    const frozen = controller.startRun(identity, preflight.preflightToken);
    const authoritativeProposal = proposal(frozen.runId, frozen.generation);
    const analyzed = recordActionableCoverage(controller, frozen);
    const continuationCursor = parseContinuationCursorToken('cursor:v1:proposal-limit');

    assert.throws(() => controller.registerDurableProposal(analyzed, {
      ...authoritativeProposal,
      rows: [{ ...authoritativeProposal.rows[0]!, repositoryId: 'other/repo' }],
    }), /FrozenScope position/u);

    const review = controller.registerDurableProposal(
      analyzed,
      authoritativeProposal,
      continuationCursor,
    );
    validateOrganizeJobRunSnapshot(review);
    assert.equal(review.state, 'review');
    assert.equal(review.proposalId, authoritativeProposal.proposalId);
    assert.equal(review.proposalReviewSummary?.totalRows, 1);
    assert.equal(review.continuationCursor, continuationCursor);
    assert.equal(JSON.stringify(review).includes('sourceFingerprint'), false);
    assert.equal(JSON.stringify(review).includes('taxonomyFingerprint'), false);

    const proposalEvent = events.find((event) => event.type === 'proposal_summary_ready');
    assert.ok(proposalEvent);
    validateOrganizeJobRunEvent(proposalEvent);
  });

});
