import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import {
  agentArtifactCoverageDirectives,
  createAgentArtifactCoverage,
  applyAgentArtifactCoverageEvidence,
  type AgentArtifactContinuationCheckpoint,
  type AgentArtifactCoverageRecord,
} from '@/bgsm-agent/artifact-coverage';
import { createAgentAttemptCoordinator } from '@/background/agent-attempt-coordinator';
import { parseScopeFingerprintV1 } from '@/bgsm-agent/scope';
import type {
  BgsmAgentSessionMessage,
  BgsmAgentSessionTransition,
} from '@/bgsm-agent/session';
import { loadAgentSession } from '@/storage/agent-session-store';
import {
  findAgentArtifactTextForSession,
  loadAgentArtifactSliceForSession,
  storeAgentArtifact,
} from '@/storage/agent-storage-store';
import { createAgentSession } from '@/storage/agent-session-store';
import { db } from '@/storage/db';

const MAX_TEST_ARTIFACT_PAGES = 16;

const OUTCOME = {
  reason: 'final_answer' as const,
  changed: false,
  changedCount: 0,
  writeSettlement: 'none' as const,
};

function sourceMessages(
  suffix: string,
  toolCallId: string,
  artifactId: string,
): BgsmAgentSessionMessage[] {
  return [
    {
      id: `user-${suffix}`,
      role: 'user',
      content: suffix === 'one' ? 'Inspect the complete result' : 'Inspect it again',
      createdAt: 1,
    },
    {
      id: `agent-call-${suffix}`,
      role: 'agent',
      content: '',
      createdAt: 2,
      toolCalls: [{ id: toolCallId, name: 'read_agent_artifact', arguments: {} }],
    },
    {
      id: `tool-${suffix}`,
      role: 'tool',
      content: '{"ok":true,"data":{"status":"artifact_available"}}',
      createdAt: 3,
      toolCallId,
      toolName: 'read_agent_artifact',
      opaqueReferences: [artifactId],
    },
    {
      id: `agent-${suffix}`,
      role: 'agent',
      content: 'The complete artifact was inspected.',
      createdAt: 4,
    },
  ];
}

function transition(
  sessionId: string,
  baseRevision: number,
  messages: BgsmAgentSessionMessage[],
): BgsmAgentSessionTransition {
  return {
    sessionId,
    baseRevision,
    messageDelta: messages,
    ...(baseRevision === 0
      ? {
          binding: {
            version: 1 as const,
            candidateContract: {
              kind: 'selected_repository' as const,
              selectedRepositoryIdHint: 'owner/repo',
            },
            scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${'s'.repeat(43)}`),
            label: 'owner/repo',
            count: 1,
            providerFingerprint: `pcf:v1:${'p'.repeat(43)}`,
          },
        }
      : {}),
  };
}

function continuation(
  records: readonly AgentArtifactCoverageRecord[],
  canonicalRawMessages: readonly BgsmAgentSessionMessage[],
  updatedAt: number,
): AgentArtifactContinuationCheckpoint | null {
  const directives = agentArtifactCoverageDirectives(records);
  return directives.length === 0
    ? null
    : {
        schemaVersion: 1,
        projectedMessages: canonicalRawMessages.map((message) => ({ ...message })),
        canonicalRawMessages: canonicalRawMessages.map((message) => ({ ...message })),
        directives,
        nonProgressRepromptUsed: false,
        updatedAt,
      };
}

describe('background Agent artifact coverage coordinator', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(() => db.close());

  it('fences commit, attaches an exact receipt, reloads it, and preserves canonical ownership', async () => {
    const sessionId = 'session-coverage-commit';
    const artifactId = 'artifact-coverage-commit';
    const created = await createAgentSession({ idFactory: () => sessionId });
    const coordinator = createAgentAttemptCoordinator('worker-coverage');
    const firstMessages = sourceMessages('one', 'call-one', artifactId);
    const firstTransition = transition(sessionId, 0, firstMessages);
    const firstLaunch = {
      sessionId,
      baseRevision: 0,
      turnAttemptId: 'attempt-one',
      prompt: firstMessages[0]!.content,
      candidateContract: firstTransition.binding!.candidateContract,
    };
    const firstAdmission = await coordinator.admit(firstLaunch, 'statically_read_only');
    assert.equal(firstAdmission.admission.kind, 'acquired');
    const artifact = await storeAgentArtifact({
      artifactId,
      sessionId,
      turnAttemptId: firstLaunch.turnAttemptId,
      toolCallId: 'call-one',
      toolName: 'read_repository',
      storageClass: 'cache',
      content: 'abcdefghij',
      now: () => 10,
    });
    const coverage = await createAgentArtifactCoverage({
      artifactId,
      sourceToolCallId: 'call-one',
      expectedBytes: artifact.byteLength,
      artifactSha256: artifact.sha256,
      integrityManifestSha256: artifact.integrity!.manifestSha256,
    });
    let checkpoint = await coordinator.checkpointArtifactEnvelope({
      sessionId,
      turnAttemptId: firstLaunch.turnAttemptId,
      launchDigest: firstAdmission.launchDigest,
      proposals: [{ kind: 'start', record: coverage }],
      continuation: continuation([coverage], firstMessages.slice(0, 3), 11),
    });
    const preFirstOffset = await loadAgentArtifactSliceForSession({
      sessionId,
      artifactId,
      byteOffset: 2,
      maxContentBytes: 2,
      now: () => 12,
    });
    await assert.rejects(
      () => applyAgentArtifactCoverageEvidence(coverage, preFirstOffset.evidence),
      /issued pending artifact cursor/u,
    );

    const coverageSnapshot = (record: AgentArtifactCoverageRecord) => ({
      state: record.state,
      bytesDelivered: record.bytesDelivered,
      expectedCursor: record.expectedCursor,
      progressToken: record.progressToken,
      cursorChainDigest: record.cursorChainDigest,
    });
    let targetedEvidence = preFirstOffset.evidence;

    await assert.rejects(() => coordinator.commit({
      turnAttemptId: firstLaunch.turnAttemptId,
      transition: firstTransition,
      launchDigest: firstAdmission.launchDigest,
      outcome: OUTCOME,
    }), /complete artifact coverage/u);
    assert.equal(await db.agentMessages.count(), 0);

    let cursor: string | null = null;
    let pagesRead = 0;
    do {
      pagesRead += 1;
      assert.ok(pagesRead <= MAX_TEST_ARTIFACT_PAGES, 'artifact pagination did not terminate');
      const page = await loadAgentArtifactSliceForSession({
        sessionId,
        artifactId,
        ...(cursor === null ? {} : { cursor }),
        maxContentBytes: 4,
        now: () => 12,
      });
      const currentCoverage = checkpoint.artifactCoverage.find((record) => (
        record.coverageId === coverage.coverageId
      ));
      if (!currentCoverage) throw new Error('coverage record missing');
      const predictedCoverage = await applyAgentArtifactCoverageEvidence(
        currentCoverage,
        page.evidence,
      );
      const predictedRecords = checkpoint.artifactCoverage.map((record) => (
        record.coverageId === coverage.coverageId ? predictedCoverage.record : record
      ));
      checkpoint = await coordinator.checkpointArtifactEnvelope({
        sessionId,
        turnAttemptId: firstLaunch.turnAttemptId,
        launchDigest: firstAdmission.launchDigest,
        proposals: [{
          kind: 'evidence',
          coverageId: coverage.coverageId,
          evidence: page.evidence,
        }],
        continuation: continuation(predictedRecords, firstMessages.slice(0, 3), 13),
      });
      if (currentCoverage.bytesDelivered === 0) {
        const pendingCoverage = checkpoint.artifactCoverage.find((record) => (
          record.coverageId === coverage.coverageId
        ));
        if (!pendingCoverage || page.nextCursor === null) {
          throw new Error('first page did not create pending coverage');
        }
        const pendingSnapshot = coverageSnapshot(pendingCoverage);
        const searched = await findAgentArtifactTextForSession({
          sessionId,
          artifactId,
          query: 'cde',
          now: () => 13,
        });
        const searchedTransition = await applyAgentArtifactCoverageEvidence(
          pendingCoverage,
          searched.evidence,
        );
        assert.equal(searchedTransition.advanced, false);
        const searchedRecords = checkpoint.artifactCoverage.map((record) => (
          record.coverageId === coverage.coverageId ? searchedTransition.record : record
        ));
        checkpoint = await coordinator.checkpointArtifactEnvelope({
          sessionId,
          turnAttemptId: firstLaunch.turnAttemptId,
          launchDigest: firstAdmission.launchDigest,
          proposals: [{
            kind: 'evidence',
            coverageId: coverage.coverageId,
            evidence: searched.evidence,
          }],
          continuation: continuation(searchedRecords, firstMessages.slice(0, 3), 13),
        });
        assert.deepEqual(coverageSnapshot(checkpoint.artifactCoverage[0]!), pendingSnapshot);

        const offset = await loadAgentArtifactSliceForSession({
          sessionId,
          artifactId,
          byteOffset: 2,
          maxContentBytes: 2,
          now: () => 14,
        });
        const offsetTransition = await applyAgentArtifactCoverageEvidence(
          checkpoint.artifactCoverage[0]!,
          offset.evidence,
        );
        assert.equal(offsetTransition.advanced, false);
        const offsetRecords = checkpoint.artifactCoverage.map((record) => (
          record.coverageId === coverage.coverageId ? offsetTransition.record : record
        ));
        checkpoint = await coordinator.checkpointArtifactEnvelope({
          sessionId,
          turnAttemptId: firstLaunch.turnAttemptId,
          launchDigest: firstAdmission.launchDigest,
          proposals: [{
            kind: 'evidence',
            coverageId: coverage.coverageId,
            evidence: offset.evidence,
          }],
          continuation: continuation(offsetRecords, firstMessages.slice(0, 3), 14),
        });
        assert.deepEqual(coverageSnapshot(checkpoint.artifactCoverage[0]!), pendingSnapshot);
        targetedEvidence = offset.evidence;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    const completedCoverage = checkpoint.artifactCoverage.find((record) => (
      record.coverageId === coverage.coverageId
    ));
    if (!completedCoverage) throw new Error('completed coverage record missing');
    await assert.rejects(
      () => applyAgentArtifactCoverageEvidence(completedCoverage, targetedEvidence),
      /Only pending artifact coverage/u,
    );
    await assert.rejects(
      () => coordinator.checkpointArtifactEnvelope({
        sessionId,
        turnAttemptId: firstLaunch.turnAttemptId,
        launchDigest: firstAdmission.launchDigest,
        proposals: [{
          kind: 'evidence',
          coverageId: completedCoverage.coverageId,
          evidence: targetedEvidence,
        }],
        continuation: null,
      }),
      /evidence must follow source-admission order/u,
    );

    const committed = await coordinator.commit({
      turnAttemptId: firstLaunch.turnAttemptId,
      transition: firstTransition,
      launchDigest: firstAdmission.launchDigest,
      outcome: OUTCOME,
    });
    assert.equal(committed.appliedRevision, 1);
    const firstSource = await db.agentMessages.get('tool-one');
    assert.equal(firstSource?.artifactCoverageReceipts?.length, 1);
    assert.equal(firstSource?.artifactCoverageReceipts?.[0]?.artifactId, artifactId);
    assert.equal((await db.agentArtifacts.get(artifactId))?.ownerMessageId, 'tool-one');

    db.close();
    await db.open();
    assert.equal((await db.agentMessages.get('tool-one'))?.artifactCoverageReceipts?.length, 1);
    assert.equal((await loadAgentSession(created.session.id)).session.revision, 1);

    const secondMessages = sourceMessages('two', 'call-two', artifactId);
    const secondTransition = transition(sessionId, 1, secondMessages);
    const secondLaunch = {
      sessionId,
      baseRevision: 1,
      turnAttemptId: 'attempt-two',
      prompt: secondMessages[0]!.content,
    };
    const secondAdmission = await coordinator.admit(secondLaunch, 'statically_read_only');
    const canonicalArtifact = (await db.agentArtifacts.get(artifactId))!;
    const secondCoverage = await createAgentArtifactCoverage({
      artifactId,
      sourceToolCallId: 'call-two',
      expectedBytes: canonicalArtifact.byteLength,
      artifactSha256: canonicalArtifact.sha256,
      integrityManifestSha256: canonicalArtifact.integrity!.manifestSha256,
    });
    let secondCheckpoint = await coordinator.checkpointArtifactEnvelope({
      sessionId,
      turnAttemptId: secondLaunch.turnAttemptId,
      launchDigest: secondAdmission.launchDigest,
      proposals: [{ kind: 'start', record: secondCoverage }],
      continuation: continuation([secondCoverage], secondMessages.slice(0, 3), 20),
    });
    cursor = null;
    pagesRead = 0;
    do {
      pagesRead += 1;
      assert.ok(pagesRead <= MAX_TEST_ARTIFACT_PAGES, 'artifact pagination did not terminate');
      const page = await loadAgentArtifactSliceForSession({
        sessionId,
        artifactId,
        ...(cursor === null ? {} : { cursor }),
        maxContentBytes: 10,
      });
      const currentCoverage = secondCheckpoint.artifactCoverage.find((record) => (
        record.coverageId === secondCoverage.coverageId
      ));
      if (!currentCoverage) throw new Error('coverage record missing');
      const predictedCoverage = await applyAgentArtifactCoverageEvidence(
        currentCoverage,
        page.evidence,
      );
      const predicted = secondCheckpoint.artifactCoverage.map((record) => (
        record.coverageId === secondCoverage.coverageId ? predictedCoverage.record : record
      ));
      secondCheckpoint = await coordinator.checkpointArtifactEnvelope({
        sessionId,
        turnAttemptId: secondLaunch.turnAttemptId,
        launchDigest: secondAdmission.launchDigest,
        proposals: [{
          kind: 'evidence',
          coverageId: secondCoverage.coverageId,
          evidence: page.evidence,
        }],
        continuation: continuation(predicted, secondMessages.slice(0, 3), 21),
      });
      cursor = page.nextCursor;
    } while (cursor !== null);
    await coordinator.commit({
      turnAttemptId: secondLaunch.turnAttemptId,
      transition: secondTransition,
      launchDigest: secondAdmission.launchDigest,
      outcome: OUTCOME,
    });
    assert.equal((await db.agentArtifacts.get(artifactId))?.ownerMessageId, 'tool-one');
    assert.equal((await db.agentMessages.get('tool-two'))?.artifactCoverageReceipts?.length, 1);
  });

  it('persists the exact re-prompt projection once and rejects a reset or replay', async () => {
    const sessionId = 'session-coverage-reprompt';
    const artifactId = 'artifact-coverage-reprompt';
    await createAgentSession({ idFactory: () => sessionId });
    const coordinator = createAgentAttemptCoordinator('worker-coverage-reprompt');
    const messages = sourceMessages('one', 'call-reprompt', artifactId);
    const candidateTransition = transition(sessionId, 0, messages);
    const launch = {
      sessionId,
      baseRevision: 0,
      turnAttemptId: 'attempt-reprompt',
      prompt: messages[0]!.content,
      candidateContract: candidateTransition.binding!.candidateContract,
    };
    const admission = await coordinator.admit(launch, 'statically_read_only');
    const artifact = await storeAgentArtifact({
      artifactId,
      sessionId,
      turnAttemptId: launch.turnAttemptId,
      toolCallId: 'call-reprompt',
      toolName: 'read_repository',
      storageClass: 'cache',
      content: 'reprompt evidence',
      now: () => 10,
    });
    const coverage = await createAgentArtifactCoverage({
      artifactId,
      sourceToolCallId: 'call-reprompt',
      expectedBytes: artifact.byteLength,
      artifactSha256: artifact.sha256,
      integrityManifestSha256: artifact.integrity!.manifestSha256,
    });
    const checkpoint = await coordinator.checkpointArtifactEnvelope({
      sessionId,
      turnAttemptId: launch.turnAttemptId,
      launchDigest: admission.launchDigest,
      proposals: [{ kind: 'start', record: coverage }],
      continuation: continuation([coverage], messages.slice(0, 3), 11),
    });
    assert.ok(checkpoint.artifactContinuation);
    const reprompt = {
      ...checkpoint.artifactContinuation,
      nonProgressRepromptUsed: true,
      updatedAt: 12,
    };
    const persisted = await coordinator.markArtifactRepromptUsed({
      sessionId,
      turnAttemptId: launch.turnAttemptId,
      launchDigest: admission.launchDigest,
      continuation: reprompt,
    });
    assert.equal(persisted.nonProgressRepromptUsed, true);
    await assert.rejects(() => coordinator.markArtifactRepromptUsed({
      sessionId,
      turnAttemptId: launch.turnAttemptId,
      launchDigest: admission.launchDigest,
      continuation: { ...reprompt, updatedAt: 13 },
    }), /re-prompt state changed/u);
    const attempt = (await db.agentAttempts.toArray()).find((row) => (
      row.turnAttemptId === launch.turnAttemptId
    ));
    assert.ok(attempt);
    assert.deepEqual(Object.keys(attempt).sort(), [
      'admittedLaunch',
      'admittedLaunchDigest',
      'artifactContinuationControl',
      'artifactCoverage',
      'id',
      'lease',
      'receipt',
      'recoveryClass',
      'retryKind',
      'sessionId',
      'state',
      'terminalReason',
      'turnAttemptId',
      'updatedAt',
      'writeSettlement',
    ].sort());
    assert.equal(attempt.artifactContinuationControl?.nonProgressRepromptUsed, true);
    const recovery = await db.agentAttemptRecoveries.get(attempt.id);
    assert.ok(recovery);
    assert.deepEqual(Object.keys(recovery).sort(), [
      'canonicalRawMessages',
      'id',
      'projectedMessages',
      'schemaVersion',
      'sessionId',
      'turnAttemptId',
      'updatedAt',
    ].sort());
    assert.equal(recovery.updatedAt, 12);
    assert.deepEqual(recovery.projectedMessages, messages.slice(0, 3));
    assert.deepEqual(recovery.canonicalRawMessages, messages.slice(0, 3));
  });
});
