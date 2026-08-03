import { describe, expect, it, vi } from 'vitest';
import {
  createOpenAIResponsesProvider,
  OPENAI_RESPONSES_ENDPOINT,
} from '@/agent-harness/providers/openai-responses';
import {
  MAX_PROVIDER_BUFFERED_RESPONSE_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
} from '@/agent-harness/provider';
import type { ModelStreamEvent } from '@/agent-harness/provider-stream';
import { createAgentTurnLiveness } from '@/agent-harness/liveness';

const RESPONSE_ID = 'resp_bgsm_1';

describe('OpenAI Responses adapter', () => {
  it('defers its fixed request deadline to a liveness-managed Agent request', async () => {
    vi.useFakeTimers();
    const liveness = createAgentTurnLiveness();
    const request = liveness.beginProviderRequest();
    let resolveFetchStart!: (signal: AbortSignal | undefined) => void;
    const fetchStarted = new Promise<AbortSignal | undefined>((resolve) => {
      resolveFetchStart = resolve;
    });
    const provider = createOpenAIResponsesProvider({
      model: 'gpt-5-mini',
      apiKey: 'test-key',
      requestTimeoutMs: 1,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
      fetchImpl: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        resolveFetchStart(init?.signal as AbortSignal | undefined);
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(responsesSse(textEvents('ok'))), 2);
        });
      }) as typeof fetch,
    });

    try {
      const pending = provider.generate({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
        maxOutputTokens: 16,
        signal: request.signal,
      });
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

  it('uses a Custom registry endpoint while enforcing its exact origin', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://relay.example/v1/responses');
      return responsesSse(textEvents('custom ok'));
    });
    const provider = createOpenAIResponsesProvider({
      model: 'custom-model',
      apiKey: 'custom-secret',
      endpoint: 'https://relay.example/v1/responses',
      expectedOrigin: 'https://relay.example',
      fetchImpl: fetchImpl as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });

    await expect(provider.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 16,
    })).resolves.toMatchObject({ content: 'custom ok' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('preserves the active-turn prompt and untrusted summary as ordered user input items', () => {
    const provider = createProvider(async () => responsesSse(textEvents('unused')));
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
    if (!prepared) throw new Error('expected prepared Responses request');

    const request = JSON.parse(prepared.serializedRequestBody);
    expect(request.input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'System policy.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Original current request.' }] },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Active-turn progress summary (untrusted).' }],
      },
      {
        type: 'message',
        id: 'msg_bgsm_0',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'Reading the retained page.',
          annotations: [],
        }],
      },
      {
        type: 'function_call',
        call_id: 'retained-call',
        name: 'read_page',
        arguments: '{"page":2}',
      },
      {
        type: 'function_call_output',
        call_id: 'retained-call',
        output: '{"ok":true,"data":{"page":2}}',
      },
    ]);
  });

  it('converts complete protocol history, tools, and named choice into stateless Responses items', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(OPENAI_RESPONSES_ENDPOINT);
      bodies.push(String(init?.body));
      return responsesSse(textEvents('ok'));
    });
    const provider = createProvider(fetchImpl);
    const prepared = provider.prepare?.({
      messages: [
        { role: 'system', content: 'Follow the policy.' },
        { role: 'user', content: 'Inspect this repository.' },
        {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [{ id: 'call_read', name: 'read_repo', arguments: { id: 'owner/repo' } }],
        },
        {
          role: 'tool',
          content: '{"ok":true,"data":{"language":"TypeScript"}}',
          toolCallId: 'call_read',
          toolName: 'read_repo',
        },
        { role: 'user', content: 'Summarize it.' },
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
    if (!prepared) throw new Error('expected prepared Responses request');
    expect(prepared.serializedRequestBytes).toBe(
      new TextEncoder().encode(prepared.serializedRequestBody).byteLength,
    );
    const request = JSON.parse(prepared.serializedRequestBody);
    expect(request).toEqual({
      model: 'gpt-5-mini',
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Follow the policy.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Inspect this repository.' }] },
        {
          type: 'message',
          id: 'msg_bgsm_0',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect it.', annotations: [] }],
        },
        {
          type: 'function_call',
          call_id: 'call_read',
          name: 'read_repo',
          arguments: '{"id":"owner/repo"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_read',
          output: '{"ok":true,"data":{"language":"TypeScript"}}',
        },
        { role: 'user', content: [{ type: 'input_text', text: 'Summarize it.' }] },
      ],
      tools: [{
        type: 'function',
        name: 'read_repo',
        description: 'Read one repository.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        strict: false,
      }],
      tool_choice: { type: 'function', name: 'read_repo' },
      max_output_tokens: 64,
      stream: true,
      store: false,
    });
    expect(request).not.toHaveProperty('previous_response_id');
    expect(request).not.toHaveProperty('reasoning');

    await expect(prepared.execute()).resolves.toMatchObject({
      content: 'ok',
      finishReason: 'stop',
    });
    expect(bodies).toEqual([prepared.serializedRequestBody]);
    await expect(prepared.execute()).rejects.toMatchObject({ code: 'protocol_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('streams arbitrary byte chunks through the P1 observer and final aggregation contract', async () => {
    const observed: ModelStreamEvent[] = [];
    const provider = createProvider(async () => responsesSse(textEvents('Hello'), [1, 2, 5, 3]));
    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Say hello.' }],
      tools: [],
      maxOutputTokens: 16,
      onStreamEvent: (event) => observed.push(event),
    });

    expect(result).toEqual({
      content: 'Hello',
      finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
    expect(observed.map((event) => event.type)).toEqual([
      'response_start',
      'text_delta',
      'usage',
      'response_end',
    ]);
  });

  it('accepts highly fragmented SSE whose wire framing exceeds the decoded payload limit', async () => {
    const text = 'x'.repeat(7_000);
    const events = [
      createdEvent(),
      outputAdded(0, { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
      contentAdded('msg_1', 0, 0, { type: 'output_text', text: '', annotations: [] }),
      ...[...text].map((delta) => textDelta('msg_1', 0, 0, delta)),
      textDone('msg_1', 0, 0, text),
      contentDone('msg_1', 0, 0, { type: 'output_text', text, annotations: [] }),
      outputDone(0, completedMessage('msg_1', text)),
      completedEvent(4, 1_250, 1_254),
    ];
    const body = responsesSseBody(events);
    const wireBytes = new TextEncoder().encode(body).byteLength;
    expect(wireBytes).toBeGreaterThan(MAX_PROVIDER_BUFFERED_RESPONSE_BYTES);
    expect(wireBytes).toBeLessThan(MAX_PROVIDER_RESPONSE_BYTES);

    const provider = createProvider(async () => rawSseResponse(body));
    await expect(provider.generate({
      messages: [{ role: 'user', content: 'List results.' }],
      tools: [],
      maxOutputTokens: 2_048,
    })).resolves.toMatchObject({ content: text, finishReason: 'stop' });
  });

  it('assembles interleaved text, reasoning, and function items by stable identity', async () => {
    const observed: ModelStreamEvent[] = [];
    const events = [
      createdEvent(),
      outputAdded(0, { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
      contentAdded('msg_1', 0, 0, { type: 'output_text', text: '', annotations: [] }),
      textDelta('msg_1', 0, 0, 'A'),
      outputAdded(1, { id: 'rs_1', type: 'reasoning', summary: [] }),
      outputAdded(3, {
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'first', arguments: '',
      }),
      functionDelta('fc_1', 3, '{"value":'),
      outputAdded(7, {
        id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'second', arguments: '',
      }),
      functionDelta('fc_2', 7, '{"value":2'),
      textDelta('msg_1', 0, 0, 'B'),
      functionDone('fc_1', 3, '{"value":1}'),
      outputDone(3, completedFunction('fc_1', 'call_1', 'first', '{"value":1}')),
      functionDelta('fc_2', 7, '}'),
      functionDone('fc_2', 7, '{"value":2}'),
      outputDone(7, completedFunction('fc_2', 'call_2', 'second', '{"value":2}')),
      textDone('msg_1', 0, 0, 'AB'),
      contentDone('msg_1', 0, 0, { type: 'output_text', text: 'AB', annotations: [] }),
      outputDone(0, completedMessage('msg_1', 'AB')),
      outputDone(1, { id: 'rs_1', type: 'reasoning', summary: [] }),
      completedEvent(12, 8, 20),
    ];
    const provider = createProvider(async () => responsesSse(events));
    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Use both tools.' }],
      tools: [],
      maxOutputTokens: 64,
      onStreamEvent: (event) => observed.push(event),
    });

    expect(result).toEqual({
      content: 'AB',
      toolCalls: [
        { id: 'call_1', name: 'first', arguments: { value: 1 } },
        { id: 'call_2', name: 'second', arguments: { value: 2 } },
      ],
      finishReason: 'tool_calls',
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });
    expect(observed.filter((event) => event.type === 'tool_call_start')).toEqual([
      { type: 'tool_call_start', index: 0, id: 'call_1', name: 'first' },
      { type: 'tool_call_start', index: 1, id: 'call_2', name: 'second' },
    ]);
    expect(observed.some((event) => event.type === 'refusal_delta')).toBe(false);
  });

  it('rejects mismatched item identity and divergent final function arguments', async () => {
    const identityMismatch = [
      createdEvent(),
      outputAdded(2, {
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '',
      }),
      functionDelta('fc_1', 3, '{}'),
    ];
    await expect(generate(identityMismatch)).rejects.toMatchObject({ code: 'protocol_error' });

    const argumentsMismatch = [
      createdEvent(),
      outputAdded(2, {
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '',
      }),
      functionDelta('fc_1', 2, '{"id":1}'),
      functionDone('fc_1', 2, '{"id":2}'),
    ];
    await expect(generate(argumentsMismatch)).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('accepts omitted top-level response IDs but rejects mismatched IDs', async () => {
    const omittedIdentity = textEvents('compatible proxy');
    for (const event of omittedIdentity) delete event.response_id;
    await expect(generate(omittedIdentity)).resolves.toMatchObject({
      content: 'compatible proxy',
      finishReason: 'stop',
    });

    const mismatchedIdentity = textEvents('mismatch');
    mismatchedIdentity[3].response_id = 'resp_other';
    await expect(generate(mismatchedIdentity)).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('accepts compatible gateway tool streams with empty frames and a trailing sentinel', async () => {
    const events: Array<Record<string, unknown>> = [
      createdEvent(),
      outputAdded(0, {
        id: 'fc_probe',
        type: 'function_call',
        call_id: 'call_probe',
        name: 'bgsm_connection_probe',
      }),
      functionDelta('fc_probe', 0, '{"nonce":"bgsm"}'),
      functionDone('fc_probe', 0, '{"nonce":"bgsm"}'),
      outputDone(0, completedFunction(
        'fc_probe',
        'call_probe',
        'bgsm_connection_probe',
        '{"nonce":"bgsm"}',
      )),
      completedEvent(8, 4, 12),
    ];
    for (const event of events) delete event.response_id;
    const body = [
      'data:\n\n',
      ...events.map((event) =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      'data: [DONE]\n\n',
    ].join('');
    const provider = createProvider(async () => rawSseResponse(body));

    await expect(provider.generate({
      messages: [{ role: 'user', content: 'Run the connection probe.' }],
      tools: [],
      maxOutputTokens: 32,
    })).resolves.toEqual({
      toolCalls: [{
        id: 'call_probe',
        name: 'bgsm_connection_probe',
        arguments: { nonce: 'bgsm' },
      }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    });
  });

  it('rejects duplicate output identities and incomplete or invalid function calls', async () => {
    const duplicate = [
      createdEvent(),
      outputAdded(0, { id: 'rs_1', type: 'reasoning', summary: [] }),
      outputAdded(1, { id: 'rs_1', type: 'reasoning', summary: [] }),
    ];
    await expect(generate(duplicate)).rejects.toMatchObject({ code: 'protocol_error' });

    const invalidJson = [
      createdEvent(),
      outputAdded(2, {
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '',
      }),
      functionDelta('fc_1', 2, 'not-json'),
      functionDone('fc_1', 2, 'not-json'),
      outputDone(2, completedFunction('fc_1', 'call_1', 'read', 'not-json')),
      completedEvent(1, 1, 2),
    ];
    await expect(generate(invalidJson)).rejects.toMatchObject({ code: 'protocol_error' });

    const openFunction = [
      createdEvent(),
      outputAdded(2, {
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '',
      }),
      completedEvent(1, 1, 2),
    ];
    await expect(generate(openFunction)).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it.each([
    'response.failed',
    'response.cancelled',
    'response.incomplete',
    'error',
  ])('fails closed on the %s terminal event', async (type) => {
    await expect(generate([createdEvent(), { type }])).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it.each([
    {
      name: 'response.failed',
      events: [
        createdEvent(),
        {
          type: 'response.failed',
          response: {
            id: RESPONSE_ID,
            status: 'failed',
            error: {
              code: 'context_length_exceeded',
              message: 'private-responses-overflow-detail',
            },
          },
        },
      ],
    },
    {
      name: 'top-level error',
      events: [{
        type: 'error',
        code: 'context_window_exceeded',
        message: 'private-responses-overflow-detail',
      }],
    },
  ])('normalizes structured $name as context overflow', async ({ events }) => {
    const canary = 'private-responses-overflow-detail';
    let error: (Error & { code?: string }) | undefined;
    try {
      await generate(events);
    } catch (caught) {
      error = caught as Error & { code?: string };
    }

    expect(error).toMatchObject({
      code: 'context_overflow',
      message: 'AI provider request exceeded the model context window.',
    });
    expect(error?.message).not.toContain(canary);
  });

  it('requires response.completed with completed status and consistent usage', async () => {
    await expect(generate([createdEvent()])).rejects.toMatchObject({ code: 'protocol_error' });

    await expect(generate([
      ...textEvents('partial').slice(0, -1),
      {
        type: 'response.completed',
        response: {
          id: RESPONSE_ID,
          status: 'incomplete',
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      },
    ])).rejects.toMatchObject({ code: 'protocol_error' });

    await expect(generate([
      ...textEvents('bad usage').slice(0, -1),
      completedEvent(2, 1, 99),
    ])).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('normalizes cache and reasoning detail subsets without double counting them', async () => {
    const events = textEvents('details');
    events[events.length - 1] = completedEvent(12, 8, 20, {
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 5 },
    });
    await expect(generate(events)).resolves.toMatchObject({
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedInputTokens: 4,
        cacheCreationInputTokens: 2,
        reasoningOutputTokens: 5,
      },
    });
  });

  it.each([
    ['non-object details', { input_tokens_details: 'invalid' }],
    ['fractional cached tokens', { input_tokens_details: { cached_tokens: 1.5 } }],
    ['cache subsets larger than input', {
      input_tokens_details: { cached_tokens: 9, cache_write_tokens: 4 },
    }],
    ['reasoning larger than output', { output_tokens_details: { reasoning_tokens: 9 } }],
  ])('rejects malformed %s usage', async (_name, details) => {
    const events = textEvents('invalid details');
    events[events.length - 1] = completedEvent(12, 8, 20, details);
    await expect(generate(events)).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('rejects refusals, late events, and mismatched SSE event names', async () => {
    const refusal = [
      createdEvent(),
      outputAdded(0, { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
      contentAdded('msg_1', 0, 0, { type: 'refusal', refusal: '' }),
      {
        type: 'response.refusal.delta', response_id: RESPONSE_ID, item_id: 'msg_1',
        output_index: 0, content_index: 0, delta: 'No.',
      },
      {
        type: 'response.refusal.done', response_id: RESPONSE_ID, item_id: 'msg_1',
        output_index: 0, content_index: 0, refusal: 'No.',
      },
      contentDone('msg_1', 0, 0, { type: 'refusal', refusal: 'No.' }),
      outputDone(0, {
        id: 'msg_1', type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'refusal', refusal: 'No.' }],
      }),
      completedEvent(2, 1, 3),
    ];
    await expect(generate(refusal)).rejects.toMatchObject({ code: 'protocol_error' });

    await expect(generate([
      ...textEvents('done'),
      { type: 'response.in_progress', response: { id: RESPONSE_ID, status: 'in_progress' } },
    ])).rejects.toMatchObject({ code: 'protocol_error' });

    const provider = createProvider(async () => rawSseResponse(
      `event: response.in_progress\ndata: ${JSON.stringify(createdEvent())}\n\n`,
    ));
    await expect(provider.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    })).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('keeps transport errors bounded, drops provider-authored details, and preserves caller aborts', async () => {
    const apiKey = 'secret-key';
    const canary = 'echoed-private-prompt-canary';
    const denied = createOpenAIResponsesProvider({
      model: 'gpt-5-mini',
      apiKey,
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ error: { message: `${canary}: bad ${apiKey}` } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch,
    });
    await expect(denied.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    })).rejects.toMatchObject({
      code: 'http_error',
      status: 401,
      message: 'AI provider rejected the request (401).',
    });

    const nonSse = createProvider(async () => new Response('{}', {
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(nonSse.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    })).rejects.toMatchObject({ code: 'protocol_error' });

    const fetchImpl = vi.fn(async () => responsesSse(textEvents('never')));
    const aborted = createProvider(fetchImpl);
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'caller_abort' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const timedOut = createOpenAIResponsesProvider({
      model: 'gpt-5-mini',
      apiKey: 'test-key',
      requestTimeoutMs: 5,
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        })
      )) as typeof fetch,
    });
    await expect(timedOut.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    })).rejects.toMatchObject({ code: 'timeout' });
  });

  it.each([
    ['code', 'context_length_exceeded'],
    ['type', 'context_window_exceeded'],
    ['code', 'max_tokens'],
  ])('classifies the Responses machine %s %s as context overflow', async (field, machineCode) => {
    const canary = 'private-responses-message';
    const provider = createProvider(async () => new Response(JSON.stringify({
      error: { [field]: machineCode, message: canary },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const error = await provider.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    }).then(() => null, (reason: unknown) => reason as Error & {
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
      error: { message: 'Requested input exceeds the model maximum context length.' },
    })],
    [413, ''],
  ])('classifies a Responses overflow at HTTP %s without exposing it', async (status, body) => {
    const provider = createProvider(async () => new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(provider.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    })).rejects.toMatchObject({
      code: 'context_overflow',
      status,
      message: 'AI provider request exceeded the model context window.',
    });
  });

  it.each([
    ['unknown machine code', JSON.stringify({ error: { code: 'rate_limit_exceeded' } })],
    ['rate-limit message', JSON.stringify({
      error: { message: 'Rate limit exceeded: token limit exceeded for this minute.' },
    })],
    ['non-JSON body', 'context_window_exceeded'],
    ['error body over 4 KiB', JSON.stringify({
      error: { type: 'context_window_exceeded', message: 'x'.repeat(4_096) },
    })],
  ])('keeps Responses %s as an ordinary HTTP error', async (_name, body) => {
    const provider = createProvider(async () => new Response(body, { status: 400 }));
    await expect(provider.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    })).rejects.toMatchObject({ code: 'http_error', status: 400 });
  });

  it('rejects unsafe serialization and invalid named tool choices before fetch', () => {
    const fetchImpl = vi.fn();
    const provider = createProvider(fetchImpl);
    expect(() => provider.prepare?.({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      toolChoice: { name: 'missing' },
      maxOutputTokens: 8,
    })).toThrow(expect.objectContaining({ code: 'protocol_error' }));

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => provider.prepare?.({
      messages: [
        { role: 'user', content: 'Call the tool.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'read', arguments: cyclic }],
        },
        {
          role: 'tool',
          content: '{"ok":true,"data":{}}',
          toolCallId: 'call_1',
          toolName: 'read',
        },
      ],
      tools: [],
      maxOutputTokens: 8,
    })).toThrow(expect.objectContaining({ code: 'provider_serialization_error' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function createProvider(fetchImpl: typeof fetch | ((...args: any[]) => Promise<Response>)) {
  return createOpenAIResponsesProvider({
    model: 'gpt-5-mini',
    apiKey: 'test-key',
    fetchImpl: fetchImpl as typeof fetch,
    hostPermissionCheck: async () => true,
    validateRuntimeIdentity: async () => true,
  });
}

async function generate(events: Array<Record<string, unknown>>) {
  return createProvider(async () => responsesSse(events)).generate({
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxOutputTokens: 32,
  });
}

function textEvents(text: string): Array<Record<string, unknown>> {
  return [
    createdEvent(),
    outputAdded(0, { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
    contentAdded('msg_1', 0, 0, { type: 'output_text', text: '', annotations: [] }),
    textDelta('msg_1', 0, 0, text),
    textDone('msg_1', 0, 0, text),
    contentDone('msg_1', 0, 0, { type: 'output_text', text, annotations: [] }),
    outputDone(0, completedMessage('msg_1', text)),
    completedEvent(4, 2, 6),
  ];
}

function createdEvent() {
  return {
    type: 'response.created',
    response: { id: RESPONSE_ID, status: 'in_progress' },
  };
}

function completedEvent(
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  details: Record<string, unknown> = {},
) {
  return {
    type: 'response.completed',
    response: {
      id: RESPONSE_ID,
      status: 'completed',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        ...details,
      },
    },
  };
}

function outputAdded(outputIndex: number, item: Record<string, unknown>) {
  return {
    type: 'response.output_item.added',
    response_id: RESPONSE_ID,
    output_index: outputIndex,
    item,
  };
}

function outputDone(outputIndex: number, item: Record<string, unknown>) {
  return {
    type: 'response.output_item.done',
    response_id: RESPONSE_ID,
    output_index: outputIndex,
    item,
  };
}

function contentAdded(
  itemId: string,
  outputIndex: number,
  contentIndex: number,
  part: Record<string, unknown>,
) {
  return {
    type: 'response.content_part.added',
    response_id: RESPONSE_ID,
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    part,
  };
}

function contentDone(
  itemId: string,
  outputIndex: number,
  contentIndex: number,
  part: Record<string, unknown>,
) {
  return {
    type: 'response.content_part.done',
    response_id: RESPONSE_ID,
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    part,
  };
}

function textDelta(itemId: string, outputIndex: number, contentIndex: number, delta: string) {
  return {
    type: 'response.output_text.delta',
    response_id: RESPONSE_ID,
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    delta,
  };
}

function textDone(itemId: string, outputIndex: number, contentIndex: number, text: string) {
  return {
    type: 'response.output_text.done',
    response_id: RESPONSE_ID,
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    text,
  };
}

function functionDelta(itemId: string, outputIndex: number, delta: string) {
  return {
    type: 'response.function_call_arguments.delta',
    response_id: RESPONSE_ID,
    item_id: itemId,
    output_index: outputIndex,
    delta,
  };
}

function functionDone(itemId: string, outputIndex: number, args: string) {
  return {
    type: 'response.function_call_arguments.done',
    response_id: RESPONSE_ID,
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  };
}

function completedMessage(id: string, text: string) {
  return {
    id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function completedFunction(
  id: string,
  callId: string,
  name: string,
  args: string,
) {
  return {
    id,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: args,
  };
}

function responsesSse(
  events: Array<Record<string, unknown>>,
  chunkSizes?: number[],
): Response {
  return rawSseResponse(responsesSseBody(events), chunkSizes);
}

function responsesSseBody(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function rawSseResponse(body: string, chunkSizes?: number[]): Response {
  if (!chunkSizes) {
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  let chunkIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const size = chunkSizes[chunkIndex % chunkSizes.length];
      chunkIndex += 1;
      const end = Math.min(offset + size, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
