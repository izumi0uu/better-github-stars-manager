import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  parseScopeFingerprintV1,
  type BgsmAgentConversationBinding,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';
import {
  attachBgsmAgentTurnPort,
  createBgsmAgentTurnRegistry,
} from '@/background/bgsm-agent-turn-port';
import type {
  BgsmAgentTurnAckDisposition,
  BgsmAgentTurnLaunch,
  BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';
import { AGENT_CONTEXT_CAPABILITY_REQUIRED } from '@/api/errors';

type Listener<T> = (value: T) => void;

const conversationBinding: BgsmAgentConversationBinding = {
  version: 1,
  candidateContract: {
    kind: 'selected_repository',
    selectedRepositoryIdHint: 'owner/repo',
  },
  scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
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
      messagesOfType(stale.posted, 'bgsmAgentTurnResult')[0]?.result.reason,
      'attempt_state_lost',
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
      messagesOfType(resumed.posted, 'bgsmAgentTurnResult')[0]?.result.reason,
      'attempt_state_lost',
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
      async runTurn(input) {
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
      async runTurn(input) {
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
      async runTurn(input) {
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
    assert.equal(messagesOfType(conflicting.posted, 'bgsmAgentTurnEvent').length, 0);
  });

  it('returns isolated active-turn snapshots and hides an acknowledged attempt', async () => {
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-inspection',
      translateError: async () => 'failed',
      releaseTurnLease: () => new Promise(() => {}),
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
