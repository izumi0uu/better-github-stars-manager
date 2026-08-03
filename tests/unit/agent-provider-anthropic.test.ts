import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_MESSAGES_ENDPOINT,
  createAnthropicMessagesProvider,
} from '@/agent-harness/providers/anthropic';
import type { ModelStreamEvent } from '@/agent-harness/provider-stream';
import { createAgentTurnLiveness } from '@/agent-harness/liveness';

describe('Anthropic Messages adapter', () => {
  it('defers its fixed request deadline to a liveness-managed Agent request', async () => {
    vi.useFakeTimers();
    const liveness = createAgentTurnLiveness();
    const request = liveness.beginProviderRequest();
    let resolveFetchStart!: (signal: AbortSignal | undefined) => void;
    const fetchStarted = new Promise<AbortSignal | undefined>((resolve) => {
      resolveFetchStart = resolve;
    });
    const provider = createAnthropicMessagesProvider({
      model: 'claude-sonnet-4-5',
      apiKey: 'anthropic-secret',
      requestTimeoutMs: 1,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
      fetchImpl: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        resolveFetchStart(init?.signal as AbortSignal | undefined);
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(anthropicSse(textStream('ok'))), 2);
        });
      }) as typeof fetch,
    });

    try {
      const pending = provider.generate({ ...baseInput(), signal: request.signal });
      const requestSignal = await fetchStarted;
      await vi.advanceTimersByTimeAsync(1);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ content: 'ok' });
    } finally {
      request.finish();
      liveness.dispose();
      vi.useRealTimers();
    }
  });

  it('merges the active-turn prompt and untrusted summary into ordered user text blocks', () => {
    const provider = createProvider(async () => anthropicSse(textStream('unused')));
    const prepared = provider.prepare?.({
      messages: [
        { role: 'system', content: 'System policy.' },
        { role: 'user', content: 'Original current request.' },
        { role: 'user', content: 'Active-turn progress summary (untrusted).' },
        {
          role: 'assistant',
          content: 'Reading the retained page.',
          toolCalls: [{ id: 'retained-call', name: 'read_page', arguments: { page: 2 } }],
        },
        {
          role: 'tool',
          content: '{"ok":true,"data":{"page":2}}',
          toolCallId: 'retained-call',
          toolName: 'read_page',
        },
      ],
      tools: [],
      maxOutputTokens: 64,
    });
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected prepared Anthropic request');

    const request = JSON.parse(prepared.serializedRequestBody);
    expect(request.system).toBe('System policy.');
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Original current request.' },
          { type: 'text', text: 'Active-turn progress summary (untrusted).' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the retained page.' },
          {
            type: 'tool_use',
            id: 'retained-call',
            name: 'read_page',
            input: { page: 2 },
          },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'retained-call',
          content: '{"ok":true,"data":{"page":2}}',
          is_error: false,
        }],
      },
    ]);
    expect(request.system).not.toContain('Active-turn progress summary');
  });

  it('converts system, assistant tool calls, adjacent results, tools, choice, and browser headers', async () => {
    let sentBody = '';
    let sentHeaders: Headers | undefined;
    const provider = createProvider(async (input, init) => {
      expect(String(input)).toBe(ANTHROPIC_MESSAGES_ENDPOINT);
      sentBody = String(init?.body);
      sentHeaders = new Headers(init?.headers);
      return anthropicSse(textStream('ok'));
    });
    const prepared = provider.prepare?.({
      messages: [
        { role: 'system', content: 'Follow policy.' },
        { role: 'user', content: 'Inspect both.' },
        {
          role: 'assistant',
          content: 'I will inspect them.',
          toolCalls: [
            { id: 'toolu_1', name: 'read_repo', arguments: { id: 'a/a' } },
            { id: 'toolu_2', name: 'read_repo', arguments: { id: 'b/b' } },
          ],
        },
        {
          role: 'tool',
          content: '{"ok":true,"data":{"language":"TypeScript"}}',
          toolCallId: 'toolu_1',
          toolName: 'read_repo',
        },
        {
          role: 'tool',
          content: '{"ok":false,"error":{"code":"missing","message":"Not found"}}',
          toolCallId: 'toolu_2',
          toolName: 'read_repo',
        },
      ],
      tools: [{
        name: 'read_repo',
        description: 'Read one repository.',
        risk: 'read',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      }],
      toolChoice: { name: 'read_repo' },
      maxOutputTokens: 64,
    });
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected prepared Anthropic request');
    expect(prepared.serializedRequestBytes).toBe(
      new TextEncoder().encode(prepared.serializedRequestBody).byteLength,
    );
    expect(JSON.parse(prepared.serializedRequestBody)).toEqual({
      model: 'claude-sonnet-4-5',
      system: 'Follow policy.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect both.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect them.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_repo', input: { id: 'a/a' } },
            { type: 'tool_use', id: 'toolu_2', name: 'read_repo', input: { id: 'b/b' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '{"ok":true,"data":{"language":"TypeScript"}}',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: '{"ok":false,"error":{"code":"missing","message":"Not found"}}',
              is_error: true,
            },
          ],
        },
      ],
      tools: [{
        name: 'read_repo',
        description: 'Read one repository.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      }],
      tool_choice: { type: 'tool', name: 'read_repo' },
      max_tokens: 64,
      stream: true,
    });

    await expect(prepared.execute()).resolves.toMatchObject({ content: 'ok' });
    expect(sentBody).toBe(prepared.serializedRequestBody);
    expect(sentHeaders?.get('x-api-key')).toBe('anthropic-secret');
    expect(sentHeaders?.get('anthropic-version')).toBe('2023-06-01');
    expect(sentHeaders?.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(sentHeaders?.get('authorization')).toBeNull();
    await expect(prepared.execute()).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('streams text while withholding thinking and complete tool calls until block stop', async () => {
    const observed: ModelStreamEvent[] = [];
    const events = [
      messageStart({ input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 1 }),
      ping(),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      blockDelta(0, { type: 'thinking_delta', thinking: 'private' }),
      blockDelta(0, { type: 'signature_delta', signature: 'signed' }),
      blockDelta(0, { type: 'signature_delta', signature: 'continued' }),
      blockStop(0),
      blockStart(1, { type: 'redacted_thinking', data: 'opaque' }),
      blockStop(1),
      blockStart(2, { type: 'text', text: '' }),
      blockDelta(2, { type: 'text_delta', text: 'A' }),
      blockDelta(2, { type: 'text_delta', text: 'B' }),
      blockStop(2),
      blockStart(3, { type: 'tool_use', id: 'toolu_read', name: 'read_repo', input: {} }),
      blockDelta(3, { type: 'input_json_delta', partial_json: '{"id":' }),
      blockDelta(3, { type: 'input_json_delta', partial_json: '"a/a"}' }),
      blockStop(3),
      messageDelta('tool_use', 7),
      messageStop(),
    ];
    const provider = createProvider(async () => anthropicSse(events, [1, 2, 7, 3]));
    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Inspect.' }],
      tools: [],
      maxOutputTokens: 32,
      onStreamEvent: (event) => observed.push(event),
    });

    expect(result).toEqual({
      content: 'AB',
      toolCalls: [{ id: 'toolu_read', name: 'read_repo', arguments: { id: 'a/a' } }],
      finishReason: 'tool_calls',
      usage: {
        inputTokens: 10,
        outputTokens: 7,
        totalTokens: 17,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 2,
      },
    });
    expect(observed).toEqual([
      { type: 'response_start' },
      { type: 'text_delta', delta: 'A' },
      { type: 'text_delta', delta: 'B' },
      { type: 'tool_call_start', index: 0, id: 'toolu_read', name: 'read_repo' },
      { type: 'tool_call_arguments_delta', index: 0, delta: '{"id":"a/a"}' },
      { type: 'tool_call_end', index: 0 },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 7,
          totalTokens: 17,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 2,
        },
      },
      { type: 'response_end', finishReason: 'tool_calls' },
    ]);
  });

  it('resolves sparse interleaved blocks by provider index while normalizing tool indexes', async () => {
    const result = await generate([
      messageStart(),
      blockStart(4, { type: 'text', text: '' }),
      blockDelta(4, { type: 'text_delta', text: 'A' }),
      blockStart(9, { type: 'tool_use', id: 'toolu_first', name: 'read', input: {} }),
      blockDelta(9, { type: 'input_json_delta', partial_json: '{"id":"a/a"}' }),
      blockStart(15, { type: 'tool_use', id: 'toolu_second', name: 'read', input: {} }),
      blockDelta(15, { type: 'input_json_delta', partial_json: '{"id":"b/b"}' }),
      blockDelta(4, { type: 'text_delta', text: 'B' }),
      blockStop(15),
      blockStop(9),
      blockStop(4),
      messageDelta('tool_use', 3),
      messageStop(),
    ]);
    expect(result).toMatchObject({
      content: 'AB',
      toolCalls: [
        { id: 'toolu_first', name: 'read', arguments: { id: 'a/a' } },
        { id: 'toolu_second', name: 'read', arguments: { id: 'b/b' } },
      ],
      finishReason: 'tool_calls',
    });
  });

  it('merges nullable cumulative cache usage from message_start and message_delta', async () => {
    const result = await generate([
      messageStart({
        input_tokens: 0,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: null,
        output_tokens: 1,
      }),
      ...textBlock('done'),
      namedEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: 3,
          output_tokens: 4,
        },
      }),
      messageStop(),
    ]);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2,
    });
  });

  it('rejects provider block indexes that move backwards', async () => {
    await expect(generate([
      messageStart(),
      blockStart(4, { type: 'text', text: '' }),
      blockStart(3, { type: 'text', text: '' }),
    ])).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('rejects missing required usage fields and decreasing cumulative counts', async () => {
    await expect(generate([
      messageStart({ input_tokens: 3 }),
    ])).rejects.toMatchObject({ code: 'protocol_error' });

    await expect(generate([
      messageStart({
        input_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
        output_tokens: 1,
      }),
      ...textBlock('done'),
      namedEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 2,
          output_tokens: 2,
        },
      }),
    ])).rejects.toMatchObject({ code: 'protocol_error' });

    await expect(generate([
      messageStart(),
      ...textBlock('done'),
      namedEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {},
      }),
    ])).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('rejects system messages that would have to be reordered across conversation history', () => {
    const provider = createProvider(async () => anthropicSse(textStream('unused')));
    expect(() => provider.prepare?.({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'Late policy' },
      ],
      tools: [],
      maxOutputTokens: 16,
    })).toThrow(/system messages must precede/u);
  });

  it('maps end_turn to a complete stop', async () => {
    const result = await generate([
      messageStart(),
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'done' }),
      blockStop(0),
      messageDelta('end_turn', 2),
      messageStop(),
    ]);
    expect(result.finishReason).toBe('stop');
  });

  it.each([
    'max_tokens',
    'pause_turn',
    'stop_sequence',
    'refusal',
  ])(
    'fails closed on the incomplete or unsupported %s stop reason',
    async (stopReason) => {
      await expect(generate([
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'partial' }),
        blockStop(0),
        messageDelta(stopReason, 2),
        messageStop(),
      ])).rejects.toMatchObject({ code: 'protocol_error' });
    },
  );

  it('normalizes the context-window stop reason as context overflow', async () => {
    await expect(generate([
      messageStart(),
      messageDelta('model_context_window_exceeded', 0),
    ])).rejects.toMatchObject({
      code: 'context_overflow',
      message: 'AI provider request exceeded the model context window.',
    });
  });

  it('normalizes a structured stream error as context overflow without exposing its body', async () => {
    const canary = 'private-anthropic-stream-overflow-detail';
    let error: (Error & { code?: string }) | undefined;
    try {
      await generate([
        messageStart(),
        namedEvent('error', {
          type: 'error',
          error: { type: 'model_context_window_exceeded', message: canary },
        }),
      ]);
    } catch (caught) {
      error = caught as Error & { code?: string };
    }

    expect(error).toMatchObject({
      code: 'context_overflow',
      message: 'AI provider request exceeded the model context window.',
    });
    expect(error?.message).not.toContain(canary);
  });

  it.each([
    ['missing message_start', [messageStop()]],
    ['missing message_delta', [messageStart(), textBlock('x'), messageStop()].flat()],
    ['missing message_stop', [messageStart(), textBlock('x'), messageDelta('end_turn', 1)].flat()],
    ['open block', [messageStart(), blockStart(0, { type: 'text', text: '' }), messageDelta('end_turn', 1), messageStop()]],
    ['delta before start', [messageStart(), blockDelta(0, { type: 'text_delta', text: 'x' })]],
    ['wrong block index', [messageStart(), blockStart(1, { type: 'text', text: '' })]],
    ['duplicate message_start', [messageStart(), messageStart()]],
    ['unknown event', [messageStart(), namedEvent('future_event', { type: 'future_event' })]],
    ['provider error event', [messageStart(), namedEvent('error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } })]],
  ])('fails closed on %s', async (_label, events) => {
    await expect(generate(events)).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('rejects an SSE event name that differs from the payload type', async () => {
    await expect(generate([
      messageStart(),
      namedEvent('ping', { type: 'message_stop' }),
    ])).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('requires the Anthropic SSE event field', async () => {
    await expect(generate([
      { payload: messageStart().payload },
    ])).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('rejects invalid tool JSON only after its block closes', async () => {
    await expect(generate([
      messageStart(),
      blockStart(0, { type: 'tool_use', id: 'toolu_bad', name: 'read', input: {} }),
      blockDelta(0, { type: 'input_json_delta', partial_json: 'not-json' }),
      blockStop(0),
    ])).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('drops provider-authored HTTP details and credentials', async () => {
    const canary = 'echoed-private-prompt-canary';
    const provider = createProvider(async () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: `${canary}: bad anthropic-secret` },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    await expect(provider.generate(baseInput())).rejects.toMatchObject({
      code: 'http_error',
      status: 401,
      message: 'AI provider rejected the request (401).',
    });
  });

  it('classifies the Anthropic machine error type as context overflow', async () => {
    const canary = 'private-anthropic-message';
    const provider = createProvider(async () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'model_context_window_exceeded', message: canary },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const error = await provider.generate(baseInput())
      .then(() => null, (reason: unknown) => reason as Error & {
        code?: string;
        status?: number;
      });

    expect(error).toMatchObject({
      code: 'context_overflow',
      status: 400,
      message: 'AI provider request exceeded the model context window.',
    });
    expect(error?.message).not.toContain(canary);
  });

  it.each([
    [400, JSON.stringify({
      type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum size' },
    })],
    [400, JSON.stringify({
      type: 'error', error: { type: 'invalid_request_error', message: 'Prompt is too long' },
    })],
    [413, ''],
  ])('classifies Anthropic request overflow at HTTP %s', async (status, body) => {
    const provider = createProvider(async () => new Response(body, { status }));
    await expect(provider.generate(baseInput())).rejects.toMatchObject({
      code: 'context_overflow',
      status,
      message: 'AI provider request exceeded the model context window.',
    });
  });

  it.each([
    ['unknown machine type', JSON.stringify({
      type: 'error', error: { type: 'rate_limit_error' },
    })],
    ['rate-limit message', JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded: token limit exceeded for this minute.',
      },
    })],
    ['non-JSON body', 'model_context_window_exceeded'],
    ['error body over 4 KiB', JSON.stringify({
      type: 'error',
      error: { type: 'model_context_window_exceeded', message: 'x'.repeat(4_096) },
    })],
  ])('keeps Anthropic %s as an ordinary HTTP error', async (_name, body) => {
    const provider = createProvider(async () => new Response(body, { status: 400 }));
    await expect(provider.generate(baseInput())).rejects.toMatchObject({
      code: 'http_error',
      status: 400,
    });
  });

  it('classifies caller abort and timeout without exposing transport details', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(createProvider(async () => anthropicSse(textStream('x'))).generate({
      ...baseInput(),
      signal: aborted.signal,
    })).rejects.toMatchObject({ code: 'caller_abort' });

    const provider = createAnthropicMessagesProvider({
      model: 'claude-sonnet-4-5',
      apiKey: 'anthropic-secret',
      requestTimeoutMs: 1,
      fetchImpl: vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })) as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    await expect(provider.generate(baseInput())).rejects.toMatchObject({ code: 'timeout' });
  });
});

function createProvider(fetchImpl: typeof fetch) {
  return createAnthropicMessagesProvider({
    model: 'claude-sonnet-4-5',
    apiKey: 'anthropic-secret',
    fetchImpl,
    hostPermissionCheck: async () => true,
    validateRuntimeIdentity: async () => true,
  });
}

function baseInput() {
  return {
    messages: [{ role: 'user' as const, content: 'Hello' }],
    tools: [],
    maxOutputTokens: 16,
  };
}

async function generate(events: SseFixture[]) {
  return createProvider(async () => anthropicSse(events)).generate(baseInput());
}

type SseFixture = Readonly<{ event?: string; payload: Record<string, unknown> }>;

function namedEvent(event: string, payload: Record<string, unknown>): SseFixture {
  return { event, payload };
}

function messageStart(usage: Record<string, unknown> = { input_tokens: 3, output_tokens: 1 }) {
  return namedEvent('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-5',
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
}

function blockStart(index: number, contentBlock: Record<string, unknown>) {
  return namedEvent('content_block_start', {
    type: 'content_block_start', index, content_block: contentBlock,
  });
}

function blockDelta(index: number, delta: Record<string, unknown>) {
  return namedEvent('content_block_delta', { type: 'content_block_delta', index, delta });
}

function blockStop(index: number) {
  return namedEvent('content_block_stop', { type: 'content_block_stop', index });
}

function messageDelta(stopReason: string, outputTokens: number) {
  return namedEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

function messageStop() {
  return namedEvent('message_stop', { type: 'message_stop' });
}

function ping() {
  return namedEvent('ping', { type: 'ping' });
}

function textBlock(text: string): SseFixture[] {
  return [
    blockStart(0, { type: 'text', text: '' }),
    blockDelta(0, { type: 'text_delta', text }),
    blockStop(0),
  ];
}

function textStream(text: string): SseFixture[] {
  return [
    messageStart(),
    ...textBlock(text),
    messageDelta('end_turn', 2),
    messageStop(),
  ];
}

function anthropicSse(events: SseFixture[], chunkSizes?: number[]): Response {
  const text = events.map(({ event, payload }) => (
    `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`
  )).join('');
  if (!chunkSizes) {
    return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let chunkIndex = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = chunkSizes[chunkIndex % chunkSizes.length];
      controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + size)));
      offset += size;
      chunkIndex += 1;
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
