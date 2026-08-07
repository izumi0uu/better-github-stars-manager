import type { AgentTurnTraceFactory } from '@/agent-observability/agent-turn-types';
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
  createAttemptCoordinator?(executionEpochId: string): AgentAttemptCoordinator;
  createTurnService?(dependencies: BgsmAgentTurnServiceDependencies): BgsmAgentTurnService;
  createTurnRegistry?(dependencies: BgsmAgentTurnRegistryDependencies): BgsmAgentTurnRegistry;
  createSessionRpcRouter?(dependencies: BgsmAgentSessionRpcDependencies): BgsmAgentSessionRpcRouter;
}>;

export type BgsmAgentRuntimeDependencies = Omit<
  BgsmAgentTurnServiceDependencies,
  'attemptCoordinator'
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
  const attemptCoordinator = factories?.createAttemptCoordinator?.(executionEpochId)
    ?? createAgentAttemptCoordinator(executionEpochId);
  const turnServiceDependencies: BgsmAgentTurnServiceDependencies = {
    ...dependencies,
    attemptCoordinator,
  };
  const turnService = factories?.createTurnService?.(turnServiceDependencies)
    ?? createBgsmAgentTurnService(turnServiceDependencies);
  const turnRegistryDependencies: BgsmAgentTurnRegistryDependencies = {
    executionEpochId,
    runTurn: (launch, options) => turnService.run(launch, options),
    releaseTurnLease: (input) => attemptCoordinator.release(input),
    translateError: dependencies.translateError,
    ...(dependencies.traceFactory ? { traceFactory: dependencies.traceFactory } : {}),
    ...(dependencies.contentCaptureFactory
      ? { contentCaptureFactory: dependencies.contentCaptureFactory }
      : {}),
  };
  const turnRegistry = factories?.createTurnRegistry?.(turnRegistryDependencies)
    ?? createBgsmAgentTurnRegistry(turnRegistryDependencies);
  const sessionRpcDependencies: BgsmAgentSessionRpcDependencies = {
    executionEpochId,
    inspectActiveTurn: (sessionId) => turnRegistry.inspectActiveTurn(sessionId),
    inspectDurableTurn: (sessionId) => attemptCoordinator.inspectActive(sessionId),
    dismissRetry: (input) => attemptCoordinator.dismissRetry(input),
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
