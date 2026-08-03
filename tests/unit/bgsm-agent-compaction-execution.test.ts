import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  CONTEXT_PROFILE_8192,
  AgentProviderError,
  InvalidCommittedHistoryError,
  MAX_PROVIDER_HISTORY_BYTES,
  SUMMARY_MAX_OUTPUT_TOKENS,
  createOpenAICompatibleProvider,
  estimateContext,
  estimateUtf8Tokens,
  getModels,
  preflightContextRequest,
  resolveContextBudgetProfile,
  resolveContextBudgetPolicy,
  resolveAgentModelContextCapability,
  runAgentLoop,
  toModelMessage,
  trustedAgentModelContextCapability,
  trustedAgentModelContextWindow,
  validateProviderProtocolHistory,
  type AgentMessage,
  type AgentTool,
  type AgentEvent,
  type AgentContentCaptureSink,
  type ModelProvider,
} from '@/agent-harness';
import {
  BGSM_AGENT_ACTIVE_TURN_SUMMARY_PREAMBLE,
  BGSM_AGENT_MAX_OUTPUT_TOKENS,
  BGSM_AGENT_SUMMARY_INSTRUCTION,
  buildBgsmAgentTerminalPayload,
  buildBgsmAgentTurnMessages,
  buildBgsmSummaryMessages,
  compactBgsmAgentCompletedToolEnvelope,
  isValidBgsmSummary,
  prepareBgsmAgentTurn,
  type BgsmAgentActiveProjection,
  type BgsmAgentCompactionCheckpoint,
  type BgsmAgentSessionMessage,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';

function completeTurns(count: number, chars = 1_200): BgsmAgentSessionMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const turn = index + 1;
    return [
      { id: `u-${turn}`, role: 'user' as const, content: `u${turn}:${'x'.repeat(chars)}`, createdAt: turn * 2 },
      { id: `a-${turn}`, role: 'agent' as const, content: `a${turn}:${'y'.repeat(chars)}`, createdAt: turn * 2 + 1 },
    ];
  }).flat();
}

function validSummary(item = 'None'): string {
  return [
    'GOALS:', `- ${item}`,
    'CONSTRAINTS:', '- None',
    'DECISIONS:', '- None',
    'COMPLETED:', '- None',
    'OPEN:', '- None',
    'HISTORICAL_FACTS:', '- Mutable facts are stale.',
  ].join('\n');
}

function nearMaximumValidSummary(): string {
  const prefix = validSummary('');
  const remainingTokens = SUMMARY_MAX_OUTPUT_TOKENS - estimateUtf8Tokens(prefix);
  return validSummary('z'.repeat(remainingTokens * 3));
}

function turn(history: BgsmAgentSessionMessage[], checkpoint?: BgsmAgentCompactionCheckpoint): BgsmAgentTurnInput {
  return {
    turnAttemptId: 'turn-attempt-1',
    sessionId: 'session-1',
    baseRevision: 4,
    prompt: 'Continue with the current request.',
    history,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

function recordingProvider(response: Parameters<typeof Promise.resolve>[0] = { content: validSummary(), finishReason: 'stop' }) {
  const calls: Parameters<ModelProvider['generate']>[0][] = [];
  const provider: ModelProvider = {
    async generate(input) {
      calls.push(input);
      return await Promise.resolve(response as Awaited<ReturnType<ModelProvider['generate']>>);
    },
  };
  return { provider, calls };
}

function inspectingRecordingProvider(
  response: Parameters<typeof Promise.resolve>[0] = {
    content: validSummary(),
    finishReason: 'stop',
  },
) {
  const calls: Parameters<ModelProvider['generate']>[0][] = [];
  const adapter = createOpenAICompatibleProvider({
    provider: 'openai',
    model: 'gpt-5.4',
    apiKey: 'test-key',
    fetchImpl: async () => {
      throw new Error('Byte-planning tests must not dispatch a network request.');
    },
  });
  const provider: ModelProvider = {
    ...adapter,
    prepare(input) {
      const prepared = adapter.prepare(input);
      return {
        ...prepared,
        async execute() {
          calls.push({ ...input });
          return await Promise.resolve(
            response as Awaited<ReturnType<ModelProvider['generate']>>,
          );
        },
      };
    },
    async generate(input) {
      calls.push(input);
      return await Promise.resolve(response as Awaited<ReturnType<ModelProvider['generate']>>);
    },
  };
  return { provider, calls };
}

function completedToolEnvelope(
  input: BgsmAgentTurnInput,
  checkpoint?: BgsmAgentCompactionCheckpoint,
  resultChars = 2_500,
) {
  const messages = buildBgsmAgentTurnMessages({ ...input, checkpoint }, 'fresh');
  const user = messages.at(-1)!;
  const assistant = {
    id: 'active-assistant',
    role: 'agent' as const,
    content: 'Reading the selected repositories.',
    createdAt: 100,
    toolCalls: [{
      id: 'active-call',
      name: 'search_stars',
      arguments: { query: '编译器', page: 1 },
    }],
  };
  const toolResult = {
    id: 'active-result',
    role: 'tool' as const,
    content: JSON.stringify({ ok: true, data: { text: '界'.repeat(resultChars) } }),
    createdAt: 101,
    toolCallId: 'active-call',
    toolName: 'search_stars',
  };
  messages.push(assistant, toolResult);
  return { messages, suffix: [user, assistant, toolResult] };
}

const completedEnvelopeTools = [{
  name: 'search_stars',
  description: 'Search current stars',
  risk: 'read' as const,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      page: { type: 'number' },
    },
  },
  async execute() {},
}];

describe('BGSM Agent compaction execution', () => {
  it('uses versioned built-in capability and requires explicit capacity for unknown routes', () => {
    const openaiModels = new Map(
      getModels('openai').map((definition) => [definition.id, definition]),
    );
    const openrouterModels = new Map(
      getModels('openrouter').map((definition) => [definition.id, definition]),
    );
    const anthropicModels = new Map(
      getModels('anthropic').map((definition) => [definition.id, definition]),
    );
    assert.deepEqual(
      ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex']
        .map((id) => [id, openaiModels.get(id)?.contextWindow]),
      [
        ['gpt-5.5', 1050000],
        ['gpt-5.5-pro', 1050000],
        ['gpt-5.4', 1050000],
        ['gpt-5.4-mini', 400000],
        ['gpt-5.3-codex', 400000],
      ],
    );
    assert.deepEqual(
      ['openrouter/auto', 'openai/gpt-5.5', 'openai/gpt-5.4', 'anthropic/claude-sonnet-4.6']
        .map((id) => [id, openrouterModels.get(id)?.contextWindow]),
      [
        ['openrouter/auto', undefined],
        ['openai/gpt-5.5', 1050000],
        ['openai/gpt-5.4', 1050000],
        ['anthropic/claude-sonnet-4.6', 1000000],
      ],
    );
    assert.deepEqual(
      ['gpt-5.5', 'gpt-5.4', 'gpt-4o-mini'].map((id) => [
        id,
        openaiModels.get(id)?.contextCapability?.maxOutputTokens,
        openaiModels.get(id)?.contextCapability?.sourceRevision,
      ]),
      [
        ['gpt-5.5', 128000, 'openai:gpt-5.5:2026-04-23'],
        ['gpt-5.4', 128000, 'openai:gpt-5.4:2026-03-05'],
        ['gpt-4o-mini', 16384, 'openai:gpt-4o-mini:2024-07-18'],
      ],
    );
    assert.deepEqual(
      ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5'].map((id) => [
        id,
        anthropicModels.get(id)?.contextWindow,
        anthropicModels.get(id)?.contextCapability?.maxOutputTokens,
        anthropicModels.get(id)?.contextCapability?.sourceRevision,
      ]),
      [
        ['claude-opus-4-7', 1000000, 128000, 'pi-ai:0.80.10:anthropic'],
        ['claude-sonnet-4-6', 1000000, 128000, 'pi-ai:0.80.10:anthropic'],
        ['claude-sonnet-4-5', 1000000, 64000, 'pi-ai:0.80.10:anthropic'],
      ],
    );
    assert.equal(getModels('custom-openai-compatible')[0]?.contextWindow, 1_050_000);
    assert.equal(getModels('custom-openai-compatible')[0]?.id, 'gpt-5.4');
    assert.equal(trustedAgentModelContextWindow('custom-openai-compatible', 'gpt-5'), 400_000);
    assert.equal(trustedAgentModelContextWindow('custom-openai-compatible', 'openai/gpt-5.5'), 1_050_000);
    assert.equal(trustedAgentModelContextWindow('custom-openai-compatible', 'GPT-5.4'), undefined);
    assert.equal(trustedAgentModelContextWindow('custom-openai-compatible', 'unknown-model'), undefined);
    assert.deepEqual(resolveAgentModelContextCapability({
      provider: 'custom-openai-compatible',
      model: 'gpt-5.4',
      declaredContextWindow: 32_768,
    }), {
      schemaVersion: 1,
      contextWindow: 32_768,
      maxOutputTokens: 32_768,
      source: 'user-declared',
      sourceRevision: 'user-settings:v1',
      capabilityRevision: 'mcc:v1:declared:custom-openai-compatible:gpt-5.4:32768',
    });
    assert.equal(trustedAgentModelContextWindow('openrouter', 'openrouter/auto'), undefined);
    assert.equal(trustedAgentModelContextWindow('openai', 'unknown-model'), undefined);
    assert.equal(trustedAgentModelContextWindow('openai', 'gpt-5-mini'), 400000);
    assert.equal(trustedAgentModelContextWindow('openai', 'gpt-5.4'), 1_050_000);
    const capability = trustedAgentModelContextCapability('openai', 'gpt-5.4');
    assert.ok(capability);
    assert.deepEqual(capability, {
      schemaVersion: 1,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      source: 'builtin-official',
      sourceRevision: 'openai:gpt-5.4:2026-03-05',
      capabilityRevision: 'mcc:v1:gpt-5.4:1050000:128000:openai:gpt-5.4:2026-03-05',
    });
    assert.equal(
      trustedAgentModelContextWindow('openrouter', 'anthropic/claude-sonnet-4'),
      200000,
    );
    assert.throws(() => resolveContextBudgetProfile(
      trustedAgentModelContextWindow('custom-openai-compatible', 'anything'),
    ), /unresolved/u);
    const full = resolveContextBudgetPolicy({ capability, requestedOutputTokens: 1_024 });
    assert.equal(full.providerWindow, 1_050_000);
    assert.equal(full.workingWindow, 1_050_000);
    const capped = resolveContextBudgetPolicy({
      capability,
      requestedOutputTokens: 1_024,
      configuredWorkingWindow: 128_000,
    });
    assert.equal(capped.providerWindow, 1_050_000);
    assert.equal(capped.workingWindow, 128_000);
  });

  it('does not call the summary provider below the soft limit', async () => {
    const { provider, calls } = recordingProvider();
    const result = await prepareBgsmAgentTurn({
      turn: turn(completeTurns(1, 120)),
      systemPrompt: 'fresh app context',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 0);
    if (result.kind === 'ready') assert.equal(result.candidateCheckpoint, undefined);
  });

  it('compacts token-accepted history when its exact Provider projection exceeds the byte limit', async () => {
    const history = completeTurns(1, 270 * 1024);
    const input = turn(history);
    const systemPrompt = 'fresh app context';
    const profile = resolveContextBudgetPolicy({
      capability: trustedAgentModelContextCapability('openai', 'gpt-5.4')!,
      requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    const tools: AgentTool[] = [];
    const projected = buildBgsmAgentTurnMessages(input, systemPrompt).map(toModelMessage);
    const { provider, calls } = inspectingRecordingProvider();
    const estimate = estimateContext({
      messages: projected,
      toolSchemas: [],
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    const inspection = provider.inspectRequest?.({
      messages: projected,
      tools: [],
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.ok(estimate.inputTokens < profile.softLimit);
    assert.equal(inspection?.accepted, false);
    assert.equal(inspection?.failure, 'provider_history_too_large');
    assert.ok((inspection?.serializedHistoryBytes ?? 0) > MAX_PROVIDER_HISTORY_BYTES);

    const result = await prepareBgsmAgentTurn({
      turn: input,
      systemPrompt,
      provider,
      tools,
      profile,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 0);
    if (result.kind !== 'ready') return;
    assert.equal(result.candidateCheckpoint?.summarizedMessageCount, history.length);
    const finalInspection = provider.inspectRequest?.({
      messages: result.messages.map(toModelMessage),
      tools: [],
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    assert.equal(finalInspection?.accepted, true);
  });

  it('uses prepare as byte admission when a provider has no inspector', async () => {
    const history = completeTurns(1, 270 * 1024);
    const input = turn(history);
    const systemPrompt = 'fresh app context';
    const profile = resolveContextBudgetPolicy({
      capability: trustedAgentModelContextCapability('openai', 'gpt-5.4')!,
      requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    const exact = inspectingRecordingProvider();
    const provider: ModelProvider = {
      generate: exact.provider.generate,
      prepare: exact.provider.prepare,
    };
    const initialProjection = buildBgsmAgentTurnMessages(input, systemPrompt).map(toModelMessage);
    assert.throws(() => provider.prepare?.({
      messages: initialProjection,
      tools: [],
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    }), (error: unknown) => (
      error instanceof AgentProviderError && error.code === 'provider_history_too_large'
    ));

    const result = await prepareBgsmAgentTurn({
      turn: input,
      systemPrompt,
      provider,
      tools: [],
      profile,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(exact.calls.length, 0);
    if (result.kind !== 'ready') return;
    assert.doesNotThrow(() => provider.prepare?.({
      messages: result.messages.map(toModelMessage),
      tools: [],
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    }));
  });

  it('compacts token-over-limit history even when its exact Provider bytes fit', async () => {
    const history = completeTurns(4, 1_200);
    const input = turn(history);
    const systemPrompt = 'fresh app context';
    const projected = buildBgsmAgentTurnMessages(input, systemPrompt).map(toModelMessage);
    const { provider, calls } = inspectingRecordingProvider();
    const estimate = estimateContext({
      messages: projected,
      toolSchemas: [],
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    const inspection = provider.inspectRequest?.({
      messages: projected,
      tools: [],
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.ok(estimate.inputTokens >= CONTEXT_PROFILE_8192.softLimit);
    assert.equal(inspection?.accepted, true);
    const captured: Array<{ kind: string; requestKind: string; content: string }> = [];
    const contentCapture: AgentContentCaptureSink = {
      providerPrompt(identity, messages) {
        captured.push({
          kind: 'prompt',
          requestKind: identity.requestKind,
          content: JSON.stringify(messages),
        });
      },
      providerResponse(identity, response) {
        captured.push({
          kind: 'response',
          requestKind: identity.requestKind,
          content: response.content ?? '',
        });
      },
      toolArguments() {},
      toolResult() {},
      finish() {},
    };

    const result = await prepareBgsmAgentTurn({
      turn: input,
      systemPrompt,
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      contentCapture,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 1);
    assert.deepEqual(captured.map(({ kind, requestKind }) => ({ kind, requestKind })), [
      { kind: 'prompt', requestKind: 'historical_summary' },
      { kind: 'response', requestKind: 'historical_summary' },
    ]);
    assert.match(captured[0]?.content ?? '', /GOALS:/u);
    assert.match(captured[1]?.content ?? '', /HISTORICAL_FACTS:/u);
  });

  it('classifies an indivisible base request byte overflow without summary traffic', async () => {
    const { provider, calls } = inspectingRecordingProvider();
    const result = await prepareBgsmAgentTurn({
      turn: turn([]),
      systemPrompt: 'fresh app context',
      provider,
      tools: [{
        name: 'oversized_tool',
        description: 'x'.repeat(MAX_PROVIDER_HISTORY_BYTES * 2),
        risk: 'read',
        async execute() {},
      }],
      profile: resolveContextBudgetPolicy({
        capability: trustedAgentModelContextCapability('openai', 'gpt-5.4')!,
        requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      }),
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.deepEqual(result, { kind: 'context_limit', reason: 'provider_request_byte_limit' });
    assert.equal(calls.length, 0);
  });

  it('generates an initial no-tool summary from the raw prefix through the selected boundary', async () => {
    const history = completeTurns(4);
    const original = structuredClone(history);
    const { provider, calls } = recordingProvider();
    const result = await prepareBgsmAgentTurn({
      turn: turn(history),
      systemPrompt: 'fresh app context must not enter summary input',
      provider,
      tools: [{ name: 'read', description: 'read', risk: 'read', async execute() {} }],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.maxOutputTokens, 1024);
    assert.deepEqual(calls[0]?.tools, []);
    assert.equal(calls[0]?.messages[0]?.content, BGSM_AGENT_SUMMARY_INSTRUCTION);
    assert.deepEqual(calls[0]?.messages.slice(1), history.slice(0, 6).map(toModelMessage));
    assert.equal(calls[0]?.messages.some((message) => message.content.includes('fresh app context')), false);
    assert.equal(calls[0]?.messages.some((message) => message.content.includes(turn(history).prompt)), false);
    assert.deepEqual(history, original);
    if (result.kind === 'ready') {
      assert.equal(result.candidateCheckpoint?.schemaVersion, 1);
      assert.equal(result.candidateCheckpoint?.summarizedMessageCount, 6);
      assert.equal(result.candidateCheckpoint?.summarizedThroughMessageId, 'a-3');
      assert.equal(result.messages.at(-1)?.content, turn(history).prompt);
    }
  });

  it('summarizes a settled-tool terminal turn after a later turn is committed', async () => {
    const settledToolTerminal: BgsmAgentSessionMessage[] = [
      {
        id: 'settled-user',
        role: 'user',
        content: `Inspect repositories ${'x'.repeat(3_500)}`,
        createdAt: 1,
      },
      {
        id: 'settled-agent',
        role: 'agent',
        content: 'Reading repository metadata.',
        createdAt: 2,
        toolCalls: [{ id: 'settled-call', name: 'search_stars', arguments: { page: 1 } }],
      },
      {
        id: 'settled-result',
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { text: 'y'.repeat(3_500) } }),
        createdAt: 3,
        toolCallId: 'settled-call',
        toolName: 'search_stars',
      },
    ];
    const laterTurn: BgsmAgentSessionMessage[] = [
      { id: 'later-user', role: 'user', content: 'z'.repeat(1_200), createdAt: 4 },
      { id: 'later-agent', role: 'agent', content: 'w'.repeat(1_200), createdAt: 5 },
    ];
    const history = [...settledToolTerminal, ...laterTurn];
    const { provider, calls } = recordingProvider({
      content: validSummary('Settled tool evidence'),
      finishReason: 'stop',
    });

    const result = await prepareBgsmAgentTurn({
      turn: turn(history),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.messages.slice(1), settledToolTerminal.map(toModelMessage));
    if (result.kind !== 'ready') return;
    assert.equal(result.candidateCheckpoint?.summarizedMessageCount, 3);
    assert.equal(result.candidateCheckpoint?.summarizedThroughMessageId, 'settled-result');
    assert.deepEqual(result.messages.slice(2, -1), laterTurn);
  });

  it('incrementally sends the prior summary plus only raw messages after the old cursor', async () => {
    const history = completeTurns(5);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary('Prior goal'),
      summarizedMessageCount: 4,
      summarizedThroughMessageId: 'a-2',
    };
    const { provider, calls } = recordingProvider({ content: validSummary('Updated goal'), finishReason: 'stop' });
    const result = await prepareBgsmAgentTurn({
      turn: turn(history, checkpoint),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls[0]?.messages[1]?.content, checkpoint.summary);
    assert.deepEqual(calls[0]?.messages.slice(2), history.slice(4, 8).map(toModelMessage));
    assert.equal(calls[0]?.messages.some((message) => message.content === history[0]?.content), false);
    if (result.kind === 'ready') {
      assert.equal(result.candidateCheckpoint?.summarizedMessageCount, 8);
      assert.equal(result.candidateCheckpoint?.summarizedThroughMessageId, 'a-4');
      assert.equal(result.messages.some((message) => message.content === history[8]?.content), true);
    }
  });

  it('advances a pre-turn checkpoint while retaining the completed active tool envelope verbatim', async () => {
    const history = completeTurns(5);
    const originalHistory = structuredClone(history);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary('Pre-turn checkpoint'),
      summarizedMessageCount: 8,
      summarizedThroughMessageId: 'a-4',
    };
    const input = turn(history, checkpoint);
    const { messages, suffix } = completedToolEnvelope(input, checkpoint);
    const suffixSnapshot = structuredClone(suffix);
    const { provider, calls } = recordingProvider({
      content: validSummary('Completed-envelope checkpoint'),
      finishReason: 'stop',
    });

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: messages,
      currentCheckpoint: checkpoint,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.messages[1]?.content, checkpoint.summary);
    assert.deepEqual(calls[0]?.messages.slice(2), history.slice(8).map(toModelMessage));
    assert.deepEqual(history, originalHistory);
    if (result.kind === 'ready') {
      assert.equal(result.candidateCheckpoint?.summarizedMessageCount, 10);
      assert.equal(result.candidateCheckpoint?.summarizedThroughMessageId, 'a-5');
      assert.deepEqual(result.messages.slice(-3), suffixSnapshot);
      for (const [index, message] of result.messages.slice(-3).entries()) {
        assert.equal(message, suffix[index]);
      }
      assert.equal(result.messages.at(-1)?.content, suffix[2]?.content);
    }
  });

  it('compacts the active turn first when tool-result memory is under pressure', async () => {
    const history = completeTurns(5);
    const input = turn(history);
    const completed = completedToolEnvelope(input, undefined, 2_000);
    const { provider, calls } = recordingProvider({
      content: validSummary('Paged inventory progress'),
      finishReason: 'stop',
    });

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: completed.messages,
      currentCheckpoint: undefined,
      rawMessages: completed.suffix,
      force: true,
      trigger: 'tool_result_memory_pressure',
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.messages.some((message) => message.content === history[0]?.content), false);
    assert.equal(calls[0]?.messages.some((message) => message.content === input.prompt), false);
    if (result.kind !== 'ready') return;
    assert.equal(result.candidateCheckpoint, undefined);
    assert.equal(result.activeProjection?.currentUserMessageId, completed.suffix[0]?.id);
    assert.equal(result.activeProjection?.summarizedThroughMessageId, completed.suffix[2]?.id);
    assert.equal(result.messages.some((message) => message.content === input.prompt), true);
    assert.equal(result.messages.some((message) => message.content.includes('Active-turn progress summary')), true);
    assert.equal(result.messages.some((message) => message.id === completed.suffix[1]?.id), false);
    assert.doesNotThrow(() => validateProviderProtocolHistory(result.messages.map(toModelMessage)));
  });

  it('allows a memory-only active projection before oversized history is compacted separately', async () => {
    const input = turn(completeTurns(1));
    const completed = completedToolEnvelope(input, undefined, 2_000);
    const oversizedSystemPrompt = `system:${'x'.repeat(40_000)}`;
    completed.messages[0] = { ...completed.messages[0]!, content: oversizedSystemPrompt };
    const { provider } = recordingProvider({
      content: validSummary('Memory-only intermediate projection'),
      finishReason: 'stop',
    });

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: oversizedSystemPrompt,
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: completed.messages,
      currentCheckpoint: undefined,
      rawMessages: completed.suffix,
      force: true,
      trigger: 'tool_result_memory_pressure',
    });

    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.equal(result.activeProjection?.summarizedThroughMessageId, completed.suffix[2]?.id);
    assert.equal(preflightContextRequest({
      messages: result.messages.map(toModelMessage),
      toolSchemas: completedEnvelopeTools,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    }, CONTEXT_PROFILE_8192).accepted, false);
  });

  it('removes enough active envelopes to exit the memory reserve before reducing old history bytes', async () => {
    const history = completeTurns(1, 120);
    const input = turn(history);
    const baseline = buildBgsmAgentTurnMessages(input, 'fresh');
    const currentUser = baseline.at(-1)!;
    const rawMessages: AgentMessage[] = [currentUser];
    for (let index = 1; index <= 3; index += 1) {
      rawMessages.push({
        id: `memory-assistant-${index}`,
        role: 'agent',
        content: `Reading page ${index}.`,
        createdAt: 100 + index * 2,
        toolCalls: [{
          id: `memory-call-${index}`,
          name: 'search_stars',
          arguments: { query: 'agent', page: index },
        }],
      }, {
        id: `memory-result-${index}`,
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { text: 'x'.repeat(3_000) } }),
        createdAt: 101 + index * 2,
        toolCallId: `memory-call-${index}`,
        toolName: 'search_stars',
      });
    }
    const currentProjectedMessages = [...baseline, ...rawMessages.slice(1)];
    const profile = resolveContextBudgetPolicy({
      capability: trustedAgentModelContextCapability('openai', 'gpt-5.4')!,
      requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      memoryResultCeilingBytes: 10_000,
    });
    const calls: Parameters<ModelProvider['generate']>[0][] = [];
    const provider: ModelProvider = {
      inspectRequest(request) {
        const accepted = request.messages[0]?.content === BGSM_AGENT_SUMMARY_INSTRUCTION
          || !request.messages.some((message) => message.content.includes('u1:'));
        return {
          serializedHistoryBytes: accepted ? 100 : 1_001,
          serializedRequestBytes: accepted ? 200 : 2_001,
          historyByteLimit: 1_000,
          requestByteLimit: 2_000,
          accepted,
          ...(!accepted ? { failure: 'provider_history_too_large' as const } : {}),
        };
      },
      async generate(request) {
        calls.push(request);
        return { content: validSummary('All three pages retained'), finishReason: 'stop' };
      },
    };

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages,
      currentCheckpoint: undefined,
      rawMessages,
      force: true,
      trigger: 'tool_result_memory_pressure',
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 1);
    if (result.kind !== 'ready') return;
    assert.equal(result.activeProjection?.summarizedThroughMessageId, 'memory-result-3');
    assert.equal(result.messages.some((message) => message.role === 'tool'), false);
    assert.equal(provider.inspectRequest?.({
      messages: result.messages.map(toModelMessage),
      tools: completedEnvelopeTools,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    }).accepted, false);
  });

  it('returns context_limit without summary traffic when no older legal boundary can advance', async () => {
    const history = completeTurns(2);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary('All prior history'),
      summarizedMessageCount: history.length,
      summarizedThroughMessageId: 'a-2',
    };
    const input = turn(history, checkpoint);
    const { messages } = completedToolEnvelope(input, checkpoint, 6_000);
    const { provider, calls } = recordingProvider();

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: messages,
      currentCheckpoint: checkpoint,
    });

    assert.deepEqual(result, {
      kind: 'context_limit',
      reason: 'current_turn_too_large',
    });
    assert.equal(calls.length, 0);
  });

  it('summarizes an early active envelope while retaining the original prompt and recent suffix', async () => {
    const history = completeTurns(2);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary('All prior history'),
      summarizedMessageCount: history.length,
      summarizedThroughMessageId: 'a-2',
    };
    const input = turn(history, checkpoint);
    const first = completedToolEnvelope(input, checkpoint, 2_000);
    const secondAssistant = {
      id: 'active-assistant-2',
      role: 'agent' as const,
      content: 'Reading one more page.',
      createdAt: 102,
      toolCalls: [{
        id: 'active-call-2',
        name: 'search_stars',
        arguments: { query: '编译器', page: 2 },
      }],
    };
    const secondResult = {
      id: 'active-result-2',
      role: 'tool' as const,
      content: JSON.stringify({ ok: true, data: { text: '界'.repeat(100) } }),
      createdAt: 103,
      toolCallId: 'active-call-2',
      toolName: 'search_stars',
    };
    const currentProjectedMessages = [...first.messages, secondAssistant, secondResult];
    const rawMessages = [...first.suffix, secondAssistant, secondResult];
    const { provider, calls } = recordingProvider({
      content: validSummary('Early active progress'),
      finishReason: 'stop',
    });

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages,
      currentCheckpoint: checkpoint,
      rawMessages,
      force: true,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tools.length, 0);
    assert.equal(calls[0]?.messages.some((message) => message.content === input.prompt), false);
    if (result.kind !== 'ready') return;
    assert.equal(result.activeProjection?.currentUserMessageId, first.suffix[0]?.id);
    assert.equal(result.activeProjection?.summarizedThroughMessageId, first.suffix[2]?.id);
    assert.equal(result.activeProjection?.retainedSuffixFirstMessageId, secondAssistant.id);
    assert.equal(result.activeProjection?.rawMessageCountAtCreation, rawMessages.length);
    assert.equal(result.activeProjection?.rawTailMessageIdAtCreation, secondResult.id);
    assert.equal(result.activeProjection?.capabilityRevision, CONTEXT_PROFILE_8192.capabilityRevision);
    assert.equal(result.activeProjection?.policyRevision, CONTEXT_PROFILE_8192.policyRevision);
    assert.equal(result.messages.some((message) => message.content === input.prompt), true);
    assert.equal(result.messages.some((message) => message.content.includes('Active-turn progress summary')), true);
    assert.deepEqual(result.messages.slice(-2), [secondAssistant, secondResult]);
    assert.equal(result.messages.some((message) => message.id === first.suffix[1]?.id), false);
    assert.deepEqual(result.candidateCheckpoint, checkpoint);
    assert.doesNotThrow(() => validateProviderProtocolHistory(result.messages.map(toModelMessage)));
    const currentUserIndex = result.messages.findIndex(
      (message) => message.role === 'user' && message.content === input.prompt,
    );
    assert.deepEqual(
      result.messages.slice(currentUserIndex).map((message) => message.role),
      ['user', 'user', 'agent', 'tool'],
    );
    assert.equal(result.messages[currentUserIndex]?.content, input.prompt);
    assert.equal(
      result.messages[currentUserIndex + 1]?.content.startsWith(
        BGSM_AGENT_ACTIVE_TURN_SUMMARY_PREAMBLE,
      ),
      true,
    );

    const thirdAssistant = {
      id: 'active-assistant-3',
      role: 'agent' as const,
      content: 'Reading the final page.',
      createdAt: 104,
      toolCalls: [{
        id: 'active-call-3',
        name: 'search_stars',
        arguments: { query: '编译器', page: 3 },
      }],
    };
    const thirdResult = {
      id: 'active-result-3',
      role: 'tool' as const,
      content: JSON.stringify({ ok: true, data: { text: '界'.repeat(80) } }),
      createdAt: 105,
      toolCallId: 'active-call-3',
      toolName: 'search_stars',
    };
    const nextRawMessages = [...rawMessages, thirdAssistant, thirdResult];
    const incrementalProvider = recordingProvider({
      content: validSummary('Updated active progress'),
      finishReason: 'stop',
    });
    const incremental = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider: incrementalProvider.provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: [...result.messages, thirdAssistant, thirdResult],
      currentCheckpoint: checkpoint,
      currentActiveProjection: result.activeProjection,
      rawMessages: nextRawMessages,
      force: true,
    });

    assert.equal(incremental.kind, 'ready');
    assert.equal(incrementalProvider.calls.length, 1);
    assert.equal(
      incrementalProvider.calls[0]?.messages[1]?.content,
      result.activeProjection?.summary,
    );
    assert.equal(
      incrementalProvider.calls[0]?.messages.some((message) => message.content === first.suffix[2]?.content),
      false,
    );
    if (incremental.kind !== 'ready') return;
    assert.equal(incremental.activeProjection?.summarizedThroughMessageId, secondResult.id);
    assert.deepEqual(incremental.messages.slice(-2), [thirdAssistant, thirdResult]);
    assert.doesNotThrow(() => validateProviderProtocolHistory(incremental.messages.map(toModelMessage)));
  });

  it('compacts an active first turn whose exact bytes overflow while tokens remain below soft limit', async () => {
    const input = turn([]);
    const systemPrompt = 'fresh app context';
    const projection = buildBgsmAgentTurnMessages(input, systemPrompt);
    const currentUser = projection.at(-1)!;
    const assistant: AgentMessage = {
      id: 'large-active-assistant',
      role: 'agent',
      content: 'x'.repeat(512 * 1024 + 32 * 1024),
      createdAt: 10,
      toolCalls: [{
        id: 'large-active-call',
        name: 'search_stars',
        arguments: { query: 'agent' },
      }],
    };
    const toolResult: AgentMessage = {
      id: 'large-active-result',
      role: 'tool',
      content: JSON.stringify({ ok: true, data: { count: 1 } }),
      createdAt: 11,
      toolCallId: 'large-active-call',
      toolName: 'search_stars',
    };
    projection.push(assistant, toolResult);
    const rawMessages = [currentUser, assistant, toolResult];
    const profile = resolveContextBudgetPolicy({
      capability: trustedAgentModelContextCapability('openai', 'gpt-5.4')!,
      requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    const { provider, calls } = inspectingRecordingProvider();
    const estimate = estimateContext({
      messages: projection.map(toModelMessage),
      toolSchemas: completedEnvelopeTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        parameters: tool.parameters,
      })),
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    const inspection = provider.inspectRequest?.({
      messages: projection.map(toModelMessage),
      tools: completedEnvelopeTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        parameters: tool.parameters,
      })),
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    assert.ok(estimate.inputTokens < profile.softLimit);
    assert.equal(inspection?.accepted, false);

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt,
      provider,
      tools: completedEnvelopeTools,
      profile,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: projection,
      currentCheckpoint: undefined,
      rawMessages,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 0);
    if (result.kind !== 'ready') return;
    assert.equal(result.activeProjection?.summarizedThroughMessageId, toolResult.id);
    assert.equal(result.messages.some((message) => message.id === assistant.id), false);
    assert.equal(provider.inspectRequest?.({
      messages: result.messages.map(toModelMessage),
      tools: completedEnvelopeTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        parameters: tool.parameters,
      })),
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    }).accepted, true);
  });

  it('continues incremental active compaction after an earlier projection retained no suffix', async () => {
    const input = turn([]);
    const baseline = buildBgsmAgentTurnMessages(input, 'fresh');
    const firstAssistant = {
      id: 'first-all-assistant',
      role: 'agent' as const,
      content: 'Read the first large page.',
      createdAt: 10,
      toolCalls: [{ id: 'first-all-call', name: 'search_stars', arguments: { page: 1 } }],
    };
    const firstResult = {
      id: 'first-all-result',
      role: 'tool' as const,
      content: JSON.stringify({ ok: true, data: { text: 'x'.repeat(6_000) } }),
      createdAt: 11,
      toolCallId: 'first-all-call',
      toolName: 'search_stars',
    };
    const firstRaw = [baseline.at(-1)!, firstAssistant, firstResult];
    const firstProvider = recordingProvider({
      content: validSummary('First large page complete'),
      finishReason: 'stop',
    });
    const first = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider: firstProvider.provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: [...baseline, firstAssistant, firstResult],
      currentCheckpoint: undefined,
      rawMessages: firstRaw,
      force: true,
    });
    assert.equal(first.kind, 'ready');
    if (first.kind !== 'ready') return;
    assert.equal(first.activeProjection?.retainedSuffixFirstMessageId, null);
    assert.deepEqual(first.messages.map((message) => message.role), ['system', 'user', 'user']);

    const secondAssistant = {
      id: 'second-appended-assistant',
      role: 'agent' as const,
      content: 'Read the appended page.',
      createdAt: 12,
      toolCalls: [{ id: 'second-appended-call', name: 'search_stars', arguments: { page: 2 } }],
    };
    const secondResult = {
      id: 'second-appended-result',
      role: 'tool' as const,
      content: JSON.stringify({ ok: true, data: { text: 'done' } }),
      createdAt: 13,
      toolCallId: 'second-appended-call',
      toolName: 'search_stars',
    };
    const secondProvider = recordingProvider({
      content: validSummary('Both pages complete'),
      finishReason: 'stop',
    });
    const second = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider: secondProvider.provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: [...first.messages, secondAssistant, secondResult],
      currentCheckpoint: undefined,
      currentActiveProjection: first.activeProjection,
      rawMessages: [...firstRaw, secondAssistant, secondResult],
      force: true,
    });

    assert.equal(second.kind, 'ready');
    assert.equal(secondProvider.calls.length, 1);
    assert.equal(secondProvider.calls[0]?.messages[1]?.content, first.activeProjection?.summary);
    if (second.kind !== 'ready') return;
    assert.equal(second.activeProjection?.summarizedThroughMessageId, secondResult.id);
    assert.equal(second.activeProjection?.retainedSuffixFirstMessageId, null);
    assert.doesNotThrow(() => validateProviderProtocolHistory(second.messages.map(toModelMessage)));
  });

  it('continues a first turn after splitting completed tool envelopes without historical candidates', async () => {
    const input = turn([]);
    const systemPrompt = 'Use local evidence and preserve the original request.';
    const initialProjection = buildBgsmAgentTurnMessages(input, systemPrompt);
    const originalUser = initialProjection.at(-1)!;
    const firstResultCanary = 'FIRST_PAGE_RESULT_CANARY';
    const secondResultCanary = 'SECOND_PAGE_RESULT_CANARY';
    const tool: AgentTool = {
      ...completedEnvelopeTools[0]!,
      async execute(args) {
        const page = (args as { page: number }).page;
        return {
          page,
          payload: page === 1
            ? firstResultCanary + ':' + '\u754c'.repeat(1_500)
            : secondResultCanary + ':' + '\u754c'.repeat(700),
        };
      },
    };
    const providerCalls: Parameters<ModelProvider['generate']>[0][] = [];
    let mainRequest = 0;
    const provider: ModelProvider = {
      async generate(request) {
        providerCalls.push(request);
        if (request.tools.length === 0) {
          return {
            content: validSummary('The first page was inspected.'),
            finishReason: 'stop',
          };
        }
        mainRequest += 1;
        if (mainRequest <= 2) {
          return {
            toolCalls: [{
              id: 'active-loop-call-' + mainRequest,
              name: tool.name,
              arguments: { query: '\u7f16\u8bd1\u5668', page: mainRequest },
            }],
            finishReason: 'tool_calls',
          };
        }
        return { content: 'Analysis complete.', finishReason: 'stop' };
      },
    };
    const continuationOutcomes: Array<{
      activeProjection?: BgsmAgentActiveProjection;
      messages: AgentMessage[];
    }> = [];
    let activeProjection: BgsmAgentActiveProjection | undefined;
    let nextId = 0;

    const result = await runAgentLoop({
      sessionId: input.sessionId,
      messages: initialProjection,
      rawMessages: [originalUser],
      provider,
      tools: [tool],
      contextPolicy: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      permissions: () => ({ type: 'allow' }),
      idFactory: () => 'active-loop-message-' + ++nextId,
      async onToolEnvelopeSettled({ messages, rawMessages }) {
        assert.ok(rawMessages);
        const compacted = await compactBgsmAgentCompletedToolEnvelope({
          turn: input,
          systemPrompt,
          provider,
          tools: [tool],
          profile: CONTEXT_PROFILE_8192,
          maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
          currentProjectedMessages: [...messages],
          currentCheckpoint: undefined,
          currentActiveProjection: activeProjection,
          rawMessages,
          force: true,
        });
        assert.equal(compacted.kind, 'ready');
        if (compacted.kind !== 'ready') return compacted;
        activeProjection = compacted.activeProjection ?? activeProjection;
        continuationOutcomes.push({
          messages: compacted.messages,
          ...(compacted.activeProjection
            ? { activeProjection: compacted.activeProjection }
            : {}),
        });
        return compacted;
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(mainRequest, 3);
    assert.equal(providerCalls.length, 4);
    assert.equal(continuationOutcomes.length, 1);
    assert.equal(
      continuationOutcomes[0]?.activeProjection?.summarizedThroughMessageId,
      'active-loop-message-2',
    );

    const summaryRequest = providerCalls.find((request) => request.tools.length === 0);
    assert.ok(summaryRequest);
    assert.deepEqual(summaryRequest.messages.map((message) => message.role), [
      'system', 'assistant', 'tool',
    ]);
    assert.equal(summaryRequest.messages.some((message) => message.content === input.prompt), false);
    assert.equal(summaryRequest.messages.some((message) => message.content.includes(firstResultCanary)), true);
    assert.equal(summaryRequest.messages.some((message) => message.content.includes(secondResultCanary)), false);

    const finalRequest = providerCalls.at(-1)!;
    assert.deepEqual(finalRequest.messages.map((message) => message.role), [
      'system', 'user', 'user', 'assistant', 'tool',
    ]);
    assert.equal(finalRequest.messages.filter((message) => message.content === input.prompt).length, 1);
    assert.equal(
      finalRequest.messages.some((message) => message.content.includes('Active-turn progress summary')),
      true,
    );
    assert.equal(finalRequest.messages.some((message) => message.content.includes(firstResultCanary)), false);
    assert.equal(finalRequest.messages.some((message) => message.content.includes(secondResultCanary)), true);
    assert.equal(finalRequest.messages.some((message) => message.role === 'assistant'
      && message.toolCalls?.[0]?.id === 'active-loop-call-1'), false);
    assert.equal(finalRequest.messages.some((message) => message.role === 'assistant'
      && message.toolCalls?.[0]?.id === 'active-loop-call-2'), true);
    assert.doesNotThrow(() => validateProviderProtocolHistory(finalRequest.messages));

    assert.deepEqual(result.rawMessages?.map((message) => message.role), [
      'user', 'agent', 'tool', 'agent', 'tool', 'agent',
    ]);
    assert.deepEqual(
      result.rawMessages?.filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId),
      ['active-loop-call-1', 'active-loop-call-2'],
    );
    assert.equal(
      result.rawMessages?.some((message) => message.content.includes('Active-turn progress summary')),
      false,
    );
    assert.equal(result.messages.some((message) => message.toolCallId === 'active-loop-call-1'), false);
    assert.equal(result.messages.at(-1)?.content, 'Analysis complete.');
  });

  it('falls back, retries an overflow after a tool, and does not replay the tool', async () => {
    const input = turn([]);
    const systemPrompt = 'Use local evidence and preserve the original request.';
    const initialProjection = buildBgsmAgentTurnMessages(input, systemPrompt);
    const originalUser = initialProjection.at(-1)!;
    const events: AgentEvent[] = [];
    let mainRequests = 0;
    let summaryRequests = 0;
    let toolExecutions = 0;
    let activeProjection: BgsmAgentActiveProjection | undefined;
    const tool: AgentTool = {
      ...completedEnvelopeTools[0]!,
      async execute() {
        toolExecutions += 1;
        return { payload: 'local evidence' };
      },
    };
    const provider: ModelProvider = {
      async generate(request) {
        if (request.tools.length === 0) {
          summaryRequests += 1;
          throw new AgentProviderError('network_error', 'Summary provider unavailable.');
        }
        mainRequests += 1;
        if (mainRequests === 1) {
          return {
            toolCalls: [{
              id: 'overflow-tool-call',
              name: tool.name,
              arguments: { query: 'agent', page: 1 },
            }],
            finishReason: 'tool_calls',
          };
        }
        if (mainRequests === 2) {
          throw new AgentProviderError('context_overflow', 'Provider context overflowed.', 400);
        }
        return { content: 'Recovered without replay.', finishReason: 'stop' };
      },
    };

    const result = await runAgentLoop({
      sessionId: input.sessionId,
      messages: initialProjection,
      rawMessages: [originalUser],
      provider,
      tools: [tool],
      contextPolicy: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      permissions: () => ({ type: 'allow' }),
      emit: (event) => events.push(event),
      async onContextOverflow({ messages, rawMessages, trigger }) {
        assert.ok(rawMessages);
        assert.equal(trigger, 'provider_context_overflow');
        const compacted = await compactBgsmAgentCompletedToolEnvelope({
          turn: input,
          systemPrompt,
          provider,
          tools: [tool],
          profile: CONTEXT_PROFILE_8192,
          maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
          currentProjectedMessages: [...messages],
          currentCheckpoint: undefined,
          currentActiveProjection: activeProjection,
          rawMessages,
          force: true,
          trigger,
        });
        if (compacted.kind === 'ready') {
          activeProjection = compacted.activeProjection ?? activeProjection;
        }
        return compacted;
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(mainRequests, 3);
    assert.equal(summaryRequests, 1);
    assert.equal(toolExecutions, 1);
    assert.equal(events.some((event) => event.type === 'agent_error'), false);
    assert.equal(events.filter((event) => (
      event.type === 'context_diagnostic'
      && event.trigger === 'provider_context_overflow'
    )).length, 1);
    assert.deepEqual(result.rawMessages?.map((message) => message.role), [
      'user', 'agent', 'tool', 'agent',
    ]);
    assert.deepEqual(result.messages.map((message) => message.role), [
      'system', 'user', 'user', 'agent',
    ]);
    assert.equal(result.messages.some((message) => message.toolCallId === 'overflow-tool-call'), false);
  });

  it('emits one byte-recovery trigger and does not replay the settled tool', async () => {
    const input = turn([]);
    const systemPrompt = 'Use local evidence and preserve the original request.';
    const initialProjection = buildBgsmAgentTurnMessages(input, systemPrompt);
    const originalUser = initialProjection.at(-1)!;
    const events: AgentEvent[] = [];
    let mainPreparations = 0;
    let summaryRequests = 0;
    let toolExecutions = 0;
    let activeProjection: BgsmAgentActiveProjection | undefined;
    const tool: AgentTool = {
      ...completedEnvelopeTools[0]!,
      async execute() {
        toolExecutions += 1;
        return { payload: 'local evidence' };
      },
    };
    const provider: ModelProvider = {
      inspectRequest() {
        return {
          serializedHistoryBytes: 100,
          serializedRequestBytes: 200,
          historyByteLimit: MAX_PROVIDER_HISTORY_BYTES,
          requestByteLimit: MAX_PROVIDER_HISTORY_BYTES + 256 * 1024,
          accepted: true,
        };
      },
      prepare(request) {
        if (request.tools.length === 0) {
          return {
            serializedRequestBody: '{}',
            serializedRequestBytes: 2,
            async execute() {
              summaryRequests += 1;
              return { content: validSummary('Settled tool evidence'), finishReason: 'stop' };
            },
          };
        }
        mainPreparations += 1;
        if (mainPreparations === 2) {
          throw new AgentProviderError(
            'provider_request_too_large',
            'Provider request exceeded its byte limit.',
          );
        }
        return {
          serializedRequestBody: '{}',
          serializedRequestBytes: 2,
          async execute() {
            return mainPreparations === 1
              ? {
                  toolCalls: [{
                    id: 'byte-recovery-tool-call',
                    name: tool.name,
                    arguments: { query: 'agent', page: 1 },
                  }],
                  finishReason: 'tool_calls',
                }
              : { content: 'Recovered without replay.', finishReason: 'stop' };
          },
        };
      },
      async generate(request) {
        assert.equal(request.tools.length, 0);
        summaryRequests += 1;
        return { content: validSummary('Settled tool evidence'), finishReason: 'stop' };
      },
    };

    const result = await runAgentLoop({
      sessionId: input.sessionId,
      messages: initialProjection,
      rawMessages: [originalUser],
      provider,
      tools: [tool],
      contextPolicy: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      permissions: () => ({ type: 'allow' }),
      emit: (event) => events.push(event),
      async onContextOverflow({ messages, rawMessages, trigger }) {
        assert.ok(rawMessages);
        assert.equal(trigger, 'provider_request_byte_limit');
        const compacted = await compactBgsmAgentCompletedToolEnvelope({
          turn: input,
          systemPrompt,
          provider,
          tools: [tool],
          profile: CONTEXT_PROFILE_8192,
          maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
          currentProjectedMessages: [...messages],
          currentCheckpoint: undefined,
          currentActiveProjection: activeProjection,
          rawMessages,
          force: true,
          trigger,
          emit: (event) => events.push(event),
        });
        if (compacted.kind === 'ready') {
          activeProjection = compacted.activeProjection ?? activeProjection;
        }
        return compacted;
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(mainPreparations, 3);
    assert.equal(summaryRequests, 1);
    assert.equal(toolExecutions, 1);
    assert.equal(events.filter((event) => (
      event.type === 'context_diagnostic'
      && event.trigger === 'provider_request_byte_limit'
    )).length, 1);
    assert.deepEqual(result.rawMessages?.map((message) => message.role), [
      'user', 'agent', 'tool', 'agent',
    ]);
  });

  it('does not retry an unchanged projection when overflow has no legal compaction candidate', async () => {
    const input = turn([]);
    const systemPrompt = 'Use only local evidence.';
    const currentProjectedMessages = buildBgsmAgentTurnMessages(input, systemPrompt);
    const { provider, calls } = recordingProvider();
    const events: AgentEvent[] = [];

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt,
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages,
      currentCheckpoint: undefined,
      rawMessages: [currentProjectedMessages.at(-1)!],
      force: true,
      trigger: 'provider_context_overflow',
      emit: (event) => events.push(event),
    });

    assert.deepEqual(result, {
      kind: 'context_limit',
      reason: 'provider_context_overflow',
    });
    assert.equal(calls.length, 0);
    assert.equal(events.some((event) => (
      event.type === 'context_diagnostic'
      && event.action === 'terminal'
      && event.category === 'provider_context_overflow'
    )), true);
  });

  it('uses deterministic fallback when the summary request itself cannot fit', async () => {
    const { provider, calls } = recordingProvider();
    const result = await prepareBgsmAgentTurn({
      turn: turn(completeTurns(4)),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: {
        ...CONTEXT_PROFILE_8192,
        summaryInputCap: 1,
      },
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 0);
    if (result.kind === 'ready') {
      assert.equal(result.candidateCheckpoint?.summarizedMessageCount, 6);
    }
  });

  it('classifies an irreducible Provider byte limit separately from token pressure', async () => {
    const provider: ModelProvider = {
      inspectRequest() {
        return {
          serializedHistoryBytes: 1_001,
          serializedRequestBytes: 2_001,
          historyByteLimit: 1_000,
          requestByteLimit: 2_000,
          accepted: false,
          failure: 'provider_history_too_large',
        };
      },
      async generate() {
        throw new Error('An irreducible request must not reach the Provider.');
      },
    };

    const result = await prepareBgsmAgentTurn({
      turn: turn([]),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.deepEqual(result, {
      kind: 'context_limit',
      reason: 'provider_request_byte_limit',
    });
  });

  it('returns aborted before inspecting a completed envelope when its signal is already cancelled', async () => {
    const history = completeTurns(2);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary(),
      summarizedMessageCount: 2,
      summarizedThroughMessageId: 'a-1',
    };
    const input = turn(history, checkpoint);
    const { messages } = completedToolEnvelope(input, checkpoint);
    const { provider, calls } = recordingProvider();
    const controller = new AbortController();
    controller.abort();

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: messages,
      currentCheckpoint: checkpoint,
      signal: controller.signal,
    });

    assert.deepEqual(result, { kind: 'aborted' });
    assert.equal(calls.length, 0);
  });

  it('rejects a rebuilt completed-envelope projection that fails final preflight', async () => {
    const history = completeTurns(5);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary('Pre-turn checkpoint'),
      summarizedMessageCount: 8,
      summarizedThroughMessageId: 'a-4',
    };
    const input = turn(history, checkpoint);
    const { messages, suffix } = completedToolEnvelope(input, checkpoint);
    const provider: ModelProvider = {
      async generate() {
        suffix[2]!.content = JSON.stringify({ ok: true, data: { text: 'x'.repeat(30_000) } });
        return { content: validSummary('Updated'), finishReason: 'stop' };
      },
    };

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: messages,
      currentCheckpoint: checkpoint,
    });

    assert.deepEqual(result, {
      kind: 'context_limit',
      reason: 'final_preflight_failed',
    });
  });

  it('repeats deterministic preflight with the accepted actual summary and full tool schemas', async () => {
    const history = completeTurns(4);
    const nearBudgetSummary = nearMaximumValidSummary();
    assert.ok(estimateUtf8Tokens(nearBudgetSummary) <= SUMMARY_MAX_OUTPUT_TOKENS);
    assert.ok(estimateUtf8Tokens(nearBudgetSummary) >= SUMMARY_MAX_OUTPUT_TOKENS - 1);
    const { provider } = recordingProvider({ content: nearBudgetSummary, finishReason: 'stop' });
    const tools = [{
      name: 'search_stars',
      description: 'Search current stars',
      risk: 'read' as const,
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      async execute() {},
    }];
    const result = await prepareBgsmAgentTurn({
      turn: turn(history),
      systemPrompt: 'fresh actual app context',
      provider,
      tools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') {
      const finalInput = {
        messages: result.messages.map(toModelMessage),
        toolSchemas: tools.map(({ execute: _execute, ...tool }) => tool),
        maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      };
      const final = estimateContext(finalInput);
      assert.ok(final.contextDemandTokens <= CONTEXT_PROFILE_8192.hardLimit);
      assert.equal(result.messages[0]?.content, 'fresh actual app context');
      assert.match(result.messages[1]?.content ?? '', /z{100}/);

      assert.equal(preflightContextRequest(finalInput, {
        hardLimit: final.inputTokens,
      }).accepted, true);
      assert.equal(preflightContextRequest(finalInput, {
        hardLimit: final.inputTokens - 1,
      }).accepted, false);
    }
  });

  it('uses one no-tool corrective retry after an invalid summary', async () => {
    const calls: Parameters<ModelProvider['generate']>[0][] = [];
    const provider: ModelProvider = {
      async generate(input) {
        calls.push(input);
        return calls.length === 1
          ? { content: 'free form', finishReason: 'stop' }
          : { content: validSummary('Corrected'), finishReason: 'stop' };
      },
    };
    const result = await prepareBgsmAgentTurn({
      turn: turn(completeTurns(4)),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.tools), [[], []]);
    assert.match(calls[1]?.messages[0]?.content ?? '', /previous summary response was invalid/i);
    if (result.kind === 'ready') {
      assert.equal(result.candidateCheckpoint?.summary, validSummary('Corrected'));
    }
  });

  it('emits content-free trigger, retry, fallback, and terminal diagnostics', async () => {
    const canaries = [
      'PROMPT_DIAGNOSTIC_CANARY',
      'NOTE_DIAGNOSTIC_CANARY',
      'CODE_DIAGNOSTIC_CANARY',
      'sk-diagnostic-secret',
      'github_pat_diagnostic_secret',
      'Authorization: Bearer compaction-header-secret',
      'RAW_PROVIDER_ERROR_COMPACTION_CANARY',
    ];
    const diagnostics: Extract<AgentEvent, { type: 'context_diagnostic' }>[] = [];
    let calls = 0;
    const result = await prepareBgsmAgentTurn({
      turn: {
        ...turn(completeTurns(4)),
        prompt: canaries.join(' '),
      },
      systemPrompt: canaries.join(' '),
      provider: {
        async generate() {
          calls += 1;
          return { content: 'invalid summary', finishReason: 'stop' };
        },
      },
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      emit(event) {
        if (event.type === 'context_diagnostic') diagnostics.push(event);
      },
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls, 2);
    assert.deepEqual(
      diagnostics.map(({ action, trigger, category }) => ({ action, trigger, category })),
      [
        { action: 'triggered', trigger: 'pre_turn_soft_limit', category: undefined },
        { action: 'summary_retry', trigger: undefined, category: 'summary_invalid' },
        { action: 'fallback', trigger: undefined, category: 'summary_invalid' },
        { action: 'terminal', trigger: undefined, category: 'succeeded' },
      ],
    );
    const serialized = JSON.stringify(diagnostics);
    for (const canary of canaries) assert.equal(serialized.includes(canary), false);
    assert.ok(diagnostics.every((event) => event.capabilitySource === 'user-declared'));
  });

  it.each([
    ['empty', () => Promise.resolve({ content: '   ', finishReason: 'stop' })],
    ['malformed', () => Promise.resolve({ content: 'free form', finishReason: 'stop' })],
    ['oversized', () => Promise.resolve({ content: validSummary('x'.repeat(3_200)), finishReason: 'stop' })],
    ['length finish', () => Promise.resolve({ content: validSummary(), finishReason: 'length' })],
    ['tool-call finish', () => Promise.resolve({
      content: validSummary(),
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'summary-call', name: 'forbidden', arguments: {} }],
    })],
    ['refusal', () => Promise.resolve({
      content: validSummary(),
      finishReason: 'stop',
      refusal: 'Cannot summarize.',
    })],
  ])('uses a deterministic fallback after two %s summaries', async (_name, generate) => {
    const calls: Parameters<ModelProvider['generate']>[0][] = [];
    const provider: ModelProvider = {
      generate(input) {
        calls.push(input);
        return generate();
      },
    };
    const history = completeTurns(4);
    const original = structuredClone(history);
    const result = await prepareBgsmAgentTurn({
      turn: turn(history),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    assert.equal(result.kind, 'ready');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.tools), [[], []]);
    assert.deepEqual(history, original);
    if (result.kind === 'ready') {
      assert.ok(result.candidateCheckpoint);
      assert.equal(isValidBgsmSummary(result.candidateCheckpoint.summary), true);
      assert.match(result.candidateCheckpoint.summary, /not authorization/);
    }
  });

  it('advances rather than replaces an existing checkpoint when incremental fallback is used', async () => {
    const history = completeTurns(5);
    const priorGoal = 'PRESERVE_PRIOR_CHECKPOINT_GOAL_7d2f';
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary(priorGoal),
      summarizedMessageCount: 4,
      summarizedThroughMessageId: 'a-2',
    };
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: 'invalid', finishReason: 'stop' };
      },
    };
    const result = await prepareBgsmAgentTurn({
      turn: turn(history, checkpoint),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls, 2);
    if (result.kind === 'ready') {
      assert.ok(result.candidateCheckpoint);
      assert.ok(
        result.candidateCheckpoint.summarizedMessageCount >
          checkpoint.summarizedMessageCount,
      );
      assert.notEqual(
        result.candidateCheckpoint.summarizedThroughMessageId,
        checkpoint.summarizedThroughMessageId,
      );
      assert.equal(result.candidateCheckpoint.summary.includes(history[0]!.content), false);
      assert.equal(result.candidateCheckpoint.summary.includes(priorGoal), true);
      assert.match(result.candidateCheckpoint.summary, /untrusted, not authorization/);
    }
  });

  it('falls back after a provider failure without issuing a corrective retry or exposing tool output', async () => {
    const secret = 'PRIVATE_TOOL_RESULT_6d3a';
    const history: BgsmAgentSessionMessage[] = [
      {
        id: 'u-tool',
        role: 'user',
        content: 'Please inspect this repository and then add tags.',
        createdAt: 1,
      },
      {
        id: 'a-tool-call',
        role: 'agent',
        content: 'I will inspect it.',
        createdAt: 2,
        toolCalls: [{
          id: 'call-secret',
          name: 'read_note',
          arguments: { authorization: 'write-all' },
        }],
      },
      {
        id: 'tool-secret',
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { secret } }),
        createdAt: 3,
        toolCallId: 'call-secret',
        toolName: 'read_note',
      },
      {
        id: 'a-tool-final',
        role: 'agent',
        content: 'Inspection completed.',
        createdAt: 4,
      },
      ...completeTurns(3),
    ];
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        throw new Error('provider unavailable');
      },
    };
    const result = await prepareBgsmAgentTurn({
      turn: turn(history),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.equal(result.kind, 'ready');
    assert.equal(calls, 1);
    if (result.kind === 'ready') {
      const summary = result.candidateCheckpoint?.summary ?? '';
      assert.equal(summary.includes(secret), false);
      assert.equal(summary.includes('write-all'), false);
      assert.match(summary, /does not authorize writes/);
      assert.match(summary, /read tool read_note: completed successfully/);
    }
  });

  it('returns fallback_too_large when even the fixed safe fallback cannot fit', async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: 'invalid', finishReason: 'length' };
      },
    };
    const result = await prepareBgsmAgentTurn({
      turn: turn(completeTurns(4)),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: {
        ...CONTEXT_PROFILE_8192,
        summaryMaxOutputTokens: 16,
      },
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });

    assert.deepEqual(result, { kind: 'context_limit', reason: 'fallback_too_large' });
    assert.equal(calls, 2);
  });

  it('propagates incomplete committed history as an internal protocol error', async () => {
    const history: BgsmAgentSessionMessage[] = [{
      id: 'u-incomplete',
      role: 'user',
      content: 'incomplete',
      createdAt: 1,
    }];
    const { provider, calls } = recordingProvider();

    await assert.rejects(
      prepareBgsmAgentTurn({
        turn: turn(history),
        systemPrompt: 'fresh',
        provider,
        tools: [],
        profile: CONTEXT_PROFILE_8192,
        maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      }),
      InvalidCommittedHistoryError,
    );
    assert.equal(calls.length, 0);
  });

  it('propagates corrupted checkpoint cursors and schemas before provider failure handling', async () => {
    const history = completeTurns(4);
    const { provider, calls } = recordingProvider();
    const corruptedCursor: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary(),
      summarizedMessageCount: 3,
      summarizedThroughMessageId: 'u-2',
    };
    await assert.rejects(
      prepareBgsmAgentTurn({
        turn: turn(history, corruptedCursor),
        systemPrompt: 'fresh',
        provider,
        tools: [],
        profile: CONTEXT_PROFILE_8192,
        maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      }),
      InvalidCommittedHistoryError,
    );

    const corruptedSchema = {
      ...corruptedCursor,
      schemaVersion: 2,
      summarizedMessageCount: 2,
      summarizedThroughMessageId: 'a-1',
    } as unknown as BgsmAgentCompactionCheckpoint;
    await assert.rejects(
      prepareBgsmAgentTurn({
        turn: turn(history, corruptedSchema),
        systemPrompt: 'fresh',
        provider,
        tools: [],
        profile: CONTEXT_PROFILE_8192,
        maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      }),
      /Unsupported BGSM Agent compaction checkpoint schema/,
    );
    assert.equal(calls.length, 0);
  });

  it('rejects an aborted summary and malformed strict summary sections', async () => {
    assert.equal(isValidBgsmSummary(validSummary()), true);
    assert.equal(isValidBgsmSummary(validSummary().replace('OPEN:', 'OPEN QUESTIONS:')), false);
    const controller = new AbortController();
    const provider: ModelProvider = {
      async generate() {
        controller.abort();
        return { content: validSummary(), finishReason: 'stop' };
      },
    };
    const result = await prepareBgsmAgentTurn({
      turn: turn(completeTurns(4)),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    });
    assert.deepEqual(result, { kind: 'aborted' });
  });

  it('builds multiple incremental summary requests without resending earlier raw history', () => {
    const history = completeTurns(6, 20);
    const first = buildBgsmSummaryMessages({ messages: history.slice(0, 4) });
    const second = buildBgsmSummaryMessages({
      previousSummary: validSummary('First'),
      messages: history.slice(4, 8),
    });
    assert.deepEqual(first.slice(1), history.slice(0, 4).map(toModelMessage));
    assert.deepEqual(second.slice(2), history.slice(4, 8).map(toModelMessage));
    assert.equal(second.some((message) => message.content === history[0]?.content), false);
  });

  it('preserves completed raw tool envelopes on a nonfinal terminal result', () => {
    const history = completeTurns(2, 20);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary(),
      summarizedMessageCount: 2,
      summarizedThroughMessageId: 'a-1',
    };
    const rawMessages = [
      { id: 'current-user', role: 'user' as const, content: 'Continue with the current request.', createdAt: 8 },
      {
        id: 'settled-tool-call',
        role: 'agent' as const,
        content: 'I will inspect the selected repositories.',
        createdAt: 9,
        toolCalls: [{ id: 'call-1', name: 'search_stars', arguments: { query: 'tools', page: 1 } }],
      },
      {
        id: 'settled-tool-result',
        role: 'tool' as const,
        content: JSON.stringify({ ok: true, data: { count: 1 } }),
        createdAt: 10,
        toolCallId: 'call-1',
        toolName: 'search_stars',
      },
    ];
    const payload = buildBgsmAgentTerminalPayload(
      { reason: 'provider_error', rawMessages },
      turn(history, checkpoint),
      checkpoint,
    );

    assert.deepEqual(payload, { newMessages: rawMessages, candidateCheckpoint: checkpoint });
  });

  it('commits a structurally valid raw transcript larger than the Provider history ceiling', () => {
    const rawMessages = [
      {
        id: 'large-current-user',
        role: 'user' as const,
        content: 'x'.repeat(270 * 1024),
        createdAt: 1,
      },
      {
        id: 'large-final-answer',
        role: 'agent' as const,
        content: 'y'.repeat(270 * 1024),
        createdAt: 2,
      },
    ];
    assert.ok(new TextEncoder().encode(JSON.stringify(rawMessages)).byteLength > MAX_PROVIDER_HISTORY_BYTES);

    const payload = buildBgsmAgentTerminalPayload(
      { reason: 'final_answer', rawMessages },
      {
        ...turn([]),
        prompt: rawMessages[0].content,
      },
    );

    assert.deepEqual(payload, { newMessages: rawMessages });
  });

  it('does not commit a lone current-user message on an aborted turn', () => {
    const history = completeTurns(1, 20);
    const payload = buildBgsmAgentTerminalPayload(
      {
        reason: 'aborted',
        rawMessages: [{
          id: 'current-user',
          role: 'user',
          content: 'Continue with the current request.',
          createdAt: 9,
        }],
      },
      turn(history),
    );

    assert.deepEqual(payload, { newMessages: [] });
  });



  it('emits low-noise compaction start/end status around summary generation', async () => {
    const history = completeTurns(4);
    const { provider } = recordingProvider();
    const events: Array<{ type: string; ok?: boolean; summarizedMessageCount?: number }> = [];
    const result = await prepareBgsmAgentTurn({
      turn: turn(history),
      systemPrompt: 'fresh app context',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      emit: (event) => {
        if (event.type === 'context_compaction_start' || event.type === 'context_compaction_end') {
          events.push(event);
        }
      },
    });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(events.map((event) => event.type), [
      'context_compaction_start',
      'context_compaction_end',
    ]);
    assert.equal(events[1]?.ok, true);
    assert.equal(events[1]?.summarizedMessageCount, 6);
  });

  it('does not emit compaction status when the soft limit is not reached', async () => {
    const { provider } = recordingProvider();
    const events: string[] = [];
    const result = await prepareBgsmAgentTurn({
      turn: turn(completeTurns(1, 120)),
      systemPrompt: 'fresh app context',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      emit: (event) => {
        if (event.type === 'context_compaction_start' || event.type === 'context_compaction_end') {
          events.push(event.type);
        }
      },
    });
    assert.equal(result.kind, 'ready');
    assert.deepEqual(events, []);
  });

  it('clears an inherited active projection when mid-turn compaction starts from an advanced checkpoint', async () => {
    const projectedTurn: BgsmAgentSessionMessage[] = [
      { id: 'proj-user', role: 'user', content: `p:${'x'.repeat(2_400)}`, createdAt: 1 },
      {
        id: 'proj-assistant',
        role: 'agent',
        content: '',
        createdAt: 2,
        toolCalls: [{ id: 'proj-call', name: 'search_stars', arguments: { query: 'q', page: 1 } }],
      },
      {
        id: 'proj-tool',
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { text: 'y'.repeat(2_400) } }),
        createdAt: 3,
        toolCallId: 'proj-call',
        toolName: 'search_stars',
      },
      { id: 'proj-final', role: 'agent', content: 'Inspection complete.', createdAt: 4 },
    ];
    const tailTurn: BgsmAgentSessionMessage[] = [
      { id: 'tail-user', role: 'user', content: 'And now?', createdAt: 5 },
      { id: 'tail-assistant', role: 'agent', content: 'Ready to continue.', createdAt: 6 },
    ];
    const inheritedProjection: BgsmAgentActiveProjection = {
      schemaVersion: 1,
      currentUserMessageId: 'proj-user',
      summarizedThroughMessageId: 'proj-tool',
      retainedSuffixFirstMessageId: 'proj-final',
      rawMessageCountAtCreation: 4,
      rawTailMessageIdAtCreation: 'proj-final',
      capabilityRevision: 'capability-v1',
      policyRevision: 'policy-v1',
      summary: validSummary('Projected the giant inspection turn'),
    };
    const input: BgsmAgentTurnInput = {
      ...turn([...projectedTurn, ...tailTurn]),
      activeProjections: [inheritedProjection],
    };
    // Pre-turn compaction already advanced the checkpoint past the projected
    // turn and rebuilt the live projection without the inherited projection.
    const advancedCheckpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validSummary('Absorbed the projected turn'),
      summarizedMessageCount: 4,
      summarizedThroughMessageId: 'proj-final',
    };
    const projected = buildBgsmAgentTurnMessages(
      { ...input, checkpoint: advancedCheckpoint, activeProjections: undefined },
      'fresh',
    );
    const envelope = [
      {
        id: 'active-assistant',
        role: 'agent' as const,
        content: 'Reading the selected repositories.',
        createdAt: 100,
        toolCalls: [{ id: 'active-call', name: 'search_stars', arguments: { query: 'q', page: 1 } }],
      },
      {
        id: 'active-result',
        role: 'tool' as const,
        content: JSON.stringify({ ok: true, data: { text: 'z'.repeat(2_500) } }),
        createdAt: 101,
        toolCallId: 'active-call',
        toolName: 'search_stars',
      },
    ];
    const { provider } = recordingProvider();

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: [...projected, ...envelope],
      currentCheckpoint: advancedCheckpoint,
      force: true,
      trigger: 'completed_tool_envelope',
    });

    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.doesNotThrow(() => validateProviderProtocolHistory(result.messages.map(toModelMessage)));
    assert.deepEqual(
      result.messages.slice(-2).map((message) => message.id),
      ['active-assistant', 'active-result'],
    );
  });

  it('clears the inherited projection when a fresh mid-turn checkpoint absorbs the projected turn', async () => {
    const projectedTurn: BgsmAgentSessionMessage[] = [
      { id: 'proj-user', role: 'user', content: `p:${'x'.repeat(2_400)}`, createdAt: 1 },
      {
        id: 'proj-assistant',
        role: 'agent',
        content: '',
        createdAt: 2,
        toolCalls: [{ id: 'proj-call', name: 'search_stars', arguments: { query: 'q', page: 1 } }],
      },
      {
        id: 'proj-tool',
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { text: 'y'.repeat(2_400) } }),
        createdAt: 3,
        toolCallId: 'proj-call',
        toolName: 'search_stars',
      },
      { id: 'proj-final', role: 'agent', content: 'Inspection complete.', createdAt: 4 },
    ];
    const tail = completeTurns(2).map((message) => ({
      ...message,
      id: `tail-${message.id}`,
      createdAt: message.createdAt + 10,
    }));
    const inheritedProjection: BgsmAgentActiveProjection = {
      schemaVersion: 1,
      currentUserMessageId: 'proj-user',
      summarizedThroughMessageId: 'proj-tool',
      retainedSuffixFirstMessageId: 'proj-final',
      rawMessageCountAtCreation: 4,
      rawTailMessageIdAtCreation: 'proj-final',
      capabilityRevision: 'capability-v1',
      policyRevision: 'policy-v1',
      summary: validSummary('Projected the giant inspection turn'),
    };
    const input: BgsmAgentTurnInput = {
      ...turn([...projectedTurn, ...tail]),
      activeProjections: [inheritedProjection],
    };
    // No checkpoint advancement yet: the live projection retains the inherited
    // projection, exactly how the loop entered this attempt.
    const projected = buildBgsmAgentTurnMessages(input, 'fresh');
    const envelope = [
      {
        id: 'active-assistant',
        role: 'agent' as const,
        content: 'Reading the selected repositories.',
        createdAt: 100,
        toolCalls: [{ id: 'active-call', name: 'search_stars', arguments: { query: 'q', page: 1 } }],
      },
      {
        id: 'active-result',
        role: 'tool' as const,
        content: JSON.stringify({ ok: true, data: { text: 'z'.repeat(6_000) } }),
        createdAt: 101,
        toolCallId: 'active-call',
        toolName: 'search_stars',
      },
    ];
    const { provider, calls } = recordingProvider();

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn: input,
      systemPrompt: 'fresh',
      provider,
      tools: completedEnvelopeTools,
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: [...projected, ...envelope],
      currentCheckpoint: input.checkpoint,
      force: true,
      trigger: 'completed_tool_envelope',
    });

    // Vacuity guard: the scenario must actually generate a fresh checkpoint
    // that covers the projected turn; otherwise the regression is not exercised.
    assert.ok(calls.length >= 1);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.ok((result.candidateCheckpoint?.summarizedMessageCount ?? 0) >= 4);
    assert.doesNotThrow(() => validateProviderProtocolHistory(result.messages.map(toModelMessage)));
    assert.deepEqual(
      result.messages.slice(-2).map((message) => message.id),
      ['active-assistant', 'active-result'],
    );
  });

});
