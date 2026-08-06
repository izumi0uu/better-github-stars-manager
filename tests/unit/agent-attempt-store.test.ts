import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import {
  digestAgentSessionLaunch,
  type AgentSessionLaunchIdentity,
} from '@/bgsm-agent/session-transport';
import {
  AgentAttemptCorruptionError,
  admitAgentSessionTurn,
  createAgentSession,
  discardDamagedAgentSessionRecovery,
  dismissAgentSessionAttemptRetry,
  loadAgentSession,
  readAgentSessionRetryDraftCandidate,
  settleAgentSessionAttemptWithoutTransition,
} from '@/storage/agent-session-store';
import { db } from '@/storage/db';

const NOW = 1_800_000_000_000;

describe('durable Agent attempt authority', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(() => {
    db.close();
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
