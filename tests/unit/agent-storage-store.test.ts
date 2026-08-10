import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  agentArtifactCoverageDirectives,
  createAgentArtifactCoverage,
} from '@/bgsm-agent/artifact-coverage';
import {
  AGENT_ARTIFACT_CHUNK_MAX_BYTES,
  AGENT_ARTIFACT_PAGE_MAX_BYTES,
  AGENT_ARTIFACT_SEARCH_MAX_QUERY_BYTES,
  AGENT_STORAGE_HARD_LIMIT_BYTES,
  AGENT_STORAGE_WARNING_BYTES,
  AgentArtifactConflictError,
  AgentArtifactCorruptionError,
  AgentArtifactAccessDeniedError,
  AgentArtifactNotReadyError,
  AgentArtifactStateConflictError,
  AgentStorageCapacityError,
  agentAttemptLogicalByteLength,
  agentAttemptRecoveryLogicalByteLength,
  agentMessageLogicalByteLength,
  agentSessionLogicalByteLength,
  beginAgentArtifactWrite,
  bindAgentArtifactsToMessages,
  cleanupAgentToolCache,
  clearAgentToolCache,
  finalizeAgentArtifact,
  findAgentArtifactTextForSession,
  getAgentStorageUsage,
  loadAgentArtifactPage,
  loadAgentArtifactSliceForSession,
  markAgentArtifactOrphaned,
  reconcileAgentStorageUsage,
  storeAgentArtifact,
  writeAgentArtifactChunk,
} from '@/storage/agent-storage-store';
import { digestAgentSessionLaunch } from '@/bgsm-agent/session-transport';
import { admitAgentSessionTurn, createAgentSession } from '@/storage/agent-session-store';
import { db } from '@/storage/db';

describe('Agent storage governance', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(async () => {
    await db.close();
  });

  it('declares the v4 stores, indexes, logical thresholds and deterministic message bytes', () => {
    for (const name of ['agentArtifacts', 'agentArtifactChunks', 'agentAttemptRecoveries', 'agentStorageUsage']) {
      assert.equal(db.tables.some((table) => table.name === name), true);
    }
    assert.equal(
      db.agentMessages.schema.indexes.some((index) => index.name === '[sessionId+turnAttemptId]'),
      true,
    );
    assert.equal(
      db.agentAttemptRecoveries.schema.indexes.some(
        (index) => index.name === '[sessionId+turnAttemptId]' && index.unique,
      ),
      true,
    );
    assert.equal(
      db.agentArtifactChunks.schema.indexes.some(
        (index) => index.name === '[artifactId+index]' && index.unique,
      ),
      true,
    );
    assert.equal(AGENT_STORAGE_WARNING_BYTES, 256 * 1024 * 1024);
    assert.equal(AGENT_STORAGE_HARD_LIMIT_BYTES, 512 * 1024 * 1024);
    assert.equal(
      agentMessageLogicalByteLength({ b: 2, a: 1 }),
      agentMessageLogicalByteLength({ a: 1, b: 2 }),
    );
    assert.equal(
      agentAttemptRecoveryLogicalByteLength({ b: 2, a: 1 }),
      agentAttemptRecoveryLogicalByteLength({ a: 1, b: 2 }),
    );
  });

  it('rejects duplicate commit bindings while preserving immutable same-session reuse', async () => {
    const sessionId = 'session-shared-artifact-binding';
    const artifactId = 'artifact-shared-binding';
    const sourceAttemptId = 'attempt-shared-binding';
    const laterAttemptId = 'attempt-later-binding';
    await createAgentSession({ idFactory: () => sessionId, now: () => 1 });
    const owner = messageRow('message-shared-owner', sessionId, 1);
    const reference = messageRow('message-shared-reference', sessionId, 2);
    const conflictingOwner = messageRow('message-shared-conflict', sessionId, 3);
    await db.agentMessages.bulkPut([owner, reference, conflictingOwner]);
    await storeAgentArtifact({
      artifactId,
      sessionId,
      turnAttemptId: sourceAttemptId,
      ownerMessageId: null,
      toolCallId: 'source-call',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: '{"ok":true}',
      expiresAt: 100,
      now: () => 2,
    });

    await assert.rejects(
      () => db.transaction('rw', [db.agentArtifacts, db.agentStorageUsage], () => (
        bindAgentArtifactsToMessages([
          { artifactId, sessionId, turnAttemptId: sourceAttemptId, messageId: owner.id, toolCallId: 'source-call' },
          { artifactId, sessionId, turnAttemptId: sourceAttemptId, messageId: reference.id, toolCallId: 'reader-call' },
        ], 3)
      )),
      AgentArtifactConflictError,
    );
    const unpromoted = await db.agentArtifacts.get(artifactId);
    assert.equal(unpromoted?.storageClass, 'cache');
    assert.equal(unpromoted?.ownerMessageId, null);

    await assert.rejects(
      () => bindAgentArtifactsToMessages([
        { artifactId, sessionId, turnAttemptId: laterAttemptId, messageId: owner.id, toolCallId: 'source-call' },
      ], 4),
      AgentArtifactAccessDeniedError,
    );
    await bindAgentArtifactsToMessages([
      { artifactId, sessionId, turnAttemptId: sourceAttemptId, messageId: owner.id, toolCallId: 'source-call' },
    ], 5);
    await bindAgentArtifactsToMessages([
      { artifactId, sessionId, turnAttemptId: sourceAttemptId, messageId: reference.id, toolCallId: 'reader-call' },
    ], 6);
    await bindAgentArtifactsToMessages([
      { artifactId, sessionId, turnAttemptId: laterAttemptId, messageId: reference.id, toolCallId: 'later-reader-call' },
    ], 7);

    const artifact = await db.agentArtifacts.get(artifactId);
    assert.equal(artifact?.storageClass, 'canonical');
    assert.equal(artifact?.ownerMessageId, owner.id);
    assert.equal(artifact?.toolCallId, 'source-call');
    assert.equal(artifact?.turnAttemptId, sourceAttemptId);
    await assert.rejects(
      () => bindAgentArtifactsToMessages([
        {
          artifactId,
          sessionId,
          turnAttemptId: laterAttemptId,
          messageId: conflictingOwner.id,
          toolCallId: 'source-call',
        },
      ], 8),
      AgentArtifactConflictError,
    );
    assert.equal((await db.agentArtifacts.get(artifactId))?.ownerMessageId, owner.id);
  });

  it('reconciles the singleton ledger from message byte metadata and repairs a missing row', async () => {
    await createAgentSession({ idFactory: () => 'session-usage', now: () => 1 });
    const session = (await db.agentSessions.get('session-usage'))!;
    const sessionBytes = agentSessionLogicalByteLength(session);
    const row = messageRow('message-usage', 'session-usage', 1);
    await db.agentMessages.put(row);
    const reconciled = await reconcileAgentStorageUsage(() => 10);
    assert.equal(reconciled.sessionCount, 1);
    assert.equal(reconciled.messageCount, 1);
    assert.equal(reconciled.canonicalBytes, sessionBytes + row.byteLength);
    assert.equal(reconciled.cacheBytes, 0);
    assert.equal(await db.agentStorageUsage.count(), 1);

    await db.agentStorageUsage.delete('agent');
    const repaired = await getAgentStorageUsage();
    assert.equal(repaired.sessionCount, 1);
    assert.equal(repaired.messageCount, 1);
    assert.equal(repaired.canonicalBytes, sessionBytes + row.byteLength);
    assert.equal(await db.agentStorageUsage.count(), 1);
  });

  it('counts recovery messages as canonical bytes and removes only unambiguous orphans', async () => {
    const sessionId = 'session-recovery-accounting';
    await createAgentSession({ idFactory: () => sessionId, now: () => 1 });
    const launch = {
      sessionId,
      turnAttemptId: 'attempt-recovery-accounting',
      baseRevision: 0,
      prompt: 'Recover this attempt.',
    };
    const launchDigest = await digestAgentSessionLaunch(launch);
    await admitAgentSessionTurn({
      ...launch,
      launch,
      launchDigest,
      executionEpochId: 'worker-recovery-accounting',
      recoveryClass: 'statically_read_only',
      now: () => 2,
    });
    const attempt = (await db.agentAttempts
      .where('[sessionId+turnAttemptId]')
      .equals([sessionId, launch.turnAttemptId])
      .first())!;
    const coverage = await createAgentArtifactCoverage({
      artifactId: 'artifact-recovery-accounting',
      sourceToolCallId: 'call-recovery-accounting',
      expectedBytes: 1,
      artifactSha256: 'a'.repeat(43),
      integrityManifestSha256: 'b'.repeat(43),
    });
    const control = {
      schemaVersion: 1 as const,
      directives: agentArtifactCoverageDirectives([coverage]),
      nonProgressRepromptUsed: false,
      updatedAt: 3,
    };
    await db.agentAttempts.put({
      ...attempt,
      artifactCoverage: [coverage],
      artifactContinuationControl: control,
      updatedAt: 3,
    });
    const recovery = {
      id: attempt.id,
      schemaVersion: 1 as const,
      sessionId,
      turnAttemptId: launch.turnAttemptId,
      projectedMessages: [],
      canonicalRawMessages: [],
      updatedAt: 3,
    };
    await db.agentAttemptRecoveries.put(recovery);
    const orphan = {
      ...recovery,
      id: `aat:v1:${'o'.repeat(43)}`,
      sessionId: 'session-orphan-recovery',
      turnAttemptId: 'attempt-orphan-recovery',
    };
    await db.agentAttemptRecoveries.put(orphan);
    await db.agentStorageUsage.delete('agent');

    const reconciled = await reconcileAgentStorageUsage(() => 4);
    const storedSession = (await db.agentSessions.get(sessionId))!;
    const storedAttempt = (await db.agentAttempts.get(attempt.id))!;
    assert.equal(
      reconciled.canonicalBytes,
      agentSessionLogicalByteLength(storedSession)
        + agentAttemptLogicalByteLength(storedAttempt)
        + agentAttemptRecoveryLogicalByteLength(recovery),
    );
    assert.ok(await db.agentAttemptRecoveries.get(attempt.id));
    assert.equal(await db.agentAttemptRecoveries.get(orphan.id), undefined);
  });

  it('isolates corrupt records while rebuilding usage and removes parentless chunks', async () => {
    await createAgentSession({ idFactory: () => 'session-repair', now: () => 1 });
    const healthyMessage = messageRow('message-healthy', 'session-repair', 1);
    const corruptMessage = messageRow('message-corrupt', 'session-repair', 2);
    (corruptMessage as unknown as Record<string, unknown>).unsupportedValue = 1n;
    await db.agentMessages.bulkPut([healthyMessage, corruptMessage]);
    await readyArtifact('artifact-healthy', 'session-repair', 'healthy', 10);
    await readyArtifact('artifact-corrupt', 'session-repair', 'corrupt', 20);
    await db.agentArtifacts.update('artifact-corrupt', { state: 'invalid' as never });
    await db.agentArtifactChunks.put({
      id: 'artifact-missing:0',
      artifactId: 'artifact-missing',
      index: 0,
      byteLength: 6,
      sha256: await sha256Base64Url('orphan'),
      payload: 'orphan',
    });
    await db.agentStorageUsage.delete('agent');

    const reconciled = await reconcileAgentStorageUsage(() => 30);

    assert.equal(reconciled.sessionCount, 1);
    assert.equal(reconciled.messageCount, 2);
    assert.equal(reconciled.artifactCount, 2);
    assert.equal(reconciled.cacheArtifactCount, 2);
    assert.ok(reconciled.canonicalBytes > healthyMessage.byteLength);
    assert.equal(reconciled.cacheBytes, 'healthy'.length + 'corrupt'.length);
    assert.equal(await db.agentArtifactChunks.get('artifact-missing:0'), undefined);
    assert.ok(await db.agentArtifacts.get('artifact-corrupt'));
  });

  it('resumes pending chunk writes idempotently and exposes content only after finalize', async () => {
    await createAgentSession({ idFactory: () => 'session-pending' });
    const chunks = ['hello ', '世界'];
    const content = chunks.join('');
    const artifact = await beginAgentArtifactWrite({
      ...artifactMetadata('artifact-pending', 'session-pending', 10),
      byteLength: new TextEncoder().encode(content).byteLength,
      chunkCount: chunks.length,
      sha256: await sha256Base64Url(content),
    });
    assert.equal(artifact.state, 'pending');
    assert.equal(artifact.integrity, null);
    await assert.rejects(
      () => loadAgentArtifactPage(artifact.id),
      AgentArtifactNotReadyError,
    );
    for (let index = 0; index < chunks.length; index += 1) {
      await writeAgentArtifactChunk({ artifactId: artifact.id, index, payload: chunks[index]! });
    }
    await writeAgentArtifactChunk({ artifactId: artifact.id, index: 0, payload: chunks[0]! });
    await assert.rejects(
      () => writeAgentArtifactChunk({ artifactId: artifact.id, index: 0, payload: 'different' }),
      AgentArtifactConflictError,
    );
    const finalized = await finalizeAgentArtifact(artifact.id);
    assert.equal(finalized.state, 'ready');
    assert.equal(finalized.integrity?.chunks.length, chunks.length);
    assert.equal((await finalizeAgentArtifact(artifact.id)).state, 'ready');
    assert.equal((await loadAgentArtifactPage(artifact.id)).content, content);

    const replay = await beginAgentArtifactWrite({
      ...artifactMetadata('artifact-pending', 'session-pending', 20),
      byteLength: new TextEncoder().encode(content).byteLength,
      chunkCount: chunks.length,
      sha256: await sha256Base64Url(content),
    });
    assert.equal(replay.state, 'ready');
    assert.equal(await db.agentArtifacts.count(), 1);
  });

  it('rejects incomplete and digest-mismatched pending artifacts without publishing them', async () => {
    await createAgentSession({ idFactory: () => 'session-invalid' });
    const incomplete = await beginAgentArtifactWrite({
      ...artifactMetadata('artifact-incomplete', 'session-invalid', 10),
      byteLength: 2,
      chunkCount: 2,
      sha256: await sha256Base64Url('ab'),
    });
    await writeAgentArtifactChunk({ artifactId: incomplete.id, index: 0, payload: 'a' });
    await assert.rejects(() => finalizeAgentArtifact(incomplete.id), AgentArtifactCorruptionError);

    const wrongDigest = await beginAgentArtifactWrite({
      ...artifactMetadata('artifact-wrong-digest', 'session-invalid', 10),
      byteLength: 1,
      chunkCount: 1,
      sha256: await sha256Base64Url('x'),
    });
    await writeAgentArtifactChunk({ artifactId: wrongDigest.id, index: 0, payload: 'y' });
    await assert.rejects(() => finalizeAgentArtifact(wrongDigest.id), AgentArtifactCorruptionError);
    assert.equal((await db.agentArtifacts.get(wrongDigest.id))?.state, 'pending');
    assert.equal(await markAgentArtifactOrphaned(wrongDigest.id, () => 20), true);
    await assert.rejects(
      () => finalizeAgentArtifact(wrongDigest.id),
      AgentArtifactStateConflictError,
    );
  });

  it('pages a ready artifact below the page budget and reconstructs the exact payload', async () => {
    await createAgentSession({ idFactory: () => 'session-pages' });
    const chunks = [
      'a'.repeat(250_000),
      'b'.repeat(250_000),
      'c'.repeat(250_000),
      'd'.repeat(250_000),
      'e',
    ];
    const content = chunks.join('');
    const artifact = await beginAgentArtifactWrite({
      ...artifactMetadata('artifact-pages', 'session-pages', 10),
      byteLength: content.length,
      chunkCount: chunks.length,
      sha256: await sha256Base64Url(content),
    });
    for (let index = 0; index < chunks.length; index += 1) {
      await writeAgentArtifactChunk({ artifactId: artifact.id, index, payload: chunks[index]! });
    }
    await finalizeAgentArtifact(artifact.id);

    const pages: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await loadAgentArtifactPage(artifact.id, cursor, { now: () => 10 });
      assert.ok(page.byteLength <= AGENT_ARTIFACT_PAGE_MAX_BYTES);
      pages.push(page.content);
      cursor = page.nextChunk;
    }
    assert.equal(pages.length, 2);
    assert.equal(pages.join(''), content);
  });

  it('reads opaque bounded slices only from the owning session', async () => {
    await createAgentSession({ idFactory: () => 'session-slice-owner' });
    await createAgentSession({ idFactory: () => 'session-slice-other' });
    const content = 'alpha\n世界\n'.repeat(300);
    await storeAgentArtifact({
      ...artifactMetadata('artifact-slices', 'session-slice-owner', 10),
      content,
    });

    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await loadAgentArtifactSliceForSession({
        sessionId: 'session-slice-owner',
        artifactId: 'artifact-slices',
        ...(pages.length === 0 ? {} : { cursor }),
        maxContentBytes: 37,
        now: () => 20,
      });
      assert.ok(page.byteLength > 0);
      assert.ok(page.byteLength <= 37);
      assert.equal(page.evidence.readKind, 'page');
      assert.equal(page.evidence.cursorSupplied, pages.length > 0);
      assert.equal(page.evidence.artifactId, page.artifactId);
      assert.equal(page.evidence.artifactBytes, page.totalBytes);
      assert.equal(page.evidence.pageBytes, page.byteLength);
      assert.equal(page.evidence.nextCursor, page.nextCursor);
      assert.equal(page.evidence.integrityVerified, true);
      assert.equal(page.evidence.touchedChunks.length, page.evidence.touchedChunkCount);
      pages.push(page.content);
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.equal(pages.join(''), content);
    await assert.rejects(
      () => loadAgentArtifactSliceForSession({
        sessionId: 'session-slice-other',
        artifactId: 'artifact-slices',
        maxContentBytes: 37,
      }),
      AgentArtifactAccessDeniedError,
    );
    await assert.rejects(
      () => loadAgentArtifactSliceForSession({
        sessionId: 'session-slice-owner',
        artifactId: 'artifact-slices',
        cursor: 'agent-artifact-page:v1:%7B%22artifactId%22%3A%22other%22%2C%22chunkIndex%22%3A0%2C%22characterOffset%22%3A0%7D',
        maxContentBytes: 37,
      }),
      /does not match/u,
    );
  });

  it('supports bounded random access and literal search without weakening session ownership', async () => {
    await createAgentSession({ idFactory: () => 'session-random-owner' });
    await createAgentSession({ idFactory: () => 'session-random-other' });
    const target = 'TARGET-近-end';
    const prefix = 'a'.repeat(AGENT_ARTIFACT_CHUNK_MAX_BYTES - 4);
    const content = `${prefix}跨${target}${'z'.repeat(2_000)}`;
    await storeAgentArtifact({
      ...artifactMetadata('artifact-random', 'session-random-owner', 10),
      content,
    });
    const targetByteOffset = new TextEncoder().encode(`${prefix}跨`).byteLength;

    const searched = await findAgentArtifactTextForSession({
      sessionId: 'session-random-owner',
      artifactId: 'artifact-random',
      query: target,
    });
    assert.equal(searched.matchByteOffset, targetByteOffset);
    assert.equal(searched.evidence.readKind, 'search');
    assert.equal(searched.evidence.pageBytes, 0);
    assert.equal(searched.evidence.nextCursor, null);
    const randomPage = await loadAgentArtifactSliceForSession({
      sessionId: 'session-random-owner',
      artifactId: 'artifact-random',
      byteOffset: targetByteOffset,
      maxContentBytes: 64,
    });
    assert.equal(randomPage.content.startsWith(target), true);
    assert.equal(randomPage.evidence.readKind, 'offset');
    assert.equal(randomPage.evidence.cursorSupplied, false);
    const insideMultibyte = await loadAgentArtifactSliceForSession({
      sessionId: 'session-random-owner',
      artifactId: 'artifact-random',
      byteOffset: targetByteOffset - 1,
      maxContentBytes: 64,
    });
    assert.equal(insideMultibyte.content.startsWith(`跨${target}`), true);
    assert.ok(insideMultibyte.byteLength <= 64);
    assert.ok(randomPage.byteLength <= 64);
    assert.equal((await findAgentArtifactTextForSession({
      sessionId: 'session-random-owner',
      artifactId: 'artifact-random',
      query: target,
      fromByte: targetByteOffset + 1,
    })).matchByteOffset, null);

    assert.equal((await findAgentArtifactTextForSession({
      sessionId: 'session-random-owner',
      artifactId: 'artifact-random',
      query: 'not-present',
    })).matchByteOffset, null);
    await assert.rejects(
      () => loadAgentArtifactSliceForSession({
        sessionId: 'session-random-owner',
        artifactId: 'artifact-random',
        byteOffset: new TextEncoder().encode(content).byteLength + 1,
        maxContentBytes: 64,
      }),
      /outside the payload/u,
    );
    await assert.rejects(
      () => findAgentArtifactTextForSession({
        sessionId: 'session-random-owner',
        artifactId: 'artifact-random',
        query: 'x'.repeat(AGENT_ARTIFACT_SEARCH_MAX_QUERY_BYTES + 1),
      }),
      /search query exceeds/u,
    );
    await assert.rejects(
      () => findAgentArtifactTextForSession({
        sessionId: 'session-random-owner',
        artifactId: 'artifact-random',
        query: target,
        fromByte: new TextEncoder().encode(content).byteLength + 1,
      }),
      /outside the payload/u,
    );
    await assert.rejects(
      () => findAgentArtifactTextForSession({
        sessionId: 'session-random-other',
        artifactId: 'artifact-random',
        query: target,
      }),
      AgentArtifactAccessDeniedError,
    );
  });

  it('does not start artifact search when its signal is already aborted', async () => {
    const sessionId = 'session-search-pre-abort';
    const artifactId = 'artifact-search-pre-abort';
    await createAgentSession({ idFactory: () => sessionId });
    await storeAgentArtifact({
      ...artifactMetadata(artifactId, sessionId, 10),
      content: 'pre-abort-content',
    });

    const controller = new AbortController();
    controller.abort();
    const artifactReads = vi.spyOn(db.agentArtifacts, 'get');
    const chunkReads = vi.spyOn(db.agentArtifactChunks, 'get');
    let returnedEvidence: unknown = null;
    try {
      await assert.rejects(
        async () => {
          const result = await findAgentArtifactTextForSession({
            sessionId,
            artifactId,
            query: 'missing',
            signal: controller.signal,
          });
          returnedEvidence = result.evidence;
        },
        (error: unknown) => (
          !!error
          && typeof error === 'object'
          && 'name' in error
          && error.name === 'AbortError'
        ),
      );
      assert.equal(artifactReads.mock.calls.length, 0);
      assert.equal(chunkReads.mock.calls.length, 0);
      assert.equal(returnedEvidence, null);
    } finally {
      artifactReads.mockRestore();
      chunkReads.mockRestore();
    }
  });

  it('stops a multi-chunk no-match search at its first checked chunk boundary after abort', async () => {
    const sessionId = 'session-search-abort';
    const artifactId = 'artifact-search-abort';
    await createAgentSession({ idFactory: () => sessionId });
    const artifact = await storeAgentArtifact({
      ...artifactMetadata(artifactId, sessionId, 10),
      content: 'a'.repeat(AGENT_ARTIFACT_CHUNK_MAX_BYTES * 3),
    });
    assert.ok(artifact.chunkCount > 1);

    const controller = new AbortController();
    const chunkReads = vi.spyOn(db.agentArtifactChunks, 'get');
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');
    let digestCount = 0;
    let returnedEvidence: unknown = null;
    try {
      digestSpy.mockImplementation(async (algorithm, data) => {
        const digest = await originalDigest(algorithm, data);
        digestCount += 1;
        if (digestCount === 2) controller.abort();
        return digest;
      });

      await assert.rejects(
        async () => {
          const result = await findAgentArtifactTextForSession({
            sessionId,
            artifactId,
            query: 'not-present',
            now: () => 1_000_000,
            signal: controller.signal,
          });
          returnedEvidence = result.evidence;
        },
        (error: unknown) => (
          !!error
          && typeof error === 'object'
          && 'name' in error
          && error.name === 'AbortError'
        ),
      );
      assert.equal(chunkReads.mock.calls.length, 1);
      assert.ok(chunkReads.mock.calls.length < artifact.chunkCount);
      assert.equal((await db.agentArtifacts.get(artifactId))?.lastAccessedAt, artifact.lastAccessedAt);
      assert.equal(returnedEvidence, null);
    } finally {
      digestSpy.mockRestore();
      chunkReads.mockRestore();
    }
  });

  it('does not touch an artifact when search aborts during evidence construction', async () => {
    const sessionId = 'session-search-evidence-abort';
    const artifactId = 'artifact-search-evidence-abort';
    await createAgentSession({ idFactory: () => sessionId });
    const artifact = await storeAgentArtifact({
      ...artifactMetadata(artifactId, sessionId, 10),
      content: 'evidence-abort-content',
    });

    const controller = new AbortController();
    const artifactUpdates = vi.spyOn(db.agentArtifacts, 'update');
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');
    let digestCount = 0;
    let returnedEvidence: unknown = null;
    try {
      digestSpy.mockImplementation(async (algorithm, data) => {
        const digest = await originalDigest(algorithm, data);
        digestCount += 1;
        if (digestCount === 3) controller.abort();
        return digest;
      });

      await assert.rejects(
        async () => {
          const result = await findAgentArtifactTextForSession({
            sessionId,
            artifactId,
            query: 'not-present',
            now: () => 1_000_000,
            signal: controller.signal,
          });
          returnedEvidence = result.evidence;
        },
        (error: unknown) => (
          !!error
          && typeof error === 'object'
          && 'name' in error
          && error.name === 'AbortError'
        ),
      );
      assert.equal(digestCount, 3);
      assert.equal(artifactUpdates.mock.calls.length, 0);
      assert.equal((await db.agentArtifacts.get(artifactId))?.lastAccessedAt, artifact.lastAccessedAt);
      assert.equal(returnedEvidence, null);
    } finally {
      digestSpy.mockRestore();
      artifactUpdates.mockRestore();
    }
  });

  it('rolls back an artifact touch when search aborts during its transaction', async () => {
    const sessionId = 'session-search-touch-abort';
    const artifactId = 'artifact-search-touch-abort';
    await createAgentSession({ idFactory: () => sessionId });
    const artifact = await storeAgentArtifact({
      ...artifactMetadata(artifactId, sessionId, 10),
      content: 'touch-abort-content',
    });

    const controller = new AbortController();
    const originalUpdate = db.agentArtifacts.update.bind(db.agentArtifacts);
    const updateSpy = vi.spyOn(db.agentArtifacts, 'update');
    let returnedEvidence: unknown = null;
    try {
      updateSpy.mockImplementation((...args) => (
        originalUpdate(...args).then((updated) => {
          controller.abort();
          return updated;
        })
      ));

      await assert.rejects(
        async () => {
          const result = await findAgentArtifactTextForSession({
            sessionId,
            artifactId,
            query: 'not-present',
            now: () => 1_000_000,
            signal: controller.signal,
          });
          returnedEvidence = result.evidence;
        },
        (error: unknown) => (
          !!error
          && typeof error === 'object'
          && 'name' in error
          && error.name === 'AbortError'
        ),
      );
      assert.equal(updateSpy.mock.calls.length, 1);
      assert.equal((await db.agentArtifacts.get(artifactId))?.lastAccessedAt, artifact.lastAccessedAt);
      assert.equal(returnedEvidence, null);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it('rejects equal-byte payload and row-digest corruption on both artifact read paths', async () => {
    await createAgentSession({ idFactory: () => 'session-read-corrupt' });
    await storeAgentArtifact({
      ...artifactMetadata('artifact-read-corrupt', 'session-read-corrupt', 10),
      content: 'alpha',
    });
    await db.agentArtifactChunks.update('artifact-read-corrupt:0', {
      payload: 'omega',
      sha256: await sha256Base64Url('omega'),
    });

    await assert.rejects(
      () => loadAgentArtifactPage('artifact-read-corrupt'),
      AgentArtifactCorruptionError,
    );
    await assert.rejects(
      () => loadAgentArtifactSliceForSession({
        sessionId: 'session-read-corrupt',
        artifactId: 'artifact-read-corrupt',
        maxContentBytes: 5,
      }),
      AgentArtifactCorruptionError,
    );
  });

  it('rejects a ready artifact whose finalized integrity manifest was changed', async () => {
    await createAgentSession({ idFactory: () => 'session-manifest-corrupt' });
    await storeAgentArtifact({
      ...artifactMetadata('artifact-manifest-corrupt', 'session-manifest-corrupt', 10),
      content: 'alpha',
    });
    const artifact = (await db.agentArtifacts.get('artifact-manifest-corrupt'))!;
    await db.agentArtifacts.update(artifact.id, {
      integrity: {
        ...artifact.integrity!,
        manifestSha256: 'x'.repeat(43),
      },
    });

    await assert.rejects(
      () => loadAgentArtifactPage(artifact.id),
      AgentArtifactCorruptionError,
    );
  });

  it('does not touch a replacement artifact after a read snapshot is superseded', async () => {
    await createAgentSession({ idFactory: () => 'session-read-replaced' });
    const artifactId = 'artifact-read-replaced';
    await storeAgentArtifact({
      ...artifactMetadata(artifactId, 'session-read-replaced', 10),
      content: 'old',
    });

    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let digestCount = 0;
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');

    try {
      const pagePromise = loadAgentArtifactPage(artifactId, 0, { now: () => 100 });
      // The first digest validates the manifest. The second is the payload
      // digest after the read transaction, which gives the replacement a
      // deterministic window before the LRU touch.
      digestSpy.mockImplementation(async (algorithm, data) => {
        digestCount += 1;
        if (digestCount === 2) {
          await db.transaction('rw', [db.agentArtifacts, db.agentArtifactChunks], async () => {
            await db.agentArtifactChunks.where('artifactId').equals(artifactId).delete();
            await db.agentArtifacts.delete(artifactId);
          });
          await storeAgentArtifact({
            ...artifactMetadata(artifactId, 'session-read-replaced', 101),
            content: 'new',
          });
        }
        return originalDigest(algorithm, data);
      });
      const page = await pagePromise;
      assert.equal(page.content, 'old');
      assert.equal((await db.agentArtifacts.get(artifactId))?.lastAccessedAt, 101);
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('keeps all-at-once writes idempotent and rejects capacity or identity conflicts before rows leak', async () => {
    await createAgentSession({ idFactory: () => 'session-admission' });
    const stored = await storeAgentArtifact({
      ...artifactMetadata('artifact-store', 'session-admission', 10),
      expiresAt: 100,
      content: '{"ok":true}',
    });
    const replay = await storeAgentArtifact({
      ...artifactMetadata('artifact-store', 'session-admission', 20),
      expiresAt: 200,
      content: '{"ok":true}',
    });
    assert.deepEqual(replay, stored);
    assert.equal(replay.expiresAt, 100);
    const pendingContent = '{"pending":true}';
    await beginAgentArtifactWrite({
      ...artifactMetadata('artifact-pending-store', 'session-admission', 20),
      byteLength: new TextEncoder().encode(pendingContent).byteLength,
      chunkCount: 1,
      sha256: await sha256Base64Url(pendingContent),
    });
    await assert.rejects(
      () => storeAgentArtifact({
        ...artifactMetadata('artifact-pending-store', 'session-admission', 30),
        content: pendingContent,
      }),
      AgentArtifactStateConflictError,
    );
    await assert.rejects(
      () => storeAgentArtifact({
        ...artifactMetadata('artifact-store', 'session-admission', 30),
        storageClass: 'canonical',
        content: '{"ok":true}',
      }),
      AgentArtifactConflictError,
    );
    const capacityDigest = await sha256Base64Url('capacity');
    await assert.rejects(
      () => beginAgentArtifactWrite({
        ...artifactMetadata('artifact-capacity', 'session-admission', 30),
        byteLength: AGENT_STORAGE_HARD_LIMIT_BYTES,
        chunkCount: AGENT_STORAGE_HARD_LIMIT_BYTES / AGENT_ARTIFACT_CHUNK_MAX_BYTES,
        sha256: capacityDigest,
      }),
      AgentStorageCapacityError,
    );
    assert.equal(await db.agentArtifacts.count(), 2);
    assert.equal(await db.agentArtifactChunks.where('artifactId').equals('artifact-capacity').count(), 0);
  });

  it('automatically removes orphaned, expired, then oldest LRU cache to reach a target', async () => {
    const now = 10_000;
    await createAgentSession({ idFactory: () => 'session-cleanup' });
    await readyArtifact('cache-old', 'session-cleanup', 'old', 10);
    await readyArtifact('cache-new', 'session-cleanup', 'new', 20);
    await readyArtifact('cache-expired', 'session-cleanup', 'exp', 30, now - 1);
    await readyArtifact('cache-orphan', 'session-cleanup', 'orp', 40);
    await markAgentArtifactOrphaned('cache-orphan', () => 50);
    const before = await getAgentStorageUsage();
    const target = before.totalBytes - 'old'.length - 'exp'.length - 'orp'.length + 1;
    const cleanup = await cleanupAgentToolCache({ targetTotalBytes: target, now: () => now });

    assert.equal(await db.agentArtifacts.get('cache-orphan'), undefined);
    assert.equal(await db.agentArtifacts.get('cache-expired'), undefined);
    assert.equal(await db.agentArtifacts.get('cache-old'), undefined);
    assert.ok(await db.agentArtifacts.get('cache-new'));
    assert.equal(cleanup.deletedArtifacts, 3);
    assert.equal(cleanup.freedBytes, 'old'.length + 'exp'.length + 'orp'.length);
  });

  it('clears only eligible cache and protects canonical, active, referenced and fresh pending data', async () => {
    const now = 10_000;
    for (const sessionId of ['session-idle', 'session-active']) {
      await createAgentSession({ idFactory: () => sessionId, now: () => 1 });
    }
    const activeLaunch = {
      sessionId: 'session-active',
      turnAttemptId: 'attempt-cache-active',
      baseRevision: 0,
      prompt: 'Keep cache available.',
    };
    await admitAgentSessionTurn({
      ...activeLaunch,
      launch: activeLaunch,
      launchDigest: await digestAgentSessionLaunch(activeLaunch),
      executionEpochId: 'worker-active',
      now: () => 2,
    });
    const owner = messageRow('owner-message', 'session-idle', 1);
    await db.agentMessages.put(owner);
    await readyArtifact('artifact-canonical', 'session-idle', 'canonical', 10, null, 'canonical');
    await readyArtifact('cache-active', 'session-active', 'active', 20);
    await readyArtifact('cache-active-old', 'session-active', 'old-active', 25);
    await readyArtifact('cache-referenced', 'session-idle', 'referenced', 30, null, 'cache', owner.id);
    await readyArtifact('cache-delete', 'session-idle', 'delete', 40);
    await beginAgentArtifactWrite({
      ...artifactMetadata('cache-pending', 'session-idle', now - 1),
      byteLength: 1,
      chunkCount: 1,
      sha256: await sha256Base64Url('p'),
    });

    const result = await clearAgentToolCache({ now: () => now });
    assert.equal(await db.agentArtifacts.get('cache-delete'), undefined);
    assert.ok(await db.agentArtifacts.get('artifact-canonical'));
    assert.ok(await db.agentArtifacts.get('cache-active'));
    assert.equal(await db.agentArtifacts.get('cache-active-old'), undefined);
    assert.ok(await db.agentArtifacts.get('cache-referenced'));
    assert.ok(await db.agentArtifacts.get('cache-pending'));
    assert.equal(result.deletedArtifacts, 2);
    assert.equal(result.protectedArtifacts, 3);
    assert.equal(await db.agentArtifactChunks.where('artifactId').equals('cache-delete').count(), 0);
  });

  it('continues clearing eligible cache when one artifact record is corrupt', async () => {
    await createAgentSession({ idFactory: () => 'session-corrupt-cache' });
    await readyArtifact('cache-valid', 'session-corrupt-cache', 'valid', 10);
    await readyArtifact('cache-corrupt', 'session-corrupt-cache', 'corrupt', 20);
    await db.agentArtifacts.update('cache-corrupt', { state: 'invalid' as never });

    const result = await clearAgentToolCache({ now: () => 100 });

    assert.equal(result.deletedArtifacts, 2);
    assert.equal(result.freedBytes, 'valid'.length + 'corrupt'.length);
    assert.equal(await db.agentArtifacts.count(), 0);
    assert.equal(await db.agentArtifactChunks.count(), 0);
    assert.equal(result.usage.artifactCount, 0);
    assert.equal(result.usage.cacheBytes, 0);
  });

  it('accounts an unknown storage class as clearable and removes it from outside the cache index', async () => {
    await createAgentSession({ idFactory: () => 'session-corrupt-class' });
    const sessionBytes = agentSessionLogicalByteLength(
      (await db.agentSessions.get('session-corrupt-class'))!,
    );
    await readyArtifact('cache-corrupt-class', 'session-corrupt-class', 'corrupt-class', 10);
    await db.agentArtifacts.update('cache-corrupt-class', { storageClass: 'invalid' as never });
    await db.agentStorageUsage.delete('agent');

    const repaired = await reconcileAgentStorageUsage(() => 20);
    assert.equal(repaired.canonicalBytes, sessionBytes);
    assert.equal(repaired.cacheBytes, 'corrupt-class'.length);

    const cleared = await clearAgentToolCache({ now: () => 30 });
    assert.equal(cleared.deletedArtifacts, 1);
    assert.equal(await db.agentArtifacts.get('cache-corrupt-class'), undefined);
    assert.equal(cleared.usage.totalBytes, sessionBytes);
  });
});

function artifactMetadata(
  artifactId: string,
  sessionId: string,
  now: number,
) {
  return {
    artifactId,
    sessionId,
    turnAttemptId: `attempt-${artifactId}`,
    ownerMessageId: null,
    toolCallId: `call-${artifactId}`,
    toolName: 'list_stars',
    storageClass: 'cache' as const,
    contentType: 'application/json',
    expiresAt: null,
    now: () => now,
  };
}

function messageRow(id: string, sessionId: string, sequence: number) {
  const row = {
    id,
    schemaVersion: 1 as const,
    sessionId,
    sequence,
    turnAttemptId: `attempt-${id}`,
    role: 'user' as const,
    content: 'hello',
    createdAt: sequence,
    storageClass: 'canonical' as const,
    lastAccessedAt: sequence,
    expiresAt: null,
    byteLength: 0,
  };
  row.byteLength = agentMessageLogicalByteLength(row);
  return row;
}

async function readyArtifact(
  id: string,
  sessionId: string,
  content: string,
  now: number,
  expiresAt: number | null = null,
  storageClass: 'canonical' | 'cache' = 'cache',
  ownerMessageId: string | null = null,
): Promise<void> {
  await storeAgentArtifact({
    ...artifactMetadata(id, sessionId, now),
    ownerMessageId,
    storageClass,
    expiresAt,
    content,
  });
}
