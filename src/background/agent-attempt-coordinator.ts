import type { AgentArtifactContinuationCheckpoint } from '@/bgsm-agent/artifact-coverage';
import type { BgsmAgentSessionTransition } from '@/bgsm-agent/session';
import {
  digestAgentSessionLaunch,
  type AgentSessionLaunchDigest,
} from '@/bgsm-agent/session-transport';
import type { BgsmAgentTurnLaunch } from '@/bgsm-agent/turn-protocol';
import {
  admitAgentSessionTurn,
  commitLeasedAgentSessionTurn,
  checkpointAgentSessionArtifactEnvelope,
  dismissAgentSessionAttemptRetry,
  discardDamagedAgentSessionRecovery,
  inspectDurableAgentSessionTurn,
  markAgentSessionAttemptStateUncertain,
  markAgentSessionArtifactRepromptUsed,
  releaseAgentSessionTurnLease,
  settleAgentSessionAttemptWithoutTransition,
  type AgentSessionCommitResult,
  type AgentSessionTerminalOutcome,
  type AgentArtifactCoverageCheckpointProposal,
  type AgentArtifactEnvelopeCheckpointResult,
  type AgentDurableTurnInspection,
} from '@/storage/agent-session-store';
import type { AgentCanonicalSessionCache } from '@/storage/agent-session-cache';
import type { AgentAttemptRecoveryClass } from '@/storage/agent-attempt-model';
export type AgentAttemptCoordinator = Readonly<{
  admit: (
    launch: BgsmAgentTurnLaunch,
    recoveryClass: AgentAttemptRecoveryClass,
  ) => Promise<Readonly<{
    launchDigest: AgentSessionLaunchDigest;
    admission: Awaited<ReturnType<typeof admitAgentSessionTurn>>;
  }>>;
  commit: (input: Readonly<{
    turnAttemptId: string;
    transition: BgsmAgentSessionTransition;
    launchDigest: AgentSessionLaunchDigest;
    outcome: AgentSessionTerminalOutcome;
  }>) => Promise<AgentSessionCommitResult>;
  checkpointArtifactEnvelope: (input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
    launchDigest: AgentSessionLaunchDigest;
    proposals: readonly AgentArtifactCoverageCheckpointProposal[];
    continuation: AgentArtifactContinuationCheckpoint | null;
  }>) => Promise<AgentArtifactEnvelopeCheckpointResult>;
  markArtifactRepromptUsed: (input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
    launchDigest: AgentSessionLaunchDigest;
    continuation: AgentArtifactContinuationCheckpoint;
  }>) => Promise<AgentArtifactContinuationCheckpoint>;
  settleWithoutTransition: (input: Readonly<{
    turnAttemptId: string;
    sessionId: string;
    launchDigest: AgentSessionLaunchDigest;
    outcome: AgentSessionTerminalOutcome;
    coverageFailureCode?: string;
  }>) => Promise<void>;
  inspectActive: (sessionId: string) => Promise<AgentDurableTurnInspection | null>;
  markStateUncertain: (input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
  }>) => Promise<boolean>;
  dismissRetry: (input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
  }>) => Promise<boolean>;
  discardDamagedRecovery: (sessionId: string) => Promise<number>;
  release: (input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
  }>) => Promise<boolean>;
}>;

/**
 * Background-owned command boundary for durable Agent attempt authority.
 * React and Port transport consume projections or issue commands; neither gets
 * a mutable repository operation.
 */
export function createAgentAttemptCoordinator(
  executionEpochId: string,
  sessionCache?: AgentCanonicalSessionCache,
): AgentAttemptCoordinator {
  return {
    async admit(launch, recoveryClass) {
      const launchDigest = await digestAgentSessionLaunch(launch);
      const admission = await admitAgentSessionTurn({
        sessionId: launch.sessionId,
        baseRevision: launch.baseRevision,
        turnAttemptId: launch.turnAttemptId,
        executionEpochId,
        launchDigest,
        launch,
        recoveryClass,
      });
      return { launchDigest, admission };
    },
    commit(input) {
      return commitLeasedAgentSessionTurn({ ...input, executionEpochId }, sessionCache);
    },
    settleWithoutTransition(input) {
      return settleAgentSessionAttemptWithoutTransition({ ...input, executionEpochId });
    },
    checkpointArtifactEnvelope(input) {
      return checkpointAgentSessionArtifactEnvelope({ ...input, executionEpochId });
    },
    markArtifactRepromptUsed(input) {
      return markAgentSessionArtifactRepromptUsed({ ...input, executionEpochId });
    },
    inspectActive(sessionId) {
      return inspectDurableAgentSessionTurn(sessionId, executionEpochId);
    },
    markStateUncertain(input) {
      return markAgentSessionAttemptStateUncertain({ ...input, executionEpochId });
    },
    dismissRetry(input) {
      return dismissAgentSessionAttemptRetry(input);
    },
    discardDamagedRecovery(sessionId) {
      return discardDamagedAgentSessionRecovery(sessionId);
    },
    release(input) {
      return releaseAgentSessionTurnLease({ ...input, executionEpochId });
    },
  };
}
