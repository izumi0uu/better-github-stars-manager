import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type {
  BgsmAgentTurnLaunch,
  BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';
import type { AgentAttemptCoordinator } from '@/background/agent-attempt-coordinator';
import type { AgentCanonicalSessionCache } from '@/storage/agent-session-cache';
import type { BgsmAgentSessionRpcDependencies, BgsmAgentSessionRpcRouter } from '@/background/bgsm-agent-session-rpc';
import {
  createBgsmAgentRuntime,
  type BgsmAgentRuntimeFactories,
} from '@/background/bgsm-agent-runtime';
import type { BgsmAgentTurnService, BgsmAgentTurnServiceDependencies } from '@/background/bgsm-agent-turn-service';
import type { BgsmAgentTurnRegistry } from '@/background/bgsm-agent-turn-port';

type TurnRegistryDependencies = Parameters<
  NonNullable<BgsmAgentRuntimeFactories['createTurnRegistry']>
>[0];

const launch: BgsmAgentTurnLaunch = {
  sessionId: 'session-runtime',
  turnAttemptId: 'turn-runtime',
  baseRevision: 4,
  prompt: 'Keep the runtime graph coherent.',
  candidateContract: {
    kind: 'selected_repository',
    selectedRepositoryIdHint: 'owner/repository',
  },
};

function terminalResult(input: BgsmAgentTurnLaunch): BgsmAgentTurnResult {
  return {
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    reason: 'final_answer',
    changed: false,
    changedCount: 0,
    commit: null,
  };
}

describe('background Agent runtime composition', () => {
  it('constructs one epoch-coherent coordinator, service, registry, and session router', async () => {
    const executionEpochId = 'worker-runtime';
    const order: string[] = [];
    const released: Array<{
      sessionId: string;
      turnAttemptId: string;
      executionEpochId?: string;
    }> = [];
    const inspectedSessions: string[] = [];
    const notifiedSessions: string[] = [];
    const retryInputs: Array<{ sessionId: string; turnAttemptId: string }> = [];
    const discardedSessions: string[] = [];
    const turnRuns: BgsmAgentTurnLaunch[] = [];
    const captures: {
      coordinatorCache: AgentCanonicalSessionCache | null;
      serviceDependencies: BgsmAgentTurnServiceDependencies | null;
      registryDependencies: TurnRegistryDependencies | null;
      sessionDependencies: BgsmAgentSessionRpcDependencies | null;
    } = {
      coordinatorCache: null,
      serviceDependencies: null,
      registryDependencies: null,
      sessionDependencies: null,
    };

    const coordinator: AgentAttemptCoordinator = {
      async admit() { throw new Error('not called by runtime construction'); },
      async commit() { throw new Error('not called by runtime construction'); },
      async checkpointArtifactEnvelope() { throw new Error('not called by runtime construction'); },
      async markArtifactRepromptUsed() { throw new Error('not called by runtime construction'); },
      async settleWithoutTransition() { throw new Error('not called by runtime construction'); },
      async inspectActive(sessionId) {
        inspectedSessions.push(sessionId);
        return null;
      },
      async markStateUncertain() { return false; },
      async dismissRetry(input) {
        retryInputs.push({ ...input });
        return true;
      },
      async discardDamagedRecovery(sessionId) {
        discardedSessions.push(sessionId);
        return 3;
      },
      async release(input) {
        released.push({ ...input });
        return true;
      },
    };
    const turnService: BgsmAgentTurnService = {
      async run(input) {
        turnRuns.push(input);
        return terminalResult(input);
      },
    };
    const activeTurn = { executionEpochId, launch };
    const turnRegistry: BgsmAgentTurnRegistry = {
      executionEpochId,
      inspectActiveTurn(sessionId) {
        return sessionId === launch.sessionId ? activeTurn : null;
      },
      attach() {},
    };
    const sessionRpc: BgsmAgentSessionRpcRouter = {
      async handle() { return null; },
      describeFailure() { return null; },
    };

    const runtime = createBgsmAgentRuntime({
      executionEpochId,
      async prepareRuntimeProvider() {
        throw new Error('not called by runtime construction');
      },
      async invalidateProviderCapability() {
        return false;
      },
      async resolveLiveCandidate() {
        throw new Error('not called by runtime construction');
      },
      async getActiveOrganizeJob() {
        return undefined;
      },
      isOrganizeApplyBlockingWrites() {
        return false;
      },
      async assignManualTags() {
        throw new Error('not called by runtime construction');
      },
      async removeVisibleTags() {
        throw new Error('not called by runtime construction');
      },
      async deleteTagsEverywhere() {
        throw new Error('not called by runtime construction');
      },
      broadcastDataChanged() {},
      providerTraceIdentity() {
        return {
          providerClass: 'openai',
          protocol: 'responses',
          modelCapabilityRevision: 'capability-runtime',
        };
      },
      async translateError() {
        return 'translated';
      },
      notifySessionDeleted(sessionId) {
        notifiedSessions.push(sessionId);
      },
      factories: {
        createAttemptCoordinator(epoch, sessionCache) {
          order.push('coordinator');
          assert.equal(epoch, executionEpochId);
          captures.coordinatorCache = sessionCache;
          return coordinator;
        },
        createTurnService(dependencies) {
          order.push('service');
          captures.serviceDependencies = dependencies;
          return turnService;
        },
        createTurnRegistry(dependencies) {
          order.push('registry');
          captures.registryDependencies = dependencies;
          return turnRegistry;
        },
        createSessionRpcRouter(dependencies) {
          order.push('session-rpc');
          captures.sessionDependencies = dependencies;
          return sessionRpc;
        },
      },
    });
    const serviceDependencies = requireCaptured<BgsmAgentTurnServiceDependencies>(
      captures.serviceDependencies,
      'turn service dependencies',
    );
    const registryDependencies = requireCaptured<TurnRegistryDependencies>(
      captures.registryDependencies,
      'turn registry dependencies',
    );
    const sessionDependencies = requireCaptured<BgsmAgentSessionRpcDependencies>(
      captures.sessionDependencies,
      'session router dependencies',
    );

    assert.deepEqual(order, ['coordinator', 'service', 'registry', 'session-rpc']);
    assert.equal(runtime.executionEpochId, executionEpochId);
    assert.strictEqual(runtime.attemptCoordinator, coordinator);
    assert.strictEqual(runtime.turnService, turnService);
    assert.ok(captures.coordinatorCache);
    assert.strictEqual(serviceDependencies.sessionCache, captures.coordinatorCache);
    assert.strictEqual(sessionDependencies.sessionCache, captures.coordinatorCache);
    assert.strictEqual(runtime.turnRegistry, turnRegistry);
    assert.strictEqual(runtime.sessionRpc, sessionRpc);
    assert.strictEqual(serviceDependencies.attemptCoordinator, coordinator);
    assert.equal(registryDependencies.executionEpochId, executionEpochId);
    assert.strictEqual(sessionDependencies.inspectActiveTurn(launch.sessionId), activeTurn);
    assert.equal(await sessionDependencies.inspectDurableTurn('session-durable'), null);
    assert.deepEqual(inspectedSessions, ['session-durable']);
    assert.equal(await sessionDependencies.dismissRetry({
      sessionId: 'session-retry',
      turnAttemptId: 'turn-retry',
    }), true);
    assert.equal(await sessionDependencies.discardDamagedRecovery('session-damaged'), 3);
    assert.deepEqual(retryInputs, [{
      sessionId: 'session-retry',
      turnAttemptId: 'turn-retry',
    }]);
    assert.deepEqual(discardedSessions, ['session-damaged']);
    sessionDependencies.notifySessionDeleted('session-deleted');
    assert.deepEqual(notifiedSessions, ['session-deleted']);

    const result = await registryDependencies.runTurn(launch, {
      signal: new AbortController().signal,
      emit() {},
      bind() {},
    });
    assert.deepEqual(result, terminalResult(launch));
    assert.deepEqual(turnRuns, [launch]);
    const releaseTurnLease = registryDependencies.releaseTurnLease;
    assert.ok(releaseTurnLease, 'runtime must wire the coordinator lease release');
    await releaseTurnLease({
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      executionEpochId,
    });
    assert.deepEqual(released, [{
      sessionId: launch.sessionId,
      turnAttemptId: launch.turnAttemptId,
      executionEpochId,
    }]);
  });
});

function requireCaptured<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Expected ${label} during runtime construction.`);
  return value;
}
