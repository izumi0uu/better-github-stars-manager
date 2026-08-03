import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDevAgentTurnTraceFactory,
  createDevTraceRecorder,
  DevTraceDB,
} from '@/agent-observability';
import {
  AgentProviderError,
  CONTEXT_PROFILE_8192,
  CONTEXT_PROFILE_32768,
  runAgentLoop,
  type AgentExecutionTraceEvent,
  type ExactRequestModelProvider,
  type ModelResponse,
} from '@/agent-harness';
import {
  BGSM_AGENT_MAX_OUTPUT_TOKENS,
  buildBgsmAgentTurnMessages,
  compactBgsmAgentCompletedToolEnvelope,
  prepareBgsmAgentTurn,
  type BgsmAgentCompactionCheckpoint,
  type BgsmAgentSessionMessage,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';

const databases: DevTraceDB[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (db) => {
    db.close();
    await db.delete();
  }));
});

describe('ordinary Agent trace instrumentation', () => {
  it('records causal Provider and tool metadata without retaining observed content', async () => {
    const db = new DevTraceDB(`bgsm-agent-trace-turn-${crypto.randomUUID()}`);
    databases.push(db);
    let wallTime = 100;
    let recorderId = 0;
    let spanId = 0;
    const recorder = createDevTraceRecorder({
      db,
      now: () => ++wallTime,
      monotonicNow: () => wallTime,
      randomId: () => `recorder-${++recorderId}`,
    });
    const trace = createDevAgentTurnTraceFactory({
      recorder,
      randomId: () => `span-${++spanId}`,
    })({
      rootOperationId: 'agent_turn:attempt-1',
      sessionId: 'session-1',
      turnAttemptId: 'attempt-1',
      baseRevision: 0,
      executionEpochId: 'epoch-1',
      startedAt: 99,
    });
    const provider = scriptedProvider();
    const secretPrompt = 'private prompt sk-proj-abcdefghijklmnop';
    const result = await runAgentLoop({
      sessionId: 'session-1',
      messages: [{ id: 'user-1', role: 'user', content: secretPrompt, createdAt: 1 }],
      provider,
      tools: [{
        name: 'inspect_repository',
        description: 'Inspect one repository.',
        risk: 'suggest',
        async execute() {
          return { fullName: 'private-owner/private-repository', note: 'private note' };
        },
      }],
      contextPolicy: { ...CONTEXT_PROFILE_32768, softLimit: 0 },
      onToolEnvelopeSettled: async ({ messages }) => ({
        kind: 'ready',
        messages: [...messages],
      }),
      trace: trace.execution,
      traceProvider: {
        providerClass: 'custom',
        protocol: 'chat_completions',
        modelCapabilityRevision: 'capability-revision-1',
      },
      emit: (event) => trace.recordAgentEvent(event),
      now: () => ++wallTime,
      idFactory: (() => {
        let id = 0;
        return () => `message-${++id}`;
      })(),
    });
    trace.execution.emit({
      kind: 'watchdog_state',
      watchdog: 'stream_idle',
      state: 'expired',
      limitMs: 45_000,
    });
    trace.recordDelivery({
      connectionEpochId: 'connection-1',
      deliverySequence: 7,
      deliveryKind: 'live',
    });
    trace.finish('completed', result.reason);
    await trace.flush();

    expect(result.reason).toBe('final_answer');
    const artifact = await db.readArtifact({
      scope: { kind: 'all_retained', id: null },
      exporterVersion: 'test',
      exportedAt: 500,
      build: {
        versionHash: 'dev-hash',
        extensionVersion: '1.0.8',
        runtime: 'service_worker',
        dev: true,
      },
    });
    const kinds = artifact.events.map((event) => event.kind);
    expect(kinds).toContain('provider_request_prepared');
    expect(kinds).toContain('provider_response_started');
    expect(kinds).toContain('provider_stream_item');
    expect(kinds).toContain('provider_usage');
    expect(kinds).toContain('provider_finished');
    expect(kinds).toContain('tool_queued');
    expect(kinds).toContain('tool_authorized');
    expect(kinds).toContain('tool_started');
    expect(kinds).toContain('tool_result_admitted');
    expect(kinds).toContain('tool_completed');
    expect(kinds).toContain('context_preflight');
    expect(kinds).toContain('continuation_started');
    expect(kinds).toContain('continuation_finished');
    expect(kinds).toContain('watchdog_state');
    expect(kinds).toContain('delivery_state');
    expect(kinds).toContain('root_terminal');

    expect(indexOf(kinds, 'provider_request_prepared'))
      .toBeLessThan(indexOf(kinds, 'provider_response_started'));
    expect(indexOf(kinds, 'provider_finished')).toBeLessThan(indexOf(kinds, 'tool_queued'));
    expect(indexOf(kinds, 'tool_queued')).toBeLessThan(indexOf(kinds, 'tool_authorized'));
    expect(indexOf(kinds, 'tool_authorized')).toBeLessThan(indexOf(kinds, 'tool_started'));
    expect(indexOf(kinds, 'tool_started')).toBeLessThan(indexOf(kinds, 'tool_completed'));

    const providerEvents = artifact.events.filter((event) => event.kind.startsWith('provider_'));
    expect(providerEvents.every((event) => (
      'providerStep' in event.data && 'requestAttempt' in event.data
    ))).toBe(true);
    expect(artifact.events.find((event) => event.kind === 'provider_request_prepared')?.data)
      .toMatchObject({ requestKind: 'turn', providerStep: 0, requestAttempt: 1 });
    expect(artifact.events.find((event) => event.kind === 'context_preflight')?.data)
      .toMatchObject({ requestKind: 'turn', providerStep: 0, requestAttempt: 1 });
    expect(artifact.events.find((event) => event.kind === 'tool_queued')?.data).toMatchObject({
      providerStep: 0,
      toolClass: 'suggest',
      risk: 'suggest',
    });
    expect(artifact.events.find((event) => event.kind === 'continuation_started')?.data)
      .toMatchObject({ providerStep: 0, reason: 'completed_tool_envelope' });
    expect(artifact.events.find((event) => event.kind === 'continuation_finished')?.data)
      .toMatchObject({ providerStep: 0, outcome: 'continued' });
    expect(artifact.events.find((event) => event.kind === 'watchdog_state')?.data)
      .toEqual({ watchdog: 'stream_idle', state: 'expired', limitMs: 45_000 });

    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(secretPrompt);
    expect(serialized).not.toContain('sk-proj-abcdefghijklmnop');
    expect(serialized).not.toContain('private-owner/private-repository');
    expect(serialized).not.toContain('private note');
    expect(serialized).not.toContain('private final response');
    expect(serialized).not.toContain('https://private-relay.example/v1');
    expect(artifact.roots[0]?.terminalState).toBe('completed');
  });

  it('records one bounded reduction episode from compaction lifecycle events', async () => {
    const db = new DevTraceDB(`bgsm-agent-trace-compaction-${crypto.randomUUID()}`);
    databases.push(db);
    const recorder = createDevTraceRecorder({ db });
    const trace = createDevAgentTurnTraceFactory({ recorder })({
      rootOperationId: 'agent_turn:attempt-compaction',
      sessionId: 'session-compaction',
      turnAttemptId: 'attempt-compaction',
      baseRevision: 2,
      executionEpochId: 'epoch-1',
      startedAt: 100,
    });
    const diagnosticBase = {
      type: 'context_diagnostic' as const,
      sessionId: 'session-compaction',
      stage: 'compaction' as const,
      providerWindow: 32_768,
      workingWindow: 32_768,
      softLimit: 20_000,
      hardLimit: 28_000,
      capabilitySource: 'builtin-official' as const,
      capabilityRevision: 'capability-1',
      policyRevision: 'policy-1',
    };
    trace.recordAgentEvent({
      ...diagnosticBase,
      action: 'triggered',
      trigger: 'provider_context_overflow',
    });
    trace.recordAgentEvent({ type: 'context_compaction_start', sessionId: 'session-compaction' });
    trace.recordAgentEvent({
      type: 'context_compaction_end',
      sessionId: 'session-compaction',
      ok: true,
      summarizedMessageCount: 4,
    });
    trace.recordAgentEvent({
      ...diagnosticBase,
      action: 'terminal',
      category: 'succeeded',
    });
    trace.finish('failed', 'provider_context_overflow_repeated');
    await trace.flush();

    const events = await db.events.orderBy('[rootOperationId+sequence]').toArray();
    const started = events.filter((event) => event.kind === 'context_reduction_started');
    const finished = events.filter((event) => event.kind === 'context_reduction_finished');
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(started[0]?.data).toMatchObject({
      providerStep: null,
      episode: 1,
      trigger: 'provider_overflow',
      splitActiveTurn: null,
    });
    expect(finished[0]?.data).toMatchObject({
      providerStep: null,
      episode: 1,
      outcome: 'summary',
      projectedTokens: null,
      projectedBytes: null,
    });
  });

  it('records a pre-turn summary Provider request as a child of its reduction', async () => {
    const fixture = createCompactionTraceFixture('valid-summary');
    const secretPrompt = 'PROMPT_SUMMARY_TRACE_CANARY';
    const secretResponse = 'SUMMARY_RESPONSE_TRACE_CANARY';
    const provider = tracedSummaryProvider([
      {
        content: validCompactionSummary(secretResponse),
        finishReason: 'stop',
        usage: { inputTokens: 1_200, outputTokens: 80, totalTokens: 1_280 },
      },
    ]);

    const result = await prepareBgsmAgentTurn({
      turn: { ...compactionTurn(), prompt: secretPrompt },
      systemPrompt: 'SYSTEM_SUMMARY_TRACE_CANARY',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      trace: fixture.trace.execution,
      traceProvider: {
        providerClass: 'custom',
        protocol: 'chat_completions',
        modelCapabilityRevision: 'summary-capability-1',
      },
      emit: (event) => fixture.trace.recordAgentEvent(event),
      now: fixture.now,
    });
    fixture.trace.finish('completed', result.kind);
    await fixture.trace.flush();

    expect(result.kind).toBe('ready');
    expect(provider.callCount()).toBe(1);
    const artifact = await fixture.artifact();
    const providerEvents = artifact.events.filter((event) => event.kind.startsWith('provider_'));
    expect(providerEvents.map((event) => event.kind)).toEqual([
      'provider_request_prepared',
      'provider_response_started',
      'provider_stream_item',
      'provider_stream_item',
      'provider_stream_item',
      'provider_usage',
      'provider_finished',
    ]);
    const providerData = providerEvents.map((event) => providerTraceData(event));
    expect(providerData.every((data) => (
      data.requestKind === 'historical_summary'
      && data.providerStep === null
      && data.requestAttempt === 1
    ))).toBe(true);
    expect(new Set(providerData.map((data) => data.requestId)).size).toBe(1);

    const reductionSpan = artifact.spans.find((span) => span.spanKind === 'context_reduction');
    const providerSpan = artifact.spans.find((span) => span.spanKind === 'provider_request');
    expect(reductionSpan).toBeDefined();
    expect(providerSpan?.parentSpanId).toBe(reductionSpan?.spanId);

    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(secretPrompt);
    expect(serialized).not.toContain(secretResponse);
    expect(serialized).not.toContain('SYSTEM_SUMMARY_TRACE_CANARY');
    expect(serialized).not.toContain('https://private-summary-provider.example/v1');
    expect(serialized).not.toContain('Bearer private-summary-key');
  });

  it('keeps an invalid summary and its correction in distinct Provider spans', async () => {
    const fixture = createCompactionTraceFixture('corrected-summary');
    const provider = tracedSummaryProvider([
      { content: 'MALFORMED_SUMMARY_TRACE_CANARY', finishReason: 'stop' },
      {
        content: validCompactionSummary('CORRECTED_SUMMARY_TRACE_CANARY'),
        finishReason: 'stop',
        usage: { inputTokens: 1_240, outputTokens: 75, totalTokens: 1_315 },
      },
    ]);

    const result = await prepareTracedCompaction(fixture, provider);
    fixture.trace.finish('completed', result.kind);
    await fixture.trace.flush();

    expect(result.kind).toBe('ready');
    expect(provider.callCount()).toBe(2);
    const artifact = await fixture.artifact();
    const prepared = artifact.events.filter((event) => event.kind === 'provider_request_prepared');
    const preparedData = prepared.map((event) => providerTraceData(event));
    expect(prepared).toHaveLength(2);
    expect(preparedData.map((data) => data.requestAttempt)).toEqual([1, 2]);
    expect(preparedData.map((data) => data.requestKind)).toEqual([
      'historical_summary',
      'historical_summary',
    ]);
    expect(new Set(preparedData.map((data) => data.requestId)).size).toBe(2);

    const reductionSpan = artifact.spans.find((span) => span.spanKind === 'context_reduction');
    const providerSpans = artifact.spans.filter((span) => span.spanKind === 'provider_request');
    expect(providerSpans).toHaveLength(2);
    expect(providerSpans.every((span) => span.parentSpanId === reductionSpan?.spanId)).toBe(true);
    expect(artifact.events.find((event) => event.kind === 'context_reduction_finished')?.data)
      .toMatchObject({ outcome: 'corrected_summary' });

    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain('MALFORMED_SUMMARY_TRACE_CANARY');
    expect(serialized).not.toContain('CORRECTED_SUMMARY_TRACE_CANARY');
  });

  it('classifies a split-turn summary and preserves its Provider step', async () => {
    const fixture = createCompactionTraceFixture('active-turn-summary');
    const history = compactionTurn().history.slice(0, 4);
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: validCompactionSummary('Prior conversation'),
      summarizedMessageCount: history.length,
      summarizedThroughMessageId: history.at(-1)!.id,
    };
    const turn = { ...compactionTurn(), history, checkpoint };
    const baseline = buildBgsmAgentTurnMessages(turn, 'fresh');
    const currentUser = baseline.at(-1)!;
    const firstAssistant = {
      id: 'active-summary-assistant-1',
      role: 'agent' as const,
      content: 'Reading the first local page.',
      createdAt: 20,
      toolCalls: [{ id: 'active-summary-call-1', name: 'search_stars', arguments: { page: 1 } }],
    };
    const firstResult = {
      id: 'active-summary-result-1',
      role: 'tool' as const,
      content: JSON.stringify({ ok: true, data: { text: 'x'.repeat(2_000) } }),
      createdAt: 21,
      toolCallId: 'active-summary-call-1',
      toolName: 'search_stars',
    };
    const secondAssistant = {
      id: 'active-summary-assistant-2',
      role: 'agent' as const,
      content: 'Reading the second local page.',
      createdAt: 22,
      toolCalls: [{ id: 'active-summary-call-2', name: 'search_stars', arguments: { page: 2 } }],
    };
    const secondResult = {
      id: 'active-summary-result-2',
      role: 'tool' as const,
      content: JSON.stringify({ ok: true, data: { count: 2 } }),
      createdAt: 23,
      toolCallId: 'active-summary-call-2',
      toolName: 'search_stars',
    };
    const provider = tracedSummaryProvider([
      { content: validCompactionSummary('ACTIVE_TURN_SUMMARY_CANARY'), finishReason: 'stop' },
    ]);

    const result = await compactBgsmAgentCompletedToolEnvelope({
      turn,
      systemPrompt: 'fresh',
      provider,
      tools: [{
        name: 'search_stars',
        description: 'Search local stars.',
        risk: 'read',
        async execute() {},
      }],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      currentProjectedMessages: [
        ...baseline,
        firstAssistant,
        firstResult,
        secondAssistant,
        secondResult,
      ],
      currentCheckpoint: checkpoint,
      rawMessages: [currentUser, firstAssistant, firstResult, secondAssistant, secondResult],
      force: true,
      trigger: 'completed_tool_envelope',
      providerStep: 4,
      trace: fixture.trace.execution,
      traceProvider: {
        providerClass: 'custom',
        protocol: 'chat_completions',
        modelCapabilityRevision: 'summary-capability-1',
      },
      emit: (event) => fixture.trace.recordAgentEvent(event),
      now: fixture.now,
    });
    fixture.trace.finish('completed', result.kind);
    await fixture.trace.flush();

    expect(result.kind).toBe('ready');
    expect(result.kind === 'ready' && result.activeProjection).toBeDefined();
    const artifact = await fixture.artifact();
    const prepared = artifact.events.find((event) => event.kind === 'provider_request_prepared');
    expect(prepared?.data).toMatchObject({
      requestKind: 'active_turn_summary',
      providerStep: 4,
      requestAttempt: 1,
    });
    const reductionSpan = artifact.spans.find((span) => span.spanKind === 'context_reduction');
    const providerSpan = artifact.spans.find((span) => span.spanKind === 'provider_request');
    expect(providerSpan?.parentSpanId).toBe(reductionSpan?.spanId);
    expect(JSON.stringify(artifact)).not.toContain('ACTIVE_TURN_SUMMARY_CANARY');
  });

  it('records a summary Provider error before deterministic fallback', async () => {
    const fixture = createCompactionTraceFixture('provider-fallback');
    const provider = tracedSummaryProvider([
      new AgentProviderError('network_error', 'RAW_SUMMARY_PROVIDER_ERROR_CANARY'),
    ]);

    const result = await prepareTracedCompaction(fixture, provider);
    fixture.trace.finish('completed', result.kind);
    await fixture.trace.flush();

    expect(result.kind).toBe('ready');
    expect(provider.callCount()).toBe(1);
    const artifact = await fixture.artifact();
    const kinds = artifact.events.map((event) => event.kind);
    expect(indexOf(kinds, 'provider_error'))
      .toBeLessThan(indexOf(kinds, 'context_reduction_finished'));
    expect(artifact.events.find((event) => event.kind === 'provider_error')?.data)
      .toMatchObject({
        requestKind: 'historical_summary',
        providerStep: null,
        requestAttempt: 1,
        code: 'network_error',
      });
    expect(artifact.events.find((event) => event.kind === 'context_reduction_finished')?.data)
      .toMatchObject({ outcome: 'fallback' });
    expect(JSON.stringify(artifact)).not.toContain('RAW_SUMMARY_PROVIDER_ERROR_CANARY');
  });

  it('classifies cancellation during summary as cancelled rather than failed', async () => {
    const fixture = createCompactionTraceFixture('cancelled-summary');
    const controller = new AbortController();
    const provider = tracedSummaryProvider([
      () => {
        controller.abort();
        return new AgentProviderError('caller_abort', 'SUMMARY_ABORT_CANARY');
      },
    ]);

    const result = await prepareTracedCompaction(fixture, provider, controller.signal);
    fixture.trace.finish('cancelled', result.kind);
    await fixture.trace.flush();

    expect(result).toEqual({ kind: 'aborted' });
    const artifact = await fixture.artifact();
    expect(artifact.events.find((event) => event.kind === 'context_reduction_finished')?.data)
      .toMatchObject({ outcome: 'cancelled' });
    expect(artifact.events.filter((event) => (
      event.kind === 'context_reduction_finished'
      && reductionTraceData(event).outcome === 'failed'
    ))).toHaveLength(0);
    expect(artifact.roots[0]?.terminalState).toBe('cancelled');
  });

  it('contains summary trace sink failures without changing compaction calls or result', async () => {
    const provider = tracedSummaryProvider([
      { content: validCompactionSummary(), finishReason: 'stop' },
    ]);
    const result = await prepareBgsmAgentTurn({
      turn: compactionTurn(),
      systemPrompt: 'fresh',
      provider,
      tools: [],
      profile: CONTEXT_PROFILE_8192,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      trace: { emit() { throw new Error('trace sink unavailable'); } },
      traceProvider: {
        providerClass: 'custom',
        protocol: 'chat_completions',
        modelCapabilityRevision: 'summary-capability-1',
      },
    });

    expect(result.kind).toBe('ready');
    expect(provider.callCount()).toBe(1);
  });

  it('retains Provider usage before normalizing a silent overflow', async () => {
    const events: AgentExecutionTraceEvent[] = [];
    const result = await runAgentLoop({
      sessionId: 'session-overflow',
      messages: [{ id: 'user-overflow', role: 'user', content: 'hello', createdAt: 1 }],
      provider: {
        inspectRequest: () => ({
          serializedHistoryBytes: 32,
          serializedRequestBytes: 64,
          historyByteLimit: 512 * 1024,
          requestByteLimit: 768 * 1024,
          accepted: true,
        }),
        async generate() {
          return {
            content: '',
            finishReason: 'stop',
            usage: {
              inputTokens: CONTEXT_PROFILE_32768.providerWindow + 1,
              outputTokens: 0,
              totalTokens: CONTEXT_PROFILE_32768.providerWindow + 1,
            },
          };
        },
      },
      tools: [],
      contextPolicy: CONTEXT_PROFILE_32768,
      trace: { emit: (event) => events.push(event) },
    });

    expect(result).toMatchObject({
      reason: 'context_limit',
      contextFailureReason: 'provider_context_overflow',
    });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'provider_usage',
      'provider_error',
    ]));
    expect(events.findIndex((event) => event.kind === 'provider_usage'))
      .toBeLessThan(events.findIndex((event) => event.kind === 'provider_error'));
  });
});

function scriptedProvider(): ExactRequestModelProvider {
  let call = 0;
  const inspectionFor = (request: number) => ({
    serializedHistoryBytes: 256 + request,
    serializedRequestBytes: 512 + request,
    historyByteLimit: 512 * 1024,
    requestByteLimit: 768 * 1024,
    accepted: true,
  } as const);
  const prepare: ExactRequestModelProvider['prepare'] = (input) => {
    const currentCall = ++call;
    const inspection = inspectionFor(currentCall);
    return {
      serializedRequestBody: '{"redacted":"test fixture"}',
      serializedRequestBytes: inspection.serializedRequestBytes,
      inspection,
      async execute(): Promise<ModelResponse> {
        input.onStreamEvent?.({ type: 'response_start' });
        if (currentCall === 1) {
          input.onStreamEvent?.({
            type: 'tool_call_start',
            index: 0,
            id: 'call-1',
            name: 'inspect_repository',
          });
          input.onStreamEvent?.({
            type: 'tool_call_arguments_delta',
            index: 0,
            delta: '{"fullName":"private-owner/private-repository"}',
          });
          input.onStreamEvent?.({ type: 'tool_call_end', index: 0 });
          input.onStreamEvent?.({
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          });
          input.onStreamEvent?.({ type: 'response_end', finishReason: 'tool_calls' });
          return {
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call-1',
              name: 'inspect_repository',
              arguments: { fullName: 'private-owner/private-repository' },
            }],
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          };
        }
        input.onStreamEvent?.({ type: 'text_delta', delta: 'private final response' });
        input.onStreamEvent?.({ type: 'response_end', finishReason: 'stop' });
        return { content: 'private final response', finishReason: 'stop' };
      },
    };
  };
  return {
    prepare,
    inspectRequest() {
      return inspectionFor(call + 1);
    },
    async generate(input) {
      return prepare(input).execute(input.signal);
    },
  };
}

type SummaryProviderResult =
  | ModelResponse
  | Error
  | (() => ModelResponse | Error);

function tracedSummaryProvider(
  results: readonly SummaryProviderResult[],
): ExactRequestModelProvider & { callCount(): number } {
  let calls = 0;
  const inspection = {
    serializedHistoryBytes: 4_096,
    serializedRequestBytes: 4_512,
    historyByteLimit: 512 * 1024,
    requestByteLimit: 768 * 1024,
    accepted: true,
  } as const;
  const prepare: ExactRequestModelProvider['prepare'] = (input) => {
    const result = results[calls] ?? results.at(-1);
    calls += 1;
    return {
      serializedRequestBody: JSON.stringify({
        endpoint: 'https://private-summary-provider.example/v1',
        authorization: 'Bearer private-summary-key',
      }),
      serializedRequestBytes: inspection.serializedRequestBytes,
      inspection,
      async execute(): Promise<ModelResponse> {
        const resolved = typeof result === 'function' ? result() : result;
        if (resolved instanceof Error) throw resolved;
        input.onStreamEvent?.({ type: 'response_start' });
        if (resolved?.content) {
          input.onStreamEvent?.({ type: 'text_delta', delta: resolved.content });
        }
        if (resolved?.usage) {
          input.onStreamEvent?.({ type: 'usage', usage: resolved.usage });
        }
        input.onStreamEvent?.({
          type: 'response_end',
          finishReason: resolved?.finishReason ?? 'unknown',
        });
        return resolved ?? { finishReason: 'stop' };
      },
    };
  };
  return {
    prepare,
    inspectRequest: () => inspection,
    generate: (input) => prepare(input).execute(input.signal),
    callCount: () => calls,
  };
}

function compactionTurn(): BgsmAgentTurnInput {
  return {
    turnAttemptId: 'summary-turn-attempt',
    sessionId: 'summary-session',
    baseRevision: 4,
    prompt: 'Continue with the current request.',
    history: Array.from({ length: 4 }, (_, index) => {
      const turn = index + 1;
      return [
        {
          id: `summary-user-${turn}`,
          role: 'user' as const,
          content: `user-${turn}:${'x'.repeat(1_200)}`,
          createdAt: turn * 2,
        },
        {
          id: `summary-agent-${turn}`,
          role: 'agent' as const,
          content: `agent-${turn}:${'y'.repeat(1_200)}`,
          createdAt: turn * 2 + 1,
        },
      ];
    }).flat() satisfies BgsmAgentSessionMessage[],
  };
}

function validCompactionSummary(item = 'None'): string {
  return [
    'GOALS:', `- ${item}`,
    'CONSTRAINTS:', '- None',
    'DECISIONS:', '- None',
    'COMPLETED:', '- None',
    'OPEN:', '- None',
    'HISTORICAL_FACTS:', '- Mutable facts are stale.',
  ].join('\n');
}

function createCompactionTraceFixture(name: string) {
  const db = new DevTraceDB(`bgsm-agent-trace-${name}-${crypto.randomUUID()}`);
  databases.push(db);
  let wallTime = 1_000;
  let recorderId = 0;
  let spanId = 0;
  const recorder = createDevTraceRecorder({
    db,
    now: () => ++wallTime,
    monotonicNow: () => wallTime,
    randomId: () => `summary-recorder-${++recorderId}`,
  });
  const trace = createDevAgentTurnTraceFactory({
    recorder,
    randomId: () => `summary-span-${++spanId}`,
  })({
    rootOperationId: `agent_turn:${name}`,
    sessionId: 'summary-session',
    turnAttemptId: `summary-attempt:${name}`,
    baseRevision: 4,
    executionEpochId: 'summary-epoch',
    startedAt: 999,
  });
  return {
    trace,
    now: () => ++wallTime,
    artifact: () => db.readArtifact({
      scope: { kind: 'all_retained' as const, id: null },
      exporterVersion: 'test',
      exportedAt: 2_000,
      build: {
        versionHash: 'dev-hash',
        extensionVersion: '1.0.8',
        runtime: 'service_worker' as const,
        dev: true,
      },
    }),
  };
}

async function prepareTracedCompaction(
  fixture: ReturnType<typeof createCompactionTraceFixture>,
  provider: ExactRequestModelProvider,
  signal?: AbortSignal,
) {
  return prepareBgsmAgentTurn({
    turn: compactionTurn(),
    systemPrompt: 'fresh',
    provider,
    tools: [],
    profile: CONTEXT_PROFILE_8192,
    maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    signal,
    trace: fixture.trace.execution,
    traceProvider: {
      providerClass: 'custom',
      protocol: 'chat_completions',
      modelCapabilityRevision: 'summary-capability-1',
    },
    emit: (event) => fixture.trace.recordAgentEvent(event),
    now: fixture.now,
  });
}

type ProviderTraceData = Readonly<{
  requestId: string;
  requestKind: 'turn' | 'historical_summary' | 'active_turn_summary';
  providerStep: number | null;
  requestAttempt: number;
}>;

function providerTraceData(event: Readonly<{ data: unknown }>): ProviderTraceData {
  return event.data as ProviderTraceData;
}

type ReductionTraceData = Readonly<{
  outcome: string;
}>;

function reductionTraceData(event: Readonly<{ data: unknown }>): ReductionTraceData {
  return event.data as ReductionTraceData;
}

function indexOf(kinds: readonly string[], kind: string): number {
  const index = kinds.indexOf(kind);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}
