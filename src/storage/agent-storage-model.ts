export const AGENT_STORAGE_SCHEMA_VERSION = 2 as const;
export const AGENT_STORAGE_USAGE_ID = 'agent' as const;
export const AGENT_STORAGE_WARNING_BYTES = 256 * 1024 * 1024;
export const AGENT_STORAGE_HARD_LIMIT_BYTES = 512 * 1024 * 1024;
export const AGENT_STORAGE_CACHE_HEADROOM_BYTES = 2 * 1024 * 1024;
export const AGENT_ARTIFACT_CHUNK_MAX_BYTES = 256 * 1024;
export const AGENT_ARTIFACT_MAX_CHUNKS = 2048;
export const AGENT_ARTIFACT_PAGE_MAX_BYTES = 1_000_000;
export const AGENT_ARTIFACT_ACCESS_WRITE_INTERVAL_MS = 5 * 60 * 1000;
export const AGENT_ARTIFACT_SEARCH_MAX_QUERY_BYTES = 512;
export const AGENT_ARTIFACT_PENDING_STALE_MS = 60 * 60 * 1000;
export const AGENT_ARTIFACT_UNBOUND_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_ARTIFACT_INTEGRITY_SCHEMA_VERSION = 1 as const;

export type AgentStorageClass = 'canonical' | 'cache';
export type AgentArtifactState = 'pending' | 'ready' | 'orphaned';

export type AgentArtifactIntegrityManifest = Readonly<{
  schemaVersion: typeof AGENT_ARTIFACT_INTEGRITY_SCHEMA_VERSION;
  chunks: ReadonlyArray<Readonly<{
    byteLength: number;
    sha256: string;
  }>>;
  manifestSha256: string;
}>;

export type AgentArtifactRecord = {
  id: string;
  schemaVersion: typeof AGENT_STORAGE_SCHEMA_VERSION;
  sessionId: string;
  turnAttemptId: string;
  ownerMessageId: string | null;
  toolCallId: string | null;
  toolName: string;
  storageClass: AgentStorageClass;
  state: AgentArtifactState;
  contentType: string;
  encoding: 'utf8';
  sha256: string;
  integrity: AgentArtifactIntegrityManifest | null;
  byteLength: number;
  chunkCount: number;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number | null;
};

export type AgentArtifactChunkRecord = {
  id: string;
  artifactId: string;
  index: number;
  byteLength: number;
  sha256: string;
  payload: string;
};

export type AgentStorageUsageRecord = {
  id: typeof AGENT_STORAGE_USAGE_ID;
  schemaVersion: typeof AGENT_STORAGE_SCHEMA_VERSION;
  canonicalBytes: number;
  cacheBytes: number;
  sessionCount: number;
  messageCount: number;
  artifactCount: number;
  canonicalArtifactCount: number;
  cacheArtifactCount: number;
  updatedAt: number;
  revision: number;
};

export type AgentStorageUsageSnapshot = Readonly<{
  canonicalBytes: number;
  cacheBytes: number;
  totalBytes: number;
  sessionCount: number;
  messageCount: number;
  artifactCount: number;
  canonicalArtifactCount: number;
  cacheArtifactCount: number;
  warningBytes: number;
  hardLimitBytes: number;
  isWarning: boolean;
  isAtHardLimit: boolean;
  browser: Readonly<{
    usageBytes: number | null;
    quotaBytes: number | null;
  }>;
}>;

export type AgentStorageCleanupResult = Readonly<{
  deletedArtifacts: number;
  freedBytes: number;
  protectedArtifacts: number;
  usage: AgentStorageUsageSnapshot;
}>;

export type AgentArtifactPage = Readonly<{
  artifactId: string;
  content: string;
  contentType: string;
  byteLength: number;
  totalBytes: number;
  nextChunk: number | null;
}>;

export type AgentArtifactSlice = Readonly<{
  artifactId: string;
  content: string;
  contentType: string;
  byteLength: number;
  totalBytes: number;
  nextCursor: string | null;
}>;

export type AgentArtifactMessageBinding = Readonly<{
  artifactId: string;
  sessionId: string;
  turnAttemptId: string;
  messageId: string;
  toolCallId: string;
}>;

export class AgentStorageCapacityError extends Error {
  readonly code = 'agent_storage_capacity_exceeded';

  constructor(
    readonly requiredBytes: number,
    readonly availableBytes: number,
    readonly hardLimitBytes = AGENT_STORAGE_HARD_LIMIT_BYTES,
  ) {
    super('Agent storage is full. Clear tool cache or delete a conversation before continuing.');
    this.name = 'AgentStorageCapacityError';
  }
}

export class AgentArtifactNotFoundError extends Error {
  readonly code = 'agent_artifact_not_found';

  constructor(readonly artifactId: string) {
    super(`Agent artifact ${artifactId} does not exist.`);
    this.name = 'AgentArtifactNotFoundError';
  }
}

export class AgentArtifactNotReadyError extends Error {
  readonly code = 'agent_artifact_not_ready';

  constructor(readonly artifactId: string) {
    super(`Agent artifact ${artifactId} is not ready.`);
    this.name = 'AgentArtifactNotReadyError';
  }
}

export class AgentArtifactCorruptionError extends Error {
  readonly code = 'agent_artifact_corrupt';

  constructor(readonly artifactId: string, message: string) {
    super(`Agent artifact ${artifactId} is corrupt: ${message}`);
    this.name = 'AgentArtifactCorruptionError';
  }
}

export class AgentArtifactConflictError extends Error {
  readonly code = 'agent_artifact_conflict';

  constructor(readonly artifactId: string) {
    super(`Agent artifact ${artifactId} was reused with different content.`);
    this.name = 'AgentArtifactConflictError';
  }
}

export class AgentArtifactStateConflictError extends Error {
  readonly code = 'agent_artifact_state_conflict';

  constructor(readonly artifactId: string, readonly state: AgentArtifactState) {
    super(`Agent artifact ${artifactId} cannot perform this operation while ${state}.`);
    this.name = 'AgentArtifactStateConflictError';
  }
}

export class AgentArtifactAccessDeniedError extends Error {
  readonly code = 'agent_artifact_access_denied';

  constructor(readonly artifactId: string, readonly sessionId: string) {
    super(`Agent artifact ${artifactId} is not available to session ${sessionId}.`);
    this.name = 'AgentArtifactAccessDeniedError';
  }
}

export type BeginAgentArtifactWriteInput = Readonly<{
  sessionId: string;
  turnAttemptId: string;
  ownerMessageId?: string | null;
  toolCallId?: string | null;
  toolName: string;
  storageClass: AgentStorageClass;
  byteLength: number;
  chunkCount: number;
  sha256: string;
  contentType?: string;
  expiresAt?: number | null;
  artifactId?: string;
  now?: () => number;
}>;
