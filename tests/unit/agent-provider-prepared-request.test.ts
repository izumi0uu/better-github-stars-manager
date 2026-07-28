import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider } from '@/agent-harness/providers/openai-compatible';
import { createOpenAIResponsesProvider } from '@/agent-harness/providers/openai-responses';
import { createAnthropicMessagesProvider } from '@/agent-harness/providers/anthropic';
import {
  MAX_PROVIDER_HISTORY_BYTES,
  MAX_PROVIDER_REQUEST_BYTES,
  type ExactRequestModelProvider,
  type ModelRequestShape,
} from '@/agent-harness/provider';

function streamingTextResponse(content: string): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { content }, finish_reason: null }], usage: null },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('prepared provider requests', () => {
  it('accounts the exact UTF-8 body later sent and keeps prepared requests single-use', async () => {
    const bodies: string[] = [];
    const observed: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return streamingTextResponse('ok');
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'test-key',
      fetchImpl: fetchImpl as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    const request = {
      messages: [{ role: 'user', content: 'Classify this repository.' }],
      tools: [],
      maxOutputTokens: 32,
    } as const;
    const inspection = provider.inspectRequest?.({
      messages: [...request.messages],
      tools: [],
      maxOutputTokens: request.maxOutputTokens,
    });
    const prepared = provider.prepare?.({
      messages: [...request.messages],
      tools: [],
      maxOutputTokens: request.maxOutputTokens,
      onStreamEvent: (event) => observed.push(event.type),
    });
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected prepared provider request');
    expect(inspection).toMatchObject({ accepted: true });
    expect(prepared.inspection).toEqual(inspection);
    expect(prepared.serializedRequestBytes).toBe(
      new TextEncoder().encode(prepared.serializedRequestBody).byteLength,
    );
    expect(JSON.parse(prepared.serializedRequestBody)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });

    await expect(prepared.execute()).resolves.toMatchObject({ content: 'ok' });
    expect(bodies).toEqual([prepared.serializedRequestBody]);
    expect(observed).toEqual(['response_start', 'text_delta', 'response_end']);
    await expect(prepared.execute()).rejects.toMatchObject({ code: 'protocol_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps generate on the same exact preparation and execution path', async () => {
    let body = '';
    const provider = createOpenAICompatibleProvider({
      provider: 'openrouter',
      model: 'openrouter/auto',
      apiKey: 'test-key',
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body);
        return streamingTextResponse('ok');
      }) as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    await provider.generate({
      messages: [{ role: 'user' as const, content: 'Hello' }],
      tools: [],
      maxOutputTokens: 16,
    });
    expect(JSON.parse(body)).toMatchObject({
      model: 'openrouter/auto',
      max_tokens: 16,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user' as const, content: 'Hello' }],
    });
  });

  it('keeps Responses on its exact prepared execution path', async () => {
    let body = '';
    const observed: string[] = [];
    const provider = createOpenAIResponsesProvider({
      model: 'gpt-5-mini',
      apiKey: 'test-key',
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body);
        return streamingResponsesTextResponse('ok');
      }) as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    const request = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
      tools: [],
      maxOutputTokens: 16,
    };
    const inspection = provider.inspectRequest(request);
    const prepared = provider.prepare({
      ...request,
      onStreamEvent: (event) => observed.push(event.type),
    });
    await expect(prepared.execute()).resolves.toMatchObject({ content: 'ok', finishReason: 'stop' });
    expect(inspection).toMatchObject({ accepted: true });
    expect(prepared.inspection).toEqual(inspection);
    expect(body).toBe(prepared.serializedRequestBody);
    expect(inspection.serializedRequestBytes).toBe(new TextEncoder().encode(body).byteLength);
    expect(observed).toEqual(['response_start', 'text_delta', 'usage', 'response_end']);
    expect(JSON.parse(body)).toEqual({
      model: 'gpt-5-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      max_output_tokens: 16,
      stream: true,
      store: false,
    });
    await expect(prepared.execute()).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('keeps Anthropic generate on its exact single-use preparation path', async () => {
    let sentBody = '';
    const observed: string[] = [];
    const provider = createAnthropicMessagesProvider({
      model: 'claude-sonnet-4-5',
      apiKey: 'test-key',
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = String(init?.body);
        return streamingAnthropicTextResponse('ok');
      }) as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    const request = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
      tools: [],
      maxOutputTokens: 16,
    };
    const inspection = provider.inspectRequest(request);
    const prepared = provider.prepare({
      ...request,
      onStreamEvent: (event) => observed.push(event.type),
    });
    expect(inspection).toMatchObject({ accepted: true });
    expect(prepared.inspection).toEqual(inspection);
    expect(prepared.serializedRequestBytes).toBe(
      new TextEncoder().encode(prepared.serializedRequestBody).byteLength,
    );
    await expect(prepared.execute()).resolves.toMatchObject({ content: 'ok' });
    expect(sentBody).toBe(prepared.serializedRequestBody);
    expect(observed).toEqual(['response_start', 'text_delta', 'usage', 'response_end']);
    await expect(prepared.execute()).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('accepts exact 512/768 KiB projections and rejects one byte over for every adapter', () => {
    const providers: ExactRequestModelProvider[] = [
      createOpenAICompatibleProvider({
        provider: 'custom-openai-compatible',
        baseUrl: 'https://example.com/v1',
        model: 'custom-model',
        apiKey: 'test-key',
        fetchImpl: vi.fn() as typeof fetch,
      }),
      createOpenAIResponsesProvider({
        model: 'gpt-5-mini',
        apiKey: 'test-key',
        fetchImpl: vi.fn() as typeof fetch,
      }),
      createAnthropicMessagesProvider({
        model: 'claude-sonnet-4-5',
        apiKey: 'test-key',
        fetchImpl: vi.fn() as typeof fetch,
      }),
    ];

    for (const provider of providers) {
      const exactHistory = requestWithExactHistoryBytes(provider, MAX_PROVIDER_HISTORY_BYTES);
      const exactHistoryInspection = provider.inspectRequest(exactHistory);
      expect(exactHistoryInspection).toMatchObject({
        serializedHistoryBytes: MAX_PROVIDER_HISTORY_BYTES,
        accepted: true,
      });
      expect(() => provider.prepare(exactHistory)).not.toThrow();
      const oversizedHistory = appendHistoryByte(exactHistory);
      expect(provider.inspectRequest(oversizedHistory)).toMatchObject({
        serializedHistoryBytes: MAX_PROVIDER_HISTORY_BYTES + 1,
        accepted: false,
        failure: 'provider_history_too_large',
      });
      expect(captureError(() => provider.prepare(oversizedHistory))).toMatchObject({
        code: 'provider_history_too_large',
      });

      const exactRequest = requestWithExactRequestBytes(provider, MAX_PROVIDER_REQUEST_BYTES);
      const exactRequestInspection = provider.inspectRequest(exactRequest);
      expect(exactRequestInspection).toMatchObject({
        serializedRequestBytes: MAX_PROVIDER_REQUEST_BYTES,
        accepted: true,
      });
      expect(() => provider.prepare(exactRequest)).not.toThrow();
      const oversizedRequest = appendToolDescriptionByte(exactRequest);
      expect(provider.inspectRequest(oversizedRequest)).toMatchObject({
        serializedRequestBytes: MAX_PROVIDER_REQUEST_BYTES + 1,
        accepted: false,
        failure: 'provider_request_too_large',
      });
      expect(captureError(() => provider.prepare(oversizedRequest))).toMatchObject({
        code: 'provider_request_too_large',
      });

      expect(JSON.stringify(exactRequestInspection)).not.toContain('test-key');
    }
  });
});

function requestWithExactHistoryBytes(
  provider: ExactRequestModelProvider,
  targetBytes: number,
): ModelRequestShape {
  const base: ModelRequestShape = {
    messages: [{ role: 'user', content: '' }],
    tools: [],
    maxOutputTokens: 16,
  };
  const baseBytes = provider.inspectRequest(base).serializedHistoryBytes;
  if (baseBytes > targetBytes) throw new Error('adapter history overhead exceeds test target');
  const request: ModelRequestShape = {
    ...base,
    messages: [{ role: 'user', content: 'x'.repeat(targetBytes - baseBytes) }],
  };
  expect(provider.inspectRequest(request).serializedHistoryBytes).toBe(targetBytes);
  return request;
}

function requestWithExactRequestBytes(
  provider: ExactRequestModelProvider,
  targetBytes: number,
): ModelRequestShape {
  const base: ModelRequestShape = {
    messages: [],
    tools: [{ name: 'boundary_tool', description: '', risk: 'read' }],
    maxOutputTokens: 16,
  };
  const baseBytes = provider.inspectRequest(base).serializedRequestBytes;
  if (baseBytes > targetBytes) throw new Error('adapter request overhead exceeds test target');
  const request: ModelRequestShape = {
    ...base,
    tools: [{
      name: 'boundary_tool',
      description: 'x'.repeat(targetBytes - baseBytes),
      risk: 'read',
    }],
  };
  expect(provider.inspectRequest(request).serializedRequestBytes).toBe(targetBytes);
  return request;
}

function appendHistoryByte(request: ModelRequestShape): ModelRequestShape {
  const [message] = request.messages;
  if (!message || typeof message.content !== 'string') throw new Error('expected text history fixture');
  return { ...request, messages: [{ ...message, content: `${message.content}x` }] };
}

function appendToolDescriptionByte(request: ModelRequestShape): ModelRequestShape {
  const [tool] = request.tools;
  if (!tool) throw new Error('expected tool fixture');
  return { ...request, tools: [{ ...tool, description: `${tool.description}x` }] };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function streamingResponsesTextResponse(content: string): Response {
  const responseId = 'resp_prepared';
  const itemId = 'msg_prepared';
  const events = [
    { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
    {
      type: 'response.output_item.added',
      response_id: responseId,
      output_index: 0,
      item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: content,
    },
    {
      type: 'response.output_text.done',
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: content,
    },
    {
      type: 'response.content_part.done',
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: content, annotations: [] },
    },
    {
      type: 'response.output_item.done',
      response_id: responseId,
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: content, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function streamingAnthropicTextResponse(content: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_prepared', type: 'message', role: 'assistant', content: [],
        model: 'claude-sonnet-4-5', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
