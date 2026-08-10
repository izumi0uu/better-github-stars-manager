import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_API_KEY_EMPTY,
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_BASE_URL_EMPTY,
  AGENT_PROVIDER_TIMEOUT,
} from '@/api/errors';
import {
  createOpenAICompatibleProvider,
  testOpenAICompatibleConnection,
} from '@/agent-harness/providers/openai-compatible';
import {
  AGENT_PROVIDER_DEADLINE_MS,
  AgentProviderError,
  MAX_PROVIDER_ERROR_BYTES,
  MAX_PROVIDER_HISTORY_BYTES,
  MAX_PROVIDER_OUTPUT_TOKENS,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
} from '@/agent-harness/provider';
import { createAgentTurnLiveness } from '@/agent-harness/liveness';

const encoder = new TextEncoder();

function sseResponse(events: readonly unknown[]): Response {
  const source = events.map((event) =>
    `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  return new Response(encoder.encode(source), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

function streamingChatResponse(payload: Record<string, unknown>): Response {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length !== 1 || !isRecord(choices[0])) {
    return sseResponse([payload, '[DONE]']);
  }
  const choice = choices[0];
  if (!isRecord(choice.message)) return sseResponse([payload, '[DONE]']);
  const message = choice.message;
  const delta: Record<string, unknown> = {};
  if (message.content !== undefined && message.content !== null) delta.content = message.content;
  if (message.refusal !== undefined && message.refusal !== null) delta.refusal = message.refusal;
  if (message.tool_calls !== undefined) {
    delta.tool_calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall, index) => isRecord(toolCall)
        ? { index, ...toolCall }
        : toolCall)
      : message.tool_calls;
  }
  const events: unknown[] = [streamChunk(delta), streamChunk({}, choice.finish_reason)];
  if (payload.usage !== undefined) {
    events.push({ choices: [], usage: payload.usage });
  }
  events.push('[DONE]');
  return sseResponse(events);
}

function streamChunk(delta: Record<string, unknown>, finishReason: unknown = null) {
  return {
    id: 'chat-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-5-mini',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function successfulProbeResponse(body: Record<string, unknown>): Response {
  const messages = body.messages as Array<{ role?: string }>;
  const hasToolResult = messages.some((message) => message.role === 'tool');
  return streamingChatResponse(hasToolResult
    ? {
        choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
      }
    : {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'probe-call-1',
              type: 'function',
              function: {
                name: 'bgsm_connection_probe',
                arguments: '{"nonce":"bgsm"}',
              },
            }],
          },
        }],
      });
}

function utf8FixtureWithExactBytes(byteLength: number): string {
  const encoder = new TextEncoder();
  const required = ['界', 'e\u0301', '😀'];
  let result = required.join('');
  let remaining = byteLength - encoder.encode(result).byteLength;
  if (remaining < 0) throw new Error('Fixture byte length is too small.');
  const units = [
    ['😀', 4],
    ['界', 3],
    ['\u0301', 2],
    ['a', 1],
  ] as const;
  for (const [value, bytes] of units) {
    while (remaining >= bytes) {
      result += value;
      remaining -= bytes;
    }
  }
  expect(remaining).toBe(0);
  expect(encoder.encode(result)).toHaveLength(byteLength);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('openai-compatible agent provider', () => {
  it('rejects Anthropic instead of dispatching it through the Chat adapter', () => {
    expect(() => createOpenAICompatibleProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'anthropic-secret',
    })).toThrow('AGENT_PROVIDER_UNSUPPORTED');
  });

  it('maps chat-completions responses into agent content and tool calls', async () => {
    const fetchMock = vi.fn(async () =>
      streamingChatResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Found something useful.',
              tool_calls: [
                {
                  id: 'call-1',
                  function: {
                    name: 'search_stars',
                    arguments: '{"query":"typescript"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Find TypeScript repos' }],
      maxOutputTokens: 777,
      tools: [
        {
          name: 'search_stars',
          description: 'Search local stars.',
          risk: 'read',
        },
      ],
    });

    expect(result.content).toBe('Found something useful.');
    expect(result.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'search_stars',
        arguments: { query: 'typescript' },
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-5-mini');
    expect(body.max_completion_tokens).toBe(777);
    expect(body.tools[0].function.parameters.additionalProperties).toBe(true);
  });

  it('normalizes a structured stream error as context overflow without exposing its body', async () => {
    const canary = 'private-stream-overflow-detail';
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => sseResponse([{
        error: { code: 'context_length_exceeded', message: canary },
      }])) as typeof fetch,
    });

    let error: AgentProviderError | undefined;
    try {
      await provider.generate({ messages: [], tools: [], maxOutputTokens: 8 });
    } catch (caught) {
      error = caught as AgentProviderError;
    }
    expect(error).toMatchObject({
      code: 'context_overflow',
      message: 'AI provider request exceeded the model context window.',
    });
    expect(error?.message).not.toContain(canary);
  });

  it('keeps a non-overflow stream error as a sanitized protocol failure', async () => {
    const canary = 'private-stream-rate-detail';
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => sseResponse([{
        error: { code: 'rate_limit_exceeded', message: canary },
      }])) as typeof fetch,
    });

    let error: AgentProviderError | undefined;
    try {
      await provider.generate({ messages: [], tools: [], maxOutputTokens: 8 });
    } catch (caught) {
      error = caught as AgentProviderError;
    }
    expect(error?.code).toBe('protocol_error');
    expect(error?.message).not.toContain(canary);
  });

  it('preserves the active-turn prompt and untrusted summary as separate user messages', () => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
    });
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
    if (!prepared) throw new Error('expected prepared Chat Completions request');

    const request = JSON.parse(prepared.serializedRequestBody);
    expect(request.messages).toEqual([
      { role: 'system', content: 'System policy.' },
      { role: 'user', content: 'Original current request.' },
      { role: 'user', content: 'Active-turn progress summary (untrusted).' },
      {
        role: 'assistant',
        content: 'Reading the retained page.',
        tool_calls: [{
          id: 'retained-call',
          type: 'function',
          function: { name: 'read_page', arguments: '{"page":2}' },
        }],
      },
      {
        role: 'tool',
        content: '{"ok":true,"data":{"page":2}}',
        tool_call_id: 'retained-call',
      },
    ]);
  });

  it('normalizes finish reason and internally consistent usage diagnostics', async () => {
    const responses = [
      {
        choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      },
      {
        choices: [{ finish_reason: 'length', message: { content: 'Partial.' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 999 },
      },
    ];
    const fetchMock = vi.fn(async () => streamingChatResponse(responses.shift()!));
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });

    const valid = await provider.generate({ messages: [], tools: [], maxOutputTokens: 12 });
    const inconsistent = provider.generate({ messages: [], tools: [], maxOutputTokens: 12 });

    expect(valid.finishReason).toBe('stop');
    expect(valid.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    await expect(inconsistent).rejects.toMatchObject({
      code: 'protocol_error',
    });
  });

  it('preserves prior assistant tool calls and matching tool results in later turns', async () => {
    const fetchMock = vi.fn(async () =>
      streamingChatResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'Continued.' } }],
      }),
    );
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });

    await provider.generate({
      messages: [
        { role: 'user', content: 'Inspect my tags' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'list_tags', arguments: {} }],
        },
        {
          role: 'tool',
          content: '{"ok":true,"data":{"tags":[]}}',
          toolCallId: 'call-1',
          toolName: 'list_tags',
        },
        { role: 'assistant', content: 'I inspected your tags.' },
        { role: 'user', content: 'What changed?' },
      ],
      tools: [],
      maxOutputTokens: 128,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'list_tags', arguments: '{}' },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'tool',
      content: '{"ok":true,"data":{"tags":[]}}',
      tool_call_id: 'call-1',
    });
  });

  it('uses OpenRouter headers for connection tests', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      successfulProbeResponse(JSON.parse(String(init?.body))),
    );

    const result = await testOpenAICompatibleConnection({
      provider: 'openrouter',
      model: 'openrouter/auto',
      apiKey: 'sk-or-test',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.providerLabel).toBe('OpenRouter');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-or-test',
      'HTTP-Referer': 'https://github.com/izumi0uu/better-github-stars-manager',
      'X-Title': 'Better GitHub Stars Manager',
    });
    const firstBody = JSON.parse(String(init.body));
    const secondBody = JSON.parse(String(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body,
    ));
    expect(firstBody.tools).toHaveLength(1);
    expect(firstBody.tools[0].function.name).toBe('bgsm_connection_probe');
    expect(firstBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'bgsm_connection_probe' },
    });
    expect(secondBody.messages[1].tool_calls[0].id).toBe('probe-call-1');
    expect(secondBody.messages[2].tool_call_id).toBe('probe-call-1');
  });

  it('calls the default service-worker fetch with the global receiver', async () => {
    const fetchMock = vi.fn(function fetchWithReceiverCheck(this: unknown, _url: string | URL | Request, init?: RequestInit) {
      expect(this).toBe(globalThis);
      return Promise.resolve(successfulProbeResponse(JSON.parse(String(init?.body))));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testOpenAICompatibleConnection({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
    });

    expect(result.preview).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts hung provider requests with a stable timeout error', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      requestTimeoutMs: 10,
      fetchImpl: fetchMock as typeof fetch,
    });
    const pending = provider.generate({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxOutputTokens: 32,
    });
    const assertion = expect(pending).rejects.toThrow(AGENT_PROVIDER_TIMEOUT);

    await vi.advanceTimersByTimeAsync(10);

    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('defers its fixed request deadline to a liveness-managed Agent request', async () => {
    vi.useFakeTimers();
    const liveness = createAgentTurnLiveness();
    const request = liveness.beginProviderRequest();
    let resolveFetchStart!: (signal: AbortSignal | undefined) => void;
    const fetchStarted = new Promise<AbortSignal | undefined>((resolve) => {
      resolveFetchStart = resolve;
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      requestTimeoutMs: 1,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
      fetchImpl: vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        resolveFetchStart(init?.signal as AbortSignal | undefined);
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(streamingChatResponse({
            choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          })), 2);
        });
      }) as typeof fetch,
    });

    try {
      const pending = provider.generate({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        maxOutputTokens: 32,
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

  it.each(['host permission', 'runtime identity'] as const)(
    'applies the request deadline while %s validation is stalled',
    async (boundary) => {
      vi.useFakeTimers();
      const gate = Promise.withResolvers<boolean>();
      const fetchMock = vi.fn();
      const provider = createOpenAICompatibleProvider({
        provider: 'openai',
        model: 'gpt-5-mini',
        apiKey: 'sk-test',
        requestTimeoutMs: 10,
        fetchImpl: fetchMock as typeof fetch,
        hostPermissionCheck: boundary === 'host permission'
          ? () => gate.promise
          : async () => true,
        validateRuntimeIdentity: boundary === 'runtime identity'
          ? () => gate.promise
          : async () => true,
      });
      const pending = provider.generate({ messages: [], tools: [], maxOutputTokens: 12 });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('uses a custom OpenAI-compatible base URL', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      successfulProbeResponse(JSON.parse(String(init?.body))),
    );

    const result = await testOpenAICompatibleConnection({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1/',
      model: 'custom-model',
      apiKey: 'sk-custom-test',
      fetchImpl: fetchMock as typeof fetch,
      hostPermissionCheck: async () => true,
    });

    expect(result.providerLabel).toBe('Custom AI service');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.example.com/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-custom-test',
    });
  });

  it('accepts a custom service endpoint pasted as a full chat-completions URL', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      successfulProbeResponse(JSON.parse(String(init?.body))),
    );

    await testOpenAICompatibleConnection({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1/chat/completions',
      model: 'custom-model',
      apiKey: 'sk-custom-test',
      fetchImpl: fetchMock as typeof fetch,
      hostPermissionCheck: async () => true,
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.example.com/v1/chat/completions');
  });

  it('rejects an empty custom base URL before making a network call', async () => {
    const fetchMock = vi.fn();

    await expect(
      testOpenAICompatibleConnection({
        provider: 'custom-openai-compatible',
        baseUrl: '   ',
        model: 'custom-model',
        apiKey: 'sk-custom-test',
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow(AGENT_BASE_URL_EMPTY);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty API key before making a network call', async () => {
    const fetchMock = vi.fn();

    await expect(
      testOpenAICompatibleConnection({
        provider: 'openai',
        model: 'gpt-5-mini',
        apiKey: '   ',
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow(AGENT_API_KEY_EMPTY);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never exposes provider-authored error details', async () => {
    const apiKey = 'sk-test.$*+?()[{\\^|';
    const canary = 'echoed-private-prompt-canary';
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: `Upstream echoed ${canary} and Bearer ${apiKey}.`,
          },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey,
      fetchImpl: fetchMock as typeof fetch,
    });

    const error = await provider.generate({
      messages: [],
      tools: [],
      maxOutputTokens: 32,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('AI provider rejected the request (401).');
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(canary);
  });

  it('reduces ordinary gateway errors to status-only product copy', async () => {
    const message = 'Gateway temporarily unavailable; retry later.';
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(provider.generate({
      messages: [],
      tools: [],
      maxOutputTokens: 32,
    })).rejects.toThrow('AI provider rejected the request (503).');
  });

  it.each([
    ['code', 'context_length_exceeded'],
    ['type', 'context_window_exceeded'],
    ['code', 'max_tokens'],
  ])('classifies the OpenAI machine %s %s as context overflow', async (field, machineCode) => {
    const canary = 'private-prompt-must-not-escape';
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: { [field]: machineCode, message: canary },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    });

    const error = await provider.generate({ messages: [], tools: [], maxOutputTokens: 8 })
      .then(() => null, (reason: unknown) => reason as AgentProviderError);
    expect(error).toMatchObject({
      code: 'context_overflow',
      status: 400,
      message: 'AI provider request exceeded the model context window.',
    });
    expect(error?.message).not.toContain(canary);
  });

  it.each([
    [400, JSON.stringify({
      error: { message: "This endpoint's maximum context length is 131072 tokens." },
    })],
    [413, ''],
  ])('classifies structured proxy overflow at HTTP %s without exposing its body', async (status, body) => {
    const provider = createOpenAICompatibleProvider({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://proxy.example.com/v1',
      model: 'proxy-model',
      apiKey: 'sk-test',
      hostPermissionCheck: async () => true,
      fetchImpl: vi.fn(async () => new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 8 }))
      .rejects.toMatchObject({
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
    ['non-JSON body', 'context_length_exceeded'],
    ['error body over 4 KiB', JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'x'.repeat(MAX_PROVIDER_ERROR_BYTES) },
    })],
  ])('keeps %s as an ordinary bounded HTTP error', async (_name, body) => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => new Response(body, { status: 400 })) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 8 }))
      .rejects.toMatchObject({
        code: 'http_error',
        status: 400,
        message: 'AI provider rejected the request (400).',
      });
  });

  it('serializes required and named tool choices and rejects oversized output budgets before fetch', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => streamingChatResponse({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'search_stars', arguments: '{}' },
          }],
        },
      }],
    }));
    const provider = createOpenAICompatibleProvider({
      provider: 'openrouter',
      model: 'openrouter/auto',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });
    const tools = [{ name: 'search_stars', description: 'Search.', risk: 'read' as const }];

    await provider.generate({ messages: [], tools, toolChoice: 'required', maxOutputTokens: 12 });
    await provider.generate({ messages: [], tools, toolChoice: { name: 'search_stars' }, maxOutputTokens: 12 });
    await provider.generate({
      messages: [],
      tools,
      toolChoice: 'auto',
      maxOutputTokens: MAX_PROVIDER_OUTPUT_TOKENS,
    });
    const first = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(first.tool_choice).toBe('required');
    expect(first.max_tokens).toBe(12);
    expect(second.tool_choice).toEqual({
      type: 'function',
      function: { name: 'search_stars' },
    });
    const third = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect(third.tool_choice).toBe('auto');
    expect(third.max_tokens).toBe(8192);

    await expect(provider.generate({
      messages: [],
      tools,
      maxOutputTokens: MAX_PROVIDER_OUTPUT_TOKENS + 1,
    })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    new Response(null, { status: 204 }),
    new Response('<html>nope</html>', { status: 200 }),
    new Response('{}', { status: 200 }),
    new Response(JSON.stringify({ error: { message: 'hidden failure' } }), { status: 200 }),
    new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: null } }],
    }), { status: 200 }),
    new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '   ' } }],
    }), { status: 200 }),
    new Response(JSON.stringify({ choices: [{
      finish_reason: 'tool_calls',
      message: { tool_calls: [{ id: '', function: { name: 'x', arguments: '{}' } }] },
    }] }), { status: 200 }),
  ])('rejects malformed successful response %#', async (response) => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => response) as typeof fetch,
    });
    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 12 }))
      .rejects.toBeInstanceOf(AgentProviderError);
  });

  it('caps streamed raw response bodies independently from decoded payload size', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 12 }))
      .rejects.toMatchObject({ code: 'provider_response_too_large' });
  });

  it('keeps the deadline active while a response body is stalled', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      requestTimeoutMs: 10,
      fetchImpl: vi.fn(async () => new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch,
    });
    const pending = provider.generate({ messages: [], tools: [], maxOutputTokens: 12 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(cancelled).toBe(true);
  });

  it('shares one 20-second deadline across both capability-probe requests', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(successfulProbeResponse(
            JSON.parse(String(init?.body)),
          )), 15_000);
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const pending = testOpenAICompatibleConnection({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('makes zero fetches when permission is denied or the exact origin mismatches', async () => {
    const fetchMock = vi.fn();
    const denied = createOpenAICompatibleProvider({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com:8443/v1',
      model: 'custom-model',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
      hostPermissionCheck: async () => false,
    });
    await expect(denied.generate({ messages: [], tools: [], maxOutputTokens: 12 }))
      .rejects.toThrow('AGENT_HOST_PERMISSION_DENIED');

    const mismatch = createOpenAICompatibleProvider({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com:8443/v1',
      model: 'custom-model',
      apiKey: 'sk-test',
      expectedOrigin: 'https://relay.example.com',
      fetchImpl: fetchMock as typeof fetch,
      hostPermissionCheck: async () => true,
    });
    await expect(mismatch.generate({ messages: [], tools: [], maxOutputTokens: 12 }))
      .rejects.toThrow('AGENT_PROVIDER_ORIGIN_MISMATCH');

    const staleIdentity = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'stale-saved-key',
      fetchImpl: fetchMock as typeof fetch,
      validateRuntimeIdentity: async () => false,
    });
    await expect(staleIdentity.generate({ messages: [], tools: [], maxOutputTokens: 12 }))
      .rejects.toThrow('AGENT_PROVIDER_IDENTITY_CHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves disclosure revocation raised during runtime identity validation', async () => {
    const fetchMock = vi.fn();
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'saved-key',
      fetchImpl: fetchMock as typeof fetch,
      validateRuntimeIdentity: async () => {
        throw new Error(AGENT_DATA_DISCLOSURE_REQUIRED);
      },
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 12 }))
      .rejects.toThrow(AGENT_DATA_DISCLOSURE_REQUIRED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revalidates saved identity before both probe fetches', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      successfulProbeResponse(JSON.parse(String(init?.body))));
    const validateRuntimeIdentity = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(testOpenAICompatibleConnection({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'saved-key',
      fetchImpl: fetchMock as typeof fetch,
      validateRuntimeIdentity,
    })).rejects.toThrow('AGENT_PROVIDER_IDENTITY_CHANGED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(validateRuntimeIdentity).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized history and complete request bodies before fetch', async () => {
    const fetchMock = vi.fn();
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });
    await expect(provider.generate({
      messages: [{ role: 'user', content: 'x'.repeat(MAX_PROVIDER_HISTORY_BYTES) }],
      tools: [],
      maxOutputTokens: 12,
    })).rejects.toMatchObject({ code: 'provider_history_too_large' });
    await expect(provider.generate({
      messages: [],
      tools: [{
        name: 'oversized_tool',
        description: 'x'.repeat(MAX_PROVIDER_REQUEST_BYTES),
        risk: 'read',
      }],
      maxOutputTokens: 12,
    })).rejects.toMatchObject({ code: 'provider_request_too_large' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds redacted provider errors by UTF-8 bytes', async () => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-secret',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: { message: `sk-secret${'界'.repeat(10_000)}` },
      }), { status: 500 })) as typeof fetch,
    });
    const error = await provider.generate({ messages: [], tools: [], maxOutputTokens: 12 })
      .then(() => null, (reason: unknown) => reason as Error);
    expect(error).toBeInstanceOf(Error);
    expect(new TextEncoder().encode(error!.message).byteLength)
      .toBeLessThanOrEqual(MAX_PROVIDER_ERROR_BYTES);
    expect(error!.message).not.toContain('sk-secret');
  });

  it.each([
    [{}, 'missing nonce'],
    [{ nonce: 'wrong' }, 'wrong nonce'],
    [{ nonce: 'bgsm', extra: true }, 'extra property'],
  ])('rejects probe arguments with %s before the acknowledgement request', async (args, _label) => {
    const fetchMock = vi.fn(async () => streamingChatResponse({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [{
            id: 'probe-call',
            type: 'function',
            function: {
              name: 'bgsm_connection_probe',
              arguments: JSON.stringify(args),
            },
          }],
        },
      }],
    }));

    await expect(testOpenAICompatibleConnection({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      choices: [{ finish_reason: 'tool_calls', message: { content: null } }],
    },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{
          id: 'wrong-tool', type: 'function',
          function: { name: 'not_the_probe', arguments: '{"nonce":"bgsm"}' },
        }] },
      }],
    },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: ['a', 'b'].map((id) => ({
          id, type: 'function',
          function: { name: 'bgsm_connection_probe', arguments: '{"nonce":"bgsm"}' },
        })) },
      }],
    },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{
          id: 'bad-json', type: 'function',
          function: { name: 'bgsm_connection_probe', arguments: '{bad' },
        }] },
      }],
    },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{
          id: 'non-object', type: 'function',
          function: { name: 'bgsm_connection_probe', arguments: '[]' },
        }] },
      }],
    },
  ])('rejects malformed first probe call shape %# with no second fetch', async (payload) => {
    const fetchMock = vi.fn(async () => streamingChatResponse(payload));
    await expect(testOpenAICompatibleConnection({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: fetchMock as typeof fetch,
    })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { finish_reason: 'stop', message: { content: '' } },
    { finish_reason: 'length', message: { content: 'partial' } },
    { finish_reason: 'stop', message: { refusal: 'no', content: null } },
    {
      finish_reason: 'tool_calls',
      message: {
        tool_calls: [{
          id: 'probe-again',
          type: 'function',
          function: { name: 'bgsm_connection_probe', arguments: '{"nonce":"bgsm"}' },
        }],
      },
    },
  ])('rejects malformed probe acknowledgement %#', async (acknowledgement) => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      call++;
      return call === 1
        ? successfulProbeResponse(JSON.parse(String(init?.body)))
        : streamingChatResponse({ choices: [acknowledgement] });
    });

    await expect(testOpenAICompatibleConnection({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { choices: [null] },
    { choices: [[]] },
    { choices: [{ finish_reason: 'stop', message: null }] },
    { choices: [{ finish_reason: 'stop', message: [] }] },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [null] },
      }],
    },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ id: 'x', function: [] }] },
      }],
    },
    {
      choices: [
        { finish_reason: 'length', message: { content: 'bad first choice' } },
        { finish_reason: 'stop', message: { content: 'valid later choice' } },
      ],
    },
    {
      choices: [{ finish_reason: 'content_filter', message: { content: 'filtered' } }],
    },
  ])('normalizes adversarial response shape %# to bounded protocol_error', async (payload) => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => streamingChatResponse(payload)) as typeof fetch,
    });
    const error = await provider.generate({ messages: [], tools: [], maxOutputTokens: 32 })
      .then(() => null, (reason: unknown) => reason as AgentProviderError);
    expect(error).toMatchObject({ code: 'protocol_error' });
    expect(new TextEncoder().encode(error!.message).byteLength)
      .toBeLessThanOrEqual(MAX_PROVIDER_ERROR_BYTES);
  });

  it.each([
    { choices: [] },
    { choices: [{ finish_reason: 'stop' }] },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{
          id: 'empty-name', type: 'function',
          function: { name: ' ', arguments: '{}' },
        }] },
      }],
    },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{
          id: 'bad-json', type: 'function',
          function: { name: 'probe', arguments: '{bad' },
        }] },
      }],
    },
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{
          id: 'non-object', type: 'function',
          function: { name: 'probe', arguments: '"string"' },
        }] },
      }],
    },
  ])('direct strict parser case %# returns protocol_error', async (payload) => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: vi.fn(async () => streamingChatResponse(payload)) as typeof fetch,
    });
    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 1 }))
      .rejects.toMatchObject({ code: 'protocol_error' });
  });

  it.each([
    () => {
      const args: Record<string, unknown> = {};
      args.self = args;
      return {
        messages: [{
          role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'x', arguments: args }],
        }],
        tools: [],
      };
    },
    () => ({
      messages: [{ role: 'user', content: 1n } as never],
      tools: [],
    }),
    () => ({
      messages: [{
        role: 'user',
        content: { toJSON() { throw new Error('secret dynamic detail'); } },
      } as never],
      tools: [],
    }),
    () => ({
      messages: [],
      tools: [{
        name: 'bad_schema',
        description: 'bad',
        risk: 'read' as const,
        parameters: { type: 'object', value: 1n } as never,
      }],
    }),
  ])('normalizes outbound serialization failure %# before fetch', (buildInput) => {
    const fetchMock = vi.fn();
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as typeof fetch,
    });
    const input = {
      ...buildInput(),
      maxOutputTokens: 32,
    } as Parameters<typeof provider.generate>[0];
    return expect(provider.generate(input)).rejects.toMatchObject({
      code: 'provider_serialization_error',
      message: expect.not.stringContaining('secret dynamic detail'),
    }).then(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it('admits exact UTF-8 history/request limits and rejects plus one before fetch', async () => {
    const fetchMock = vi.fn(async () => streamingChatResponse({
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    }));
    const openAI = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: fetchMock as typeof fetch,
    });
    const emptyHistoryBytes = new TextEncoder().encode(JSON.stringify([
      { role: 'user', content: '' },
    ])).byteLength;
    const exactHistory = utf8FixtureWithExactBytes(
      MAX_PROVIDER_HISTORY_BYTES - emptyHistoryBytes,
    );
    await openAI.generate({
      messages: [{ role: 'user', content: exactHistory }],
      tools: [],
      maxOutputTokens: 1,
    });
    const exactHistoryBody = String(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    );
    const exactHistoryValue = JSON.parse(exactHistoryBody);
    expect(new TextEncoder().encode(JSON.stringify(exactHistoryValue.messages)))
      .toHaveLength(MAX_PROVIDER_HISTORY_BYTES);
    expect(exactHistoryBody).toBe(JSON.stringify(exactHistoryValue));
    await expect(openAI.generate({
      messages: [{ role: 'user', content: `${exactHistory}x` }],
      tools: [],
      maxOutputTokens: 1,
    })).rejects.toMatchObject({ code: 'provider_history_too_large' });

    const requestShape = (description: string) => ({
      model: 'openrouter/auto',
      messages: [],
      tools: [{
        type: 'function',
        function: {
          name: 'sized_tool',
          description,
          parameters: { type: 'object', properties: {}, additionalProperties: true },
        },
      }],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1,
    });
    const emptyRequestBytes = new TextEncoder().encode(
      JSON.stringify(requestShape('')),
    ).byteLength;
    const exactDescription = utf8FixtureWithExactBytes(
      MAX_PROVIDER_REQUEST_BYTES - emptyRequestBytes,
    );
    const openRouter = createOpenAICompatibleProvider({
      provider: 'openrouter', model: 'openrouter/auto', apiKey: 'sk',
      fetchImpl: fetchMock as typeof fetch,
    });
    const tool = (description: string) => [{
      name: 'sized_tool', description, risk: 'read' as const,
    }];
    await openRouter.generate({
      messages: [], tools: tool(exactDescription), maxOutputTokens: 1,
    });
    const exactRequestBody = String(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body,
    );
    expect(new TextEncoder().encode(exactRequestBody))
      .toHaveLength(MAX_PROVIDER_REQUEST_BYTES);
    expect(exactRequestBody).toBe(JSON.stringify(JSON.parse(exactRequestBody)));
    await expect(openRouter.generate({
      messages: [], tools: tool(`${exactDescription}x`), maxOutputTokens: 1,
    })).rejects.toMatchObject({ code: 'provider_request_too_large' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails oversized Content-Length without awaiting a non-settling body cancel', async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: vi.fn(async () => new Response(stream, {
        headers: { 'Content-Length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) },
      })) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 1 }))
      .rejects.toMatchObject({ code: 'provider_response_too_large' });
    expect(cancelCalled).toBe(true);
  });

  it.each([
    [200, 'provider_response_too_large'],
    [500, 'http_error'],
  ])('enforces the applicable body cap with lying Content-Length at HTTP %i', async (status, code) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: vi.fn(async () => new Response(stream, {
        status,
        headers: {
          'Content-Length': '1',
          ...(status === 200 ? { 'Content-Type': 'text/event-stream' } : {}),
        },
      })) as typeof fetch,
    });
    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 1 }))
      .rejects.toMatchObject({ code });
  });

  it('distinguishes caller abort before headers and during body read', async () => {
    const beforeController = new AbortController();
    const beforeFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      }));
    const beforeProvider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: beforeFetch as typeof fetch,
    });
    const before = beforeProvider.generate({
      messages: [], tools: [], maxOutputTokens: 1, signal: beforeController.signal,
    });
    beforeController.abort();
    await expect(before).rejects.toMatchObject({ code: 'caller_abort' });

    let bodyCancelled = false;
    let markBodyReadStarted!: () => void;
    const bodyReadStarted = new Promise<void>((resolve) => {
      markBodyReadStarted = resolve;
    });
    const bodyController = new AbortController();
    const bodyFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { markBodyReadStarted(); },
      cancel() { bodyCancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const bodyProvider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: bodyFetch as typeof fetch,
    });
    const during = bodyProvider.generate({
      messages: [], tools: [], maxOutputTokens: 1, signal: bodyController.signal,
    });
    await vi.waitFor(() => expect(bodyFetch).toHaveBeenCalledOnce());
    await bodyReadStarted;
    bodyController.abort();
    await expect(during).rejects.toMatchObject({ code: 'caller_abort' });
    expect(bodyCancelled).toBe(true);
  });

  it('uses absolute expiry even when the timer callback has not run', async () => {
    let nowCalls = 0;
    const provider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      requestTimeoutMs: 1000,
      now: () => ++nowCalls >= 6 ? 1000 : 0,
      fetchImpl: vi.fn(async () => streamingChatResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      })) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 1 }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(nowCalls).toBeGreaterThanOrEqual(6);
  });

  it.each([
    ['non-stream response validation', 6, () => new Response(new Uint8Array([0xc3, 0x28]))],
    ['missing stream content type', 6, () => new Response('{invalid')],
    ['HTTP error construction', 9, () => new Response(
      JSON.stringify({ error: { message: 'denied' } }),
      { status: 401 },
    )],
    ['stream protocol validation error', 6, () => sseResponse([{ choices: [] }, '[DONE]'])],
  ] as const)(
    'gives absolute timeout precedence when expiry occurs during %s',
    async (_name, expireAtCheck, responseFactory) => {
      let nowCalls = 0;
      const provider = createOpenAICompatibleProvider({
        provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
        requestTimeoutMs: 1000,
        now: () => ++nowCalls >= expireAtCheck ? 1000 : 0,
        fetchImpl: vi.fn(async () => responseFactory()) as typeof fetch,
      });

      await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 1 }))
        .rejects.toMatchObject({ code: 'timeout' });
      expect(nowCalls).toBeGreaterThanOrEqual(expireAtCheck);
    },
  );

  it('cleans one source listener and timer exactly once after settlement', async () => {
    vi.useFakeTimers();
    const source = new AbortController();
    const addSpy = vi.spyOn(source.signal, 'addEventListener');
    const removeSpy = vi.spyOn(source.signal, 'removeEventListener');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      firstSignal ??= init?.signal as AbortSignal;
      return streamingChatResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      });
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: fetchMock as typeof fetch,
    });

    await provider.generate({
      messages: [], tools: [], maxOutputTokens: 1, signal: source.signal,
    });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGENT_PROVIDER_DEADLINE_MS);
    expect(firstSignal?.aborted).toBe(false);

    await provider.generate({ messages: [], tools: [], maxOutputTokens: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    addSpy.mockRestore();
    removeSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  // 中转站（aiping.cn / new-api / one-api 等）常见非标准形态：
  // 1) 最后一个 chunk 同时带 choices[].finish_reason 与 usage（合并尾包）
  // 2) delta 中混入非标准字段（如 GLM 的 reasoning_content）
  // 这里确保两者都被正确接受，不触发 protocol_error。
  it('accepts a relay-style stream that combines the final choice and usage in one chunk', async () => {
    const events: unknown[] = [
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'g',
        choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '思考中...' }, finish_reason: null }],
        system_fingerprint: 'fp_x', sla_metrics: { ttft_ms: 12 } },
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'g',
        choices: [{ index: 0, delta: { reasoning_content: '继续。' }, finish_reason: null }],
        system_fingerprint: 'fp_x' },
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'g',
        choices: [{ index: 0, delta: { content: 'PONG' }, finish_reason: null }] },
      // 合并尾包：choices[0].finish_reason="stop" 与 usage 同时存在
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'g',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 15, completion_tokens: 182, total_tokens: 197 } },
      '[DONE]',
    ];
    const fetchMock = vi.fn(async () => sseResponse(events));
    const provider = createOpenAICompatibleProvider({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      model: 'GLM-4.7-Flash',
      apiKey: 'sk-relay',
      fetchImpl: fetchMock as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    const result = await provider.generate({
      messages: [{ role: 'user', content: 'PONG' }],
      tools: [],
      maxOutputTokens: 64,
    });
    expect(result.content).toBe('PONG');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 182,
      totalTokens: 197,
    });
  });

  it('sends stream_options.include_usage on the custom-openai-compatible request', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // 断言请求体后再回复：先把请求 body 取出来检查，再返回固定流。
      const body = JSON.parse(String(init?.body));
      capturedRequestBodies.push(body);
      return streamingChatResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'PONG' } }],
      });
    });
    const capturedRequestBodies: unknown[] = [];
    const provider = createOpenAICompatibleProvider({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      model: 'GLM-4.7-Flash',
      apiKey: 'sk-relay',
      fetchImpl: fetchMock as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    await provider.generate({
      messages: [{ role: 'user', content: 'PONG' }],
      tools: [],
      maxOutputTokens: 64,
    });
    const body = capturedRequestBodies[0] as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('still rejects a usage chunk emitted before any finish reason', async () => {
    // 一些不规范中转站会在尚未给出 finish_reason 的早期 chunk 中就附带 usage；
    // 这种"超前 usage"应当被识别为 protocol_error（结束条件异常），而不是被吞掉。
    const events: unknown[] = [
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'g',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'g',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ];
    const provider = createOpenAICompatibleProvider({
      provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk',
      fetchImpl: vi.fn(async () => sseResponse(events)) as typeof fetch,
    });
    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 16 }))
      .rejects.toMatchObject({ code: 'protocol_error' });
  });
});
