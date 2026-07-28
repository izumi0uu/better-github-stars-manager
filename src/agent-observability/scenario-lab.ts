import { runAgentLoop, type AgentContextContinuation } from '@/agent-harness/agent-loop';
import type { AgentEvent } from '@/agent-harness/events';
import type { AgentMessage } from '@/agent-harness/messages';
import {
  AgentProviderError,
  MAX_PROVIDER_HISTORY_BYTES,
  MAX_PROVIDER_REQUEST_BYTES,
  type ExactRequestModelProvider,
  type ModelGenerateInput,
  type ModelResponse,
} from '@/agent-harness/provider';
import { resolveContextBudgetProfile } from '@/agent-harness/compaction/budgets';
import type { AgentTool } from '@/agent-harness/tools';
import {
  BGSM_AGENT_MAX_OUTPUT_TOKENS,
  prepareBgsmAgentTurn,
} from '@/bgsm-agent/compaction';
import {
  createOrganizeJobId,
  parseRunId,
} from '@/bgsm-agent/identity';
import type {
  BgsmAgentSessionMessage,
  BgsmAgentTurnInput,
} from '@/bgsm-agent/session';
import { createDevAgentTurnTraceFactory } from './agent-turn-trace';
import { createDevOrganizeJobRunTraceFactory } from './organize-job-trace';
import { DevTraceDB } from './dev-trace-db';
import {
  DEV_TRACE_SCENARIO_IDS,
  type DevTraceScenarioId,
} from './dev-protocol';
import {
  createDevTraceRecorder,
  type DevTraceRecorder,
} from './recorder';

export type DevTraceScenarioInput = Readonly<{
  scenarioId: DevTraceScenarioId;
  controls: Readonly<{
    delayMs: number;
    contextWindow: number;
  }>;
}>;

export type DevTraceScenarioResult = Readonly<{
  scenarioId: DevTraceScenarioId;
  rootOperationIds: readonly string[];
}>;

export type DevTraceScenarioDependencies = Readonly<{
  dev?: boolean;
  db?: DevTraceDB;
  recorder?: DevTraceRecorder;
  now?: () => number;
  monotonicNow?: () => number;
  randomId?: () => string;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}>;

type ScenarioRuntime = Readonly<{
  input: DevTraceScenarioInput;
  recorder: DevTraceRecorder;
  now: () => number;
  randomId: () => string;
  runIdentity: string;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}>;

type ScriptedProviderStep =
  | ModelResponse
  | Error
  | ((signal?: AbortSignal) => ModelResponse | Error | Promise<ModelResponse | Error>);

const TRACE_PROVIDER = Object.freeze({
  providerClass: 'custom' as const,
  protocol: 'chat_completions' as const,
  modelCapabilityRevision: 'scenario-lab-capability-v1',
});

/**
 * Runs only predefined, metadata-only development fixtures. Dependencies stay
 * synthetic so this module cannot reach configured Providers or product data.
 */
export async function runDevTraceScenario(
  input: DevTraceScenarioInput,
  dependencies: DevTraceScenarioDependencies = {},
): Promise<DevTraceScenarioResult> {
  if (!(dependencies.dev ?? __GSM_DEV__)) {
    throw new Error('Scenario Lab is available only in development builds.');
  }
  validateScenarioInput(input);

  const ownsDb = !dependencies.db && !dependencies.recorder;
  const db = dependencies.db ?? (dependencies.recorder ? null : new DevTraceDB());
  const now = dependencies.now ?? Date.now;
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const recorder = dependencies.recorder ?? createDevTraceRecorder({
    db: db!,
    now,
    monotonicNow: dependencies.monotonicNow,
    randomId,
  });
  const runtime: ScenarioRuntime = {
    input,
    recorder,
    now,
    randomId,
    runIdentity: randomId(),
    sleep: dependencies.sleep ?? abortableDelay,
  };

  try {
    const rootOperationId = await runScenario(runtime);
    return Object.freeze({
      scenarioId: input.scenarioId,
      rootOperationIds: Object.freeze([rootOperationId]),
    });
  } finally {
    if (ownsDb) db?.close();
  }
}

async function runScenario(runtime: ScenarioRuntime): Promise<string> {
  switch (runtime.input.scenarioId) {
    case 'small-window-multiple-tools':
      return runSmallWindowMultipleTools(runtime);
    case 'overflow-then-success':
      return runOverflowThenSuccess(runtime);
    case 'malformed-summary-fallback':
      return runMalformedSummaryFallback(runtime);
    case 'cancel-during-compaction':
      return runCancelDuringCompaction(runtime);
    case 'agent-port-disconnect':
      return runAgentPortDisconnect(runtime);
    case 'organize-cross-batch-recovery':
      return runOrganizeCrossBatchRecovery(runtime);
    case 'organize-cancel-during-apply':
      return runOrganizeCancelDuringApply(runtime);
    case 'organize-port-reconnect':
      return runOrganizePortReconnect(runtime);
  }
}

async function runSmallWindowMultipleTools(runtime: ScenarioRuntime): Promise<string> {
  const tool = syntheticReadTool();
  return runAgentScenario(runtime, {
    providerSteps: [
      toolResponse('scenario-tool-1', tool.name, { page: 1 }),
      toolResponse('scenario-tool-2', tool.name, { page: 2 }),
      { content: 'Scenario complete.', finishReason: 'stop' },
    ],
    tools: [tool],
    policySoftLimit: 0,
    onToolEnvelopeSettled: async ({ messages }) => ({
      kind: 'ready',
      messages: [...messages],
    }),
  });
}

async function runOverflowThenSuccess(runtime: ScenarioRuntime): Promise<string> {
  let traceEvent: ((event: AgentEvent) => void) | null = null;
  return runAgentScenario(runtime, {
    providerSteps: [
      new AgentProviderError('context_overflow', 'Synthetic Provider context overflow.', 400),
      { content: 'Scenario recovered.', finishReason: 'stop' },
    ],
    tools: [],
    bindTraceEvent(handler) {
      traceEvent = handler;
    },
    onContextOverflow: async ({ messages }) => {
      traceEvent?.({ type: 'context_compaction_start', sessionId: scenarioSessionId(runtime) });
      traceEvent?.({
        ...contextDiagnostic(runtime),
        action: 'terminal',
        category: 'succeeded',
      });
      traceEvent?.({
        type: 'context_compaction_end',
        sessionId: scenarioSessionId(runtime),
        ok: true,
        summarizedMessageCount: 0,
      });
      return { kind: 'ready', messages: [...messages] };
    },
  });
}

async function runMalformedSummaryFallback(runtime: ScenarioRuntime): Promise<string> {
  const trace = createAgentTrace(runtime);
  const provider = createScriptedProvider(
    [
      { content: 'Malformed summary one.', finishReason: 'stop' },
      { content: 'Malformed summary two.', finishReason: 'stop' },
    ],
    runtime,
  );
  const result = await prepareBgsmAgentTurn({
    turn: compactionTurn(runtime),
    systemPrompt: 'Run the isolated Scenario Lab fixture.',
    provider,
    tools: [],
    profile: { ...scenarioPolicy(runtime), softLimit: 0 },
    maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    emit: (event) => trace.recordAgentEvent(event),
    trace: trace.execution,
    traceProvider: TRACE_PROVIDER,
    now: runtime.now,
  });
  trace.finish(result.kind === 'ready' ? 'completed' : 'failed', result.kind);
  await trace.flush();
  return traceRootOperationId(runtime);
}

async function runCancelDuringCompaction(runtime: ScenarioRuntime): Promise<string> {
  const controller = new AbortController();
  const trace = createAgentTrace(runtime);
  const provider = createScriptedProvider([
    () => {
      controller.abort();
      return new AgentProviderError('caller_abort', 'Synthetic summary cancellation.');
    },
  ], runtime);
  const result = await prepareBgsmAgentTurn({
    turn: compactionTurn(runtime),
    systemPrompt: 'Run the isolated Scenario Lab fixture.',
    provider,
    tools: [],
    profile: { ...scenarioPolicy(runtime), softLimit: 0 },
    maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    signal: controller.signal,
    emit: (event) => trace.recordAgentEvent(event),
    trace: trace.execution,
    traceProvider: TRACE_PROVIDER,
    now: runtime.now,
  });
  trace.recordCancellation('scenario');
  trace.finish(result.kind === 'aborted' ? 'cancelled' : 'failed', result.kind);
  await trace.flush();
  return traceRootOperationId(runtime);
}

async function runAgentPortDisconnect(runtime: ScenarioRuntime): Promise<string> {
  return runAgentScenario(runtime, {
    providerSteps: [{ content: 'Scenario reattached.', finishReason: 'stop' }],
    tools: [],
    beforeRun(trace) {
      trace.recordDelivery({
        connectionEpochId: 'scenario-connection-1',
        deliverySequence: 0,
        deliveryKind: 'live',
      });
      trace.recordDisconnect({
        connectionEpochId: 'scenario-connection-1',
        lastDeliverySequence: 0,
        attemptState: 'active',
      });
      trace.recordDelivery({
        connectionEpochId: 'scenario-connection-2',
        deliverySequence: 1,
        deliveryKind: 'replay',
      });
    },
  });
}

async function runAgentScenario(
  runtime: ScenarioRuntime,
  fixture: Readonly<{
    providerSteps: readonly ScriptedProviderStep[];
    tools: readonly AgentTool[];
    policySoftLimit?: number;
    onToolEnvelopeSettled?: AgentContextContinuation;
    onContextOverflow?: AgentContextContinuation;
    bindTraceEvent?: (handler: (event: AgentEvent) => void) => void;
    beforeRun?: (trace: ReturnType<typeof createAgentTrace>) => void;
  }>,
): Promise<string> {
  const trace = createAgentTrace(runtime);
  const emit = (event: AgentEvent) => trace.recordAgentEvent(event);
  fixture.bindTraceEvent?.(emit);
  fixture.beforeRun?.(trace);
  const userMessage = scenarioUserMessage(runtime);
  const policy = scenarioPolicy(runtime);
  const result = await runAgentLoop({
    sessionId: scenarioSessionId(runtime),
    messages: [userMessage],
    rawMessages: [userMessage],
    provider: createScriptedProvider(fixture.providerSteps, runtime),
    tools: [...fixture.tools],
    contextPolicy: fixture.policySoftLimit === undefined
      ? policy
      : { ...policy, softLimit: fixture.policySoftLimit },
    maxOutputTokens: policy.requestedOutputTokens,
    onToolEnvelopeSettled: fixture.onToolEnvelopeSettled,
    onContextOverflow: fixture.onContextOverflow,
    trace: trace.execution,
    traceProvider: TRACE_PROVIDER,
    emit,
    idFactory: () => `scenario-message:${runtime.randomId()}`,
    now: runtime.now,
  });
  if (result.reason === 'aborted') trace.recordCancellation('scenario');
  trace.finish(
    result.reason === 'final_answer'
      ? 'completed'
      : result.reason === 'aborted' ? 'cancelled' : 'failed',
    result.reason,
  );
  await trace.flush();
  return traceRootOperationId(runtime);
}

async function runOrganizeCrossBatchRecovery(runtime: ScenarioRuntime): Promise<string> {
  await runtime.sleep(runtime.input.controls.delayMs);
  const jobId = createOrganizeJobId(runtime.randomId);
  const rootOperationId = `organize_job:${jobId}`;
  const firstRunId = parseRunId(`run:v1:scenario-${runtime.randomId()}`);
  const restoredRunId = parseRunId(`run:v1:scenario-${runtime.randomId()}`);
  const factory = createDevOrganizeJobRunTraceFactory({ recorder: runtime.recorder });
  const first = factory({
    jobId,
    executionEpochId: 'scenario-organize-epoch-1',
    startedAt: runtime.now(),
  });
  first.recordPreflight('requested', null);
  first.recordPreflight('ready', 6);
  first.recordPreflight('started', 6);
  first.recordGeneration({
    runId: firstRunId,
    generation: 0,
    state: 'frozen',
    cause: 'initial',
    parentRunId: null,
    parentGeneration: null,
    repositoryCount: 6,
  });
  first.recordBatch({
    runId: firstRunId,
    generation: 0,
    batchStart: 0,
    batchEnd: 3,
    repositoryCount: 3,
    localOnlyCount: 1,
    providerCount: 2,
    state: 'provider_completed',
  });
  first.recordDurableState({ revision: 1, source: 'mutation' });
  await first.flush();

  const restored = factory({
    jobId,
    executionEpochId: 'scenario-organize-epoch-2',
    startedAt: runtime.now(),
    resumeExisting: true,
  });
  restored.recordGeneration({
    runId: restoredRunId,
    generation: 1,
    state: 'restored',
    cause: 'restore',
    parentRunId: firstRunId,
    parentGeneration: 0,
    repositoryCount: 6,
  });
  restored.recordDurableState({ revision: 3, source: 'restore' });
  restored.recordBatch({
    runId: restoredRunId,
    generation: 1,
    batchStart: 3,
    batchEnd: 6,
    repositoryCount: 3,
    localOnlyCount: 0,
    providerCount: 3,
    state: 'provider_completed',
  });
  restored.finish('completed', 'cross_batch_recovered');
  await restored.flush();
  return rootOperationId;
}

async function runOrganizeCancelDuringApply(runtime: ScenarioRuntime): Promise<string> {
  await runtime.sleep(runtime.input.controls.delayMs);
  const jobId = createOrganizeJobId(runtime.randomId);
  const runId = parseRunId(`run:v1:scenario-${runtime.randomId()}`);
  const trace = createDevOrganizeJobRunTraceFactory({ recorder: runtime.recorder })({
    jobId,
    executionEpochId: 'scenario-organize-apply-epoch',
    startedAt: runtime.now(),
  });
  trace.recordGeneration({
    runId,
    generation: 0,
    state: 'frozen',
    cause: 'initial',
    parentRunId: null,
    parentGeneration: null,
    repositoryCount: 4,
  });
  trace.recordApply({
    applyId: 'scenario-apply',
    executionId: null,
    revision: 1,
    state: 'sealed',
    total: 4,
    settled: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  });
  trace.recordApply({
    applyId: 'scenario-apply',
    executionId: 'scenario-apply-execution',
    revision: null,
    state: 'attempt_started',
    total: null,
    settled: null,
    changed: null,
    unchanged: null,
    skipped: null,
    failed: null,
  });
  trace.recordApplyChunk({
    applyId: 'scenario-apply',
    executionId: 'scenario-apply-execution',
    chunkSequence: 1,
    state: 'claimed',
    positionStart: 0,
    positionEnd: 2,
    rowCount: 2,
    maxAttemptCount: 1,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    complete: null,
  });
  trace.recordApply({
    applyId: 'scenario-apply',
    executionId: null,
    revision: 2,
    state: 'pause_requested',
    total: 4,
    settled: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  });
  trace.recordApply({
    applyId: 'scenario-apply',
    executionId: null,
    revision: 3,
    state: 'paused',
    total: 4,
    settled: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  });
  trace.recordCancellation('scenario');
  trace.finish('cancelled', 'scenario_cancelled_during_apply');
  await trace.flush();
  return `organize_job:${jobId}`;
}

async function runOrganizePortReconnect(runtime: ScenarioRuntime): Promise<string> {
  await runtime.sleep(runtime.input.controls.delayMs);
  const jobId = createOrganizeJobId(runtime.randomId);
  const runId = parseRunId(`run:v1:scenario-${runtime.randomId()}`);
  const factory = createDevOrganizeJobRunTraceFactory({ recorder: runtime.recorder });
  const initial = factory({
    jobId,
    executionEpochId: 'scenario-organize-port-epoch-1',
    startedAt: runtime.now(),
  });
  initial.recordGeneration({
    runId,
    generation: 0,
    state: 'frozen',
    cause: 'initial',
    parentRunId: null,
    parentGeneration: null,
    repositoryCount: 8,
  });
  initial.recordDurableState({ revision: 4, source: 'mutation' });
  await initial.flush();

  const reconnected = factory({
    jobId,
    executionEpochId: 'scenario-organize-port-epoch-2',
    startedAt: runtime.now(),
    resumeExisting: true,
  });
  reconnected.recordDurableState({ revision: 4, source: 'reconnect' });
  reconnected.recordDurableState({ revision: 6, source: 'reconnect' });
  reconnected.recordReview({
    runId,
    generation: 0,
    revision: 6,
    state: 'page_delivered',
    actionableRepositories: 8,
    selectedRepositories: 8,
    selectedActions: 12,
    rowOffset: 0,
    rowCount: 8,
    nextRowOffset: null,
  });
  reconnected.finish('completed', 'snapshot_reconciled');
  await reconnected.flush();
  return `organize_job:${jobId}`;
}

function createAgentTrace(runtime: ScenarioRuntime) {
  return createDevAgentTurnTraceFactory({
    recorder: runtime.recorder,
    randomId: runtime.randomId,
  })({
    rootOperationId: traceRootOperationId(runtime),
    sessionId: scenarioSessionId(runtime),
    turnAttemptId: scenarioAttemptId(runtime),
    baseRevision: 0,
    executionEpochId: 'scenario-agent-epoch-v1',
    startedAt: runtime.now(),
  });
}

function createScriptedProvider(
  steps: readonly ScriptedProviderStep[],
  runtime: ScenarioRuntime,
): ExactRequestModelProvider {
  let nextStep = 0;
  const inspect: ExactRequestModelProvider['inspectRequest'] = (input) => {
    const historyBytes = utf8Bytes(JSON.stringify(input.messages));
    const requestBytes = historyBytes + utf8Bytes(JSON.stringify({
      tools: input.tools,
      maxOutputTokens: input.maxOutputTokens,
    }));
    return {
      serializedHistoryBytes: historyBytes,
      serializedRequestBytes: requestBytes,
      historyByteLimit: MAX_PROVIDER_HISTORY_BYTES,
      requestByteLimit: MAX_PROVIDER_REQUEST_BYTES,
      accepted: true,
    };
  };
  const prepare: ExactRequestModelProvider['prepare'] = (input) => {
    const step = steps[nextStep] ?? steps.at(-1);
    nextStep += 1;
    if (!step) throw new Error('Scenario Provider script is empty.');
    const inspection = inspect(input);
    return {
      serializedRequestBody: '{"scenario":true}',
      serializedRequestBytes: inspection.serializedRequestBytes,
      inspection,
      async execute(signal) {
        await runtime.sleep(runtime.input.controls.delayMs, signal);
        if (signal?.aborted) throw new AgentProviderError('caller_abort', 'Scenario request was cancelled.');
        const resolved = typeof step === 'function' ? await step(signal) : step;
        if (resolved instanceof Error) throw resolved;
        emitScriptedStream(input, resolved);
        return resolved;
      },
    };
  };
  return {
    inspectRequest: inspect,
    prepare,
    generate(input) {
      return prepare(input).execute(input.signal);
    },
  };
}

function emitScriptedStream(input: Omit<ModelGenerateInput, 'signal'>, response: ModelResponse): void {
  input.onStreamEvent?.({ type: 'response_start' });
  if (response.content) input.onStreamEvent?.({ type: 'text_delta', delta: response.content });
  for (const [index, call] of (response.toolCalls ?? []).entries()) {
    input.onStreamEvent?.({ type: 'tool_call_start', index, id: call.id, name: call.name });
    input.onStreamEvent?.({
      type: 'tool_call_arguments_delta',
      index,
      delta: JSON.stringify(call.arguments),
    });
    input.onStreamEvent?.({ type: 'tool_call_end', index });
  }
  if (response.usage) input.onStreamEvent?.({ type: 'usage', usage: response.usage });
  input.onStreamEvent?.({
    type: 'response_end',
    finishReason: response.finishReason ?? 'unknown',
  });
}

function syntheticReadTool(): AgentTool<{ page: number }, { page: number; itemCount: number }> {
  return {
    name: 'scenario_read_page',
    description: 'Read one synthetic Scenario Lab page.',
    risk: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['page'],
      properties: { page: { type: 'integer', minimum: 1, maximum: 2 } },
    },
    validate(value) {
      if (!value || typeof value !== 'object' || (value as { page?: unknown }).page !== 1 && (value as { page?: unknown }).page !== 2) {
        throw new TypeError('Synthetic page is invalid.');
      }
      return { page: (value as { page: 1 | 2 }).page };
    },
    async execute({ page }) {
      return { page, itemCount: 3 };
    },
  };
}

function toolResponse(id: string, name: string, args: unknown): ModelResponse {
  return {
    toolCalls: [{ id, name, arguments: args }],
    finishReason: 'tool_calls',
    usage: { inputTokens: 64, outputTokens: 16, totalTokens: 80 },
  };
}

function compactionTurn(runtime: ScenarioRuntime): BgsmAgentTurnInput {
  const history = Array.from({ length: 4 }, (_, index) => [
    {
      id: `scenario-history-user-${index}`,
      role: 'user' as const,
      content: `SCENARIO_PRIVATE_PROMPT_CANARY ${'u'.repeat(1_200)}`,
      createdAt: index * 2,
    },
    {
      id: `scenario-history-agent-${index}`,
      role: 'agent' as const,
      content: `SCENARIO_PRIVATE_RESPONSE_CANARY ${'a'.repeat(1_200)}`,
      createdAt: index * 2 + 1,
    },
  ]).flat() satisfies BgsmAgentSessionMessage[];
  return {
    turnAttemptId: scenarioAttemptId(runtime),
    sessionId: scenarioSessionId(runtime),
    baseRevision: 0,
    prompt: 'SCENARIO_PRIVATE_CURRENT_PROMPT_CANARY',
    history,
  };
}

function scenarioUserMessage(runtime: ScenarioRuntime): AgentMessage {
  return {
    id: 'scenario-user-message',
    role: 'user',
    content: 'SCENARIO_PRIVATE_CURRENT_PROMPT_CANARY',
    createdAt: runtime.now(),
  };
}

function contextDiagnostic(runtime: ScenarioRuntime): Extract<AgentEvent, { type: 'context_diagnostic' }> {
  const policy = scenarioPolicy(runtime);
  return {
    type: 'context_diagnostic',
    sessionId: scenarioSessionId(runtime),
    stage: 'compaction',
    providerWindow: policy.providerWindow,
    workingWindow: policy.workingWindow,
    softLimit: policy.softLimit,
    hardLimit: policy.hardLimit,
    capabilitySource: policy.capabilitySource,
    capabilityRevision: policy.capabilityRevision,
    policyRevision: policy.policyRevision,
  };
}

function scenarioPolicy(runtime: ScenarioRuntime) {
  return resolveContextBudgetProfile(runtime.input.controls.contextWindow);
}

function traceRootOperationId(runtime: ScenarioRuntime): string {
  return `agent_turn:${scenarioAttemptId(runtime)}`;
}

function scenarioAttemptId(runtime: ScenarioRuntime): string {
  return `scenario:${runtime.input.scenarioId}:${scenarioRunIdentity(runtime)}`;
}

function scenarioSessionId(runtime: ScenarioRuntime): string {
  return `scenario-session:${runtime.input.scenarioId}:${scenarioRunIdentity(runtime)}`;
}

function scenarioRunIdentity(runtime: ScenarioRuntime): string {
  return runtime.runIdentity;
}

function validateScenarioInput(input: DevTraceScenarioInput): void {
  if (!DEV_TRACE_SCENARIO_IDS.includes(input.scenarioId)) {
    throw new TypeError('Scenario ID is invalid.');
  }
  assertIntegerRange(input.controls.delayMs, 0, 30_000, 'Scenario delayMs');
  assertIntegerRange(input.controls.contextWindow, 4_096, 1_000_000, 'Scenario contextWindow');
}

function assertIntegerRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside the allowed range.`);
  }
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AgentProviderError('caller_abort', 'Scenario request was cancelled.');
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new AgentProviderError('caller_abort', 'Scenario request was cancelled.'));
    };
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
