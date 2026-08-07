import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDevAgentTurnTraceFactory,
  createDevTraceRecorder,
  DevTraceDB,
} from '@/agent-observability';
import {
  createBgsmAgentTurnRegistry,
} from '@/background/bgsm-agent-turn-port';
import type { BgsmAgentTurnInput } from '@/bgsm-agent';
import type { BgsmAgentTurnLaunch } from '@/utils/messaging';

const databases: DevTraceDB[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (db) => {
    db.close();
    await db.delete();
  }));
});

describe('Cubby turn trace boundary', () => {
  it('creates one root for duplicate attachments and records replay after terminal', async () => {
    const db = new DevTraceDB(`bgsm-agent-turn-boundary-${crypto.randomUUID()}`);
    databases.push(db);
    let id = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: (() => {
        let time = 100;
        return () => ++time;
      })(),
      monotonicNow: () => 1,
      randomId: () => `event-${++id}`,
    });
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-epoch-1',
      randomId: () => `transport-${++id}`,
      traceFactory: createDevAgentTurnTraceFactory({
        recorder,
        randomId: () => `span-${++id}`,
      }),
      translateError: async () => 'failed',
      async runTurn(input, options) {
        options.emit({ type: 'agent_start', sessionId: input.sessionId });
        options.trace?.emit({
          kind: 'provider_error',
          requestId: 'provider-request-1',
          requestKind: 'turn',
          providerStep: 0,
          requestAttempt: 1,
          code: 'network_error',
          status: null,
          retryable: true,
          overflow: false,
        });
        options.emit({ type: 'agent_done', sessionId: input.sessionId, reason: 'provider_error' });
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'provider_error',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      },
    });
    const turn: BgsmAgentTurnInput = {
      turnAttemptId: 'attempt-1',
      sessionId: 'session-1',
      baseRevision: 0,
      prompt: 'private prompt that must not enter trace',
      history: [],
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repository',
      },
    };

    const first = fakePort();
    registry.attach(first.port);
    first.start(turn);
    await waitUntil(() => messagesOfType(first.posted, 'bgsmAgentTurnResult').length === 1);

    const replay = fakePort();
    registry.attach(replay.port);
    replay.start(turn);
    await waitUntil(() => messagesOfType(replay.posted, 'bgsmAgentTurnResult').length === 1);
    await waitUntil(async () => (
      (await db.roots.get('agent_turn:attempt-1'))?.terminalState === 'failed'
      && (await db.events.where('kind').equals('delivery_state').count()) >= 8
    ));

    const roots = await db.roots.toArray();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.terminalState).toBe('failed');
    const events = await db.events.orderBy('[rootOperationId+sequence]').toArray();
    expect(events.filter((event) => event.kind === 'root_started')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'root_terminal')).toHaveLength(1);
    const deliveries = events.filter((event) => event.kind === 'delivery_state');
    expect(deliveries.some((event) => (
      (event.data as { deliveryKind?: string }).deliveryKind === 'replay'
      && event.sequence > events.find((candidate) => candidate.kind === 'root_terminal')!.sequence
    ))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(turn.prompt);
  });

  it('contains a broken trace implementation without changing the turn result', async () => {
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-epoch-failure',
      traceFactory: () => ({
        execution: { emit() { throw new Error('trace unavailable'); } },
        recordAgentEvent() { throw new Error('trace unavailable'); },
        recordDelivery() { throw new Error('trace unavailable'); },
        recordAcknowledgement() { throw new Error('trace unavailable'); },
        recordCancellation() { throw new Error('trace unavailable'); },
        recordAttemptRejected() { throw new Error('trace unavailable'); },
        recordDisconnect() { throw new Error('trace unavailable'); },
        finish() { throw new Error('trace unavailable'); },
        async flush() { throw new Error('trace unavailable'); },
      }),
      translateError: async () => 'failed',
      async runTurn(input, options) {
        options.trace?.emit({
          kind: 'provider_error',
          requestId: 'provider-request-trace-failure',
          requestKind: 'turn',
          providerStep: 0,
          requestAttempt: 1,
          code: 'network_error',
          status: null,
          retryable: true,
          overflow: false,
        });
        options.emit({ type: 'agent_start', sessionId: input.sessionId });
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
    const transport = fakePort();
    registry.attach(transport.port);
    const turn = {
      turnAttemptId: 'attempt-trace-failure',
      sessionId: 'session-trace-failure',
      baseRevision: 0,
      prompt: 'continue despite trace failure',
      history: [],
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repository',
      },
    } satisfies BgsmAgentTurnInput;
    transport.start(turn);
    const identityConflict = fakePort();
    registry.attach(identityConflict.port);
    identityConflict.start({ ...turn, prompt: 'conflicting launch' });
    expect(messagesOfType(identityConflict.posted, 'bgsmAgentTurnError')).toHaveLength(1);
    const sessionConflict = fakePort();
    registry.attach(sessionConflict.port);
    sessionConflict.start({ ...turn, turnAttemptId: 'attempt-trace-failure-other' });
    expect((messagesOfType(sessionConflict.posted, 'bgsmAgentTurnResult')[0]?.result as { reason?: string }).reason)
      .toBe('attempt_state_lost');
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    const result = messagesOfType(transport.posted, 'bgsmAgentTurnResult')[0]?.result;
    expect((result as { reason?: string }).reason).toBe('final_answer');
  });

  it('resumes a prior-worker root and closes the lost attempt without creating a duplicate', async () => {
    const db = new DevTraceDB(`bgsm-agent-turn-prior-worker-${crypto.randomUUID()}`);
    databases.push(db);
    let id = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: (() => {
        let time = 100;
        return () => ++time;
      })(),
      monotonicNow: () => 1,
      randomId: () => `prior-event-${++id}`,
    });
    await recorder.startRoot({
      rootOperationId: 'agent_turn:attempt-prior-worker',
      operationKind: 'agent_turn',
      sessionId: 'session-prior-worker',
      executionEpochId: 'worker-epoch-1',
      attemptId: 'attempt-prior-worker',
      baseRevision: 0,
      startedAt: 50,
    });
    let runCount = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-epoch-2',
      randomId: () => `prior-transport-${++id}`,
      traceFactory: createDevAgentTurnTraceFactory({
        recorder,
        randomId: () => `prior-span-${++id}`,
      }),
      translateError: async () => 'failed',
      async runTurn(input) {
        runCount += 1;
        return resultFor(input);
      },
    });
    const transport = fakePort();
    registry.attach(transport.port);
    transport.start(turnInput({
      turnAttemptId: 'attempt-prior-worker',
      sessionId: 'session-prior-worker',
      baseRevision: 0,
    }), 'worker-epoch-1');
    transport.port.disconnect();

    await waitUntil(async () => (
      (await db.roots.get('agent_turn:attempt-prior-worker'))?.terminalState === 'attempt_state_lost'
      && (await db.events.where('kind').equals('port_disconnected').count()) === 1
    ));
    expect(runCount).toBe(0);
    expect(await db.roots.count()).toBe(1);
    const events = await db.events.orderBy('[rootOperationId+sequence]').toArray();
    expect(events.filter((event) => event.kind === 'root_started')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'root_terminal')).toHaveLength(1);
    expect(events.find((event) => event.kind === 'attempt_rejected')?.data)
      .toEqual({ reason: 'execution_epoch_mismatch' });
    expect(events.find((event) => event.kind === 'port_disconnected')?.data)
      .toMatchObject({ lastDeliverySequence: 0, attemptState: 'rejected' });
  });

  it('keeps a terminal root immutable while appending rejected reconnect evidence', async () => {
    const db = new DevTraceDB(`bgsm-agent-turn-terminal-resume-${crypto.randomUUID()}`);
    databases.push(db);
    let id = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: (() => {
        let time = 100;
        return () => ++time;
      })(),
      monotonicNow: () => 1,
      randomId: () => `terminal-event-${++id}`,
    });
    const factory = createDevAgentTurnTraceFactory({ recorder, randomId: () => `terminal-span-${++id}` });
    const turn = turnInput({
      turnAttemptId: 'attempt-terminal-resume',
      sessionId: 'session-terminal-resume',
      baseRevision: 0,
    });
    const completed = factory({
      rootOperationId: `agent_turn:${turn.turnAttemptId}`,
      sessionId: turn.sessionId,
      turnAttemptId: turn.turnAttemptId,
      baseRevision: turn.baseRevision,
      executionEpochId: 'worker-epoch-1',
      startedAt: 50,
    });
    completed.finish('completed', 'final_answer');
    await completed.flush();

    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-epoch-2',
      now: () => 110,
      randomId: () => `terminal-transport-${++id}`,
      traceFactory: factory,
      translateError: async () => 'failed',
      async runTurn(input) { return resultFor(input); },
    });
    const rejected = fakePort();
    registry.attach(rejected.port);
    rejected.start(turn, 'worker-epoch-1');
    rejected.port.disconnect();

    await waitUntil(async () => (await db.events.where('kind').equals('port_disconnected').count()) === 1);
    const root = await db.roots.get(`agent_turn:${turn.turnAttemptId}`);
    expect(root?.terminalState).toBe('completed');
    expect(root?.terminalReasonCode).toBe('final_answer');
    const events = await db.events.orderBy('[rootOperationId+sequence]').toArray();
    expect(events.filter((event) => event.kind === 'root_started')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'root_terminal')).toHaveLength(1);
    const terminalSequence = events.find((event) => event.kind === 'root_terminal')!.sequence;
    expect(events.filter((event) => ['attempt_rejected', 'delivery_state', 'port_disconnected'].includes(event.kind))
      .every((event) => event.sequence > terminalSequence)).toBe(true);
  });

  it('records active, rejected, and terminal disconnects without terminating the valid attempt', async () => {
    const db = new DevTraceDB(`bgsm-agent-turn-disconnect-states-${crypto.randomUUID()}`);
    databases.push(db);
    let id = 0;
    let resolveTurn!: (result: ReturnType<typeof resultFor>) => void;
    const completion = new Promise<ReturnType<typeof resultFor>>((resolve) => { resolveTurn = resolve; });
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-epoch-1',
      randomId: () => `disconnect-transport-${++id}`,
      traceFactory: createDevAgentTurnTraceFactory({
        recorder: createDevTraceRecorder({
          db,
          now: (() => {
            let time = 100;
            return () => ++time;
          })(),
          monotonicNow: () => 1,
          randomId: () => `disconnect-event-${++id}`,
        }),
        randomId: () => `disconnect-span-${++id}`,
      }),
      translateError: async () => 'failed',
      async runTurn() { return completion; },
    });
    const turn = turnInput({
      turnAttemptId: 'attempt-disconnect-states',
      sessionId: 'session-disconnect-states',
    });
    const active = fakePort();
    registry.attach(active.port);
    active.start(turn);
    active.port.disconnect();

    const identityConflict = fakePort();
    registry.attach(identityConflict.port);
    identityConflict.start({ ...turn, prompt: 'different prompt' });
    identityConflict.port.disconnect();

    const sessionConflict = fakePort();
    registry.attach(sessionConflict.port);
    sessionConflict.start({ ...turn, turnAttemptId: 'attempt-session-conflict' });
    sessionConflict.port.disconnect();

    const terminal = fakePort();
    registry.attach(terminal.port);
    terminal.start(turn);
    resolveTurn(resultFor(turn));
    await waitUntil(() => messagesOfType(terminal.posted, 'bgsmAgentTurnResult').length === 1);
    terminal.port.disconnect();

    await waitUntil(async () => (await db.events.where('kind').equals('port_disconnected').count()) === 4);
    const validRoot = await db.roots.get(`agent_turn:${turn.turnAttemptId}`);
    expect(validRoot?.terminalState).toBe('completed');
    const validEvents = (await db.events.where('rootOperationId').equals(`agent_turn:${turn.turnAttemptId}`).toArray())
      .sort((left, right) => left.sequence - right.sequence);
    expect(validEvents.filter((event) => event.kind === 'root_terminal')).toHaveLength(1);
    expect(validEvents.find((event) => event.kind === 'attempt_rejected')?.data)
      .toEqual({ reason: 'identity_conflict' });
    expect(validEvents.filter((event) => event.kind === 'port_disconnected').map((event) => event.data))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ lastDeliverySequence: 0, attemptState: 'active' }),
        expect.objectContaining({ lastDeliverySequence: 0, attemptState: 'rejected' }),
        expect.objectContaining({ lastDeliverySequence: 1, attemptState: 'terminal' }),
      ]));
    const conflictEvents = await db.events
      .where('rootOperationId')
      .equals('agent_turn:attempt-session-conflict')
      .toArray();
    expect(conflictEvents.find((event) => event.kind === 'attempt_rejected')?.data)
      .toEqual({ reason: 'active_session_conflict' });
    expect((await db.roots.get('agent_turn:attempt-session-conflict'))?.terminalState)
      .toBe('attempt_state_lost');
  });

  it('records a failed live delivery and keeps the terminal result replayable', async () => {
    const db = new DevTraceDB(`bgsm-agent-turn-delivery-failure-${crypto.randomUUID()}`);
    databases.push(db);
    let id = 0;
    let resolveTurn!: (result: ReturnType<typeof resultFor>) => void;
    const completion = new Promise<ReturnType<typeof resultFor>>((resolve) => { resolveTurn = resolve; });
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-epoch-1',
      now: () => 110,
      randomId: () => `delivery-transport-${++id}`,
      traceFactory: createDevAgentTurnTraceFactory({
        recorder: createDevTraceRecorder({
          db,
          now: (() => {
            let time = 100;
            return () => ++time;
          })(),
          monotonicNow: () => 1,
          randomId: () => `delivery-event-${++id}`,
        }),
        randomId: () => `delivery-span-${++id}`,
      }),
      translateError: async () => 'failed',
      async runTurn() { return completion; },
    });
    const turn = turnInput({ turnAttemptId: 'attempt-delivery-failure' });
    const failedLive = fakePort({ failDeliverySequence: 1 });
    registry.attach(failedLive.port);
    failedLive.start(turn);
    resolveTurn(resultFor(turn));

    await waitUntil(async () => (await db.events.where('kind').equals('port_disconnected').count()) === 1);
    expect(messagesOfType(failedLive.posted, 'bgsmAgentTurnResult')).toHaveLength(0);
    expect(failedLive.disconnectCalls).toBe(1);
    const disconnect = (await db.events.where('kind').equals('port_disconnected').first())?.data;
    expect(disconnect).toMatchObject({ lastDeliverySequence: 0, attemptState: 'terminal' });

    const replay = fakePort();
    registry.attach(replay.port);
    replay.start(turn);
    await waitUntil(() => messagesOfType(replay.posted, 'bgsmAgentTurnResult').length === 1);
    expect((messagesOfType(replay.posted, 'bgsmAgentTurnResult')[0]?.result as { reason?: string }).reason)
      .toBe('final_answer');
    await waitUntil(async () => (
      (await db.roots.get(`agent_turn:${turn.turnAttemptId}`))?.terminalState === 'completed'
    ));
  });

  it('distinguishes acknowledged attempts from completed revision rejection', async () => {
    const db = new DevTraceDB(`bgsm-agent-turn-acknowledged-${crypto.randomUUID()}`);
    databases.push(db);
    let id = 0;
    const registry = createBgsmAgentTurnRegistry({
      executionEpochId: 'worker-epoch-1',
      now: () => 110,
      randomId: () => `ack-transport-${++id}`,
      traceFactory: createDevAgentTurnTraceFactory({
        recorder: createDevTraceRecorder({
          db,
          now: (() => {
            let time = 100;
            return () => ++time;
          })(),
          monotonicNow: () => 1,
          randomId: () => `ack-event-${++id}`,
        }),
        randomId: () => `ack-span-${++id}`,
      }),
      translateError: async () => 'failed',
      async runTurn(input) { return resultFor(input); },
    });
    const turn = turnInput({ turnAttemptId: 'attempt-acknowledged', sessionId: 'session-acknowledged' });
    const first = fakePort();
    registry.attach(first.port);
    first.start(turn);
    await waitUntil(() => messagesOfType(first.posted, 'bgsmAgentTurnResult').length === 1);
    await waitUntil(async () => (
      (await db.roots.get(`agent_turn:${turn.turnAttemptId}`))?.terminalState === 'completed'
    ));
    first.deliver({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: registry.executionEpochId,
      turnAttemptId: turn.turnAttemptId,
      sessionId: turn.sessionId,
      baseRevision: turn.baseRevision,
      disposition: 'applied',
      appliedRevision: turn.baseRevision + 1,
    });

    const acknowledged = fakePort();
    registry.attach(acknowledged.port);
    acknowledged.start(turn);
    acknowledged.deliver({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: registry.executionEpochId,
      turnAttemptId: turn.turnAttemptId,
      sessionId: turn.sessionId,
      baseRevision: turn.baseRevision,
      disposition: 'detached',
      appliedRevision: null,
    });
    acknowledged.port.disconnect();
    const completedRevision = fakePort();
    registry.attach(completedRevision.port);
    completedRevision.start({ ...turn, turnAttemptId: 'attempt-completed-revision' });
    completedRevision.port.disconnect();

    await waitUntil(async () => (
      (await db.events.where('kind').equals('attempt_rejected').count()) === 2
      && (await db.events.where('kind').equals('result_acknowledged').count()) === 2
    ));
    const acknowledgedEvents = await db.events
      .where('rootOperationId')
      .equals(`agent_turn:${turn.turnAttemptId}`)
      .toArray();
    expect(acknowledgedEvents.find((event) => (
      event.kind === 'result_acknowledged'
      && (event.data as { disposition?: string }).disposition === 'applied'
    ))?.data)
      .toEqual({ disposition: 'applied', appliedRevision: turn.baseRevision + 1 });
    expect(acknowledgedEvents.find((event) => event.kind === 'attempt_rejected')?.data)
      .toEqual({ reason: 'acknowledged_attempt' });
    expect(acknowledgedEvents.find((event) => (
      event.kind === 'result_acknowledged'
      && (event.data as { disposition?: string }).disposition === 'detached'
    ))?.data)
      .toEqual({ disposition: 'detached', appliedRevision: null });
    expect((await db.roots.get(`agent_turn:${turn.turnAttemptId}`))?.terminalState).toBe('completed');
    const revisionEvents = await db.events
      .where('rootOperationId')
      .equals('agent_turn:attempt-completed-revision')
      .toArray();
    expect(revisionEvents.find((event) => event.kind === 'attempt_rejected')?.data)
      .toEqual({ reason: 'completed_revision' });
    expect((await db.roots.get('agent_turn:attempt-completed-revision'))?.terminalState)
      .toBe('attempt_state_lost');
  });
});

function fakePort(options: Readonly<{ failDeliverySequence?: number }> = {}) {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: unknown[] = [];
  let disconnectCalls = 0;
  return {
    port: {
      postMessage(message: unknown) {
        if (
          typeof message === 'object'
          && message !== null
          && 'sequence' in message
          && message.sequence === options.failDeliverySequence
        ) throw new Error('simulated Port delivery failure');
        posted.push(message);
      },
      disconnect() {
        disconnectCalls += 1;
        disconnectListeners.forEach((listener) => listener());
      },
      onMessage: {
        addListener(listener: (message: unknown) => void) { messageListeners.push(listener); },
      },
      onDisconnect: {
        addListener(listener: () => void) { disconnectListeners.push(listener); },
      },
    },
    posted,
    get disconnectCalls() { return disconnectCalls; },
    deliver(message: unknown) {
      for (const listener of messageListeners) listener(message);
    },
    start(input: BgsmAgentTurnInput, executionEpochId?: string) {
      const hello = messagesOfType(posted, 'bgsmAgentTurnHello')[0];
      if (!hello) throw new Error('Expected worker hello.');
      for (const listener of messageListeners) listener({
        type: 'startBgsmAgentTurn',
        executionEpochId: executionEpochId ?? hello.executionEpochId,
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        prompt: input.prompt,
        ...(input.candidateContract ? { candidateContract: input.candidateContract } : {}),
      });
    },
  };
}

function turnInput(overrides: Partial<BgsmAgentTurnInput> = {}): BgsmAgentTurnInput {
  return {
    turnAttemptId: 'attempt-default',
    sessionId: 'session-default',
    baseRevision: 0,
    prompt: 'inspect repositories',
    history: [],
    candidateContract: {
      kind: 'selected_repository',
      selectedRepositoryIdHint: 'owner/repository',
    },
    ...overrides,
  };
}

function resultFor(input: BgsmAgentTurnLaunch) {
  return {
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    reason: 'final_answer' as const,
    changed: false,
    changedCount: 0,
    commit: null,
  };
}

function messagesOfType<T extends string>(messages: unknown[], type: T) {
  return messages.filter((message): message is Record<string, unknown> & { type: T } => (
    !!message && typeof message === 'object' && (message as { type?: string }).type === type
  ));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for trace state.');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
