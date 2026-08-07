import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  BGSM_AGENT_PROMPT_MAX_BYTES,
  type AgentSessionLaunchIdentity,
} from '@/bgsm-agent';
import {
  createBgsmAgentTurnRegistry,
  type BgsmAgentTurnRunner,
} from '@/background/bgsm-agent-turn-port';
import {
  AGENT_TURN_ERROR_CODES,
  type AgentTurnErrorCode,
  type BgsmAgentActiveTurn,
  type BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';

type Listener<T> = (value: T) => void;

type FakePort = {
  port: {
    postMessage(message: unknown): void;
    disconnect(): void;
    onMessage: { addListener(listener: Listener<unknown>): void };
    onDisconnect: { addListener(listener: () => void): void };
  };
  posted: unknown[];
  deliver(message: unknown): void;
};

function fakePort(): FakePort {
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
    deliver(message: unknown) { messageListeners.forEach((listener) => listener(message)); },
  };
}

function launch(overrides: Partial<AgentSessionLaunchIdentity> = {}): AgentSessionLaunchIdentity {
  return {
    turnAttemptId: 'turn-attempt-contract',
    sessionId: 'session-contract',
    baseRevision: 3,
    prompt: 'Inspect the selected repository.',
    candidateContract: {
      kind: 'selected_repository',
      selectedRepositoryIdHint: 'owner/repository',
    },
    ...overrides,
  };
}

function start(
  transport: FakePort,
  input: AgentSessionLaunchIdentity,
): void {
  const hello = findHello(transport);
  transport.deliver({
    type: 'startBgsmAgentTurn',
    executionEpochId: hello.executionEpochId,
    ...input,
  });
}

function acknowledge(
  transport: FakePort,
  input: AgentSessionLaunchIdentity,
): void {
  const hello = findHello(transport);
  transport.deliver({
    type: 'ackBgsmAgentTurnResult',
    executionEpochId: hello.executionEpochId,
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    disposition: 'no_transition',
    appliedRevision: null,
  });
}

function messagesOfType(messages: readonly unknown[], type: string): Record<string, unknown>[] {
  return messages.filter((message): message is Record<string, unknown> => (
    isRecord(message) && message.type === type
  ));
}

function terminalResult(input: AgentSessionLaunchIdentity): BgsmAgentTurnResult {
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  assert.fail('condition was not reached');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function findHello(transport: FakePort): { executionEpochId: string } {
  const message = transport.posted.find((candidate) => (
    isRecord(candidate) && candidate.type === 'bgsmAgentTurnHello'
  ));
  if (!isRecord(message) || typeof message.executionEpochId !== 'string') {
    throw new Error('expected Agent worker handshake');
  }
  return { executionEpochId: message.executionEpochId };
}

describe('background Agent turn transport contract', () => {
  it('routes an exact bounded launch through the runner and shared active-turn transport', async () => {
    const input = launch();
    let received: AgentSessionLaunchIdentity | null = null;
    let finish!: (result: BgsmAgentTurnResult) => void;
    const completion = new Promise<BgsmAgentTurnResult>((resolve) => { finish = resolve; });
    const runner: BgsmAgentTurnRunner = async (candidate) => {
      received = candidate;
      return completion;
    };
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-contract',
      translateError: async () => 'failed',
      runTurn: runner,
    });
    const transport = fakePort();
    registry.attach(transport.port);

    start(transport, input);

    assert.deepEqual(received, input);
    const active: BgsmAgentActiveTurn | null = registry.inspectActiveTurn(input.sessionId);
    assert.ok(active);
    assert.equal(active.executionEpochId, registry.executionEpochId);
    assert.deepEqual(active.launch, input);
    assert.notEqual(active.launch, input);
    assert.deepEqual(Object.keys(active).sort(), ['executionEpochId', 'launch']);

    finish(terminalResult(input));
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    acknowledge(transport, input);
  });

  it.each([
    ['accepts', BGSM_AGENT_PROMPT_MAX_BYTES, 1],
    ['rejects', BGSM_AGENT_PROMPT_MAX_BYTES + 1, 0],
  ] as const)('%s a Port launch at the prompt boundary (%i bytes)', async (
    _expected,
    promptBytes,
    expectedRuns,
  ) => {
    const input = launch({
      turnAttemptId: `turn-attempt-prompt-${promptBytes}`,
      sessionId: `session-prompt-${promptBytes}`,
      prompt: 'x'.repeat(promptBytes),
    });
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-prompt-boundary',
      translateError: async () => 'failed',
      runTurn: async (candidate) => {
        runCount += 1;
        return terminalResult(candidate);
      },
    });
    const transport = fakePort();
    registry.attach(transport.port);

    start(transport, input);

    assert.equal(runCount, expectedRuns);
    if (expectedRuns === 1) {
      await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
      acknowledge(transport, input);
    } else {
      assert.equal(messagesOfType(transport.posted, 'bgsmAgentTurnEvent').length, 0);
    }
  });


  it('rejects oversized stop and acknowledgement identities before control handling', async () => {
    const input = launch({ turnAttemptId: 'turn-attempt-control-bounds' });
    let signal: AbortSignal | undefined;
    let finish!: (result: BgsmAgentTurnResult) => void;
    const completion = new Promise<BgsmAgentTurnResult>((resolve) => { finish = resolve; });
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-control-bounds',
      translateError: async () => 'failed',
      runTurn: async (_candidate, options) => {
        signal = options.signal;
        return completion;
      },
    });
    const transport = fakePort();
    registry.attach(transport.port);
    start(transport, input);
    const hello = findHello(transport);

    transport.deliver({
      type: 'stopBgsmAgentTurn',
      executionEpochId: hello.executionEpochId,
      turnAttemptId: 'x'.repeat(513),
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    });
    assert.equal(signal?.aborted, false);

    finish(terminalResult(input));
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    transport.deliver({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: hello.executionEpochId,
      turnAttemptId: 'x'.repeat(513),
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'no_transition',
      appliedRevision: null,
    });
    assert.equal(messagesOfType(transport.posted, 'bgsmAgentTurnAck').length, 0);
    acknowledge(transport, input);
  });
  it.each(AGENT_TURN_ERROR_CODES)(
    'normalizes bounded producer error code %s into a typed terminal delivery',
    async (code: AgentTurnErrorCode) => {
      const input = launch({ turnAttemptId: `turn-attempt-${code}` });
      const registry = createBgsmAgentTurnRegistry({
        executionEpochId: 'worker-errors',
        translateError: async () => 'Typed Agent failure.',
        runTurn: async () => { throw { code }; },
      });
      const transport = fakePort();
      registry.attach(transport.port);

      start(transport, input);
      await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnError').length === 1);

      const delivery = messagesOfType(transport.posted, 'bgsmAgentTurnError')[0];
      assert.ok(delivery && isRecord(delivery.error));
      assert.equal(delivery.error.code, code);
      acknowledge(transport, input);
    },
  );

  it('normalizes browser quota failures without admitting unknown error codes', async () => {
    const cases = [
      { error: { name: 'QuotaExceededError' }, expected: 'agent_session_quota_exceeded' },
      { error: { code: 'agent_unbounded_unknown_code' }, expected: undefined },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const input = launch({
        turnAttemptId: `turn-attempt-normalization-${index}`,
        sessionId: `session-normalization-${index}`,
      });
      const registry = createBgsmAgentTurnRegistry({
        executionEpochId: `worker-normalization-${index}`,
        translateError: async () => 'Agent failure.',
        runTurn: async () => { throw testCase.error; },
      });
      const transport = fakePort();
      registry.attach(transport.port);
      start(transport, input);
      await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnError').length === 1);

      const delivery = messagesOfType(transport.posted, 'bgsmAgentTurnError')[0];
      assert.ok(delivery && isRecord(delivery.error));
      assert.equal(delivery.error.code, testCase.expected);
      acknowledge(transport, input);
    }
  });
});
