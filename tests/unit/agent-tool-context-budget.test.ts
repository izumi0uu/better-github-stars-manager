import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
  MIN_TOOL_RESULT_ENVELOPE_BYTES,
  estimateContext,
  estimateContextWithUsage,
  preflightContextRequest,
  resolveContextBudgetPolicy,
  runAgentLoop,
  type AgentMessage,
  type AgentEvent,
  type AgentTool,
  AgentProviderError,
  type ContextBudgetPolicy,
  type ModelGenerateInput,
  type ModelResponse,
  type ModelUsage,
  type ToolResultAllowance,
} from '../../src/agent-harness/index.ts';

const encoder = new TextEncoder();
const baseMessage: AgentMessage = {
  id: 'user-1',
  role: 'user',
  content: 'Inspect these repositories.',
  createdAt: 1,
};

type CapturedRequest = Readonly<{
  messages: ModelGenerateInput['messages'];
  tools: ModelGenerateInput['tools'];
}>;

function contextPolicy(
  contextWindow: number,
  options: Readonly<{
    maxOutputTokens?: number;
    memoryResultCeilingBytes?: number;
  }> = {},
): ContextBudgetPolicy {
  const maxOutputTokens = options.maxOutputTokens ?? 1_024;
  return resolveContextBudgetPolicy({
    capability: {
      schemaVersion: 1,
      contextWindow,
      maxOutputTokens: Math.min(8_192, contextWindow),
      source: 'user-declared',
      sourceRevision: `test:${contextWindow}`,
      capabilityRevision: `test:${contextWindow}:${maxOutputTokens}`,
    },
    requestedOutputTokens: maxOutputTokens,
    safetyReserveTokens: Math.min(1_024, Math.floor(contextWindow / 4)),
    memoryResultCeilingBytes: options.memoryResultCeilingBytes,
  });
}

function dataForSerializedBytes(targetBytes: number, character = 'x'): { payload: string } {
  const overhead = encoder.encode(JSON.stringify({ ok: true, data: { payload: '' } })).byteLength;
  assert.ok(targetBytes >= overhead);
  const characterBytes = encoder.encode(character).byteLength;
  const available = targetBytes - overhead;
  const repeated = Math.floor(available / characterBytes);
  return {
    payload: character.repeat(repeated) + 'x'.repeat(available - repeated * characterBytes),
  };
}

function createBudgetAwareTool(
  name: string,
  allowances: ToolResultAllowance[],
  requestedBytes: (allowance: ToolResultAllowance) => number,
  character = 'x',
): AgentTool {
  return {
    name,
    description: `Read data through ${name}.`,
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { page: { type: 'integer' } },
      required: ['page'],
      additionalProperties: false,
    },
    async execute(_args, context) {
      assert.ok(context.resultAllowance);
      allowances.push(context.resultAllowance);
      return dataForSerializedBytes(requestedBytes(context.resultAllowance), character);
    },
  };
}

function sequentialIdFactory(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function captureRequest(input: ModelGenerateInput): CapturedRequest {
  return {
    messages: input.messages.map((message) => ({ ...message })),
    tools: input.tools.map((tool) => ({ ...tool })),
  };
}

function assertProjectionWithinPolicy(
  request: CapturedRequest,
  policy: ContextBudgetPolicy,
  maxOutputTokens: number,
): void {
  const preflight = preflightContextRequest({
    messages: request.messages,
    toolSchemas: request.tools,
    maxOutputTokens,
  }, policy);
  assert.ok(
    preflight.inputTokens <= policy.hardLimit,
    `projection ${preflight.inputTokens} exceeded hard limit ${policy.hardLimit}`,
  );
}

describe('agent tool context budget invariants', () => {
  it.each([32_768, 131_072])(
    'continues a short two-result turn near the former 8 KiB cap in a %i-token window',
    async (contextWindow) => {
      const policy = contextPolicy(contextWindow);
      const allowances: ToolResultAllowance[] = [];
      const requests: CapturedRequest[] = [];
      const tools = ['read_first', 'read_second'].map((name) =>
        createBudgetAwareTool(name, allowances, () => 8_000));
      let call = 0;

      const result = await runAgentLoop({
        sessionId: `two-results-${contextWindow}`,
        messages: [baseMessage],
        tools,
        contextPolicy: policy,
        maxOutputTokens: policy.requestedOutputTokens,
        idFactory: sequentialIdFactory('message'),
        now: () => 2,
        provider: {
          async generate(input): Promise<ModelResponse> {
            requests.push(captureRequest(input));
            call += 1;
            return call === 1
              ? {
                  toolCalls: tools.map((tool, index) => ({
                    id: `call-${index}`,
                    name: tool.name,
                    arguments: { page: 1 },
                  })),
                }
              : { content: 'Both result envelopes fit.' };
          },
        },
      });

      assert.equal(result.reason, 'final_answer');
      assert.equal(requests.length, 2);
      assert.equal(allowances.length, 2);
      assert.ok(allowances.every((allowance) => allowance.maxSerializedBytes >= 8_000));
      assert.equal(result.messages.filter((message) => message.role === 'tool').length, 2);
      for (const request of requests) {
        assertProjectionWithinPolicy(request, policy, policy.requestedOutputTokens);
      }
    },
  );

  it('shrinks dynamically in a narrow window and replaces an oversized result with a minimal error envelope', async () => {
    const maxOutputTokens = 256;
    const policy = contextPolicy(4_096, { maxOutputTokens });
    const allowances: ToolResultAllowance[] = [];
    const requests: CapturedRequest[] = [];
    const diagnostics: Extract<AgentEvent, { type: 'context_diagnostic' }>[] = [];
    const tool = createBudgetAwareTool(
      'read_oversized',
      allowances,
      (allowance) => allowance.maxSerializedBytes + 1_000,
    );
    let call = 0;

    const result = await runAgentLoop({
      sessionId: 'narrow-fallback',
      messages: [baseMessage],
      tools: [tool],
      contextPolicy: policy,
      maxOutputTokens,
      idFactory: sequentialIdFactory('narrow'),
      emit(event) {
        if (event.type === 'context_diagnostic') diagnostics.push(event);
      },
      provider: {
        async generate(input): Promise<ModelResponse> {
          requests.push(captureRequest(input));
          call += 1;
          return call === 1
            ? { toolCalls: [{ id: 'narrow-call', name: tool.name, arguments: { page: 1 } }] }
            : { content: 'Recovered from the bounded result.' };
        },
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(allowances.length, 1);
    assert.ok(allowances[0].maxSerializedBytes >= MIN_TOOL_RESULT_ENVELOPE_BYTES);
    assert.ok(allowances[0].maxSerializedBytes < 8_192);
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    assert.ok(encoder.encode(toolMessage.content).byteLength <= allowances[0].maxSerializedBytes);
    assert.deepEqual(JSON.parse(toolMessage.content), {
      ok: false,
      error: {
        code: 'tool_output_too_large',
        message: 'Tool output exceeded the available result budget. Request a smaller page.',
      },
    });
    assert.equal(requests.length, 2);
    assertProjectionWithinPolicy(requests[1], policy, maxOutputTokens);
    assert.ok(diagnostics.some((event) => (
      event.stage === 'tool_allowance'
      && event.toolResultReduced === true
      && typeof event.toolResultBytes === 'number'
    )));
  });

  it('reserves worst-case JSON expansion against the exact Provider byte ceiling', async () => {
    const policy = contextPolicy(32_768);
    const allowances: ToolResultAllowance[] = [];
    const diagnostics: Extract<AgentEvent, { type: 'context_diagnostic' }>[] = [];
    const tool = createBudgetAwareTool(
      'read_provider_limited',
      allowances,
      (allowance) => allowance.maxSerializedBytes + 1_000,
    );
    let call = 0;

    const result = await runAgentLoop({
      sessionId: 'provider-byte-limited-result',
      messages: [baseMessage],
      tools: [tool],
      contextPolicy: policy,
      maxOutputTokens: policy.requestedOutputTokens,
      emit(event) {
        if (event.type === 'context_diagnostic') diagnostics.push(event);
      },
      provider: {
        inspectRequest() {
          return {
            serializedHistoryBytes: 900,
            serializedRequestBytes: 900,
            historyByteLimit: 1_000,
            requestByteLimit: 2_000,
            accepted: true,
          };
        },
        async generate(): Promise<ModelResponse> {
          call += 1;
          return call === 1
            ? { toolCalls: [{ id: 'provider-limited-call', name: tool.name, arguments: {} }] }
            : { content: 'The bounded result fit.' };
        },
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(allowances.length, 1);
    assert.equal(
      allowances[0].providerResultCeilingBytes,
      MIN_TOOL_RESULT_ENVELOPE_BYTES + 50,
    );
    assert.equal(allowances[0].maxSerializedBytes, allowances[0].providerResultCeilingBytes);
    assert.ok(diagnostics.some((event) => (
      event.stage === 'tool_allowance'
      && event.toolBudgetLimitedBy === 'provider'
      && event.toolProviderResultCeilingBytes === MIN_TOOL_RESULT_ENVELOPE_BYTES + 50
    )));
  });

  it('settles a minimum tool envelope before recovering byte pressure', async () => {
    const policy = contextPolicy(32_768);
    const allowances: ToolResultAllowance[] = [];
    let providerCalls = 0;
    let toolExecutions = 0;
    let continuationCalls = 0;
    const tool = createBudgetAwareTool(
      'read_before_byte_compaction',
      allowances,
      () => 2_000,
    );

    const result = await runAgentLoop({
      sessionId: 'minimum-envelope-before-byte-compaction',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      tools: [{
        ...tool,
        async execute(args, context) {
          toolExecutions += 1;
          return tool.execute(args, context);
        },
      }],
      contextPolicy: policy,
      maxOutputTokens: policy.requestedOutputTokens,
      provider: {
        inspectRequest(request) {
          const containsToolEnvelope = request.messages.some((message) => (
            message.role === 'assistant' || message.role === 'tool'
          ));
          return {
            serializedHistoryBytes: containsToolEnvelope ? 1_001 : 100,
            serializedRequestBytes: containsToolEnvelope ? 2_001 : 200,
            historyByteLimit: 1_000,
            requestByteLimit: 2_000,
            accepted: !containsToolEnvelope,
            ...(containsToolEnvelope
              ? { failure: 'provider_history_too_large' as const }
              : {}),
          };
        },
        async generate() {
          providerCalls += 1;
          return providerCalls === 1
            ? {
                content: 'x'.repeat(2_000),
                toolCalls: [{
                  id: 'minimum-envelope-call',
                  name: tool.name,
                  arguments: { page: 1 },
                }],
              }
            : { content: 'Recovered after settling the tool.' };
        },
      },
      async onToolEnvelopeSettled(continuation) {
        continuationCalls += 1;
        assert.equal(continuation.trigger, 'provider_request_byte_limit');
        assert.deepEqual(
          continuation.messages.slice(-2).map((message) => message.role),
          ['agent', 'tool'],
        );
        return { kind: 'ready', messages: [baseMessage] };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(providerCalls, 2);
    assert.equal(toolExecutions, 1);
    assert.equal(continuationCalls, 1);
    assert.equal(allowances[0]?.maxSerializedBytes, MIN_TOOL_RESULT_ENVELOPE_BYTES);
    assert.equal(allowances[0]?.providerResultCeilingBytes, 0);
    assert.deepEqual(result.rawMessages?.map((message) => message.role), [
      'user', 'agent', 'tool', 'agent',
    ]);
  });

  it('measures Unicode results by UTF-8 bytes while honoring the separate memory ceiling', async () => {
    const maxOutputTokens = 256;
    const memoryResultCeilingBytes = 700;
    const policy = contextPolicy(32_768, { maxOutputTokens, memoryResultCeilingBytes });
    const allowances: ToolResultAllowance[] = [];
    const requests: CapturedRequest[] = [];
    const tool = createBudgetAwareTool(
      'read_unicode',
      allowances,
      (allowance) => allowance.maxSerializedBytes,
      '😀',
    );
    let call = 0;

    const result = await runAgentLoop({
      sessionId: 'unicode-memory',
      messages: [{ ...baseMessage, content: '读取 😀 e\u0301' }],
      tools: [tool],
      contextPolicy: policy,
      maxOutputTokens,
      idFactory: sequentialIdFactory('unicode'),
      provider: {
        async generate(input): Promise<ModelResponse> {
          requests.push(captureRequest(input));
          call += 1;
          return call === 1
            ? { toolCalls: [{ id: 'unicode-call', name: tool.name, arguments: { page: 1 } }] }
            : { content: 'Unicode result accepted.' };
        },
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(allowances.length, 1);
    assert.equal(allowances[0].maxSerializedBytes, memoryResultCeilingBytes);
    assert.equal(allowances[0].memoryRemainingBytes, memoryResultCeilingBytes);
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    assert.equal(encoder.encode(toolMessage.content).byteLength, memoryResultCeilingBytes);
    assertProjectionWithinPolicy(requests[1], policy, maxOutputTokens);
  });

  it('reserves complete envelopes for multiple schemas and parallel tool calls', async () => {
    const maxOutputTokens = 512;
    const memoryResultCeilingBytes = 2_000;
    const policy = contextPolicy(16_384, { maxOutputTokens, memoryResultCeilingBytes });
    const allowances: ToolResultAllowance[] = [];
    const requests: CapturedRequest[] = [];
    const tools = Array.from({ length: 4 }, (_, index) =>
      createBudgetAwareTool(
        `read_parallel_${index}`,
        allowances,
        (allowance) => Math.min(420, allowance.maxSerializedBytes),
      ));
    let call = 0;

    const result = await runAgentLoop({
      sessionId: 'parallel-calls',
      messages: [baseMessage],
      tools,
      contextPolicy: policy,
      maxOutputTokens,
      idFactory: sequentialIdFactory('parallel'),
      provider: {
        async generate(input): Promise<ModelResponse> {
          requests.push(captureRequest(input));
          call += 1;
          return call === 1
            ? {
                toolCalls: tools.map((tool, index) => ({
                  id: `parallel-call-${index}`,
                  name: tool.name,
                  arguments: { page: index + 1 },
                })),
              }
            : { content: 'All parallel results are complete.' };
        },
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(allowances.length, tools.length);
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, tools.length);
    for (let index = 1; index < allowances.length; index += 1) {
      assert.ok(allowances[index].memoryRemainingBytes < allowances[index - 1].memoryRemainingBytes);
    }
    assert.ok(allowances.every((allowance) => allowance.maxSerializedBytes >= 420));
    assertProjectionWithinPolicy(requests[1], policy, maxOutputTokens);
  });

  it('uses larger Provider usage only to tighten the result allowance', async () => {
    const maxOutputTokens = 512;
    const policy = contextPolicy(16_384, { maxOutputTokens, memoryResultCeilingBytes: 64 * 1024 });

    async function allowanceFor(usage: ModelUsage): Promise<ToolResultAllowance> {
      const allowances: ToolResultAllowance[] = [];
      const tool = createBudgetAwareTool(
        'read_usage_sensitive',
        allowances,
        (allowance) => Math.min(200, allowance.maxSerializedBytes),
      );
      let call = 0;
      const result = await runAgentLoop({
        sessionId: `usage-${usage.totalTokens}`,
        messages: [baseMessage],
        tools: [tool],
        contextPolicy: policy,
        maxOutputTokens,
        idFactory: sequentialIdFactory(`usage-${usage.totalTokens}`),
        provider: {
          async generate(): Promise<ModelResponse> {
            call += 1;
            return call === 1
              ? {
                  toolCalls: [{
                    id: `usage-call-${usage.totalTokens}`,
                    name: tool.name,
                    arguments: { page: 1 },
                  }],
                  usage,
                }
              : { content: 'Usage-aware continuation.' };
          },
        },
      });
      assert.equal(result.reason, 'final_answer');
      assert.equal(allowances.length, 1);
      return allowances[0];
    }

    const smaller = await allowanceFor({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    const larger = await allowanceFor({ inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500 });
    assert.ok(larger.contextRemainingTokens < smaller.contextRemainingTokens);
    assert.ok(larger.maxSerializedBytes < smaller.maxSerializedBytes);
  });

  it('invokes continuation only after a complete active tool envelope', async () => {
    const policy = contextPolicy(24_000, { memoryResultCeilingBytes: 64 * 1024 });
    const allowances: ToolResultAllowance[] = [];
    const tool = createBudgetAwareTool('read_large_page', allowances, () => 55_000);
    const continuations: AgentMessage[][] = [];
    let call = 0;

    const result = await runAgentLoop({
      sessionId: 'completed-envelope-continuation',
      messages: [baseMessage],
      tools: [tool],
      contextPolicy: policy,
      maxOutputTokens: policy.requestedOutputTokens,
      idFactory: sequentialIdFactory('continuation'),
      provider: {
        async generate() {
          call += 1;
          return call === 1
            ? { toolCalls: [{ id: 'large-call', name: tool.name, arguments: { page: 1 } }] }
            : { content: 'Continued after the complete envelope.' };
        },
      },
      async onToolEnvelopeSettled({ messages }) {
        continuations.push([...messages]);
        return { kind: 'ready', messages: [...messages] };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(continuations.length, 1);
    assert.deepEqual(
      continuations[0].slice(-3).map((message) => message.role),
      ['user', 'agent', 'tool'],
    );
    assert.equal(continuations[0].at(-1)?.toolCallId, 'large-call');
    assert.equal(continuations[0].at(-2)?.toolCalls?.[0]?.id, 'large-call');
  });

  it('does not dispatch another Provider request when cancellation wins after continuation returns', async () => {
    const policy = contextPolicy(24_000, { memoryResultCeilingBytes: 64 * 1024 });
    const controller = new AbortController();
    const allowances: ToolResultAllowance[] = [];
    const tool = createBudgetAwareTool('read_large_page', allowances, () => 55_000);
    let providerCalls = 0;
    let continuations = 0;

    const result = await runAgentLoop({
      sessionId: 'continuation-cancellation-wins',
      messages: [baseMessage],
      rawMessages: [baseMessage],
      tools: [tool],
      contextPolicy: policy,
      maxOutputTokens: policy.requestedOutputTokens,
      signal: controller.signal,
      idFactory: sequentialIdFactory('continuation-abort'),
      provider: {
        async generate() {
          providerCalls += 1;
          return providerCalls === 1
            ? { toolCalls: [{ id: 'large-call', name: tool.name, arguments: { page: 1 } }] }
            : { content: 'Must not be requested.' };
        },
      },
      async onToolEnvelopeSettled({ messages }) {
        continuations += 1;
        controller.abort();
        return { kind: 'ready', messages: [...messages] };
      },
    });

    assert.equal(result.reason, 'aborted');
    assert.equal(providerCalls, 1);
    assert.equal(continuations, 1);
    assert.deepEqual(result.rawMessages?.map((message) => message.role), [
      'user', 'agent', 'tool',
    ]);
  });

  it('retains every settled first-turn envelope when compaction replaces the Provider projection', async () => {
    const policy = contextPolicy(24_000, { memoryResultCeilingBytes: 64 * 1024 });
    const tool: AgentTool = {
      name: 'read_page',
      description: 'Read one page.',
      risk: 'read',
      async execute(args) {
        const page = (args as { page: number }).page;
        return { payload: 'x'.repeat(page === 1 ? 55_000 : 20) };
      },
    };
    let providerCalls = 0;
    const rawMessages = [baseMessage];

    const result = await runAgentLoop({
      sessionId: 'raw-transcript-after-projection-replacement',
      messages: [{ id: 'system-1', role: 'system', content: 'Use tools.', createdAt: 0 }, baseMessage],
      rawMessages,
      tools: [tool],
      contextPolicy: policy,
      maxOutputTokens: policy.requestedOutputTokens,
      idFactory: sequentialIdFactory('raw-projection'),
      provider: {
        async generate() {
          providerCalls += 1;
          if (providerCalls === 1) {
            return { toolCalls: [{ id: 'first-call', name: tool.name, arguments: { page: 1 } }] };
          }
          if (providerCalls === 2) {
            return { toolCalls: [{ id: 'second-call', name: tool.name, arguments: { page: 2 } }] };
          }
          return { content: 'Both pages are complete.' };
        },
      },
      async onToolEnvelopeSettled() {
        return {
          kind: 'ready',
          messages: [
            { id: 'replacement-system', role: 'system', content: 'Compacted context.', createdAt: 2 },
            baseMessage,
          ],
        };
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(providerCalls, 3);
    assert.ok(result.rawMessages);
    assert.deepEqual(result.rawMessages.map((message) => message.role), [
      'user', 'agent', 'tool', 'agent', 'tool', 'agent',
    ]);
    assert.deepEqual(
      result.rawMessages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
      ['first-call', 'second-call'],
    );
    assert.equal(result.messages.some((message) => message.toolCallId === 'first-call'), false);
  });

  it('emits content-free context diagnostics without prompt, tool, repository, or secret data', async () => {
    const canaries = [
      'PROMPT_CANARY',
      'owner/private-repository',
      'NOTE_CANARY',
      'CODE_CANARY',
      'sk-secret-canary',
      'github_pat_canary',
      'Authorization: Bearer header-canary',
      'RAW_PROVIDER_ERROR_CANARY',
    ];
    const policy = contextPolicy(16_384);
    const diagnostics: Extract<AgentEvent, { type: 'context_diagnostic' }>[] = [];
    let call = 0;
    await runAgentLoop({
      sessionId: 'diagnostic-session',
      messages: [{
        ...baseMessage,
        content: canaries.join(' '),
      }],
      tools: [{
        name: 'read_private_data',
        description: 'Read bounded data',
        risk: 'read',
        async execute() {
          return { payload: canaries.join(' ') };
        },
      }],
      contextPolicy: policy,
      maxOutputTokens: policy.requestedOutputTokens,
      emit(event) {
        if (event.type === 'context_diagnostic') diagnostics.push(event);
      },
      provider: {
        async generate() {
          call += 1;
          return call === 1
            ? { toolCalls: [{ id: 'diagnostic-call', name: 'read_private_data', arguments: {} }] }
            : { content: 'done' };
        },
      },
    });

    assert.ok(diagnostics.length >= 3);
    const serialized = JSON.stringify(diagnostics);
    for (const canary of canaries) assert.equal(serialized.includes(canary), false);
    const allowedKeys = new Set([
      'type',
      'sessionId',
      'stage',
      'providerWindow',
      'workingWindow',
      'softLimit',
      'hardLimit',
      'capabilitySource',
      'capabilityRevision',
      'policyRevision',
      'inputTokens',
      'deterministicInputTokens',
      'usageAdjustmentTokens',
      'observedPrefixTokens',
      'contextRemainingTokens',
      'toolAllowanceBytes',
      'toolMemoryRemainingBytes',
      'toolProviderResultCeilingBytes',
      'toolBudgetLimitedBy',
      'toolResultBytes',
      'toolResultReduced',
      'action',
      'trigger',
      'category',
    ]);
    for (const diagnostic of diagnostics) {
      assert.deepEqual(
        Object.keys(diagnostic).filter((key) => !allowedKeys.has(key)),
        [],
      );
    }
    assert.deepEqual(new Set(diagnostics.map((event) => event.stage)), new Set([
      'preflight',
      'tool_allowance',
      'post_tool',
    ]));
    const preflight = diagnostics.find((event) => event.stage === 'preflight');
    assert.ok(preflight);
    assert.equal(typeof preflight.deterministicInputTokens, 'number');
    assert.equal(typeof preflight.usageAdjustmentTokens, 'number');
    const allowance = diagnostics.find((event) => event.stage === 'tool_allowance');
    assert.ok(allowance);
    assert.equal(typeof allowance.toolMemoryRemainingBytes, 'number');
    assert.ok(['context', 'memory', 'provider', 'multiple'].includes(
      allowance.toolBudgetLimitedBy ?? '',
    ));
  });

  it('emits a content-free terminal category for Provider context overflow', async () => {
    const diagnostics: Extract<AgentEvent, { type: 'context_diagnostic' }>[] = [];
    const result = await runAgentLoop({
      sessionId: 'provider-overflow-diagnostic',
      messages: [baseMessage],
      tools: [],
      contextPolicy: contextPolicy(32_768),
      emit(event) {
        if (event.type === 'context_diagnostic') diagnostics.push(event);
      },
      provider: {
        async generate() {
          throw new AgentProviderError(
            'context_overflow',
            'RAW_PROVIDER_ERROR_CANARY Authorization: Bearer secret',
            400,
          );
        },
      },
    });

    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'provider_context_overflow');
    const terminal = diagnostics.at(-1);
    assert.equal(terminal?.action, 'terminal');
    assert.equal(terminal?.category, 'provider_context_overflow');
    assert.equal(JSON.stringify(diagnostics).includes('RAW_PROVIDER_ERROR_CANARY'), false);
    assert.equal(JSON.stringify(diagnostics).includes('Bearer secret'), false);
  });

  it('traces one overflow recovery and a precise repeated-overflow terminal', async () => {
    const diagnostics: Extract<AgentEvent, { type: 'context_diagnostic' }>[] = [];
    let continuationCalls = 0;
    const result = await runAgentLoop({
      sessionId: 'provider-overflow-repeated-diagnostic',
      messages: [baseMessage],
      tools: [],
      contextPolicy: contextPolicy(32_768),
      emit(event) {
        if (event.type === 'context_diagnostic') diagnostics.push(event);
      },
      provider: {
        async generate() {
          throw new AgentProviderError(
            'context_overflow',
            'RAW_REPEATED_OVERFLOW_CANARY Authorization: Bearer secret',
            400,
          );
        },
      },
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        return { kind: 'ready', messages: [...continuation.messages] };
      },
    });

    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'provider_context_overflow_repeated');
    assert.equal(continuationCalls, 1);
    assert.deepEqual(
      diagnostics.filter((event) => event.stage === 'compaction').map((event) => ({
        action: event.action,
        trigger: event.trigger,
        category: event.category,
      })),
      [
        {
          action: 'triggered',
          trigger: 'provider_context_overflow',
          category: 'provider_context_overflow',
        },
        {
          action: 'terminal',
          trigger: undefined,
          category: 'provider_context_overflow_repeated',
        },
      ],
    );
    assert.equal(JSON.stringify(diagnostics).includes('RAW_REPEATED_OVERFLOW_CANARY'), false);
    assert.equal(JSON.stringify(diagnostics).includes('Bearer secret'), false);
  });

  it('keeps every admitted seeded-fuzz result projection at or below hardLimit', async () => {
    const fixedCases = [
      { window: 4_096, schemas: 1, calls: 1, character: 'x' },
      { window: 8_192, schemas: 3, calls: 2, character: '界' },
      { window: 16_384, schemas: 4, calls: 3, character: '😀' },
      { window: 32_768, schemas: 6, calls: 4, character: 'e\u0301' },
      { window: 131_072, schemas: 8, calls: 4, character: 'x' },
    ] as const;
    const random = seededRandom(0x5b65_4d32);
    const windows = [4_096, 8_192, 16_384, 32_768, 131_072] as const;
    const characters = ['x', '界', '😀', 'e\u0301'] as const;
    const fuzzCases = Array.from({ length: 32 }, (_, index) => {
      const schemas = 1 + Math.floor(random() * 8);
      return {
        window: windows[Math.floor(random() * windows.length)]!,
        schemas,
        calls: 1 + Math.floor(random() * Math.min(4, schemas)),
        character: characters[Math.floor(random() * characters.length)]!,
        resultBytes: 128 + Math.floor(random() * 2_500),
        memoryCeilingBytes: 8_192 + Math.floor(random() * 56 * 1_024),
        caseId: index,
      };
    });
    const cases = [
      ...fixedCases.map((fixture, index) => ({
        ...fixture,
        resultBytes: 1_500,
        memoryCeilingBytes: 48 * 1_024,
        caseId: 10_000 + index,
      })),
      ...fuzzCases,
    ];

    for (const fixture of cases) {
      const maxOutputTokens = 256;
      const policy = contextPolicy(fixture.window, {
        maxOutputTokens,
        memoryResultCeilingBytes: fixture.memoryCeilingBytes,
      });
      const allowances: ToolResultAllowance[] = [];
      const requests: CapturedRequest[] = [];
      const tools = Array.from({ length: fixture.schemas }, (_, index) =>
        createBudgetAwareTool(
          `property_tool_${fixture.window}_${index}`,
          allowances,
          (allowance) => Math.max(
            MIN_TOOL_RESULT_ENVELOPE_BYTES,
            Math.min(fixture.resultBytes + index * 137, allowance.maxSerializedBytes),
          ),
          fixture.character,
        ));
      let call = 0;
      const result = await runAgentLoop({
        sessionId: `property-${fixture.caseId}-${fixture.window}`,
        messages: [{ ...baseMessage, content: `${baseMessage.content} ${fixture.character}` }],
        tools,
        contextPolicy: policy,
        maxOutputTokens,
        idFactory: sequentialIdFactory(`property-${fixture.caseId}-${fixture.window}`),
        provider: {
          async generate(input): Promise<ModelResponse> {
            requests.push(captureRequest(input));
            call += 1;
            return call === 1
              ? {
                  toolCalls: tools.slice(0, fixture.calls).map((tool, index) => ({
                    id: `property-call-${fixture.caseId}-${fixture.window}-${index}`,
                    name: tool.name,
                    arguments: { page: index + 1 },
                  })),
                }
              : { content: 'Property fixture complete.' };
          },
        },
      });

      assert.equal(
        result.reason,
        'final_answer',
        `seeded case ${fixture.caseId}, window ${fixture.window}`,
      );
      assert.equal(allowances.length, fixture.calls);
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assertProjectionWithinPolicy(request, policy, maxOutputTokens);
      }
      const firstResponseUsage: ModelUsage = {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      };
      const usageAware = estimateContextWithUsage({
        messages: requests[1].messages,
        toolSchemas: requests[1].tools,
        maxOutputTokens,
        latestUsage: {
          usage: firstResponseUsage,
          prefixMessageCount: requests[0].messages.length + 1,
        },
      });
      const deterministic = estimateContext({
        messages: requests[1].messages,
        toolSchemas: requests[1].tools,
        maxOutputTokens,
      });
      assert.ok(usageAware.inputTokens >= deterministic.inputTokens);
      assert.ok(usageAware.inputTokens <= policy.hardLimit);
    }
  });
});
