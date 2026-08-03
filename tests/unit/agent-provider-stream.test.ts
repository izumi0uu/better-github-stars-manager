import { describe, expect, it, vi } from 'vitest';
import {
  aggregateModelStream,
  type ModelStreamEvent,
} from '@/agent-harness/provider-stream';
import {
  AgentProviderError,
  MAX_PROVIDER_ERROR_BYTES,
} from '@/agent-harness/provider';

async function* eventStream(events: readonly ModelStreamEvent[]): AsyncGenerator<ModelStreamEvent> {
  for (const event of events) yield event;
}

async function expectProviderError(
  events: readonly ModelStreamEvent[],
  code: AgentProviderError['code'],
): Promise<AgentProviderError> {
  try {
    await aggregateModelStream(eventStream(events));
  } catch (error) {
    expect(error).toBeInstanceOf(AgentProviderError);
    expect(error).toMatchObject({ code });
    return error as AgentProviderError;
  }
  throw new Error('Expected provider stream aggregation to fail.');
}

describe('provider stream aggregation', () => {
  it('assembles text and usage while observing bounded lifecycle events synchronously', async () => {
    const observer = vi.fn();
    const events: ModelStreamEvent[] = [
      { type: 'response_start' },
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: '世界' },
      {
        type: 'usage',
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      },
      { type: 'response_end', finishReason: 'stop' },
    ];

    await expect(aggregateModelStream(eventStream(events), observer)).resolves.toEqual({
      content: 'Hello 世界',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    expect(observer.mock.calls.map(([event]) => event)).toEqual(events);
  });

  it('retains valid cache and reasoning subsets without adding them to totals again', async () => {
    const usage = {
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      cachedInputTokens: 6,
      cacheCreationInputTokens: 4,
      reasoningOutputTokens: 3,
    };
    await expect(aggregateModelStream(eventStream([
      { type: 'response_start' },
      { type: 'text_delta', delta: 'done' },
      { type: 'usage', usage },
      { type: 'response_end', finishReason: 'stop' },
    ]))).resolves.toMatchObject({ usage });
  });

  it('assembles interleaved indexed tool calls in index order only after each tool end', async () => {
    const observer = vi.fn();
    const events: ModelStreamEvent[] = [
      { type: 'response_start' },
      { type: 'tool_call_start', index: 0, id: 'call-search', name: 'search_stars' },
      { type: 'tool_call_start', index: 1, id: 'call-tags', name: 'list_tags' },
      { type: 'tool_call_arguments_delta', index: 1, delta: '{"limit"' },
      { type: 'tool_call_arguments_delta', index: 0, delta: '{"query":"type' },
      { type: 'tool_call_arguments_delta', index: 1, delta: ':10}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'tool_call_arguments_delta', index: 0, delta: 'script"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'response_end', finishReason: 'tool_calls' },
    ];

    const result = await aggregateModelStream(eventStream(events), observer);

    expect(result).toEqual({
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'call-search', name: 'search_stars', arguments: { query: 'typescript' } },
        { id: 'call-tags', name: 'list_tags', arguments: { limit: 10 } },
      ],
    });
    expect(observer).toHaveBeenCalledTimes(events.length);
  });

  it('fails closed on a missing terminal and emits one observer error terminal', async () => {
    const observed: ModelStreamEvent[] = [];
    const promise = aggregateModelStream(eventStream([
      { type: 'response_start' },
      { type: 'text_delta', delta: 'partial' },
    ]), (event) => observed.push(event));

    await expect(promise).rejects.toMatchObject({ code: 'protocol_error' });
    expect(observed.map((event) => event.type)).toEqual([
      'response_start',
      'text_delta',
      'error',
    ]);
  });

  it('replaces duplicate or trailing terminal outcomes with one observer error terminal', async () => {
    const observed: ModelStreamEvent[] = [];
    const promise = aggregateModelStream(eventStream([
      { type: 'response_start' },
      { type: 'text_delta', delta: 'complete-looking' },
      { type: 'response_end', finishReason: 'stop' },
      { type: 'response_end', finishReason: 'stop' },
    ]), (event) => observed.push(event));

    await expect(promise).rejects.toMatchObject({ code: 'protocol_error' });
    expect(observed.map((event) => event.type)).toEqual([
      'response_start',
      'text_delta',
      'error',
    ]);
  });

  it.each([
    {
      name: 'data before response_start',
      events: [{ type: 'text_delta', delta: 'early' }],
    },
    {
      name: 'duplicate response_start',
      events: [{ type: 'response_start' }, { type: 'response_start' }],
    },
    {
      name: 'arguments for an unknown tool',
      events: [
        { type: 'response_start' },
        { type: 'tool_call_arguments_delta', index: 0, delta: '{}' },
      ],
    },
    {
      name: 'duplicate usage',
      events: [
        { type: 'response_start' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ],
    },
    {
      name: 'inconsistent usage',
      events: [
        { type: 'response_start' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 99 } },
      ],
    },
    {
      name: 'cache subsets larger than input usage',
      events: [
        { type: 'response_start' },
        {
          type: 'usage',
          usage: {
            inputTokens: 5,
            outputTokens: 1,
            totalTokens: 6,
            cachedInputTokens: 4,
            cacheCreationInputTokens: 2,
          },
        },
      ],
    },
    {
      name: 'reasoning subset larger than output usage',
      events: [
        { type: 'response_start' },
        {
          type: 'usage',
          usage: {
            inputTokens: 5,
            outputTokens: 1,
            totalTokens: 6,
            reasoningOutputTokens: 2,
          },
        },
      ],
    },
    {
      name: 'invalid tool JSON',
      events: [
        { type: 'response_start' },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'search_stars' },
        { type: 'tool_call_arguments_delta', index: 0, delta: '{' },
        { type: 'tool_call_end', index: 0 },
      ],
    },
    {
      name: 'unfinished tool call',
      events: [
        { type: 'response_start' },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'search_stars' },
        { type: 'tool_call_arguments_delta', index: 0, delta: '{}' },
        { type: 'response_end', finishReason: 'tool_calls' },
      ],
    },
    {
      name: 'non-contiguous tool indexes',
      events: [
        { type: 'response_start' },
        { type: 'tool_call_start', index: 1, id: 'call-1', name: 'search_stars' },
        { type: 'tool_call_arguments_delta', index: 1, delta: '{}' },
        { type: 'tool_call_end', index: 1 },
        { type: 'response_end', finishReason: 'tool_calls' },
      ],
    },
    {
      name: 'stop with tool calls',
      events: [
        { type: 'response_start' },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'search_stars' },
        { type: 'tool_call_arguments_delta', index: 0, delta: '{}' },
        { type: 'tool_call_end', index: 0 },
        { type: 'response_end', finishReason: 'stop' },
      ],
    },
    {
      name: 'stop without assistant content',
      events: [
        { type: 'response_start' },
        { type: 'text_delta', delta: '   ' },
        { type: 'response_end', finishReason: 'stop' },
      ],
    },
  ])('rejects malformed sequence: $name', async ({ events }) => {
    await expectProviderError(events as ModelStreamEvent[], 'protocol_error');
  });

  it.each([
    { finishReason: 'length', message: 'before a complete response' },
    { finishReason: 'content_filter', message: 'unsupported finish reason' },
    { finishReason: '', message: 'unsupported finish reason' },
  ])('rejects incomplete or unsupported finish reason $finishReason', async ({ finishReason, message }) => {
    const error = await expectProviderError([
      { type: 'response_start' },
      { type: 'text_delta', delta: 'partial' },
      { type: 'response_end', finishReason },
    ], 'protocol_error');
    expect(error.message).toContain(message);
  });

  it('preserves a zero-output length candidate for model-window overflow detection', async () => {
    const usage = { inputTokens: 8_192, outputTokens: 0, totalTokens: 8_192 };
    await expect(aggregateModelStream(eventStream([
      { type: 'response_start' },
      { type: 'usage', usage },
      { type: 'response_end', finishReason: 'length' },
    ]))).resolves.toEqual({ finishReason: 'length', usage });
  });

  it('never returns refusal text as a successful partial response', async () => {
    const observed: ModelStreamEvent[] = [];
    const promise = aggregateModelStream(eventStream([
      { type: 'response_start' },
      { type: 'refusal_delta', delta: 'I cannot comply.' },
      { type: 'response_end', finishReason: 'stop' },
    ]), (event) => observed.push(event));

    await expect(promise).rejects.toMatchObject({ code: 'protocol_error' });
    expect(observed.at(-1)).toMatchObject({ type: 'error' });
    expect(observed.some((event) => event.type === 'response_end')).toBe(false);
  });

  it.each([
    {
      name: 'event count',
      events: [
        { type: 'response_start' },
        { type: 'text_delta', delta: 'a' },
        { type: 'response_end', finishReason: 'stop' },
      ],
      limits: { maxEvents: 2 },
    },
    {
      name: 'text bytes',
      events: [
        { type: 'response_start' },
        { type: 'text_delta', delta: '世界' },
      ],
      limits: { maxTextBytes: 5 },
    },
    {
      name: 'refusal bytes',
      events: [
        { type: 'response_start' },
        { type: 'refusal_delta', delta: '世界' },
      ],
      limits: { maxRefusalBytes: 5 },
    },
    {
      name: 'tool argument bytes',
      events: [
        { type: 'response_start' },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'search_stars' },
        { type: 'tool_call_arguments_delta', index: 0, delta: '{"q":"世界"}' },
      ],
      limits: { maxToolArgumentBytes: 8 },
    },
    {
      name: 'total buffered bytes',
      events: [
        { type: 'response_start' },
        { type: 'text_delta', delta: '1234' },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'search_stars' },
        { type: 'tool_call_arguments_delta', index: 0, delta: '{}' },
      ],
      limits: { maxBufferedBytes: 5 },
    },
  ])('enforces the $name limit using UTF-8 bytes', async ({ events, limits }) => {
    await expect(aggregateModelStream(
      eventStream(events as ModelStreamEvent[]),
      undefined,
      limits,
    )).rejects.toMatchObject({ code: 'provider_response_too_large' });
  });

  it('normalizes an error terminal to a bounded AgentProviderError and observes it once', async () => {
    const observed: ModelStreamEvent[] = [];
    const sourceError = new AgentProviderError('http_error', '世'.repeat(MAX_PROVIDER_ERROR_BYTES), 429);
    const promise = aggregateModelStream(eventStream([
      { type: 'error', error: sourceError },
    ]), (event) => observed.push(event));

    await expect(promise).rejects.toMatchObject({ code: 'http_error', status: 429 });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ type: 'error' });
    const terminal = observed[0];
    if (terminal?.type !== 'error') throw new Error('Expected an error terminal.');
    expect(new TextEncoder().encode(terminal.error.message).byteLength)
      .toBeLessThanOrEqual(MAX_PROVIDER_ERROR_BYTES);
  });

  it('does not let an observer mutate the error ultimately rejected by the aggregator', async () => {
    const promise = aggregateModelStream(eventStream([
      { type: 'error', error: new AgentProviderError('timeout', 'Provider timed out.') },
    ]), (event) => {
      if (event.type === 'error') event.error.message = 'observer replacement';
    });

    await expect(promise).rejects.toMatchObject({
      code: 'timeout',
      message: 'Provider timed out.',
    });
  });

  it('normalizes an iterator failure and does not expose accumulated partial tool arguments', async () => {
    const observed: ModelStreamEvent[] = [];
    async function* failingStream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: 'response_start' };
      yield { type: 'tool_call_start', index: 0, id: 'call-1', name: 'search_stars' };
      yield { type: 'tool_call_arguments_delta', index: 0, delta: '{"query":"partial' };
      throw new Error('socket included a sensitive raw response');
    }

    await expect(aggregateModelStream(failingStream(), (event) => observed.push(event)))
      .rejects.toMatchObject({ code: 'network_error', message: 'Provider stream failed.' });
    expect(observed.at(-1)).toMatchObject({ type: 'error' });
    expect(observed.some((event) => event.type === 'tool_call_end')).toBe(false);
  });
});
