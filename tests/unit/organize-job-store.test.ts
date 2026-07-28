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
import { idbTagStore, resetDirtyForDev } from '@/storage/idb-tag-store';
import {
  attachOrganizeJob,
  advanceOrganizeJobRun,
  checkpointOrganizeAnalysisPage,
  cancelOrganizeJob,
  claimOrganizeAnalysisBatch,
  claimOrganizeApplyChunk,
  completeOrganizeJobWithoutApply,
  createOrganizeJob,
  dismissOrganizeReceipt,
  getActiveOrganizeJob,
  getOrganizeCoverage,
  getOrganizeJob,
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
} from '@/storage/organize-job-store';
import { fakeStar } from './test-utils';

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

    assert.equal(await dismissOrganizeReceipt(apply.applyId), true);
    assert.equal(await getOrganizeJob(job.jobId), undefined);
    assert.equal(await getOrganizeTaxonomy(job.jobId), undefined);
    assert.equal(await getOrganizeReceipt(apply.applyId), undefined);
  }, 20_000);

  it('blocks review when terminal analysis failures leave incomplete coverage', async () => {
    const job = await createOrganizeJob(jobInput(['owner/fails']));
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
    const attached = await attachOrganizeJob({
      jobId: job.jobId,
      controllerId: 'controller:replacement',
      sessionId: 'session:replacement',
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
      controllerId: job.controllerId,
      sessionId: job.sessionId,
      runId: run2,
      generation: 2,
      proposalId: parseProposalId('proposal:v1:exact-page-2'),
      budget: createProductionRunBudget(),
      usage: createEmptyRunBudgetUsage(),
      startFrozenIndex: 1,
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
      controllerId: job.controllerId,
      sessionId: job.sessionId,
      runId: childRunId,
      generation: 2,
      proposalId: parseProposalId('proposal:v1:lease-child'),
      budget: createProductionRunBudget(),
      usage: emptyUsage,
      startFrozenIndex: 0,
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

  it('prunes no-change, cancelled, and superseded terminal artifacts', async () => {
    const noChange = await createOrganizeJob(jobInput([]));
    await completeOrganizeJobWithoutApply(noChange.jobId);
    assert.equal(await db.organizeJobs.count(), 0);
    assert.equal(await db.organizeItems.count(), 0);
    assert.equal(await db.organizeTaxonomies.count(), 0);

    const star = fakeStar({ full_name: 'owner/old-receipt' });
    await db.stars.put(star);
    const completedJob = await createOrganizeJob(jobInput([star.full_name]));
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
    assert.equal(oldApply.status, 'completed');
    assert.equal(await db.organizeApplies.count(), 1);

    const replacement = await createOrganizeJob(jobInput(['owner/replacement']));
    assert.equal(await getOrganizeJob(completedJob.jobId), undefined);
    assert.equal(await getOrganizeReceipt(oldApply.applyId), undefined);
    assert.equal(await db.organizeJobs.count(), 1);
    assert.equal(await db.organizeItems.count(), 1);
    assert.equal(await db.organizeTaxonomies.count(), 1);

    assert.equal(await cancelOrganizeJob(replacement.jobId), true);
    assert.equal(await db.organizeJobs.count(), 0);
    assert.equal(await db.organizeItems.count(), 0);
    assert.equal(await db.organizeTaxonomies.count(), 0);
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

    const attached = await attachOrganizeJob({
      jobId,
      controllerId: 'controller:replacement',
      sessionId: 'session:replacement',
      now: 2,
    });
    assert.equal(attached.jobId, jobId);
    await assert.rejects(
      () => createOrganizeJob({ ...jobInput(['owner/duplicate']), jobId }),
      /active job/u,
    );
  });
});

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
    taxonomy,
    budget: { maxBatches: 10 },
    usage: { batches: 0 },
    now: 1,
  };
}
