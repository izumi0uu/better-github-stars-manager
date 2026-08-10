import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import {
  agentArtifactCoverageDirectives,
  createAgentArtifactCoverage,
} from '@/bgsm-agent/artifact-coverage';
import { parseScopeFingerprintV1 } from '@/bgsm-agent/scope';
import { BGSM_AGENT_SUMMARY_MAX_BYTES } from '@/bgsm-agent/session';
import type {
  BgsmAgentActiveProjection,
  BgsmAgentCompactionCheckpoint,
  BgsmAgentSessionMessage,
  BgsmAgentSessionTransition,
} from '@/bgsm-agent/session';
import {
  digestAgentSessionLaunch,
  digestAgentSessionTransition,
  type AgentSessionLaunchDigest,
} from '@/bgsm-agent/session-transport';
import {
  AgentSessionAttemptConflictError,
  AgentAttemptCorruptionError,
  AgentSessionCorruptionError,
  AgentSessionDeletionBlockedError,
  AgentSessionTurnActiveError,
  AgentSessionTurnLeaseMismatchError,
  AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  admitAgentSessionTurn,
  commitAgentSessionTransition as commitAgentSessionTransitionDurable,
  commitLeasedAgentSessionTurn,
  createAgentSession,
  deleteAgentSession,
  inspectAgentSessionCatalog,
  getOrCreateInitialAgentSession,
  discardDamagedAgentSessionRecovery,
  inspectDurableAgentSessionTurn,
  loadAgentSessionTranscriptPage,
  loadCanonicalAgentSession,
  loadAgentSession,
  loadCommittedAgentSessionTurn,
  readAgentSessionRetryDraftCandidate,
  releaseAgentSessionTurnLease,
  type AgentSessionTerminalOutcome,
  type AgentSessionTransitionCommitInput,
  type AgentAttemptRecoveryRecord,
} from '@/storage/agent-session-store';
import {
  agentSessionLogicalByteLength,
  agentAttemptLogicalByteLength,
  clearAgentToolCache,
  getAgentStorageUsage,
  reconcileAgentStorageUsage,
  storeAgentArtifact,
} from '@/storage/agent-storage-store';
import { db } from '@/storage/db';
import { AgentCanonicalSessionCache } from '@/storage/agent-session-cache';
import type { OrganizeJobRecord } from '@/types';

const messages: BgsmAgentSessionMessage[] = [
  { id: 'user-1', role: 'user', content: 'Organize my repositories', createdAt: 1 },
  {
    id: 'agent-call-1',
    role: 'agent',
    content: '',
    createdAt: 2,
    toolCalls: [{ id: 'call-1', name: 'list_stars', arguments: {} }],
  },
  {
    id: 'tool-1',
    role: 'tool',
    content: '{"ok":true,"data":{}}',
    createdAt: 3,
    toolCallId: 'call-1',
    toolName: 'list_stars',
  },
  { id: 'agent-1', role: 'agent', content: 'I inspected the library.', createdAt: 4 },
  { id: 'user-2', role: 'user', content: 'Continue', createdAt: 5 },
  {
    id: 'agent-call-2',
    role: 'agent',
    content: '',
    createdAt: 6,
    toolCalls: [{ id: 'call-2', name: 'list_tags', arguments: {} }],
  },
  {
    id: 'tool-2',
    role: 'tool',
    content: '{"ok":true,"data":{}}',
    createdAt: 7,
    toolCallId: 'call-2',
    toolName: 'list_tags',
  },
  { id: 'agent-2', role: 'agent', content: 'The taxonomy is ready.', createdAt: 8 },
];
const sequencedMessages = messages.map((message, index) => ({
  sequence: index + 1,
  ...message,
}));


const checkpoint: BgsmAgentCompactionCheckpoint = {
  schemaVersion: 1,
  summary: 'The first repository inspection completed.',
  summarizedMessageCount: 4,
  summarizedThroughMessageId: 'agent-1',
};

const projection: BgsmAgentActiveProjection = {
  schemaVersion: 1,
  currentUserMessageId: 'user-2',
  summarizedThroughMessageId: 'tool-2',
  retainedSuffixFirstMessageId: 'agent-2',
  rawMessageCountAtCreation: 3,
  rawTailMessageIdAtCreation: 'tool-2',
  capabilityRevision: 'capability-v1',
  policyRevision: 'policy-v1',
  summary: 'The tag inventory was loaded.',
};

const terminalOutcome: AgentSessionTerminalOutcome = {
  reason: 'final_answer',
  changed: false,
  changedCount: 0,
  writeSettlement: 'none',
};


describe('durable Agent session store', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
  });

  afterAll(async () => {
    await db.close();
  });

  it('digests the complete canonical launch identity without storing the prompt in outcomes', async () => {
    const candidate = {
      kind: 'selected_repository' as const,
      selectedRepositoryIdHint: 'owner/repo',
    };
    const launch = {
      turnAttemptId: 'attempt-launch-digest',
      sessionId: 'session-launch-digest',
      baseRevision: 3,
      prompt: 'Inspect this repository',
      candidateContract: candidate,
    };
    const digest = await digestAgentSessionLaunch(launch);
    assert.match(digest, /^asl:v1:[A-Za-z0-9_-]{43}$/u);
    assert.equal(await digestAgentSessionLaunch({
      candidateContract: candidate,
      prompt: launch.prompt,
      baseRevision: launch.baseRevision,
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
    }), digest);
    assert.notEqual(await digestAgentSessionLaunch({
      ...launch,
      prompt: 'Inspect another repository',
    }), digest);
  });

  it('rejects oversized UTF-8 session IDs before storage access', async () => {
    const oversizedSessionId = 'é'.repeat(257);

    await assert.rejects(
      () => createAgentSession({ idFactory: () => oversizedSessionId }),
      RangeError,
    );
    await assert.rejects(() => loadAgentSession(oversizedSessionId), RangeError);
    await assert.rejects(() => deleteAgentSession(oversizedSessionId), RangeError);
    assert.equal(await db.agentSessions.count(), 0);
  });

  it('commits canonical history, binding, checkpoint, projection, title and revision atomically', async () => {
    const created = await createAgentSession({
      idFactory: () => 'session-atomic',
      now: () => 10,
    });
    const transition = fullTransition(created.session.id);

    const committed = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-atomic',
      transition,
      now: () => 20,
    });

    assert.equal(committed.idempotent, false);
    assert.equal(committed.session.revision, 1);
    assert.deepEqual(committed.transcript.messages, sequencedMessages);
    assert.deepEqual(committed.presentationMessages, [
      { sequence: 1, id: 'user-1', role: 'user', content: 'Organize my repositories', createdAt: 1 },
      { sequence: 8, id: 'agent-2', role: 'agent', content: 'The taxonomy is ready.', createdAt: 8 },
    ]);
    assert.deepEqual(committed.session.compaction, checkpoint);
    assert.deepEqual(committed.session.activeProjections, [projection]);
    assert.deepEqual(committed.session.binding, transition.binding);
    assert.equal(committed.summary.title, 'Organize my repositories');
    assert.equal(committed.summary.updatedAt, 20);
    assert.equal(await db.agentMessages.count(), messages.length);
    const storedHeader = (await db.agentSessions.get(created.session.id))!;
    const storedAttempt = await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([created.session.id, 'attempt-atomic'])
      .first();
    assert.ok(storedAttempt);
    const storedMessages = await db.agentMessages.where('sessionId').equals(created.session.id).toArray();
    assert.equal(
      (await getAgentStorageUsage()).canonicalBytes,
      agentSessionLogicalByteLength(storedHeader)
        + agentAttemptLogicalByteLength(storedAttempt)
        + storedMessages.reduce((total, message) => total + message.byteLength, 0),
    );
    const loaded = await loadAgentSession(created.session.id);
    assert.deepEqual(loaded.session, committed.session);
    assert.deepEqual(loaded.transcript.messages, sequencedMessages);
    assert.equal(loaded.transcript.nextBeforeSequence, null);
  });

  it('uses exact revision cache hits for loads and warm appends, then evicts after deletion', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-cache-boundary' });
    const cache = new AgentCanonicalSessionCache();
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-cache-first',
      transition: {
        sessionId: created.session.id,
        baseRevision: 0,
        messageDelta: messages.slice(0, 4),
      },
    });
    const loaded = await loadCanonicalAgentSession(created.session.id, cache);
    const whereSpy = vi.spyOn(db.agentMessages, 'where');
    assert.deepEqual(await loadCanonicalAgentSession(created.session.id, cache), loaded);
    assert.equal(
      whereSpy.mock.calls.filter(([index]) => (
        typeof index === 'string' && index === 'sessionId'
      )).length,
      0,
    );
    const secondCommit = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-cache-second',
      transition: {
        sessionId: created.session.id,
        baseRevision: 1,
        messageDelta: messages.slice(4),
      },
    }, cache);
    const replay = await loadCommittedAgentSessionTurn({
      sessionId: created.session.id,
      turnAttemptId: secondCommit.turnAttemptId,
      launchDigest: secondCommit.launchDigest,
    });
    assert.equal(replay?.idempotent, true);
    assert.equal(
      whereSpy.mock.calls.filter(([index]) => (
        typeof index === 'string' && index === 'sessionId'
      )).length,
      0,
    );
    whereSpy.mockRestore();
    assert.equal(cache.get(created.session.id, 2)?.messages.length, messages.length);
    assert.equal(await deleteAgentSession(created.session.id, { cache }), true);
    assert.equal(cache.get(created.session.id, 2), null);
  });

  it('does not publish a cache revision when the canonical transaction fails', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-cache-failure' });
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-cache-failure-first',
      transition: {
        sessionId: created.session.id,
        baseRevision: 0,
        messageDelta: messages.slice(0, 4),
      },
    });
    const cache = new AgentCanonicalSessionCache();
    const loaded = await loadCanonicalAgentSession(created.session.id, cache);
    const bulkAdd = vi.spyOn(db.agentMessages, 'bulkAdd')
      .mockRejectedValueOnce(new Error('canonical message write failed'));
    try {
      await assert.rejects(
        () => commitAgentSessionTransition({
          turnAttemptId: 'attempt-cache-failure-second',
          transition: {
            sessionId: created.session.id,
            baseRevision: 1,
            messageDelta: messages.slice(4),
          },
        }, cache),
        /canonical message write failed/,
      );
    } finally {
      bulkAdd.mockRestore();
    }
    assert.deepEqual(cache.get(created.session.id, 1), loaded);
    assert.equal(cache.get(created.session.id, 2), null);
    assert.equal((await db.agentSessions.get(created.session.id))?.revision, 1);
  });

  it('replays session creation by caller-provided ID without duplicating durable rows', async () => {
    const first = await createAgentSession({
      idFactory: () => 'session-create-replay',
      now: () => 10,
    });
    const replay = await createAgentSession({
      idFactory: () => 'session-create-replay',
      now: () => 20,
    });

    assert.deepEqual(replay, first);
    assert.equal(await db.agentSessions.count(), 1);
    assert.equal(await db.agentMessages.count(), 0);
  });

  it('converges concurrent empty-catalog activation on one durable initial session', async () => {
    const [pageA, pageB] = await Promise.all([
      getOrCreateInitialAgentSession({
        idFactory: () => 'session-initial-page-a',
        now: () => 10,
      }),
      getOrCreateInitialAgentSession({
        idFactory: () => 'session-initial-page-b',
        now: () => 20,
      }),
    ]);

    assert.equal(pageA.session.id, pageB.session.id);
    assert.equal(await db.agentSessions.count(), 1);
    assert.equal(await db.agentMessages.count(), 0);
    assert.deepEqual(
      (await inspectAgentSessionCatalog()).summaries.map(({ id }) => id),
      [pageA.session.id],
    );
  });

  it('keeps full canonical history in IndexedDB and returns bounded recent transcript pages', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-pages' });
    const pageMessages = Array.from({ length: 120 }, (_, index) => {
      const createdAt = index * 2 + 1;
      return [
        {
          id: `page-user-${index}`,
          role: 'user' as const,
          content: `Question ${index}`,
          createdAt,
        },
        {
          id: `page-agent-${index}`,
          role: 'agent' as const,
          content: `Answer ${index}`,
          createdAt: createdAt + 1,
        },
      ];
    }).flat();
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-pages',
      transition: {
        sessionId: created.session.id,
        baseRevision: 0,
        messageDelta: pageMessages,
        binding: fullTransition(created.session.id).binding,
      },
    });

    const whereSpy = vi.spyOn(db.agentMessages, 'where');
    const recent = await loadAgentSession(created.session.id);
    assert.deepEqual(whereSpy.mock.calls.map(([index]) => index), ['[sessionId+sequence]']);
    whereSpy.mockRestore();
    assert.equal(recent.transcript.messages.length, 100);
    assert.equal(recent.transcript.nextBeforeSequence, 141);
    const middle = await loadAgentSessionTranscriptPage(
      created.session.id,
      recent.transcript.nextBeforeSequence!,
    );
    assert.equal(middle.messages.length, 100);
    assert.equal(middle.nextBeforeSequence, 41);
    const oldest = await loadAgentSessionTranscriptPage(
      created.session.id,
      middle.nextBeforeSequence!,
    );
    assert.equal(oldest.messages.length, 40);
    assert.equal(oldest.nextBeforeSequence, null);
    assert.deepEqual(
      [...oldest.messages, ...middle.messages, ...recent.transcript.messages],
      pageMessages.map((message, index) => ({ sequence: index + 1, ...message })),
    );
    assert.deepEqual((await loadCanonicalAgentSession(created.session.id)).messages, pageMessages);
  });

  it('bounds transcript pages while persisting an aggregate turn larger than 8 MiB', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-byte-pages' });
    const largeMessages = Array.from({ length: 5 }, (_, index) => {
      const createdAt = index * 2 + 1;
      return [
        {
          id: `large-user-${index}`,
          role: 'user' as const,
          content: 'u'.repeat(400_000),
          createdAt,
        },
        {
          id: `large-agent-${index}`,
          role: 'agent' as const,
          content: 'a'.repeat(400_000),
          createdAt: createdAt + 1,
        },
      ];
    }).flat();
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-byte-pages',
      transition: {
        sessionId: created.session.id,
        baseRevision: 0,
        messageDelta: largeMessages,
        binding: fullTransition(created.session.id).binding,
      },
    });
    const loaded = await loadAgentSession(created.session.id);
    assert.ok(loaded.transcript.messages.length > 0);
    assert.ok(loaded.transcript.messages.length < largeMessages.length);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(loaded.transcript.messages)).byteLength
        <= AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
    );

    const oversized = Array.from({ length: 9 }, (_, index) => {
      const createdAt = index * 2 + 1;
      return [
        {
          id: `oversized-user-${index}`,
          role: 'user' as const,
          content: 'u'.repeat(500_000),
          createdAt,
        },
        {
          id: `oversized-agent-${index}`,
          role: 'agent' as const,
          content: 'a'.repeat(500_000),
          createdAt: createdAt + 1,
        },
      ];
    }).flat();
    const oversizedCommit = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-oversized-delta',
      transition: {
        sessionId: created.session.id,
        baseRevision: 1,
        messageDelta: oversized,
      },
    });
    assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).byteLength > 8 * 1024 * 1024);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(oversizedCommit.transcript.messages)).byteLength
        <= AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
    );
    assert.deepEqual(oversizedCommit.presentationMessages, [
      { sequence: 11, id: 'oversized-user-0', role: 'user', content: 'u'.repeat(500_000), createdAt: 1 },
      { sequence: 28, id: 'oversized-agent-8', role: 'agent', content: 'a'.repeat(500_000), createdAt: 18 },
    ]);
    assert.equal((await loadCanonicalAgentSession(created.session.id)).messages.length, 28);
  });

  it('makes ACK-loss retries idempotent and rejects attempt ID reuse with another payload', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-retry' });
    const transition = fullTransition(created.session.id);
    const expectedDigest = await digestAgentSessionTransition(transition);
    assert.equal(await digestAgentSessionTransition({
      binding: transition.binding,
      messageDelta: transition.messageDelta,
      candidateActiveProjection: transition.candidateActiveProjection,
      candidateCheckpoint: transition.candidateCheckpoint,
      baseRevision: transition.baseRevision,
      sessionId: transition.sessionId,
    }), expectedDigest);
    const first = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-retry',
      transition,
    });
    const replay = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-retry',
      transition,
    });

    assert.equal(replay.idempotent, true);
    assert.equal(replay.appliedRevision, 1);
    assert.equal(replay.session.revision, first.session.revision);
    assert.deepEqual(replay.presentationMessages, first.presentationMessages);
    assert.equal(await db.agentMessages.count(), messages.length);
    assert.deepEqual((await loadAgentSession(created.session.id)).appliedTurnReceipts, [{
      turnAttemptId: 'attempt-retry',
      digest: expectedDigest,
      launchDigest: first.launchDigest,
      appliedRevision: 1,
      outcome: terminalOutcome,
    }]);
    await assert.rejects(
      () => commitAgentSessionTransition({
        turnAttemptId: 'attempt-retry',
        transition: {
          ...transition,
          messageDelta: messages.map((message, index) => (
            index === 0 ? { ...message, content: 'Different prompt' } : message
          )),
        },
      }),
      AgentSessionAttemptConflictError,
    );
  });

  it('isolates malformed attempt receipts from the canonical session catalog', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-missing-settlement' });
    const turnAttemptId = 'attempt-missing-settlement';
    const committed = await commitAgentSessionTransition({
      turnAttemptId,
      transition: fullTransition(created.session.id),
      outcome: terminalOutcome,
    });
    const attempt = await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([created.session.id, turnAttemptId])
      .first();
    assert.ok(attempt?.receipt);
    const { writeSettlement: _writeSettlement, ...malformedOutcome } = attempt.receipt.outcome;
    await db.agentAttempts.put({
      ...attempt,
      receipt: {
        ...attempt.receipt,
        outcome: malformedOutcome as AgentSessionTerminalOutcome,
      },
    });

    await assert.rejects(
      () => loadCommittedAgentSessionTurn({
        sessionId: created.session.id,
        turnAttemptId,
        launchDigest: committed.launchDigest,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AgentAttemptCorruptionError);
        assert.match(error.message, /terminal outcome has unexpected fields/iu);
        return true;
      },
    );
    assert.equal((await loadAgentSession(created.session.id)).session.id, created.session.id);
    const catalog = await inspectAgentSessionCatalog();
    assert.deepEqual(catalog.summaries.map((summary) => summary.id), [created.session.id]);
    assert.equal(catalog.corruptions.length, 0);
  });

  it('keeps ACK-loss replays idempotent after another tab commits a later revision', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-delayed-retry' });
    const firstTransition = fullTransition(created.session.id);
    const firstDigest = await digestAgentSessionTransition(firstTransition);
    const firstCommit = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-delayed-a',
      transition: firstTransition,
    });
    const followupMessages: BgsmAgentSessionMessage[] = [
      { id: 'user-3', role: 'user', content: 'Keep going', createdAt: 9 },
      { id: 'agent-3', role: 'agent', content: 'The follow-up is complete.', createdAt: 10 },
    ];
    const followupTransition: BgsmAgentSessionTransition = {
      sessionId: created.session.id,
      baseRevision: 1,
      messageDelta: followupMessages,
    };
    const followupDigest = await digestAgentSessionTransition(followupTransition);
    const followupCommit = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-delayed-b',
      transition: followupTransition,
    });
    const beforeReplay = await loadAgentSession(created.session.id);

    const replay = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-delayed-a',
      transition: firstTransition,
    });
    const afterReplay = await loadAgentSession(created.session.id);

    assert.equal(replay.idempotent, true);
    assert.equal(replay.appliedRevision, 1);
    assert.equal(replay.session.revision, 2);
    assert.deepEqual(replay.presentationMessages, [
      { sequence: 1, id: 'user-1', role: 'user', content: 'Organize my repositories', createdAt: 1 },
      { sequence: 8, id: 'agent-2', role: 'agent', content: 'The taxonomy is ready.', createdAt: 8 },
    ]);
    assert.deepEqual(
      beforeReplay.appliedTurnReceipts,
      [
        {
          turnAttemptId: 'attempt-delayed-a',
          digest: firstDigest,
          launchDigest: firstCommit.launchDigest,
          appliedRevision: 1,
          outcome: terminalOutcome,
        },
        {
          turnAttemptId: 'attempt-delayed-b',
          digest: followupDigest,
          launchDigest: followupCommit.launchDigest,
          appliedRevision: 2,
          outcome: terminalOutcome,
        },
      ],
    );
    assert.deepEqual(afterReplay.appliedTurnReceipts, beforeReplay.appliedTurnReceipts);
    assert.deepEqual(
      afterReplay.transcript.messages,

      [...messages, ...followupMessages].map((message, index) => ({
        sequence: index + 1,
        ...message,
      })),
    );
    assert.equal(await db.agentMessages.count(), messages.length + followupMessages.length);
  });

  it('transactionally prunes structurally valid residual recovery with the oldest settled attempt', async () => {
    const sessionId = 'session-prune-residual-recovery';
    await createAgentSession({ idFactory: () => sessionId, now: () => 1 });
    const cache = new AgentCanonicalSessionCache();
    const transitionFor = (index: number): BgsmAgentSessionTransition => ({
      sessionId,
      baseRevision: index,
      messageDelta: [
        {
          id: `prune-user-${index}`,
          role: 'user',
          content: `Question ${index}`,
          createdAt: index * 2 + 1,
        },
        {
          id: `prune-agent-${index}`,
          role: 'agent',
          content: `Answer ${index}`,
          createdAt: index * 2 + 2,
        },
      ],
    });

    for (let index = 0; index < 129; index += 1) {
      await commitAgentSessionTransition({
        turnAttemptId: `attempt-prune-${index}`,
        transition: transitionFor(index),
        now: () => index + 10,
      }, cache);
    }
    const oldest = await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([sessionId, 'attempt-prune-0'])
      .first();
    assert.ok(oldest);
    const recoveryMessage: BgsmAgentSessionMessage = {
      id: 'prune-residual-user',
      role: 'user',
      content: 'Residual recovery projection.',
      createdAt: 500,
    };
    await db.agentAttemptRecoveries.put({
      id: oldest.id,
      schemaVersion: 1,
      sessionId,
      turnAttemptId: oldest.turnAttemptId,
      projectedMessages: [recoveryMessage],
      canonicalRawMessages: [recoveryMessage],
      updatedAt: 500,
    });
    await reconcileAgentStorageUsage(() => 501);

    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-prune-129',
      transition: transitionFor(129),
      now: () => 600,
    }, cache);

    assert.equal(await db.agentAttempts.get(oldest.id), undefined);
    assert.equal(await db.agentAttemptRecoveries.get(oldest.id), undefined);
    const accountedBytes = (await getAgentStorageUsage()).canonicalBytes;
    assert.equal((await reconcileAgentStorageUsage(() => 601)).canonicalBytes, accountedBytes);
  }, 20_000);
  it('joins exact read-only recovery rows, fails closed when damaged, and preserves the transcript', async () => {
    const sessionId = 'session-recovery-join';
    await createAgentSession({ idFactory: () => sessionId, now: () => 1 });
    const seedAttempt = async (turnAttemptId: string, suffix: string) => {
      const launch = {
        sessionId,
        turnAttemptId,
        baseRevision: 0,
        prompt: 'Resume this read-only request.',
      };
      const launchDigest = await digestAgentSessionLaunch(launch);
      await admitAgentSessionTurn({
        ...launch,
        launch,
        launchDigest,
        executionEpochId: `worker-recovery-${suffix}`,
        recoveryClass: 'statically_read_only',
        now: () => 10,
      });
      const attempt = (await db.agentAttempts
        .where('[sessionId+turnAttemptId]')
        .equals([sessionId, turnAttemptId])
        .first())!;
      const coverage = await createAgentArtifactCoverage({
        artifactId: `artifact-recovery-${suffix}`,
        sourceToolCallId: `call-recovery-${suffix}`,
        expectedBytes: 1,
        artifactSha256: 'a'.repeat(43),
        integrityManifestSha256: 'b'.repeat(43),
      });
      const control = {
        schemaVersion: 1 as const,
        directives: agentArtifactCoverageDirectives([coverage]),
        nonProgressRepromptUsed: false,
        updatedAt: 11,
      };
      const recoveryMessage: BgsmAgentSessionMessage = {
        id: `recovery-user-${suffix}`,
        role: 'user',
        content: 'Continue the checked-out read.',
        createdAt: 11,
      };
      await db.agentAttempts.put({
        ...attempt,
        artifactCoverage: [coverage],
        artifactContinuationControl: control,
        updatedAt: 11,
      });
      const recovery: AgentAttemptRecoveryRecord = {
        id: attempt.id,
        schemaVersion: 1,
        sessionId,
        turnAttemptId,
        projectedMessages: [recoveryMessage],
        canonicalRawMessages: [recoveryMessage],
        updatedAt: 11,
      };
      await db.agentAttemptRecoveries.put(recovery);
      return { attempt, control, recovery, recoveryMessage };
    };

    const missing = await seedAttempt('attempt-recovery-missing', 'missing');
    await db.agentAttemptRecoveries.delete(missing.attempt.id);
    await reconcileAgentStorageUsage(() => 12);
    await assert.rejects(
      () => inspectDurableAgentSessionTurn(sessionId, 'worker-recovery-missing'),
      AgentAttemptCorruptionError,
    );
    assert.equal((await db.agentAttempts.get(missing.attempt.id))?.state, 'state_uncertain');
    assert.equal((await loadCanonicalAgentSession(sessionId)).id, sessionId);
    assert.equal(await discardDamagedAgentSessionRecovery(sessionId, 20), 1);

    const valid = await seedAttempt('attempt-recovery-valid', 'valid');
    await reconcileAgentStorageUsage(() => 21);
    const chunkWhere = vi.spyOn(db.agentArtifactChunks, 'where');
    const recoveryToArray = vi.spyOn(db.agentAttemptRecoveries, 'toArray')
      .mockRejectedValue(new Error('recovery payload should not be materialized as a collection'));
    try {
      const inspected = await inspectDurableAgentSessionTurn(sessionId, 'worker-recovery-valid');
      assert.deepEqual(inspected?.artifactContinuation, {
        schemaVersion: 1,
        projectedMessages: [valid.recoveryMessage],
        canonicalRawMessages: [valid.recoveryMessage],
        directives: valid.control.directives,
        nonProgressRepromptUsed: false,
        updatedAt: 11,
      });
    } finally {
      recoveryToArray.mockRestore();
    }
    assert.equal(chunkWhere.mock.calls.length, 0);
    chunkWhere.mockRestore();

    await db.agentAttemptRecoveries.update(valid.attempt.id, {
      projectedMessages: [{ ...valid.recoveryMessage, unexpected: true }] as never,
    });
    await assert.rejects(
      () => inspectDurableAgentSessionTurn(sessionId, 'worker-recovery-damaged'),
      AgentAttemptCorruptionError,
    );
    assert.equal((await loadCanonicalAgentSession(sessionId)).id, sessionId);
    assert.equal(await discardDamagedAgentSessionRecovery(sessionId, 22), 1);
    assert.equal(await db.agentAttemptRecoveries.count(), 0);
    assert.equal(await db.agentAttempts.count(), 0);
  });

  it('does not refresh cache recency when a commit transaction fails', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-cache-recency-failure' });
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-cache-recency-first',
      transition: {
        sessionId: created.session.id,
        baseRevision: 0,
        messageDelta: messages.slice(0, 4),
      },
    });
    const cache = new AgentCanonicalSessionCache();
    const loaded = await loadCanonicalAgentSession(created.session.id, cache);
    for (let index = 1; index < 8; index += 1) {
      cache.put({ ...loaded, id: `session-cache-recency-padding-${index}` });
    }
    const bulkAdd = vi.spyOn(db.agentMessages, 'bulkAdd')
      .mockRejectedValueOnce(new Error('canonical message write failed'));
    try {
      await assert.rejects(
        () => commitAgentSessionTransition({
          turnAttemptId: 'attempt-cache-recency-second',
          transition: {
            sessionId: created.session.id,
            baseRevision: 1,
            messageDelta: messages.slice(4),
          },
        }, cache),
        /canonical message write failed/,
      );
    } finally {
      bulkAdd.mockRestore();
    }
    assert.deepEqual(cache.peek(created.session.id, 1), loaded);
    cache.put({ ...loaded, id: 'session-cache-recency-after-failure' });
    assert.equal(cache.peek(created.session.id, 1), null);
    assert.ok(cache.peek('session-cache-recency-padding-1', 1));
  });

  it('blocks retry and fresh start on recovery-only corruption until explicit discard', async () => {
    const sessionId = 'session-recovery-only-corruption';
    await createAgentSession({ idFactory: () => sessionId, now: () => 1 });
    const launch = {
      sessionId,
      turnAttemptId: 'attempt-recovery-only-corruption',
      baseRevision: 0,
      prompt: 'Retry this request.',
    };
    const launchDigest = await digestAgentSessionLaunch(launch);
    await admitAgentSessionTurn({
      ...launch,
      launch,
      launchDigest,
      executionEpochId: 'worker-recovery-only-corruption',
      recoveryClass: 'write_capable_or_unknown',
      now: () => 10,
    });
    const attempt = (await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([sessionId, launch.turnAttemptId])
      .first())!;
    await db.agentAttempts.put({
      ...attempt,
      state: 'retryable',
      retryKind: 'failed',
      lease: null,
      updatedAt: 11,
    });
    await db.agentAttemptRecoveries.put({
      id: attempt.id,
      schemaVersion: 1,
      sessionId,
      turnAttemptId: launch.turnAttemptId,
      projectedMessages: [],
      canonicalRawMessages: [],
      updatedAt: 11,
    });

    const recoveryToArray = vi.spyOn(db.agentAttemptRecoveries, 'toArray')
      .mockRejectedValue(new Error('recovery payload should not be materialized'));
    try {
      await assert.rejects(
        () => readAgentSessionRetryDraftCandidate(sessionId),
        AgentAttemptCorruptionError,
      );
    } finally {
      recoveryToArray.mockRestore();
    }
    const freshLaunch = { ...launch, turnAttemptId: 'attempt-fresh-after-corruption' };
    const freshDigest = await digestAgentSessionLaunch(freshLaunch);
    await assert.rejects(
      () => admitAgentSessionTurn({
        ...freshLaunch,
        launch: freshLaunch,
        launchDigest: freshDigest,
        executionEpochId: 'worker-fresh-after-corruption',
        recoveryClass: 'write_capable_or_unknown',
        now: () => 12,
      }),
      AgentAttemptCorruptionError,
    );
    assert.equal((await loadCanonicalAgentSession(sessionId)).id, sessionId);
    assert.equal(await discardDamagedAgentSessionRecovery(sessionId, 13), 1);
    assert.equal(await db.agentAttemptRecoveries.count(), 0);
    assert.equal(await db.agentAttempts.count(), 0);
  });
  it('admits one active attempt and lets only statically read-only work reacquire after an epoch change', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-turn-lease' });
    const launch = {
      sessionId: created.session.id,
      baseRevision: 0,
      turnAttemptId: 'attempt-lease-a',
      prompt: 'Resume this read-only request.',
    };
    const launchDigest = await digestAgentSessionLaunch(launch);
    const admission = {
      ...launch,
      launch,
      launchDigest,
      executionEpochId: 'worker-epoch-a',
      recoveryClass: 'statically_read_only' as const,
      now: () => 10,
    };
    assert.deepEqual(await admitAgentSessionTurn(admission), { kind: 'acquired' });
    assert.deepEqual(await admitAgentSessionTurn(admission), { kind: 'acquired' });
    const competingLaunch = { ...launch, turnAttemptId: 'attempt-lease-b' };
    const competingDigest = await digestAgentSessionLaunch(competingLaunch);
    await assert.rejects(
      () => admitAgentSessionTurn({
        ...admission,
        turnAttemptId: competingLaunch.turnAttemptId,
        launch: competingLaunch,
        launchDigest: competingDigest,
      }),
      AgentSessionTurnActiveError,
    );

    assert.deepEqual(await admitAgentSessionTurn({
      ...admission,
      executionEpochId: 'worker-epoch-b',
      now: () => 11,
    }), { kind: 'acquired' });
    assert.equal(await releaseAgentSessionTurnLease({
      sessionId: created.session.id,
      turnAttemptId: launch.turnAttemptId,
      executionEpochId: 'worker-epoch-a',
    }), false);
    const stored = await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([created.session.id, launch.turnAttemptId])
      .first();
    assert.equal(stored?.lease?.executionEpochId, 'worker-epoch-b');
  });

  it('atomically admits or replays a committed turn across worker epochs', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-admit-replay' });
    const transition = fullTransition(created.session.id);
    const launch = {
      turnAttemptId: 'attempt-admit-replay',
      sessionId: created.session.id,
      baseRevision: 0,
      prompt: messages[0]!.content,
      candidateContract: transition.binding!.candidateContract,
    };
    const launchDigest = await digestAgentSessionLaunch(launch);
    const admission = {
      sessionId: created.session.id,
      baseRevision: 0,
      turnAttemptId: 'attempt-admit-replay',
      executionEpochId: 'worker-admit-a',
      launchDigest,
      launch,
    };
    assert.deepEqual(await admitAgentSessionTurn(admission), { kind: 'acquired' });
    const outcome: AgentSessionTerminalOutcome = {
      ...terminalOutcome,
      organizeLibraryAction: 'request_confirmation',
      handoffAnchor: { messageId: 'agent-2', createdAt: 8 },
    };
    const committed = await commitLeasedAgentSessionTurn({
      turnAttemptId: admission.turnAttemptId,
      executionEpochId: admission.executionEpochId,
      launchDigest,
      transition,
      outcome,
    });
    assert.equal(committed.idempotent, false);
    const storedAttempt = await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([created.session.id, admission.turnAttemptId])
      .first();
    assert.equal(storedAttempt?.lease, null);
    assert.deepEqual(storedAttempt?.admittedLaunch, launch);

    const replay = await admitAgentSessionTurn({
      ...admission,
      executionEpochId: 'worker-admit-b',
    });
    assert.equal(replay.kind, 'replay');
    if (replay.kind !== 'replay') throw new Error('Expected a durable replay.');
    assert.equal(replay.commit.idempotent, true);
    assert.deepEqual(replay.commit.outcome, outcome);
    assert.deepEqual(replay.commit.presentationMessages, committed.presentationMessages);
    assert.deepEqual(
      await loadCommittedAgentSessionTurn({
        sessionId: created.session.id,
        turnAttemptId: admission.turnAttemptId,
        launchDigest,
      }),
      replay.commit,
    );
    await assert.rejects(
      () => admitAgentSessionTurn({
        ...admission,
        executionEpochId: 'worker-admit-c',
        launchDigest: `asl:v1:${'x'.repeat(43)}` as AgentSessionLaunchDigest,
      }),
      AgentSessionAttemptConflictError,
    );
  });

  it('lets a new worker replace admission but rejects a stale leased commit', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-stale-commit' });
    const transition = fullTransition(created.session.id);
    const launch = {
      turnAttemptId: 'attempt-stale-commit',
      sessionId: created.session.id,
      baseRevision: 0,
      prompt: messages[0]!.content,
      candidateContract: transition.binding!.candidateContract,
    };
    const launchDigest = await digestAgentSessionLaunch(launch);
    const admission = {
      sessionId: created.session.id,
      baseRevision: 0,
      turnAttemptId: 'attempt-stale-commit',
      executionEpochId: 'worker-stale-a',
      launchDigest,
      launch,
      recoveryClass: 'statically_read_only' as const,
    };
    await admitAgentSessionTurn(admission);
    await admitAgentSessionTurn({ ...admission, executionEpochId: 'worker-stale-b' });
    await assert.rejects(
      () => commitLeasedAgentSessionTurn({
        turnAttemptId: admission.turnAttemptId,
        executionEpochId: admission.executionEpochId,
        launchDigest,
        transition,
        outcome: terminalOutcome,
      }),
      AgentSessionTurnLeaseMismatchError,
    );
    const committed = await commitLeasedAgentSessionTurn({
      turnAttemptId: admission.turnAttemptId,
      executionEpochId: 'worker-stale-b',
      launchDigest,
      transition,
      outcome: terminalOutcome,
    });
    assert.equal(committed.appliedRevision, 1);
  });

  it('rejects a single serialized message row that cannot fit in a transcript page', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-message-row-limit' });
    const toolCalls = Array.from({ length: 7 }, (_, index) => ({
      id: `oversized-call-${index}`,
      name: 'search_stars',
      arguments: { query: 'q'.repeat(240_000) },
    }));
    const transition: BgsmAgentSessionTransition = {
      sessionId: created.session.id,
      baseRevision: 0,
      binding: fullTransition(created.session.id).binding,
      messageDelta: [
        { id: 'row-user', role: 'user', content: 'Search', createdAt: 1 },
        { id: 'row-agent', role: 'agent', content: '', createdAt: 2, toolCalls },
        ...toolCalls.map((call, index) => ({
          id: `row-tool-${index}`,
          role: 'tool' as const,
          content: '{"ok":true}',
          createdAt: index + 3,
          toolCallId: call.id,
          toolName: call.name,
        })),
      ],
    };
    await assert.rejects(
      () => commitAgentSessionTransition({
        turnAttemptId: 'attempt-message-row-limit',
        transition,
      }),
      /message row exceeds the transcript page budget/iu,
    );
    assert.equal((await loadAgentSession(created.session.id)).session.revision, 0);
    assert.equal(await db.agentMessages.count(), 0);
  });

  it('clears the matching physical attempt lease in the same transaction as its canonical commit', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-lease-commit' });
    const transition = fullTransition(created.session.id);
    const launch = {
      turnAttemptId: 'attempt-lease-commit',
      sessionId: created.session.id,
      baseRevision: 0,
      prompt: messages[0]!.content,
      candidateContract: transition.binding!.candidateContract,
    };
    const launchDigest = await digestAgentSessionLaunch(launch);
    await admitAgentSessionTurn({
      ...launch,
      launch,
      launchDigest,
      executionEpochId: 'worker-lease-commit',
      now: () => 10,
    });
    await commitLeasedAgentSessionTurn({
      turnAttemptId: launch.turnAttemptId,
      transition,
      launchDigest,
      outcome: terminalOutcome,
      executionEpochId: 'worker-lease-commit',
      now: () => 11,
    });

    assert.equal((await db.agentSessions.get(created.session.id))?.revision, 1);
    assert.equal(
      (await db.agentAttempts
        .where('[sessionId+turnAttemptId]')
        .equals([created.session.id, launch.turnAttemptId])
        .first())?.lease,
      null,
    );
  });

  it('rejects a competing admitted turn before it can race the session revision', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-race' });
    const transition = fullTransition(created.session.id);
    const results = await Promise.allSettled([
      commitAgentSessionTransition({ turnAttemptId: 'attempt-a', transition }),
      commitAgentSessionTransition({ turnAttemptId: 'attempt-b', transition }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof AgentSessionTurnActiveError);
    assert.equal((await loadAgentSession(created.session.id)).session.revision, 1);
    assert.equal(await db.agentMessages.count(), messages.length);
  });

  it('rolls back messages and revision when the message write exceeds quota', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-quota' });
    const usageBefore = await getAgentStorageUsage();
    vi.spyOn(db.agentMessages, 'bulkAdd').mockRejectedValueOnce(
      new DOMException('Storage quota exhausted.', 'QuotaExceededError'),
    );

    await assert.rejects(
      () => commitAgentSessionTransition({
        turnAttemptId: 'attempt-quota',
        transition: fullTransition(created.session.id),
      }),
      /quota/u,
    );
    const loaded = await loadAgentSession(created.session.id);
    assert.equal(loaded.session.revision, 0);
    assert.deepEqual(loaded.transcript.messages, []);
    assert.equal(loaded.summary.title, '');
    assert.equal(await db.agentMessages.count(), 0);
    const attempt = await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([created.session.id, 'attempt-quota'])
      .first();
    if (!attempt) throw new Error('Expected the admitted attempt to remain durable.');
    const attemptBytes = agentAttemptLogicalByteLength(attempt);
    assert.deepEqual(await getAgentStorageUsage(), {
      ...usageBefore,
      canonicalBytes: usageBefore.canonicalBytes + attemptBytes,
      totalBytes: usageBefore.totalBytes + attemptBytes,
    });
  });

  it('clears eligible tool cache and retries only the durable commit after a quota failure', async () => {
    const cacheSession = await createAgentSession({ idFactory: () => 'session-quota-cache' });
    await storeAgentArtifact({
      artifactId: 'artifact-quota-cache',
      sessionId: cacheSession.session.id,
      turnAttemptId: 'attempt-quota-cache',
      toolCallId: 'call-quota-cache',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: '{"cached":true}',
    });
    const created = await createAgentSession({ idFactory: () => 'session-quota-retry' });
    vi.spyOn(db.agentMessages, 'bulkAdd').mockRejectedValueOnce(
      new DOMException('Storage quota exhausted.', 'QuotaExceededError'),
    );

    const committed = await commitAgentSessionTransition({
      turnAttemptId: 'attempt-quota-retry',
      transition: fullTransition(created.session.id),
    });

    assert.equal(committed.session.revision, 1);
    assert.equal(await db.agentArtifacts.get('artifact-quota-cache'), undefined);
    assert.equal(await db.agentMessages.where('sessionId').equals(created.session.id).count(), messages.length);
    const usage = await getAgentStorageUsage();
    assert.equal(usage.cacheBytes, 0);
    assert.equal(usage.messageCount, messages.length);
  });

  it('drops only the current unbound artifact and commits a bounded transcript after quota failure', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-quota-degraded' });
    const turnAttemptId = 'attempt-quota-degraded';
    const executionEpochId = 'worker-quota-degraded';
    const transition = fullTransition(created.session.id);
    transition.messageDelta = transition.messageDelta.map((message) => (
      message.id === 'tool-1'
        ? {
            ...message,
            content: '{"ok":true,"data":{"status":"artifact_available"}}',
            opaqueReferences: ['artifact-quota-degraded'],
          }
        : message
    ));
    const launch = {
      turnAttemptId,
      sessionId: created.session.id,
      baseRevision: 0,
      prompt: messages[0]!.content,
      candidateContract: transition.binding!.candidateContract,
    };
    const launchDigest = await digestAgentSessionLaunch(launch);
    await admitAgentSessionTurn({
      ...launch,
      launch,
      launchDigest,
      executionEpochId,
      now: () => 10,
    });
    await storeAgentArtifact({
      artifactId: 'artifact-quota-degraded',
      sessionId: created.session.id,
      turnAttemptId,
      toolCallId: 'call-1',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: JSON.stringify({ repositories: ['owner/repo'] }),
      now: () => 11,
    });
    vi.spyOn(db.agentMessages, 'bulkAdd').mockRejectedValueOnce(
      new DOMException('Storage quota exhausted.', 'QuotaExceededError'),
    );

    const committed = await commitLeasedAgentSessionTurn({
      turnAttemptId,
      transition,
      launchDigest,
      outcome: terminalOutcome,
      executionEpochId,
      now: () => 12,
    });

    assert.equal(committed.session.revision, 1);
    assert.equal(await db.agentArtifacts.get('artifact-quota-degraded'), undefined);
    const toolRow = await db.agentMessages.get('tool-1');
    assert.equal(toolRow?.artifactIds, undefined);
    assert.equal(
      JSON.parse(toolRow!.content).error.code,
      'tool_result_artifact_evicted',
    );
    assert.equal(
      (await db.agentAttempts
        .where('[sessionId+turnAttemptId]')
        .equals([created.session.id, turnAttemptId])
        .first())?.lease,
      null,
    );
    const usage = await getAgentStorageUsage();
    assert.equal(usage.cacheBytes, 0);
    assert.equal(usage.artifactCount, 0);
    assert.equal(usage.messageCount, messages.length);
  });

  it('protects a non-leased transition artifact until quota fallback can degrade it', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-quota-degraded-no-lease' });
    const turnAttemptId = 'attempt-quota-degraded-no-lease';
    await storeAgentArtifact({
      artifactId: 'artifact-quota-degraded-no-lease',
      sessionId: created.session.id,
      turnAttemptId,
      toolCallId: 'call-1',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: JSON.stringify({ repositories: ['owner/repo'] }),
      now: () => 11,
    });
    const transition = fullTransition(created.session.id);
    transition.messageDelta = transition.messageDelta.map((message) => (
      message.id === 'tool-1'
        ? {
            ...message,
            content: '{"ok":true,"data":{"status":"artifact_available"}}',
            opaqueReferences: ['artifact-quota-degraded-no-lease'],
          }
        : message
    ));
    vi.spyOn(db.agentMessages, 'bulkAdd').mockRejectedValueOnce(
      new DOMException('Storage quota exhausted.', 'QuotaExceededError'),
    );

    const committed = await commitAgentSessionTransition({
      turnAttemptId,
      transition,
      outcome: terminalOutcome,
      now: () => 12,
    });

    assert.equal(committed.session.revision, 1);
    assert.equal(await db.agentArtifacts.get('artifact-quota-degraded-no-lease'), undefined);
    const toolRow = await db.agentMessages.get('tool-1');
    assert.equal(toolRow?.artifactIds, undefined);
    assert.equal(
      JSON.parse(toolRow!.content).error.code,
      'tool_result_artifact_evicted',
    );
  });

  it('rolls artifact deletion back when the degraded quota commit also fails', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-quota-degraded-rollback' });
    const turnAttemptId = 'attempt-quota-degraded-rollback';
    const content = JSON.stringify({ repositories: ['owner/repo'] });
    await storeAgentArtifact({
      artifactId: 'artifact-quota-degraded-rollback',
      sessionId: created.session.id,
      turnAttemptId,
      toolCallId: 'call-1',
      toolName: 'list_stars',
      storageClass: 'cache',
      content,
      now: () => 11,
    });
    const transition = fullTransition(created.session.id);
    transition.messageDelta = transition.messageDelta.map((message) => (
      message.id === 'tool-1'
        ? {
            ...message,
            content: '{"ok":true,"data":{"status":"artifact_available"}}',
            opaqueReferences: ['artifact-quota-degraded-rollback'],
          }
        : message
    ));
    vi.spyOn(db.agentMessages, 'bulkAdd').mockRejectedValue(
      new DOMException('Storage quota exhausted.', 'QuotaExceededError'),
    );

    await assert.rejects(
      () => commitAgentSessionTransition({
        turnAttemptId,
        transition,
        outcome: terminalOutcome,
        now: () => 12,
      }),
      /quota/u,
    );

    assert.ok(await db.agentArtifacts.get('artifact-quota-degraded-rollback'));
    assert.equal(
      await db.agentArtifactChunks.where('artifactId').equals('artifact-quota-degraded-rollback').count(),
      1,
    );
    assert.equal((await db.agentSessions.get(created.session.id))?.revision, 0);
    assert.equal(await db.agentMessages.where('sessionId').equals(created.session.id).count(), 0);
    const usage = await getAgentStorageUsage();
    assert.equal(usage.cacheBytes, new TextEncoder().encode(content).byteLength);
  });

  it('deletes canonical messages and both artifact classes in one accounting transaction', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-delete-storage' });
    await storeAgentArtifact({
      artifactId: 'artifact-delete-canonical',
      sessionId: created.session.id,
      turnAttemptId: 'attempt-delete-canonical',
      toolCallId: 'call-delete-canonical',
      toolName: 'list_stars',
      storageClass: 'canonical',
      content: '{"canonical":true}',
    });
    await storeAgentArtifact({
      artifactId: 'artifact-delete-cache',
      sessionId: created.session.id,
      turnAttemptId: 'attempt-delete-cache',
      toolCallId: 'call-delete-cache',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: '{"cache":true}',
    });
    const transition = fullTransition(created.session.id);
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-delete-session',
      transition,
    });

    assert.equal(await deleteAgentSession(created.session.id), true);
    assert.equal(await db.agentMessages.where('sessionId').equals(created.session.id).count(), 0);
    assert.equal(await db.agentArtifacts.where('sessionId').equals(created.session.id).count(), 0);
    assert.equal(await db.agentArtifactChunks.count(), 0);
    const usage = await getAgentStorageUsage();
    assert.equal(usage.sessionCount, 0);
    assert.equal(usage.messageCount, 0);
    assert.equal(usage.artifactCount, 0);
    assert.equal(usage.canonicalBytes, 0);
    assert.equal(usage.cacheBytes, 0);
  });

  it('deletes a damaged session and rebuilds usage from the surviving records', async () => {
    const damaged = await createAgentSession({ idFactory: () => 'session-delete-damaged' });
    const survivor = await createAgentSession({ idFactory: () => 'session-delete-survivor' });
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-delete-damaged',
      transition: fullTransition(damaged.session.id),
    });
    await storeAgentArtifact({
      artifactId: 'artifact-delete-damaged',
      sessionId: damaged.session.id,
      turnAttemptId: 'attempt-delete-damaged-artifact',
      toolCallId: 'call-delete-damaged',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: 'damaged',
    });
    await storeAgentArtifact({
      artifactId: 'artifact-delete-survivor',
      sessionId: survivor.session.id,
      turnAttemptId: 'attempt-delete-survivor-artifact',
      toolCallId: 'call-delete-survivor',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: 'survivor',
    });
    await db.agentMessages.update('tool-1', { byteLength: -1 });
    await db.agentArtifacts.update('artifact-delete-damaged', { state: 'invalid' as never });

    assert.equal(await deleteAgentSession(damaged.session.id), true);

    assert.equal(await db.agentSessions.get(damaged.session.id), undefined);
    assert.equal(await db.agentMessages.where('sessionId').equals(damaged.session.id).count(), 0);
    assert.equal(await db.agentArtifacts.get('artifact-delete-damaged'), undefined);
    assert.equal(
      await db.agentArtifactChunks.where('artifactId').equals('artifact-delete-damaged').count(),
      0,
    );
    const survivorRecord = (await db.agentSessions.get(survivor.session.id))!;
    assert.ok(survivorRecord);
    assert.ok(await db.agentArtifacts.get('artifact-delete-survivor'));
    const usage = await getAgentStorageUsage();
    assert.equal(usage.sessionCount, 1);
    assert.equal(usage.messageCount, 0);
    assert.equal(usage.artifactCount, 1);
    assert.equal(usage.cacheBytes, 'survivor'.length);
    assert.equal(usage.canonicalBytes, agentSessionLogicalByteLength(survivorRecord));
  });

  it('deletes a referenced artifact even when its session link is damaged', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-delete-corrupt-link' });
    const turnAttemptId = 'attempt-delete-corrupt-link';
    await storeAgentArtifact({
      artifactId: 'artifact-delete-corrupt-link',
      sessionId: created.session.id,
      turnAttemptId,
      toolCallId: 'call-1',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: '{"cached":true}',
    });
    const transition = fullTransition(created.session.id);
    transition.messageDelta = transition.messageDelta.map((message) => (
      message.id === 'tool-1'
        ? { ...message, opaqueReferences: ['artifact-delete-corrupt-link'] }
        : message
    ));
    await commitAgentSessionTransition({ turnAttemptId, transition });
    await db.agentArtifacts.update('artifact-delete-corrupt-link', { sessionId: null as never });

    assert.equal(await deleteAgentSession(created.session.id), true);
    assert.equal(await db.agentArtifacts.get('artifact-delete-corrupt-link'), undefined);
    assert.equal(
      await db.agentArtifactChunks.where('artifactId').equals('artifact-delete-corrupt-link').count(),
      0,
    );
  });

  it('atomically binds a cache artifact to its committed tool-result message', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-artifact-binding' });
    const turnAttemptId = 'attempt-artifact-binding';
    const content = '{"repositories":["owner/repo"]}';
    await storeAgentArtifact({
      artifactId: 'artifact-binding',
      sessionId: created.session.id,
      turnAttemptId,
      toolCallId: 'call-1',
      toolName: 'list_stars',
      storageClass: 'cache',
      expiresAt: 100,
      content,
      now: () => 10,
    });
    const transition = fullTransition(created.session.id);
    transition.messageDelta = transition.messageDelta.map((message) => (
      message.id === 'tool-1'
        ? { ...message, opaqueReferences: ['artifact-binding'] }
        : message
    ));

    await commitAgentSessionTransition({ turnAttemptId, transition, now: () => 20 });

    const artifact = await db.agentArtifacts.get('artifact-binding');
    assert.equal(artifact?.storageClass, 'canonical');
    assert.equal(artifact?.ownerMessageId, 'tool-1');
    assert.equal(artifact?.expiresAt, null);
    const toolRow = await db.agentMessages.get('tool-1');
    assert.deepEqual(toolRow?.artifactIds, ['artifact-binding']);
    const usage = await getAgentStorageUsage();
    assert.equal(usage.cacheArtifactCount, 0);
    assert.equal(usage.canonicalArtifactCount, 1);
    assert.equal(usage.cacheBytes, 0);
    assert.ok(usage.canonicalBytes >= new TextEncoder().encode(content).byteLength);
    const cleanup = await clearAgentToolCache();
    assert.equal(cleanup.deletedArtifacts, 0);
    assert.ok(await db.agentArtifacts.get('artifact-binding'));
  });

  it('rejects malformed canonical data before writing a transition', async () => {
    const bindingSession = await createAgentSession({
      idFactory: () => 'session-invalid-transition-binding',
    });
    const invalidBinding = fullTransition(bindingSession.session.id);
    invalidBinding.binding = { ...invalidBinding.binding!, count: 0 };
    await assert.rejects(
      () => commitAgentSessionTransition({
        turnAttemptId: 'attempt-invalid-binding',
        transition: invalidBinding,
      }),
      /count must be a positive/u,
    );

    const messageSession = await createAgentSession({
      idFactory: () => 'session-invalid-transition-message',
    });
    const invalidMessage = fullTransition(messageSession.session.id);
    invalidMessage.messageDelta = invalidMessage.messageDelta.map((message, index) => (
      index === 0 ? { ...message, id: '' } : message
    ));
    await assert.rejects(
      () => commitAgentSessionTransition({
        turnAttemptId: 'attempt-invalid-message',
        transition: invalidMessage,
      }),
      /message id|canonical message id/iu,
    );

    for (const sessionId of [bindingSession.session.id, messageSession.session.id]) {
      const loaded = await loadAgentSession(sessionId);
      assert.equal(loaded.session.revision, 0);
      assert.deepEqual(loaded.transcript.messages, []);
    }
    assert.equal(await db.agentMessages.count(), 0);
  });

  it.each([
    ['none', false],
    ['all_failed', false],
    ['unsafe', true],
  ] as const)('allows changed outcomes with %s settlement: %s', async (
    writeSettlement,
    accepted,
  ) => {
    const created = await createAgentSession({
      idFactory: () => `session-changed-${writeSettlement}`,
    });
    const commit = () => commitAgentSessionTransition({
      turnAttemptId: `attempt-changed-${writeSettlement}`,
      transition: fullTransition(created.session.id),
      outcome: {
        reason: 'final_answer',
        changed: true,
        changedCount: 1,
        writeSettlement,
      },
    });

    if (accepted) {
      assert.equal((await commit()).outcome.writeSettlement, 'unsafe');
    } else {
      await assert.rejects(commit, /must have an unsafe write settlement/iu);
    }
  });

  it('rejects malformed checkpoint and projection shapes before durable writes', async () => {
    const template = fullTransition('session-invalid-projection-template');
    const invalidTransitions: BgsmAgentSessionTransition[] = [
      {
        ...template,
        candidateCheckpoint: {
          ...checkpoint,
          unexpected: true,
        } as BgsmAgentCompactionCheckpoint,
      },
      {
        ...template,
        candidateCheckpoint: {
          ...checkpoint,
          summary: 'a'.repeat(BGSM_AGENT_SUMMARY_MAX_BYTES + 1),
        },
      },
      {
        ...template,
        candidateCheckpoint: {
          ...checkpoint,
          summarizedMessageCount: Number.NaN,
        },
      },
      {
        ...template,
        candidateActiveProjection: {
          ...projection,
          unexpected: true,
        } as BgsmAgentActiveProjection,
      },
      {
        ...template,
        candidateActiveProjection: {
          ...projection,
          rawMessageCountAtCreation: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        ...template,
        candidateActiveProjection: {
          ...projection,
          summary: 'a'.repeat(BGSM_AGENT_SUMMARY_MAX_BYTES + 1),
        },
      },
    ];

    for (const [index, transition] of invalidTransitions.entries()) {
      const created = await createAgentSession({
        idFactory: () => `session-invalid-projection-${index}`,
      });
      await assert.rejects(
        () => commitAgentSessionTransition({
          turnAttemptId: `attempt-invalid-shape-${index}`,
          transition: { ...transition, sessionId: created.session.id },
        }),
        /unexpected fields|positive safe integer|too large/iu,
      );
      const loaded = await loadAgentSession(created.session.id);
      assert.equal(loaded.session.revision, 0);
      assert.deepEqual(loaded.transcript.messages, []);
    }
    assert.equal(await db.agentMessages.count(), 0);
  });

  it('rejects malformed checkpoint and projection shapes when reloading durable data', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-corrupt-shapes' });
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-corrupt-shapes',
      transition: fullTransition(created.session.id),
    });
    const validRecord = await db.agentSessions.get(created.session.id);
    assert.ok(validRecord);
    const corruptions: Array<{
      patch: Partial<typeof validRecord>;
      expected: RegExp;
    }> = [
      {
        patch: {
          compactionCheckpoint: {
            ...checkpoint,
            unexpected: true,
          } as BgsmAgentCompactionCheckpoint,
        },
        expected: /compaction checkpoint has unexpected fields/i,
      },
      {
        patch: {
          compactionCheckpoint: {
            ...checkpoint,
            summary: 'a'.repeat(BGSM_AGENT_SUMMARY_MAX_BYTES + 1),
          },
        },
        expected: /checkpoint summary is too large/i,
      },
      {
        patch: {
          compactionCheckpoint: {
            ...checkpoint,
            summarizedMessageCount: Number.NaN,
          },
        },
        expected: /checkpoint message count must be a positive safe integer/i,
      },
      {
        patch: {
          activeProjections: [{
            ...projection,
            unexpected: true,
          } as BgsmAgentActiveProjection],
        },
        expected: /active projection has unexpected fields/i,
      },
      {
        patch: {
          activeProjections: [{
            ...projection,
            rawMessageCountAtCreation: Number.NaN,
          }],
        },
        expected: /raw message count must be a positive safe integer/i,
      },
      {
        patch: {
          activeProjections: [{
            ...projection,
            summary: 'a'.repeat(BGSM_AGENT_SUMMARY_MAX_BYTES + 1),
          }],
        },
        expected: /projection summary is too large/i,
      },
    ];

    for (const { patch, expected } of corruptions) {
      await db.agentSessions.put({ ...validRecord, ...patch });
      await assert.rejects(
        () => loadAgentSession(created.session.id),
        (error: unknown) => {
          assert.ok(error instanceof AgentSessionCorruptionError);
          assert.match(error.message, expected);
          return true;
        },
      );
    }

    const catalog = await inspectAgentSessionCatalog();
    assert.deepEqual(catalog.summaries, []);
    assert.equal(catalog.corruptions.length, 1);
  });

  it('lists valid summaries without loading histories and isolates a damaged session', async () => {
    await createAgentSession({ idFactory: () => 'session-valid', now: () => 2 });
    await db.agentSessions.put({
      id: 'session-corrupt',
      schemaVersion: 99 as 1,
      title: '',
      revision: 0,
      lastSequence: 0,
      binding: null,
      compactionCheckpoint: null,
      activeProjections: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const forbiddenReads = [
      vi.spyOn(db.agentAttempts, 'toArray').mockRejectedValue(new Error('catalog read attempts')),
      vi.spyOn(db.agentAttemptRecoveries, 'toArray').mockRejectedValue(new Error('catalog read recoveries')),
      vi.spyOn(db.agentMessages, 'toArray').mockRejectedValue(new Error('catalog read messages')),
      vi.spyOn(db.agentArtifacts, 'toArray').mockRejectedValue(new Error('catalog read artifacts')),
      vi.spyOn(db.agentArtifactChunks, 'toArray').mockRejectedValue(new Error('catalog read chunks')),
    ];
    try {
      const catalog = await inspectAgentSessionCatalog();
      assert.deepEqual(catalog.summaries.map((summary) => summary.id), ['session-valid']);
      assert.equal(catalog.corruptions.length, 1);
    } finally {
      forbiddenReads.forEach((spy) => spy.mockRestore());
    }
    await assert.rejects(() => loadAgentSession('session-corrupt'), AgentSessionCorruptionError);
    assert.equal((await loadAgentSession('session-valid')).session.id, 'session-valid');
    assert.equal(await deleteAgentSession('session-corrupt'), true);
    assert.equal(await db.agentSessions.get('session-corrupt'), undefined);
  });

  it('retains terminal workflow evidence byte-for-byte after deleting origin and current sessions', async () => {
    const origin = await createAgentSession({ idFactory: () => 'session-origin' });
    const owner = await createAgentSession({ idFactory: () => 'session-owner' });
    await commitAgentSessionTransition({
      turnAttemptId: 'attempt-delete',
      transition: fullTransition(origin.session.id),
    });
    const deletionCache = new AgentCanonicalSessionCache();
    await loadCanonicalAgentSession(origin.session.id, deletionCache);
    const activeJob = organizeJob(origin.session.id, owner.session.id);
    await db.organizeJobs.put(activeJob);

    await assert.rejects(
      () => deleteAgentSession(origin.session.id, { now: () => 100, cache: deletionCache }),
      AgentSessionDeletionBlockedError,
    );
    assert.ok(deletionCache.get(origin.session.id, 1));
    await assert.rejects(
      () => deleteAgentSession(owner.session.id, { now: () => 100 }),
      AgentSessionDeletionBlockedError,
    );
    assert.equal(await db.agentMessages.where('sessionId').equals(origin.session.id).count(), messages.length);

    const applyId = 'organize-apply:v1:session-delete';
    const terminalJob = {
      ...activeJob,
      activeSlot: undefined,
      status: 'completed' as const,
      applyId,
      completedAt: 90,
    };
    await db.organizeJobs.put(terminalJob);
    await db.organizeItems.put({
      id: `${terminalJob.jobId}:0`,
      jobId: terminalJob.jobId,
      position: 0,
      fullName: 'owner/repo',
      analysisState: 'unchanged',
      proposedActions: [],
      approvedActions: [],
      proposedAdditions: [],
      sourceFingerprint: 'source:v1:session-delete',
      selected: false,
      retryCount: 0,
      failure: null,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      analyzedAt: 80,
    });
    await db.organizeTaxonomies.put({
      jobId: terminalJob.jobId,
      fingerprint: 'taxonomy:v1:session-delete',
      snapshot: { retained: true },
      createdAt: 1,
    });
    await db.organizeApplies.put({
      applyId,
      jobId: terminalJob.jobId,
      sourceRevision: 1,
      expectedTaxonomyFingerprint: 'taxonomy:v1:session-delete',
      status: 'completed',
      rowCount: 1,
      createdAt: 1,
      updatedAt: 90,
      completedAt: 90,
    });
    await db.organizeApplyRows.put({
      id: `${applyId}:0`,
      applyId,
      jobId: terminalJob.jobId,
      position: 0,
      fullName: 'owner/repo',
      approvedActions: [],
      approvedAdditions: [],
      sourceFingerprint: 'source:v1:session-delete',
      taxonomyFingerprint: 'taxonomy:v1:session-delete',
      state: 'unchanged',
      outcomeReason: null,
      attemptCount: 1,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      settledAt: 90,
    });
    const evidence = await Promise.all([
      db.organizeJobs.get(terminalJob.jobId),
      db.organizeItems.where('jobId').equals(terminalJob.jobId).toArray(),
      db.organizeTaxonomies.get(terminalJob.jobId),
      db.organizeApplies.where('jobId').equals(terminalJob.jobId).toArray(),
      db.organizeApplyRows.where('applyId').equals(applyId).toArray(),
    ]);
    const fullScan = vi.spyOn(db.organizeJobs, 'toArray')
      .mockRejectedValue(new Error('conversation deletion must use organize indexes'));

    assert.equal(await deleteAgentSession(origin.session.id, { now: () => 100, cache: deletionCache }), true);
    assert.equal(await db.agentSessions.get(origin.session.id), undefined);
    assert.equal(await db.agentMessages.where('sessionId').equals(origin.session.id).count(), 0);
    assert.equal(deletionCache.get(origin.session.id, 1), null);
    assert.deepEqual(await Promise.all([
      db.organizeJobs.get(terminalJob.jobId),
      db.organizeItems.where('jobId').equals(terminalJob.jobId).toArray(),
      db.organizeTaxonomies.get(terminalJob.jobId),
      db.organizeApplies.where('jobId').equals(terminalJob.jobId).toArray(),
      db.organizeApplyRows.where('applyId').equals(applyId).toArray(),
    ]), evidence);

    assert.equal(await deleteAgentSession(owner.session.id, { now: () => 100 }), true);
    assert.equal(await db.agentSessions.get(owner.session.id), undefined);
    assert.deepEqual(await Promise.all([
      db.organizeJobs.get(terminalJob.jobId),
      db.organizeItems.where('jobId').equals(terminalJob.jobId).toArray(),
      db.organizeTaxonomies.get(terminalJob.jobId),
      db.organizeApplies.where('jobId').equals(terminalJob.jobId).toArray(),
      db.organizeApplyRows.where('applyId').equals(applyId).toArray(),
    ]), evidence);
    fullScan.mockRestore();
  });

  it('retains a cancelled no-Apply result when its linked conversation is deleted', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-cancelled-result' });
    const cancelled = {
      ...organizeJob(created.session.id, created.session.id),
      activeSlot: undefined,
      status: 'cancelled' as const,
      revision: 2,
      updatedAt: 50,
      cancelledAt: 50,
    };
    await db.organizeJobs.put(cancelled);
    await db.organizeItems.put({
      id: `${cancelled.jobId}:0`,
      jobId: cancelled.jobId,
      position: 0,
      fullName: 'owner/repo',
      analysisState: 'pending',
      proposedActions: [],
      approvedActions: [],
      proposedAdditions: [],
      sourceFingerprint: null,
      selected: false,
      retryCount: 0,
      failure: null,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      analyzedAt: null,
    });
    await db.organizeTaxonomies.put({
      jobId: cancelled.jobId,
      fingerprint: 'taxonomy:v1:cancelled-session-delete',
      snapshot: { retained: true },
      createdAt: 1,
    });
    const evidence = await Promise.all([
      db.organizeJobs.get(cancelled.jobId),
      db.organizeItems.where('jobId').equals(cancelled.jobId).toArray(),
      db.organizeTaxonomies.get(cancelled.jobId),
    ]);

    assert.equal(await deleteAgentSession(created.session.id, { now: () => 100 }), true);
    assert.equal(await db.agentSessions.get(created.session.id), undefined);
    assert.deepEqual(await Promise.all([
      db.organizeJobs.get(cancelled.jobId),
      db.organizeItems.where('jobId').equals(cancelled.jobId).toArray(),
      db.organizeTaxonomies.get(cancelled.jobId),
    ]), evidence);
    assert.equal(await db.organizeApplies.where('jobId').equals(cancelled.jobId).count(), 0);
  });

  for (const status of [
    'preflight_ready',
    'analysis_blocked',
    'paused',
    'review',
    'apply_sealed',
    'applying',
  ] as const) {
    it(`blocks deletion for linked ${status} workflow authority`, async () => {
      const created = await createAgentSession({ idFactory: () => `session-delete-${status}` });
      const job = {
        ...organizeJob(created.session.id, created.session.id),
        status,
        ...(status === 'preflight_ready' ? {
          preflight: {
            token: `preflight:v1:delete-${status}`,
            requestId: `request:delete-${status}`,
            state: 'ready' as const,
            expiresAt: 200,
            consumedAt: null,
          },
        } : {}),
      };
      await db.organizeJobs.put(job);

      await assert.rejects(
        () => deleteAgentSession(created.session.id, { now: () => 100 }),
        AgentSessionDeletionBlockedError,
      );
      assert.ok(await db.agentSessions.get(created.session.id));
      assert.deepEqual(await db.organizeJobs.get(job.jobId), job);
    });
  }

  it('blocks deletion for the current worker turn but ignores a prior worker epoch', async () => {
    const blocked = await createAgentSession({ idFactory: () => 'session-delete-active-turn' });
    const launch = {
      sessionId: blocked.session.id,
      baseRevision: 0,
      turnAttemptId: 'attempt-delete-active-turn',
      prompt: 'Keep this attempt active.',
    };
    await admitAgentSessionTurn({
      ...launch,
      launch,
      launchDigest: await digestAgentSessionLaunch(launch),
      executionEpochId: 'worker-delete-current',
      now: () => 10,
    });
    await assert.rejects(
      () => deleteAgentSession(blocked.session.id, {
        executionEpochId: 'worker-delete-current',
      }),
      AgentSessionTurnActiveError,
    );
    assert.ok(await db.agentSessions.get(blocked.session.id));

    assert.equal(await deleteAgentSession(blocked.session.id, {
      executionEpochId: 'worker-after-restart',
    }), true);
    assert.equal(await db.agentSessions.get(blocked.session.id), undefined);
  });

  it('removes an expired linked preflight and its frozen artifacts with the session', async () => {
    const created = await createAgentSession({ idFactory: () => 'session-expired-preflight' });
    const job = {
      ...organizeJob(created.session.id, created.session.id),
      status: 'preflight_ready' as const,
      preflight: {
        token: 'preflight:v1:expired-session-delete',
        requestId: 'request:expired-session-delete',
        state: 'ready' as const,
        expiresAt: 50,
        consumedAt: null,
      },
    };
    await db.organizeJobs.put(job);
    const staleJob = {
      ...job,
      jobId: 'organize-job:v1:stale-session-delete',
      activeSlot: undefined,
      preflight: {
        token: 'preflight:v1:stale-session-delete',
        requestId: 'request:stale-session-delete',
        state: 'consumed' as const,
        expiresAt: 200,
        consumedAt: 75,
      },
    };
    await db.organizeJobs.put(staleJob);
    await db.organizeItems.put({
      id: `${job.jobId}:0`,
      jobId: job.jobId,
      position: 0,
      fullName: 'owner/repo',
      analysisState: 'pending',
      proposedActions: [],
      approvedActions: [],
      proposedAdditions: [],
      sourceFingerprint: null,
      selected: false,
      retryCount: 0,
      failure: null,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      analyzedAt: null,
    });
    await db.organizeTaxonomies.put({
      jobId: job.jobId,
      fingerprint: 'taxonomy:v1:expired-session-delete',
      snapshot: {},
      createdAt: 1,
    });

    assert.equal(await deleteAgentSession(created.session.id, { now: () => 100 }), true);
    assert.equal(await db.organizeJobs.get(job.jobId), undefined);
    assert.equal(await db.organizeJobs.get(staleJob.jobId), undefined);
    assert.equal(await db.organizeItems.where('jobId').equals(job.jobId).count(), 0);
    assert.equal(await db.organizeTaxonomies.get(job.jobId), undefined);
  });
});

async function commitAgentSessionTransition(
  input: Omit<AgentSessionTransitionCommitInput, 'launchDigest' | 'outcome'>
    & Partial<Pick<AgentSessionTransitionCommitInput, 'launchDigest' | 'outcome'>>,
  cache?: AgentCanonicalSessionCache,
) {
  const prompt = input.transition.messageDelta.find((message) => message.role === 'user')?.content;
  if (!prompt) throw new TypeError('Test transition requires a user prompt.');
  const launch = {
    turnAttemptId: input.turnAttemptId,
    sessionId: input.transition.sessionId,
    baseRevision: input.transition.baseRevision,
    prompt,
    ...(input.transition.binding
      ? { candidateContract: input.transition.binding.candidateContract }
      : {}),
  };
  const launchDigest = input.launchDigest ?? await digestAgentSessionLaunch(launch);
  const admission = await admitAgentSessionTurn({
    sessionId: input.transition.sessionId,
    baseRevision: input.transition.baseRevision,
    turnAttemptId: input.turnAttemptId,
    executionEpochId: `worker-test-${input.turnAttemptId}`,
    launchDigest,
    launch,
    ...(input.now ? { now: input.now } : {}),
  });
  if (admission.kind === 'replay') return admission.commit;
  return commitAgentSessionTransitionDurable({
    ...input,
    launchDigest,
    outcome: input.outcome ?? terminalOutcome,
  }, cache);
}

function fullTransition(sessionId: string): BgsmAgentSessionTransition {
  return {
    sessionId,
    baseRevision: 0,
    messageDelta: messages,
    candidateCheckpoint: checkpoint,
    candidateActiveProjection: projection,
    binding: {
      version: 1,
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
      scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
      label: 'owner/repo',
      count: 1,
      providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
    },
  };
}

function organizeJob(originSessionId: string, ownerSessionId: string): OrganizeJobRecord {
  return {
    jobId: 'organize-job:v1:session-delete',
    activeSlot: 'organize-tags',
    controllerId: 'controller:v1:session-delete',
    sessionId: ownerSessionId,
    originAgentSessionId: originSessionId,
    runId: 'run:v1:session-delete',
    generation: 1,
    proposalId: 'proposal:v1:session-delete',
    frozenScope: {
      kind: 'all_live_stars',
      label: 'All stars',
      filterSnapshot: {},
      repositoryIds: ['owner/repo'],
      capturedAt: 1,
      fingerprint: 'scope:v1:session-delete',
    },
    taskInstruction: 'Organize all repositories.',
    budget: {},
    usage: {},
    nextFrozenIndex: 0,
    providerBinding: null,
    status: 'analyzing',
    revision: 1,
    itemCount: 1,
    applyId: null,
    pauseRequested: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    cancelledAt: null,
  };
}
