import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PROVIDER_RESPONSE_BYTES } from '@/agent-harness/provider';
import { createOpenAICompatibleProvider } from '@/agent-harness/providers/openai-compatible';
import type { ModelStreamEvent } from '@/agent-harness/provider-stream';

const encoder = new TextEncoder();

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenAI-compatible streaming adapter', () => {
  it('streams text and the final usage-only chunk through normalized events', async () => {
    const observed: ModelStreamEvent[] = [];
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return sseResponse([
          chunk({ role: 'assistant' }),
          chunk({ content: '你' }),
          chunk({ content: '好' }),
          chunk({}, 'stop'),
          {
            id: 'chat-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-5-mini',
            choices: [],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 2,
              total_tokens: 10,
              prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          },
          '[DONE]',
        ], [1, 2, 5, 3, 8]);
      }) as typeof fetch,
    });

    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Say hello' }],
      tools: [],
      maxOutputTokens: 16,
      onStreamEvent: (event) => observed.push(event),
    });

    expect(result).toEqual({
      content: '你好',
      finishReason: 'stop',
      usage: {
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 1,
      },
    });
    expect(observed.map((event) => event.type)).toEqual([
      'response_start',
      'text_delta',
      'text_delta',
      'usage',
      'response_end',
    ]);
    expect(requestBody).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it.each([
    ['non-object details', {
      prompt_tokens: 8, completion_tokens: 2, total_tokens: 10,
      prompt_tokens_details: 'invalid',
    }],
    ['fractional cached tokens', {
      prompt_tokens: 8, completion_tokens: 2, total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 1.5 },
    }],
    ['cache subsets larger than prompt tokens', {
      prompt_tokens: 8, completion_tokens: 2, total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 3 },
    }],
    ['reasoning larger than completion tokens', {
      prompt_tokens: 8, completion_tokens: 2, total_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 3 },
    }],
  ])('rejects malformed %s usage', async (_name, usage) => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => sseResponse([
        chunk({ content: 'done' }),
        chunk({}, 'stop'),
        { ...usageChunk(), usage },
        '[DONE]',
      ])) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 8 }))
      .rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('ignores empty data frames from compatible streaming gateways', async () => {
    const provider = createOpenAICompatibleProvider({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example/v1',
      model: 'custom-model',
      apiKey: 'sk-test',
      hostPermissionCheck: async () => true,
      fetchImpl: vi.fn(async () => new Response([
        'data:\n\n',
        `data: ${JSON.stringify(chunk({ content: 'OK' }))}\n\n`,
        `data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch,
    });

    await expect(provider.generate({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxOutputTokens: 8,
    })).resolves.toMatchObject({ content: 'OK', finishReason: 'stop' });
  });

  it('assembles interleaved indexed tool-call deltas only after complete JSON', async () => {
    const observed: ModelStreamEvent[] = [];
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => sseResponse([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call-search',
              type: 'function',
              function: { name: 'search_stars', arguments: '{"query":"' },
            },
            {
              index: 1,
              type: 'function',
              function: { arguments: '{"page":' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 1, id: 'call-tags' }] }),
        chunk({
          tool_calls: [
            { index: 1, function: { name: 'list_tags', arguments: '2}' } },
            { index: 0, function: { arguments: 'typescript"}' } },
          ],
        }),
        chunk({}, 'tool_calls'),
        '[DONE]',
      ])) as typeof fetch,
    });

    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Inspect repositories' }],
      tools: [
        { name: 'search_stars', description: 'Search stars', risk: 'read' },
        { name: 'list_tags', description: 'List tags', risk: 'read' },
      ],
      maxOutputTokens: 64,
      onStreamEvent: (event) => observed.push(event),
    });

    expect(result).toEqual({
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'call-search', name: 'search_stars', arguments: { query: 'typescript' } },
        { id: 'call-tags', name: 'list_tags', arguments: { page: 2 } },
      ],
    });
    expect(observed.filter((event) => event.type === 'tool_call_end')).toHaveLength(2);
    expect(observed.at(-1)).toEqual({ type: 'response_end', finishReason: 'tool_calls' });
  });

  it('sends stream_options.include_usage so relay services return token statistics', async () => {
    // OpenAI 官方与绝大多数 OpenAI 兼容中转站（new-api、one-api、aiping 等）按规范
    // 在 stream_options.include_usage=true 时，于流末尾返回 usage 统计；不识别该字段
    // 的服务端通常会安全忽略。Cubby 始终开启它以确保能拿到 token 用量用于计费/限制。
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatibleProvider({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      apiKey: 'sk-test',
      hostPermissionCheck: async () => true,
      fetchImpl: vi.fn(async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return sseResponse([chunk({ content: 'OK' }), chunk({}, 'stop'), '[DONE]']);
      }) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 8 }))
      .resolves.toMatchObject({ content: 'OK', finishReason: 'stop' });
    expect(requestBody?.stream).toBe(true);
    expect(requestBody?.stream_options).toEqual({ include_usage: true });
  });

  it.each([
    ['missing provider terminal', [chunk({ content: 'partial' }), chunk({}, 'stop')]],
    ['missing finish reason', [chunk({ content: 'partial' }), '[DONE]']],
    ['refusal', [chunk({ refusal: 'sensitive refusal detail' }), chunk({}, 'stop'), '[DONE]']],
    ['length', [chunk({ content: 'partial' }), chunk({}, 'length'), '[DONE]']],
    ['content filter', [chunk({ content: 'partial' }), chunk({}, 'content_filter'), '[DONE]']],
    ['unexpected role', [chunk({ role: 'user', content: 'wrong role' }), chunk({}, 'stop'), '[DONE]']],
    ['choice after finish', [
      chunk({ content: 'complete' }),
      chunk({}, 'stop'),
      chunk({ content: 'late data' }),
      '[DONE]',
    ]],
    ['usage before finish', [
      usageChunk(),
      chunk({ content: 'complete' }),
      chunk({}, 'stop'),
      '[DONE]',
    ]],
    ['usage mixed with choices', [
      { ...chunk({ content: 'complete' }), usage: usageChunk().usage },
      chunk({}, 'stop'),
      '[DONE]',
    ]],
  ])('fails closed for %s', async (_name, events) => {
    const observed: ModelStreamEvent[] = [];
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => sseResponse(events)) as typeof fetch,
    });

    const error = await provider.generate({
      messages: [],
      tools: [],
      maxOutputTokens: 8,
      onStreamEvent: (event) => observed.push(event),
    }).then(() => null, (reason: unknown) => reason as Error & { code?: string });

    expect(error?.code).toBe('protocol_error');
    expect(error?.message).not.toContain('sensitive refusal detail');
    expect(observed.at(-1)?.type).toBe('error');
  });

  it('keeps the request deadline active while an SSE body is stalled', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      requestTimeoutMs: 10,
      fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch,
    });
    const pending = provider.generate({ messages: [], tools: [], maxOutputTokens: 8 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(cancelled).toBe(true);
  });

  it('rejects an oversized declared SSE body before reading it', async () => {
    let cancelled = false;
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Content-Length': String(MAX_PROVIDER_RESPONSE_BYTES + 1),
        },
      })) as typeof fetch,
    });

    await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 8 }))
      .rejects.toMatchObject({ code: 'provider_response_too_large' });
    expect(cancelled).toBe(true);
  });
});

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-5-mini',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

function usageChunk() {
  return {
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-5-mini',
    choices: [],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  };
}

function sseResponse(
  events: readonly unknown[],
  chunkPattern: readonly number[] = [],
): Response {
  const source = events.map((event) =>
    `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = encoder.encode(source);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let patternIndex = 0;
      while (offset < bytes.byteLength) {
        const requested = chunkPattern[patternIndex % Math.max(chunkPattern.length, 1)] ?? bytes.byteLength;
        const size = Math.max(1, Math.min(requested, bytes.byteLength - offset));
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
        patternIndex += 1;
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}
