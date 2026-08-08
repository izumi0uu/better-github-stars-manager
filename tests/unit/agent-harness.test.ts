import {
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_PROVIDER_IDENTITY_CHANGED,
} from '@/api/errors';
import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
  MAX_TOOL_RESULT_BYTES,
  MAX_TURN_TOOL_RESULT_BYTES,
  CONTEXT_PROFILE_8192,
  AgentProviderError,
  MockProvider,
  estimateContext,
  errorToolResult,
  finalizeToolResult,
  MIN_TOOL_RESULT_ENVELOPE_BYTES,
  okToolResult,
  ToolOutputTooLargeError,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  runAgentLoop,
  toModelMessage,
  toToolDefinition,
} from '../../src/agent-harness/index.ts';

const encoder = new TextEncoder();

function resultWithByteLength(byteLength: number) {
  const overhead = encoder.encode(JSON.stringify(okToolResult({ payload: '' }))).byteLength;
  return okToolResult({ payload: 'x'.repeat(byteLength - overhead) });
}

const baseMessage: AgentMessage = {
  id: 'm-user',
  role: 'user',
  content: 'Help me organize tags',
  createdAt: 1,
};

function makeReadTool(): AgentTool<{ query: string }, { count: number }> {
  return {
    name: 'search_stars',
    description: 'Search stars',
    risk: 'read',
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Expected object.');
      }
      const query = (input as { query?: unknown }).query;
      if (typeof query !== 'string') throw new Error('Expected query.');
      return { query };
    },
    async execute(args) {
      return { count: args.query.length };
    },
  };
}

describe('agent harness agent loop', () => {
  it('omits opaque message references from Provider conversion', () => {
    assert.deepEqual(toModelMessage({
      ...baseMessage,
      opaqueReferences: ['opaque:local-only'],
    }), {
      role: 'user',
      content: baseMessage.content,
      toolCallId: undefined,
      toolName: undefined,
      toolCalls: undefined,
    });
  });

  it('passes the configured output budget explicitly on every model request', async () => {
    const budgets: number[] = [];
    const result = await runAgentLoop({
      sessionId: 's-budget',
      messages: [baseMessage],
      provider: {
        async generate(input) {
          budgets.push(input.maxOutputTokens);
          return { content: 'Done.' };
        },
      },
      tools: [],
      maxOutputTokens: 321,
    });

    assert.equal(result.reason, 'final_answer');
    assert.deepEqual(budgets, [321]);
  });

  it('forwards only presentation-safe provider stream events', async () => {
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      sessionId: 's-stream',
      messages: [baseMessage],
      provider: {
        async generate(input) {
          input.onStreamEvent?.({ type: 'response_start' });
          input.onStreamEvent?.({ type: 'text_delta', delta: 'Hello' });
          input.onStreamEvent?.({ type: 'refusal_delta', delta: 'hidden refusal' });
          input.onStreamEvent?.({
            type: 'tool_call_start',
            index: 0,
            id: 'hidden-call',
            name: 'hidden_tool',
          });
          input.onStreamEvent?.({
            type: 'tool_call_arguments_delta',
            index: 0,
            delta: '{"secret":true}',
          });
          input.onStreamEvent?.({
            type: 'usage',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          input.onStreamEvent?.({ type: 'response_end', finishReason: 'stop' });
          return { content: 'Hello' };
        },
      },
      tools: [],
      emit: (event) => events.push(event),
    });

    assert.equal(result.reason, 'final_answer');
    assert.deepEqual(events.filter((event) => (
      event.type === 'assistant_stream_start' || event.type === 'assistant_text_delta'
    )), [
      { type: 'assistant_stream_start', sessionId: 's-stream', step: 0 },
      { type: 'assistant_text_delta', sessionId: 's-stream', step: 0, delta: 'Hello' },
    ]);
    assert.equal(JSON.stringify(events).includes('hidden refusal'), false);
    assert.equal(JSON.stringify(events).includes('secret'), false);
    assert.equal(JSON.stringify(events).includes('hidden_tool'), false);
  });

  it('accepts context input exactly at the hard limit', async () => {
    const maxOutputTokens = 321;
    const contextHardLimit = estimateContext({
      messages: [baseMessage].map(toModelMessage),
      toolSchemas: [],
      maxOutputTokens,
    }).inputTokens;
    let providerCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-context-exact',
      messages: [baseMessage],
      provider: {
        async generate() {
          providerCalls++;
          return { content: 'Done.' };
        },
      },
      tools: [],
      maxOutputTokens,
      contextHardLimit,
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(providerCalls, 1);
  });

  it('rejects context input one token over the hard limit before calling the provider', async () => {
    const events: AgentEvent[] = [];
    const maxOutputTokens = 321;
    const inputTokens = estimateContext({
      messages: [baseMessage].map(toModelMessage),
      toolSchemas: [],
      maxOutputTokens,
    }).inputTokens;
    let providerCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-context-over',
      messages: [baseMessage],
      provider: {
        async generate() {
          providerCalls++;
          return { content: 'Must not run.' };
        },
      },
      tools: [],
      emit: (event) => events.push(event),
      maxOutputTokens,
      contextHardLimit: inputTokens - 1,
    });

    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'current_turn_too_large');
    assert.equal(providerCalls, 0);
    assert.deepEqual(result.messages, [baseMessage]);
    assert.deepEqual(
      events.filter((event) => event.type === 'agent_error'),
      [{
        type: 'agent_error',
        sessionId: 's-context-over',
        message: 'Context limit exceeded.',
      }],
    );
  });

  it('rechecks context after tool results before the next provider call', async () => {
    const tool = makeReadTool();
    const maxOutputTokens = 321;
    const contextHardLimit = estimateContext({
      messages: [baseMessage].map(toModelMessage),
      toolSchemas: [toToolDefinition(tool)],
      maxOutputTokens,
    }).inputTokens;
    let providerCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-context-tool-result',
      messages: [baseMessage],
      provider: {
        async generate() {
          providerCalls++;
          return {
            toolCalls: [{
              id: 'call-context-growth',
              name: 'search_stars',
              arguments: { query: 'agent' },
            }],
          };
        },
      },
      tools: [tool],
      maxOutputTokens,
      contextHardLimit,
    });

    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'current_turn_too_large');
    assert.equal(providerCalls, 1);
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 1);
    assert.equal(result.messages.at(-1)?.role, 'tool');
  });

  it('returns a final answer when the provider has no tool calls', async () => {
    const result = await runAgentLoop({
      sessionId: 's1',
      messages: [baseMessage],
      provider: new MockProvider([{ content: 'Done.' }]),
      tools: [],
      idFactory: () => 'm-agent',
      now: () => 2,
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(result.messages.at(-1)?.role, 'agent');
    assert.equal(result.messages.at(-1)?.content, 'Done.');
  });

  it('executes allowed tools and sends structured tool results back into the loop', async () => {
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      sessionId: 's2',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'search_stars',
              arguments: { query: 'agent' },
            },
          ],
        },
        { content: 'Found matches.' },
      ]),
      tools: [makeReadTool()],
      emit: (event) => events.push(event),
      idFactory: (() => {
        let i = 0;
        return () => `m-${++i}`;
      })(),
      now: () => 2,
    });

    assert.equal(result.reason, 'final_answer');
    const assistantCall = result.messages.find((message) => message.toolCalls?.[0]?.id === 'call-1');
    const toolResult = result.messages.find((message) => message.role === 'tool');
    assert.deepEqual(assistantCall?.toolCalls, [
      {
        id: 'call-1',
        name: 'search_stars',
        arguments: { query: 'agent' },
      },
    ]);
    assert.equal(toolResult?.toolCallId, 'call-1');
    assert.equal(toolResult?.toolName, 'search_stars');
    assert.equal(events.some((event) => event.type === 'tool_execution_queued'), true);
    assert.equal(events.some((event) => event.type === 'tool_execution_start'), true);
    assert.equal(events.some((event) => event.type === 'tool_execution_end' && event.ok), true);
  });

  it('pauses when a tool requires approval', async () => {
    const events: AgentEvent[] = [];
    const writeTool: AgentTool = {
      name: 'apply_tag_changes',
      description: 'Apply changes',
      risk: 'write',
      async execute() {
        return { applied: true };
      },
    };

    const result = await runAgentLoop({
      sessionId: 's3',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [
            {
              id: 'call-2',
              name: 'apply_tag_changes',
              arguments: {},
            },
          ],
        },
      ]),
      tools: [writeTool],
      emit: (event) => events.push(event),
      idFactory: () => 'm-tool',
      now: () => 2,
    });

    assert.equal(result.reason, 'approval_required');
    assert.equal(events.some((event) => event.type === 'approval_required'), true);
    assert.equal(events.some((event) => event.type === 'tool_execution_start'), false);
  });

  it('does not execute tools when cancellation arrives with the provider response', async () => {
    const controller = new AbortController();
    let toolExecutions = 0;
    const tool = makeReadTool();
    const executeTool = tool.execute.bind(tool);
    tool.execute = async (args, context) => {
      toolExecutions++;
      return executeTool(args, context);
    };
    const result = await runAgentLoop({
      sessionId: 's-aborted',
      messages: [baseMessage],
      provider: {
        async generate() {
          controller.abort();
          return {
            toolCalls: [
              {
                id: 'call-aborted',
                name: 'search_stars',
                arguments: { query: 'agent' },
              },
            ],
          };
        },
      },
      tools: [tool],
      signal: controller.signal,
    });

    assert.equal(result.reason, 'aborted');
    assert.equal(toolExecutions, 0);
  });

  it('preserves caller cancellation when the provider rejects the in-flight request', async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      sessionId: 's-provider-caller-abort',
      messages: [baseMessage],
      provider: {
        async generate() {
          controller.abort();
          throw new AgentProviderError('caller_abort', 'Agent provider request was aborted.');
        },
      },
      tools: [],
      signal: controller.signal,
      emit: (event) => events.push(event),
    });

    assert.equal(result.reason, 'aborted');
    assert.equal(events.some((event) => event.type === 'agent_error'), false);
  });

  it('recovers one Provider overflow inside the same step without a visible error', async () => {
    const events: AgentEvent[] = [];
    let providerCalls = 0;
    let continuationCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-overflow-recovery',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      provider: {
        async generate() {
          providerCalls += 1;
          if (providerCalls === 1) {
            throw new AgentProviderError('context_overflow', 'Provider context overflowed.', 400);
          }
          return { content: 'Recovered.' };
        },
      },
      tools: [],
      maxSteps: 1,
      emit: (event) => events.push(event),
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        assert.equal(continuation.step, 0);
        assert.equal(continuation.trigger, 'provider_context_overflow');
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(providerCalls, 2);
    assert.equal(continuationCalls, 1);
    assert.equal(events.some((event) => event.type === 'agent_error'), false);
    assert.deepEqual(
      events.filter((event) => event.type === 'turn_start').map((event) => event.step),
      [0],
    );
  });

  it('recovers one prepared-request byte rejection before dispatch', async () => {
    const events: AgentEvent[] = [];
    let prepareCalls = 0;
    let continuationCalls = 0;
    let executeCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-byte-recovery',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      provider: {
        async generate() {
          throw new Error('generate must not run when prepare is available');
        },
        prepare() {
          prepareCalls += 1;
          if (prepareCalls === 1) {
            throw new AgentProviderError(
              'provider_history_too_large',
              'Provider history exceeded its byte limit.',
            );
          }
          return {
            serializedRequestBody: '{}',
            serializedRequestBytes: 2,
            async execute() {
              executeCalls += 1;
              return { content: 'Recovered.' };
            },
          };
        },
      },
      tools: [],
      maxSteps: 1,
      emit: (event) => events.push(event),
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        assert.equal(continuation.trigger, 'provider_request_byte_limit');
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(prepareCalls, 2);
    assert.equal(executeCalls, 1);
    assert.equal(continuationCalls, 1);
    assert.equal(events.some((event) => event.type === 'agent_error'), false);
  });

  it('terminates repeated prepared-request byte rejection without dispatching', async () => {
    let prepareCalls = 0;
    let continuationCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-byte-repeated',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      provider: {
        async generate() {
          throw new Error('generate must not run when prepare is available');
        },
        prepare() {
          prepareCalls += 1;
          throw new AgentProviderError(
            'provider_request_too_large',
            'Provider request exceeded its byte limit.',
          );
        },
      },
      tools: [],
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'provider_request_byte_limit_repeated');
    assert.equal(prepareCalls, 2);
    assert.equal(continuationCalls, 1);
  });

  it('compacts post-tool byte pressure without replaying the completed tool', async () => {
    const events: AgentEvent[] = [];
    let providerExecutions = 0;
    let toolExecutions = 0;
    let continuationCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-post-tool-byte-pressure',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      contextPolicy: CONTEXT_PROFILE_8192,
      maxSteps: 2,
      emit: (event) => events.push(event),
      provider: {
        inspectRequest(request) {
          const toolResult = request.messages.find((message) => message.role === 'tool');
          const accepted = !toolResult || toolResult.content.length < 500;
          return {
            serializedHistoryBytes: accepted ? 100 : 2_500,
            serializedRequestBytes: accepted ? 200 : 3_200,
            historyByteLimit: 2_000,
            requestByteLimit: 3_000,
            accepted,
            ...(accepted ? {} : { failure: 'provider_history_too_large' as const }),
          };
        },
        prepare() {
          return {
            serializedRequestBody: '{}',
            serializedRequestBytes: 2,
            async execute() {
              providerExecutions += 1;
              return providerExecutions === 1
                ? {
                    toolCalls: [{
                      id: 'post-tool-byte-call',
                      name: 'search_stars',
                      arguments: { query: 'agent' },
                    }],
                  }
                : { content: 'Recovered after compacting the settled tool envelope.' };
            },
          };
        },
        async generate() {
          throw new Error('generate must not run when prepare is available');
        },
      },
      tools: [{
        ...makeReadTool(),
        async execute() {
          toolExecutions += 1;
          return { text: 'x'.repeat(600) };
        },
      }],
      async onToolEnvelopeSettled(continuation) {
        continuationCalls += 1;
        assert.equal(continuation.trigger, 'provider_request_byte_limit');
        return { kind: 'ready', messages: [continuation.messages[0]!] };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(providerExecutions, 2);
    assert.equal(toolExecutions, 1);
    assert.equal(continuationCalls, 1);
    assert.equal(events.filter((event) => (
      event.type === 'context_diagnostic'
      && event.action === 'triggered'
      && event.trigger === 'provider_request_byte_limit'
    )).length, 1);
    assert.deepEqual(result.rawMessages?.map((message) => message.role), [
      'user', 'agent', 'tool', 'agent',
    ]);
  });

  it('reports post-tool byte pressure precisely when no continuation owner exists', async () => {
    let providerExecutions = 0;
    let toolExecutions = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-post-tool-byte-terminal',
      messages: [baseMessage],
      contextPolicy: CONTEXT_PROFILE_8192,
      maxSteps: 2,
      provider: {
        inspectRequest(request) {
          const toolResult = request.messages.find((message) => message.role === 'tool');
          const accepted = !toolResult || toolResult.content.length < 500;
          return {
            serializedHistoryBytes: accepted ? 100 : 2_500,
            serializedRequestBytes: accepted ? 200 : 3_200,
            historyByteLimit: 2_000,
            requestByteLimit: 3_000,
            accepted,
            ...(accepted ? {} : { failure: 'provider_history_too_large' as const }),
          };
        },
        async generate() {
          providerExecutions += 1;
          return {
            toolCalls: [{
              id: 'post-tool-byte-terminal-call',
              name: 'search_stars',
              arguments: { query: 'agent' },
            }],
          };
        },
      },
      tools: [{
        ...makeReadTool(),
        async execute() {
          toolExecutions += 1;
          return { text: 'x'.repeat(600) };
        },
      }],
    });

    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'provider_request_byte_limit');
    assert.equal(providerExecutions, 1);
    assert.equal(toolExecutions, 1);
    assert.deepEqual(result.messages.slice(-2).map((message) => message.role), ['agent', 'tool']);
  });

  it.each([
    {
      name: 'usage above the model window',
      response: {
        content: 'Silently truncated.',
        finishReason: 'stop',
        usage: { inputTokens: 8_193, outputTokens: 4, totalTokens: 8_197 },
      },
    },
    {
      name: 'zero-output length stop at the model window',
      response: {
        finishReason: 'length',
        usage: { inputTokens: 8_192, outputTokens: 0, totalTokens: 8_192 },
      },
    },
  ])('recovers silent Provider overflow from $name', async ({ response }) => {
    let providerCalls = 0;
    let continuationCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-silent-overflow',
      messages: [baseMessage],
      provider: {
        async generate() {
          providerCalls += 1;
          return providerCalls === 1 ? response : { content: 'Recovered.', finishReason: 'stop' };
        },
      },
      tools: [],
      maxSteps: 1,
      contextPolicy: CONTEXT_PROFILE_8192,
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(providerCalls, 2);
    assert.equal(continuationCalls, 1);
  });

  it('terminates a repeated Provider overflow without re-entering recovery', async () => {
    const events: AgentEvent[] = [];
    let providerCalls = 0;
    let continuationCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-overflow-repeated',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      provider: {
        async generate() {
          providerCalls += 1;
          throw new AgentProviderError('context_overflow', 'Provider context overflowed.', 400);
        },
      },
      tools: [],
      emit: (event) => events.push(event),
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'provider_context_overflow_repeated');
    assert.equal(providerCalls, 2);
    assert.equal(continuationCalls, 1);
    assert.equal(events.filter((event) => event.type === 'agent_error').length, 1);
    assert.deepEqual(result.rawMessages, [baseMessage]);
  });

  it('starts a new bounded overflow episode after a successful Provider step', async () => {
    let providerCalls = 0;
    let continuationCalls = 0;
    let toolExecutions = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-overflow-reset',
      messages: [baseMessage],
      provider: {
        async generate() {
          providerCalls += 1;
          if (providerCalls === 1 || providerCalls === 3) {
            throw new AgentProviderError('context_overflow', 'Provider context overflowed.', 400);
          }
          if (providerCalls === 2) {
            return {
              toolCalls: [{
                id: 'overflow-reset-call',
                name: 'search_stars',
                arguments: { query: 'agent' },
              }],
            };
          }
          return { content: 'Recovered twice.' };
        },
      },
      tools: [{
        ...makeReadTool(),
        async execute(args) {
          toolExecutions += 1;
          return { count: (args as { query: string }).query.length };
        },
      }],
      maxSteps: 2,
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(providerCalls, 4);
    assert.equal(continuationCalls, 2);
    assert.equal(toolExecutions, 1);
  });

  it('lets cancellation win after overflow continuation and before Provider retry', async () => {
    const controller = new AbortController();
    let providerCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-provider-overflow-cancelled',
      messages: [baseMessage],
      provider: {
        async generate() {
          providerCalls += 1;
          throw new AgentProviderError('context_overflow', 'Provider context overflowed.', 400);
        },
      },
      tools: [],
      signal: controller.signal,
      async onContextOverflow(continuation) {
        controller.abort();
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'aborted');
    assert.equal(providerCalls, 1);
  });

  it('converts cancellation thrown by overflow continuation into an aborted result', async () => {
    const controller = new AbortController();
    const result = await runAgentLoop({
      sessionId: 's-provider-overflow-continuation-abort',
      messages: [baseMessage],
      provider: {
        async generate() {
          throw new AgentProviderError('context_overflow', 'Provider context overflowed.', 400);
        },
      },
      tools: [],
      signal: controller.signal,
      async onContextOverflow() {
        controller.abort();
        throw new AgentProviderError('caller_abort', 'Compaction was cancelled.');
      },
    });

    assert.equal(result.reason, 'aborted');
  });

  it.each([
    [AGENT_DATA_DISCLOSURE_REQUIRED, 'disclosure'],
    [AGENT_HOST_PERMISSION_DENIED, 'permission'],
    [AGENT_PROVIDER_IDENTITY_CHANGED, 'capability'],
  ] as const)('classifies runtime authority failure %s as %s', async (code, category) => {
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      sessionId: `s-authority-${category}`,
      messages: [baseMessage],
      provider: { async generate() { throw new Error(code); } },
      tools: [],
      emit: (event) => events.push(event),
    });

    assert.equal(result.reason, 'provider_error');
    assert.equal(
      events.some((event) => event.type === 'agent_error' && event.category === category),
      true,
    );
  });

  it('emits translated provider errors without raw provider details', async () => {
    const credential = 'RAW_PROVIDER_CREDENTIAL_CANARY';
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      sessionId: 's-provider-error-redaction',
      messages: [baseMessage],
      provider: {
        async generate() {
          throw new AgentProviderError('network_error', `Provider rejected request: ${credential}`);
        },
      },
      tools: [],
      emit: (event) => events.push(event),
    });

    assert.equal(result.reason, 'provider_error');
    assert.deepEqual(events.filter((event) => event.type === 'agent_error'), [{
      type: 'agent_error',
      sessionId: 's-provider-error-redaction',
      message: 'AI provider network request failed.',
      category: 'provider',
    }]);
    assert.equal(JSON.stringify(events).includes(credential), false);
  });

  it('stops at the configured step budget', async () => {
    const result = await runAgentLoop({
      sessionId: 's4',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [
            {
              id: 'call-3',
              name: 'search_stars',
              arguments: { query: 'x' },
            },
          ],
        },
      ]),
      tools: [makeReadTool()],
      maxSteps: 1,
      idFactory: () => 'm-tool',
      now: () => 2,
    });

    assert.equal(result.reason, 'step_budget_reached');
  });

  it('replaces an oversized unsafe tool result with a bounded protocol error', async () => {
    const unsafeTool: AgentTool = {
      name: 'unsafe_read',
      description: 'Return an unsafe payload',
      risk: 'read',
      async execute() {
        return { payload: 'x'.repeat(MAX_TOOL_RESULT_BYTES) };
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-oversized-result',
      messages: [baseMessage],
      provider: new MockProvider([
        { toolCalls: [{ id: 'call-large', name: 'unsafe_read', arguments: {} }] },
        { content: 'Handled.' },
      ]),
      tools: [unsafeTool],
    });

    const toolMessage = result.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    const parsed = JSON.parse(toolMessage.content) as {
      ok: boolean;
      error?: { code: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.code, 'tool_output_too_large');
    assert.ok(encoder.encode(toolMessage.content).byteLength <= MAX_TOOL_RESULT_BYTES);
  });

  it('admits a transformed result and complete canonical envelope before publication', async () => {
    const events: AgentEvent[] = [];
    const order: string[] = [];
    const result = await runAgentLoop({
      sessionId: 's-generic-admission',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      provider: {
        async generate(input) {
          input.onStreamEvent?.({ type: 'response_start' });
          input.onStreamEvent?.({ type: 'text_delta', delta: 'Working' });
          return {
            content: 'Working',
            toolCalls: [{ id: 'call-admission', name: 'large_read', arguments: {} }],
          };
        },
      },
      tools: [{
        name: 'large_read',
        description: 'Return a large payload',
        risk: 'read',
        async execute() {
          return { payload: 'x'.repeat(MAX_TOOL_RESULT_BYTES) };
        },
      }],
      maxSteps: 1,
      toolResultAdmissionHost: {
        async afterToolResult(input) {
          assert.equal(input.result.ok, true);
          assert.equal(input.risk, 'read');
          assert.deepEqual(input.requiredBeforeFinal, []);
          return {
            result: okToolResult({ stored: true }),
            opaqueReferences: ['opaque:large-read'],
            requiredBeforeFinal: [{
              reference: 'coverage:large-read',
              progressToken: 'issued:0',
              requiredBeforeFinal: true,
            }],
            admissionToken: 'checkpoint:large-read',
          };
        },
        async admitEnvelope(input) {
          order.push('checkpoint');
          assert.equal(input.envelopeKind, 'canonical_source');
          assert.deepEqual(input.admissionTokens, ['checkpoint:large-read']);
          assert.deepEqual(input.projectedMessages.map((message) => message.role), [
            'user', 'agent', 'tool',
          ]);
          assert.deepEqual(input.canonicalRawMessages, input.projectedMessages);
        },
      },
      emit(event) {
        events.push(event);
        if (
          event.type === 'assistant_stream_start'
          || event.type === 'assistant_text_delta'
          || event.type === 'message_update'
        ) order.push(event.type);
      },
    });

    assert.equal(result.reason, undefined);
    assert.equal(result.continuation?.cause, 'episode_exhausted');
    assert.deepEqual(result.continuation?.requiredBeforeFinal, [{
      reference: 'coverage:large-read',
      progressToken: 'issued:0',
      requiredBeforeFinal: true,
    }]);
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    assert.deepEqual(toolMessage?.opaqueReferences, ['opaque:large-read']);
    assert.deepEqual(JSON.parse(toolMessage!.content), { ok: true, data: { stored: true } });
    assert.equal(order[0], 'checkpoint');
    assert.deepEqual(order.slice(1), [
      'assistant_stream_start',
      'assistant_text_delta',
      'message_update',
      'message_update',
    ]);
    assert.equal(events.some((event) => event.type === 'agent_done'), false);
  });

  it('disposes a transformed result that cannot fit and admits a generic error', async () => {
    let disposeCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-admission-overflow',
      messages: [baseMessage],
      provider: new MockProvider([{
        toolCalls: [{ id: 'call-admission-overflow', name: 'large_read', arguments: {} }],
      }]),
      tools: [{
        name: 'large_read',
        description: 'Return data',
        risk: 'read',
        async execute() {
          return { value: 1 };
        },
      }],
      contextPolicy: {
        ...CONTEXT_PROFILE_8192,
        memoryResultCeilingBytes: MIN_TOOL_RESULT_ENVELOPE_BYTES,
      },
      maxSteps: 1,
      toolResultAdmissionHost: {
        async afterToolResult() {
          return {
            result: okToolResult({ payload: 'x'.repeat(MAX_TOOL_RESULT_BYTES) }),
            dispose: async () => { disposeCalls += 1; },
          };
        },
      },
    });

    assert.equal(disposeCalls, 1);
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    assert.equal(JSON.parse(toolMessage!.content).error.code, 'tool_result_admission_failed');
    assert.equal(toolMessage?.opaqueReferences, undefined);
  });

  it('publishes no envelope content when its host checkpoint fails', async () => {
    const secret = 'host-checkpoint-secret';
    const events: AgentEvent[] = [];
    let disposeCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-admission-checkpoint-failure',
      messages: [baseMessage],
      provider: {
        async generate(input) {
          input.onStreamEvent?.({ type: 'response_start' });
          input.onStreamEvent?.({ type: 'text_delta', delta: 'provisional secret page' });
          return {
            content: 'provisional secret page',
            toolCalls: [{ id: 'call-checkpoint-failure', name: 'read_data', arguments: {} }],
          };
        },
      },
      tools: [{
        name: 'read_data',
        description: 'Read data',
        risk: 'read',
        async execute() { return { value: 1 }; },
      }],
      toolResultAdmissionHost: {
        async afterToolResult() {
          return {
            result: okToolResult({ projected: true }),
            opaqueReferences: ['opaque:unadmitted'],
            dispose: async () => { disposeCalls += 1; },
          };
        },
        async admitEnvelope() { throw new Error(secret); },
      },
      emit: (event) => events.push(event),
    });

    assert.equal(result.reason, 'provider_error');
    assert.deepEqual(result.messages, [baseMessage]);
    assert.equal(disposeCalls, 1);
    assert.equal(events.some((event) => event.type === 'message_update'), false);
    assert.equal(events.some((event) => event.type === 'assistant_stream_start'), false);
    assert.equal(events.some((event) => event.type === 'assistant_text_delta'), false);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(JSON.stringify(events).includes('provisional secret page'), false);
    assert.equal(
      events.some((event) => event.type === 'agent_error'
        && event.message === 'Tool result admission failed.'),
      true,
    );
  });

  it('keeps continuation envelopes internal and returns a host-switch boundary after clearing directives', async () => {
    const events: AgentEvent[] = [];
    const checkpoints: Array<{ projected: AgentMessage[]; canonical: AgentMessage[] }> = [];
    let providerCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-continuation-clear',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      requiredBeforeFinal: [{
        reference: 'required:one',
        progressToken: 'cursor:one',
        requiredBeforeFinal: true,
      }],
      provider: {
        async generate(input) {
          providerCalls += 1;
          input.onStreamEvent?.({ type: 'response_start' });
          input.onStreamEvent?.({
            type: 'text_delta',
            delta: providerCalls === 1 ? 'discard this prose' : 'Accepted final',
          });
          return providerCalls === 1
            ? {
                content: 'discard this prose',
                toolCalls: [{ id: 'call-progress', name: 'continue_read', arguments: {} }],
              }
            : { content: 'Accepted final' };
        },
      },
      tools: [{
        name: 'continue_read',
        description: 'Continue a host-owned read',
        risk: 'read',
        async execute() { return { page: 'bounded' }; },
      }],
      maxSteps: 2,
      toolResultAdmissionHost: {
        async afterToolResult() {
          return { result: okToolResult({ page: 'bounded' }), requiredBeforeFinal: [] };
        },
        async admitEnvelope(input) {
          assert.equal(input.envelopeKind, 'internal_continuation');
          checkpoints.push({
            projected: [...input.projectedMessages],
            canonical: [...input.canonicalRawMessages],
          });
        },
      },
      emit: (event) => events.push(event),
    });

    assert.equal(result.reason, undefined);
    assert.equal(result.continuation?.cause, 'episode_exhausted');
    assert.deepEqual(result.continuation?.requiredBeforeFinal, []);
    assert.equal(providerCalls, 1);
    assert.deepEqual(checkpoints[0]?.projected.map((message) => message.role), [
      'user', 'agent', 'tool',
    ]);
    assert.equal(checkpoints[0]?.projected[1]?.content, '');
    assert.deepEqual(checkpoints[0]?.canonical, [baseMessage]);
    assert.deepEqual(result.rawMessages?.map((message) => message.content), [
      baseMessage.content,
    ]);
    assert.deepEqual(events.filter((event) => event.type === 'assistant_text_delta'), []);
    assert.deepEqual(events.filter((event) => event.type === 'message_update'), []);
  });

  it('returns no progress without checkpointing or admitting unchanged continuation state', async () => {
    let checkpoints = 0;
    let disposeCalls = 0;
    const directive = {
      reference: 'required:unchanged',
      progressToken: 'cursor:same',
      requiredBeforeFinal: true as const,
    };
    const result = await runAgentLoop({
      sessionId: 's-continuation-no-progress',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      requiredBeforeFinal: [directive],
      provider: new MockProvider([{
        content: 'premature prose',
        toolCalls: [{ id: 'call-no-progress', name: 'continue_read', arguments: {} }],
      }]),
      tools: [{
        name: 'continue_read',
        description: 'Continue a host-owned read',
        risk: 'read',
        async execute() { return { page: 'same' }; },
      }],
      toolResultAdmissionHost: {
        async afterToolResult() {
          return {
            result: okToolResult({ page: 'same' }),
            requiredBeforeFinal: [directive],
            dispose: async () => { disposeCalls += 1; },
          };
        },
        async admitEnvelope() { checkpoints += 1; },
      },
    });

    assert.equal(result.reason, undefined);
    assert.equal(result.continuation?.cause, 'no_progress');
    assert.deepEqual(result.messages, [baseMessage]);
    assert.deepEqual(result.rawMessages, [baseMessage]);
    assert.deepEqual(result.continuation?.requiredBeforeFinal, [directive]);
    assert.equal(checkpoints, 0);
    assert.equal(disposeCalls, 1);
  });
  it('retains token-backed checkpointed non-progress envelopes through one bounded episode', async () => {
    const directive = {
      reference: 'required:targeted',
      progressToken: 'cursor:same',
      requiredBeforeFinal: true as const,
    };
    const checkpoints: AgentMessage[][] = [];
    const result = await runAgentLoop({
      sessionId: 's-continuation-targeted',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      requiredBeforeFinal: [directive],
      provider: new MockProvider([
        { toolCalls: [{ id: 'call-search', name: 'targeted_read', arguments: { mode: 'search' } }] },
        { toolCalls: [{ id: 'call-offset', name: 'targeted_read', arguments: { mode: 'offset' } }] },
      ]),
      tools: [{
        name: 'targeted_read',
        description: 'Read a targeted location.',
        risk: 'read',
        async execute() { return { ok: true }; },
      }],
      maxSteps: 2,
      toolResultAdmissionHost: {
        async afterToolResult(input) {
          return {
            result: okToolResult({ mode: input.toolCall.name }),
            requiredBeforeFinal: [directive],
            admissionToken: input.toolCall.id,
            retainOnNoProgress: true,
          };
        },
        async admitEnvelope(input) {
          checkpoints.push([...input.projectedMessages]);
        },
      },
    });

    assert.equal(result.continuation?.cause, 'no_progress');
    assert.equal(checkpoints.length, 2);
    assert.deepEqual(result.messages.map((message) => message.role), ['user', 'agent', 'tool', 'agent', 'tool']);
    assert.deepEqual(result.rawMessages, [baseMessage]);
  });

  it('ignores no-progress markers without a successful token-backed checkpointed admission', async () => {
    const directive = {
      reference: 'required:retention-validation',
      progressToken: 'cursor:same',
      requiredBeforeFinal: true as const,
    };
    for (const scenario of [
      {
        name: 'error result',
        admittedResult: errorToolResult('bounded_error', 'Bounded error.'),
        admissionToken: 'token',
        checkpoint: true,
      },
      {
        name: 'missing token',
        admittedResult: okToolResult({ located: true }),
        admissionToken: undefined,
        checkpoint: true,
      },
      {
        name: 'missing checkpoint',
        admittedResult: okToolResult({ located: true }),
        admissionToken: 'token',
        checkpoint: false,
      },
    ] as const) {
      let checkpoints = 0;
      const result = await runAgentLoop({
        sessionId: `s-retention-${scenario.name.replace(/ /gu, '-')}`,
        messages: [baseMessage],
        rawMessages: [baseMessage],
        requiredBeforeFinal: [directive],
        provider: new MockProvider([{
          toolCalls: [{ id: 'call-retention-validation', name: 'targeted_read', arguments: {} }],
        }]),
        tools: [{
          name: 'targeted_read',
          description: 'Read a targeted location.',
          risk: 'read',
          async execute() { return { located: true }; },
        }],
        maxSteps: 1,
        toolResultAdmissionHost: {
          async afterToolResult() {
            return {
              result: scenario.admittedResult,
              requiredBeforeFinal: [directive],
              ...(scenario.admissionToken === undefined
                ? {}
                : { admissionToken: scenario.admissionToken }),
              retainOnNoProgress: true,
            };
          },
          ...(scenario.checkpoint ? {
            async admitEnvelope() { checkpoints += 1; },
          } : {}),
        },
      });
      assert.equal(result.continuation?.cause, 'no_progress', scenario.name);
      assert.deepEqual(result.messages, [baseMessage], scenario.name);
      assert.equal(checkpoints, 0, scenario.name);
    }
  });

  it('does not let one retained sibling keep an unmarked no-progress envelope', async () => {
    const directive = {
      reference: 'required:all-envelopes',
      progressToken: 'cursor:same',
      requiredBeforeFinal: true as const,
    };
    let checkpoints = 0;
    const result = await runAgentLoop({
      sessionId: 's-retention-mixed-siblings',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      requiredBeforeFinal: [directive],
      provider: new MockProvider([{
        toolCalls: [
          { id: 'call-retained', name: 'retained_read', arguments: {} },
          { id: 'call-unmarked', name: 'ordinary_read', arguments: {} },
        ],
      }]),
      tools: [
        {
          name: 'retained_read',
          description: 'Read a targeted location.',
          risk: 'read',
          async execute() { return { located: true }; },
        },
        {
          name: 'ordinary_read',
          description: 'Read ordinary data.',
          risk: 'read',
          async execute() { return { ordinary: true }; },
        },
      ],
      toolResultAdmissionHost: {
        async afterToolResult(input) {
          return {
            result: okToolResult({ call: input.toolCall.id }),
            requiredBeforeFinal: [directive],
            admissionToken: input.toolCall.id,
            ...(input.toolCall.name === 'retained_read' ? { retainOnNoProgress: true } : {}),
          };
        },
        async admitEnvelope() { checkpoints += 1; },
      },
    });
    assert.equal(result.continuation?.cause, 'no_progress');
    assert.deepEqual(result.messages, [baseMessage]);
    assert.equal(checkpoints, 0);
  });

  it('preserves ordinary exhaustion after required progress within an episode', async () => {
    const progressTokens = ['cursor:two', 'cursor:three'];
    let calls = 0;
    let checkpoints = 0;
    const result = await runAgentLoop({
      sessionId: 's-retention-progress',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      requiredBeforeFinal: [{
        reference: 'required:progress',
        progressToken: 'cursor:one',
        requiredBeforeFinal: true,
      }],
      provider: new MockProvider([
        { toolCalls: [{ id: 'call-progress-one', name: 'continue_read', arguments: {} }] },
        { toolCalls: [{ id: 'call-progress-two', name: 'continue_read', arguments: {} }] },
      ]),
      tools: [{
        name: 'continue_read',
        description: 'Continue a host-owned read.',
        risk: 'read',
        async execute() { return { page: 'next' }; },
      }],
      maxSteps: 2,
      toolResultAdmissionHost: {
        async afterToolResult() {
          const progressToken = progressTokens[calls++];
          if (!progressToken) throw new Error('unexpected extra progress call');
          return {
            result: okToolResult({ page: progressToken }),
            requiredBeforeFinal: [{
              reference: 'required:progress',
              progressToken,
              requiredBeforeFinal: true,
            }],
          };
        },
        async admitEnvelope() { checkpoints += 1; },
      },
    });
    assert.equal(result.continuation?.cause, 'episode_exhausted');
    assert.equal(result.continuation?.requiredBeforeFinal[0]?.progressToken, 'cursor:three');
    assert.equal(checkpoints, 2);
  });
  it('recognizes opaque token advancement before returning a later no-progress candidate', async () => {
    let providerCalls = 0;
    const result = await runAgentLoop({
      sessionId: 's-continuation-token-progress',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      requiredBeforeFinal: [{
        reference: 'required:token',
        progressToken: 'cursor:one',
        requiredBeforeFinal: true,
      }],
      provider: new MockProvider([
        { toolCalls: [{ id: 'call-token-progress', name: 'continue_read', arguments: {} }] },
        { content: 'still premature' },
      ]),
      tools: [{
        name: 'continue_read',
        description: 'Continue a host-owned read',
        risk: 'read',
        async execute() { return { page: 'next' }; },
      }],
      maxSteps: 2,
      toolResultAdmissionHost: {
        async afterToolResult() {
          providerCalls += 1;
          return {
            result: okToolResult({ page: 'next' }),
            requiredBeforeFinal: [{
              reference: 'required:token',
              progressToken: 'cursor:two',
              requiredBeforeFinal: true,
            }],
          };
        },
        async admitEnvelope() {},
      },
    });

    assert.equal(providerCalls, 1);
    assert.equal(result.reason, undefined);
    assert.equal(result.continuation?.cause, 'no_progress');
    assert.equal(result.continuation?.requiredBeforeFinal[0]?.progressToken, 'cursor:two');
    assert.deepEqual(result.rawMessages, [baseMessage]);
    assert.deepEqual(result.messages.map((message) => message.role), ['user', 'agent', 'tool']);
  });

  it('accepts a serialized tool result exactly at the per-result byte limit', async () => {
    const envelopeOverhead = encoder.encode(JSON.stringify({ ok: true, data: { payload: '' } })).byteLength;
    const boundaryTool: AgentTool = {
      name: 'boundary_read',
      description: 'Return an exact-boundary payload',
      risk: 'read',
      async execute() {
        return { payload: 'x'.repeat(MAX_TOOL_RESULT_BYTES - envelopeOverhead) };
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-boundary-result',
      messages: [baseMessage],
      provider: new MockProvider([
        { toolCalls: [{ id: 'call-boundary', name: 'boundary_read', arguments: {} }] },
        { content: 'Handled.' },
      ]),
      tools: [boundaryTool],
    });

    const toolMessage = result.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    assert.equal(encoder.encode(toolMessage.content).byteLength, MAX_TOOL_RESULT_BYTES);
    assert.equal((JSON.parse(toolMessage.content) as { ok: boolean }).ok, true);
  });

  it('caps cumulative serialized tool results within one turn', async () => {
    const resultBytes = 6_000;
    const envelopeOverhead = encoder.encode(JSON.stringify({ ok: true, data: { payload: '' } })).byteLength;
    const boundedTool: AgentTool = {
      name: 'bounded_read',
      description: 'Return a precisely sized payload',
      risk: 'read',
      async execute() {
        return { payload: 'x'.repeat(resultBytes - envelopeOverhead) };
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-cumulative-results',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [1, 2, 3].map((index) => ({
            id: `call-${index}`,
            name: 'bounded_read',
            arguments: {},
          })),
        },
        { content: 'Handled.' },
      ]),
      tools: [boundedTool],
    });

    const toolResults = result.messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content) as { ok: boolean; error?: { code: string } });
    assert.deepEqual(toolResults.map((item) => item.ok), [true, true, false]);
    assert.equal(toolResults[2]?.error?.code, 'tool_output_too_large');
    assert.ok(resultBytes * 2 <= MAX_TURN_TOOL_RESULT_BYTES);
    assert.ok(resultBytes * 3 > MAX_TURN_TOOL_RESULT_BYTES);
  });

  it('accepts exactly 16 KiB of results and bounds a candidate one byte above it', () => {
    const first = finalizeToolResult(resultWithByteLength(8_000), 0, MIN_TOOL_RESULT_ENVELOPE_BYTES * 2);
    const second = finalizeToolResult(
      resultWithByteLength(8_000),
      first.byteLength,
      MIN_TOOL_RESULT_ENVELOPE_BYTES,
    );
    const exact = finalizeToolResult(
      resultWithByteLength(MAX_TURN_TOOL_RESULT_BYTES - first.byteLength - second.byteLength),
      first.byteLength + second.byteLength,
    );

    assert.equal(first.byteLength + second.byteLength + exact.byteLength, MAX_TURN_TOOL_RESULT_BYTES);
    assert.equal(exact.result.ok, true);

    const plusOne = finalizeToolResult(
      resultWithByteLength(exact.byteLength + 1),
      first.byteLength + second.byteLength,
    );
    assert.equal(plusOne.result.ok, false);
    assert.equal(
      (plusOne.result as { ok: false; error: { code: string } }).error.code,
      'tool_output_too_large',
    );
    assert.ok(first.byteLength + second.byteLength + plusOne.byteLength <= MAX_TURN_TOOL_RESULT_BYTES);
  });

  it('counts multibyte UTF-8 bytes and sanitizes huge tool errors', () => {
    const finalized = finalizeToolResult(errorToolResult('bad', '界'.repeat(10_000)), 0);
    assert.equal(finalized.result.ok, false);
    assert.equal(encoder.encode(finalized.serialized).byteLength, finalized.byteLength);
    assert.ok(finalized.byteLength <= MAX_TOOL_RESULT_BYTES);
    assert.ok(finalized.serialized.length < finalized.byteLength);
  });

  it('keeps repeated huge errors within the cumulative turn budget', async () => {
    const calls = Array.from({ length: 20 }, (_, index) => ({
      id: `call-error-${index}`,
      name: 'error_read',
      arguments: {},
    }));
    const errorTool: AgentTool = {
      name: 'error_read',
      description: 'Throw a large error',
      risk: 'read',
      async execute() {
        throw new Error('界'.repeat(10_000));
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-repeated-errors',
      messages: [baseMessage],
      provider: new MockProvider([{ toolCalls: calls }, { content: 'Handled.' }]),
      tools: [errorTool],
    });
    const toolMessages = result.messages.filter((message) => message.role === 'tool');
    const totalBytes = toolMessages.reduce(
      (sum, message) => sum + encoder.encode(message.content).byteLength,
      0,
    );

    assert.equal(toolMessages.length, calls.length);
    assert.ok(toolMessages.every((message) => encoder.encode(message.content).byteLength <= MAX_TOOL_RESULT_BYTES));
    assert.ok(totalBytes <= MAX_TURN_TOOL_RESULT_BYTES);
    assert.ok(toolMessages.every((message) => JSON.parse(message.content).ok === false));
  });

  it('rejects tool calls before appending when minimal result envelopes cannot fit', async () => {
    const sizedTool: AgentTool<unknown, { payload: string }> = {
      name: 'sized_read',
      description: 'Return fixed-size data',
      risk: 'read',
      async execute() {
        const overhead = encoder.encode(JSON.stringify(okToolResult({ payload: '' }))).byteLength;
        return { payload: 'x'.repeat(8_000 - overhead) };
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-preappend-reservation',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [1, 2].map((index) => ({
            id: `call-fill-${index}`,
            name: 'sized_read',
            arguments: {},
          })),
        },
        {
          toolCalls: [1, 2, 3, 4].map((index) => ({
            id: `call-rejected-${index}`,
            name: 'sized_read',
            arguments: {},
          })),
        },
      ]),
      tools: [sizedTool],
    });

    assert.equal(result.reason, 'step_budget_reached');
    assert.equal(result.messages.some((message) => message.toolCalls?.[0]?.id === 'call-rejected-1'), false);
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 2);
  });

  it('emits one result for every declared call when approval stops execution', async () => {
    const writeTool: AgentTool = {
      name: 'write_many',
      description: 'Require approval',
      risk: 'write',
      async execute() {
        return { changed: true };
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-approval-boundary',
      messages: [baseMessage],
      provider: new MockProvider([{
        toolCalls: [1, 2, 3].map((index) => ({
          id: `call-approval-${index}`,
          name: 'write_many',
          arguments: {},
        })),
      }]),
      tools: [writeTool],
    });

    assert.equal(result.reason, 'approval_required');
    assert.deepEqual(
      result.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
      ['call-approval-1', 'call-approval-2', 'call-approval-3'],
    );
  });

  it('rejects a mixed exclusive envelope before any sibling tool can execute', async () => {
    const executed: string[] = [];
    const writeTool: AgentTool = {
      name: 'write_before_handoff',
      description: 'Mutate durable state',
      risk: 'write',
      async execute() {
        executed.push('write');
        return { changed: true };
      },
    };
    const handoffTool: AgentTool = {
      name: 'exclusive_handoff',
      description: 'Transfer control to a dedicated workflow',
      risk: 'suggest',
      requiresExclusiveEnvelope: true,
      async execute() {
        executed.push('handoff');
        return { status: 'accepted' };
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-exclusive-envelope',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [
            { id: 'call-write', name: writeTool.name, arguments: {} },
            { id: 'call-handoff', name: handoffTool.name, arguments: {} },
          ],
        },
        { content: 'Retried safely.' },
      ]),
      tools: [writeTool, handoffTool],
      permissions: async () => ({ type: 'allow' }),
    });

    assert.equal(result.reason, 'final_answer');
    assert.deepEqual(executed, []);
    assert.deepEqual(
      result.messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content).error.code),
      ['exclusive_tool_envelope_required', 'exclusive_tool_envelope_required'],
    );
  });

  it('pairs every declared call when the permission evaluator rejects', async () => {
    const secret = 'permission-secret-do-not-expose';
    const result = await runAgentLoop({
      sessionId: 's-permission-rejection',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [1, 2, 3].map((index) => ({
            id: `call-permission-${index}`,
            name: 'search_stars',
            arguments: { query: 'agent' },
          })),
        },
        { content: 'Handled.' },
      ]),
      tools: [makeReadTool()],
      permissions: async () => {
        throw new Error(secret);
      },
    });

    const toolMessages = result.messages.filter((message) => message.role === 'tool');
    assert.equal(result.reason, 'final_answer');
    assert.deepEqual(
      toolMessages.map((message) => message.toolCallId),
      ['call-permission-1', 'call-permission-2', 'call-permission-3'],
    );
    assert.deepEqual(
      toolMessages.map((message) => JSON.parse(message.content)),
      Array.from({ length: 3 }, () => ({
        ok: false,
        error: {
          code: 'permission_evaluation_failed',
          message: 'Tool permission evaluation failed.',
        },
      })),
    );
    assert.equal(toolMessages.some((message) => message.content.includes(secret)), false);
  });

  it('does not expose validator or tool exception messages in tool results', async () => {
    const validatorSecret = 'validator-secret-do-not-expose';
    const toolSecret = 'tool-secret-do-not-expose';
    const oversizedSecret = 'oversized-secret-do-not-expose';
    const failingTool: AgentTool = {
      name: 'failing_read',
      description: 'Fail during execution',
      risk: 'read',
      async execute() {
        throw new Error(toolSecret);
      },
    };
    const oversizedTool: AgentTool = {
      name: 'oversized_read',
      description: 'Reject oversized output',
      risk: 'read',
      async execute() {
        throw new ToolOutputTooLargeError(oversizedSecret);
      },
    };
    const result = await runAgentLoop({
      sessionId: 's-private-tool-errors',
      messages: [baseMessage],
      provider: new MockProvider([
        {
          toolCalls: [
            { id: 'call-invalid', name: 'search_stars', arguments: {} },
            { id: 'call-failing', name: 'failing_read', arguments: {} },
            { id: 'call-oversized', name: 'oversized_read', arguments: {} },
          ],
        },
        { content: 'Handled.' },
      ]),
      tools: [
        {
          ...makeReadTool(),
          validate() {
            throw new Error(validatorSecret);
          },
        },
        failingTool,
        oversizedTool,
      ],
    });

    const toolResults = result.messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content));
    assert.deepEqual(toolResults, [
      {
        ok: false,
        error: { code: 'invalid_arguments', message: 'Tool arguments were invalid.' },
      },
      {
        ok: false,
        error: { code: 'tool_execution_failed', message: 'Tool execution failed.' },
      },
      {
        ok: false,
        error: {
          code: 'tool_output_too_large',
          message: 'Tool output exceeded the available result budget. Request a smaller page.',
        },
      },
    ]);
    assert.equal(JSON.stringify(toolResults).includes(validatorSecret), false);
    assert.equal(JSON.stringify(toolResults).includes(toolSecret), false);
    assert.equal(JSON.stringify(toolResults).includes(oversizedSecret), false);
  });
});
