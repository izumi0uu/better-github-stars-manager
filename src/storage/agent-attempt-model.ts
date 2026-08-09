import type { AgentStopReason, AgentWriteSettlement } from '@/agent-harness';
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import type {
  AgentSessionLaunchDigest,
  AgentSessionLaunchIdentity,
} from '@/bgsm-agent/session-transport';
import type { AgentArtifactCoverageRecord } from '@/bgsm-agent/artifact-coverage';
import type {
  AgentSessionAttemptReceipt,
  AgentSessionRetryKind,
  AgentSessionTurnLease,
} from './agent-session-model';
import type { AgentArtifactContinuationControl } from './agent-attempt-recovery-model';

export type AgentAttemptState =
  | 'running'
  | 'stop_pending'
  | 'retryable'
  | 'committed'
  | 'state_uncertain'
  | 'terminal_non_retryable';

export type AgentAttemptRecoveryClass =
  | 'statically_read_only'
  | 'write_capable_or_unknown';

export type AgentAttemptTerminalReason =
  | AgentStopReason
  | 'retried'
  | 'superseded'
  | 'dismissed'
  | 'abandoned';

/**
 * Durable execution authority for one immutable Agent turn launch.
 *
 * The opaque ID is derived from the session and turn-attempt identity, while
 * the unique Dexie compound index remains the persisted identity invariant.
 */
export type AgentAttemptRecord = Readonly<{
  id: string;
  sessionId: string;
  turnAttemptId: string;
  state: AgentAttemptState;
  terminalReason: AgentAttemptTerminalReason | null;
  admittedLaunch: AgentSessionLaunchIdentity;
  admittedLaunchDigest: AgentSessionLaunchDigest;
  recoveryClass: AgentAttemptRecoveryClass;
  retryKind: AgentSessionRetryKind | null;
  writeSettlement: AgentWriteSettlement | null;
  receipt: AgentSessionAttemptReceipt | null;
  artifactCoverage: readonly AgentArtifactCoverageRecord[];
  artifactContinuationControl: AgentArtifactContinuationControl | null;
  lease: AgentSessionTurnLease | null;
  updatedAt: number;
}>;

/**
 * Produces the deterministic opaque key for one session-scoped turn attempt.
 * Consumers must treat the result as an identifier and never parse it.
 */
export async function agentAttemptStorageId(
  sessionId: string,
  turnAttemptId: string,
): Promise<string> {
  return `aat:v1:${await sha256Base64Url(canonicalJson([sessionId, turnAttemptId]))}`;
}
