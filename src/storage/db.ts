import Dexie, { type Table } from 'dexie';
import type {
  OrganizeApplyRecord,
  OrganizeApplyRowRecord,
  OrganizeItemRecord,
  OrganizeJobRecord,
  OrganizeTaxonomyRecord,
  Star,
  Tag,
  TagDirtyOutboxRecord,
  TagMeta,
} from '@/types';
import type {
  AgentSessionMessageRecord,
  AgentSessionRecord,
} from './agent-session-model';
import type {
  AgentArtifactChunkRecord,
  AgentArtifactRecord,
  AgentStorageUsageRecord,
} from './agent-storage-model';
import type { AgentAttemptRecord } from './agent-attempt-model';
import type { AgentAttemptRecoveryRecord } from './agent-attempt-recovery-model';
import type {
  GitHubNotificationThread,
  GitHubWatchRepository,
  GitHubWatchStateRecord,
} from '@/watch/watch-model';
import { normalizeStoredTag, type LegacyTagRow } from './tag-shape';

/**
 * IndexedDB schema (via Dexie). IDB is the source of truth for stars/tags/tagMeta;
 * chrome.storage.local holds lightweight config and UI preferences. Indexes
 * back the UI filter/sort paths.
 */
export class StarsDB extends Dexie {
  stars!: Table<Star, string>;
  tags!: Table<Tag, string>;
  tagMeta!: Table<TagMeta, string>;
  organizeJobs!: Table<OrganizeJobRecord, string>;
  organizeItems!: Table<OrganizeItemRecord, string>;
  organizeTaxonomies!: Table<OrganizeTaxonomyRecord, string>;
  organizeApplies!: Table<OrganizeApplyRecord, string>;
  organizeApplyRows!: Table<OrganizeApplyRowRecord, string>;
  tagDirtyOutbox!: Table<TagDirtyOutboxRecord, string>;
  agentSessions!: Table<AgentSessionRecord, string>;
  agentAttempts!: Table<AgentAttemptRecord, string>;
  agentAttemptRecoveries!: Table<AgentAttemptRecoveryRecord, string>;
  agentMessages!: Table<AgentSessionMessageRecord, string>;
  agentArtifacts!: Table<AgentArtifactRecord, string>;
  agentArtifactChunks!: Table<AgentArtifactChunkRecord, string>;
  agentStorageUsage!: Table<AgentStorageUsageRecord, string>;
  watchRepositories!: Table<GitHubWatchRepository, string>;
  watchNotificationThreads!: Table<GitHubNotificationThread, string>;
  watchState!: Table<GitHubWatchStateRecord, 'singleton'>;

  constructor() {
    super('better-github-stars-manager');
    this.version(1).stores({
      stars: 'full_name, language, starred_at, pushed_at, tombstone',
      tags: 'full_name, *tags, mtime',
      tagMeta: 'name, dimension, mtime',
    });
    // v2: tagMeta gained an `excluded` (delete-tombstone) field. No index added —
    // excluded names are read via get(name)/toArray(), not queried — so the store
    // declaration is unchanged. Bumping the version ensures the new field is
    // recognized on existing DBs; existing rows simply lack it (read as undefined).
    this.version(2).stores({
      stars: 'full_name, language, starred_at, pushed_at, tombstone',
      tags: 'full_name, *tags, mtime',
      tagMeta: 'name, dimension, mtime',
    });
    // v3: stars gained repo `created_at`, and tags split ambiguous `tags`
    // into manual/auto/dismissed layers. The visible tag union is derived in
    // memory, so the old *tags index is intentionally gone.
    this.version(3).stores({
      stars: 'full_name, language, starred_at, pushed_at, created_at, tombstone',
      tags: 'full_name, mtime',
      tagMeta: 'name, dimension, mtime',
    }).upgrade(async (tx) => {
      const table = tx.table('tags');
      const rows = await table.toArray() as LegacyTagRow[];
      await table.bulkPut(rows.map((row) => normalizeStoredTag(row)));
    });
    // v4 adds isolated durable artifacts for whole-library tag organization,
    // Gist dirtiness, local Agent data, and account-bound Watch snapshots.
    // Transcripts, in-flight launch/retry authority, and chunked tool artifacts
    // stay in IndexedDB so extension messages remain bounded and worker
    // restarts do not lose admitted prompts.
    this.version(4).stores({
      stars: 'full_name, language, starred_at, pushed_at, created_at, tombstone',
      tags: 'full_name, mtime',
      tagMeta: 'name, dimension, mtime',
      organizeJobs: 'jobId, &activeSlot, status, updatedAt, originAgentSessionId, sessionId',
      organizeItems: 'id, [jobId+position], [jobId+analysisState], jobId, position, analysisState, leaseExpiresAt',
      organizeTaxonomies: 'jobId',
      organizeApplies: 'applyId, jobId, status',
      organizeApplyRows: 'id, [applyId+position], [applyId+state], applyId, state, leaseExpiresAt',
      tagDirtyOutbox: 'id, kind, updatedAt',
      agentSessions: 'id, updatedAt, createdAt',
      agentMessages: 'id, sessionId, &[sessionId+sequence], [sessionId+turnAttemptId]',
      agentAttempts: 'id, sessionId, &[sessionId+turnAttemptId], [sessionId+state], updatedAt',
      agentAttemptRecoveries: 'id, sessionId, &[sessionId+turnAttemptId], updatedAt',
      agentArtifacts: 'id, sessionId, turnAttemptId, ownerMessageId, storageClass, [sessionId+storageClass], [storageClass+state+lastAccessedAt], [state+createdAt], expiresAt',
      agentArtifactChunks: 'id, artifactId, &[artifactId+index]',
      agentStorageUsage: 'id',
      watchRepositories: 'full_name',
      watchNotificationThreads: 'id, repositoryFullName, updatedAt, [repositoryFullName+updatedAt]',
      watchState: 'id',
    });
  }
}

export const db = new StarsDB();

/**
 * Count of live (non-tombstone) stars — used by the UI header.
 * IndexedDB/Dexie index booleans unreliably, so filter in JS (cheap over ~10k rows).
 */
export async function liveStarCount(): Promise<number> {
  let n = 0;
  await db.stars.each((s) => {
    if (!s.tombstone) n++;
  });
  return n;
}
