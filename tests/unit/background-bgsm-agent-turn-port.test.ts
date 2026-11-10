import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  parseScopeFingerprint,
  type BgsmAgentConversationBinding,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';
import {
  attachBgsmAgentTurnPort,
  createBgsmAgentTurnRegistry,
} from '@/background/bgsm-agent-turn-port';
import { createAgentAttemptCoordinator } from '@/background/agent-attempt-coordinator';
import { createBgsmAgentTurnService } from '@/background/bgsm-agent-turn-service';
import type {
  BgsmAgentTurnAckDisposition,
  BgsmAgentTurnLaunch,
  BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';
import { AGENT_CONTEXT_CAPABILITY_REQUIRED } from '@/api/errors';
import {
  createAgentSession,
  releaseAgentSessionTurnLease,
} from '@/storage/agent-session-store';
import { db } from '@/storage/db';

type Listener<T> = (value: T) => void;

const conversationBinding: BgsmAgentConversationBinding = {
  version: 1,
  candidateContract: {
    kind: 'selected_repository',
    selectedRepositoryIdHint: 'owner/repo',
  },
  scopeFingerprint: parseScopeFingerprint(`fs:${'a'.repeat(43)}`),
  label: 'owner/repo',
  count: 1,
  providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
};

function fakePort() {
  const messageListeners: Array<Listener<unknown>> = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: unknown[] = [];
  let disconnected = false;
  return {
    port: {
      postMessage(message: unknown) { posted.push(message); },
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        disconnectListeners.forEach((listener) => listener());
      },
      onMessage: {
        addListener(listener: Listener<unknown>) { messageListeners.push(listener); },
        removeListener() {},
        hasListener() { return false; },
        hasListeners() { return messageListeners.length > 0; },
      },
      onDisconnect: {
        addListener(listener: () => void) { disconnectListeners.push(listener); },
        removeListener() {},
        hasListener() { return false; },
        hasListeners() { return disconnectListeners.length > 0; },
      },
    },
    posted,
    get disconnected() { return disconnected; },
    deliver(message: unknown) { messageListeners.forEach((listener) => listener(message)); },
    start(
      input: BgsmAgentTurnInput | BgsmAgentTurnLaunch,
      options: Readonly<{ resumeOnly?: true }> = {},
    ) {
      const hello = posted.find((message) => (
        (message as { type?: string }).type === 'bgsmAgentTurnHello'
      )) as { executionEpochId: string } | undefined;
      if (!hello) throw new Error('expected Agent worker handshake');
      messageListeners.forEach((listener) => listener({
        type: 'startBgsmAgentTurn',
        executionEpochId: hello.executionEpochId,
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        prompt: input.prompt,
        ...(input.candidateContract ? { candidateContract: input.candidateContract } : {}),
        ...(options.resumeOnly ? { resumeOnly: true } : {}),
      }));
    },
    acknowledge(
      input: BgsmAgentTurnInput,
      appliedRevision: number | null = null,
      disposition: BgsmAgentTurnAckDisposition = appliedRevision === null
        ? 'no_transition'
        : 'applied',
    ) {
      const hello = posted[0] as { executionEpochId: string };
      messageListeners.forEach((listener) => listener({
        type: 'ackBgsmAgentTurnResult',
        executionEpochId: hello.executionEpochId,
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        disposition,
        appliedRevision,
      }));
      if (!posted.some((message) => (
        (message as { type?: string }).type === 'bgsmAgentTurnAck'
      ))) throw new Error('expected Agent acknowledgement confirmation');
      if (!disconnected) {
        disconnected = true;
        disconnectListeners.forEach((listener) => listener());
      }
    },
  };
}

describe('Cubby turn Port ownership', () => {
  for (const restoredStop of [false, true]) {
    it(`settles ${restoredStop ? 'restored' : 'admission-gated'} Stop in the real turn service before provider preparation`, async () => {
      await db.delete();
      await db.open();
      try {
        const created = await createAgentSession({ idFactory: () => 'session-service-stop' });
        const launch: BgsmAgentTurnLaunch = {
          sessionId: created.session.id, turnAttemptId: 'attempt-service-stop',
          baseRevision: 0, prompt: 'Read repositories.',
        };
        const coordinator = createAgentAttemptCoordinator('worker-service-stop');
        if (restoredStop) {
          await coordinator.admit(launch, 'statically_read_only');
          await coordinator.requestStop(launch);
        }
        let providerCalls = 0;
        const unexpected = () => { throw new Error('Stopped turn reached execution dependencies.'); };
        const service = createBgsmAgentTurnService({
          attemptCoordinator: coordinator,
          prepareRuntimeProvider: () => { providerCalls += 1; return unexpected(); },
          invalidateProviderCapability: unexpected,
          resolveLiveCandidate: unexpected,
          getActiveOrganizeJob: unexpected,
          isOrganizeApplyBlockingWrites: unexpected,
          createTagAssignmentPolicy: unexpected,
          assignManualTags: unexpected,
          removeVisibleTags: unexpected,
          deleteTagsEverywhere: unexpected,
          broadcastDataChanged: unexpected,
          providerTraceIdentity: unexpected,
        });
        const controller = new AbortController();
        const result = await service.run(launch, {
          signal: controller.signal,
          async onDurableLeaseAcquired() {
            assert.equal(await coordinator.requestStop(launch), true);
            if (!restoredStop) controller.abort();
          },
        });
        assert.equal(result.reason, 'aborted');
        assert.equal(result.commit, null);
        assert.equal(providerCalls, 0);
        const stored = (await db.agentAttempts.toArray())[0]!;
        assert.equal(stored.state, 'retryable');
        assert.equal(stored.retryKind, 'stopped');
        assert.equal(stored.writeSettlement, 'none');
        assert.equal(stored.lease, null);
      } finally {
        await db.delete();
      }
    });
  }

  for (const stopBeforeAdmission of [false, true]) {
    it(`persists Stop before aborting ${stopBeforeAdmission ? 'admitting' : 'running'} work and fences replacement`, async () => {
      await db.delete();
      await db.open();
      try {
        const created = await createAgentSession({ idFactory: () => 'session-port-durable-stop' });
        const launch: BgsmAgentTurnLaunch = {
          sessionId: created.session.id, turnAttemptId: 'attempt-port-durable-stop',
          baseRevision: 0, prompt: 'Read the scoped repositories.',
        };
        const coordinator = createAgentAttemptCoordinator('worker-port-stop');
        let releaseAdmission!: () => void;
        const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
        let releaseStop!: () => void;
        const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
        let stopCalls = 0;
        let providerCalls = 0;
        let admitted = false;
        let aborted = false;
        const registry = createBgsmAgentTurnRegistry({
          executionEpochId: 'worker-port-stop',
          translateError: async () => 'failed',
          requestTurnStop: async (input) => {
            stopCalls += 1;
            await stopGate;
            return coordinator.requestStop(input);
          },
          runTurn: async (input, options) => {
            options.signal.addEventListener('abort', () => { aborted = true; });
            if (stopBeforeAdmission) await admissionGate;
            await coordinator.admit(input, 'statically_read_only');
            admitted = true;
            await options.onDurableLeaseAcquired();
            if (!options.signal.aborted) providerCalls += 1;
            // Simulate worker loss after Stop, before terminal settlement.
            return new Promise<BgsmAgentTurnResult>(() => {});
          },
        });
        const transport = fakePort();
        registry.attach(transport.port);
        transport.start(launch);
        if (!stopBeforeAdmission) await waitUntil(() => providerCalls === 1);
        const stop = {
          type: 'stopBgsmAgentTurn', executionEpochId: registry.executionEpochId,
          sessionId: launch.sessionId, turnAttemptId: launch.turnAttemptId,
          baseRevision: launch.baseRevision,
        };
        transport.deliver({ ...stop, executionEpochId: 'worker-stale' });
        transport.deliver({ ...stop, sessionId: 'session-stale' });
        assert.equal(stopCalls, 0);
        transport.deliver(stop);
        transport.deliver(stop);
        if (stopBeforeAdmission) {
          assert.equal(stopCalls, 0);
          releaseAdmission();
        }
        await waitUntil(() => admitted && stopCalls === 1);
        assert.equal(aborted, false);
        assert.equal((await db.agentAttempts.toArray())[0]?.state, 'running');
        releaseStop();
        await waitUntil(() => aborted);
        assert.equal(stopCalls, 1);
        assert.equal(providerCalls, stopBeforeAdmission ? 0 : 1);
        assert.equal((await db.agentAttempts.toArray())[0]?.state, 'stop_pending');
        transport.deliver(stop);
        assert.equal(stopCalls, 1);
        assert.equal(await createAgentAttemptCoordinator('worker-port-replacement')
          .inspectActive(launch.sessionId), null);
        assert.equal((await db.agentAttempts.toArray())[0]?.state, 'state_uncertain');
        assert.equal(providerCalls, stopBeforeAdmission ? 0 : 1);
        transport.port.disconnect();
      } finally {
        await db.delete();
      }
    });
  }

  it('does not turn a rejected Stop into an aborted terminal or retry acceptance', async () => {
    const transport = fakePort();
    let signal!: AbortSignal;
    let finish!: (result: BgsmAgentTurnResult) => void;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-stop-rejected',
      translateError: async () => 'failed',
      requestTurnStop: async () => false,
      runTurn: async (_input, options) => {
        signal = options.signal;
        await options.onDurableLeaseAcquired();
        return new Promise<BgsmAgentTurnResult>((resolve) => { finish = resolve; });
      },
    });
    const launch = {
      sessionId: 'session-stop-rejected', turnAttemptId: 'attempt-stop-rejected',
      baseRevision: 0, prompt: 'Read repositories.',
    };
    registry.attach(transport.port);
    transport.start(launch);
    await waitUntil(() => !!finish);
    transport.deliver({
      type: 'stopBgsmAgentTurn', executionEpochId: registry.executionEpochId,
      sessionId: launch.sessionId, turnAttemptId: launch.turnAttemptId, baseRevision: 0,
    });
    await Promise.resolve();
    assert.equal(signal.aborted, false);
    finish({
      sessionId: launch.sessionId, turnAttemptId: launch.turnAttemptId, baseRevision: 0,
      reason: 'final_answer', changed: false, changedCount: 0, commit: null,
    });
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    assert.equal(messagesOfType(transport.posted, 'bgsmAgentTurnResult')[0]!.result.reason, 'final_answer');
  });

  it('restores one coordinator-approved runner across concurrent inspection subscribers', () => {
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-restored',
      translateError: async () => 'failed',
      runTurn: async () => {
        runCount += 1;
        return new Promise<BgsmAgentTurnResult>(() => {});
      },
    });
    const launch: BgsmAgentTurnLaunch = {
      turnAttemptId: 'turn-attempt-restored',
      sessionId: 'session-restored',
      baseRevision: 3,
      prompt: 'Continue the approved read-only attempt.',
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
    };

    const reservation = registry.reserveRecovery(launch.sessionId);
    const firstRestore = registry.restoreApprovedTurn(launch, reservation);
    const secondRestore = registry.restoreApprovedTurn(structuredClone(launch), reservation);
    registry.releaseRecovery(reservation);
    const firstSubscriber = fakePort();
    const secondSubscriber = fakePort();
    registry.attach(firstSubscriber.port);
    registry.attach(secondSubscriber.port);
    firstSubscriber.start(firstRestore.launch, { resumeOnly: true });
    secondSubscriber.start(secondRestore.launch, { resumeOnly: true });

    assert.equal(firstRestore.executionEpochId, 'worker-restored');
    assert.equal(runCount, 1);
    assert.deepEqual(firstRestore, secondRestore);
    assert.deepEqual(
      messagesOfType(firstSubscriber.posted, 'bgsmAgentTurnEvent').map((message) => message.event.type),
      ['agent_queued'],
    );
    assert.deepEqual(
      messagesOfType(secondSubscriber.posted, 'bgsmAgentTurnEvent').map((message) => message.event.type),
      ['agent_queued'],
    );
  });

  it('fences an asynchronously rejected restored runner before admitting fresh authority', async () => {
    const restoredLaunch: BgsmAgentTurnLaunch = {
      turnAttemptId: 'turn-restored-async-failure',
      sessionId: 'session-restored-async-failure',
      baseRevision: 2,
      prompt: 'Resume the claimed read-only turn.',
    };
    let durableState: 'running' | 'state_uncertain' = 'running';
    let restoredRunCount = 0;
    let freshRunCount = 0;
    let providerCallCount = 0;
    let fenceCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-restored-async-failure',
      translateError: async () => 'The previous turn could not be resumed safely.',
      async fenceRestoredTurnFailure(input) {
        assert.deepEqual(input, restoredLaunch);
        assert.equal(durableState, 'running');
        fenceCount += 1;
        await Promise.resolve();
        durableState = 'state_uncertain';
        return true;
      },
      releaseTurnLease() {
        return durableState !== 'running';
      },
      async runTurn(input) {
        if (input.turnAttemptId === restoredLaunch.turnAttemptId) {
          restoredRunCount += 1;
          await Promise.resolve();
          throw new Error('Injected pre-admission recovery failure.');
        }
        freshRunCount += 1;
        if (durableState === 'state_uncertain') {
          throw Object.assign(new Error('The durable turn is still active.'), {
            code: 'agent_session_turn_active',
          });
        }
        providerCallCount += 1;
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });

    const reservation = registry.reserveRecovery(restoredLaunch.sessionId);
    registry.restoreApprovedTurn(restoredLaunch, reservation);
    registry.releaseRecovery(reservation);
    const restored = fakePort();
    registry.attach(restored.port);
    restored.start(restoredLaunch, { resumeOnly: true });
    await waitUntil(() => messagesOfType(restored.posted, 'bgsmAgentTurnError').length === 1);

    assert.equal(fenceCount, 1);
    assert.equal(restoredRunCount, 1);
    assert.equal(providerCallCount, 0);
    assert.equal(durableState, 'state_uncertain');
    assert.equal(
      messagesOfType(restored.posted, 'bgsmAgentTurnError')[0]!.error.code,
      'agent_attempt_state_lost',
    );
    restored.acknowledge({ ...restoredLaunch, history: [] });
    await waitUntil(() => registry.inspectActiveTurn(restoredLaunch.sessionId) === null);

    const fresh = fakePort();
    registry.attach(fresh.port);
    fresh.start({
      ...restoredLaunch,
      turnAttemptId: 'turn-fresh-after-async-failure',
      prompt: 'Do not bypass uncertain authority.',
    });
    await waitUntil(() => messagesOfType(fresh.posted, 'bgsmAgentTurnError').length === 1);

    assert.equal(freshRunCount, 1);
    assert.equal(restoredRunCount, 1);
    assert.equal(providerCallCount, 0);
    assert.equal(fenceCount, 1);
    assert.equal(
      messagesOfType(fresh.posted, 'bgsmAgentTurnError')[0]!.error.code,
      'agent_session_turn_active',
    );
  });

  it('blocks competing starts during recovery and rejects conflicting or tombstoned restores', async () => {
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-recovery-guard',
      translateError: async () => 'failed',
      runTurn: async (input) => {
        runCount += 1;
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });
    const launch: BgsmAgentTurnLaunch = {
      turnAttemptId: 'turn-recovery-guard',
      sessionId: 'session-recovery-guard',
      baseRevision: 0,
      prompt: 'Restore only approved work.',
    };
    const reservation = registry.reserveRecovery(launch.sessionId);
    const competitor = fakePort();
    registry.attach(competitor.port);
    competitor.start({ ...launch, turnAttemptId: 'turn-competing' });
    assert.equal(runCount, 0);
    assert.equal(
      messagesOfType(competitor.posted, 'bgsmAgentTurnError')[0]?.error.code,
      'agent_session_turn_active',
    );

    registry.restoreApprovedTurn(launch, reservation);
    assert.throws(
      () => registry.restoreApprovedTurn({ ...launch, turnAttemptId: 'turn-conflicting' }, reservation),
      /different Agent turn/i,
    );
    registry.releaseRecovery(reservation);
    const subscriber = fakePort();
    registry.attach(subscriber.port);
    subscriber.start(launch, { resumeOnly: true });
    await waitUntil(() => messagesOfType(subscriber.posted, 'bgsmAgentTurnResult').length === 1);
    subscriber.acknowledge({ ...launch, history: [] });
    await waitUntil(() => registry.inspectActiveTurn(launch.sessionId) === null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tombstoneReservation = registry.reserveRecovery(launch.sessionId);
    assert.throws(
      () => registry.restoreApprovedTurn(launch, tombstoneReservation),
      /already finalized/i,
    );
    registry.releaseRecovery(tombstoneReservation);
    assert.equal(runCount, 1);
  });

  it('rejects a different launch against one active session with the typed conflict', () => {
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-active-conflict',
      translateError: async () => 'failed',
      async runTurn() {
        runCount += 1;
        return new Promise<BgsmAgentTurnResult>(() => {});
      },
    });
    const active: BgsmAgentTurnLaunch = {
      turnAttemptId: 'turn-active-conflict',
      sessionId: 'session-active-conflict',
      baseRevision: 0,
      prompt: 'Keep this launch active.',
    };
    const owner = fakePort();
    registry.attach(owner.port);
    owner.start(active);
    const competitor = fakePort();
    registry.attach(competitor.port);
    competitor.start({
      ...active,
      turnAttemptId: 'turn-active-conflict-competitor',
      prompt: 'Do not replace the active launch.',
    });

    assert.equal(runCount, 1);
    assert.equal(
      messagesOfType(competitor.posted, 'bgsmAgentTurnError')[0]?.error.code,
      'agent_session_turn_active',
    );
    assert.equal(messagesOfType(competitor.posted, 'bgsmAgentTurnResult').length, 0);
  });

  it('rejects a different launch immediately while the admitted winner Provider is held', async () => {
    await db.delete();
    await db.open();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    try {
      const created = await createAgentSession({ idFactory: () => 'session-admitted-held-winner' });
      const executionEpochId = 'worker-admitted-held-winner';
      const coordinator = createAgentAttemptCoordinator(executionEpochId);
      let runnerCount = 0;
      let providerCallCount = 0;
      const registry = createBgsmAgentTurnRegistry({
        executionEpochId,
        translateError: async (error) => error instanceof Error ? error.message : 'failed',
        releaseTurnLease: (input) => coordinator.release(input),
        async runTurn(input, options) {
          runnerCount += 1;
          const { admission, launchDigest } = await coordinator.admit(
            input,
            'write_capable_or_unknown',
          );
          assert.equal(admission.kind, 'acquired');
          options.onDurableLeaseAcquired();
          providerCallCount += 1;
          await providerGate;
          await coordinator.settleWithoutTransition({
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            launchDigest,
            outcome: {
              reason: 'aborted',
              changed: false,
              changedCount: 0,
              writeSettlement: 'none',
            },
          });
          return {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            reason: 'aborted',
            changed: false,
            changedCount: 0,
            commit: null,
          };
        },
      });
      const winner: BgsmAgentTurnLaunch = {
        turnAttemptId: 'turn-admitted-held-winner',
        sessionId: created.session.id,
        baseRevision: created.session.revision,
        prompt: 'Hold the admitted winner at the Provider boundary.',
        candidateContract: {
          kind: 'selected_repository',
          selectedRepositoryIdHint: 'owner/repo',
        },
      };
      const owner = fakePort();
      registry.attach(owner.port);
      owner.start(winner);
      await waitUntil(() => (
        providerCallCount === 1
        || messagesOfType(owner.posted, 'bgsmAgentTurnError').length === 1
      ));
      assert.deepEqual(messagesOfType(owner.posted, 'bgsmAgentTurnError'), []);
      const durableWinner = await db.agentAttempts
        .where('[sessionId+turnAttemptId]')
        .equals([winner.sessionId, winner.turnAttemptId])
        .first();
      assert.equal(durableWinner?.state, 'running');

      const competitor = fakePort();
      registry.attach(competitor.port);
      competitor.start({
        ...winner,
        turnAttemptId: 'turn-admitted-held-competitor',
        prompt: 'Reject this distinct launch without waiting for the winner.',
      });

      const conflict = messagesOfType(competitor.posted, 'bgsmAgentTurnError');
      assert.equal(conflict.length, 1);
      assert.deepEqual(conflict[0]!.error, {
        turnAttemptId: 'turn-admitted-held-competitor',
        sessionId: winner.sessionId,
        baseRevision: winner.baseRevision,
        message: 'Another Cubby turn is already active for this conversation.',
        category: 'other',
        code: 'agent_session_turn_active',
      });
      assert.equal(runnerCount, 1);
      assert.equal(providerCallCount, 1);
      assert.equal(await db.agentAttempts.count(), 1);
      assert.equal(messagesOfType(owner.posted, 'bgsmAgentTurnError').length, 0);

      const subscriber = fakePort();
      registry.attach(subscriber.port);
      subscriber.start(winner, { resumeOnly: true });
      assert.deepEqual(
        messagesOfType(subscriber.posted, 'bgsmAgentTurnEvent').map((message) => message.event.type),
        ['agent_queued'],
      );
      assert.equal(runnerCount, 1);
      assert.equal(providerCallCount, 1);

      releaseProvider();
      await waitUntil(() => messagesOfType(owner.posted, 'bgsmAgentTurnResult').length === 1);
      owner.acknowledge({ ...winner, history: [] });
      owner.port.disconnect();
      subscriber.port.disconnect();
      competitor.port.disconnect();
    } finally {
      releaseProvider();
      await db.delete();
    }
  });

  it('reattaches a resume-only launch without starting a second runner', () => {
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-resume',
      translateError: async () => 'failed',
      runTurn: async () => {
        runCount += 1;
        return new Promise<BgsmAgentTurnResult>(() => {});
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-resume',
      sessionId: 'session-resume',
      baseRevision: 0,
      prompt: 'Resume the active request',
      history: [],
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
    };
    const original = fakePort();
    registry.attach(original.port);
    original.start(input);
    const active = registry.inspectActiveTurn(input.sessionId);
    assert.ok(active);

    original.port.disconnect();
    const resumed = fakePort();
    registry.attach(resumed.port);
    resumed.start(active.launch, { resumeOnly: true });

    assert.equal(runCount, 1);
    assert.deepEqual(
      messagesOfType(resumed.posted, 'bgsmAgentTurnEvent').map((message) => message.event.type),
      ['agent_queued'],
    );

    const stale = fakePort();
    registry.attach(stale.port);
    stale.start({ ...active.launch, prompt: 'A different launch fingerprint' }, { resumeOnly: true });

    assert.equal(runCount, 1);
    assert.equal(
      messagesOfType(stale.posted, 'bgsmAgentTurnError')[0]?.error.code,
      'agent_session_turn_active',
    );
  });


  it('does not start a runner when a resume-only launch outlives its attempt', async () => {
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-cleanup-race',
      terminalAttemptAckGraceMs: 0,
      translateError: async () => 'failed',
      async runTurn(input) {
        runCount += 1;
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-cleanup-race',
      sessionId: 'session-cleanup-race',
      baseRevision: 0,
      prompt: 'Finish before the refreshed page attaches',
      history: [],
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
    };
    const original = fakePort();
    registry.attach(original.port);
    original.start(input);
    await waitUntil(() => messagesOfType(original.posted, 'bgsmAgentTurnResult').length === 1);
    const inspected = registry.inspectActiveTurn(input.sessionId);
    assert.ok(inspected);

    original.port.disconnect();
    await waitUntil(() => registry.inspectActiveTurn(input.sessionId) === null);
    const resumed = fakePort();
    registry.attach(resumed.port);
    resumed.start(inspected.launch, { resumeOnly: true });

    assert.equal(runCount, 1);
    assert.equal(
      messagesOfType(resumed.posted, 'bgsmAgentTurnError')[0]?.error.code,
      'agent_session_turn_active',
    );
  });

  it('admits concurrent identical attempt IDs through one runner after terminal lease cleanup', async () => {
    let releaseOldLease!: () => void;
    const oldLease = new Promise<void>((resolve) => {
      releaseOldLease = resolve;
    });
    let releaseCount = 0;
    let newRunCount = 0;
    const oldAttemptId = 'turn-attempt-concurrent-old';
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-concurrent-identical',
      terminalAttemptAckGraceMs: 60_000,
      translateError: async () => 'failed',
      releaseTurnLease(input) {
        releaseCount += 1;
        return input.turnAttemptId === oldAttemptId ? oldLease : undefined;
      },
      async runTurn(input, options) {
        options.onDurableLeaseAcquired();
        if (input.turnAttemptId === oldAttemptId) {
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
        newRunCount += 1;
        return new Promise<BgsmAgentTurnResult>(() => {});
      },
    });
    const oldInput: BgsmAgentTurnInput = {
      turnAttemptId: oldAttemptId,
      sessionId: 'session-concurrent-identical',
      baseRevision: 0,
      prompt: 'Finish the previous request',
      history: [],
    };
    const oldTransport = fakePort();
    registry.attach(oldTransport.port);
    oldTransport.start(oldInput);
    await waitUntil(() => messagesOfType(oldTransport.posted, 'bgsmAgentTurnResult').length === 1);
    oldTransport.port.disconnect();

    const nextInput: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-concurrent-next',
      sessionId: oldInput.sessionId,
      baseRevision: 1,
      prompt: 'Start exactly once',
      history: [],
    };
    const first = fakePort();
    const second = fakePort();
    registry.attach(first.port);
    registry.attach(second.port);
    first.start(nextInput);
    second.start(nextInput);
    await waitUntil(() => releaseCount === 1);

    assert.equal(newRunCount, 0);
    releaseOldLease();
    await waitUntil(() => (
      messagesOfType(first.posted, 'bgsmAgentTurnEvent').length === 1
      && messagesOfType(second.posted, 'bgsmAgentTurnEvent').length === 1
    ));

    assert.equal(newRunCount, 1);
    assert.deepEqual(
      messagesOfType(first.posted, 'bgsmAgentTurnEvent').map((message) => message.event.type),
      ['agent_queued'],
    );
    assert.deepEqual(
      messagesOfType(second.posted, 'bgsmAgentTurnEvent').map((message) => message.event.type),
      ['agent_queued'],
    );
    assert.equal(messagesOfType(first.posted, 'bgsmAgentTurnError').length, 0);
    assert.equal(messagesOfType(second.posted, 'bgsmAgentTurnError').length, 0);
  });

  it('rejects admission when recovery reserves the session during awaited lease cleanup', async () => {
    let releaseOldLease!: () => void;
    const oldLease = new Promise<void>((resolve) => {
      releaseOldLease = resolve;
    });
    let releaseCount = 0;
    let newRunCount = 0;
    const oldAttemptId = 'turn-attempt-recovery-fence-old';
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-recovery-fence',
      terminalAttemptAckGraceMs: 60_000,
      translateError: async () => 'failed',
      releaseTurnLease(input) {
        releaseCount += 1;
        return input.turnAttemptId === oldAttemptId ? oldLease : undefined;
      },
      async runTurn(input, options) {
        options.onDurableLeaseAcquired();
        if (input.turnAttemptId === oldAttemptId) {
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
        newRunCount += 1;
        return new Promise<BgsmAgentTurnResult>(() => {});
      },
    });
    const oldInput: BgsmAgentTurnInput = {
      turnAttemptId: oldAttemptId,
      sessionId: 'session-recovery-fence',
      baseRevision: 0,
      prompt: 'Finish before recovery begins',
      history: [],
    };
    const oldTransport = fakePort();
    registry.attach(oldTransport.port);
    oldTransport.start(oldInput);
    await waitUntil(() => messagesOfType(oldTransport.posted, 'bgsmAgentTurnResult').length === 1);
    oldTransport.port.disconnect();

    const nextInput: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-recovery-fence-next',
      sessionId: oldInput.sessionId,
      baseRevision: 1,
      prompt: 'Must not race the replacement recovery',
      history: [],
    };
    const next = fakePort();
    registry.attach(next.port);
    next.start(nextInput);
    await waitUntil(() => releaseCount === 1);
    assert.equal(newRunCount, 0);

    const reservation = registry.reserveRecovery(nextInput.sessionId);
    releaseOldLease();
    await waitUntil(() => messagesOfType(next.posted, 'bgsmAgentTurnError').length === 1);

    assert.equal(newRunCount, 0);
    assert.equal(
      messagesOfType(next.posted, 'bgsmAgentTurnError')[0]!.error.code,
      'agent_session_turn_active',
    );
    assert.equal(registry.inspectActiveTurn(nextInput.sessionId), null);
    registry.releaseRecovery(reservation);
  });

  it('aborts a pending admission without starting its runner while terminal lease cleanup is blocked', async () => {
    let releaseOldLease!: () => void;
    const oldLease = new Promise<void>((resolve) => {
      releaseOldLease = resolve;
    });
    let releaseCount = 0;
    let newRunCount = 0;
    const oldAttemptId = 'turn-attempt-stop-pending-old';
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-stop-pending',
      terminalAttemptAckGraceMs: 60_000,
      translateError: async () => 'failed',
      releaseTurnLease(input) {
        releaseCount += 1;
        return input.turnAttemptId === oldAttemptId ? oldLease : undefined;
      },
      async runTurn(input, options) {
        options.onDurableLeaseAcquired();
        if (input.turnAttemptId === oldAttemptId) {
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
        newRunCount += 1;
        return new Promise<BgsmAgentTurnResult>(() => {});
      },
    });
    const oldInput: BgsmAgentTurnInput = {
      turnAttemptId: oldAttemptId,
      sessionId: 'session-stop-pending',
      baseRevision: 0,
      prompt: 'Finish the previous request',
      history: [],
    };
    const oldTransport = fakePort();
    registry.attach(oldTransport.port);
    oldTransport.start(oldInput);
    await waitUntil(() => messagesOfType(oldTransport.posted, 'bgsmAgentTurnResult').length === 1);
    oldTransport.port.disconnect();

    const nextInput: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-stop-pending-next',
      sessionId: oldInput.sessionId,
      baseRevision: 1,
      prompt: 'Do not start after Stop',
      history: [],
    };
    const next = fakePort();
    registry.attach(next.port);
    next.start(nextInput);
    await waitUntil(() => releaseCount === 1);
    next.deliver({
      type: 'stopBgsmAgentTurn',
      executionEpochId: (next.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: nextInput.turnAttemptId,
      sessionId: 'wrong-session',
      baseRevision: nextInput.baseRevision,
    });
    assert.equal(newRunCount, 0);
    assert.equal(messagesOfType(next.posted, 'bgsmAgentTurnResult').length, 0);
    next.deliver({
      type: 'stopBgsmAgentTurn',
      executionEpochId: (next.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: nextInput.turnAttemptId,
      sessionId: nextInput.sessionId,
      baseRevision: nextInput.baseRevision,
    });

    releaseOldLease();
    await waitUntil(() => messagesOfType(next.posted, 'bgsmAgentTurnResult').length === 1);

    assert.equal(newRunCount, 0);
    assert.equal(messagesOfType(next.posted, 'bgsmAgentTurnError').length, 0);
    assert.deepEqual(messagesOfType(next.posted, 'bgsmAgentTurnResult')[0]!.result, {
      turnAttemptId: nextInput.turnAttemptId,
      sessionId: nextInput.sessionId,
      baseRevision: nextInput.baseRevision,
      reason: 'aborted',
      changed: false,
      changedCount: 0,
      commit: null,
    });
    assert.deepEqual(sequenceNumbers(next.posted), [0]);

    next.acknowledge(nextInput);
    await waitUntil(() => next.disconnected);
    assert.equal(messagesOfType(next.posted, 'bgsmAgentTurnAck').length, 1);
    assert.equal(registry.inspectActiveTurn(nextInput.sessionId), null);
  });

  it('drops a stopped pre-admission attempt without weakening production lease release', async () => {
    await db.delete();
    await db.open();
    try {
      const created = await createAgentSession({ idFactory: () => 'session-stop-before-admission' });
      const oldAttemptId = 'turn-stop-before-admission-old';
      const stoppedAttemptId = 'turn-stop-before-admission-stopped';
      let finishOldRelease!: () => void;
      const oldReleaseGate = new Promise<void>((resolve) => {
        finishOldRelease = resolve;
      });
      let oldReleaseCount = 0;
      const productionReleaseCalls: string[] = [];
      let runCount = 0;
      const registry = createBgsmAgentTurnRegistry({
        executionEpochId: 'worker-stop-before-admission',
        terminalAttemptAckGraceMs: 60_000,
        translateError: async () => 'failed',
        releaseTurnLease(input) {
          if (input.turnAttemptId === oldAttemptId) {
            oldReleaseCount += 1;
            return oldReleaseGate;
          }
          productionReleaseCalls.push(input.turnAttemptId);
          return releaseAgentSessionTurnLease(input);
        },
        async runTurn(input, options) {
          runCount += 1;
          if (input.turnAttemptId === oldAttemptId) {
            options.onDurableLeaseAcquired();
          }
          return {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            reason: 'final_answer',
            changed: false,
            changedCount: 0,
            commit: null,
          };
        },
      });
      const oldInput: BgsmAgentTurnInput = {
        turnAttemptId: oldAttemptId,
        sessionId: created.session.id,
        baseRevision: 0,
        prompt: 'Finish the old delivery before admitting another turn.',
        history: [],
      };
      const old = fakePort();
      registry.attach(old.port);
      old.start(oldInput);
      await waitUntil(() => messagesOfType(old.posted, 'bgsmAgentTurnResult').length === 1);
      old.port.disconnect();

      const stoppedInput: BgsmAgentTurnInput = {
        turnAttemptId: stoppedAttemptId,
        sessionId: created.session.id,
        baseRevision: 0,
        prompt: 'Stop before durable admission.',
        history: [],
      };
      const stopped = fakePort();
      registry.attach(stopped.port);
      stopped.start(stoppedInput);
      await waitUntil(() => oldReleaseCount === 1);
      stopped.deliver({
        type: 'stopBgsmAgentTurn',
        executionEpochId: registry.executionEpochId,
        turnAttemptId: stoppedInput.turnAttemptId,
        sessionId: stoppedInput.sessionId,
        baseRevision: stoppedInput.baseRevision,
      });
      assert.equal(runCount, 1);

      finishOldRelease();
      await waitUntil(() => messagesOfType(stopped.posted, 'bgsmAgentTurnResult').length === 1);
      assert.equal(messagesOfType(stopped.posted, 'bgsmAgentTurnResult')[0]!.result.reason, 'aborted');
      assert.equal(await db.agentAttempts.count(), 0);
      assert.equal(await releaseAgentSessionTurnLease({
        sessionId: stoppedInput.sessionId,
        turnAttemptId: stoppedInput.turnAttemptId,
        executionEpochId: registry.executionEpochId,
      }), false);

      stopped.acknowledge(stoppedInput);
      await waitUntil(() => registry.inspectActiveTurn(stoppedInput.sessionId) === null);

      const fresh = fakePort();
      registry.attach(fresh.port);
      fresh.start({
        ...stoppedInput,
        turnAttemptId: 'turn-stop-before-admission-fresh',
        prompt: 'Start after the synthetic stop is finalized.',
      });
      await waitUntil(() => messagesOfType(fresh.posted, 'bgsmAgentTurnResult').length === 1);
      assert.equal(runCount, 2);
      assert.equal(messagesOfType(fresh.posted, 'bgsmAgentTurnError').length, 0);
      assert.deepEqual(productionReleaseCalls, []);
    } finally {
      await db.delete();
    }
  });

  it('rejects the conflicting concurrent attempt-ID peer after terminal lease cleanup', async () => {
    let releaseOldLease!: () => void;
    const oldLease = new Promise<void>((resolve) => {
      releaseOldLease = resolve;
    });
    let releaseCount = 0;
    let newRunCount = 0;
    const oldAttemptId = 'turn-attempt-concurrent-conflict-old';
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-concurrent-conflict',
      terminalAttemptAckGraceMs: 60_000,
      translateError: async () => 'failed',
      releaseTurnLease(input) {
        releaseCount += 1;
        return input.turnAttemptId === oldAttemptId ? oldLease : undefined;
      },
      async runTurn(input, options) {
        options.onDurableLeaseAcquired();
        if (input.turnAttemptId === oldAttemptId) {
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
        newRunCount += 1;
        return new Promise<BgsmAgentTurnResult>(() => {});
      },
    });
    const oldInput: BgsmAgentTurnInput = {
      turnAttemptId: oldAttemptId,
      sessionId: 'session-concurrent-conflict',
      baseRevision: 0,
      prompt: 'Finish the previous request',
      history: [],
    };
    const oldTransport = fakePort();
    registry.attach(oldTransport.port);
    oldTransport.start(oldInput);
    await waitUntil(() => messagesOfType(oldTransport.posted, 'bgsmAgentTurnResult').length === 1);
    oldTransport.port.disconnect();

    const admittedInput: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-concurrent-conflict-next',
      sessionId: oldInput.sessionId,
      baseRevision: 1,
      prompt: 'Use the canonical prompt',
      history: [],
    };
    const conflictingInput = {
      ...admittedInput,
      prompt: 'Reuse the ID with different launch data',
    };
    const admitted = fakePort();
    const conflicting = fakePort();
    registry.attach(admitted.port);
    registry.attach(conflicting.port);
    admitted.start(admittedInput);
    conflicting.start(conflictingInput);
    await waitUntil(() => releaseCount === 1);

    assert.equal(newRunCount, 0);
    releaseOldLease();
    await waitUntil(() => (
      messagesOfType(admitted.posted, 'bgsmAgentTurnEvent').length === 1
      && messagesOfType(conflicting.posted, 'bgsmAgentTurnError').length === 1
    ));

    assert.equal(newRunCount, 1);
    assert.deepEqual(
      messagesOfType(admitted.posted, 'bgsmAgentTurnEvent').map((message) => message.event.type),
      ['agent_queued'],
    );
    assert.equal(messagesOfType(admitted.posted, 'bgsmAgentTurnError').length, 0);
    assert.match(
      messagesOfType(conflicting.posted, 'bgsmAgentTurnError')[0]!.error.message,
      /reused with conflicting launch data/,
    );
    assert.equal(
      messagesOfType(conflicting.posted, 'bgsmAgentTurnError')[0]!.error.code,
      'agent_session_attempt_conflict',
    );
    assert.equal(messagesOfType(conflicting.posted, 'bgsmAgentTurnEvent').length, 0);
  });

  it('returns isolated active-turn snapshots and hides an acknowledged attempt', async () => {
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-inspection',
      translateError: async () => 'failed',
      releaseTurnLease: () => new Promise(() => {}),
      async runTurn(input, options) {
        options.onDurableLeaseAcquired();
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-inspection',
      sessionId: 'session-inspection',
      baseRevision: 0,
      prompt: 'Inspect without sharing mutable launch state',
      history: [],
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
    };
    const transport = fakePort();
    registry.attach(transport.port);
    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);

    const first = registry.inspectActiveTurn(input.sessionId);
    assert.ok(first);
    const mutableLaunch = first.launch as {
      prompt: string;
      candidateContract?: { selectedRepositoryIdHint?: string };
    };
    mutableLaunch.prompt = 'mutated snapshot';
    if (mutableLaunch.candidateContract) {
      mutableLaunch.candidateContract.selectedRepositoryIdHint = 'other/repo';
    }

    const second = registry.inspectActiveTurn(input.sessionId);
    assert.ok(second);
    assert.notEqual(second.launch, first.launch);
    assert.equal(second.launch.prompt, input.prompt);
    assert.deepEqual(second.launch.candidateContract, input.candidateContract);

    transport.acknowledge(input);
    assert.equal(registry.inspectActiveTurn(input.sessionId), null);
  });

  it('keeps an acknowledged attempt hidden when its first lease release fails', async () => {
    let releaseCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-ack-release-failure',
      terminalAttemptAckGraceMs: 60_000,
      translateError: async () => 'failed',
      releaseTurnLease() {
        releaseCount += 1;
        if (releaseCount === 1) throw new Error('lease release failed');
        return new Promise(() => {});
      },
      async runTurn(input, options) {
        options.onDurableLeaseAcquired();
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-ack-release-failure',
      sessionId: 'session-ack-release-failure',
      baseRevision: 0,
      prompt: 'Acknowledge before cleanup fails',
      history: [],
    };
    const transport = fakePort();
    registry.attach(transport.port);
    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);

    transport.acknowledge(input);
    await waitUntil(() => releaseCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(registry.inspectActiveTurn(input.sessionId), null);
  });

  it('retains acquired terminal authority when durable release reports a live lease', async () => {
    let runCount = 0;
    let releaseCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-live-lease-release',
      terminalAttemptAckGraceMs: 60_000,
      translateError: async () => 'failed',
      releaseTurnLease() {
        releaseCount += 1;
        return false;
      },
      async runTurn(input, options) {
        runCount += 1;
        options.onDurableLeaseAcquired();
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-live-lease-release',
      sessionId: 'session-live-lease-release',
      baseRevision: 0,
      prompt: 'Do not drop unsettled durable authority.',
      history: [],
    };
    const transport = fakePort();
    registry.attach(transport.port);
    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    transport.acknowledge(input);
    await waitUntil(() => releaseCount === 1);

    const competitor = fakePort();
    registry.attach(competitor.port);
    competitor.start({
      ...input,
      turnAttemptId: 'turn-live-lease-release-competitor',
      prompt: 'This launch must remain blocked.',
    });
    await waitUntil(() => messagesOfType(competitor.posted, 'bgsmAgentTurnError').length === 1);

    assert.equal(runCount, 1);
    assert.equal(releaseCount >= 2, true);
    assert.equal(
      messagesOfType(competitor.posted, 'bgsmAgentTurnError')[0]!.error.code,
      'agent_session_turn_active',
    );
  });

  it('rejects malformed start envelopes instead of repairing them', () => {
    const transport = fakePort();
    let runCount = 0;
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'failed',
      async runTurn(input) {
        runCount += 1;
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });

    transport.deliver({
      type: 'startBgsmAgentTurn',
      executionEpochId: (transport.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: 'malformed-attempt',
      sessionId: 'strict-session',
      baseRevision: 0,
      prompt: 'Do not normalize me',
      history: [],
      unexpected: true,
    });

    assert.equal(runCount, 0);
    assert.equal(transport.disconnected, true);
    assert.deepEqual(transport.posted.map((message) => (message as { type: string }).type), [
      'bgsmAgentTurnHello',
    ]);
  });

  it.each(['no_transition', 'transition_rejected', 'detached'] as const)(
    'accepts and confirms a %s result acknowledgement without a revision',
    async (disposition) => {
      const transport = fakePort();
      attachBgsmAgentTurnPort(transport.port, {
        translateError: async () => 'failed',
        async runTurn(input) {
          return {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            reason: 'final_answer',
            changed: false,
            changedCount: 0,
            commit: null,
          };
        },
      });
      const input: BgsmAgentTurnInput = {
        turnAttemptId: `turn-attempt-ack-${disposition}`,
        sessionId: `session-ack-${disposition}`,
        baseRevision: 0,
        prompt: 'Acknowledge the terminal result',
        history: [],
        binding: conversationBinding,
      };

      transport.start(input);
      await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
      transport.acknowledge(input, null, disposition);

      assert.deepEqual(messagesOfType(transport.posted, 'bgsmAgentTurnAck')[0], {
        type: 'bgsmAgentTurnAck',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        disposition,
        appliedRevision: null,
      });
    },
  );

  it('carries only launch identity, prompt and a first-turn candidate through the Port', async () => {
    const transport = fakePort();
    let received: BgsmAgentTurnLaunch | undefined;
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'failed',
      async runTurn(input) {
        received = input;
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-candidate',
      sessionId: 'candidate-session',
      baseRevision: 0,
      prompt: 'Inspect the selected repository.',
      history: [{ id: 'must-not-cross', role: 'user', content: 'Old history', createdAt: 1 }],
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
    };

    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);

    assert.deepEqual(received, {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      prompt: input.prompt,
      candidateContract: input.candidateContract,
    });
    transport.acknowledge(input, input.baseRevision + 1);
    await waitUntil(() => transport.disconnected);
  });

  it('aborts through an identity-bound stop command and still delivers one terminal result', async () => {
    const transport = fakePort();
    let aborted = false;
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'failed',
      runTurn: async (input, options) => new Promise<BgsmAgentTurnResult>((resolve) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          options.emit({ type: 'agent_done', sessionId: input.sessionId, reason: 'aborted' });
          resolve({
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            reason: 'aborted',
            changed: false,
            changedCount: 0,
            commit: null,
          });
        }, { once: true });
      }),
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-stop',
      sessionId: 'stop-session',
      baseRevision: 5,
      prompt: 'Stop',
      history: [],
      binding: conversationBinding,
    };
    transport.start(input);
    transport.deliver({
      type: 'stopBgsmAgentTurn',
      executionEpochId: (transport.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: input.turnAttemptId,
      sessionId: 'wrong-session',
      baseRevision: input.baseRevision,
    });
    assert.equal(aborted, false);
    transport.deliver({
      type: 'stopBgsmAgentTurn',
      executionEpochId: (transport.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    });
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    transport.acknowledge(input);
    await waitUntil(() => transport.disconnected);

    assert.equal(aborted, true);
    const results = messagesOfType(transport.posted, 'bgsmAgentTurnResult');
    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.reason, 'aborted');
    assert.deepEqual(
      sequenceNumbers(transport.posted),
      sequenceNumbers(transport.posted).map((_sequence, index) => index),
    );
  });

  it('turns unresolved context capability into an actionable typed result', async () => {
    const transport = fakePort();
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'unused',
      async runTurn() {
        throw new Error(AGENT_CONTEXT_CAPABILITY_REQUIRED);
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-capability',
      sessionId: 'capability-session',
      baseRevision: 0,
      prompt: 'Inspect repositories',
      history: [],
      binding: conversationBinding,
    };
    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    transport.acknowledge(input);
    await waitUntil(() => transport.disconnected);

    assert.equal(messagesOfType(transport.posted, 'bgsmAgentTurnError').length, 0);
    const results = messagesOfType(transport.posted, 'bgsmAgentTurnResult');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.result, {
      turnAttemptId: 'turn-attempt-capability',
      sessionId: 'capability-session',
      baseRevision: 0,
      reason: 'context_limit',
      contextFailureReason: 'capability_unresolved',
      changed: false,
      changedCount: 0,
      commit: null,
    });
  });

  it('delivers a bounded terminal projection for a background-owned large turn', async () => {
    const transport = fakePort();
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async (error) => error instanceof Error ? error.message : String(error),
      async runTurn(input) {
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: {
            session: { id: input.sessionId, revision: input.baseRevision + 1 },
            summary: { id: input.sessionId, title: input.prompt, createdAt: 1, updatedAt: 2 },
            turnAttemptId: input.turnAttemptId,
            idempotent: false,
            appliedRevision: input.baseRevision + 1,
            digest: `asd:v1:${'a'.repeat(43)}`,
            launchDigest: `asl:v1:${'b'.repeat(43)}`,
            outcome: {
              reason: 'final_answer',
              changed: false,
              changedCount: 0,
              writeSettlement: 'none',
            },
            transcript: {
              sessionId: input.sessionId,
              messages: [
                { sequence: 1, id: 'guard-user', role: 'user', content: input.prompt, createdAt: 1 },
                { sequence: 2, id: 'guard-agent', role: 'agent', content: 'Committed in background.', createdAt: 2 },
              ],
              nextBeforeSequence: null,
            },
            presentationMessages: [
              { sequence: 1, id: 'guard-user', role: 'user', content: input.prompt, createdAt: 1 },
              { sequence: 2, id: 'guard-agent', role: 'agent', content: 'Committed in background.', createdAt: 2 },
            ],
          },
        };
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-transport-guard',
      sessionId: 'transport-guard-session',
      baseRevision: 0,
      prompt: 'Generate an oversized turn',
      history: [],
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
    };

    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    assert.equal(messagesOfType(transport.posted, 'bgsmAgentTurnError').length, 0);
    assert.equal(
      (messagesOfType(transport.posted, 'bgsmAgentTurnResult')[0]!.result.commit as { transcript: { messages: unknown[] } })
        .transcript.messages.length,
      2,
    );
  });
});

function messagesOfType<T extends string>(messages: unknown[], type: T) {
  return messages.filter((message): message is Record<string, any> & { type: T } => (
    !!message && typeof message === 'object' && (message as { type?: string }).type === type
  ));
}

function sequenceNumbers(messages: unknown[]): number[] {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const sequence = (message as { sequence?: unknown }).sequence;
    return typeof sequence === 'number' ? [sequence] : [];
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for background Port state.');
}
