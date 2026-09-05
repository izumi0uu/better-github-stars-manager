import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import {
  digestAgentSessionLaunch,
  type AgentSessionLaunchIdentity,
} from '@/bgsm-agent/session-transport';
import {
  agentArtifactCoverageDirectives,
  createAgentArtifactCoverage,
  settleAgentArtifactCoverageIncomplete,
  type AgentArtifactCoverageRecord,
} from '@/bgsm-agent/artifact-coverage';
import {
  abandonAgentSessionUncertainAttempt,
  AgentAttemptCorruptionError,
  admitAgentSessionTurn,
  checkpointAgentSessionArtifactEnvelope,
  createAgentSession,
  discardDamagedAgentSessionRecovery,
  dismissAgentSessionAttemptRetry,
  inspectDurableAgentSessionTurn,
  markAgentSessionAttemptStateUncertain,
  loadAgentSession,
  readAgentSessionRetryDraftCandidate,
  settleAgentSessionAttemptWithoutTransition,
  type AgentAttemptRecord,
} from '@/storage/agent-session-store';
import { createAgentAttemptCoordinator } from '@/background/agent-attempt-coordinator';
import { db } from '@/storage/db';
import {
  agentMessageLogicalByteLength,
  getAgentStorageUsage,
  reconcileAgentStorageUsage,
  storeAgentArtifact,
  type AgentArtifactRecord,
} from '@/storage/agent-storage-store';

const NOW = 1_800_000_000_000;

describe('durable Agent attempt authority', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  it('persists an exact lease-fenced Stop idempotently and retains safe same-worker retry', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-durable-stop' });
    const launch = attemptLaunch(created.session.id, 'attempt-durable-stop');
    const coordinator = createAgentAttemptCoordinator('worker-stop');
    const { launchDigest } = await coordinator.admit(launch, 'statically_read_only');
    const running = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.equal(await createAgentAttemptCoordinator('worker-stale').requestStop(launch), false);
    for (const stale of [
      { ...launch, turnAttemptId: 'attempt-other' },
      { ...launch, sessionId: 'session-other' },
      { ...launch, baseRevision: 1 },
      { ...launch, prompt: 'A different immutable prompt.' },
    ]) assert.equal(await coordinator.requestStop(stale), false);
    assert.deepEqual(await attemptRow(launch.sessionId, launch.turnAttemptId), running);

    assert.equal(await coordinator.requestStop(launch), true);
    const stopped = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.equal(stopped?.state, 'stop_pending');
    assert.equal(stopped?.writeSettlement, null);
    assert.deepEqual(stopped?.lease, running?.lease);
    assert.equal(await coordinator.requestStop(launch), true);
    assert.deepEqual(await attemptRow(launch.sessionId, launch.turnAttemptId), stopped);
    assert.equal((await readAgentSessionRetryDraftCandidate(launch.sessionId))?.settlement, 'stop_pending');

    await coordinator.settleWithoutTransition({
      sessionId: launch.sessionId, turnAttemptId: launch.turnAttemptId,
      launchDigest, outcome: terminalOutcome('aborted'),
    });
    const settled = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.equal(settled?.state, 'retryable');
    assert.equal(settled?.retryKind, 'stopped');
    assert.equal(settled?.lease, null);
    assert.equal(await coordinator.requestStop(launch), false);
    assert.deepEqual(await attemptRow(launch.sessionId, launch.turnAttemptId), settled);
  });
  it('rolls back failed Stop persistence without changing lease or storage accounting', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-stop-rollback' });
    const launch = attemptLaunch(created.session.id, 'attempt-stop-rollback');
    const coordinator = createAgentAttemptCoordinator('worker-stop-rollback');
    await coordinator.admit(launch, 'statically_read_only');
    const before = await attemptRow(launch.sessionId, launch.turnAttemptId);
    const usage = await getAgentStorageUsage();
    const put = vi.spyOn(db.agentAttempts, 'put').mockRejectedValueOnce(new Error('stop write failed'));
    try {
      await assert.rejects(() => coordinator.requestStop(launch), /stop write failed/u);
    } finally {
      put.mockRestore();
    }
    assert.deepEqual(await attemptRow(launch.sessionId, launch.turnAttemptId), before);
    assert.deepEqual(await getAgentStorageUsage(), usage);
  });

  it('never turns a started unsafe write into retry authority when Stop settles', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-stop-unsafe' });
    const launch = attemptLaunch(created.session.id, 'attempt-stop-unsafe');
    const coordinator = createAgentAttemptCoordinator('worker-stop-unsafe');
    const { launchDigest } = await coordinator.admit(launch, 'write_capable_or_unknown');
    assert.equal(await coordinator.requestStop(launch), true);
    await coordinator.settleWithoutTransition({
      sessionId: launch.sessionId, turnAttemptId: launch.turnAttemptId, launchDigest,
      outcome: { reason: 'aborted', changed: true, changedCount: 1, writeSettlement: 'unsafe' },
    });
    const settled = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.equal(settled?.state, 'terminal_non_retryable');
    assert.equal(settled?.writeSettlement, 'unsafe');
    assert.equal(await readAgentSessionRetryDraftCandidate(launch.sessionId), null);
  });


  for (const recoveryClass of ['statically_read_only', 'write_capable_or_unknown'] as const) {
    it(`never resumes stopped ${recoveryClass} authority after worker replacement`, async () => {
      const created = await createAgentSession({ idFactory: () => `session-stop-${recoveryClass}` });
      const launch = attemptLaunch(created.session.id, `attempt-stop-${recoveryClass}`);
      const original = createAgentAttemptCoordinator('worker-original');
      const { launchDigest } = await original.admit(launch, recoveryClass);
      assert.equal(await original.requestStop(launch), true);
      const replacement = createAgentAttemptCoordinator('worker-replacement');
      assert.equal(await replacement.inspectActive(launch.sessionId), null);
      const uncertain = await attemptRow(launch.sessionId, launch.turnAttemptId);
      assert.equal(uncertain?.state, 'state_uncertain');
      assert.equal(uncertain?.terminalReason, 'attempt_state_lost');
      assert.equal(uncertain?.writeSettlement, 'unsafe');
      assert.equal(uncertain?.lease, null);
      assert.equal(await readAgentSessionRetryDraftCandidate(launch.sessionId), null);
      assert.equal(await original.requestStop(launch), false);
      await original.settleWithoutTransition({
        sessionId: launch.sessionId, turnAttemptId: launch.turnAttemptId,
        launchDigest, outcome: terminalOutcome('aborted'),
      });
      assert.deepEqual(await attemptRow(launch.sessionId, launch.turnAttemptId), uncertain);
      await assert.rejects(
        () => replacement.admit(launch, recoveryClass),
        { name: 'AgentSessionAttemptConflictError' },
      );
    });
  }

  it('rejects Stop from the old epoch after an unstopped read-only recovery transfers the lease', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-stop-stale-epoch' });
    const launch = attemptLaunch(created.session.id, 'attempt-stop-stale-epoch');
    const original = createAgentAttemptCoordinator('worker-original');
    await original.admit(launch, 'statically_read_only');
    const replacement = createAgentAttemptCoordinator('worker-replacement');
    assert.deepEqual((await replacement.inspectActive(launch.sessionId))?.launch, launch);
    const recovered = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.equal(await original.requestStop(launch), false);
    assert.deepEqual(await attemptRow(launch.sessionId, launch.turnAttemptId), recovered);
    assert.equal(await replacement.requestStop(launch), true);
  });

  it('derives retry projection from a settled attempt without rewriting its admitted launch', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-attempt-projection' });
    const launch = attemptLaunch(created.session.id, 'attempt-projection');
    const launchDigest = await admit(launch, 'worker-projection');

    await settleAgentSessionAttemptWithoutTransition({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      launchDigest,
      executionEpochId: 'worker-projection',
      outcome: terminalOutcome('aborted'),
      now: () => NOW + 1,
    });

    assert.deepEqual(await readAgentSessionRetryDraftCandidate(launch.sessionId), {
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      baseRevision: launch.baseRevision,
      prompt: launch.prompt,
      kind: 'stopped',
      settlement: 'retryable',
      updatedAt: NOW + 1,
    });
    const stored = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.deepEqual(stored?.admittedLaunch, launch);
    assert.equal(stored?.admittedLaunchDigest, launchDigest);
    assert.equal(stored?.artifactContinuationControl, null);
    assert.equal(await db.agentAttemptRecoveries.count(), 0);
  });

  it('settles a retry source as retried and an unclaimed source as superseded atomically', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-attempt-source' });
    const source = attemptLaunch(created.session.id, 'attempt-source');
    const sourceDigest = await admit(source, 'worker-source');
    await settleAgentSessionAttemptWithoutTransition({
      sessionId: source.sessionId,
      turnAttemptId: source.turnAttemptId,
      launchDigest: sourceDigest,
      executionEpochId: 'worker-source',
      outcome: terminalOutcome('provider_error'),
      now: () => NOW + 1,
    });

    const retry = {
      ...source,
      turnAttemptId: 'attempt-retry',
      retrySourceAttemptId: source.turnAttemptId,
    };
    const retryDigest = await admit(retry, 'worker-retry');
    assert.equal((await attemptRow(source.sessionId, source.turnAttemptId))?.terminalReason, 'retried');
    assert.equal((await attemptRow(retry.sessionId, retry.turnAttemptId))?.state, 'running');

    await settleAgentSessionAttemptWithoutTransition({
      sessionId: retry.sessionId,
      turnAttemptId: retry.turnAttemptId,
      launchDigest: retryDigest,
      executionEpochId: 'worker-retry',
      outcome: terminalOutcome('aborted'),
      now: () => NOW + 2,
    });
    const fresh = {
      sessionId: source.sessionId,
      baseRevision: source.baseRevision,
      turnAttemptId: 'attempt-fresh',
      prompt: source.prompt,
    };
    await admit(fresh, 'worker-fresh');

    assert.equal((await attemptRow(retry.sessionId, retry.turnAttemptId))?.terminalReason, 'superseded');
    assert.equal((await attemptRow(fresh.sessionId, fresh.turnAttemptId))?.state, 'running');
  });

  it('dismisses only a retryable attempt through the explicit command', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-attempt-dismiss' });
    const launch = attemptLaunch(created.session.id, 'attempt-dismiss');
    const launchDigest = await admit(launch, 'worker-dismiss');
    await settleAgentSessionAttemptWithoutTransition({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      launchDigest,
      executionEpochId: 'worker-dismiss',
      outcome: terminalOutcome('aborted'),
      now: () => NOW + 1,
    });

    assert.equal(await dismissAgentSessionAttemptRetry({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      now: () => NOW + 2,
    }), true);
    assert.equal(await dismissAgentSessionAttemptRetry({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      now: () => NOW + 3,
    }), false);
    assert.equal(await readAgentSessionRetryDraftCandidate(launch.sessionId), null);
    assert.equal((await attemptRow(launch.sessionId, launch.turnAttemptId))?.terminalReason, 'dismissed');
  });

  it('abandons only the exact state-uncertain attempt while preserving audit identity', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-attempt-uncertain' });
    const launch = attemptLaunch(created.session.id, 'attempt-uncertain');
    const launchDigest = await admit(launch, 'worker-uncertain');
    const before = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.ok(before);

    assert.equal(await abandonAgentSessionUncertainAttempt({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      now: () => NOW + 1,
    }), false);
    assert.equal(await markAgentSessionAttemptStateUncertain({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      executionEpochId: 'worker-uncertain',
      now: () => NOW + 2,
    }), true);
    assert.equal(await abandonAgentSessionUncertainAttempt({
      sessionId: launch.sessionId,
      turnAttemptId: 'attempt-other',
      now: () => NOW + 3,
    }), false);
    assert.equal(await abandonAgentSessionUncertainAttempt({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      now: () => NOW + 4,
    }), true);

    const abandoned = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.ok(abandoned);
    assert.equal(abandoned.state, 'terminal_non_retryable');
    assert.equal(abandoned.terminalReason, 'abandoned');
    assert.deepEqual(abandoned.admittedLaunch, launch);
    assert.equal(abandoned.admittedLaunchDigest, launchDigest);
    assert.equal(abandoned.recoveryClass, before.recoveryClass);
    assert.equal(abandoned.writeSettlement, 'unsafe');
    assert.equal(abandoned.receipt, null);
    assert.equal(abandoned.lease, null);
    assert.equal(abandoned.artifactContinuationControl, null);
    assert.equal(await db.agentAttemptRecoveries.count(), 0);
    assert.equal(await abandonAgentSessionUncertainAttempt({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      now: () => NOW + 5,
    }), false);

    const leasedLaunch = attemptLaunch(created.session.id, 'attempt-uncertain-leased');
    await admit(leasedLaunch, 'worker-uncertain-leased');
    const leased = await attemptRow(leasedLaunch.sessionId, leasedLaunch.turnAttemptId);
    assert.ok(leased?.lease);
    await db.agentAttempts.update(leased.id, {
      state: 'state_uncertain',
      terminalReason: 'attempt_state_lost',
      writeSettlement: 'unsafe',
    });
    const leasedInvalid = await attemptRow(leasedLaunch.sessionId, leasedLaunch.turnAttemptId);
    assert.ok(leasedInvalid);
    await assert.rejects(
      () => abandonAgentSessionUncertainAttempt({
        sessionId: leasedLaunch.sessionId,
        turnAttemptId: leasedLaunch.turnAttemptId,
        now: () => NOW + 6,
      }),
      AgentAttemptCorruptionError,
    );
    assert.deepEqual(
      await attemptRow(leasedLaunch.sessionId, leasedLaunch.turnAttemptId),
      leasedInvalid,
    );

    await db.agentAttempts.delete(leased.id);
    const receiptedLaunch = attemptLaunch(created.session.id, 'attempt-uncertain-receipted');
    const receiptedDigest = await admit(receiptedLaunch, 'worker-uncertain-receipted');
    await markAgentSessionAttemptStateUncertain({
      sessionId: receiptedLaunch.sessionId,
      turnAttemptId: receiptedLaunch.turnAttemptId,
      executionEpochId: 'worker-uncertain-receipted',
      now: () => NOW + 7,
    });
    const receipted = await attemptRow(receiptedLaunch.sessionId, receiptedLaunch.turnAttemptId);
    assert.ok(receipted);
    await db.agentAttempts.update(receipted.id, {
      receipt: {
        turnAttemptId: receiptedLaunch.turnAttemptId,
        digest: `asd:v1:${'a'.repeat(43)}`,
        launchDigest: receiptedDigest,
        appliedRevision: 1,
        outcome: terminalOutcome('provider_error'),
      },
    });
    const receiptedInvalid = await attemptRow(
      receiptedLaunch.sessionId,
      receiptedLaunch.turnAttemptId,
    );
    assert.ok(receiptedInvalid);
    await assert.rejects(
      () => abandonAgentSessionUncertainAttempt({
        sessionId: receiptedLaunch.sessionId,
        turnAttemptId: receiptedLaunch.turnAttemptId,
        now: () => NOW + 8,
      }),
      AgentAttemptCorruptionError,
    );
    assert.deepEqual(
      await attemptRow(receiptedLaunch.sessionId, receiptedLaunch.turnAttemptId),
      receiptedInvalid,
    );
  });

  it('rolls back only the exact replacement recovery lease as state uncertain', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-recovery-rollback' });
    const launch = attemptLaunch(created.session.id, 'attempt-recovery-rollback');
    const launchDigest = await digestAgentSessionLaunch(launch);
    await admitAgentSessionTurn({
      sessionId: launch.sessionId,
      baseRevision: launch.baseRevision,
      turnAttemptId: launch.turnAttemptId,
      executionEpochId: 'worker-recovery-original',
      launchDigest,
      launch,
      recoveryClass: 'statically_read_only',
      now: () => NOW,
    });

    const replacement = createAgentAttemptCoordinator('worker-recovery-replacement');
    const inspected = await replacement.inspectActive(launch.sessionId);
    assert.deepEqual(inspected?.launch, launch);
    assert.equal(await createAgentAttemptCoordinator('worker-recovery-stale')
      .rollbackRecoveryClaim(launch), false);
    assert.equal(await replacement.rollbackRecoveryClaim({
      ...launch,
      prompt: 'A different immutable launch must not clear the claimed lease.',
    }), false);
    assert.equal((await attemptRow(launch.sessionId, launch.turnAttemptId))?.state, 'running');

    assert.equal(await replacement.rollbackRecoveryClaim(launch), true);
    const rolledBack = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.ok(rolledBack);
    assert.equal(rolledBack.state, 'state_uncertain');
    assert.equal(rolledBack.terminalReason, 'attempt_state_lost');
    assert.equal(rolledBack.writeSettlement, 'unsafe');
    assert.equal(rolledBack.lease, null);
    assert.equal(rolledBack.artifactContinuationControl, null);
    assert.deepEqual(rolledBack.admittedLaunch, launch);
    assert.equal(rolledBack.admittedLaunchDigest, launchDigest);
    assert.equal(await db.agentAttemptRecoveries.count(), 0);
    assert.equal((await loadAgentSession(launch.sessionId)).session.id, launch.sessionId);
  });

  it('rejects malformed uncertain and abandoned evidence instead of normalizing it', async () => {
    const uncertainCases: ReadonlyArray<Readonly<{
      suffix: string;
      mutate: (
        row: AgentAttemptRecord,
        lease: NonNullable<AgentAttemptRecord['lease']>,
      ) => Partial<AgentAttemptRecord>;
    }>> = [
      {
        suffix: 'receipt',
        mutate: (row) => ({ receipt: attemptReceipt(row) }),
      },
      { suffix: 'retry', mutate: () => ({ retryKind: 'failed' }) },
      { suffix: 'settlement', mutate: () => ({ writeSettlement: 'none' }) },
      { suffix: 'reason', mutate: () => ({ terminalReason: 'provider_error' }) },
      { suffix: 'lease', mutate: (_row, lease) => ({ lease }) },
    ];
    for (const candidate of uncertainCases) {
      const seeded = await seedUncertainAttempt(`uncertain-${candidate.suffix}`);
      await db.agentAttempts.update(
        seeded.attempt.id,
        candidate.mutate(seeded.attempt, seeded.lease),
      );
      await assert.rejects(
        () => readAgentSessionRetryDraftCandidate(seeded.launch.sessionId),
        AgentAttemptCorruptionError,
      );
    }

    const recoverySeed = await seedUncertainAttempt('uncertain-recovery');
    await db.agentAttemptRecoveries.put({
      id: recoverySeed.attempt.id,
      schemaVersion: 1,
      sessionId: recoverySeed.launch.sessionId,
      turnAttemptId: recoverySeed.launch.turnAttemptId,
      projectedMessages: [],
      canonicalRawMessages: [],
      updatedAt: NOW + 2,
    });
    await assert.rejects(
      () => abandonAgentSessionUncertainAttempt({
        sessionId: recoverySeed.launch.sessionId,
        turnAttemptId: recoverySeed.launch.turnAttemptId,
      }),
      AgentAttemptCorruptionError,
    );

    const abandonedCases = uncertainCases.filter((candidate) => (
      candidate.suffix === 'receipt'
      || candidate.suffix === 'retry'
      || candidate.suffix === 'settlement'
      || candidate.suffix === 'lease'
    ));
    for (const candidate of abandonedCases) {
      const seeded = await seedUncertainAttempt(`abandoned-${candidate.suffix}`);
      assert.equal(await abandonAgentSessionUncertainAttempt({
        sessionId: seeded.launch.sessionId,
        turnAttemptId: seeded.launch.turnAttemptId,
      }), true);
      const abandoned = await attemptRow(seeded.launch.sessionId, seeded.launch.turnAttemptId);
      assert.ok(abandoned);
      await db.agentAttempts.update(
        abandoned.id,
        candidate.mutate(abandoned, seeded.lease),
      );
      await assert.rejects(
        () => readAgentSessionRetryDraftCandidate(seeded.launch.sessionId),
        AgentAttemptCorruptionError,
      );
    }
  });

  it('discards only exact unbound cache artifacts on abandonment and rolls failure back', async () => {
    const seeded = await seedUncertainAttemptWithArtifacts('abandon-cleanup');
    const usageBefore = await getAgentStorageUsage();

    assert.equal(await abandonAgentSessionUncertainAttempt({
      sessionId: seeded.launch.sessionId,
      turnAttemptId: seeded.launch.turnAttemptId,
      now: () => NOW + 10,
    }), true);
    assert.equal(await db.agentArtifacts.get(seeded.exact.id), undefined);
    assert.equal(await artifactChunkCount(seeded.exact.id), 0);
    assert.ok(await db.agentArtifacts.get(seeded.crossAttempt.id));
    assert.ok(await db.agentArtifacts.get(seeded.canonical.id));
    assert.equal(await artifactChunkCount(seeded.crossAttempt.id), 1);
    assert.equal(await artifactChunkCount(seeded.canonical.id), 1);
    assert.ok(await db.agentMessages.get(seeded.canonical.ownerMessageId!));
    const usageAfter = await getAgentStorageUsage();
    assert.equal(usageAfter.cacheBytes, usageBefore.cacheBytes - seeded.exact.byteLength);
    assert.equal(usageAfter.cacheArtifactCount, usageBefore.cacheArtifactCount - 1);
    assert.equal(usageAfter.canonicalArtifactCount, usageBefore.canonicalArtifactCount);

    const rollback = await seedUncertainAttemptWithArtifacts('abandon-rollback');
    const rollbackUsage = await getAgentStorageUsage();
    const attemptPut = vi.spyOn(db.agentAttempts, 'put')
      .mockRejectedValueOnce(new Error('attempt terminalization failed'));
    try {
      await assert.rejects(
        () => abandonAgentSessionUncertainAttempt({
          sessionId: rollback.launch.sessionId,
          turnAttemptId: rollback.launch.turnAttemptId,
          now: () => NOW + 11,
        }),
        /attempt terminalization failed/u,
      );
    } finally {
      attemptPut.mockRestore();
    }
    assert.ok(await db.agentArtifacts.get(rollback.exact.id));
    assert.equal(await artifactChunkCount(rollback.exact.id), 1);
    assert.equal(
      (await attemptRow(rollback.launch.sessionId, rollback.launch.turnAttemptId))?.state,
      'state_uncertain',
    );
    assert.deepEqual(await getAgentStorageUsage(), rollbackUsage);
  });

  it('quarantines damaged recovery while preserving canonical and cross-attempt artifacts', async () => {
    const sessionId = 'session-quarantine-artifacts';
    const launch = attemptLaunch(sessionId, 'attempt-quarantine-artifacts');
    await createAgentSession({ idFactory: () => sessionId, now: () => NOW });
    const launchDigest = await digestAgentSessionLaunch(launch);
    await admitAgentSessionTurn({
      ...launch,
      launch,
      launchDigest,
      executionEpochId: 'worker-quarantine-original',
      recoveryClass: 'statically_read_only',
      now: () => NOW,
    });
    const artifacts = await storeAttemptArtifacts(launch, 'quarantine');
    const pending = await coverageForArtifact(artifacts.exact);
    const recoveryMessage = {
      id: 'recovery-message-quarantine',
      role: 'user' as const,
      content: 'Continue exact artifact coverage.',
      createdAt: NOW + 1,
    };
    await checkpointAgentSessionArtifactEnvelope({
      sessionId,
      turnAttemptId: launch.turnAttemptId,
      executionEpochId: 'worker-quarantine-original',
      launchDigest,
      proposals: [{ kind: 'start', record: pending }],
      continuation: {
        schemaVersion: 1,
        projectedMessages: [recoveryMessage],
        canonicalRawMessages: [recoveryMessage],
        directives: agentArtifactCoverageDirectives([pending]),
        nonProgressRepromptUsed: false,
        updatedAt: NOW + 1,
      },
      now: () => NOW + 1,
    });
    const attempt = await attemptRow(sessionId, launch.turnAttemptId);
    assert.ok(attempt);
    await db.agentAttemptRecoveries.update(attempt.id, { updatedAt: NOW + 2 });
    await reconcileAgentStorageUsage(() => NOW + 3);
    const usageBefore = await getAgentStorageUsage();

    await assert.rejects(
      () => inspectDurableAgentSessionTurn(sessionId, 'worker-quarantine-replacement'),
      AgentAttemptCorruptionError,
    );
    assert.equal((await attemptRow(sessionId, launch.turnAttemptId))?.state, 'state_uncertain');
    assert.equal(await db.agentAttemptRecoveries.get(attempt.id), undefined);
    assert.equal(await db.agentArtifacts.get(artifacts.exact.id), undefined);
    assert.equal(await artifactChunkCount(artifacts.exact.id), 0);
    assert.ok(await db.agentArtifacts.get(artifacts.crossAttempt.id));
    assert.ok(await db.agentArtifacts.get(artifacts.canonical.id));
    assert.equal(await artifactChunkCount(artifacts.crossAttempt.id), 1);
    assert.equal(await artifactChunkCount(artifacts.canonical.id), 1);
    const usageAfter = await getAgentStorageUsage();
    assert.equal(usageAfter.cacheBytes, usageBefore.cacheBytes - artifacts.exact.byteLength);
    assert.equal(usageAfter.cacheArtifactCount, usageBefore.cacheArtifactCount - 1);
    assert.equal(usageAfter.canonicalArtifactCount, usageBefore.canonicalArtifactCount);
  });
  it('fails admission on a corrupt attempt while preserving the transcript until explicit discard', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-attempt-corrupt' });
    const launch = attemptLaunch(created.session.id, 'attempt-corrupt');
    await admit(launch, 'worker-corrupt');
    const stored = await attemptRow(launch.sessionId, launch.turnAttemptId);
    assert.ok(stored);
    await db.agentAttempts.update(stored.id, {
      admittedLaunchDigest: 'invalid-launch-digest' as never,
    });

    const replacement = attemptLaunch(created.session.id, 'attempt-replacement');
    await assert.rejects(
      () => admit(replacement, 'worker-replacement'),
      AgentAttemptCorruptionError,
    );
    assert.equal((await loadAgentSession(created.session.id)).session.id, created.session.id);
    assert.equal(await discardDamagedAgentSessionRecovery(created.session.id, NOW + 1), 1);
    await assert.doesNotReject(() => admit(replacement, 'worker-replacement'));
  });
});

function attemptLaunch(sessionId: string, turnAttemptId: string): AgentSessionLaunchIdentity {
  return {
    sessionId,
    turnAttemptId,
    baseRevision: 0,
    prompt: 'Recover this durable attempt.',
  };
}

async function admit(
  launch: AgentSessionLaunchIdentity,
  executionEpochId: string,
): Promise<Awaited<ReturnType<typeof digestAgentSessionLaunch>>> {
  const launchDigest = await digestAgentSessionLaunch(launch);
  await admitAgentSessionTurn({
    sessionId: launch.sessionId,
    baseRevision: launch.baseRevision,
    turnAttemptId: launch.turnAttemptId,
    executionEpochId,
    launchDigest,
    launch,
    now: () => NOW,
  });
  return launchDigest;
}

function terminalOutcome(reason: 'aborted' | 'provider_error') {
  return {
    reason,
    changed: false,
    changedCount: 0,
    writeSettlement: 'none' as const,
  };
}

function attemptRow(sessionId: string, turnAttemptId: string) {
  return db.agentAttempts
    .where('[sessionId+turnAttemptId]')
    .equals([sessionId, turnAttemptId])
    .first();
}

function attemptReceipt(row: AgentAttemptRecord): NonNullable<AgentAttemptRecord['receipt']> {
  return {
    turnAttemptId: row.turnAttemptId,
    digest: `asd:v1:${'a'.repeat(43)}`,
    launchDigest: row.admittedLaunchDigest,
    appliedRevision: row.admittedLaunch.baseRevision,
    outcome: {
      reason: 'provider_error',
      changed: false,
      changedCount: 0,
      writeSettlement: 'unsafe',
    },
  };
}

async function seedUncertainAttempt(suffix: string): Promise<Readonly<{
  launch: AgentSessionLaunchIdentity;
  attempt: AgentAttemptRecord;
  lease: NonNullable<AgentAttemptRecord['lease']>;
}>> {
  const sessionId = `session-${suffix}`;
  const launch = attemptLaunch(sessionId, `attempt-${suffix}`);
  await createAgentSession({ idFactory: () => sessionId, now: () => NOW });
  await admit(launch, `worker-${suffix}`);
  const running = await attemptRow(sessionId, launch.turnAttemptId);
  assert.ok(running?.lease);
  const lease = structuredClone(running.lease);
  assert.equal(await markAgentSessionAttemptStateUncertain({
    sessionId,
    turnAttemptId: launch.turnAttemptId,
    executionEpochId: `worker-${suffix}`,
    now: () => NOW + 1,
  }), true);
  const attempt = await attemptRow(sessionId, launch.turnAttemptId);
  assert.ok(attempt);
  return { launch, attempt, lease };
}

async function seedUncertainAttemptWithArtifacts(suffix: string): Promise<Readonly<{
  launch: AgentSessionLaunchIdentity;
  attempt: AgentAttemptRecord;
  exact: AgentArtifactRecord;
  crossAttempt: AgentArtifactRecord;
  canonical: AgentArtifactRecord;
}>> {
  const seeded = await seedUncertainAttempt(suffix);
  const artifacts = await storeAttemptArtifacts(seeded.launch, suffix);
  const coverage = await Promise.all([
    coverageForArtifact(artifacts.exact),
    coverageForArtifact(artifacts.canonical),
  ]);
  const incompleteCoverage = await Promise.all(coverage.map((record) => (
    settleAgentArtifactCoverageIncomplete(record, 'attempt_state_lost')
  )));
  await db.agentAttempts.update(seeded.attempt.id, { artifactCoverage: incompleteCoverage });
  await reconcileAgentStorageUsage(() => NOW + 5);
  const attempt = await attemptRow(seeded.launch.sessionId, seeded.launch.turnAttemptId);
  assert.ok(attempt);
  return { ...seeded, ...artifacts, attempt };
}

async function storeAttemptArtifacts(
  launch: AgentSessionLaunchIdentity,
  suffix: string,
): Promise<Readonly<{
  exact: AgentArtifactRecord;
  crossAttempt: AgentArtifactRecord;
  canonical: AgentArtifactRecord;
}>> {
  const canonicalId = `artifact-canonical-${suffix}`;
  const ownerMessageId = `message-canonical-${suffix}`;
  const ownerToolCallId = `call-canonical-${suffix}`;
  const ownerWithoutBytes = {
    id: ownerMessageId,
    schemaVersion: 1 as const,
    sessionId: launch.sessionId,
    sequence: 1,
    turnAttemptId: launch.turnAttemptId,
    role: 'tool' as const,
    content: '{"ok":true}',
    storageClass: 'canonical' as const,
    createdAt: NOW,
    lastAccessedAt: NOW,
    expiresAt: null,
    toolCallId: ownerToolCallId,
    toolName: 'canonical_fixture',
    artifactIds: [canonicalId],
  };
  await db.agentMessages.put({
    ...ownerWithoutBytes,
    byteLength: agentMessageLogicalByteLength(ownerWithoutBytes),
  });
  const exact = await storeAgentArtifact({
    artifactId: `artifact-exact-${suffix}`,
    sessionId: launch.sessionId,
    turnAttemptId: launch.turnAttemptId,
    toolCallId: `call-exact-${suffix}`,
    toolName: 'exact_fixture',
    storageClass: 'cache',
    content: `exact-${suffix}`,
    now: () => NOW + 2,
  });
  const crossAttempt = await storeAgentArtifact({
    artifactId: `artifact-cross-${suffix}`,
    sessionId: launch.sessionId,
    turnAttemptId: `attempt-cross-${suffix}`,
    toolCallId: `call-cross-${suffix}`,
    toolName: 'cross_fixture',
    storageClass: 'cache',
    content: `cross-${suffix}`,
    now: () => NOW + 3,
  });
  const canonical = await storeAgentArtifact({
    artifactId: canonicalId,
    sessionId: launch.sessionId,
    turnAttemptId: launch.turnAttemptId,
    ownerMessageId,
    toolCallId: ownerToolCallId,
    toolName: 'canonical_fixture',
    storageClass: 'canonical',
    content: `canonical-${suffix}`,
    now: () => NOW + 4,
  });
  return { exact, crossAttempt, canonical };
}

async function coverageForArtifact(
  artifact: AgentArtifactRecord,
): Promise<AgentArtifactCoverageRecord> {
  assert.ok(artifact.toolCallId);
  assert.ok(artifact.integrity);
  return createAgentArtifactCoverage({
    artifactId: artifact.id,
    sourceToolCallId: artifact.toolCallId,
    expectedBytes: artifact.byteLength,
    artifactSha256: artifact.sha256,
    integrityManifestSha256: artifact.integrity.manifestSha256,
  });
}

function artifactChunkCount(artifactId: string): Promise<number> {
  return db.agentArtifactChunks.where('artifactId').equals(artifactId).count();
}
