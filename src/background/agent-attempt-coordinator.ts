import type { BgsmAgentSessionTransition } from '@/bgsm-agent/session';
import {
  digestAgentSessionLaunch,
  type AgentActiveTurnTransport,
  type AgentSessionLaunchDigest,
} from '@/bgsm-agent/session-transport';
import type { BgsmAgentTurnLaunch } from '@/utils/messaging';
import {
  admitAgentSessionTurn,
  commitLeasedAgentSessionTurn,
  dismissAgentSessionAttemptRetry,
  discardDamagedAgentSessionRecovery,
  inspectDurableAgentSessionTurn,
  markAgentSessionAttemptStateUncertain,
  releaseAgentSessionTurnLease,
  settleAgentSessionAttemptWithoutTransition,
  type AgentSessionCommitResult,
  type AgentSessionTerminalOutcome,
} from '@/storage/agent-session-store';
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
  settleWithoutTransition: (input: Readonly<{
    turnAttemptId: string;
    sessionId: string;
    launchDigest: AgentSessionLaunchDigest;
    outcome: AgentSessionTerminalOutcome;
  }>) => Promise<void>;
  inspectActive: (sessionId: string) => Promise<AgentActiveTurnTransport | null>;
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
      return commitLeasedAgentSessionTurn({ ...input, executionEpochId });
    },
    settleWithoutTransition(input) {
      return settleAgentSessionAttemptWithoutTransition({ ...input, executionEpochId });
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
