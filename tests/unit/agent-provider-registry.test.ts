import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRegisteredAgentProvider,
  runAgentProviderConnectionProbe,
  testRegisteredAgentProviderConnection,
} from '@/agent-harness/provider-registry';
import {
  resolveAgentProviderEndpoint,
} from '@/agent-harness/models';
import type {
  AgentCustomProviderProtocol,
  AgentProviderId,
} from '@/types';
import type { ModelProvider, ModelResponse } from '@/agent-harness/provider';

const CASES = [
  ['openai', null, null, 'openai-responses', 'responses'],
  ['openrouter', null, null, 'openai-compatible', 'chat-completions'],
  ['anthropic', null, null, 'anthropic-messages', 'anthropic-messages'],
  ['custom-openai-compatible', 'chat-completions', 'https://relay.example/v1', 'openai-compatible', 'chat-completions'],
  ['custom-openai-compatible', 'responses', 'https://relay.example/v1', 'openai-responses', 'responses'],
] as const satisfies ReadonlyArray<readonly [
  AgentProviderId,
  AgentCustomProviderProtocol | null,
  string | null,
  string,
  string,
]>;

describe('Agent provider registry', () => {
  it.each(CASES)(
    'dispatches %s/%s through its resolved protocol adapter',
    (provider, protocol, baseUrl, adapter, resolvedProtocol) => {
      const endpoint = resolveAgentProviderEndpoint(provider, baseUrl, protocol);
      expect(endpoint.profile).toEqual(expect.objectContaining({
        adapter,
        protocol: resolvedProtocol,
      }));

      const registered = createRegisteredAgentProvider({
        provider,
        protocol,
        baseUrl,
        model: 'test-model',
        apiKey: 'test-secret',
      });
      expect(typeof registered.generate).toBe('function');
      expect(typeof registered.prepare).toBe('function');
    },
  );

  it('uses only the three verified adapter identities across all services', () => {
    expect(new Set(CASES.map(([provider, protocol, baseUrl]) =>
      resolveAgentProviderEndpoint(provider, baseUrl, protocol).profile.adapter,
    ))).toEqual(new Set([
      'openai-compatible',
      'openai-responses',
      'anthropic-messages',
    ]));
  });

  it('normalizes the model reported by the shared two-turn connection probe', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role?: string }>;
      };
      const acknowledgement = body.messages.some((message) => message.role === 'tool');
      return chatSse(acknowledgement
        ? [{ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]']
        : [{
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'probe-call',
                  type: 'function',
                  function: {
                    name: 'bgsm_connection_probe',
                    arguments: '{"nonce":"bgsm"}',
                  },
                }],
              },
              finish_reason: null,
            }],
          }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']);
    });

    const result = await testRegisteredAgentProviderConnection({
      provider: 'openrouter',
      model: '   ',
      apiKey: 'test-secret',
      fetchImpl: fetchImpl as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });

    expect(result.model).toBe('openrouter/auto');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['openai', null, null, 'https://api.openai.com/v1/responses'],
    [
      'custom-openai-compatible',
      'responses',
      'https://relay.example/v1',
      'https://relay.example/v1/responses',
    ],
  ] as const)(
    'completes a real two-turn Responses probe for %s',
    async (provider, protocol, baseUrl, expectedEndpoint) => {
      let responseNumber = 0;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(expectedEndpoint);
        responseNumber += 1;
        const request = JSON.parse(String(init?.body)) as {
          input: Array<{ type?: string }>;
        };
        const acknowledgement = request.input.some(
          (item) => item.type === 'function_call_output',
        );
        const events = acknowledgement
          ? responsesTextEvents(`ok-${responseNumber}`)
          : responsesToolEvents();
        return responsesSse(
          provider === 'custom-openai-compatible'
            ? withoutTopLevelResponseIds(events)
            : events,
        );
      });

      const result = await testRegisteredAgentProviderConnection({
        provider,
        protocol,
        baseUrl,
        model: 'test-model',
        apiKey: 'test-secret',
        fetchImpl: fetchImpl as typeof fetch,
        hostPermissionCheck: async () => true,
        validateRuntimeIdentity: async () => true,
      });

      expect(result).toEqual(expect.objectContaining({
        provider,
        protocol: 'responses',
        completionEndpoint: expectedEndpoint,
        preview: 'ok-2',
      }));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('completes a real two-turn Anthropic Messages probe', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content?: Array<{ type?: string }> }>;
      };
      const acknowledgement = request.messages.some((message) =>
        message.content?.some((block) => block.type === 'tool_result'));
      return anthropicSse(
        acknowledgement ? anthropicTextEvents('ok') : anthropicToolEvents(),
      );
    });

    const result = await testRegisteredAgentProviderConnection({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'test-secret',
      fetchImpl: fetchImpl as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });

    expect(result).toEqual(expect.objectContaining({
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      completionEndpoint: 'https://api.anthropic.com/v1/messages',
      preview: 'ok',
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ content: 'again', finishReason: 'tool_calls' as const }, 'non-stop'],
    [{
      content: 'again',
      finishReason: 'stop' as const,
      toolCalls: [{ id: 'again', name: 'bgsm_connection_probe', arguments: { nonce: 'bgsm' } }],
    }, 'tool-bearing'],
  ])('rejects a %s acknowledgement from the shared probe', async (acknowledgement, _label) => {
    const provider = sequenceProvider(acknowledgement);
    await expect(runAgentProviderConnectionProbe({
      provider,
      endpoint: resolveAgentProviderEndpoint('openai', null),
      model: 'gpt-5-mini',
      timeoutMs: 100,
    })).rejects.toMatchObject({
      code: 'protocol_error',
      phase: 'tool_acknowledgement',
    });
  });

  it('shares one total deadline across both probe turns', async () => {
    vi.useFakeTimers();
    let call = 0;
    const provider: ModelProvider = {
      generate: vi.fn(async (input): Promise<ModelResponse> => {
        call += 1;
        if (call === 1) {
          await new Promise((resolve) => setTimeout(resolve, 8));
          return successfulToolCall();
        }
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }),
    };
    const pending = runAgentProviderConnectionProbe({
      provider,
      endpoint: resolveAgentProviderEndpoint('openai', null),
      model: 'gpt-5-mini',
      timeoutMs: 10,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'timeout',
      phase: 'tool_acknowledgement',
    });

    await vi.advanceTimersByTimeAsync(8);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2);
    await rejected;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function sequenceProvider(acknowledgement: Awaited<ReturnType<ModelProvider['generate']>>): ModelProvider {
  let call = 0;
  return {
    async generate() {
      call += 1;
      return call === 1 ? successfulToolCall() : acknowledgement;
    },
  };
}

function successfulToolCall() {
  return {
    content: '',
    finishReason: 'tool_calls' as const,
    toolCalls: [{
      id: 'probe-call',
      name: 'bgsm_connection_probe',
      arguments: { nonce: 'bgsm' },
    }],
  };
}

function chatSse(events: readonly (Record<string, unknown> | '[DONE]')[]): Response {
  const body = events.map((event) =>
    `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function withoutTopLevelResponseIds(
  events: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return events.map(({ response_id: _responseId, ...event }) => event);
}

function responsesToolEvents(): Record<string, unknown>[] {
  return [
    {
      type: 'response.created',
      response: { id: 'resp_probe', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      response_id: 'resp_probe',
      output_index: 0,
      item: {
        id: 'fc_probe',
        type: 'function_call',
        call_id: 'call_probe',
        name: 'bgsm_connection_probe',
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      response_id: 'resp_probe',
      item_id: 'fc_probe',
      output_index: 0,
      delta: '{"nonce":"bgsm"}',
    },
    {
      type: 'response.function_call_arguments.done',
      response_id: 'resp_probe',
      item_id: 'fc_probe',
      output_index: 0,
      arguments: '{"nonce":"bgsm"}',
    },
    {
      type: 'response.output_item.done',
      response_id: 'resp_probe',
      output_index: 0,
      item: {
        id: 'fc_probe',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_probe',
        name: 'bgsm_connection_probe',
        arguments: '{"nonce":"bgsm"}',
      },
    },
    responsesCompletedEvent(),
  ];
}

function responsesTextEvents(text: string): Record<string, unknown>[] {
  return [
    {
      type: 'response.created',
      response: { id: 'resp_probe', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      response_id: 'resp_probe',
      output_index: 0,
      item: {
        id: 'msg_probe',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      response_id: 'resp_probe',
      item_id: 'msg_probe',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      response_id: 'resp_probe',
      item_id: 'msg_probe',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      response_id: 'resp_probe',
      item_id: 'msg_probe',
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      response_id: 'resp_probe',
      item_id: 'msg_probe',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    },
    {
      type: 'response.output_item.done',
      response_id: 'resp_probe',
      output_index: 0,
      item: {
        id: 'msg_probe',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    responsesCompletedEvent(),
  ];
}

function responsesCompletedEvent(): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: {
      id: 'resp_probe',
      status: 'completed',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    },
  };
}

type AnthropicEvent = Readonly<{ event: string; payload: Record<string, unknown> }>;

function anthropicToolEvents(): AnthropicEvent[] {
  return [
    anthropicMessageStart(),
    {
      event: 'content_block_start',
      payload: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_probe',
          name: 'bgsm_connection_probe',
          input: {},
        },
      },
    },
    {
      event: 'content_block_delta',
      payload: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"nonce":"bgsm"}' },
      },
    },
    {
      event: 'content_block_stop',
      payload: { type: 'content_block_stop', index: 0 },
    },
    anthropicMessageDelta('tool_use'),
    { event: 'message_stop', payload: { type: 'message_stop' } },
  ];
}

function anthropicTextEvents(text: string): AnthropicEvent[] {
  return [
    anthropicMessageStart(),
    {
      event: 'content_block_start',
      payload: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      payload: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    },
    {
      event: 'content_block_stop',
      payload: { type: 'content_block_stop', index: 0 },
    },
    anthropicMessageDelta('end_turn'),
    { event: 'message_stop', payload: { type: 'message_stop' } },
  ];
}

function anthropicMessageStart(): AnthropicEvent {
  return {
    event: 'message_start',
    payload: {
      type: 'message_start',
      message: {
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
  };
}

function anthropicMessageDelta(stopReason: 'tool_use' | 'end_turn'): AnthropicEvent {
  return {
    event: 'message_delta',
    payload: {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 2 },
    },
  };
}

function responsesSse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => (
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
  )).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function anthropicSse(events: readonly AnthropicEvent[]): Response {
  const body = events.map(({ event, payload }) => (
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  )).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
