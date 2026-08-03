import { describe, expect, it } from 'vitest';
import {
  buildRawCaptureField,
  createDevRawCaptureCoordinator,
  type DevRawCaptureEvent,
  type DevTracePortResponse,
  RAW_CAPTURE_EVENT_MAX_BYTES,
  RAW_CAPTURE_FIELD_MAX_BYTES,
  RAW_CAPTURE_PENDING_QUEUE_MAX_BYTES,
  RAW_CAPTURE_ROOT_MAX_BYTES,
  scrubRawCaptureText,
  truncateUtf8,
  utf8Bytes,
} from '@/agent-observability';
import { runAgentLoop, type AgentMessage, type AgentTool } from '@/agent-harness';

class CapturePort {
  readonly posted: DevTracePortResponse[] = [];

  postMessage(message: DevTracePortResponse): void {
    this.posted.push(message);
  }
}

function drainCallbacks(callbacks: Array<() => void>): void {
  for (;;) {
    const callback = callbacks.shift();
    if (!callback) return;
    callback();
  }
}

function rawEvents(port: CapturePort): DevRawCaptureEvent[] {
  return port.posted.filter(
    (message): message is DevRawCaptureEvent => message.type === 'raw_capture_event',
  );
}

describe('Agent observability raw capture', () => {
  it('removes configured credentials and known token/header forms before display', () => {
    const configured = 'custom-secret-value';
    const source = [
      `configured=${configured}`,
      'openai=sk-proj-abcdefghijklmnopqrstuvwx',
      'github=github_pat_abcdefghijklmnopqrstuvwxyz123456',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.1234',
      'Cookie: session=private-cookie-value',
    ].join('\n');
    const result = scrubRawCaptureText(source, [configured]);

    expect(result.configuredSecretMatches).toBe(1);
    expect(result.knownPatternMatches).toBeGreaterThanOrEqual(4);
    expect(result.text).not.toContain(configured);
    expect(result.text).not.toMatch(/sk-proj-|github_pat_|Bearer|private-cookie/);
  });

  it('truncates only on Unicode code-point boundaries using UTF-8 bytes', () => {
    expect(truncateUtf8('A😀中B', 1)).toBe('A');
    expect(truncateUtf8('A😀中B', 5)).toBe('A😀');
    expect(truncateUtf8('A😀中B', 8)).toBe('A😀中');
    expect(utf8Bytes(truncateUtf8('😀'.repeat(100), 17))).toBe(16);
  });

  it('enforces the independent field cap and exposes the other capture ceilings', () => {
    const field = buildRawCaptureField('中'.repeat(100), [], 10);
    expect(field.originalBytes).toBe(300);
    expect(field.retainedBytes).toBe(9);
    expect(field.truncated).toBe(true);
    expect(field.text).toBe('中中中');
    expect(RAW_CAPTURE_FIELD_MAX_BYTES).toBe(256 * 1024);
    expect(RAW_CAPTURE_EVENT_MAX_BYTES).toBe(512 * 1024);
    expect(RAW_CAPTURE_ROOT_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(RAW_CAPTURE_PENDING_QUEUE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('binds configured-secret scrubbing to one Port and the next real root only', async () => {
    const callbacks: Array<() => void> = [];
    const configuredSecret = 'configured-provider-secret';
    const port = new CapturePort();
    const coordinator = createDevRawCaptureCoordinator({
      getConfiguredSecrets: async () => [configuredSecret, 'github-configured-token'],
      randomId: () => 'capture-1',
      scheduleDrain: (callback) => callbacks.push(callback),
    });

    await expect(coordinator.arm(port)).resolves.toEqual({
      kind: 'armed',
      captureId: 'raw_capture:capture-1',
    });
    const sink = coordinator.beginRoot({ rootOperationId: 'agent_turn:attempt-1' });
    expect(sink).toBeDefined();
    expect(coordinator.beginRoot({ rootOperationId: 'agent_turn:attempt-2' })).toBeUndefined();

    const identity = {
      requestId: 'provider-request-1',
      requestKind: 'turn' as const,
      providerStep: 0,
      requestAttempt: 1,
    };
    sink!.providerPrompt(identity, [{
      role: 'user',
      content: [
        `secret=${configuredSecret}`,
        'Authorization: Basic abcdefghijklmnopqrstuv',
        'Cookie: session=prompt-cookie-value',
      ].join('\n'),
    }]);
    sink!.providerResponse(identity, {
      content: 'token=sk-proj-abcdefghijklmnopqrstuvwx',
    });
    sink!.toolArguments({
      providerStep: 0,
      toolName: `read_${configuredSecret}`,
      toolCallId: `call-${configuredSecret}`,
      content: '{"query":"github-configured-token"}',
    });
    sink!.toolResult({
      providerStep: 0,
      toolName: 'read_repositories',
      toolCallId: 'call-1',
      content: 'Cookie: session=private-cookie-value',
    });
    sink!.finish('final_answer');
    drainCallbacks(callbacks);

    const events = rawEvents(port);
    expect(events.map((message) => message.event.kind)).toEqual([
      'root_started',
      'provider_prompt',
      'provider_response',
      'tool_arguments',
      'tool_result',
      'capture_completed',
    ]);
    expect(events.map((message) => message.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events.every((message) => message.captureId === 'raw_capture:capture-1')).toBe(true);
    expect(events.every((message) => message.rootOperationId === 'agent_turn:attempt-1')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(configuredSecret);
    expect(serialized).not.toContain('github-configured-token');
    expect(serialized).not.toContain('sk-proj-');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Basic abcdefghijklmnopqrstuv');
    expect(serialized).not.toContain('prompt-cookie-value');
    expect(serialized).not.toContain('private-cookie-value');
    expect(serialized).toContain('[REDACTED]');
    expect(events.at(-1)?.event).toEqual(expect.objectContaining({
      kind: 'capture_completed',
      reason: 'final_answer',
      droppedEventCount: 0,
    }));
  });

  it('destroys armed or queued capture state on explicit disarm and Port disconnect', async () => {
    const callbacks: Array<() => void> = [];
    const port = new CapturePort();
    const coordinator = createDevRawCaptureCoordinator({
      getConfiguredSecrets: async () => ['secret'],
      randomId: () => 'capture-disconnect',
      scheduleDrain: (callback) => callbacks.push(callback),
    });

    const armed = await coordinator.arm(port);
    expect(armed.kind).toBe('armed');
    expect(coordinator.disarm(port)).toBe('raw_capture:capture-disconnect');
    expect(coordinator.beginRoot({ rootOperationId: 'agent_turn:not-captured' })).toBeUndefined();

    await coordinator.arm(port);
    const finished = coordinator.beginRoot({ rootOperationId: 'agent_turn:finished-queued' })!;
    finished.providerResponse({
      requestId: 'request',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
    }, { content: 'must disappear before delivery' });
    finished.finish('final_answer');
    expect(coordinator.disarm(port)).toBe('raw_capture:capture-disconnect');

    await coordinator.arm(port);
    const disconnected = coordinator.beginRoot({ rootOperationId: 'agent_turn:queued' })!;
    disconnected.providerResponse({
      requestId: 'request-2',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
    }, { content: 'must also disappear before delivery' });
    coordinator.disconnect(port);
    drainCallbacks(callbacks);

    expect(port.posted).toEqual([]);
    expect(coordinator.beginRoot({ rootOperationId: 'agent_turn:after-disconnect' })).toBeUndefined();
  });

  it('reports Unicode-safe truncation and lossy queue/root pressure without backpressure', async () => {
    const callbacks: Array<() => void> = [];
    const port = new CapturePort();
    const coordinator = createDevRawCaptureCoordinator({
      getConfiguredSecrets: async () => [],
      randomId: () => 'capture-limits',
      scheduleDrain: (callback) => callbacks.push(callback),
      limits: {
        fieldBytes: 10,
        eventBytes: 1_024,
        rootBytes: 4_096,
        pendingQueueBytes: 700,
      },
    });
    await coordinator.arm(port);
    const sink = coordinator.beginRoot({ rootOperationId: 'agent_turn:limits' })!;
    const identity = {
      requestId: 'request-limits',
      requestKind: 'turn' as const,
      providerStep: 0,
      requestAttempt: 1,
    };
    for (let index = 0; index < 12; index += 1) {
      sink.providerResponse(identity, { content: '中'.repeat(100) });
    }
    sink.finish('final_answer');
    drainCallbacks(callbacks);

    const events = rawEvents(port);
    const content = events.find((message) => message.event.kind === 'provider_response');
    expect(content?.event).toEqual(expect.objectContaining({
      content: expect.objectContaining({
        text: '中中中',
        retainedBytes: 9,
        truncated: true,
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        kind: 'evidence_dropped',
        reason: 'pending_queue_limit',
        droppedEventCount: expect.any(Number),
      }),
    }));
    expect(events.at(-1)?.event).toEqual(expect.objectContaining({
      kind: 'capture_completed',
      truncatedFieldCount: expect.any(Number),
      droppedEventCount: expect.any(Number),
    }));
  });

  it('captures the real Agent loop provider and tool content through the narrow sink', async () => {
    const callbacks: Array<() => void> = [];
    const port = new CapturePort();
    const configuredSecret = 'loop-configured-secret';
    const coordinator = createDevRawCaptureCoordinator({
      getConfiguredSecrets: async () => [configuredSecret],
      randomId: () => 'capture-loop',
      scheduleDrain: (callback) => callbacks.push(callback),
    });
    await coordinator.arm(port);
    const sink = coordinator.beginRoot({ rootOperationId: 'agent_turn:loop' })!;
    const messages: AgentMessage[] = [{
      id: 'user-1',
      role: 'user',
      content: `find ${configuredSecret}`,
      createdAt: 1,
    }];
    const tool: AgentTool<{ query: string }, { result: string }> = {
      name: 'search_stars',
      description: 'Search local stars.',
      risk: 'read',
      validate(value) {
        return value as { query: string };
      },
      async execute(args) {
        return { result: `found ${args.query}` };
      },
    };
    let providerCall = 0;
    const result = await runAgentLoop({
      sessionId: 'session-loop',
      messages,
      tools: [tool],
      contentCapture: sink,
      provider: {
        async generate() {
          providerCall += 1;
          return providerCall === 1
            ? {
                toolCalls: [{
                  id: 'tool-call-1',
                  name: 'search_stars',
                  arguments: { query: configuredSecret },
                }],
              }
            : { content: `answer ${configuredSecret}`, finishReason: 'stop' };
        },
      },
    });
    sink.finish(result.reason);
    drainCallbacks(callbacks);

    expect(result.reason).toBe('final_answer');
    const events = rawEvents(port);
    expect(events.filter((message) => message.event.kind === 'provider_prompt')).toHaveLength(2);
    expect(events.some((message) => message.event.kind === 'provider_response')).toBe(true);
    expect(events.some((message) => message.event.kind === 'tool_arguments')).toBe(true);
    expect(events.some((message) => message.event.kind === 'tool_result')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(configuredSecret);
  });

  it('contains capture observer failures without changing the Agent result', async () => {
    const fail = () => { throw new Error('capture observer failed'); };
    const result = await runAgentLoop({
      sessionId: 'session-capture-failure',
      messages: [{ id: 'user', role: 'user', content: 'hello', createdAt: 1 }],
      tools: [],
      provider: {
        async generate() {
          return { content: 'answer', finishReason: 'stop' };
        },
      },
      contentCapture: {
        providerPrompt: fail,
        providerResponse: fail,
        toolArguments: fail,
        toolResult: fail,
        finish: fail,
      },
    });

    expect(result.reason).toBe('final_answer');
    expect(result.messages.at(-1)?.content).toBe('answer');
  });
});
