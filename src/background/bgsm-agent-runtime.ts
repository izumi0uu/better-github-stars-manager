import type { AgentTurnTraceFactory } from '@/agent-observability/agent-turn-types';
import { AgentCanonicalSessionCache } from '@/storage/agent-session-cache';
import type { AgentDurableTurnInspection } from '@/storage/agent-session-store';
import { createAgentAttemptCoordinator, type AgentAttemptCoordinator } from './agent-attempt-coordinator';
import {
  createBgsmAgentSessionRpcRouter,
  type BgsmAgentSessionRpcDependencies,
  type BgsmAgentSessionRpcRouter,
} from './bgsm-agent-session-rpc';
import {
  createBgsmAgentTurnService,
  type BgsmAgentTurnService,
  type BgsmAgentTurnServiceDependencies,
} from './bgsm-agent-turn-service';
import {
  createBgsmAgentTurnRegistry,
  type BgsmAgentTurnRegistry,
} from './bgsm-agent-turn-port';

type BgsmAgentTurnRegistryDependencies = Parameters<typeof createBgsmAgentTurnRegistry>[0];

export type BgsmAgentRuntimeFactories = Readonly<{
  createAttemptCoordinator?(
    executionEpochId: string,
    sessionCache: AgentCanonicalSessionCache,
  ): AgentAttemptCoordinator;
  createTurnService?(dependencies: BgsmAgentTurnServiceDependencies): BgsmAgentTurnService;
  createTurnRegistry?(dependencies: BgsmAgentTurnRegistryDependencies): BgsmAgentTurnRegistry;
  createSessionRpcRouter?(dependencies: BgsmAgentSessionRpcDependencies): BgsmAgentSessionRpcRouter;
}>;

export type BgsmAgentRuntimeDependencies = Omit<
  BgsmAgentTurnServiceDependencies,
  'attemptCoordinator' | 'sessionCache'
> & Readonly<{
  executionEpochId?: string;
  translateError(error: unknown): Promise<string>;
  traceFactory?: AgentTurnTraceFactory;
  contentCaptureFactory?: BgsmAgentTurnRegistryDependencies['contentCaptureFactory'];
  notifySessionDeleted(sessionId: string): void;
  factories?: BgsmAgentRuntimeFactories;
}>;

export type BgsmAgentRuntime = Readonly<{
  executionEpochId: string;
  attemptCoordinator: AgentAttemptCoordinator;
  turnService: BgsmAgentTurnService;
  turnRegistry: BgsmAgentTurnRegistry;
  sessionRpc: BgsmAgentSessionRpcRouter;
}>;

/**
 * Constructs the one worker-epoch authority graph. It deliberately owns no
 * Chrome listener: index.ts remains the synchronous extension composition root.
 */
export function createBgsmAgentRuntime(
  dependencies: BgsmAgentRuntimeDependencies,
): BgsmAgentRuntime {
  const executionEpochId = dependencies.executionEpochId ?? `bgsm_worker_${crypto.randomUUID()}`;
  const factories = dependencies.factories;
  const sessionCache = new AgentCanonicalSessionCache();
  const attemptCoordinator = factories?.createAttemptCoordinator?.(executionEpochId, sessionCache)
    ?? createAgentAttemptCoordinator(executionEpochId, sessionCache);
  const turnServiceDependencies: BgsmAgentTurnServiceDependencies = {
    ...dependencies,
    sessionCache,
    attemptCoordinator,
  };
  const turnService = factories?.createTurnService?.(turnServiceDependencies)
    ?? createBgsmAgentTurnService(turnServiceDependencies);
  const turnRegistryDependencies: BgsmAgentTurnRegistryDependencies = {
    executionEpochId,
    runTurn: (launch, options) => turnService.run(launch, options),
    releaseTurnLease: (input) => attemptCoordinator.release(input),
    requestTurnStop: (launch) => attemptCoordinator.requestStop(launch),
    fenceRestoredTurnFailure: (launch) => attemptCoordinator.rollbackRecoveryClaim(launch),
    translateError: dependencies.translateError,
    ...(dependencies.traceFactory ? { traceFactory: dependencies.traceFactory } : {}),
    ...(dependencies.contentCaptureFactory
      ? { contentCaptureFactory: dependencies.contentCaptureFactory }
      : {}),
  };
  const turnRegistry = factories?.createTurnRegistry?.(turnRegistryDependencies)
    ?? createBgsmAgentTurnRegistry(turnRegistryDependencies);
  const durableRecoveryBySession = new Map<string, Promise<AgentDurableTurnInspection | null>>();
  const inspectDurableTurn = (sessionId: string) => {
    const existing = durableRecoveryBySession.get(sessionId);
    if (existing) return existing;
    const reservation = turnRegistry.reserveRecovery(sessionId);
    const recovery = (async () => {
      let inspected: AgentDurableTurnInspection | null = null;
      try {
        inspected = await attemptCoordinator.inspectActive(sessionId);
        if (inspected) turnRegistry.restoreApprovedTurn(inspected.launch, reservation);
        return inspected;
      } catch (error) {
        if (inspected) {
          const rolledBack = await attemptCoordinator.rollbackRecoveryClaim(inspected.launch);
          if (!rolledBack) {
            throw new Error(
              'Agent recovery restore failed and its replacement lease could not be rolled back.',
              { cause: error },
            );
          }
        }
        throw error;
      } finally {
        turnRegistry.releaseRecovery(reservation);
      }
    })();
    durableRecoveryBySession.set(sessionId, recovery);
    void recovery.then(
      () => {
        if (durableRecoveryBySession.get(sessionId) === recovery) durableRecoveryBySession.delete(sessionId);
      },
      () => {
        if (durableRecoveryBySession.get(sessionId) === recovery) durableRecoveryBySession.delete(sessionId);
      },
    );
    return recovery;
  };
  const sessionRpcDependencies: BgsmAgentSessionRpcDependencies = {
    executionEpochId,
    sessionCache,
    inspectActiveTurn: (sessionId) => turnRegistry.inspectActiveTurn(sessionId),
    inspectDurableTurn,
    dismissRetry: (input) => attemptCoordinator.dismissRetry(input),
    abandonUncertainAttempt: (input) => attemptCoordinator.abandonUncertainAttempt(input),
    discardDamagedRecovery: (sessionId) => attemptCoordinator.discardDamagedRecovery(sessionId),
    notifySessionDeleted: dependencies.notifySessionDeleted,
  };
  const sessionRpc = factories?.createSessionRpcRouter?.(sessionRpcDependencies)
    ?? createBgsmAgentSessionRpcRouter(sessionRpcDependencies);

  return Object.freeze({
    executionEpochId,
    attemptCoordinator,
    turnService,
    turnRegistry,
    sessionRpc,
  });
}
