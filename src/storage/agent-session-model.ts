import type {
  AgentContextFailureReason,
  AgentStopReason,
  AgentWriteSettlement,
  ModelToolCall,
} from '@/agent-harness';
import type {
  BgsmAgentActiveProjection,
  BgsmAgentCompactionCheckpoint,
  BgsmAgentSession,
  BgsmAgentSessionMessage,
} from '@/bgsm-agent/session';
import type {
  AgentSessionAttemptDigest,
  AgentSessionLaunchDigest,
} from '@/bgsm-agent/session-transport';
import type { BgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';
import type { BgsmAgentOrganizeLibraryAction } from '@/bgsm-agent/tools';
import type { AgentStorageClass } from './agent-storage-model';
import type { AgentArtifactCoverageReceipt } from '@/bgsm-agent/artifact-coverage';

export const AGENT_SESSION_SCHEMA_VERSION = 1 as const;
export const AGENT_SESSION_TITLE_MAX_LENGTH = 32;
export const AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES = 1_500_000;
export const AGENT_SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES = 100;
export const AGENT_SESSION_TERMINAL_OUTCOME_MAX_BYTES = 4 * 1024;

export type AgentSessionHandoffAnchor = Readonly<{
  messageId: string | null;
  createdAt: number;
}>;

export type AgentSessionTerminalOutcome = Readonly<{
  reason: AgentStopReason;
  changed: boolean;
  changedCount: number;
  writeSettlement: AgentWriteSettlement;
  contextFailureReason?: AgentContextFailureReason;
  organizeLibraryAction?: BgsmAgentOrganizeLibraryAction;
  handoffAnchor?: AgentSessionHandoffAnchor;
}>;

export type AgentSessionAttemptReceipt = Readonly<{
  turnAttemptId: string;
  digest: AgentSessionAttemptDigest;
  launchDigest: AgentSessionLaunchDigest;
  appliedRevision: number;
  outcome: AgentSessionTerminalOutcome;
}>;

export type AgentSessionAppliedTurnReceipt = AgentSessionAttemptReceipt;

export type AgentSessionTurnLease = Readonly<{
  executionEpochId: string;
  turnAttemptId: string;
  baseRevision: number;
  launchDigest: AgentSessionLaunchDigest;
  acquiredAt: number;
}>;

export type AgentSessionRetryKind = 'stopped' | 'failed' | 'context_limit';
export type AgentSessionRetrySettlement = 'stop_pending' | 'retryable';

export type AgentSessionRetryDraft = Readonly<{
  sessionId: string;
  turnAttemptId: string;
  baseRevision: number;
  prompt: string;
  kind: AgentSessionRetryKind;
  settlement: AgentSessionRetrySettlement;
  updatedAt: number;
}>;

/** Read-only projection of background-owned retry authority. */
export type AgentRetryDraft = AgentSessionRetryDraft;
export type AgentRetryDraftKind = AgentSessionRetryKind;


export type AgentSessionRecord = {
  id: string;
  schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION;
  title: string;
  revision: number;
  lastSequence: number;
  binding: BgsmAgentConversationBinding | null;
  compactionCheckpoint: BgsmAgentCompactionCheckpoint | null;
  activeProjections: BgsmAgentActiveProjection[];
  createdAt: number;
  updatedAt: number;
};

export type AgentSessionMessageRecord = {
  id: string;
  schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION;
  sessionId: string;
  sequence: number;
  turnAttemptId: string;
  role: BgsmAgentSessionMessage['role'];
  content: string;
  byteLength: number;
  storageClass: Extract<AgentStorageClass, 'canonical'>;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: null;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ModelToolCall[];
  artifactIds?: string[];
  artifactCoverageReceipts?: AgentArtifactCoverageReceipt[];
};

export type BgsmAgentSessionSummary = Readonly<{
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  corrupt?: true;
}>;

export type AgentSessionMetadata = Readonly<{
  id: string;
  revision: number;
  compaction?: BgsmAgentCompactionCheckpoint;
  activeProjections?: BgsmAgentActiveProjection[];
  binding?: BgsmAgentConversationBinding;
}>;

export type AgentSessionTranscriptMessage = Readonly<
  BgsmAgentSessionMessage & { sequence: number }
>;

export type AgentSessionTranscriptPage = Readonly<{
  sessionId: string;
  messages: AgentSessionTranscriptMessage[];
  nextBeforeSequence: number | null;
}>;

export type AgentSessionPresentationMessage = Readonly<{
  sequence: number;
  id: string;
  role: 'user' | 'agent';
  content: string;
  createdAt: number;
}>;

export type LoadedAgentSession = Readonly<{
  session: AgentSessionMetadata;
  transcript: AgentSessionTranscriptPage;
  summary: BgsmAgentSessionSummary;
  lastAppliedTurnAttemptId: string | null;
  appliedTurnReceipts: readonly AgentSessionAppliedTurnReceipt[];
}>;

export type AgentSessionCatalogInspection = Readonly<{
  summaries: BgsmAgentSessionSummary[];
  corruptions: ReadonlyArray<Readonly<{
    sessionId: string | null;
    message: string;
  }>>;
}>;

export type AgentSessionCommitResult = Readonly<{
  session: AgentSessionMetadata;
  summary: BgsmAgentSessionSummary;
  turnAttemptId: string;
  idempotent: boolean;
  appliedRevision: number;
  digest: AgentSessionAttemptDigest;
  launchDigest: AgentSessionLaunchDigest;
  outcome: AgentSessionTerminalOutcome;
  transcript: AgentSessionTranscriptPage;
  presentationMessages: readonly AgentSessionPresentationMessage[];
}>;

export type AgentSessionTurnAdmission = Readonly<
  | { kind: 'acquired' }
  | { kind: 'stop_pending' }
  | { kind: 'replay'; commit: AgentSessionCommitResult }
>;

export type CanonicalLoadedAgentSession = Readonly<{
  session: BgsmAgentSession;
  summary: BgsmAgentSessionSummary;
  lastAppliedTurnAttemptId: string | null;
  appliedTurnReceipts: readonly AgentSessionAppliedTurnReceipt[];
}>;
