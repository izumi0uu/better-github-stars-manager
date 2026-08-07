import Dexie from 'dexie';
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import { assertAgentTurnTransportIdentifier } from '@/bgsm-agent/session-transport';
import {
  AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION,
  digestAgentArtifactTouchedChunks,
  type AgentArtifactCoverageEvidence,
} from '@/bgsm-agent/artifact-coverage';
import {
  buildArtifactIntegrityManifest,
  requireArtifactIntegrity,
  sameArtifactIntegrity,
  verifyArtifactIntegrityManifest,
  verifyChunkDigests,
} from './agent-artifact-integrity';
import {
  countCodePoints,
  isStringBoundary,
  splitUtf8Chunks,
  takeCodePointSuffix,
  takeUtf8Prefix,
  utf8BoundaryAtOrBefore,
} from './agent-artifact-text';
import {
  AGENT_ARTIFACT_ACCESS_WRITE_INTERVAL_MS,
  AGENT_ARTIFACT_CHUNK_MAX_BYTES,
  AGENT_ARTIFACT_INTEGRITY_SCHEMA_VERSION,
  AGENT_ARTIFACT_MAX_CHUNKS,
  AGENT_ARTIFACT_PAGE_MAX_BYTES,
  AGENT_ARTIFACT_PENDING_STALE_MS,
  AGENT_ARTIFACT_SEARCH_MAX_QUERY_BYTES,
  AGENT_STORAGE_CACHE_HEADROOM_BYTES,
  AGENT_STORAGE_HARD_LIMIT_BYTES,
  AGENT_STORAGE_SCHEMA_VERSION,
  AGENT_STORAGE_USAGE_ID,
  AGENT_STORAGE_WARNING_BYTES,
  AgentArtifactAccessDeniedError,
  AgentArtifactConflictError,
  AgentArtifactCorruptionError,
  AgentArtifactNotFoundError,
  AgentArtifactNotReadyError,
  AgentArtifactStateConflictError,
  AgentStorageCapacityError,
  type AgentArtifactChunkRecord,
  type AgentArtifactMessageBinding,
  type AgentArtifactPage,
  type AgentArtifactRecord,
  type AgentArtifactSlice,
  type AgentStorageClass,
  type AgentStorageCleanupResult,
  type AgentStorageUsageRecord,
  type AgentStorageUsageSnapshot,
  type BeginAgentArtifactWriteInput,
} from './agent-storage-model';
import type { AgentAttemptRecord } from './agent-attempt-model';
import type { AgentAttemptRecoveryRecord } from './agent-attempt-recovery-model';
import { db } from './db';

export * from './agent-storage-model';
export * from './agent-attempt-model';
export * from './agent-attempt-recovery-model';

const AGENT_ARTIFACT_CURSOR_PREFIX = 'agent-artifact-page:v1:';
const AGENT_ARTIFACT_CURSOR_MAX_CHARS = 2_048;
const AGENT_ARTIFACT_TEXT_ENCODER = new TextEncoder();

export async function getAgentStorageUsage(): Promise<AgentStorageUsageSnapshot> {
  const [record, browser] = await Promise.all([
    ensureAgentStorageUsage(),
    estimateBrowserStorage(),
  ]);
  return usageSnapshot(record, browser);
}

/** Rebuilds the logical ledger and removes chunk rows whose parent metadata is gone. */
export async function reconcileAgentStorageUsage(
  now: () => number = Date.now,
): Promise<AgentStorageUsageRecord> {
  const updatedAt = now();
  assertTimestamp(updatedAt, 'Agent storage reconciliation time');
  return db.transaction(
    'rw',
    [
      db.agentStorageUsage,
      db.agentSessions,
      db.agentAttempts,
      db.agentAttemptRecoveries,
      db.agentMessages,
      db.agentArtifacts,
      db.agentArtifactChunks,
    ],
    () => reconcileAgentStorageUsageInCurrentTransaction(updatedAt),
  );
}

/** Caller must include every Agent storage table in its active transaction. */
export async function reconcileAgentStorageUsageInCurrentTransaction(
  updatedAt: number,
): Promise<AgentStorageUsageRecord> {
  assertTimestamp(updatedAt, 'Agent storage reconciliation time');
  const artifacts = await db.agentArtifacts.toArray();
  const attempts = await db.agentAttempts.toArray();
  const recoveries = await db.agentAttemptRecoveries.toArray();
  const orphanRecoveryIds = recoveries.flatMap((recovery) => (
    isUnambiguousOrphanAgentAttemptRecovery(recovery, attempts) ? [recovery.id] : []
  ));
  if (orphanRecoveryIds.length > 0) {
    await db.agentAttemptRecoveries.bulkDelete(orphanRecoveryIds);
  }
  const orphanRecoveryIdSet = new Set(orphanRecoveryIds);
  const artifactIds = new Set(
    artifacts.flatMap((artifact) => (
      typeof artifact?.id === 'string' ? [artifact.id] : []
    )),
  );
  const chunkBytesByArtifact = new Map<string, number>();
  const orphanChunkIds: string[] = [];
  await db.agentArtifactChunks.each((chunk) => {
    const artifactId = typeof chunk?.artifactId === 'string' ? chunk.artifactId : null;
    if (!artifactId || !artifactIds.has(artifactId)) {
      if (typeof chunk?.id === 'string') orphanChunkIds.push(chunk.id);
      return;
    }
    chunkBytesByArtifact.set(
      artifactId,
      addAccountingBytes(
        chunkBytesByArtifact.get(artifactId) ?? 0,
        repairChunkByteLength(chunk),
      ),
    );
  });
  for (let index = 0; index < orphanChunkIds.length; index += 1_000) {
    await db.agentArtifactChunks.bulkDelete(orphanChunkIds.slice(index, index + 1_000));
  }

  let canonicalBytes = 0;
  let cacheBytes = 0;
  let sessionCount = 0;
  let messageCount = 0;
  let canonicalArtifactCount = 0;
  let cacheArtifactCount = 0;
  await db.agentSessions.each((session) => {
    canonicalBytes = addAccountingBytes(
      canonicalBytes,
      repairAgentSessionLogicalByteLength(session as unknown as Record<string, unknown>),
    );
    sessionCount += 1;
  });
  for (const attempt of attempts) {
    canonicalBytes = addAccountingBytes(
      canonicalBytes,
      repairAgentAttemptLogicalByteLength(attempt),
    );
  }
  for (const recovery of recoveries) {
    if (orphanRecoveryIdSet.has(recovery.id)) continue;
    canonicalBytes = addAccountingBytes(
      canonicalBytes,
      repairAgentAttemptRecoveryLogicalByteLength(recovery),
    );
  }
  await db.agentMessages.each((message) => {
    canonicalBytes = addAccountingBytes(
      canonicalBytes,
      repairAgentMessageLogicalByteLength(message as unknown as Record<string, unknown>),
    );
    messageCount += 1;
  });
  for (const artifact of artifacts) {
    const accounting = repairArtifactAccounting(
      artifact,
      typeof artifact?.id === 'string' ? chunkBytesByArtifact.get(artifact.id) : undefined,
    );
    if (accounting.storageClass === 'canonical') {
      canonicalBytes = addAccountingBytes(canonicalBytes, accounting.byteLength);
      canonicalArtifactCount += 1;
    } else {
      cacheBytes = addAccountingBytes(cacheBytes, accounting.byteLength);
      cacheArtifactCount += 1;
    }
  }
  const prior = await db.agentStorageUsage.get(AGENT_STORAGE_USAGE_ID);
  const record: AgentStorageUsageRecord = {
    id: AGENT_STORAGE_USAGE_ID,
    schemaVersion: AGENT_STORAGE_SCHEMA_VERSION,
    canonicalBytes,
    cacheBytes,
    sessionCount,
    messageCount,
    artifactCount: artifacts.length,
    canonicalArtifactCount,
    cacheArtifactCount,
    updatedAt: validUsageRecord(prior) ? Math.max(updatedAt, prior.updatedAt) : updatedAt,
    revision: validUsageRecord(prior) ? prior.revision + 1 : 0,
  };
  await db.agentStorageUsage.put(record);
  return record;
}

export async function ensureAgentStorageUsage(): Promise<AgentStorageUsageRecord> {
  const existing = await db.agentStorageUsage.get(AGENT_STORAGE_USAGE_ID);
  if (validUsageRecord(existing)) return existing;
  return reconcileAgentStorageUsage();
}

/** Must run inside a transaction that includes agentStorageUsage. */
export async function accountAgentSessionCreated(
  record: Readonly<Record<string, unknown>>,
  now: number,
): Promise<void> {
  const byteLength = agentSessionLogicalByteLength(record);
  const usage = await requireUsageRecord();
  assertStorageAdmission(usage, byteLength, 'canonical');
  await putUsage({
    ...usage,
    canonicalBytes: usage.canonicalBytes + byteLength,
    sessionCount: usage.sessionCount + 1,
  }, now);
}

/** Accounts the durable session header in the same transaction as its update. */
export async function accountAgentSessionUpdated(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
  now: number,
): Promise<void> {
  const previousBytes = agentSessionLogicalByteLength(previous);
  const nextBytes = agentSessionLogicalByteLength(next);
  const usage = await requireUsageRecord();
  if (nextBytes > previousBytes) {
    assertStorageAdmission(usage, nextBytes - previousBytes, 'canonical');
  }
  const canonicalBytes = usage.canonicalBytes - previousBytes + nextBytes;
  assertNonnegativeSafeInteger(canonicalBytes, 'Agent canonical storage bytes');
  await putUsage({ ...usage, canonicalBytes }, now);
}

/** Must run inside a transaction that includes agentStorageUsage and agentAttempts. */
export async function accountAgentAttemptCreated(
  record: AgentAttemptRecord,
  now: number,
): Promise<void> {
  const byteLength = agentAttemptLogicalByteLength(record);
  const usage = await requireUsageRecord();
  assertStorageAdmission(usage, byteLength, 'canonical');
  await putUsage({
    ...usage,
    canonicalBytes: usage.canonicalBytes + byteLength,
  }, now);
}

/** Must run inside a transaction that includes agentStorageUsage and agentAttempts. */
export async function accountAgentAttemptUpdated(
  previous: AgentAttemptRecord,
  next: AgentAttemptRecord,
  now: number,
): Promise<void> {
  const previousBytes = agentAttemptLogicalByteLength(previous);
  const nextBytes = agentAttemptLogicalByteLength(next);
  const usage = await requireUsageRecord();
  if (nextBytes > previousBytes) {
    assertStorageAdmission(usage, nextBytes - previousBytes, 'canonical');
  }
  const canonicalBytes = usage.canonicalBytes - previousBytes + nextBytes;
  assertNonnegativeSafeInteger(canonicalBytes, 'Agent canonical storage bytes');
  await putUsage({ ...usage, canonicalBytes }, now);
}

/** Must run inside a transaction that includes agentStorageUsage and agentAttempts. */
export async function accountAgentAttemptDeleted(
  record: AgentAttemptRecord,
  now: number,
): Promise<void> {
  const byteLength = agentAttemptLogicalByteLength(record);
  const usage = await requireUsageRecord();
  const canonicalBytes = usage.canonicalBytes - byteLength;
  assertNonnegativeSafeInteger(canonicalBytes, 'Agent canonical storage bytes');
  await putUsage({ ...usage, canonicalBytes }, now);
}

/** Must run inside a transaction that includes agentStorageUsage and agentAttemptRecoveries. */
export async function accountAgentAttemptRecoveryCreated(
  record: AgentAttemptRecoveryRecord,
  now: number,
): Promise<void> {
  const byteLength = agentAttemptRecoveryLogicalByteLength(record);
  const usage = await requireUsageRecord();
  assertStorageAdmission(usage, byteLength, 'canonical');
  await putUsage({
    ...usage,
    canonicalBytes: usage.canonicalBytes + byteLength,
  }, now);
}

/** Must run inside a transaction that includes agentStorageUsage and agentAttemptRecoveries. */
export async function accountAgentAttemptRecoveryUpdated(
  previous: AgentAttemptRecoveryRecord,
  next: AgentAttemptRecoveryRecord,
  now: number,
): Promise<void> {
  const previousBytes = agentAttemptRecoveryLogicalByteLength(previous);
  const nextBytes = agentAttemptRecoveryLogicalByteLength(next);
  const usage = await requireUsageRecord();
  if (nextBytes > previousBytes) {
    assertStorageAdmission(usage, nextBytes - previousBytes, 'canonical');
  }
  const canonicalBytes = usage.canonicalBytes - previousBytes + nextBytes;
  assertNonnegativeSafeInteger(canonicalBytes, 'Agent canonical storage bytes');
  await putUsage({ ...usage, canonicalBytes }, now);
}

/** Must run inside a transaction that includes agentStorageUsage and agentAttemptRecoveries. */
export async function accountAgentAttemptRecoveryDeleted(
  record: AgentAttemptRecoveryRecord,
  now: number,
): Promise<void> {
  const byteLength = agentAttemptRecoveryLogicalByteLength(record);
  const usage = await requireUsageRecord();
  const canonicalBytes = usage.canonicalBytes - byteLength;
  assertNonnegativeSafeInteger(canonicalBytes, 'Agent canonical storage bytes');
  await putUsage({ ...usage, canonicalBytes }, now);
}

/** Must run inside the same transaction as the canonical message write. */
export async function accountAgentMessagesAdded(
  rows: readonly Readonly<{ byteLength: number }>[],
  now: number,
): Promise<void> {
  if (rows.length === 0) return;
  const delta = sumSafe(rows.map((row) => row.byteLength), 'Agent message bytes');
  const usage = await requireUsageRecord();
  assertStorageAdmission(usage, delta, 'canonical');
  await putUsage({
    ...usage,
    canonicalBytes: usage.canonicalBytes + delta,
    messageCount: usage.messageCount + rows.length,
  }, now);
}

/** Deletes all artifacts for a session. Caller owns the surrounding transaction. */
export async function deleteAgentSessionArtifacts(
  sessionId: string,
  referencedArtifactIds: readonly string[] = [],
): Promise<void> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent artifact session ID');
  const artifacts = await db.agentArtifacts.where('sessionId').equals(sessionId).toArray();
  const artifactIds = new Set(
    artifacts.flatMap((artifact) => (
      typeof artifact?.id === 'string' ? [artifact.id] : []
    )),
  );
  // Canonical tool messages retain a reverse reference. Use it as a fallback
  // when an artifact's sessionId field is damaged, but never cross-delete a
  // valid artifact that belongs to another session.
  for (const artifactId of referencedArtifactIds) {
    if (typeof artifactId !== 'string') continue;
    const artifact = await db.agentArtifacts.get(artifactId);
    if (!artifact) continue;
    if (artifact.sessionId === sessionId || typeof artifact.sessionId !== 'string') {
      artifactIds.add(artifactId);
    }
  }
  for (const artifactId of artifactIds) {
    await db.agentArtifactChunks.where('artifactId').equals(artifactId).delete();
  }
  await db.agentArtifacts.where('sessionId').equals(sessionId).delete();
  for (const artifactId of artifactIds) {
    await db.agentArtifacts.delete(artifactId);
  }
}

/**
 * Reserves logical capacity before a large artifact starts writing. Chunks are
 * immutable and idempotent, so a restarted worker can resume the same pending
 * artifact and publish it only after final validation.
 */
export async function beginAgentArtifactWrite(
  input: BeginAgentArtifactWriteInput,
): Promise<AgentArtifactRecord> {
  validatePendingArtifactInput(input);
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent artifact creation time');
  const artifactId = input.artifactId ?? crypto.randomUUID();
  assertIdentifier(artifactId, 'Agent artifact ID');
  await ensureAgentStorageUsage();

  return db.transaction(
    'rw',
    [db.agentSessions, db.agentMessages, db.agentArtifacts, db.agentStorageUsage],
    async () => {
      const session = await db.agentSessions.get(input.sessionId);
      if (!session) throw new TypeError('Agent artifact session does not exist.');
      const ownerMessageId = input.ownerMessageId ?? null;
      if (ownerMessageId !== null) {
        const owner = await db.agentMessages.get(ownerMessageId);
        if (!owner || owner.sessionId !== input.sessionId) {
          throw new TypeError('Agent artifact owner message does not exist in this session.');
        }
      }
      const expected: AgentArtifactRecord = {
        id: artifactId,
        schemaVersion: AGENT_STORAGE_SCHEMA_VERSION,
        sessionId: input.sessionId,
        turnAttemptId: input.turnAttemptId,
        ownerMessageId,
        toolCallId: input.toolCallId ?? null,
        toolName: input.toolName,
        storageClass: input.storageClass,
        state: 'pending',
        contentType: input.contentType ?? 'application/json',
        encoding: 'utf8',
        sha256: input.sha256,
        integrity: null,
        byteLength: input.byteLength,
        chunkCount: input.chunkCount,
        createdAt: now,
        lastAccessedAt: now,
        expiresAt: input.storageClass === 'cache' ? input.expiresAt ?? null : null,
      };
      validateArtifactRecord(expected);
      const existing = await db.agentArtifacts.get(artifactId);
      if (existing) {
        validateArtifactRecord(existing);
        if (!sameArtifactWrite(existing, expected)) {
          throw new AgentArtifactConflictError(artifactId);
        }
        if (existing.state === 'orphaned') {
          throw new AgentArtifactStateConflictError(existing.id, existing.state);
        }
        return existing;
      }
      const usage = await requireUsageRecord();
      assertStorageAdmission(usage, expected.byteLength, expected.storageClass);
      await db.agentArtifacts.add(expected);
      await putUsage({
        ...usage,
        canonicalBytes: usage.canonicalBytes
          + (expected.storageClass === 'canonical' ? expected.byteLength : 0),
        cacheBytes: usage.cacheBytes
          + (expected.storageClass === 'cache' ? expected.byteLength : 0),
        artifactCount: usage.artifactCount + 1,
        canonicalArtifactCount: usage.canonicalArtifactCount
          + (expected.storageClass === 'canonical' ? 1 : 0),
        cacheArtifactCount: usage.cacheArtifactCount
          + (expected.storageClass === 'cache' ? 1 : 0),
      }, now);
      return expected;
    },
  );
}

export async function writeAgentArtifactChunk(input: Readonly<{
  artifactId: string;
  index: number;
  payload: string;
}>): Promise<AgentArtifactChunkRecord> {
  assertIdentifier(input.artifactId, 'Agent artifact ID');
  assertNonnegativeSafeInteger(input.index, 'Agent artifact chunk index');
  if (typeof input.payload !== 'string' || input.payload.length === 0) {
    throw new TypeError('Agent artifact chunk payload must be nonempty text.');
  }
  const byteLength = new TextEncoder().encode(input.payload).byteLength;
  if (byteLength > AGENT_ARTIFACT_CHUNK_MAX_BYTES) {
    throw new RangeError('Agent artifact chunk exceeds the chunk byte limit.');
  }
  const row: AgentArtifactChunkRecord = {
    id: `${input.artifactId}:${input.index}`,
    artifactId: input.artifactId,
    index: input.index,
    byteLength,
    sha256: await sha256Base64Url(input.payload),
    payload: input.payload,
  };

  return db.transaction('rw', [db.agentArtifacts, db.agentArtifactChunks], async () => {
    const artifact = await db.agentArtifacts.get(input.artifactId);
    if (!artifact) throw new AgentArtifactNotFoundError(input.artifactId);
    validateArtifactRecord(artifact);
    if (artifact.state !== 'pending') {
      throw new AgentArtifactStateConflictError(artifact.id, artifact.state);
    }
    if (input.index >= artifact.chunkCount) {
      throw new RangeError('Agent artifact chunk index exceeds the declared chunk count.');
    }
    const existing = await db.agentArtifactChunks.get(row.id);
    if (existing) {
      validateChunkRecord(existing, artifact.id, input.index);
      if (existing.payload !== row.payload) throw new AgentArtifactConflictError(artifact.id);
      if (existing.sha256 !== row.sha256) {
        throw new AgentArtifactCorruptionError(artifact.id, 'existing chunk digest does not match its payload');
      }
      return existing;
    }
    const priorByteLengths: number[] = [];
    await db.agentArtifactChunks.where('artifactId').equals(artifact.id).each((chunk) => {
      priorByteLengths.push(chunk.byteLength);
    });
    const writtenBytes = sumSafe(
      [...priorByteLengths, row.byteLength],
      'Agent artifact chunk bytes',
    );
    if (writtenBytes > artifact.byteLength) {
      throw new RangeError('Agent artifact chunks exceed the declared byte length.');
    }
    await db.agentArtifactChunks.add(row);
    return row;
  });
}

export async function finalizeAgentArtifact(
  artifactId: string,
  now: () => number = Date.now,
): Promise<AgentArtifactRecord> {
  assertIdentifier(artifactId, 'Agent artifact ID');
  const snapshot = await db.transaction(
    'r',
    [db.agentArtifacts, db.agentArtifactChunks],
    async () => {
      const artifact = await db.agentArtifacts.get(artifactId);
      if (!artifact) throw new AgentArtifactNotFoundError(artifactId);
      validateArtifactRecord(artifact);
      if (artifact.state === 'ready') return { artifact, chunks: null };
      if (artifact.state !== 'pending') {
        throw new AgentArtifactStateConflictError(artifact.id, artifact.state);
      }
      const chunks = await loadCompleteArtifactChunks(artifact);
      return { artifact, chunks };
    },
  );
  if (snapshot.chunks === null) {
    await verifyArtifactIntegrityManifest(snapshot.artifact);
    return snapshot.artifact;
  }
  await verifyChunkDigests(artifactId, snapshot.chunks);
  const content = snapshot.chunks.map((chunk) => chunk.payload).join('');
  if (await sha256Base64Url(content) !== snapshot.artifact.sha256) {
    throw new AgentArtifactCorruptionError(artifactId, 'payload digest does not match metadata');
  }
  const integrity = await buildArtifactIntegrityManifest(snapshot.chunks);

  const ready = await db.transaction('rw', [db.agentArtifacts, db.agentArtifactChunks], async () => {
    const artifact = await db.agentArtifacts.get(artifactId);
    if (!artifact) throw new AgentArtifactNotFoundError(artifactId);
    validateArtifactRecord(artifact);
    if (artifact.state === 'ready') return artifact;
    if (artifact.state !== 'pending') {
      throw new AgentArtifactStateConflictError(artifact.id, artifact.state);
    }
    const chunks = await loadCompleteArtifactChunks(artifact);
    if (
      chunks.length !== snapshot.chunks!.length
      || chunks.some((chunk, index) => (
        chunk.payload !== snapshot.chunks![index]?.payload
        || chunk.sha256 !== snapshot.chunks![index]?.sha256
      ))
    ) {
      throw new AgentArtifactConflictError(artifactId);
    }
    const finalizedAt = now();
    assertTimestamp(finalizedAt, 'Agent artifact finalization time');
    const readyArtifact: AgentArtifactRecord = {
      ...artifact,
      state: 'ready',
      integrity,
      lastAccessedAt: Math.max(artifact.lastAccessedAt, finalizedAt),
    };
    await db.agentArtifacts.put(readyArtifact);
    return readyArtifact;
  });
  await verifyArtifactIntegrityManifest(ready);
  return ready;
}

export async function storeAgentArtifact(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  ownerMessageId?: string | null;
  toolCallId?: string | null;
  toolName: string;
  storageClass: AgentStorageClass;
  content: string;
  contentType?: string;
  expiresAt?: number | null;
  artifactId?: string;
  now?: () => number;
}>): Promise<AgentArtifactRecord> {
  validateArtifactInput(input);
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent artifact creation time');
  const byteLength = new TextEncoder().encode(input.content).byteLength;
  if (byteLength > AGENT_STORAGE_HARD_LIMIT_BYTES) {
    throw new AgentStorageCapacityError(byteLength, 0);
  }
  const chunks = splitUtf8Chunks(input.content, AGENT_ARTIFACT_CHUNK_MAX_BYTES);
  if (sumSafe(chunks.map((chunk) => chunk.byteLength), 'Agent artifact bytes') !== byteLength) {
    throw new TypeError('Agent artifact chunking changed the payload byte length.');
  }
  const artifactId = input.artifactId ?? crypto.randomUUID();
  assertIdentifier(artifactId, 'Agent artifact ID');
  const sha256 = await sha256Base64Url(input.content);
  // Web Crypto is not an IndexedDB request. Awaiting it inside a Dexie
  // transaction can let the browser auto-commit before the following writes.
  const chunkRows: AgentArtifactChunkRecord[] = await Promise.all(
    chunks.map(async (chunk, index) => ({
      id: `${artifactId}:${index}`,
      artifactId,
      index,
      byteLength: chunk.byteLength,
      sha256: await sha256Base64Url(chunk.payload),
      payload: chunk.payload,
    })),
  );
  const integrity = await buildArtifactIntegrityManifest(chunkRows);
  await ensureAgentStorageUsage();

  return db.transaction(
    'rw',
    [
      db.agentSessions,
      db.agentMessages,
      db.agentArtifacts,
      db.agentArtifactChunks,
      db.agentStorageUsage,
    ],
    async () => {
      const session = await db.agentSessions.get(input.sessionId);
      if (!session) throw new TypeError('Agent artifact session does not exist.');
      const existing = await db.agentArtifacts.get(artifactId);
      if (existing) {
        validateArtifactRecord(existing);
        if (
          existing.sessionId === input.sessionId
          && existing.turnAttemptId === input.turnAttemptId
          && existing.ownerMessageId === (input.ownerMessageId ?? null)
          && existing.toolCallId === (input.toolCallId ?? null)
          && existing.toolName === input.toolName
          && existing.storageClass === input.storageClass
          && existing.contentType === (input.contentType ?? 'application/json')
          && existing.sha256 === sha256
          && existing.byteLength === byteLength
        ) {
          if (existing.state !== 'ready') {
            throw new AgentArtifactStateConflictError(existing.id, existing.state);
          }
          if (!sameArtifactIntegrity(existing.integrity, integrity)) {
            throw new AgentArtifactConflictError(artifactId);
          }
          return existing;
        }
        throw new AgentArtifactConflictError(artifactId);
      }
      const ownerMessageId = input.ownerMessageId ?? null;
      if (ownerMessageId !== null) {
        const owner = await db.agentMessages.get(ownerMessageId);
        if (!owner || owner.sessionId !== input.sessionId) {
          throw new TypeError('Agent artifact owner message does not exist in this session.');
        }
      }
      const usage = await requireUsageRecord();
      assertStorageAdmission(usage, byteLength, input.storageClass);
      const record: AgentArtifactRecord = {
        id: artifactId,
        schemaVersion: AGENT_STORAGE_SCHEMA_VERSION,
        sessionId: input.sessionId,
        turnAttemptId: input.turnAttemptId,
        ownerMessageId,
        toolCallId: input.toolCallId ?? null,
        toolName: input.toolName,
        storageClass: input.storageClass,
        state: 'ready',
        contentType: input.contentType ?? 'application/json',
        encoding: 'utf8',
        sha256,
        integrity,
        byteLength,
        chunkCount: chunks.length,
        createdAt: now,
        lastAccessedAt: now,
        expiresAt: input.storageClass === 'cache' ? input.expiresAt ?? null : null,
      };
      validateArtifactRecord(record);
      if (chunkRows.length > 0) await db.agentArtifactChunks.bulkAdd(chunkRows);
      await db.agentArtifacts.add(record);
      await putUsage({
        ...usage,
        canonicalBytes: usage.canonicalBytes
          + (input.storageClass === 'canonical' ? byteLength : 0),
        cacheBytes: usage.cacheBytes + (input.storageClass === 'cache' ? byteLength : 0),
        artifactCount: usage.artifactCount + 1,
        canonicalArtifactCount: usage.canonicalArtifactCount
          + (input.storageClass === 'canonical' ? 1 : 0),
        cacheArtifactCount: usage.cacheArtifactCount
          + (input.storageClass === 'cache' ? 1 : 0),
      }, now);
      return record;
    },
  );
}

export async function loadAgentArtifactPage(
  artifactId: string,
  startChunk = 0,
  options: Readonly<{ now?: () => number }> = {},
): Promise<AgentArtifactPage> {
  assertIdentifier(artifactId, 'Agent artifact ID');
  assertNonnegativeSafeInteger(startChunk, 'Agent artifact cursor');
  const snapshot = await loadVerifiedReadyArtifact(artifactId);
  if (startChunk >= snapshot.chunkCount && !(startChunk === 0 && snapshot.chunkCount === 0)) {
    throw new RangeError('Agent artifact cursor is outside the payload.');
  }
  const endChunk = artifactPageEndChunk(snapshot, startChunk, AGENT_ARTIFACT_PAGE_MAX_BYTES);
  const result = await db.transaction(
    'r',
    [db.agentArtifacts, db.agentArtifactChunks],
    async () => {
      const artifact = await db.agentArtifacts.get(artifactId);
      if (!artifact) throw new AgentArtifactNotFoundError(artifactId);
      assertSameReadyArtifactSnapshot(artifact, snapshot);
      const rows = startChunk === endChunk
        ? []
        : await db.agentArtifactChunks
            .where('[artifactId+index]')
            .between([artifactId, startChunk], [artifactId, endChunk], true, false)
            .toArray();
      if (rows.length !== endChunk - startChunk) {
        throw new AgentArtifactCorruptionError(artifactId, 'payload chunks are missing');
      }
      rows.forEach((row, index) => {
        validateReadyChunkRecord(artifact, row, startChunk + index);
      });
      const bytes = sumSafe(rows.map((row) => row.byteLength), 'Agent artifact page bytes');
      return {
        artifact,
        chunks: rows,
        page: {
          artifactId,
          content: rows.map((row) => row.payload).join(''),
          contentType: artifact.contentType,
          byteLength: bytes,
          totalBytes: artifact.byteLength,
          nextChunk: endChunk < artifact.chunkCount ? endChunk : null,
        } satisfies AgentArtifactPage,
      };
    },
  );
  await verifyChunkDigests(artifactId, result.chunks);
  const now = (options.now ?? Date.now)();
  await touchAgentArtifactIfCurrent(artifactId, result.artifact, now);
  return result.page;
}

/**
 * Reads a bounded UTF-8 slice for a model tool. The cursor is opaque and bound
 * to the artifact ID; session ownership is checked before any payload leaves
 * IndexedDB.
 */
export async function loadAgentArtifactSliceForSession(input: Readonly<{
  sessionId: string;
  artifactId: string;
  cursor?: string | null;
  byteOffset?: number;
  maxContentBytes: number;
  now?: () => number;
}>): Promise<AgentArtifactSlice> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent artifact session ID');
  assertIdentifier(input.artifactId, 'Agent artifact ID');
  assertPositiveSafeInteger(input.maxContentBytes, 'Agent artifact page bytes');
  if (input.maxContentBytes > AGENT_ARTIFACT_PAGE_MAX_BYTES) {
    throw new RangeError('Agent artifact page exceeds the storage read limit.');
  }
  const cursorSupplied = Object.prototype.hasOwnProperty.call(input, 'cursor');
  const hasCursor = input.cursor !== undefined && input.cursor !== null;
  if (hasCursor && input.byteOffset !== undefined) {
    throw new TypeError('Agent artifact cursor and byte offset are mutually exclusive.');
  }
  if (input.byteOffset !== undefined) {
    assertNonnegativeSafeInteger(input.byteOffset, 'Agent artifact byte offset');
  }
  const snapshot = await loadVerifiedReadyArtifact(input.artifactId, input.sessionId);
  // Byte offsets may land inside a multi-byte code point. Resume from the
  // preceding complete UTF-8 boundary so returned text is always valid.
  const position = hasCursor
    ? decodeArtifactCursor(input.cursor!, input.artifactId)
    : input.byteOffset !== undefined
      ? await resolveArtifactBytePosition(snapshot, input.byteOffset)
      : { chunkIndex: 0, characterOffset: 0 };
  if (
    position.chunkIndex > snapshot.chunkCount
    || (position.chunkIndex === snapshot.chunkCount && position.characterOffset !== 0)
  ) throw new RangeError('Agent artifact cursor is outside the payload.');
  const result = await db.transaction(
    'r',
    [db.agentArtifacts, db.agentArtifactChunks],
    async () => {
      const artifact = await db.agentArtifacts.get(input.artifactId);
      if (!artifact) throw new AgentArtifactNotFoundError(input.artifactId);
      assertSameReadyArtifactSnapshot(artifact, snapshot);
      if (artifact.chunkCount === 0 || position.chunkIndex === artifact.chunkCount) {
        return {
          artifact,
          chunks: [] as AgentArtifactChunkRecord[],
          page: {
            artifactId: artifact.id,
            content: '',
            contentType: artifact.contentType,
            byteLength: 0,
            totalBytes: artifact.byteLength,
            nextCursor: null,
          } satisfies Omit<AgentArtifactSlice, 'evidence'>,
        };
      }

      let chunkIndex = position.chunkIndex;
      let characterOffset = position.characterOffset;
      let remainingBytes = input.maxContentBytes;
      let selectedBytes = 0;
      const selected: string[] = [];
      const touchedChunks: AgentArtifactChunkRecord[] = [];
      const consume = (row: AgentArtifactChunkRecord) => {
        validateReadyChunkRecord(artifact, row, chunkIndex);
        touchedChunks.push(row);
        if (!isStringBoundary(row.payload, characterOffset)) {
          throw new RangeError('Agent artifact cursor does not identify a text boundary.');
        }
        const available = row.payload.slice(characterOffset);
        const prefix = takeUtf8Prefix(available, remainingBytes);
        if (prefix.byteLength === 0 && available.length > 0) {
          throw new RangeError('Agent artifact page budget cannot contain one character.');
        }
        selected.push(prefix.value);
        selectedBytes += prefix.byteLength;
        remainingBytes -= prefix.byteLength;
        characterOffset += prefix.characterLength;
        if (characterOffset < row.payload.length) return;
        chunkIndex += 1;
        characterOffset = 0;
      };

      const first = await db.agentArtifactChunks.get(`${artifact.id}:${chunkIndex}`);
      if (!first) {
        throw new AgentArtifactCorruptionError(artifact.id, 'payload chunks are missing');
      }
      consume(first);

      if (remainingBytes > 0 && characterOffset === 0 && chunkIndex < artifact.chunkCount) {
        const endChunk = artifactPageEndChunk(artifact, chunkIndex, remainingBytes);
        const rows = await db.agentArtifactChunks
          .where('[artifactId+index]')
          .between([artifact.id, chunkIndex], [artifact.id, endChunk], true, false)
          .toArray();
        if (rows.length !== endChunk - chunkIndex) {
          throw new AgentArtifactCorruptionError(artifact.id, 'payload chunks are missing');
        }
        for (const row of rows) {
          consume(row);
          if (remainingBytes === 0 || characterOffset > 0) break;
        }
      }
      if (selectedBytes === 0 && artifact.byteLength > 0) {
        throw new RangeError('Agent artifact page budget cannot contain one character.');
      }
      const done = chunkIndex >= artifact.chunkCount;
      return {
        artifact,
        chunks: touchedChunks,
        page: {
          artifactId: artifact.id,
          content: selected.join(''),
          contentType: artifact.contentType,
          byteLength: selectedBytes,
          totalBytes: artifact.byteLength,
          nextCursor: done
            ? null
            : encodeArtifactCursor(artifact.id, chunkIndex, characterOffset),
        } satisfies Omit<AgentArtifactSlice, 'evidence'>,
      };
    },
  );
  await verifyChunkDigests(input.artifactId, result.chunks);
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent artifact access time');
  await touchAgentArtifactIfCurrent(input.artifactId, result.artifact, now);
  return {
    ...result.page,
    evidence: await createAgentArtifactCoverageEvidence({
      artifact: result.artifact,
      readKind: input.byteOffset === undefined ? 'page' : 'offset',
      cursorSupplied,
      inputCursor: hasCursor ? input.cursor! : null,
      pageBytes: result.page.byteLength,
      nextCursor: result.page.nextCursor,
      chunks: result.chunks,
    }),
  };
}

export type AgentArtifactSearchResult = Readonly<{
  artifactId: string;
  contentType: string;
  totalBytes: number;
  matchByteOffset: number | null;
  evidence: AgentArtifactCoverageEvidence;
}>;

/** Finds an exact literal without materializing the complete artifact in memory. */
export async function findAgentArtifactTextForSession(input: Readonly<{
  sessionId: string;
  artifactId: string;
  query: string;
  fromByte?: number;
  now?: () => number;
}>): Promise<AgentArtifactSearchResult> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent artifact session ID');
  assertIdentifier(input.artifactId, 'Agent artifact ID');
  if (typeof input.query !== 'string' || input.query.length === 0) {
    throw new TypeError('Agent artifact search query must be nonempty.');
  }
  const queryBytes = AGENT_ARTIFACT_TEXT_ENCODER.encode(input.query).byteLength;
  if (queryBytes > AGENT_ARTIFACT_SEARCH_MAX_QUERY_BYTES) {
    throw new RangeError('Agent artifact search query exceeds the storage limit.');
  }
  const fromByte = input.fromByte ?? 0;
  assertNonnegativeSafeInteger(fromByte, 'Agent artifact search offset');
  const snapshot = await loadVerifiedReadyArtifact(input.artifactId, input.sessionId);
  if (fromByte > snapshot.byteLength) {
    throw new RangeError('Agent artifact search offset is outside the payload.');
  }
  const position = await resolveArtifactBytePosition(snapshot, fromByte);
  let chunkIndex = position.chunkIndex;
  let characterOffset = position.characterOffset;
  let chunkStartByte = position.chunkStartByte;
  // Retain only enough code points to detect a literal spanning two chunks;
  // the complete artifact is never assembled in memory.
  let overlap = '';
  let overlapStartByte = position.byteOffset;
  const overlapCharacters = Math.max(0, countCodePoints(input.query) - 1);
  let matchByteOffset: number | null = null;
  const touchedChunks: AgentArtifactChunkRecord[] = [];

  while (chunkIndex < snapshot.chunkCount) {
    const row = await loadCheckedArtifactChunk(snapshot, chunkIndex);
    touchedChunks.push(row);
    const skipped = row.payload.slice(0, characterOffset);
    const segment = row.payload.slice(characterOffset);
    const skippedBytes = AGENT_ARTIFACT_TEXT_ENCODER.encode(skipped).byteLength;
    const segmentStartByte = chunkStartByte + skippedBytes;
    const combined = overlap + segment;
    const combinedStartByte = overlap ? overlapStartByte : segmentStartByte;
    let matchIndex = combined.indexOf(input.query);
    while (matchIndex >= 0) {
      const candidate = combinedStartByte
        + AGENT_ARTIFACT_TEXT_ENCODER.encode(combined.slice(0, matchIndex)).byteLength;
      if (candidate >= fromByte) {
        matchByteOffset = candidate;
        break;
      }
      matchIndex = combined.indexOf(input.query, matchIndex + 1);
    }
    if (matchByteOffset !== null) break;

    const combinedBytes = AGENT_ARTIFACT_TEXT_ENCODER.encode(overlap).byteLength
      + row.byteLength - skippedBytes;
    overlap = takeCodePointSuffix(combined, overlapCharacters);
    const overlapBytes = AGENT_ARTIFACT_TEXT_ENCODER.encode(overlap).byteLength;
    overlapStartByte = combinedStartByte + combinedBytes - overlapBytes;
    chunkStartByte += row.byteLength;
    chunkIndex += 1;
    characterOffset = 0;
  }

  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent artifact access time');
  await touchAgentArtifactIfCurrent(input.artifactId, snapshot, now);
  return {
    artifactId: snapshot.id,
    contentType: snapshot.contentType,
    totalBytes: snapshot.byteLength,
    matchByteOffset,
    evidence: await createAgentArtifactCoverageEvidence({
      artifact: snapshot,
      readKind: 'search',
      cursorSupplied: false,
      inputCursor: null,
      pageBytes: 0,
      nextCursor: null,
      chunks: touchedChunks,
    }),
  };
}

async function createAgentArtifactCoverageEvidence(input: Readonly<{
  artifact: AgentArtifactRecord;
  readKind: AgentArtifactCoverageEvidence['readKind'];
  cursorSupplied: boolean;
  inputCursor: string | null;
  pageBytes: number;
  nextCursor: string | null;
  chunks: readonly AgentArtifactChunkRecord[];
}>): Promise<AgentArtifactCoverageEvidence> {
  const integrity = requireArtifactIntegrity(input.artifact);
  const touchedChunks = input.chunks.map((chunk) => ({
    index: chunk.index,
    byteLength: chunk.byteLength,
    sha256: chunk.sha256,
  }));
  return {
    schemaVersion: AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION,
    artifactId: input.artifact.id,
    artifactBytes: input.artifact.byteLength,
    artifactSha256: input.artifact.sha256,
    integrityManifestSha256: integrity.manifestSha256,
    readKind: input.readKind,
    cursorSupplied: input.cursorSupplied,
    inputCursor: input.inputCursor,
    pageBytes: input.pageBytes,
    nextCursor: input.nextCursor,
    touchedChunks,
    touchedChunkCount: touchedChunks.length,
    touchedChunkBytes: sumSafe(
      touchedChunks.map((chunk) => chunk.byteLength),
      'Agent artifact touched chunk bytes',
    ),
    touchedChunkDigest: await digestAgentArtifactTouchedChunks(touchedChunks),
    integrityVerified: true,
  };
}
/** Revalidates one coverage start against immutable artifact metadata. */
export async function validateAgentArtifactCoverageStartInCurrentTransaction(input: Readonly<{
  record: AgentAttemptRecord['artifactCoverage'][number];
  sessionId: string;
  turnAttemptId: string;
}>): Promise<void> {
  const artifact = await db.agentArtifacts.get(input.record.artifactId);
  if (!artifact) throw new AgentArtifactNotFoundError(input.record.artifactId);
  validateArtifactRecord(artifact);
  if (artifact.sessionId !== input.sessionId) {
    throw new AgentArtifactAccessDeniedError(artifact.id, input.sessionId);
  }
  if (artifact.state !== 'ready') throw new AgentArtifactStateConflictError(artifact.id, artifact.state);
  const integrity = requireArtifactIntegrity(artifact);
  await Dexie.waitFor(verifyArtifactIntegrityManifest(artifact));
  if (
    artifact.byteLength !== input.record.expectedBytes
    || artifact.sha256 !== input.record.artifactSha256
    || integrity.manifestSha256 !== input.record.integrityManifestSha256
  ) throw new AgentArtifactConflictError(artifact.id);
  if (artifact.storageClass === 'cache') {
    if (
      artifact.turnAttemptId !== input.turnAttemptId
      || artifact.toolCallId !== input.record.sourceToolCallId
      || artifact.ownerMessageId !== null
    ) throw new AgentArtifactAccessDeniedError(artifact.id, input.sessionId);
  } else if (artifact.ownerMessageId === null) {
    throw new AgentArtifactConflictError(artifact.id);
  }
}

/**
 * Revalidates bounded evidence against the current manifest and touched chunk
 * rows. Payload bytes were already verified by the read and are not rehashed.
 */
export async function validateAgentArtifactCoverageEvidenceInCurrentTransaction(input: Readonly<{
  record: AgentAttemptRecord['artifactCoverage'][number];
  evidence: AgentArtifactCoverageEvidence;
  sessionId: string;
  turnAttemptId: string;
}>): Promise<void> {
  await validateAgentArtifactCoverageStartInCurrentTransaction(input);
  const artifact = await db.agentArtifacts.get(input.record.artifactId);
  if (!artifact) throw new AgentArtifactNotFoundError(input.record.artifactId);
  const manifest = requireArtifactIntegrity(artifact);
  for (const touched of input.evidence.touchedChunks) {
    const expected = manifest.chunks[touched.index];
    const row = await db.agentArtifactChunks.get(`${artifact.id}:${touched.index}`);
    if (
      !expected
      || expected.byteLength !== touched.byteLength
      || expected.sha256 !== touched.sha256
      || !row
      || row.artifactId !== artifact.id
      || row.index !== touched.index
      || row.byteLength !== touched.byteLength
      || row.sha256 !== touched.sha256
    ) throw new AgentArtifactCorruptionError(artifact.id, 'coverage evidence does not match touched chunks');
  }
}

/** Promotes newly owned cache artifacts and validates later canonical references. */
export async function bindAgentArtifactsToMessages(
  bindings: readonly AgentArtifactMessageBinding[],
  now: number,
): Promise<void> {
  if (bindings.length === 0) return;
  assertTimestamp(now, 'Agent artifact binding time');
  const seen = new Set<string>();
  const usage = await requireUsageRecord();
  let promotedBytes = 0;
  let promotedCount = 0;
  for (const binding of bindings) {
    assertIdentifier(binding.artifactId, 'Agent artifact ID');
    assertAgentTurnTransportIdentifier(binding.sessionId, 'Agent artifact session ID');
    assertAgentTurnTransportIdentifier(binding.turnAttemptId, 'Agent artifact turn attempt ID');
    assertIdentifier(binding.messageId, 'Agent artifact owner message');
    assertIdentifier(binding.toolCallId, 'Agent artifact tool call');
    if (seen.has(binding.artifactId)) {
      throw new AgentArtifactConflictError(binding.artifactId);
    }
    seen.add(binding.artifactId);
    const artifact = await db.agentArtifacts.get(binding.artifactId);
    if (!artifact) throw new AgentArtifactNotFoundError(binding.artifactId);
    validateArtifactRecord(artifact);
    if (artifact.sessionId !== binding.sessionId) {
      throw new AgentArtifactAccessDeniedError(binding.artifactId, binding.sessionId);
    }
    if (artifact.state !== 'ready') {
      throw new AgentArtifactStateConflictError(artifact.id, artifact.state);
    }
    await Dexie.waitFor(verifyArtifactIntegrityManifest(artifact));
    if (artifact.storageClass === 'canonical') {
      if (artifact.ownerMessageId === null) throw new AgentArtifactConflictError(artifact.id);
      // A later canonical source row may reference this immutable artifact, but
      // ownership stays with the message that originally promoted it.
      continue;
    }
    if (
      artifact.turnAttemptId !== binding.turnAttemptId
      || artifact.toolCallId !== binding.toolCallId
      || artifact.ownerMessageId !== null
    ) throw new AgentArtifactAccessDeniedError(binding.artifactId, binding.sessionId);
    promotedBytes += artifact.byteLength;
    promotedCount += 1;
    await db.agentArtifacts.put({
      ...artifact,
      ownerMessageId: binding.messageId,
      storageClass: 'canonical',
      expiresAt: null,
      lastAccessedAt: Math.max(artifact.lastAccessedAt, now),
    });
  }
  if (promotedCount === 0) return;
  await putUsage({
    ...usage,
    canonicalBytes: usage.canonicalBytes + promotedBytes,
    cacheBytes: subtractFloor(usage.cacheBytes, promotedBytes),
    canonicalArtifactCount: usage.canonicalArtifactCount + promotedCount,
    cacheArtifactCount: subtractFloor(usage.cacheArtifactCount, promotedCount),
  }, now);
}

export async function markAgentArtifactOrphaned(
  artifactId: string,
  now: () => number = Date.now,
): Promise<boolean> {
  assertIdentifier(artifactId, 'Agent artifact ID');
  const timestamp = now();
  assertTimestamp(timestamp, 'Agent artifact update time');
  return db.transaction('rw', db.agentArtifacts, async () => {
    const artifact = await db.agentArtifacts.get(artifactId);
    if (!artifact) return false;
    validateArtifactRecord(artifact);
    if (artifact.storageClass === 'canonical') {
      throw new TypeError('Canonical Agent artifacts cannot be orphaned.');
    }
    await db.agentArtifacts.put({
      ...artifact,
      state: 'orphaned',
      lastAccessedAt: timestamp,
    });
    return true;
  });
}

/** Drops only unbound cache artifacts from one exact turn before a degraded commit. */
export async function discardUnboundAgentArtifacts(input: Readonly<{
  artifactIds: readonly string[];
  sessionId: string;
  turnAttemptId: string;
  now?: () => number;
}>): Promise<number> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent artifact session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent artifact turn attempt ID');
  const artifactIds = [...new Set(input.artifactIds)];
  artifactIds.forEach((artifactId) => assertIdentifier(artifactId, 'Agent artifact ID'));
  if (artifactIds.length === 0) return 0;
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent artifact discard time');
  await ensureAgentStorageUsage();
  return db.transaction(
    'rw',
    [db.agentArtifacts, db.agentArtifactChunks, db.agentStorageUsage],
    () => discardUnboundAgentArtifactsInCurrentTransaction({
      artifactIds,
      sessionId: input.sessionId,
      turnAttemptId: input.turnAttemptId,
    }, now),
  );
}

/** Caller must include artifact metadata, chunks, and the usage ledger. */
export async function discardUnboundAgentArtifactsInCurrentTransaction(
  input: Readonly<{
    artifactIds: readonly string[];
    sessionId: string;
    turnAttemptId: string;
  }>,
  now: number,
): Promise<number> {
  const usage = await requireUsageRecord();
  let freedBytes = 0;
  let deletedArtifacts = 0;
  for (const artifactId of input.artifactIds) {
    const artifact = await db.agentArtifacts.get(artifactId);
    if (!artifact) continue;
    if (artifact.sessionId !== input.sessionId) {
      throw new AgentArtifactAccessDeniedError(artifactId, input.sessionId);
    }
    // Later inspections reference an existing canonical artifact without
    // taking ownership; failed attempts must leave that source untouched.
    if (artifact.storageClass === 'canonical' || artifact.ownerMessageId !== null) continue;
    if (artifact.turnAttemptId !== input.turnAttemptId) {
      throw new AgentArtifactAccessDeniedError(artifactId, input.sessionId);
    }
    const accounting = repairArtifactAccounting(
      artifact,
      await measureArtifactChunkBytes(artifactId),
    );
    await db.agentArtifactChunks.where('artifactId').equals(artifactId).delete();
    await db.agentArtifacts.delete(artifactId);
    freedBytes = addAccountingBytes(freedBytes, accounting.byteLength);
    deletedArtifacts += 1;
  }
  await putUsage({
    ...usage,
    cacheBytes: subtractFloor(usage.cacheBytes, freedBytes),
    artifactCount: subtractFloor(usage.artifactCount, deletedArtifacts),
    cacheArtifactCount: subtractFloor(usage.cacheArtifactCount, deletedArtifacts),
  }, now);
  return freedBytes;
}

export async function cleanupAgentToolCache(
  options: Readonly<{
    targetTotalBytes?: number;
    clearAllEligible?: boolean;
    protectedArtifactIds?: readonly string[];
    protectedSessionIds?: readonly string[];
    now?: () => number;
  }> = {},
): Promise<AgentStorageCleanupResult> {
  const now = (options.now ?? Date.now)();
  assertTimestamp(now, 'Agent cache cleanup time');
  const targetTotalBytes = options.targetTotalBytes ?? AGENT_STORAGE_WARNING_BYTES;
  assertNonnegativeSafeInteger(targetTotalBytes, 'Agent cache cleanup target');
  const protectedArtifactIds = new Set(options.protectedArtifactIds ?? []);
  const protectedSessionIds = new Set(options.protectedSessionIds ?? []);
  for (const id of protectedArtifactIds) assertIdentifier(id, 'Protected Agent artifact ID');
  for (const id of protectedSessionIds) assertIdentifier(id, 'Protected Agent session ID');
  await ensureAgentStorageUsage();
  const cleanup = await db.transaction(
    'rw',
    [
      db.agentSessions,
      db.agentAttempts,
      db.agentAttemptRecoveries,
      db.agentMessages,
      db.agentArtifacts,
      db.agentArtifactChunks,
      db.agentStorageUsage,
    ],
    async () => {
      const usage = await requireUsageRecord();
      const activeTurnsBySession = new Map(
        (await db.agentAttempts.toArray()).flatMap((attempt) => (
          attempt.state === 'running' && attempt.lease
            ? [[attempt.sessionId, attempt.turnAttemptId] as const]
            : []
        )),
      );
      // Include malformed metadata that vanished from the storageClass index;
      // otherwise one damaged cache row can permanently consume capacity.
      const cache = await db.agentArtifacts.toArray();
      let freedBytes = 0;
      let deletedArtifacts = 0;
      let protectedArtifacts = 0;
      let projectedTotal = usage.canonicalBytes + usage.cacheBytes;
      let encounteredCorruption = false;
      for (const artifact of sortCleanupCandidates(cache, now)) {
        let corrupt = false;
        try {
          validateArtifactRecord(artifact);
        } catch {
          corrupt = true;
          encounteredCorruption = true;
        }
        const artifactId = typeof artifact?.id === 'string' ? artifact.id : null;
        if (!artifactId) {
          protectedArtifacts += 1;
          continue;
        }
        const sessionId = typeof artifact?.sessionId === 'string' ? artifact.sessionId : null;
        if (!corrupt && artifact?.storageClass === 'canonical') continue;
        const owner = typeof artifact?.ownerMessageId === 'string'
          ? await db.agentMessages.get(artifact.ownerMessageId)
          : undefined;
        const hasCanonicalOwner = !!owner
          && sessionId !== null
          && owner.sessionId === sessionId;
        const freshPending = !corrupt
          && artifact?.state === 'pending'
          && typeof artifact.createdAt === 'number'
          && artifact.createdAt + AGENT_ARTIFACT_PENDING_STALE_MS > now;
        if (
          protectedArtifactIds.has(artifactId)
          || (sessionId !== null && protectedSessionIds.has(sessionId))
          || (sessionId !== null
            && activeTurnsBySession.get(sessionId) === artifact.turnAttemptId)
          || hasCanonicalOwner
          || freshPending
        ) {
          protectedArtifacts += 1;
          continue;
        }
        const mandatory = corrupt
          || artifact?.state === 'orphaned'
          || artifact?.state === 'pending'
          || (artifact?.expiresAt !== null && artifact?.expiresAt !== undefined && artifact.expiresAt <= now);
        if (!mandatory && options.clearAllEligible !== true && projectedTotal <= targetTotalBytes) {
          continue;
        }
        const artifactBytes = corrupt
          ? repairArtifactAccounting(
              artifact,
              await measureArtifactChunkBytes(artifactId),
            ).byteLength
          : artifact.byteLength;
        await db.agentArtifactChunks.where('artifactId').equals(artifactId).delete();
        await db.agentArtifacts.delete(artifactId);
        freedBytes = addAccountingBytes(freedBytes, artifactBytes);
        projectedTotal = Math.max(0, projectedTotal - artifactBytes);
        deletedArtifacts += 1;
      }
      const next = encounteredCorruption
        ? await reconcileAgentStorageUsageInCurrentTransaction(now)
        : await putUsage({
            ...usage,
            cacheBytes: subtractFloor(usage.cacheBytes, freedBytes),
            artifactCount: subtractFloor(usage.artifactCount, deletedArtifacts),
            cacheArtifactCount: subtractFloor(usage.cacheArtifactCount, deletedArtifacts),
          }, now);
      return { freedBytes, deletedArtifacts, protectedArtifacts, usage: next };
    },
  );
  return {
    ...cleanup,
    usage: usageSnapshot(cleanup.usage, await estimateBrowserStorage()),
  };
}

export async function clearAgentToolCache(
  options: Readonly<{
    protectedArtifactIds?: readonly string[];
    protectedSessionIds?: readonly string[];
    now?: () => number;
  }> = {},
): Promise<AgentStorageCleanupResult> {
  return cleanupAgentToolCache({ ...options, targetTotalBytes: 0, clearAllEligible: true });
}

export function agentMessageLogicalByteLength(
  row: Readonly<Record<string, unknown>>,
): number {
  const { byteLength: _byteLength, ...logical } = row;
  return new TextEncoder().encode(canonicalJson(logical)).byteLength;
}

/** Counts every persisted attempt field, including its durable lease. */
export function agentAttemptLogicalByteLength(
  row: Readonly<Record<string, unknown>>,
): number {
  return new TextEncoder().encode(canonicalJson(row)).byteLength;
}

/** Counts every persisted recovery-message field outside compact attempt authority. */
export function agentAttemptRecoveryLogicalByteLength(
  row: Readonly<Record<string, unknown>>,
): number {
  return new TextEncoder().encode(canonicalJson(row)).byteLength;
}

/** Counts every persisted canonical session field. */
export function agentSessionLogicalByteLength(
  row: Readonly<Record<string, unknown>>,
): number {
  return new TextEncoder().encode(canonicalJson(row)).byteLength;
}

function repairAgentSessionLogicalByteLength(
  row: Readonly<Record<string, unknown>>,
): number {
  try {
    return agentSessionLogicalByteLength(row);
  } catch {
    return bestEffortJsonByteLength(row);
  }
}

function repairAgentAttemptLogicalByteLength(record: AgentAttemptRecord): number {
  try {
    return agentAttemptLogicalByteLength(record);
  } catch {
    return bestEffortJsonByteLength(record);
  }
}

function repairAgentAttemptRecoveryLogicalByteLength(record: AgentAttemptRecoveryRecord): number {
  try {
    return agentAttemptRecoveryLogicalByteLength(record);
  } catch {
    return bestEffortJsonByteLength(record);
  }
}

function isUnambiguousOrphanAgentAttemptRecovery(
  recovery: AgentAttemptRecoveryRecord,
  attempts: readonly AgentAttemptRecord[],
): boolean {
  const id = typeof recovery?.id === 'string' ? recovery.id : null;
  const sessionId = typeof recovery?.sessionId === 'string' ? recovery.sessionId : null;
  const turnAttemptId = typeof recovery?.turnAttemptId === 'string'
    ? recovery.turnAttemptId
    : null;
  if (!id || !sessionId || !turnAttemptId) return false;
  return !attempts.some((attempt) => attempt?.id === id)
    && !attempts.some((attempt) => (
      attempt?.sessionId === sessionId && attempt?.turnAttemptId === turnAttemptId
    ));
}

function repairAgentMessageLogicalByteLength(
  row: Readonly<Record<string, unknown>>,
): number {
  try {
    return agentMessageLogicalByteLength(row);
  } catch {
    const logical = { ...row };
    delete logical.byteLength;
    return bestEffortJsonByteLength(logical);
  }
}

function repairArtifactAccounting(
  artifact: AgentArtifactRecord,
  measuredChunkBytes?: number,
): Readonly<{ storageClass: AgentStorageClass; byteLength: number }> {
  try {
    validateArtifactRecord(artifact);
    return { storageClass: artifact.storageClass, byteLength: artifact.byteLength };
  } catch {
    // Only an explicit canonical value receives non-evictable accounting.
    // Unknown classes remain clearable instead of poisoning capacity forever.
    const storageClass = artifact?.storageClass === 'canonical' ? 'canonical' : 'cache';
    const byteLength = measuredChunkBytes !== undefined
      ? measuredChunkBytes
      : nonnegativeSafeInteger(artifact?.byteLength) ?? bestEffortJsonByteLength(artifact);
    return { storageClass, byteLength };
  }
}

async function measureArtifactChunkBytes(artifactId: string): Promise<number> {
  let byteLength = 0;
  await db.agentArtifactChunks.where('artifactId').equals(artifactId).each((chunk) => {
    byteLength = addAccountingBytes(byteLength, repairChunkByteLength(chunk));
  });
  return byteLength;
}

function repairChunkByteLength(chunk: AgentArtifactChunkRecord): number {
  if (typeof chunk?.payload === 'string') {
    return new TextEncoder().encode(chunk.payload).byteLength;
  }
  return nonnegativeSafeInteger(chunk?.byteLength) ?? bestEffortJsonByteLength(chunk);
}

function bestEffortJsonByteLength(value: unknown): number {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === 'bigint') return `${entry.toString()}n`;
      if (entry && typeof entry === 'object') {
        if (seen.has(entry)) return '[Circular]';
        seen.add(entry);
      }
      return entry;
    });
    return new TextEncoder().encode(serialized ?? 'null').byteLength;
  } catch {
    return 0;
  }
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function addAccountingBytes(total: number, delta: number): number {
  const normalized = nonnegativeSafeInteger(delta) ?? 0;
  return Math.min(Number.MAX_SAFE_INTEGER, total + normalized);
}

function assertStorageAdmission(
  usage: AgentStorageUsageRecord,
  delta: number,
  storageClass: AgentStorageClass,
): void {
  assertNonnegativeSafeInteger(delta, 'Agent storage write size');
  const current = usage.canonicalBytes + usage.cacheBytes;
  const effectiveLimit = storageClass === 'cache'
    ? AGENT_STORAGE_HARD_LIMIT_BYTES - AGENT_STORAGE_CACHE_HEADROOM_BYTES
    : AGENT_STORAGE_HARD_LIMIT_BYTES;
  if (current + delta <= effectiveLimit) return;
  throw new AgentStorageCapacityError(
    delta,
    Math.max(0, effectiveLimit - current),
  );
}

async function requireUsageRecord(): Promise<AgentStorageUsageRecord> {
  const record = await db.agentStorageUsage.get(AGENT_STORAGE_USAGE_ID);
  if (!validUsageRecord(record)) {
    throw new TypeError('Agent storage usage ledger is missing or corrupt.');
  }
  return record;
}

async function putUsage(
  value: Omit<AgentStorageUsageRecord, 'revision' | 'updatedAt'>
    & Pick<AgentStorageUsageRecord, 'revision' | 'updatedAt'>,
  now: number,
): Promise<AgentStorageUsageRecord> {
  const next: AgentStorageUsageRecord = {
    ...value,
    updatedAt: Math.max(now, value.updatedAt),
    revision: value.revision + 1,
  };
  validateUsageRecord(next);
  await db.agentStorageUsage.put(next);
  return next;
}

function validUsageRecord(value: unknown): value is AgentStorageUsageRecord {
  try {
    validateUsageRecord(value);
    return true;
  } catch {
    return false;
  }
}

function validateUsageRecord(value: unknown): asserts value is AgentStorageUsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent storage usage ledger must be an object.');
  }
  const record = value as AgentStorageUsageRecord;
  if (record.id !== AGENT_STORAGE_USAGE_ID || record.schemaVersion !== AGENT_STORAGE_SCHEMA_VERSION) {
    throw new TypeError('Agent storage usage ledger version is unsupported.');
  }
  for (const [label, amount] of [
    ['canonical bytes', record.canonicalBytes],
    ['cache bytes', record.cacheBytes],
    ['session count', record.sessionCount],
    ['message count', record.messageCount],
    ['artifact count', record.artifactCount],
    ['canonical artifact count', record.canonicalArtifactCount],
    ['cache artifact count', record.cacheArtifactCount],
    ['revision', record.revision],
  ] as const) assertNonnegativeSafeInteger(amount, `Agent storage ${label}`);
  if (record.artifactCount !== record.canonicalArtifactCount + record.cacheArtifactCount) {
    throw new TypeError('Agent storage artifact counts are inconsistent.');
  }
  assertTimestamp(record.updatedAt, 'Agent storage update time');
}

function usageSnapshot(
  record: AgentStorageUsageRecord,
  browser: Readonly<{ usageBytes: number | null; quotaBytes: number | null }>,
): AgentStorageUsageSnapshot {
  const totalBytes = record.canonicalBytes + record.cacheBytes;
  return {
    canonicalBytes: record.canonicalBytes,
    cacheBytes: record.cacheBytes,
    totalBytes,
    sessionCount: record.sessionCount,
    messageCount: record.messageCount,
    artifactCount: record.artifactCount,
    canonicalArtifactCount: record.canonicalArtifactCount,
    cacheArtifactCount: record.cacheArtifactCount,
    warningBytes: AGENT_STORAGE_WARNING_BYTES,
    hardLimitBytes: AGENT_STORAGE_HARD_LIMIT_BYTES,
    isWarning: totalBytes >= AGENT_STORAGE_WARNING_BYTES,
    isAtHardLimit: totalBytes >= AGENT_STORAGE_HARD_LIMIT_BYTES,
    browser,
  };
}

async function estimateBrowserStorage(): Promise<Readonly<{
  usageBytes: number | null;
  quotaBytes: number | null;
}>> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    return {
      usageBytes: finiteNonnegativeNumber(estimate?.usage),
      quotaBytes: finiteNonnegativeNumber(estimate?.quota),
    };
  } catch {
    return { usageBytes: null, quotaBytes: null };
  }
}

function finiteNonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function validatePendingArtifactInput(input: BeginAgentArtifactWriteInput): void {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent artifact session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent artifact turn attempt ID');
  assertIdentifier(input.toolName, 'Agent artifact tool name', 256);
  if (input.ownerMessageId != null) {
    assertIdentifier(input.ownerMessageId, 'Agent artifact owner message');
  }
  if (input.toolCallId != null) {
    assertIdentifier(input.toolCallId, 'Agent artifact tool call');
  }
  if (input.storageClass !== 'canonical' && input.storageClass !== 'cache') {
    throw new TypeError('Agent artifact storage class is invalid.');
  }
  assertNonnegativeSafeInteger(input.byteLength, 'Agent artifact bytes');
  assertNonnegativeSafeInteger(input.chunkCount, 'Agent artifact chunk count');
  if (input.chunkCount > AGENT_ARTIFACT_MAX_CHUNKS) {
    throw new RangeError('Agent artifact has too many chunks.');
  }
  if ((input.byteLength === 0) !== (input.chunkCount === 0)) {
    throw new TypeError('Empty Agent artifacts must declare zero chunks.');
  }
  if (input.byteLength > input.chunkCount * AGENT_ARTIFACT_CHUNK_MAX_BYTES) {
    throw new RangeError('Agent artifact bytes exceed the declared chunk capacity.');
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(input.sha256)) {
    throw new TypeError('Agent artifact digest is malformed.');
  }
  if (input.contentType !== undefined) {
    assertIdentifier(input.contentType, 'Agent artifact content type', 256);
  }
  if (input.expiresAt != null) {
    assertTimestamp(input.expiresAt, 'Agent artifact expiry time');
    if (input.storageClass !== 'cache') {
      throw new TypeError('Canonical Agent artifacts cannot expire.');
    }
  }
  if (input.artifactId !== undefined) assertIdentifier(input.artifactId, 'Agent artifact ID');
}

function sameArtifactWrite(left: AgentArtifactRecord, right: AgentArtifactRecord): boolean {
  return left.id === right.id
    && left.schemaVersion === right.schemaVersion
    && left.sessionId === right.sessionId
    && left.turnAttemptId === right.turnAttemptId
    && left.ownerMessageId === right.ownerMessageId
    && left.toolCallId === right.toolCallId
    && left.toolName === right.toolName
    && left.storageClass === right.storageClass
    && left.contentType === right.contentType
    && left.encoding === right.encoding
    && left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.chunkCount === right.chunkCount;
}

async function loadVerifiedReadyArtifact(
  artifactId: string,
  sessionId?: string,
): Promise<AgentArtifactRecord> {
  const artifact = await db.agentArtifacts.get(artifactId);
  if (!artifact) throw new AgentArtifactNotFoundError(artifactId);
  validateReadableArtifactRecord(artifact, artifactId);
  if (sessionId !== undefined && artifact.sessionId !== sessionId) {
    throw new AgentArtifactAccessDeniedError(artifactId, sessionId);
  }
  if (artifact.state !== 'ready') throw new AgentArtifactNotReadyError(artifactId);
  await verifyArtifactIntegrityManifest(artifact);
  return artifact;
}

/** Touches only the exact artifact that was validated by the read. */
async function touchAgentArtifactIfCurrent(
  artifactId: string,
  snapshot: AgentArtifactRecord,
  now: number,
): Promise<void> {
  assertTimestamp(now, 'Agent artifact access time');
  await db.transaction('rw', db.agentArtifacts, async () => {
    const current = await db.agentArtifacts.get(artifactId);
    if (!current) return;
    try {
      assertSameReadyArtifactSnapshot(current, snapshot);
    } catch {
      // A concurrent delete/replacement invalidates the touch, not the page.
      return;
    }
    if (now - current.lastAccessedAt < AGENT_ARTIFACT_ACCESS_WRITE_INTERVAL_MS) return;
    await db.agentArtifacts.update(artifactId, {
      lastAccessedAt: Math.max(current.lastAccessedAt, now),
    });
  });
}

function assertSameReadyArtifactSnapshot(
  artifact: AgentArtifactRecord,
  snapshot: AgentArtifactRecord,
): void {
  validateReadableArtifactRecord(artifact, snapshot.id);
  if (artifact.state !== 'ready') throw new AgentArtifactNotReadyError(artifact.id);
  if (
    artifact.id !== snapshot.id
    || artifact.sessionId !== snapshot.sessionId
    || artifact.turnAttemptId !== snapshot.turnAttemptId
    || artifact.ownerMessageId !== snapshot.ownerMessageId
    || artifact.toolCallId !== snapshot.toolCallId
    || artifact.toolName !== snapshot.toolName
    || artifact.storageClass !== snapshot.storageClass
    || artifact.contentType !== snapshot.contentType
    || artifact.encoding !== snapshot.encoding
    || artifact.sha256 !== snapshot.sha256
    || artifact.byteLength !== snapshot.byteLength
    || artifact.chunkCount !== snapshot.chunkCount
    || artifact.createdAt !== snapshot.createdAt
    || artifact.expiresAt !== snapshot.expiresAt
    || !sameArtifactIntegrity(artifact.integrity, snapshot.integrity)
  ) throw new AgentArtifactConflictError(artifact.id);
}

function artifactPageEndChunk(
  artifact: AgentArtifactRecord,
  startChunk: number,
  maxBytes: number,
): number {
  const integrity = requireArtifactIntegrity(artifact);
  let bytes = 0;
  let endChunk = startChunk;
  while (endChunk < artifact.chunkCount) {
    const nextBytes = integrity.chunks[endChunk]!.byteLength;
    if (bytes > 0 && bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    endChunk += 1;
    if (bytes >= maxBytes) break;
  }
  return endChunk;
}

function validateReadableArtifactRecord(
  artifact: AgentArtifactRecord,
  artifactId: string,
): void {
  try {
    validateArtifactRecord(artifact);
  } catch (error) {
    throw new AgentArtifactCorruptionError(
      artifactId,
      error instanceof Error ? error.message : 'metadata is invalid',
    );
  }
}

async function loadCompleteArtifactChunks(
  artifact: AgentArtifactRecord,
): Promise<AgentArtifactChunkRecord[]> {
  const chunks = await db.agentArtifactChunks
    .where('[artifactId+index]')
    .between([artifact.id, 0], [artifact.id, artifact.chunkCount], true, false)
    .toArray();
  if (chunks.length !== artifact.chunkCount) {
    throw new AgentArtifactCorruptionError(artifact.id, 'chunk count does not match metadata');
  }
  chunks.forEach((chunk, index) => validateChunkRecord(chunk, artifact.id, index));
  if (sumSafe(chunks.map((chunk) => chunk.byteLength), 'Agent artifact bytes') !== artifact.byteLength) {
    throw new AgentArtifactCorruptionError(artifact.id, 'chunk bytes do not match metadata');
  }
  return chunks;
}

function validateArtifactInput(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  ownerMessageId?: string | null;
  toolCallId?: string | null;
  toolName: string;
  storageClass: AgentStorageClass;
  content: string;
  contentType?: string;
  expiresAt?: number | null;
}>): void {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent artifact session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent artifact turn attempt ID');
  assertIdentifier(input.toolName, 'Agent artifact tool name', 256);
  if (input.ownerMessageId != null) assertIdentifier(input.ownerMessageId, 'Agent artifact owner message');
  if (input.toolCallId != null) assertIdentifier(input.toolCallId, 'Agent artifact tool call');
  if (input.storageClass !== 'canonical' && input.storageClass !== 'cache') {
    throw new TypeError('Agent artifact storage class is invalid.');
  }
  if (typeof input.content !== 'string') throw new TypeError('Agent artifact content must be text.');
  if (input.contentType !== undefined) assertIdentifier(input.contentType, 'Agent artifact content type', 256);
  if (input.expiresAt != null) {
    assertTimestamp(input.expiresAt, 'Agent artifact expiry time');
    if (input.storageClass !== 'cache') {
      throw new TypeError('Canonical Agent artifacts cannot expire.');
    }
  }
}

function validateArtifactRecord(record: AgentArtifactRecord): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Agent artifact must be an object.');
  }
  if (record.schemaVersion !== AGENT_STORAGE_SCHEMA_VERSION) {
    throw new TypeError('Agent artifact schema version is unsupported.');
  }
  assertIdentifier(record.id, 'Agent artifact ID');
  assertIdentifier(record.sessionId, 'Agent artifact session ID');
  assertIdentifier(record.turnAttemptId, 'Agent artifact turn attempt ID');
  if (record.ownerMessageId !== null) assertIdentifier(record.ownerMessageId, 'Agent artifact owner message');
  if (record.toolCallId !== null) assertIdentifier(record.toolCallId, 'Agent artifact tool call');
  assertIdentifier(record.toolName, 'Agent artifact tool name', 256);
  if (record.storageClass !== 'canonical' && record.storageClass !== 'cache') {
    throw new TypeError('Agent artifact storage class is invalid.');
  }
  if (!['pending', 'ready', 'orphaned'].includes(record.state)) {
    throw new TypeError('Agent artifact state is invalid.');
  }
  assertIdentifier(record.contentType, 'Agent artifact content type', 256);
  if (record.encoding !== 'utf8') throw new TypeError('Agent artifact encoding is unsupported.');
  if (typeof record.sha256 !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(record.sha256)) {
    throw new TypeError('Agent artifact digest is malformed.');
  }
  assertNonnegativeSafeInteger(record.byteLength, 'Agent artifact bytes');
  assertNonnegativeSafeInteger(record.chunkCount, 'Agent artifact chunk count');
  if (record.chunkCount > AGENT_ARTIFACT_MAX_CHUNKS) {
    throw new RangeError('Agent artifact has too many chunks.');
  }
  if ((record.byteLength === 0) !== (record.chunkCount === 0)) {
    throw new TypeError('Empty Agent artifacts must contain zero chunks.');
  }
  if (record.byteLength > record.chunkCount * AGENT_ARTIFACT_CHUNK_MAX_BYTES) {
    throw new RangeError('Agent artifact bytes exceed its chunk capacity.');
  }
  validateArtifactIntegrity(record);
  assertTimestamp(record.createdAt, 'Agent artifact creation time');
  assertTimestamp(record.lastAccessedAt, 'Agent artifact access time');
  if (record.lastAccessedAt < record.createdAt) {
    throw new TypeError('Agent artifact access time precedes creation.');
  }
  if (record.expiresAt !== null) {
    assertTimestamp(record.expiresAt, 'Agent artifact expiry time');
    if (record.storageClass !== 'cache') throw new TypeError('Canonical Agent artifacts cannot expire.');
  }
}

function validateArtifactIntegrity(record: AgentArtifactRecord): void {
  const integrity = record.integrity;
  if (integrity === null) {
    if (record.state === 'ready') {
      throw new TypeError('Ready Agent artifacts require an integrity manifest.');
    }
    return;
  }
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
    throw new TypeError('Agent artifact integrity manifest is malformed.');
  }
  const keys = Object.keys(integrity).sort();
  if (
    keys.length !== 3
    || keys[0] !== 'chunks'
    || keys[1] !== 'manifestSha256'
    || keys[2] !== 'schemaVersion'
    || integrity.schemaVersion !== AGENT_ARTIFACT_INTEGRITY_SCHEMA_VERSION
    || !Array.isArray(integrity.chunks)
    || integrity.chunks.length !== record.chunkCount
    || typeof integrity.manifestSha256 !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(integrity.manifestSha256)
  ) throw new TypeError('Agent artifact integrity manifest is malformed.');
  if (record.state === 'pending') {
    throw new TypeError('Pending Agent artifacts cannot have an integrity manifest.');
  }
  let byteLength = 0;
  for (const chunk of integrity.chunks) {
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      throw new TypeError('Agent artifact integrity chunk is malformed.');
    }
    const chunkKeys = Object.keys(chunk).sort();
    if (
      chunkKeys.length !== 2
      || chunkKeys[0] !== 'byteLength'
      || chunkKeys[1] !== 'sha256'
      || !Number.isSafeInteger(chunk.byteLength)
      || chunk.byteLength <= 0
      || chunk.byteLength > AGENT_ARTIFACT_CHUNK_MAX_BYTES
      || typeof chunk.sha256 !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(chunk.sha256)
    ) throw new TypeError('Agent artifact integrity chunk is malformed.');
    byteLength = sumSafe([byteLength, chunk.byteLength], 'Agent artifact integrity bytes');
  }
  if (byteLength !== record.byteLength) {
    throw new TypeError('Agent artifact integrity bytes do not match metadata.');
  }
}

function validateChunkRecord(
  row: AgentArtifactChunkRecord,
  artifactId: string,
  expectedIndex: number,
): void {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new AgentArtifactCorruptionError(artifactId, 'chunk is malformed');
  }
  if (row.artifactId !== artifactId || row.index !== expectedIndex) {
    throw new AgentArtifactCorruptionError(artifactId, 'chunk sequence has a gap');
  }
  if (row.id !== `${artifactId}:${expectedIndex}` || typeof row.payload !== 'string') {
    throw new AgentArtifactCorruptionError(artifactId, 'chunk identity is malformed');
  }
  if (typeof row.sha256 !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(row.sha256)) {
    throw new AgentArtifactCorruptionError(artifactId, 'chunk digest is malformed');
  }
  const actualBytes = new TextEncoder().encode(row.payload).byteLength;
  if (row.byteLength !== actualBytes || actualBytes > AGENT_ARTIFACT_CHUNK_MAX_BYTES) {
    throw new AgentArtifactCorruptionError(artifactId, 'chunk byte length is invalid');
  }
}

function validateReadyChunkRecord(
  artifact: AgentArtifactRecord,
  row: AgentArtifactChunkRecord,
  expectedIndex: number,
): void {
  validateChunkRecord(row, artifact.id, expectedIndex);
  const expected = requireArtifactIntegrity(artifact).chunks[expectedIndex];
  if (expected?.byteLength !== row.byteLength || expected.sha256 !== row.sha256) {
    throw new AgentArtifactCorruptionError(
      artifact.id,
      'chunk identity does not match the finalized integrity manifest',
    );
  }
}

type AgentArtifactBytePosition = Readonly<{
  chunkIndex: number;
  characterOffset: number;
  chunkStartByte: number;
  byteOffset: number;
}>;

async function resolveArtifactBytePosition(
  artifact: AgentArtifactRecord,
  requestedByteOffset: number,
): Promise<AgentArtifactBytePosition> {
  if (requestedByteOffset > artifact.byteLength) {
    throw new RangeError('Agent artifact byte offset is outside the payload.');
  }
  if (requestedByteOffset === artifact.byteLength) {
    return {
      chunkIndex: artifact.chunkCount,
      characterOffset: 0,
      chunkStartByte: artifact.byteLength,
      byteOffset: artifact.byteLength,
    };
  }
  let chunkStartByte = 0;
  const chunks = requireArtifactIntegrity(artifact).chunks;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunkBytes = chunks[chunkIndex]!.byteLength;
    if (requestedByteOffset < chunkStartByte + chunkBytes) {
      const row = await loadCheckedArtifactChunk(artifact, chunkIndex);
      const local = utf8BoundaryAtOrBefore(row.payload, requestedByteOffset - chunkStartByte);
      return {
        chunkIndex,
        characterOffset: local.characterOffset,
        chunkStartByte,
        byteOffset: chunkStartByte + local.byteOffset,
      };
    }
    chunkStartByte += chunkBytes;
  }
  throw new AgentArtifactCorruptionError(artifact.id, 'byte offsets do not match the manifest');
}

async function loadCheckedArtifactChunk(
  snapshot: AgentArtifactRecord,
  chunkIndex: number,
): Promise<AgentArtifactChunkRecord> {
  const row = await db.transaction(
    'r',
    [db.agentArtifacts, db.agentArtifactChunks],
    async () => {
      const current = await db.agentArtifacts.get(snapshot.id);
      if (!current) throw new AgentArtifactNotFoundError(snapshot.id);
      assertSameReadyArtifactSnapshot(current, snapshot);
      const chunk = await db.agentArtifactChunks.get(`${snapshot.id}:${chunkIndex}`);
      if (!chunk) {
        throw new AgentArtifactCorruptionError(snapshot.id, 'payload chunks are missing');
      }
      validateReadyChunkRecord(current, chunk, chunkIndex);
      return chunk;
    },
  );
  await verifyChunkDigests(snapshot.id, [row]);
  return row;
}

function encodeArtifactCursor(
  artifactId: string,
  chunkIndex: number,
  characterOffset: number,
): string {
  const cursor = `${AGENT_ARTIFACT_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify({
    artifactId,
    chunkIndex,
    characterOffset,
  }))}`;
  if (cursor.length > AGENT_ARTIFACT_CURSOR_MAX_CHARS) {
    throw new RangeError('Agent artifact cursor is too large.');
  }
  return cursor;
}

function decodeArtifactCursor(
  cursor: string,
  artifactId: string,
): Readonly<{ chunkIndex: number; characterOffset: number }> {
  if (
    typeof cursor !== 'string'
    || cursor.length > AGENT_ARTIFACT_CURSOR_MAX_CHARS
    || !cursor.startsWith(AGENT_ARTIFACT_CURSOR_PREFIX)
  ) throw new TypeError('Agent artifact cursor is malformed.');
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(cursor.slice(AGENT_ARTIFACT_CURSOR_PREFIX.length)));
  } catch {
    throw new TypeError('Agent artifact cursor is malformed.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent artifact cursor is malformed.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== 'artifactId'
    || keys[1] !== 'characterOffset'
    || keys[2] !== 'chunkIndex'
    || record.artifactId !== artifactId
  ) throw new TypeError('Agent artifact cursor does not match this artifact.');
  assertNonnegativeSafeInteger(record.chunkIndex, 'Agent artifact cursor chunk');
  assertNonnegativeSafeInteger(record.characterOffset, 'Agent artifact cursor offset');
  return {
    chunkIndex: record.chunkIndex,
    characterOffset: record.characterOffset,
  };
}

function sortCleanupCandidates(
  artifacts: readonly AgentArtifactRecord[],
  now: number,
): AgentArtifactRecord[] {
  const rank = (artifact: AgentArtifactRecord) => artifact?.state === 'orphaned'
    ? 0
    : artifact?.state === 'pending'
      ? 1
      : artifact?.expiresAt !== null
        && artifact?.expiresAt !== undefined
        && artifact.expiresAt <= now
        ? 2
        : 3;
  return [...artifacts].sort((left, right) => (
    rank(left) - rank(right)
    || (nonnegativeSafeInteger(left?.lastAccessedAt) ?? Number.MAX_SAFE_INTEGER)
      - (nonnegativeSafeInteger(right?.lastAccessedAt) ?? Number.MAX_SAFE_INTEGER)
    || (nonnegativeSafeInteger(left?.createdAt) ?? Number.MAX_SAFE_INTEGER)
      - (nonnegativeSafeInteger(right?.createdAt) ?? Number.MAX_SAFE_INTEGER)
    || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  ));
}

function assertIdentifier(value: unknown, label: string, maxLength = 512): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty trimmed string.`);
  }
  if (new TextEncoder().encode(value).byteLength > maxLength) {
    throw new RangeError(`${label} is too long.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  assertNonnegativeSafeInteger(value, label);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
}

function sumSafe(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    assertNonnegativeSafeInteger(value, label);
    total += value;
    if (!Number.isSafeInteger(total)) throw new RangeError(`${label} exceed the safe integer range.`);
  }
  return total;
}

function subtractFloor(value: number, amount: number): number {
  return Math.max(0, value - amount);
}
