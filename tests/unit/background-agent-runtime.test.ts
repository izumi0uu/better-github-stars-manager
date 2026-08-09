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
    const abandonedAttempts: Array<{ sessionId: string; turnAttemptId: string }> = [];
    const restoredTurns: BgsmAgentTurnLaunch[] = [];
    const rolledBackRecoveries: BgsmAgentTurnLaunch[] = [];
    const reservedSessions: string[] = [];
    const releasedReservations: string[] = [];
    let releaseConcurrentInspection!: () => void;
    const concurrentInspectionGate = new Promise<void>((resolve) => {
      releaseConcurrentInspection = resolve;
    });
    const turnRuns: BgsmAgentTurnLaunch[] = [];
    let durableAdmissionObserved = false;
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
        if (sessionId === 'session-concurrent') await concurrentInspectionGate;
        if (sessionId === 'session-restore-failure') {
          return {
            executionEpochId,
            launch: { ...launch, sessionId },
            artifactCoverage: [],
            artifactContinuation: null,
          };
        }
        return sessionId === 'session-durable' || sessionId === 'session-concurrent'
          ? { executionEpochId, launch, artifactCoverage: [], artifactContinuation: null }
          : null;
      },
      async rollbackRecoveryClaim(recoveredLaunch) {
        rolledBackRecoveries.push(structuredClone(recoveredLaunch));
        return true;
      },
      async markStateUncertain() { return false; },
      async abandonUncertainAttempt(input) {
        abandonedAttempts.push({ ...input });
        return true;
      },
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
      async run(input, options) {
        turnRuns.push(input);
        options.onDurableLeaseAcquired();
        return terminalResult(input);
      },
    };
    const activeTurn = { executionEpochId, launch };
    const reservations = new Map<string, symbol>();
    const turnRegistry: BgsmAgentTurnRegistry = {
      executionEpochId,
      inspectActiveTurn(sessionId) {
        return sessionId === launch.sessionId ? activeTurn : null;
      },
      reserveRecovery(sessionId) {
        const token = Symbol(sessionId);
        reservations.set(sessionId, token);
        reservedSessions.push(sessionId);
        return { sessionId, token };
      },
      restoreApprovedTurn(restoredLaunch, reservation) {
        assert.equal(reservations.get(reservation.sessionId), reservation.token);
        if (restoredLaunch.sessionId === 'session-restore-failure') {
          throw new Error('restore rejected');
        }
        restoredTurns.push(restoredLaunch);
        return { executionEpochId, launch: restoredLaunch };
      },
      releaseRecovery(reservation) {
        assert.equal(reservations.get(reservation.sessionId), reservation.token);
        reservations.delete(reservation.sessionId);
        releasedReservations.push(reservation.sessionId);
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
    assert.deepEqual(await sessionDependencies.inspectDurableTurn('session-durable'), {
      executionEpochId,
      launch,
      artifactCoverage: [],
      artifactContinuation: null,
    });
    assert.equal(await sessionDependencies.inspectDurableTurn('session-uncertain'), null);
    const firstConcurrentInspection = sessionDependencies.inspectDurableTurn('session-concurrent');
    const secondConcurrentInspection = sessionDependencies.inspectDurableTurn('session-concurrent');
    assert.strictEqual(firstConcurrentInspection, secondConcurrentInspection);
    releaseConcurrentInspection();
    await Promise.all([firstConcurrentInspection, secondConcurrentInspection]);
    await assert.rejects(
      () => sessionDependencies.inspectDurableTurn('session-restore-failure'),
      /restore rejected/,
    );
    assert.deepEqual(inspectedSessions, [
      'session-durable',
      'session-uncertain',
      'session-concurrent',
      'session-restore-failure',
    ]);
    assert.deepEqual(restoredTurns, [launch, launch]);
    assert.deepEqual(rolledBackRecoveries, [{ ...launch, sessionId: 'session-restore-failure' }]);
    assert.deepEqual(reservedSessions, [
      'session-durable',
      'session-uncertain',
      'session-concurrent',
      'session-restore-failure',
    ]);
    assert.deepEqual(releasedReservations, reservedSessions);
    assert.equal(await sessionDependencies.dismissRetry({
      sessionId: 'session-retry',
      turnAttemptId: 'turn-retry',
    }), true);
    assert.equal(await sessionDependencies.abandonUncertainAttempt({
      sessionId: 'session-uncertain',
      turnAttemptId: 'turn-uncertain',
    }), true);
    assert.equal(await sessionDependencies.discardDamagedRecovery('session-damaged'), 3);
    assert.deepEqual(retryInputs, [{
      sessionId: 'session-retry',
      turnAttemptId: 'turn-retry',
    }]);
    assert.deepEqual(abandonedAttempts, [{
      sessionId: 'session-uncertain',
      turnAttemptId: 'turn-uncertain',
    }]);
    assert.deepEqual(discardedSessions, ['session-damaged']);
    sessionDependencies.notifySessionDeleted('session-deleted');
    assert.deepEqual(notifiedSessions, ['session-deleted']);

    const result = await registryDependencies.runTurn(launch, {
      signal: new AbortController().signal,
      onDurableLeaseAcquired() {
        durableAdmissionObserved = true;
      },
      emit() {},
      bind() {},
    });
    assert.deepEqual(result, terminalResult(launch));
    assert.deepEqual(turnRuns, [launch]);
    assert.equal(durableAdmissionObserved, true);
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
    const fenceRestoredTurnFailure = registryDependencies.fenceRestoredTurnFailure;
    assert.ok(fenceRestoredTurnFailure, 'runtime must wire restored-runner rollback');
    await fenceRestoredTurnFailure(launch);
    assert.deepEqual(rolledBackRecoveries.at(-1), launch);
  });
});

function requireCaptured<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Expected ${label} during runtime construction.`);
  return value;
}
