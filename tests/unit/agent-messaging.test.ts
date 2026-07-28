import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BgsmAgentTurnInput } from '@/bgsm-agent';
import {
  startBgsmAgentTurn,
  type BgsmAgentTurnResult,
} from '@/utils/messaging';

type Listener<T> = (value: T) => void;

function createRuntimePort() {
  const messageListeners: Array<Listener<unknown>> = [];
  const disconnectListeners: Array<() => void> = [];
  const port = {
    onMessage: {
      addListener: vi.fn((listener: Listener<unknown>) => {
        messageListeners.push(listener);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => {
        disconnectListeners.push(listener);
      }),
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    port,
    deliver(message: unknown) {
      messageListeners.forEach((listener) => listener(message));
    },
    disconnect() {
      disconnectListeners.forEach((listener) => listener());
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BGSM Agent messaging', () => {
  it('preserves complete tool protocol history and results across the Port', () => {
    let messageListener: Listener<unknown> | undefined;
    const postMessage = vi.fn();
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect: vi.fn(),
    };
    vi.stubGlobal('chrome', {
      runtime: {
        connect: vi.fn(() => port),
      },
    });

    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-history',
      sessionId: 'session-1',
      baseRevision: 7,
      prompt: 'Continue',
      history: [
        {
          id: 'assistant-call',
          role: 'agent',
          content: '',
          createdAt: 1,
          toolCalls: [{ id: 'call-1', name: 'list_tags', arguments: {} }],
        },
        {
          id: 'tool-result',
          role: 'tool',
          content: '{"ok":true}',
          createdAt: 2,
          toolCallId: 'call-1',
          toolName: 'list_tags',
        },
      ],
    };
    const onResult = vi.fn();

    const control = startBgsmAgentTurn(input, { onResult });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      ...input,
    });

    const candidateActiveProjection = {
      schemaVersion: 1 as const,
      currentUserMessageId: 'active-user',
      summarizedThroughMessageId: 'active-tool-result',
      retainedSuffixFirstMessageId: null,
      rawMessageCountAtCreation: 3,
      rawTailMessageIdAtCreation: 'active-tool-result',
      capabilityRevision: 'capability-v1',
      policyRevision: 'policy-v1',
      summary: 'Completed tool evidence is untrusted background only.',
    };
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: 'session-1',
      baseRevision: 7,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      newMessages: input.history,
      candidateActiveProjection,
    };
    messageListener?.({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).toHaveBeenCalledWith(result);
    expect(onResult.mock.calls[0]?.[0].newMessages[0].toolCalls[0].id).toBe('call-1');
    expect(onResult.mock.calls[0]?.[0].candidateActiveProjection).toEqual(candidateActiveProjection);
    expect(onResult.mock.calls[0]?.[0].newMessages[1].toolCallId).toBe('call-1');
    control.acknowledge({ disposition: 'applied', appliedRevision: 8 });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 8,
    });
    expect(port.disconnect).not.toHaveBeenCalled();
    messageListener?.({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 8,
    });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('preserves delivery identity on streamed events and errors', () => {
    let messageListener: Listener<unknown> | undefined;
    let disconnectListener: (() => void) | undefined;
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: {
        addListener: vi.fn((listener: () => void) => {
          disconnectListener = listener;
        }),
      },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    vi.stubGlobal('chrome', {
      runtime: {
        connect: vi.fn(() => port),
        lastError: undefined,
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-delivery',
      sessionId: 'session-1',
      baseRevision: 3,
      prompt: 'Continue',
      history: [],
    };
    const onEvent = vi.fn();
    const onError = vi.fn();

    const firstControl = startBgsmAgentTurn(input, { onEvent, onError });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const event = {
      type: 'agent_queued' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    };
    messageListener?.({ type: 'bgsmAgentTurnEvent', sequence: 0, event });
    expect(onEvent).toHaveBeenCalledWith(event);

    const error = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      message: 'Provider failed.',
    };
    messageListener?.({ type: 'bgsmAgentTurnError', sequence: 1, error });
    expect(onError).toHaveBeenCalledWith(error);
    firstControl.acknowledge({ disposition: 'not_applied', appliedRevision: null });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'not_applied',
      appliedRevision: null,
    });
    messageListener?.({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'not_applied',
      appliedRevision: null,
    });

    const disconnectError = vi.fn();
    startBgsmAgentTurn(input, { onError: disconnectError });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    disconnectListener?.();
    expect(disconnectError).not.toHaveBeenCalled();
    disconnectListener?.();
    expect(disconnectError).not.toHaveBeenCalled();
    disconnectListener?.();
    expect(disconnectError).toHaveBeenCalledWith({
      turnAttemptId: input.turnAttemptId,
      sessionId: 'session-1',
      baseRevision: 3,
      message: 'BGSM Agent stopped before finishing.',
    });
  });

  it('retries failed start posts and reports the final Port error', async () => {
    const transports = Array.from({ length: 3 }, () => createRuntimePort());
    for (const transport of transports) {
      transport.port.postMessage.mockImplementation(() => {
        throw new Error('Port is disconnected');
      });
    }
    const connect = vi.fn()
      .mockReturnValueOnce(transports[0].port)
      .mockReturnValueOnce(transports[1].port)
      .mockReturnValueOnce(transports[2].port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-post-failure',
      sessionId: 'session-post-failure',
      baseRevision: 5,
      prompt: 'Start safely',
      history: [],
    };
    const onError = vi.fn();

    startBgsmAgentTurn(input, { onError });
    transports[0].deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    await Promise.resolve();
    transports[1].deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    await Promise.resolve();
    transports[2].deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(transports.every(({ port }) => port.disconnect.mock.calls.length === 1)).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      message: 'Port is disconnected',
    });
  });

  it('reconnects to the same worker and skips replayed deliveries already applied by the UI', () => {
    const first = createRuntimePort();
    const replay = createRuntimePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(replay.port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-reconnect',
      sessionId: 'session-reconnect',
      baseRevision: 2,
      prompt: 'Continue safely',
      history: [],
    };
    const onEvent = vi.fn();
    const onResult = vi.fn();

    const control = startBgsmAgentTurn(input, { onEvent, onResult });
    first.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const queued = {
      type: 'agent_queued' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    };
    first.deliver({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    first.disconnect();

    replay.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    expect(replay.port.postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      ...input,
    });
    replay.deliver({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      newMessages: [],
    };
    replay.deliver({ type: 'bgsmAgentTurnResult', sequence: 1, result });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(result);
    control.acknowledge({ disposition: 'applied', appliedRevision: 3 });
    expect(replay.port.disconnect).not.toHaveBeenCalled();
    replay.deliver({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 3,
    });
    expect(replay.port.disconnect).toHaveBeenCalledOnce();
  });

  it('uses the original epoch after worker restart and accepts attempt_state_lost at sequence zero', () => {
    const first = createRuntimePort();
    const restarted = createRuntimePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(restarted.port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-lost',
      sessionId: 'session-lost',
      baseRevision: 4,
      prompt: 'Continue safely',
      history: [],
    };
    const onResult = vi.fn();

    const control = startBgsmAgentTurn(input, { onResult });
    first.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    first.deliver({
      type: 'bgsmAgentTurnEvent',
      sequence: 0,
      event: {
        type: 'agent_queued',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      },
    });
    first.disconnect();
    restarted.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-2' });
    expect(restarted.port.postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      ...input,
    });
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'attempt_state_lost',
      changed: false,
      changedCount: 0,
      newMessages: [],
    };
    restarted.deliver({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).toHaveBeenCalledWith(result);
    control.acknowledge({ disposition: 'not_applied', appliedRevision: null });
    restarted.deliver({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'not_applied',
      appliedRevision: null,
    });
    expect(restarted.port.disconnect).toHaveBeenCalledOnce();
  });

  it('resends an unconfirmed acknowledgement after reconnect', () => {
    const first = createRuntimePort();
    const retry = createRuntimePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(retry.port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-ack-retry',
      sessionId: 'session-ack-retry',
      baseRevision: 1,
      prompt: 'Finish safely',
      history: [],
    };
    const control = startBgsmAgentTurn(input, { onResult: vi.fn() });
    first.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    first.deliver({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        newMessages: [],
      },
    });
    control.acknowledge({ disposition: 'applied', appliedRevision: 2 });
    first.disconnect();

    retry.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    expect(retry.port.postMessage).toHaveBeenCalledWith({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 2,
    });
    retry.deliver({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 2,
    });
    expect(retry.port.disconnect).toHaveBeenCalledOnce();
  });

  it('settles a detached turn without delivering callbacks to an unmounted UI', () => {
    const transport = createRuntimePort();
    vi.stubGlobal('chrome', {
      runtime: { connect: vi.fn(() => transport.port), lastError: undefined },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-detached',
      sessionId: 'session-detached',
      baseRevision: 0,
      prompt: 'Stop during unmount',
      history: [],
    };
    const onResult = vi.fn();
    const onError = vi.fn();
    const control = startBgsmAgentTurn(input, { onResult, onError });
    transport.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    control.stop({ detach: true });
    transport.deliver({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'aborted',
        changed: false,
        changedCount: 0,
        newMessages: [],
      },
    });

    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(transport.port.postMessage).toHaveBeenCalledWith({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'not_applied',
      appliedRevision: null,
    });
  });

  it('applies exact-next deliveries once, rejects gaps, and sends one explicit stop', () => {
    let messageListener: Listener<unknown> | undefined;
    const postMessage = vi.fn();
    const disconnect = vi.fn();
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect,
    };
    vi.stubGlobal('chrome', {
      runtime: {
        connect: vi.fn(() => port),
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-sequenced',
      sessionId: 'session-sequenced',
      baseRevision: 2,
      prompt: 'Stream this',
      history: [],
    };
    const onEvent = vi.fn();
    const onError = vi.fn();
    const control = startBgsmAgentTurn(input, { onEvent, onError });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const queued = {
      type: 'agent_queued' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    };
    messageListener?.({
      type: 'bgsmAgentTurnEvent',
      sequence: 0,
      event: { ...queued, sessionId: 'stale-session' },
    });
    messageListener?.({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    messageListener?.({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    messageListener?.({
      type: 'bgsmAgentTurnEvent',
      sequence: 2,
      event: { ...queued, type: 'agent_start' },
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'BGSM Agent background deliveries arrived out of order.',
    }));
    expect(disconnect).toHaveBeenCalledOnce();

    control.stop();
    control.stop();
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'stopBgsmAgentTurn'))
      .toHaveLength(0);
  });

  it('keeps the Port open after Stop until the sequenced aborted result arrives', () => {
    let messageListener: Listener<unknown> | undefined;
    const postMessage = vi.fn();
    const disconnect = vi.fn();
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect,
    };
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-stop',
      sessionId: 'session-stop',
      baseRevision: 4,
      prompt: 'Stop this',
      history: [],
    };
    const onResult = vi.fn();
    const control = startBgsmAgentTurn(input, { onResult });
    control.stop();
    control.stop();
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });

    expect(postMessage.mock.calls.filter(([message]) => message.type === 'stopBgsmAgentTurn'))
      .toEqual([[{
        type: 'stopBgsmAgentTurn',
        executionEpochId: 'worker-epoch-1',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      }]]);
    expect(disconnect).not.toHaveBeenCalled();

    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'aborted',
      changed: false,
      changedCount: 0,
      newMessages: [],
    };
    messageListener?.({ type: 'bgsmAgentTurnResult', sequence: 0, result });
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('does not deliver messages after the final result', () => {
    let messageListener: Listener<unknown> | undefined;
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-terminal',
      sessionId: 'session-terminal',
      baseRevision: 1,
      prompt: 'Finish once',
      history: [],
    };
    const onEvent = vi.fn();
    const onResult = vi.fn();
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      newMessages: [],
    };

    startBgsmAgentTurn(input, { onEvent, onResult });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    messageListener?.({ type: 'bgsmAgentTurnResult', sequence: 0, result });
    messageListener?.({
      type: 'bgsmAgentTurnEvent',
      sequence: 1,
      event: {
        type: 'agent_start',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      },
    });

    expect(onResult).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
  });
});
