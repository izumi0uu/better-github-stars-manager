import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { BgsmAgentTurnInput } from '@/bgsm-agent';
import {
  createBgsmAgentTurnRegistry,
  type BgsmAgentTurnRunner,
} from '@/background/bgsm-agent-turn-port';
import type { BgsmAgentTurnResult } from '@/utils/messaging';

type Listener<T> = (value: T) => void;

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
      },
      onDisconnect: {
        addListener(listener: () => void) { disconnectListeners.push(listener); },
      },
    },
    posted,
    get disconnected() { return disconnected; },
    deliver(message: unknown) { messageListeners.forEach((listener) => listener(message)); },
  };
}

function input(overrides: Partial<BgsmAgentTurnInput> = {}): BgsmAgentTurnInput {
  return {
    turnAttemptId: 'turn-attempt-1',
    sessionId: 'session-1',
    baseRevision: 0,
    prompt: 'Inspect current stars',
    history: [],
    candidateContract: { kind: 'selected_repository', selectedRepositoryIdHint: 'owner/repo' },
    ...overrides,
  };
}

function startMessage(turn: BgsmAgentTurnInput, executionEpochId = 'worker-epoch-1') {
  return { type: 'startBgsmAgentTurn', executionEpochId, ...turn };
}

function messagesOfType<T extends string>(messages: unknown[], type: T) {
  return messages.filter((message): message is Record<string, any> & { type: T } => (
    !!message && typeof message === 'object' && (message as { type?: string }).type === type
  ));
}

function deferredRunner() {
  let runCount = 0;
  let signal: AbortSignal | null = null;
  let resolve!: (result: BgsmAgentTurnResult) => void;
  const completion = new Promise<BgsmAgentTurnResult>((next) => { resolve = next; });
  const runner: BgsmAgentTurnRunner = async (_input, options) => {
    runCount += 1;
    signal = options.signal;
    return completion;
  };
  return {
    runner,
    resolve,
    get runCount() { return runCount; },
    get signal() { return signal; },
  };
}

describe('Cubby turn single-flight registry', () => {
  it('claims one content capture for a newly admitted root and closes it once at terminal', async () => {
    const run = deferredRunner();
    let factoryCalls = 0;
    let receivedCapture = false;
    const finishReasons: string[] = [];
    const contentCapture = {
      providerPrompt() {},
      providerResponse() {},
      toolArguments() {},
      toolResult() {},
      finish(reason: string) { finishReasons.push(reason); },
    };
    const registry = createBgsmAgentTurnRegistry({
      runTurn: async (turn, options) => {
        receivedCapture = options.contentCapture === contentCapture;
        return run.runner(turn, options);
      },
      translateError: async (error) => String(error),
      executionEpochId: 'worker-epoch-1',
      contentCaptureFactory: (start) => {
        factoryCalls += 1;
        assert.equal(start.rootOperationId, 'agent_turn:turn-attempt-1');
        return contentCapture;
      },
    });
    const turn = input();
    const first = fakePort();
    registry.attach(first.port);
    first.deliver(startMessage(turn));

    const duplicate = fakePort();
    registry.attach(duplicate.port);
    duplicate.deliver(startMessage(turn));
    assert.equal(factoryCalls, 1);
    assert.equal(receivedCapture, true);

    run.resolve({
      turnAttemptId: turn.turnAttemptId,
      sessionId: turn.sessionId,
      baseRevision: turn.baseRevision,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      newMessages: [],
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.deepEqual(finishReasons, ['final_answer']);
  });

  it('keeps one execution across disconnect and replays the unacknowledged result', async () => {
    const run = deferredRunner();
    const registry = createBgsmAgentTurnRegistry({
      runTurn: run.runner,
      translateError: async (error) => String(error),
      executionEpochId: 'worker-epoch-1',
    });
    const turn = input();
    const first = fakePort();
    registry.attach(first.port);
    first.deliver(startMessage(turn));
    assert.equal(run.runCount, 1);
    first.port.disconnect();
    assert.equal(run.signal?.aborted, false);

    run.resolve({
      turnAttemptId: turn.turnAttemptId,
      sessionId: turn.sessionId,
      baseRevision: turn.baseRevision,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      newMessages: [],
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const replay = fakePort();
    registry.attach(replay.port);
    replay.deliver(startMessage(turn));
    assert.equal(run.runCount, 1);
    assert.deepEqual(
      messagesOfType(replay.posted, 'bgsmAgentTurnEvent').map((message) => message.sequence),
      [0],
    );
    assert.equal(messagesOfType(replay.posted, 'bgsmAgentTurnResult').length, 1);

    replay.deliver({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: registry.executionEpochId,
      turnAttemptId: turn.turnAttemptId,
      sessionId: turn.sessionId,
      baseRevision: turn.baseRevision,
      disposition: 'applied',
      appliedRevision: turn.baseRevision + 1,
    });
    assert.deepEqual(messagesOfType(replay.posted, 'bgsmAgentTurnAck')[0], {
      type: 'bgsmAgentTurnAck',
      turnAttemptId: turn.turnAttemptId,
      sessionId: turn.sessionId,
      baseRevision: turn.baseRevision,
      disposition: 'applied',
      appliedRevision: turn.baseRevision + 1,
    });
    replay.port.disconnect();
    assert.equal(replay.disconnected, true);

    const stale = fakePort();
    registry.attach(stale.port);
    stale.deliver(startMessage(input({
      turnAttemptId: 'turn-attempt-stale-new-id',
    })));
    assert.equal(run.runCount, 1);
    assert.equal(
      messagesOfType(stale.posted, 'bgsmAgentTurnResult')[0]?.result.reason,
      'attempt_state_lost',
    );
  });

  it('attaches identical duplicates and rejects conflicting attempt reuse before execution', () => {
    const run = deferredRunner();
    const registry = createBgsmAgentTurnRegistry({
      runTurn: run.runner,
      translateError: async (error) => String(error),
      executionEpochId: 'worker-epoch-1',
    });
    const turn = input();
    const first = fakePort();
    registry.attach(first.port);
    first.deliver(startMessage(turn));

    const duplicate = fakePort();
    registry.attach(duplicate.port);
    duplicate.deliver(startMessage(turn));
    assert.equal(run.runCount, 1);
    assert.equal(messagesOfType(duplicate.posted, 'bgsmAgentTurnEvent').length, 1);

    const conflicting = fakePort();
    registry.attach(conflicting.port);
    conflicting.deliver(startMessage(input({ prompt: 'Different payload' })));
    assert.equal(run.runCount, 1);
    assert.match(
      messagesOfType(conflicting.posted, 'bgsmAgentTurnError')[0]?.error.message ?? '',
      /conflicting launch data/u,
    );
    conflicting.deliver({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: registry.executionEpochId,
      turnAttemptId: turn.turnAttemptId,
      sessionId: turn.sessionId,
      baseRevision: turn.baseRevision,
      disposition: 'no_transition',
      appliedRevision: null,
    });
    assert.equal(messagesOfType(conflicting.posted, 'bgsmAgentTurnAck').length, 1);

    const concurrent = fakePort();
    registry.attach(concurrent.port);
    concurrent.deliver(startMessage(input({ turnAttemptId: 'turn-attempt-2' })));
    assert.equal(run.runCount, 1);
    assert.equal(
      messagesOfType(concurrent.posted, 'bgsmAgentTurnResult')[0]?.result.reason,
      'attempt_state_lost',
    );

    const stillAttached = fakePort();
    registry.attach(stillAttached.port);
    stillAttached.deliver(startMessage(turn));
    assert.equal(run.runCount, 1);
    assert.equal(messagesOfType(stillAttached.posted, 'bgsmAgentTurnEvent').length, 1);
  });

  it('publishes a fallback terminal error when translation fails', async () => {
    const registry = createBgsmAgentTurnRegistry({
      runTurn: async () => {
        throw new Error('provider exploded');
      },
      translateError: async () => {
        throw new Error('translation exploded');
      },
      executionEpochId: 'worker-epoch-1',
    });
    const transport = fakePort();
    registry.attach(transport.port);
    transport.deliver(startMessage(input()));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    assert.equal(
      messagesOfType(transport.posted, 'bgsmAgentTurnError')[0]?.error.message,
      'Cubby turn failed.',
    );
  });

  it('rejects a prior-worker epoch without starting Provider or tools', () => {
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      runTurn: async (turn) => {
        runCount += 1;
        return {
          turnAttemptId: turn.turnAttemptId,
          sessionId: turn.sessionId,
          baseRevision: turn.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          newMessages: [],
        };
      },
      translateError: async (error) => String(error),
      executionEpochId: 'worker-epoch-2',
    });
    const transport = fakePort();
    registry.attach(transport.port);
    transport.deliver(startMessage(input(), 'worker-epoch-1'));

    assert.equal(runCount, 0);
    assert.equal(
      messagesOfType(transport.posted, 'bgsmAgentTurnResult')[0]?.result.reason,
      'attempt_state_lost',
    );
  });
});
