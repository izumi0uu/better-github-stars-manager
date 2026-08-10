import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { sourceFingerprintV1 } from '@/bgsm-agent/source-fingerprint';
import {
  buildSemanticPolicyTaxonomyFromStorage,
  fingerprintSemanticTaxonomy,
} from '@/bgsm-agent/semantic-dto';
import { parseProposalId, parseRunId } from '@/bgsm-agent/identity';
import { createEmptyRunBudgetUsage, createProductionRunBudget } from '@/bgsm-agent/policy';
import { db } from '@/storage/db';
import { createAgentSession, deleteAgentSession } from '@/storage/agent-session-store';
import { idbTagStore, resetDirtyForDev } from '@/storage/idb-tag-store';
import {
  activateOrganizePreflight,
  advanceOrganizeJobRun,
  bindOrganizeJobProvider,
  cancelOrganizePreflight,
  checkpointOrganizeAnalysisPage,
  cancelOrganizeJob,
  claimOrganizeAnalysisBatch,
  claimOrganizeApplyChunk,
  completeOrganizeJobWithoutApply,
  createOrganizeJob as createStoredOrganizeJob,
  createOrganizePreflight as createStoredOrganizePreflight,
  dismissTerminalOrganizeJob,
  getActiveOrganizeJob,
  getOrganizeCoverage,
  getOrganizeJob,
  getReadyOrganizePreflight,
  getOrganizeReceipt,
  getOrganizeReviewPage,
  getOrganizeTaxonomy,
  recoverExpiredOrganizeLeases,
  releaseOrganizeAnalysisPage,
  releaseOrganizeJobLeases,
  requestOrganizeApplyPause,
  resumeOrganizeApply,
  reserveOrganizeAnalysisPage,
  reserveOrganizeAnalysisProviderAttempt,
  restoreOrganizeAnalysisCheckpoint,
  retryOrganizeAnalysisFromFirstFailure,
  sealOrganizeApply,
  settleOrganizeAnalysisBatch,
  settleOrganizeApplyChunk,
  splitOrganizeAnalysisPage,
  updateOrganizeSelection,
  takeControlOrganizeJob,
} from '@/storage/organize-job-store';
import { fakeStar } from './test-utils';

async function createOrganizeJob(input: Parameters<typeof createStoredOrganizeJob>[0]) {
  await ensureAgentSession(input.sessionId);
  return createStoredOrganizeJob(input);
}

async function createOrganizePreflight(input: Parameters<typeof createStoredOrganizePreflight>[0]) {
  await ensureAgentSession(input.sessionId);
  return createStoredOrganizePreflight(input);
}

async function ensureAgentSession(sessionId: string): Promise<void> {
  if (!await db.agentSessions.get(sessionId)) {
    await createAgentSession({ idFactory: () => sessionId });
  }
}

describe('durable whole-library organize job store', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    resetDirtyForDev();
  });

  afterAll(async () => {
    await db.close();
  });

  it('freezes 101 rows, analyzes in bounded batches, and applies in 100-row chunks', async () => {
    const repositoryIds = Array.from({ length: 101 }, (_, index) => `owner/repo-${index}`);
    const stars = repositoryIds.map((full_name) => fakeStar({ full_name }));
    await db.stars.bulkPut(stars);
    await db.tagMeta.put({
      name: 'blocked',
      dimension: null,
      color: null,
      excluded: true,
      mtime: '2026-07-18T00:00:00.000Z',
    });
    const fingerprints = new Map(await Promise.all(stars.map(async (star) => (
      [star.full_name, await sourceFingerprintV1(star, undefined)] as const
    ))));
    const policyTaxonomy = buildSemanticPolicyTaxonomyFromStorage(await db.tagMeta.toArray(), []);
    const taxonomy = {
      fingerprint: await fingerprintSemanticTaxonomy(policyTaxonomy),
      snapshot: { policyTaxonomy },
    };
    const job = await createOrganizeJob(jobInput(repositoryIds, taxonomy));

    assert.equal((await getActiveOrganizeJob())?.jobId, job.jobId);
    assert.equal((await getOrganizeTaxonomy(job.jobId))?.fingerprint, taxonomy.fingerprint);
    await assert.rejects(() => createOrganizeJob(jobInput(['owner/duplicate'])), /active job/u);
    await assert.rejects(
      () => claimOrganizeAnalysisBatch(job.jobId, 51, { ownerId: 'analysis-1' }),
      /between 1 and 50/u,
    );

    let claim = await claimOrganizeAnalysisBatch(job.jobId, undefined, {
      ownerId: 'analysis-1',
      now: 100,
    });
    assert.equal(claim?.items.length, 25);
    while (claim) {
      await settleOrganizeAnalysisBatch({
        jobId: job.jobId,
        leaseToken: claim.leaseToken,
        now: 200 + claim.items[0]!.position,
        outcomes: claim.items.map((item) => ({
          position: item.position,
          state: 'actionable' as const,
          sourceFingerprint: fingerprints.get(item.fullName)!,
          proposedActions: [
            {
              kind: item.position === 0 ? 'add_existing_tag' : 'propose_new_tag',
              tag: item.position === 0 ? 'blocked' : 'organized',
              evidence: `Frozen evidence for ${item.fullName}`,
            },
            ...(item.position === 1 ? [{
              kind: 'propose_new_tag' as const,
              tag: 'secondary',
              evidence: 'Secondary frozen evidence.',
            }] : []),
          ],
        })),
      });
      claim = await claimOrganizeAnalysisBatch(job.jobId, 50, {
        ownerId: 'analysis-1',
        now: 500 + (claim.items.at(-1)?.position ?? 0),
      });
    }

    assert.deepEqual(await getOrganizeCoverage(job.jobId), {
      total: 101,
      pending: 0,
      leased: 0,
      actionable: 101,
      unchanged: 0,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      failed: 0,
      analyzed: 101,
      complete: true,
    });
    const firstPage = await getOrganizeReviewPage(job.jobId, null, 100);
    const secondPage = await getOrganizeReviewPage(job.jobId, firstPage.nextCursor, 100);
    assert.equal(firstPage.rows.length, 100);
    assert.equal(firstPage.rows[0]?.proposedActions[0]?.evidence, 'Frozen evidence for owner/repo-0');
    assert.equal(secondPage.rows.length, 1);

    const initialReview = (await getOrganizeJob(job.jobId))!;
    await updateOrganizeSelection({
      jobId: job.jobId,
      expectedRevision: initialReview.revision,
      selections: [{
        position: 1,
        selected: true,
        approvedActions: [firstPage.rows[1]!.proposedActions[0]!],
      }],
    });
    const reviewed = (await getOrganizeJob(job.jobId))!;
    const apply = await sealOrganizeApply(job.jobId, reviewed.revision, 1_000);
    assert.equal(apply.rowCount, 101);
    assert.equal((await getActiveOrganizeJob())?.jobId, job.jobId);
    await assert.rejects(() => claimOrganizeApplyChunk(apply.applyId, 101), /between 1 and 100/u);

    const firstApply = await claimOrganizeApplyChunk(apply.applyId, 100, {
      ownerId: 'apply-1',
      now: 1_100,
    });
    assert.equal(firstApply?.rows.length, 100);
    assert.equal(await claimOrganizeApplyChunk(apply.applyId, 100, {
      ownerId: 'competing-apply',
      now: 1_101,
    }), null);
    assert.equal(firstApply?.rows[0]?.approvedActions[0]?.evidence, 'Frozen evidence for owner/repo-0');
    assert.deepEqual(firstApply?.rows[1]?.approvedAdditions, ['organized']);
    const firstSettlement = await settleOrganizeApplyChunk({
      applyId: apply.applyId,
      leaseToken: firstApply!.leaseToken,
      now: 1_200,
    });
    assert.equal(firstSettlement.complete, false);

    const secondApply = await claimOrganizeApplyChunk(apply.applyId, 100, {
      ownerId: 'apply-1',
      durationMs: 10,
      now: 1_300,
    });
    assert.equal(secondApply?.rows.length, 1);
    await assert.rejects(
      () => settleOrganizeApplyChunk({
        applyId: apply.applyId,
        leaseToken: secondApply!.leaseToken,
        now: 1_311,
      }),
      /lease has expired/u,
    );
    assert.deepEqual(await recoverExpiredOrganizeLeases(1_311), { analysis: 0, apply: 1 });
    const recoveredApply = await claimOrganizeApplyChunk(apply.applyId, 100, {
      ownerId: 'apply-2',
      now: 1_320,
    });
    const secondSettlement = await settleOrganizeApplyChunk({
      applyId: apply.applyId,
      leaseToken: recoveredApply!.leaseToken,
      now: 1_400,
    });
    assert.equal(secondSettlement.complete, true);

    const receipt = await getOrganizeReceipt(apply.applyId);
    assert.deepEqual(receipt?.counts, {
      changed: 100,
      unchanged: 0,
      skipped: 1,
      failed: 0,
      pending: 0,
    });
    assert.equal((await db.tagMeta.get('blocked'))?.excluded, true);
    assert.equal((await db.tags.get('owner/repo-0'))?.manualTags.includes('blocked'), undefined);
    assert.equal(await db.tagDirtyOutbox.count(), 100);
    assert.equal(await getActiveOrganizeJob(), undefined);

    const terminalJob = (await getOrganizeJob(job.jobId))!;
    assert.equal(await dismissTerminalOrganizeJob({
      jobId: terminalJob.jobId,
      expectedRevision: terminalJob.revision,
    }), true);
    assert.equal(await getOrganizeJob(job.jobId), undefined);
    assert.equal(await getOrganizeTaxonomy(job.jobId), undefined);
    assert.equal(await getOrganizeReceipt(apply.applyId), undefined);
    assert.equal(await db.organizeItems.where('jobId').equals(job.jobId).count(), 0);
    assert.equal(await db.organizeApplies.get(apply.applyId), undefined);
    assert.equal(await db.organizeApplyRows.where('applyId').equals(apply.applyId).count(), 0);
  }, 20_000);

  it('blocks review when terminal analysis failures leave incomplete coverage', async () => {
    const runId = parseRunId('run:v1:blocked-at-end');
    const job = await createOrganizeJob({
      ...jobInput(['owner/fails']),
      runId,
      proposalId: parseProposalId('proposal:v1:blocked-at-end'),
      budget: createProductionRunBudget(),
      usage: createEmptyRunBudgetUsage(),
    });
    const claim = await claimOrganizeAnalysisBatch(job.jobId, 25, { ownerId: 'analysis' });
    await settleOrganizeAnalysisBatch({
      jobId: job.jobId,
      leaseToken: claim!.leaseToken,
      outcomes: [{ position: 0, state: 'failed', failure: 'provider_failed' }],
    });

    const coverage = await getOrganizeCoverage(job.jobId);
    assert.equal(coverage.failed, 1);
    assert.equal(coverage.complete, false);
    assert.equal((await getOrganizeJob(job.jobId))?.status, 'analysis_blocked');
    await assert.rejects(() => advanceOrganizeJobRun({
      jobId: job.jobId,
      runId: parseRunId('run:v1:blocked-at-end-child'),
      generation: 2,
      expectedParent: { runId, generation: 1 },
      proposalId: parseProposalId('proposal:v1:blocked-at-end-child'),
      budget: createProductionRunBudget(),
      usage: createEmptyRunBudgetUsage(),
      startFrozenIndex: 1,
      analysisPendingRanges: [],
    }), /actively analyzing/u);
  });

  it('snapshots organization preferences and reconciles tag coverage across persisted pages', async () => {
    const repositoryIds = ['owner/a', 'owner/b', 'owner/c', 'owner/d'];
    const requestedPolicy = { maxTagsPerRepo: 2, minTopicRepoCount: 3 };
    const preflight = await createOrganizePreflight(preflightInput(repositoryIds, {
      tagPolicy: requestedPolicy,
    }));
    requestedPolicy.maxTagsPerRepo = 5;
    requestedPolicy.minTopicRepoCount = 1;
    const activated = await activateOrganizePreflight({
      preflightToken: preflight.preflight!.token,
      controllerId: preflight.controllerId,
      sessionId: preflight.sessionId,
      taskInstruction: preflight.taskInstruction,
      now: 10,
    });
    assert.deepEqual(activated.job.tagPolicy, {
      maxTagsPerRepo: 2,
      minTopicRepoCount: 3,
    });

    const action = (tag: string) => ({
      kind: 'propose_new_tag' as const,
      tag,
      evidence: `${tag} evidence.`,
    });
    const first = await claimOrganizeAnalysisBatch(preflight.jobId, 2, {
      ownerId: 'coverage-worker',
      now: 20,
    });
    await settleOrganizeAnalysisBatch({
      jobId: preflight.jobId,
      leaseToken: first!.leaseToken,
      now: 30,
      outcomes: [
        {
          position: 0,
          state: 'actionable',
          sourceFingerprint: 'source:a',
          proposedActions: [action('Shared'), action('Rare')],
        },
        {
          position: 1,
          state: 'actionable',
          sourceFingerprint: 'source:b',
          proposedActions: [action('shared')],
        },
      ],
    });
    assert.equal((await getOrganizeJob(preflight.jobId))?.status, 'analyzing');

    const second = await claimOrganizeAnalysisBatch(preflight.jobId, 2, {
      ownerId: 'coverage-worker',
      now: 40,
    });
    const coverage = await settleOrganizeAnalysisBatch({
      jobId: preflight.jobId,
      leaseToken: second!.leaseToken,
      now: 50,
      outcomes: [
        {
          position: 2,
          state: 'actionable',
          sourceFingerprint: 'source:c',
          proposedActions: [action('SHARED')],
        },
        {
          position: 3,
          state: 'actionable',
          sourceFingerprint: 'source:d',
          proposedActions: [action('rare')],
        },
      ],
    });

    assert.deepEqual(coverage, {
      total: 4,
      pending: 0,
      leased: 0,
      actionable: 3,
      unchanged: 0,
      insufficientEvidence: 1,
      missing: 0,
      tombstoned: 0,
      failed: 0,
      analyzed: 4,
      complete: true,
    });
    const restored = await restoreOrganizeAnalysisCheckpoint(preflight.jobId);
    assert.deepEqual(restored.job.tagPolicy, {
      maxTagsPerRepo: 2,
      minTopicRepoCount: 3,
    });
    assert.deepEqual(restored.items.map((row) => ({
      position: row.position,
      state: row.analysisState,
      tags: row.proposedActions.map((entry) => entry.tag),
    })), [
      { position: 0, state: 'actionable', tags: ['Shared'] },
      { position: 1, state: 'actionable', tags: ['shared'] },
      { position: 2, state: 'actionable', tags: ['SHARED'] },
      { position: 3, state: 'insufficient_evidence', tags: [] },
    ]);

    const reviewJob = (await getOrganizeJob(preflight.jobId))!;
    const apply = await sealOrganizeApply(preflight.jobId, reviewJob.revision, 60);
    assert.equal(apply.rowCount, 3);
    const applyRows = await db.organizeApplyRows.where('applyId').equals(apply.applyId).sortBy('position');
    assert.deepEqual(applyRows.map((row) => row.approvedAdditions), [
      ['Shared'],
      ['shared'],
      ['SHARED'],
    ]);
  });

  it('normalizes a legacy job without a tag policy to the default shared coverage', async () => {
    const job = await createOrganizeJob(jobInput(['owner/legacy-policy']));
    await db.organizeJobs.update(job.jobId, { tagPolicy: undefined });
    const batch = await claimOrganizeAnalysisBatch(job.jobId, 1, {
      ownerId: 'legacy-policy-worker',
      now: 20,
    });

    const coverage = await settleOrganizeAnalysisBatch({
      jobId: job.jobId,
      leaseToken: batch!.leaseToken,
      now: 30,
      outcomes: [{
        position: 0,
        state: 'actionable',
        sourceFingerprint: 'source:legacy-policy',
        proposedActions: [{
          kind: 'propose_new_tag',
          tag: 'single-use',
          evidence: 'Only one repository proposed this tag.',
        }],
      }],
    });

    assert.equal(coverage.actionable, 0);
    assert.equal(coverage.insufficientEvidence, 1);
    assert.deepEqual((await getOrganizeJob(job.jobId))?.tagPolicy, {
      maxTagsPerRepo: 5,
      minTopicRepoCount: 3,
    });
  });

  it('recovers expired leases and rejects settlement from the stale claimant', async () => {
    const job = await createOrganizeJob(jobInput(['owner/missing', 'owner/tombstoned']));
    const stale = await claimOrganizeAnalysisBatch(job.jobId, 25, {
      ownerId: 'dead-worker',
      durationMs: 10,
      now: 100,
    });
    await assert.rejects(
      () => settleOrganizeAnalysisBatch({
        jobId: job.jobId,
        leaseToken: stale!.leaseToken,
        now: 111,
        outcomes: stale!.items.map((item) => ({ position: item.position, state: 'missing' as const })),
      }),
      /lease has expired/u,
    );
    assert.deepEqual(await recoverExpiredOrganizeLeases(111), { analysis: 2, apply: 0 });
    await ensureAgentSession('session:replacement');
    const recoveredJob = (await getOrganizeJob(job.jobId))!;
    const attached = await takeControlOrganizeJob({
      jobId: job.jobId,
      controllerId: 'controller:replacement',
      sessionId: 'session:replacement',
      expectedRevision: recoveredJob.revision,
      now: 111,
    });
    assert.equal(attached.controllerId, 'controller:replacement');
    const recovered = await claimOrganizeAnalysisBatch(job.jobId, 25, {
      ownerId: 'replacement-worker',
      now: 112,
    });
    await assert.rejects(
      () => settleOrganizeAnalysisBatch({
        jobId: job.jobId,
        leaseToken: stale!.leaseToken,
        outcomes: stale!.items.map((item) => ({ position: item.position, state: 'missing' as const })),
      }),
      /stale or empty/u,
    );
    await settleOrganizeAnalysisBatch({
      jobId: job.jobId,
      leaseToken: recovered!.leaseToken,
      now: 113,
      outcomes: [
        { position: 0, state: 'missing' },
        { position: 1, state: 'tombstoned' },
      ],
    });
    const coverage = await getOrganizeCoverage(job.jobId);
    assert.equal(coverage.complete, true);
    assert.equal(coverage.missing, 1);
    assert.equal(coverage.tombstoned, 1);
  });

  it('never resurrects a cancelled job from late scheduler or expired-lease cleanup', async () => {
    const job = await createOrganizeJob(jobInput(['owner/terminal-lease']));
    const lease = await claimOrganizeAnalysisBatch(job.jobId, 1, {
      ownerId: 'late-worker',
      durationMs: 10,
      now: 100,
    });
    assert.ok(lease);
    assert.equal(await cancelOrganizeJob(job.jobId, 105), true);
    const terminal = await getOrganizeJob(job.jobId);
    const rows = await db.organizeItems.where('jobId').equals(job.jobId).toArray();
    assert.equal(terminal?.status, 'cancelled');

    assert.equal(await releaseOrganizeAnalysisPage({
      jobId: job.jobId,
      leaseToken: lease.leaseToken,
      now: 106,
    }), false);
    assert.deepEqual(await recoverExpiredOrganizeLeases(111), { analysis: 0, apply: 0 });
    assert.deepEqual(await getOrganizeJob(job.jobId), terminal);
    assert.deepEqual(await db.organizeItems.where('jobId').equals(job.jobId).toArray(), rows);
  });
  it('preserves analysis_blocked while releasing and recovering analysis leases', async () => {
    const job = await createOrganizeJob(jobInput(['owner/blocked-lease']));
    const claimed = await claimOrganizeAnalysisBatch(job.jobId, 1, {
      ownerId: 'blocked-worker',
      durationMs: 10,
      now: 100,
    });
    assert.ok(claimed);
    await db.organizeJobs.update(job.jobId, { status: 'analysis_blocked' });

    assert.deepEqual(await releaseOrganizeJobLeases(job.jobId, 105), { analysis: 1, apply: 0 });
    assert.equal((await getOrganizeJob(job.jobId))?.status, 'analysis_blocked');

    await db.organizeItems.update(claimed.items[0]!.id, {
      analysisState: 'leased',
      leaseToken: 'expired-blocked-token',
      leaseOwner: 'expired-blocked-worker',
      leaseExpiresAt: 110,
    });
    assert.deepEqual(await recoverExpiredOrganizeLeases(110), { analysis: 1, apply: 0 });
    assert.equal((await getOrganizeJob(job.jobId))?.status, 'analysis_blocked');
    assert.equal((await db.organizeItems.get(claimed.items[0]!.id))?.analysisState, 'pending');
  });

  it('checkpoints the scheduler exact page and retries only the failed suffix', async () => {
    const run1 = parseRunId('run:v1:exact-page-1');
    const proposal1 = parseProposalId('proposal:v1:exact-page-1');
    const job = await createOrganizeJob({
      ...jobInput(['owner/one', 'owner/two', 'owner/three']),
      runId: run1,
      proposalId: proposal1,
      budget: createProductionRunBudget(),
      usage: createEmptyRunBudgetUsage(),
    });
    const emptyUsage = createEmptyRunBudgetUsage();
    const firstPageUsage = { ...emptyUsage, analyzerBatches: 1 };
    const first = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: run1,
      generation: 1,
      expectedRevision: job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 2,
      previousUsage: emptyUsage,
      usage: firstPageUsage,
      lease: { ownerId: 'scheduler-1', now: 100 },
    });
    assert.deepEqual(first?.items.map((row) => row.position), [0, 1]);
    await assert.rejects(
      () => reserveOrganizeAnalysisPage({
        jobId: job.jobId,
        runId: run1,
        generation: 1,
        expectedRevision: first!.job.revision,
        startFrozenIndex: 1,
        endFrozenIndexExclusive: 3,
        previousUsage: firstPageUsage,
        usage: { ...firstPageUsage, analyzerBatches: 2 },
        lease: { ownerId: 'scheduler-2', now: 101 },
      }),
      /durable cursor/u,
    );
    const blocked = await checkpointOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: run1,
      generation: 1,
      expectedRevision: first!.job.revision,
      leaseToken: first!.leaseToken,
      expectedNextFrozenIndex: 2,
      usage: { ...createEmptyRunBudgetUsage(), consumedFrozenPositions: 2, analyzerBatches: 1 },
      now: 110,
      outcomes: [
        { position: 0, state: 'missing' },
        { position: 1, state: 'failed', failure: 'provider_failed' },
      ],
      analysisPendingRanges: [],
    });
    assert.equal(blocked.job.status, 'analysis_blocked');
    assert.equal(blocked.job.nextFrozenIndex, 2);
    assert.deepEqual(
      { failed: blocked.coverage.failed, pending: blocked.coverage.pending },
      { failed: 1, pending: 1 },
    );

    const retried = await retryOrganizeAnalysisFromFirstFailure(job.jobId, 120);
    assert.equal(retried.nextFrozenIndex, 1);
    const run2 = parseRunId('run:v1:exact-page-2');
    const advanced = await advanceOrganizeJobRun({
      jobId: job.jobId,
      runId: run2,
      generation: 2,
      expectedParent: { runId: run1, generation: 1 },
      proposalId: parseProposalId('proposal:v1:exact-page-2'),
      budget: createProductionRunBudget(),
      usage: createEmptyRunBudgetUsage(),
      startFrozenIndex: 1,
      analysisPendingRanges: [],
      now: 121,
    });
    const second = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: run2,
      generation: 2,
      expectedRevision: advanced.revision,
      startFrozenIndex: 1,
      endFrozenIndexExclusive: 3,
      previousUsage: createEmptyRunBudgetUsage(),
      usage: { ...createEmptyRunBudgetUsage(), analyzerBatches: 1 },
      lease: { ownerId: 'scheduler-2', now: 122 },
    });
    const completed = await checkpointOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: run2,
      generation: 2,
      expectedRevision: second!.job.revision,
      leaseToken: second!.leaseToken,
      expectedNextFrozenIndex: 3,
      usage: { ...createEmptyRunBudgetUsage(), consumedFrozenPositions: 2, analyzerBatches: 1 },
      now: 123,
      outcomes: [
        { position: 1, state: 'unchanged' },
        { position: 2, state: 'tombstoned' },
      ],
      analysisPendingRanges: [],
    });
    assert.equal(completed.job.status, 'review');
    assert.equal(completed.coverage.complete, true);
    const restored = await restoreOrganizeAnalysisCheckpoint(job.jobId);
    assert.equal(restored.resumeFrozenIndex, 3);
    assert.deepEqual(restored.items.map((row) => row.analysisState), [
      'missing',
      'unchanged',
      'tombstoned',
    ]);
  });

  it('does not advance a review-ready run or a complete durable ledger back to analyzing', async () => {
    const runId = parseRunId('run:v1:review-phase-guard');
    const emptyUsage = createEmptyRunBudgetUsage();
    const pageUsage = { ...emptyUsage, analyzerBatches: 1 };
    const job = await createOrganizeJob({
      ...jobInput(['owner/review-phase-guard']),
      runId,
      proposalId: parseProposalId('proposal:v1:review-phase-guard'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
    });
    const page = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 1,
      previousUsage: emptyUsage,
      usage: pageUsage,
      lease: { ownerId: 'scheduler:review-phase-guard', now: 100 },
    });
    const reviewed = await checkpointOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: page!.job.revision,
      leaseToken: page!.leaseToken,
      expectedNextFrozenIndex: 1,
      outcomes: [{ position: 0, state: 'unchanged' }],
      usage: { ...pageUsage, consumedFrozenPositions: 1 },
      analysisPendingRanges: [],
      now: 101,
    });
    assert.equal(reviewed.job.status, 'review');
    assert.equal(reviewed.coverage.complete, true);

    const bound = await bindOrganizeJobProvider({
      jobId: job.jobId,
      runId,
      generation: 1,
      providerBinding: { provider: 'test', model: 'review-safe' },
      now: 102,
    });
    assert.equal(bound.status, 'review');
    assert.equal(bound.nextFrozenIndex, 1);
    assert.deepEqual(bound.providerBinding, { provider: 'test', model: 'review-safe' });

    const advance = () => advanceOrganizeJobRun({
      jobId: job.jobId,
      runId,
      generation: 1,
      proposalId: parseProposalId(job.proposalId),
      budget: bound.budget as ReturnType<typeof createProductionRunBudget>,
      usage: bound.usage as ReturnType<typeof createEmptyRunBudgetUsage>,
      startFrozenIndex: 1,
      analysisPendingRanges: [],
      now: 103,
    });
    await assert.rejects(advance, /review-ready|complete coverage/u);

    await db.organizeJobs.update(job.jobId, { status: 'analyzing' });
    await assert.rejects(advance, /complete coverage/u);
  });

  it('renews a slow retry lease through checkpoint beyond the original expiry', async () => {
    const runId = parseRunId('run:v1:durable-slow-retry');
    const emptyUsage = createEmptyRunBudgetUsage();
    const pageUsage = { ...emptyUsage, analyzerBatches: 1 };
    const job = await createOrganizeJob({
      ...jobInput(['owner/slow-checkpoint']),
      runId,
      proposalId: parseProposalId('proposal:v1:durable-slow-retry'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
    });
    const page = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 1,
      previousUsage: emptyUsage,
      usage: pageUsage,
      lease: { ownerId: 'scheduler:slow', now: 100 },
    });
    const firstUsage = {
      ...pageUsage,
      firstAnalyzerRequestAt: 100,
      providerAttempts: 1,
      serializedOutboundRequestBytes: 10,
      requestedOutputTokens: 20,
    };
    const firstAttempt = await reserveOrganizeAnalysisProviderAttempt({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: page!.job.revision,
      leaseToken: page!.leaseToken,
      previousUsage: pageUsage,
      usage: firstUsage,
      serializedRequestBytes: 10,
      requestedOutputTokens: 20,
      reservedAt: 100,
      leaseDurationMs: 60_000,
    });
    const retryUsage = {
      ...firstUsage,
      providerAttempts: 2,
      serializedOutboundRequestBytes: 21,
      requestedOutputTokens: 41,
    };
    const retry = await reserveOrganizeAnalysisProviderAttempt({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: firstAttempt.job.revision,
      leaseToken: page!.leaseToken,
      previousUsage: firstUsage,
      usage: retryUsage,
      serializedRequestBytes: 11,
      requestedOutputTokens: 21,
      reservedAt: 45_101,
      leaseDurationMs: 60_000,
    });
    assert.equal(retry.leaseExpiresAt, 105_101);

    const checkpoint = await checkpointOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: retry.job.revision,
      leaseToken: page!.leaseToken,
      expectedNextFrozenIndex: 1,
      outcomes: [{ position: 0, state: 'missing' }],
      usage: { ...retryUsage, consumedFrozenPositions: 1 },
      analysisPendingRanges: [],
      now: 90_102,
    });
    assert.equal(checkpoint.job.status, 'review');
    assert.equal(checkpoint.coverage.complete, true);
  });

  it('preserves paid attempt usage and wall start across a worker restart', async () => {
    const runId = parseRunId('run:v1:durable-attempt-restart');
    const emptyUsage = createEmptyRunBudgetUsage();
    const pageUsage = { ...emptyUsage, analyzerBatches: 1 };
    const job = await createOrganizeJob({
      ...jobInput(['owner/slow-retry']),
      runId,
      proposalId: parseProposalId('proposal:v1:durable-attempt-restart'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
    });
    const page = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 1,
      previousUsage: emptyUsage,
      usage: pageUsage,
      lease: { ownerId: 'scheduler:first', now: 100 },
    });
    const firstAttemptUsage = {
      ...pageUsage,
      firstAnalyzerRequestAt: 100,
      providerAttempts: 1,
      serializedOutboundRequestBytes: 10,
      requestedOutputTokens: 20,
    };
    const firstAttempt = await reserveOrganizeAnalysisProviderAttempt({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: page!.job.revision,
      leaseToken: page!.leaseToken,
      previousUsage: pageUsage,
      usage: firstAttemptUsage,
      serializedRequestBytes: 10,
      requestedOutputTokens: 20,
      reservedAt: 100,
    });
    assert.equal(firstAttempt.leaseExpiresAt, 360_100);

    const secondAttemptUsage = {
      ...firstAttemptUsage,
      providerAttempts: 2,
      serializedOutboundRequestBytes: 21,
      requestedOutputTokens: 41,
    };
    const secondAttempt = await reserveOrganizeAnalysisProviderAttempt({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: firstAttempt.job.revision,
      leaseToken: page!.leaseToken,
      previousUsage: firstAttemptUsage,
      usage: secondAttemptUsage,
      serializedRequestBytes: 11,
      requestedOutputTokens: 21,
      reservedAt: 45_101,
    });
    assert.equal(secondAttempt.leaseExpiresAt, 405_101);
    assert.deepEqual((await getOrganizeJob(job.jobId))?.usage, secondAttemptUsage);

    assert.equal(await releaseOrganizeAnalysisPage({
      jobId: job.jobId,
      leaseToken: page!.leaseToken,
      now: 45_102,
    }), true);
    const restored = await restoreOrganizeAnalysisCheckpoint(job.jobId);
    assert.deepEqual(restored.job.usage, secondAttemptUsage);
    assert.equal(restored.resumeFrozenIndex, 0);

    const restartedPageUsage = { ...secondAttemptUsage, analyzerBatches: 2 };
    const restarted = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: restored.job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 1,
      previousUsage: secondAttemptUsage,
      usage: restartedPageUsage,
      lease: { ownerId: 'scheduler:replacement', now: 45_103 },
    });
    await assert.rejects(
      () => reserveOrganizeAnalysisProviderAttempt({
        jobId: job.jobId,
        runId,
        generation: 1,
        expectedRevision: restarted!.job.revision,
        leaseToken: page!.leaseToken,
        previousUsage: restartedPageUsage,
        usage: {
          ...restartedPageUsage,
          providerAttempts: 3,
          serializedOutboundRequestBytes: 22,
          requestedOutputTokens: 42,
        },
        serializedRequestBytes: 1,
        requestedOutputTokens: 1,
        reservedAt: 45_104,
      }),
      /stale or empty/u,
    );
    assert.equal(restarted?.items[0]?.leaseToken, restarted?.leaseToken);
    assert.deepEqual((await getOrganizeJob(job.jobId))?.usage, restartedPageUsage);
  });

  it('persists depth-first split ranges and fences stale workers by revision', async () => {
    const runId = parseRunId('run:v1:durable-split-worklist');
    const emptyUsage = createEmptyRunBudgetUsage();
    const rootUsage = { ...emptyUsage, analyzerBatches: 1 };
    const job = await createOrganizeJob({
      ...jobInput(['owner/0', 'owner/1', 'owner/2', 'owner/3']),
      runId,
      proposalId: parseProposalId('proposal:v1:durable-split-worklist'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
    });
    const root = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 4,
      previousUsage: emptyUsage,
      usage: rootUsage,
      lease: { ownerId: 'scheduler:root', now: 100 },
    });
    await assert.rejects(() => splitOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: job.revision,
      leaseToken: root!.leaseToken,
      now: 101,
    }), /revision is stale/u);

    const split = await splitOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: root!.job.revision,
      leaseToken: root!.leaseToken,
      now: 101,
    });
    assert.deepEqual(split.pendingRanges, [
      { startFrozenIndex: 0, endFrozenIndexExclusive: 2, depth: 1 },
      { startFrozenIndex: 2, endFrozenIndexExclusive: 4, depth: 1 },
    ]);
    assert.deepEqual(
      (await restoreOrganizeAnalysisCheckpoint(job.jobId)).items.map((row) => [row.analysisState, row.retryCount]),
      [['pending', 0], ['pending', 0], ['pending', 0], ['pending', 0]],
    );

    const leftUsage = { ...rootUsage, analyzerBatches: 2 };
    const left = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: split.job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 2,
      previousUsage: rootUsage,
      usage: leftUsage,
      lease: { ownerId: 'scheduler:left', now: 102 },
    });
    const checkpoint = await checkpointOrganizeAnalysisPage({
      jobId: job.jobId,
      runId,
      generation: 1,
      expectedRevision: left!.job.revision,
      leaseToken: left!.leaseToken,
      expectedNextFrozenIndex: 2,
      outcomes: [
        { position: 0, state: 'missing' },
        { position: 1, state: 'missing' },
      ],
      usage: { ...leftUsage, consumedFrozenPositions: 2 },
      analysisPendingRanges: [
        { startFrozenIndex: 2, endFrozenIndexExclusive: 4, depth: 1 },
      ],
      now: 103,
    });
    assert.equal(checkpoint.job.nextFrozenIndex, 2);
    assert.deepEqual(checkpoint.job.analysisPendingRanges, [
      { startFrozenIndex: 2, endFrozenIndexExclusive: 4, depth: 1 },
    ]);
  });

  it('preserves a split worklist through provider binding and continuation checkpoints', async () => {
    const parentRunId = parseRunId('run:v1:split-continuation-parent');
    const emptyUsage = createEmptyRunBudgetUsage();
    const parentPageUsage = { ...emptyUsage, analyzerBatches: 1 };
    const repositoryIds = Array.from({ length: 25 }, (_, index) => `owner/split-${index}`);
    const job = await createOrganizeJob({
      ...jobInput(repositoryIds),
      runId: parentRunId,
      proposalId: parseProposalId('proposal:v1:split-continuation-parent'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
    });
    const parentPage = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: parentRunId,
      generation: 1,
      expectedRevision: job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 25,
      previousUsage: emptyUsage,
      usage: parentPageUsage,
      lease: { ownerId: 'scheduler:split-parent', now: 100 },
    });
    const split = await splitOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: parentRunId,
      generation: 1,
      expectedRevision: parentPage!.job.revision,
      leaseToken: parentPage!.leaseToken,
      now: 101,
    });
    assert.deepEqual(split.pendingRanges, [
      { startFrozenIndex: 0, endFrozenIndexExclusive: 12, depth: 1 },
      { startFrozenIndex: 12, endFrozenIndexExclusive: 25, depth: 1 },
    ]);

    await assert.rejects(() => advanceOrganizeJobRun({
      jobId: job.jobId,
      runId: parentRunId,
      generation: 1,
      proposalId: parseProposalId(job.proposalId),
      budget: job.budget as ReturnType<typeof createProductionRunBudget>,
      usage: parentPageUsage,
      providerBinding: { provider: 'test', model: 'split-safe' },
      startFrozenIndex: 0,
      analysisPendingRanges: [],
      now: 102,
    }), /pending range worklist is stale/u);

    const providerBound = await bindOrganizeJobProvider({
      jobId: job.jobId,
      runId: parentRunId,
      generation: 1,
      providerBinding: { provider: 'test', model: 'split-safe' },
      now: 102,
    });
    assert.equal(providerBound.nextFrozenIndex, 0);
    assert.equal(providerBound.status, 'analyzing');
    assert.deepEqual(providerBound.analysisPendingRanges, split.pendingRanges);

    const childRunId = parseRunId('run:v1:split-continuation-child');
    const continued = await advanceOrganizeJobRun({
      jobId: job.jobId,
      runId: childRunId,
      generation: 2,
      expectedParent: { runId: parentRunId, generation: 1 },
      proposalId: parseProposalId('proposal:v1:split-continuation-child'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
      providerBinding: providerBound.providerBinding,
      startFrozenIndex: 0,
      analysisPendingRanges: split.pendingRanges,
      now: 103,
    });
    assert.deepEqual(continued.analysisPendingRanges, split.pendingRanges);

    const leftPageUsage = { ...emptyUsage, analyzerBatches: 1 };
    const left = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: childRunId,
      generation: 2,
      expectedRevision: continued.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 12,
      previousUsage: emptyUsage,
      usage: leftPageUsage,
      lease: { ownerId: 'scheduler:split-child', now: 104 },
    });
    const leftCheckpoint = await checkpointOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: childRunId,
      generation: 2,
      expectedRevision: left!.job.revision,
      leaseToken: left!.leaseToken,
      expectedNextFrozenIndex: 12,
      outcomes: left!.items.map((row) => ({ position: row.position, state: 'missing' as const })),
      usage: { ...leftPageUsage, consumedFrozenPositions: 12 },
      analysisPendingRanges: [
        { startFrozenIndex: 12, endFrozenIndexExclusive: 25, depth: 1 },
      ],
      now: 105,
    });
    assert.equal(leftCheckpoint.job.nextFrozenIndex, 12);

    const restored = await restoreOrganizeAnalysisCheckpoint(job.jobId);
    assert.equal(restored.resumeFrozenIndex, 12);
    assert.deepEqual(restored.job.analysisPendingRanges, [
      { startFrozenIndex: 12, endFrozenIndexExclusive: 25, depth: 1 },
    ]);
    const rightPageUsage = {
      ...(leftCheckpoint.job.usage as typeof leftPageUsage),
      analyzerBatches: 2,
    };
    const right = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: childRunId,
      generation: 2,
      expectedRevision: restored.job.revision,
      startFrozenIndex: 12,
      endFrozenIndexExclusive: 25,
      previousUsage: leftCheckpoint.job.usage as typeof leftPageUsage,
      usage: rightPageUsage,
      lease: { ownerId: 'scheduler:split-child-restored', now: 106 },
    });
    assert.deepEqual(
      right?.items.map((row) => row.position),
      Array.from({ length: 13 }, (_, index) => index + 12),
    );
  });

  it('lets only one child claim a durable continuation generation', async () => {
    const parentRunId = parseRunId('run:v1:continuation-parent');
    const firstChildRunId = parseRunId('run:v1:continuation-child-first');
    const secondChildRunId = parseRunId('run:v1:continuation-child-second');
    const emptyUsage = createEmptyRunBudgetUsage();
    const job = await createOrganizeJob({
      ...jobInput(['owner/continuation-cas']),
      runId: parentRunId,
      proposalId: parseProposalId('proposal:v1:continuation-parent'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
    });
    const continuationInput = {
      jobId: job.jobId,
      generation: 2,
      expectedParent: { runId: parentRunId, generation: 1 },
      budget: createProductionRunBudget(),
      usage: emptyUsage,
      startFrozenIndex: 0,
      analysisPendingRanges: [],
    } as const;

    await assert.rejects(() => advanceOrganizeJobRun({
      ...continuationInput,
      runId: firstChildRunId,
      generation: 3,
      proposalId: parseProposalId('proposal:v1:continuation-child-skipped'),
      now: 99,
    }), /advance exactly once/u);

    const firstChild = await advanceOrganizeJobRun({
      ...continuationInput,
      runId: firstChildRunId,
      proposalId: parseProposalId('proposal:v1:continuation-child-first'),
      now: 100,
    });
    assert.equal(firstChild.runId, firstChildRunId);
    assert.equal(firstChild.generation, 2);
    assert.equal(firstChild.originAgentSessionId, job.sessionId);

    await assert.rejects(() => advanceOrganizeJobRun({
      ...continuationInput,
      runId: secondChildRunId,
      proposalId: parseProposalId('proposal:v1:continuation-child-second'),
      now: 101,
    }), /parent authority|durable identity/u);

    const durable = await getOrganizeJob(job.jobId);
    assert.equal(durable?.runId, firstChildRunId);
    assert.equal(durable?.generation, 2);
    assert.equal(durable?.proposalId, 'proposal:v1:continuation-child-first');
    assert.equal(durable?.originAgentSessionId, job.sessionId);
  });

  it('releases a captured page token after the job advances to a child generation', async () => {
    const parentRunId = parseRunId('run:v1:lease-parent');
    const emptyUsage = createEmptyRunBudgetUsage();
    const job = await createOrganizeJob({
      ...jobInput(['owner/continuation-race']),
      runId: parentRunId,
      proposalId: parseProposalId('proposal:v1:lease-parent'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
    });
    const parentPage = await reserveOrganizeAnalysisPage({
      jobId: job.jobId,
      runId: parentRunId,
      generation: 1,
      expectedRevision: job.revision,
      startFrozenIndex: 0,
      endFrozenIndexExclusive: 1,
      previousUsage: emptyUsage,
      usage: { ...emptyUsage, analyzerBatches: 1 },
      lease: { ownerId: 'scheduler:parent', now: 100 },
    });
    const childRunId = parseRunId('run:v1:lease-child');
    await advanceOrganizeJobRun({
      jobId: job.jobId,
      runId: childRunId,
      generation: 2,
      expectedParent: { runId: parentRunId, generation: 1 },
      proposalId: parseProposalId('proposal:v1:lease-child'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
      startFrozenIndex: 0,
      analysisPendingRanges: [],
      now: 101,
    });

    assert.equal(await releaseOrganizeAnalysisPage({
      jobId: job.jobId,
      leaseToken: parentPage!.leaseToken,
      now: 102,
    }), true);
    const advanced = await getOrganizeJob(job.jobId);
    assert.equal(advanced?.runId, childRunId);
    assert.equal(advanced?.generation, 2);
    assert.equal((await restoreOrganizeAnalysisCheckpoint(job.jobId)).items[0]?.analysisState, 'pending');
  });

  it('resumes a 237-row Apply as 100, 100, and 37 without replaying committed rows', async () => {
    const repositoryIds = Array.from({ length: 237 }, (_, index) => `bulk/repo-${index}`);
    const stars = repositoryIds.map((full_name) => fakeStar({ full_name }));
    await db.stars.bulkPut(stars);
    const fingerprints = new Map(await Promise.all(stars.map(async (star) => (
      [star.full_name, await sourceFingerprintV1(star, undefined)] as const
    ))));
    const policyTaxonomy = buildSemanticPolicyTaxonomyFromStorage([], []);
    const frozenTaxonomyFingerprint = await fingerprintSemanticTaxonomy(policyTaxonomy);
    const job = await createOrganizeJob(jobInput(repositoryIds, {
      fingerprint: frozenTaxonomyFingerprint,
      snapshot: { policyTaxonomy },
    }));
    let claim = await claimOrganizeAnalysisBatch(job.jobId, 50, { ownerId: 'analysis' });
    while (claim) {
      await settleOrganizeAnalysisBatch({
        jobId: job.jobId,
        leaseToken: claim.leaseToken,
        outcomes: claim.items.map((item) => ({
          position: item.position,
          state: 'actionable' as const,
          sourceFingerprint: fingerprints.get(item.fullName)!,
          proposedActions: [{
            kind: 'propose_new_tag' as const,
            tag: 'organized',
            evidence: 'Whole-library organization evidence.',
          }],
        })),
      });
      claim = await claimOrganizeAnalysisBatch(job.jobId, 50, { ownerId: 'analysis' });
    }
    const reviewed = (await getOrganizeJob(job.jobId))!;
    const apply = await sealOrganizeApply(job.jobId, reviewed.revision);

    const first = await claimOrganizeApplyChunk(apply.applyId, 100, { ownerId: 'apply-1' });
    assert.equal(first?.rows.length, 100);
    await settleOrganizeApplyChunk({ applyId: apply.applyId, leaseToken: first!.leaseToken });
    const checkpointedApply = await db.organizeApplies.get(apply.applyId);
    const liveTaxonomy = buildSemanticPolicyTaxonomyFromStorage([], await db.tags.toArray());
    assert.notEqual(checkpointedApply?.expectedTaxonomyFingerprint, frozenTaxonomyFingerprint);
    assert.equal(
      checkpointedApply?.expectedTaxonomyFingerprint,
      await fingerprintSemanticTaxonomy(liveTaxonomy),
    );
    assert.equal((await getOrganizeTaxonomy(job.jobId))?.fingerprint, frozenTaxonomyFingerprint);
    await db.close();
    await db.open();

    const interrupted = await claimOrganizeApplyChunk(apply.applyId, 100, { ownerId: 'apply-1' });
    assert.equal(interrupted?.rows.length, 100);
    assert.deepEqual(await releaseOrganizeJobLeases(job.jobId), { analysis: 0, apply: 100 });
    await assert.rejects(
      () => settleOrganizeApplyChunk({ applyId: apply.applyId, leaseToken: interrupted!.leaseToken }),
      /not applying|stale or empty/u,
    );
    const second = await claimOrganizeApplyChunk(apply.applyId, 100, { ownerId: 'apply-2' });
    assert.equal(second?.rows.length, 100);
    const pauseRequested = await requestOrganizeApplyPause(job.jobId);
    assert.equal(pauseRequested.pauseRequested, true);
    await settleOrganizeApplyChunk({ applyId: apply.applyId, leaseToken: second!.leaseToken });
    const paused = (await getOrganizeJob(job.jobId))!;
    assert.equal(paused.status, 'paused');
    assert.equal(await claimOrganizeApplyChunk(apply.applyId, 100, { ownerId: 'apply-3' }), null);
    await resumeOrganizeApply(job.jobId, paused.revision);

    const third = await claimOrganizeApplyChunk(apply.applyId, 100, { ownerId: 'apply-2' });
    assert.equal(third?.rows.length, 37);
    const completed = await settleOrganizeApplyChunk({
      applyId: apply.applyId,
      leaseToken: third!.leaseToken,
    });
    assert.equal(completed.complete, true);
    const receipt = await getOrganizeReceipt(apply.applyId);
    assert.deepEqual(receipt?.counts, {
      changed: 237,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
    });
    assert.equal(receipt?.rows.slice(0, 100).every((row) => row.attemptCount === 1), true);
    assert.equal(receipt?.rows.slice(100, 200).every((row) => row.attemptCount === 2), true);
  }, 20_000);

  it('distinguishes its own prior chunk writes from an external taxonomy change', async () => {
    const stars = [
      fakeStar({ full_name: 'owner/first' }),
      fakeStar({ full_name: 'owner/second' }),
    ];
    await db.stars.bulkPut(stars);
    const policyTaxonomy = buildSemanticPolicyTaxonomyFromStorage([], []);
    const job = await createOrganizeJob(jobInput(stars.map((star) => star.full_name), {
      fingerprint: await fingerprintSemanticTaxonomy(policyTaxonomy),
      snapshot: { policyTaxonomy },
    }));
    const claim = await claimOrganizeAnalysisBatch(job.jobId, 2, { ownerId: 'analysis' });
    await settleOrganizeAnalysisBatch({
      jobId: job.jobId,
      leaseToken: claim!.leaseToken,
      outcomes: await Promise.all(claim!.items.map(async (item) => ({
        position: item.position,
        state: 'actionable' as const,
        sourceFingerprint: await sourceFingerprintV1(stars[item.position]!, undefined),
        proposedActions: [{
          kind: 'propose_new_tag' as const,
          tag: 'organized',
          evidence: 'The repository belongs in the organized group.',
        }],
      }))),
    });
    const reviewed = (await getOrganizeJob(job.jobId))!;
    const apply = await sealOrganizeApply(job.jobId, reviewed.revision);

    const first = await claimOrganizeApplyChunk(apply.applyId, 1, { ownerId: 'apply' });
    await settleOrganizeApplyChunk({ applyId: apply.applyId, leaseToken: first!.leaseToken });
    assert.deepEqual((await db.tags.get('owner/first'))?.manualTags, ['organized']);

    await idbTagStore.setTags('external/repository', ['external-change']);
    const second = await claimOrganizeApplyChunk(apply.applyId, 1, { ownerId: 'apply' });
    await settleOrganizeApplyChunk({ applyId: apply.applyId, leaseToken: second!.leaseToken });

    const receipt = await getOrganizeReceipt(apply.applyId);
    assert.deepEqual(receipt?.counts, {
      changed: 1,
      unchanged: 0,
      skipped: 1,
      failed: 0,
      pending: 0,
    });
    assert.equal(receipt?.rows[1]?.outcomeReason, 'taxonomy_conflict');
    assert.equal(await db.tags.get('owner/second'), undefined);
  });

  it('rolls back a local tag write when its durable outbox write fails', async () => {
    const put = vi.spyOn(db.tagDirtyOutbox, 'put').mockRejectedValueOnce(new Error('outbox unavailable'));
    await assert.rejects(() => idbTagStore.setTags('owner/atomic', ['react']), /outbox unavailable/u);
    assert.equal(await db.tags.get('owner/atomic'), undefined);
    assert.equal(await db.tagDirtyOutbox.count(), 0);
    put.mockRestore();

    await idbTagStore.setTags('owner/atomic', ['react']);
    assert.deepEqual((await db.tags.get('owner/atomic'))?.manualTags, ['react']);
    assert.equal((await db.tagDirtyOutbox.get('tag:owner/atomic'))?.key, 'owner/atomic');
  });

  it('rolls back an Apply chunk when its durable taxonomy checkpoint fails', async () => {
    const star = fakeStar({ full_name: 'owner/apply-atomic' });
    await db.stars.put(star);
    const policyTaxonomy = buildSemanticPolicyTaxonomyFromStorage([], []);
    const taxonomyFingerprint = await fingerprintSemanticTaxonomy(policyTaxonomy);
    const job = await createOrganizeJob(jobInput([star.full_name], {
      fingerprint: taxonomyFingerprint,
      snapshot: { policyTaxonomy },
    }));
    const analysis = await claimOrganizeAnalysisBatch(job.jobId, 1, { ownerId: 'analysis' });
    await settleOrganizeAnalysisBatch({
      jobId: job.jobId,
      leaseToken: analysis!.leaseToken,
      outcomes: [{
        position: 0,
        state: 'actionable',
        sourceFingerprint: await sourceFingerprintV1(star, undefined),
        proposedActions: [{
          kind: 'propose_new_tag',
          tag: 'atomic',
          evidence: 'Atomic Apply checkpoint evidence.',
        }],
      }],
    });
    const reviewed = (await getOrganizeJob(job.jobId))!;
    const apply = await sealOrganizeApply(job.jobId, reviewed.revision);
    const claim = await claimOrganizeApplyChunk(apply.applyId, 1, { ownerId: 'apply' });
    const checkpoint = vi.spyOn(db.organizeApplies, 'put')
      .mockRejectedValueOnce(new Error('apply checkpoint unavailable'));

    await assert.rejects(
      () => settleOrganizeApplyChunk({ applyId: apply.applyId, leaseToken: claim!.leaseToken }),
      /apply checkpoint unavailable/u,
    );
    checkpoint.mockRestore();
    assert.equal(await db.tags.get(star.full_name), undefined);
    assert.equal(await db.tagDirtyOutbox.count(), 0);
    assert.equal((await db.organizeApplyRows.get(claim!.rows[0]!.id))?.state, 'leased');
    assert.equal((await db.organizeApplies.get(apply.applyId))?.expectedTaxonomyFingerprint, taxonomyFingerprint);

    await settleOrganizeApplyChunk({ applyId: apply.applyId, leaseToken: claim!.leaseToken });
    assert.deepEqual((await db.tags.get(star.full_name))?.manualTags, ['atomic']);
    assert.equal((await getOrganizeReceipt(apply.applyId))?.counts.changed, 1);
  });

  it('atomically replaces the one retained terminal result and all of its evidence', async () => {
    const noChange = await createOrganizeJob(jobInput([]));
    const noChangeTerminal = await completeOrganizeJobWithoutApply(noChange.jobId);
    assert.equal((await getOrganizeJob(noChange.jobId))?.status, 'completed');
    assert.equal(await db.organizeTaxonomies.where('jobId').equals(noChange.jobId).count(), 1);

    const star = fakeStar({ full_name: 'owner/old-receipt' });
    await db.stars.put(star);
    const completedJob = await createOrganizeJob(jobInput([star.full_name]));
    assert.equal(await getOrganizeJob(noChangeTerminal.jobId), undefined);
    const analysis = await claimOrganizeAnalysisBatch(completedJob.jobId, 1, { ownerId: 'analysis' });
    await settleOrganizeAnalysisBatch({
      jobId: completedJob.jobId,
      leaseToken: analysis!.leaseToken,
      outcomes: [{
        position: 0,
        state: 'actionable',
        sourceFingerprint: await sourceFingerprintV1(star, undefined),
        proposedActions: [{
          kind: 'propose_new_tag',
          tag: 'old',
          evidence: 'Superseded receipt evidence.',
        }],
      }],
    });
    const review = (await getOrganizeJob(completedJob.jobId))!;
    const deselected = await updateOrganizeSelection({
      jobId: completedJob.jobId,
      expectedRevision: review.revision,
      selections: [{ position: 0, selected: false }],
    });
    const oldApply = await sealOrganizeApply(completedJob.jobId, deselected.revision);
    const oldJob = (await getOrganizeJob(completedJob.jobId))!;
    const oldTaxonomy = await getOrganizeTaxonomy(completedJob.jobId);
    const oldReceipt = await getOrganizeReceipt(oldApply.applyId);

    const failedInsert = vi.spyOn(db.organizeTaxonomies, 'add')
      .mockRejectedValueOnce(new Error('replacement taxonomy unavailable'));
    await assert.rejects(
      () => createOrganizeJob(jobInput(['owner/failed-replacement'])),
      /replacement taxonomy unavailable/u,
    );
    failedInsert.mockRestore();
    assert.deepEqual(await getOrganizeJob(completedJob.jobId), oldJob);
    assert.deepEqual(await getOrganizeTaxonomy(completedJob.jobId), oldTaxonomy);
    assert.deepEqual(await getOrganizeReceipt(oldApply.applyId), oldReceipt);

    const replacement = await createOrganizeJob(jobInput(['owner/replacement']));
    assert.equal(await getOrganizeJob(completedJob.jobId), undefined);
    assert.equal(await getOrganizeReceipt(oldApply.applyId), undefined);
    assert.equal(await db.organizeJobs.count(), 1);
    assert.equal(await db.organizeItems.count(), 1);
    assert.equal(await db.organizeTaxonomies.count(), 1);

    assert.equal(await cancelOrganizeJob(replacement.jobId, 500), true);
    const cancelled = (await getOrganizeJob(replacement.jobId))!;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelledAt, 500);
    assert.equal(await db.organizeItems.where('jobId').equals(replacement.jobId).count(), 1);
    assert.equal(await db.organizeTaxonomies.where('jobId').equals(replacement.jobId).count(), 1);
    const nextPreflight = await createOrganizePreflight(preflightInput(['owner/next-preflight']));
    assert.equal(await getOrganizeJob(cancelled.jobId), undefined);
    assert.equal((await getOrganizeJob(nextPreflight.jobId))?.status, 'preflight_ready');
    assert.equal(await db.organizeJobs.count(), 1);
    assert.equal(await db.organizeItems.count(), 1);
    assert.equal(await db.organizeTaxonomies.count(), 1);
  });

  it('dismisses cancelled jobs without Apply only at the exact terminal revision', async () => {
    const job = await createOrganizeJob(jobInput(['owner/cancelled-dismiss']));
    await assert.rejects(
      () => dismissTerminalOrganizeJob({ jobId: job.jobId, expectedRevision: job.revision }),
      /Only terminal organize jobs/u,
    );
    assert.equal(await cancelOrganizeJob(job.jobId, 200), true);
    const cancelled = (await getOrganizeJob(job.jobId))!;
    const items = await db.organizeItems.where('jobId').equals(job.jobId).toArray();
    const taxonomy = await getOrganizeTaxonomy(job.jobId);

    await assert.rejects(
      () => dismissTerminalOrganizeJob({ jobId: job.jobId, expectedRevision: job.revision }),
      /revision is stale/u,
    );
    assert.deepEqual(await getOrganizeJob(job.jobId), cancelled);
    assert.deepEqual(await db.organizeItems.where('jobId').equals(job.jobId).toArray(), items);
    assert.deepEqual(await getOrganizeTaxonomy(job.jobId), taxonomy);

    assert.equal(await dismissTerminalOrganizeJob({
      jobId: job.jobId,
      expectedRevision: cancelled.revision,
    }), true);
    assert.equal(await getOrganizeJob(job.jobId), undefined);
    assert.equal(await db.organizeItems.where('jobId').equals(job.jobId).count(), 0);
    assert.equal(await getOrganizeTaxonomy(job.jobId), undefined);
    assert.equal(await db.organizeApplies.where('jobId').equals(job.jobId).count(), 0);
  });

  it('rejects a nonzero create cursor instead of fabricating prior outcomes', async () => {
    await assert.rejects(
      () => createOrganizeJob({ ...jobInput(['owner/repo']), nextFrozenIndex: 1 }),
      /must begin at nextFrozenIndex 0/u,
    );
  });

  it('preserves a caller-preallocated organize job identity', async () => {
    const jobId = 'organize-job:v1:preallocated-store';
    const created = await createOrganizeJob({
      ...jobInput(['owner/preallocated']),
      jobId,
    });
    assert.equal(created.jobId, jobId);
    assert.equal((await getOrganizeJob(jobId))?.jobId, jobId);
    await assert.rejects(
      () => createOrganizeJob({ ...jobInput(['owner/duplicate']), jobId }),
      /active job/u,
    );
  });

  it('revision-checks concurrent takeover and never rewrites origin provenance', async () => {
    const created = await createOrganizeJob(jobInput(['owner/origin-job']));
    await Promise.all([
      ensureAgentSession('session:takeover-a'),
      ensureAgentSession('session:takeover-b'),
    ]);

    const attempts = await Promise.allSettled([
      takeControlOrganizeJob({
        jobId: created.jobId,
        controllerId: 'controller:takeover-a',
        sessionId: 'session:takeover-a',
        expectedRevision: created.revision,
        now: 2,
      }),
      takeControlOrganizeJob({
        jobId: created.jobId,
        controllerId: 'controller:takeover-b',
        sessionId: 'session:takeover-b',
        expectedRevision: created.revision,
        now: 3,
      }),
    ]);

    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    const controlled = (await getOrganizeJob(created.jobId))!;
    assert.equal(controlled.revision, created.revision + 1);
    assert.equal(controlled.originAgentSessionId, created.originAgentSessionId);
    assert.notEqual(controlled.sessionId, created.sessionId);
    await assert.rejects(
      () => takeControlOrganizeJob({
        jobId: created.jobId,
        controllerId: 'controller:stale',
        sessionId: 'session:takeover-a',
        expectedRevision: created.revision,
      }),
      /revision is stale/u,
    );
    assert.equal((await getOrganizeJob(created.jobId))?.originAgentSessionId, created.sessionId);

    const continued = await advanceOrganizeJobRun({
      jobId: created.jobId,
      runId: parseRunId('run:v1:takeover-continuation'),
      generation: created.generation + 1,
      expectedParent: {
        runId: parseRunId(created.runId),
        generation: created.generation,
      },
      proposalId: parseProposalId('proposal:v1:takeover-continuation'),
      budget: createProductionRunBudget(),
      usage: createEmptyRunBudgetUsage(),
      startFrozenIndex: created.nextFrozenIndex,
      analysisPendingRanges: [],
      now: 4,
    });
    assert.equal(continued.controllerId, controlled.controllerId);
    assert.equal(continued.sessionId, controlled.sessionId);
    assert.equal(continued.originAgentSessionId, created.originAgentSessionId);
  });

  it('never leaves an orphan Agent origin when session deletion races job creation', async () => {
    const input = jobInput(['owner/session-race']);
    await createAgentSession({ idFactory: () => input.sessionId });

    const results = await Promise.allSettled([
      deleteAgentSession(input.sessionId),
      createStoredOrganizeJob(input),
    ]);

    assert.ok(results.filter((result) => result.status === 'fulfilled').length >= 1);
    const jobs = await db.organizeJobs.toArray();
    for (const job of jobs) {
      assert.ok(await db.agentSessions.get(job.originAgentSessionId));
    }
  });

  it('keeps explicit control idempotent when the durable owner is unchanged', async () => {
    const created = await createOrganizeJob(jobInput(['owner/idempotent-control']));
    const controlled = await takeControlOrganizeJob({
      jobId: created.jobId,
      controllerId: created.controllerId,
      sessionId: created.sessionId,
      expectedRevision: created.revision,
      now: created.updatedAt + 100,
    });

    assert.equal(controlled.revision, created.revision);
    assert.equal(controlled.updatedAt, created.updatedAt);
    assert.deepEqual(await getOrganizeJob(created.jobId), created);
  });

  it('persists a frozen preflight across workers and starts it idempotently', async () => {
    const input = preflightInput(['owner/first', 'owner/second']);
    const ready = await createOrganizePreflight(input);

    assert.equal(ready.status, 'preflight_ready');
    assert.equal(await getActiveOrganizeJob(), undefined);
    assert.equal((await getReadyOrganizePreflight({
      controllerId: input.controllerId,
      sessionId: input.sessionId,
      now: 150,
    }))?.jobId, ready.jobId);

    const started = await activateOrganizePreflight({
      preflightToken: input.preflightToken,
      controllerId: input.controllerId,
      sessionId: input.sessionId,
      taskInstruction: input.taskInstruction,
      now: 150,
    });
    assert.equal(started.disposition, 'started');
    assert.equal(started.job.status, 'analyzing');
    assert.equal((await getActiveOrganizeJob())?.jobId, ready.jobId);

    const replayed = await activateOrganizePreflight({
      preflightToken: input.preflightToken,
      controllerId: input.controllerId,
      sessionId: input.sessionId,
      taskInstruction: 'A replay must return the active durable run.',
      now: 160,
    });
    assert.equal(replayed.disposition, 'already_started');
    assert.equal(replayed.job.runId, started.job.runId);
    assert.equal(await db.organizeJobs.count(), 1);
    assert.equal(await db.organizeItems.count(), 2);
  });

  it('keeps preflight origin immutable during explicit control takeover', async () => {
    const input = preflightInput(['owner/origin-preflight']);
    const ready = await createOrganizePreflight(input);
    await ensureAgentSession('session:replacement-preflight');

    const controlled = await takeControlOrganizeJob({
      jobId: ready.jobId,
      controllerId: 'controller:replacement-preflight',
      sessionId: 'session:replacement-preflight',
      expectedRevision: ready.revision,
      now: 2,
    });

    assert.equal(ready.originAgentSessionId, input.sessionId);
    assert.equal(controlled.sessionId, 'session:replacement-preflight');
    assert.equal(controlled.originAgentSessionId, input.sessionId);
    assert.equal((await getOrganizeJob(ready.jobId))?.originAgentSessionId, input.sessionId);
  });

  it('rejects blank activation identity and instruction before reading the durable token', async () => {
    const input = preflightInput(['owner/blank-validation']);
    await createOrganizePreflight(input);
    await assert.rejects(
      () => activateOrganizePreflight({
        ...input,
        controllerId: ' ',
      }),
      /controllerId must be nonempty/u,
    );
    await assert.rejects(
      () => activateOrganizePreflight({
        ...input,
        taskInstruction: '\t',
      }),
      /taskInstruction must be nonempty/u,
    );
  });

  it('rejects consumed preflight replay after its job becomes terminal', async () => {
    for (const status of ['cancelled', 'completed'] as const) {
      const input = preflightInput([`owner/${status}`], {
        jobId: `organize-job:v1:terminal-${status}`,
        preflightToken: `preflight:v1:terminal-${status}`,
        requestId: `request:terminal-${status}`,
        controllerId: `controller:v1:terminal-${status}`,
        sessionId: `session:terminal-${status}`,
      });
      await createOrganizePreflight(input);
      const started = await activateOrganizePreflight({
        preflightToken: input.preflightToken,
        controllerId: input.controllerId,
        sessionId: input.sessionId,
        taskInstruction: input.taskInstruction,
        now: 150,
      });
      await db.organizeJobs.update(started.job.jobId, {
        status,
        activeSlot: undefined,
      });

      await assert.rejects(() => activateOrganizePreflight({
        preflightToken: input.preflightToken,
        controllerId: input.controllerId,
        sessionId: input.sessionId,
        taskInstruction: input.taskInstruction,
        now: 160,
      }), /invalid or stale/u);
    }
  });

  it('expires and cancels durable preflights without exposing them as active jobs', async () => {
    const expiredInput = preflightInput(['owner/expired'], {
      preflightToken: 'preflight:v1:expired-store',
      requestId: 'request:expired-store',
      expiresAt: 110,
    });
    await createOrganizePreflight(expiredInput);
    await assert.rejects(() => activateOrganizePreflight({
      preflightToken: expiredInput.preflightToken,
      controllerId: expiredInput.controllerId,
      sessionId: expiredInput.sessionId,
      taskInstruction: expiredInput.taskInstruction,
      now: 111,
    }), /expired/u);
    assert.equal(await getReadyOrganizePreflight({
      controllerId: expiredInput.controllerId,
      sessionId: expiredInput.sessionId,
      now: 111,
    }), null);

    const cancelledInput = preflightInput(['owner/cancelled'], {
      preflightToken: 'preflight:v1:cancelled-store',
      requestId: 'request:cancelled-store',
      controllerId: 'controller:v1:cancel-store',
      sessionId: 'session:cancel-store',
    });
    await createOrganizePreflight(cancelledInput);
    assert.equal(await cancelOrganizePreflight({
      controllerId: cancelledInput.controllerId,
      sessionId: cancelledInput.sessionId,
      requestId: cancelledInput.requestId,
      now: 120,
    }), true);
    assert.equal(await getActiveOrganizeJob(), undefined);
    assert.equal(await cancelOrganizePreflight({
      controllerId: cancelledInput.controllerId,
      sessionId: cancelledInput.sessionId,
      requestId: cancelledInput.requestId,
      now: 121,
    }), false);
  });

  it('prunes expired abandoned preflights when another confirmation is created', async () => {
    const abandonedJobId = 'organize-job:v1:abandoned-store';
    const currentJobId = 'organize-job:v1:current-store';
    const abandoned = preflightInput(['owner/abandoned-first', 'owner/abandoned-second'], {
      jobId: abandonedJobId,
      preflightToken: 'preflight:v1:abandoned-store',
      requestId: 'request:abandoned-store',
      controllerId: 'controller:v1:abandoned-store',
      sessionId: 'session:abandoned-store',
      now: 100,
      expiresAt: 110,
    });
    const current = preflightInput(['owner/current'], {
      jobId: currentJobId,
      preflightToken: 'preflight:v1:current-store',
      requestId: 'request:current-store',
      controllerId: 'controller:v1:current-store',
      sessionId: 'session:current-store',
      now: 120,
      expiresAt: 200,
    });
    await createOrganizePreflight(abandoned);
    await createOrganizePreflight(current);

    assert.equal(await getOrganizeJob(abandonedJobId), undefined);
    assert.equal((await getOrganizeJob(currentJobId))?.status, 'preflight_ready');
    assert.equal(await db.organizeJobs.count(), 1);
    assert.equal(await db.organizeItems.count(), 1);
    assert.equal(await db.organizeTaxonomies.count(), 1);
  });

  it('rejects a preflight start when its owner or frozen instruction changes', async () => {
    const input = preflightInput(['owner/guarded']);
    await createOrganizePreflight(input);
    await assert.rejects(() => activateOrganizePreflight({
      preflightToken: input.preflightToken,
      controllerId: input.controllerId,
      sessionId: 'session:other',
      taskInstruction: input.taskInstruction,
      now: 150,
    }), /another controller|session/u);
    await assert.rejects(() => activateOrganizePreflight({
      preflightToken: input.preflightToken,
      controllerId: input.controllerId,
      sessionId: input.sessionId,
      taskInstruction: 'A different instruction.',
      now: 150,
    }), /instruction/u);
  });
});

function preflightInput(
  repositoryIds: string[],
  overrides: Partial<ReturnType<typeof jobInput> & {
    jobId: string;
    preflightToken: string;
    requestId: string;
    expiresAt: number;
  }> = {},
) {
  return {
    ...jobInput(repositoryIds),
    activeSlot: undefined,
    preflightToken: 'preflight:v1:store-test',
    requestId: 'request:store-test',
    expiresAt: 200,
    ...overrides,
  };
}

function jobInput(
  repositoryIds: string[],
  taxonomy: Readonly<{ fingerprint: string; snapshot: unknown }> = {
    fingerprint: 'taxonomy:v1:test',
    snapshot: { entries: [] },
  },
) {
  return {
    controllerId: `controller:${repositoryIds[0] ?? 'empty'}`,
    sessionId: `session:${repositoryIds[0] ?? 'empty'}`,
    runId: `run:v1:${repositoryIds[0] ?? 'empty'}`,
    generation: 1,
    frozenScope: {
      kind: 'all_stars',
      label: 'All stars',
      filterSnapshot: {},
      repositoryIds,
      capturedAt: 1,
      fingerprint: `scope:${repositoryIds.length}`,
    },
    taskInstruction: 'Organize all tags.',
    tagPolicy: { maxTagsPerRepo: 5, minTopicRepoCount: 1 },
    taxonomy,
    budget: { maxBatches: 10 },
    usage: { batches: 0 },
    now: 1,
  };
}
