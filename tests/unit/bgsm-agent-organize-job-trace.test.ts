import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import {
  createDevOrganizeJobRunTraceFactory,
  createDevTraceRecorder,
  DevTraceDB,
  reconcileDevOrganizeJobRunProvisionalRoots,
} from '@/agent-observability';
import {
  parseControllerId,
  parseOrganizeJobId,
  parseRunId,
} from '@/bgsm-agent';
import { createBgsmOrganizeJobTraceCoordinator } from '@/background/organize-job-trace';
import type { OrganizeJobRunSnapshot } from '@/bgsm-agent/events';

const databases: DevTraceDB[] = [];

function database(suffix: string): DevTraceDB {
  const db = new DevTraceDB(`organize-job-trace-${suffix}-${crypto.randomUUID()}`);
  databases.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (db) => {
    db.close();
    await db.delete();
  }));
});

describe('BGSM Agent OrganizeJobRun trace', () => {
  it('uses one preallocated job root across mutable generations and worker restore', async () => {
    const db = database('identity');
    const jobId = parseOrganizeJobId('organize-job:v1:trace-identity');
    let id = 0;
    const firstRecorder = createDevTraceRecorder({
      db,
      now: () => 100 + id,
      monotonicNow: () => id,
      randomId: () => `organize-event-${++id}`,
    });
    const first = createDevOrganizeJobRunTraceFactory({ recorder: firstRecorder })({
      jobId,
      executionEpochId: 'organize-epoch:first',
      startedAt: 100,
    });
    first.recordPreflight('requested', null);
    first.recordPreflight('ready', 290);
    first.recordPreflight('started', 290);
    const generationSource = {
      runId: parseRunId('run:v1:first-generation'),
      generation: 1,
      state: 'frozen' as const,
      cause: 'initial' as const,
      parentRunId: null,
      parentGeneration: null,
      repositoryCount: 290,
      repositoryId: 'private-owner/private-repository',
      tag: 'private-tag',
      taskInstruction: 'private task instruction',
    };
    first.recordGeneration(generationSource);
    first.recordGeneration({
      runId: parseRunId('run:v1:continuation-generation'),
      generation: 2,
      state: 'prepared',
      cause: 'continuation',
      parentRunId: generationSource.runId,
      parentGeneration: generationSource.generation,
      repositoryCount: 290,
    });
    await first.flush();

    const secondRecorder = createDevTraceRecorder({
      db,
      now: () => 900 + id,
      monotonicNow: () => id,
      randomId: () => `organize-event-${++id}`,
    });
    const restored = createDevOrganizeJobRunTraceFactory({ recorder: secondRecorder })({
      jobId,
      executionEpochId: 'organize-epoch:restored',
      startedAt: 900,
      resumeExisting: true,
    });
    restored.recordGeneration({
      runId: parseRunId('run:v1:restored-generation'),
      generation: 3,
      state: 'restored',
      cause: 'restore',
      parentRunId: null,
      parentGeneration: null,
      repositoryCount: 290,
    });
    restored.finish('completed', 'apply_completed');
    await restored.flush();

    const roots = await db.roots.toArray();
    const events = await db.events.orderBy('[rootOperationId+sequence]').toArray();
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.rootOperationId, `organize_job:${jobId}`);
    assert.equal(events.filter((event) => event.kind === 'root_started').length, 1);
    assert.deepEqual(
      events.filter((event) => event.kind === 'organize_generation_state').map((event) => event.data),
      [
        {
          runId: 'run:v1:first-generation',
          generation: 1,
          state: 'frozen',
          cause: 'initial',
          parentRunId: null,
          parentGeneration: null,
          repositoryCount: 290,
        },
        {
          runId: 'run:v1:continuation-generation',
          generation: 2,
          state: 'prepared',
          cause: 'continuation',
          parentRunId: 'run:v1:first-generation',
          parentGeneration: 1,
          repositoryCount: 290,
        },
        {
          runId: 'run:v1:restored-generation',
          generation: 3,
          state: 'restored',
          cause: 'restore',
          parentRunId: null,
          parentGeneration: null,
          repositoryCount: 290,
        },
      ],
    );
    assert.equal(events.at(-1)?.kind, 'root_terminal');
    assert.doesNotMatch(
      JSON.stringify(events),
      /private-owner|private-repository|private-tag|private task instruction/u,
    );
  });

  it('closes every provisional exit with a precise terminal state', async () => {
    const db = database('provisional');
    let id = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: () => 1_000 + id,
      monotonicNow: () => id,
      randomId: () => `provisional-event-${++id}`,
    });
    const coordinator = createBgsmOrganizeJobTraceCoordinator({
      executionEpochId: 'organize-epoch:provisional',
      traceFactory: createDevOrganizeJobRunTraceFactory({ recorder }),
      now: () => 1_000,
    });
    const cases = [
      ['no-work', 'no_work', 'completed', 'no_work'],
      ['cancelled', 'cancelled', 'cancelled', 'preflight_cancelled'],
      ['expired', 'expired', 'cancelled', 'preflight_expired'],
      ['stale', 'stale', 'cancelled', 'preflight_stale'],
      ['disconnected', 'disconnected', 'cancelled', 'preflight_disconnected'],
      ['worker-lost', 'worker_lost', 'attempt_state_lost', 'worker_state_lost'],
    ] as const;

    for (const [suffix, state] of cases) {
      const jobId = parseOrganizeJobId(`organize-job:v1:${suffix}`);
      coordinator.begin(jobId);
      coordinator.recordPreflight({ jobId, state, repositoryCount: 0 });
      await coordinator.flush(jobId);
    }

    for (const [suffix, , terminalState, terminalReasonCode] of cases) {
      const root = await db.roots.get(`organize_job:organize-job:v1:${suffix}`);
      assert.equal(root?.terminalState, terminalState);
      assert.equal(root?.terminalReasonCode, terminalReasonCode);
    }
  });

  it('records restored snapshots without making mutable controller/session IDs root authority', async () => {
    const db = database('coordinator');
    let id = 0;
    const coordinator = createBgsmOrganizeJobTraceCoordinator({
      executionEpochId: 'organize-epoch:coordinator',
      traceFactory: createDevOrganizeJobRunTraceFactory({
        recorder: createDevTraceRecorder({
          db,
          now: () => 2_000 + id,
          monotonicNow: () => id,
          randomId: () => `coordinator-event-${++id}`,
        }),
      }),
      now: () => 2_000,
    });
    const jobId = parseOrganizeJobId('organize-job:v1:coordinator');
    const snapshot = {
      controllerId: parseControllerId('controller:v1:replacement'),
      sessionId: 'replacement-session',
      runId: parseRunId('run:v1:replacement'),
      generation: 7,
      frozenScope: { count: 501 },
    } as OrganizeJobRunSnapshot;
    coordinator.resume(jobId);
    coordinator.recordGeneration(jobId, snapshot, {
      state: 'restored',
      cause: 'restore',
      parentRunId: null,
      parentGeneration: null,
    });
    await coordinator.flush(jobId);

    const root = (await db.roots.toArray())[0];
    assert.equal(root?.rootOperationId, `organize_job:${jobId}`);
    assert.equal(root?.sessionId, null);
    assert.equal(root?.attemptId, null);
    assert.equal(root?.baseRevision, null);
  });

  it('records metadata-only restore failures even after a prior terminal result', async () => {
    const db = database('restore-failure');
    const jobId = parseOrganizeJobId('organize-job:v1:restore-failure');
    const factory = createDevOrganizeJobRunTraceFactory({
      recorder: createDevTraceRecorder({ db }),
    });
    const first = factory({
      jobId,
      executionEpochId: 'organize-epoch:restore-failure-first',
      startedAt: 1_000,
    });
    first.finish('completed', 'apply_completed');
    await first.flush();

    const restored = factory({
      jobId,
      executionEpochId: 'organize-epoch:restore-failure-second',
      startedAt: 2_000,
      resumeExisting: true,
    });
    restored.recordRestore({ state: 'started', reasonCode: null });
    restored.recordRestore({
      state: 'failed',
      reasonCode: 'checkpoint_invariant',
      rawError: 'Analyzed private-owner/private-repository with Bearer secret',
    } as Parameters<typeof restored.recordRestore>[0]);
    await restored.flush();

    const rootId = `organize_job:${jobId}`;
    const events = await db.events.where('rootOperationId').equals(rootId).sortBy('sequence');
    assert.deepEqual(
      events.filter((event) => event.kind === 'organize_restore_state').map((event) => event.data),
      [
        { state: 'started', reasonCode: null },
        { state: 'failed', reasonCode: 'checkpoint_invariant' },
      ],
    );
    assert.equal((await db.roots.get(rootId))?.terminalState, 'completed');
    assert.doesNotMatch(JSON.stringify(events), /private-owner|private-repository|Bearer secret/u);
  });

  it('records OrganizeJobRun heartbeat and deadline transitions as metadata-only watchdog states', async () => {
    const db = database('watchdog');
    let id = 0;
    const coordinator = createBgsmOrganizeJobTraceCoordinator({
      executionEpochId: 'organize-epoch:watchdog',
      traceFactory: createDevOrganizeJobRunTraceFactory({
        recorder: createDevTraceRecorder({
          db,
          now: () => 3_000 + id,
          monotonicNow: () => id,
          randomId: () => `watchdog-event-${++id}`,
        }),
      }),
      now: () => 3_000,
    });
    const jobId = parseOrganizeJobId('organize-job:v1:watchdog');

    const armedHeartbeat = {
      watchdog: 'organize_heartbeat',
      state: 'armed',
      limitMs: 20_000,
      repositoryName: 'private-owner/private-repository',
    } as const;
    coordinator.recordWatchdog(jobId, armedHeartbeat);
    coordinator.recordWatchdog(jobId, {
      watchdog: 'organize_heartbeat',
      state: 'progress',
      limitMs: 20_000,
    });
    coordinator.recordWatchdog(jobId, {
      watchdog: 'organize_wall_deadline',
      state: 'armed',
      limitMs: 300_000,
    });
    coordinator.recordWatchdog(jobId, {
      watchdog: 'organize_wall_deadline',
      state: 'expired',
      limitMs: 300_000,
    });
    await coordinator.flush(jobId);

    const events = await db.events
      .where('rootOperationId')
      .equals(`organize_job:${jobId}`)
      .filter((event) => event.kind === 'watchdog_state')
      .sortBy('sequence');
    assert.deepEqual(events.map((event) => event.data), [
      { watchdog: 'organize_heartbeat', state: 'armed', limitMs: 20_000 },
      { watchdog: 'organize_heartbeat', state: 'progress', limitMs: 20_000 },
      { watchdog: 'organize_wall_deadline', state: 'armed', limitMs: 300_000 },
      { watchdog: 'organize_wall_deadline', state: 'expired', limitMs: 300_000 },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /private-owner|private-repository/u);
  });

  it('records nested batch and Provider-attempt spans in causal order without content', async () => {
    const db = database('batch-spans');
    const jobId = parseOrganizeJobId('organize-job:v1:batch-spans');
    let id = 0;
    const trace = createDevOrganizeJobRunTraceFactory({
      recorder: createDevTraceRecorder({
        db,
        now: () => 4_000 + id,
        monotonicNow: () => id,
        randomId: () => `batch-span-event-${++id}`,
      }),
    })({
      jobId,
      executionEpochId: 'organize-epoch:batch-spans',
      startedAt: 4_000,
    });
    trace.recordGeneration({
      runId: parseRunId('run:v1:batch-spans'),
      generation: 0,
      state: 'frozen',
      cause: 'initial',
      parentRunId: null,
      parentGeneration: null,
      repositoryCount: 3,
    });
    const batch = {
      runId: parseRunId('run:v1:batch-spans'),
      generation: 0,
      batchStart: 0,
      batchEnd: 3,
      repositoryCount: 3,
      localOnlyCount: 1,
      providerCount: 2,
      repositoryName: 'private-owner/private-repository',
      tag: 'private-tag',
      prompt: 'private prompt',
    };
    trace.recordBatch({ ...batch, state: 'scheduled' });
    trace.recordBatch({ ...batch, state: 'loaded' });
    const attempt = {
      runId: batch.runId,
      generation: 0,
      batchStart: 0,
      batchEnd: 3,
      requestBytes: 512,
      requestedOutputTokens: 256,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reasonCode: null,
      rawError: 'Bearer private-provider-token',
      requestBody: { repositories: ['private-owner/private-repository'] },
    };
    trace.recordProviderAttempt({ ...attempt, attempt: 1, state: 'prepared' });
    trace.recordProviderAttempt({ ...attempt, attempt: 1, state: 'admitted' });
    trace.recordProviderAttempt({
      ...attempt,
      attempt: 1,
      state: 'failed',
      reasonCode: 'invalid_or_failed',
    });
    trace.recordProviderAttempt({ ...attempt, attempt: 2, state: 'prepared' });
    trace.recordProviderAttempt({ ...attempt, attempt: 2, state: 'admitted' });
    trace.recordProviderAttempt({
      ...attempt,
      attempt: 2,
      state: 'succeeded',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    trace.recordBatch({ ...batch, state: 'provider_completed' });
    await trace.flush();

    const rootId = `organize_job:${jobId}`;
    const spans = await db.spans.where('rootOperationId').equals(rootId).toArray();
    const rootSpan = spans.find((span) => span.spanKind === 'root');
    const batchSpan = spans.find((span) => span.spanKind === 'organize_batch');
    const providerSpans = spans.filter((span) => span.spanKind === 'organize_provider_attempt');
    assert.ok(rootSpan);
    assert.ok(batchSpan);
    assert.equal(batchSpan.parentSpanId, rootSpan.spanId);
    assert.equal(batchSpan.endedAt !== null, true);
    assert.equal(providerSpans.length, 2);
    assert.equal(providerSpans.every((span) => span.parentSpanId === batchSpan.spanId), true);
    assert.equal(providerSpans.every((span) => span.endedAt !== null), true);

    const events = await db.events.where('rootOperationId').equals(rootId).sortBy('sequence');
    assert.deepEqual(
      events.slice(1).map((event) => [event.kind, 'state' in event.data ? event.data.state : null]),
      [
        ['organize_generation_state', 'frozen'],
        ['organize_batch_state', 'scheduled'],
        ['organize_batch_state', 'loaded'],
        ['organize_provider_attempt', 'prepared'],
        ['organize_provider_attempt', 'admitted'],
        ['organize_provider_attempt', 'failed'],
        ['organize_provider_attempt', 'prepared'],
        ['organize_provider_attempt', 'admitted'],
        ['organize_provider_attempt', 'succeeded'],
        ['organize_batch_state', 'provider_completed'],
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(events),
      /private-owner|private-repository|private-tag|private prompt|private-provider-token|requestBody/u,
    );

    trace.finish('completed', 'review_ready');
    await trace.flush();
    assert.equal((await db.roots.get(rootId))?.terminalReasonCode, 'review_ready');
  });

  it('traces review through Apply chunks and closes success when the receipt becomes available', async () => {
    const db = database('review-apply-receipt');
    const jobId = parseOrganizeJobId('organize-job:v1:review-apply-receipt');
    let id = 0;
    const coordinator = createBgsmOrganizeJobTraceCoordinator({
      executionEpochId: 'organize-epoch:review-apply-receipt',
      traceFactory: createDevOrganizeJobRunTraceFactory({
        recorder: createDevTraceRecorder({
          db,
          now: () => 4_500 + id,
          monotonicNow: () => id,
          randomId: () => `review-apply-receipt-event-${++id}`,
        }),
      }),
      now: () => 4_500,
    });
    coordinator.begin(jobId);
    coordinator.recordReview(jobId, {
      runId: 'run:v1:review-apply-receipt',
      generation: 1,
      revision: 4,
      state: 'ready',
      actionableRepositories: 3,
      selectedRepositories: 3,
      selectedActions: 4,
      rowOffset: null,
      rowCount: 0,
      nextRowOffset: null,
    });
    coordinator.recordSelection(jobId, {
      runId: 'run:v1:review-apply-receipt',
      generation: 1,
      previousRevision: 4,
      revision: 5,
      mode: 'partial',
      affectedRepositories: 2,
      selectedRepositories: 2,
      selectedActions: 3,
    });
    coordinator.recordApply(jobId, {
      applyId: 'organize-apply:trace',
      executionId: null,
      revision: 6,
      state: 'sealed',
      total: 2,
      settled: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    coordinator.recordApply(jobId, {
      applyId: 'organize-apply:trace',
      executionId: 'apply-execution:trace',
      revision: null,
      state: 'attempt_started',
      total: null,
      settled: null,
      changed: null,
      unchanged: null,
      skipped: null,
      failed: null,
    });
    const chunk = {
      applyId: 'organize-apply:trace',
      executionId: 'apply-execution:trace',
      chunkSequence: 1,
      positionStart: 7,
      positionEnd: 9,
      rowCount: 2,
      maxAttemptCount: 1,
      repositoryName: 'private-owner/private-repository',
      approvedTags: ['private-tag'],
    };
    coordinator.recordApplyChunk(jobId, {
      ...chunk,
      state: 'claimed',
      changed: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      complete: null,
    });
    coordinator.recordApplyChunk(jobId, {
      ...chunk,
      state: 'settled',
      changed: 1,
      unchanged: 0,
      skipped: 1,
      failed: 0,
      complete: true,
    });
    coordinator.recordApply(jobId, {
      applyId: 'organize-apply:trace',
      executionId: 'apply-execution:trace',
      revision: null,
      state: 'attempt_completed',
      total: null,
      settled: null,
      changed: null,
      unchanged: null,
      skipped: null,
      failed: null,
    });
    const receipt = {
      applyId: 'organize-apply:trace',
      total: 2,
      changed: 1,
      unchanged: 0,
      skipped: 1,
      failed: 0,
    };
    coordinator.recordReceipt(jobId, {
      ...receipt,
      state: 'available',
      rowOffset: null,
      rowCount: 0,
      nextRowOffset: null,
      filter: null,
    }, { state: 'completed', reasonCode: 'apply_completed' });
    await coordinator.flush(jobId);

    coordinator.recordReceipt(jobId, {
      ...receipt,
      state: 'page_delivered',
      rowOffset: 0,
      rowCount: 2,
      nextRowOffset: null,
      filter: 'all',
    });
    await coordinator.flush(jobId);
    coordinator.recordReceipt(jobId, {
      ...receipt,
      state: 'dismissed',
      rowOffset: null,
      rowCount: 0,
      nextRowOffset: null,
      filter: null,
    });
    await coordinator.flush(jobId);

    const rootId = `organize_job:${jobId}`;
    const root = await db.roots.get(rootId);
    assert.equal(root?.terminalState, 'completed');
    assert.equal(root?.terminalReasonCode, 'apply_completed');
    const events = await db.events.where('rootOperationId').equals(rootId).sortBy('sequence');
    assert.equal(events.filter((event) => event.kind === 'root_started').length, 1);
    assert.equal(events.filter((event) => event.kind === 'root_terminal').length, 1);
    assert.deepEqual(
      events.flatMap((event) => (
        event.kind === 'organize_receipt_state' && 'state' in event.data ? [event.data.state] : []
      )),
      ['available', 'page_delivered', 'dismissed'],
    );
    const terminalIndex = events.findIndex((event) => event.kind === 'root_terminal');
    const receiptIndexes = events.flatMap((event, index) => event.kind === 'organize_receipt_state' ? [index] : []);
    assert.equal(receiptIndexes[0]! < terminalIndex, true);
    assert.equal(receiptIndexes[1]! > terminalIndex, true);
    assert.equal(receiptIndexes[2]! > terminalIndex, true);
    const spans = await db.spans.where('rootOperationId').equals(rootId).toArray();
    const applySpan = spans.find((span) => span.spanKind === 'organize_apply_attempt');
    const chunkSpan = spans.find((span) => span.spanKind === 'organize_apply_chunk');
    const receiptSpan = spans.find((span) => span.spanKind === 'organize_receipt');
    assert.ok(applySpan);
    assert.ok(chunkSpan);
    assert.ok(receiptSpan);
    assert.equal(chunkSpan.parentSpanId, applySpan.spanId);
    assert.equal(applySpan.endedAt !== null, true);
    assert.equal(chunkSpan.endedAt !== null, true);
    assert.equal(receiptSpan.endedAt !== null, true);
    assert.doesNotMatch(JSON.stringify(events), /private-owner|private-repository|private-tag/u);
  });

  it('closes no-change completion explicitly without waiting for a generation terminal', async () => {
    const db = database('no-changes-terminal');
    const jobId = parseOrganizeJobId('organize-job:v1:no-changes-terminal');
    const coordinator = createBgsmOrganizeJobTraceCoordinator({
      executionEpochId: 'organize-epoch:no-changes-terminal',
      traceFactory: createDevOrganizeJobRunTraceFactory({ recorder: createDevTraceRecorder({ db }) }),
    });
    coordinator.begin(jobId);
    coordinator.recordRunTerminal(jobId, 'completed', 'no_changes');
    await coordinator.flush(jobId);
    assert.equal((await db.roots.get(`organize_job:${jobId}`))?.terminalState, null);
    coordinator.completeNoChanges(jobId);
    await coordinator.flush(jobId);
    const root = await db.roots.get(`organize_job:${jobId}`);
    assert.equal(root?.terminalState, 'completed');
    assert.equal(root?.terminalReasonCode, 'no_changes');
  });

  it('reconciles durable revision gaps across recorder and worker epochs', async () => {
    const db = database('durable-revisions');
    const jobId = parseOrganizeJobId('organize-job:v1:durable-revisions');
    let id = 0;
    const first = createDevOrganizeJobRunTraceFactory({
      recorder: createDevTraceRecorder({
        db,
        now: () => 5_000 + id,
        monotonicNow: () => id,
        randomId: () => `durable-revision-first-${++id}`,
      }),
    })({
      jobId,
      executionEpochId: 'organize-epoch:durable-first',
      startedAt: 5_000,
    });
    first.recordDurableState({ revision: 1, source: 'mutation' });
    first.recordDurableState({ revision: 2, source: 'mutation' });
    await first.flush();

    const restored = createDevOrganizeJobRunTraceFactory({
      recorder: createDevTraceRecorder({
        db,
        now: () => 6_000 + id,
        monotonicNow: () => id,
        randomId: () => `durable-revision-restored-${++id}`,
      }),
    })({
      jobId,
      executionEpochId: 'organize-epoch:durable-restored',
      startedAt: 6_000,
      resumeExisting: true,
    });
    restored.recordDurableState({ revision: 5, source: 'restore' });
    restored.recordDurableState({ revision: 5, source: 'reconnect' });
    restored.recordDurableState({ revision: 4, source: 'reconnect' });
    restored.recordDurableState({ revision: 6, source: 'mutation' });
    await restored.flush();

    const events = await db.events
      .where('rootOperationId')
      .equals(`organize_job:${jobId}`)
      .filter((event) => event.kind === 'organize_durable_state')
      .sortBy('sequence');
    assert.deepEqual(events.map((event) => event.data), [
      {
        revision: 1,
        previousRevision: null,
        observation: 'initial',
        missingFromRevision: null,
        missingToRevision: null,
        source: 'mutation',
      },
      {
        revision: 2,
        previousRevision: 1,
        observation: 'advanced',
        missingFromRevision: null,
        missingToRevision: null,
        source: 'mutation',
      },
      {
        revision: 5,
        previousRevision: 2,
        observation: 'gap_reconciled',
        missingFromRevision: 3,
        missingToRevision: 4,
        source: 'restore',
      },
      {
        revision: 5,
        previousRevision: 5,
        observation: 'duplicate',
        missingFromRevision: null,
        missingToRevision: null,
        source: 'reconnect',
      },
      {
        revision: 4,
        previousRevision: 5,
        observation: 'stale',
        missingFromRevision: null,
        missingToRevision: null,
        source: 'reconnect',
      },
      {
        revision: 6,
        previousRevision: 5,
        observation: 'advanced',
        missingFromRevision: null,
        missingToRevision: null,
        source: 'mutation',
      },
    ]);
  });

  it('settles only prior-worker provisional roots that have no durable organize job', async () => {
    const db = database('worker-loss');
    let id = 0;
    const factory = createDevOrganizeJobRunTraceFactory({
      recorder: createDevTraceRecorder({
        db,
        now: () => 3_000 + id,
        monotonicNow: () => id,
        randomId: () => `worker-loss-event-${++id}`,
      }),
    });
    const lostJobId = parseOrganizeJobId('organize-job:v1:lost-provisional');
    const durableJobId = parseOrganizeJobId('organize-job:v1:durable-active');
    const currentJobId = parseOrganizeJobId('organize-job:v1:current-provisional');
    for (const [jobId, executionEpochId] of [
      [lostJobId, 'organize-epoch:prior'],
      [durableJobId, 'organize-epoch:prior'],
      [currentJobId, 'organize-epoch:current'],
    ] as const) {
      const trace = factory({ jobId, executionEpochId, startedAt: 3_000 });
      trace.recordPreflight('requested', null);
      trace.recordPreflight('ready', 1);
      await trace.flush();
    }

    const reconciled = await reconcileDevOrganizeJobRunProvisionalRoots({
      executionEpochId: 'organize-epoch:current',
      durableJobIds: new Set([durableJobId]),
      db,
    });

    assert.equal(reconciled, 1);
    assert.equal((await db.roots.get(`organize_job:${lostJobId}`))?.terminalState, 'attempt_state_lost');
    assert.equal((await db.roots.get(`organize_job:${durableJobId}`))?.terminalState, null);
    assert.equal((await db.roots.get(`organize_job:${currentJobId}`))?.terminalState, null);
  });
});
