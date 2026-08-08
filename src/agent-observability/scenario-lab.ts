import {
  runAgentLoop,
  type AgentContextContinuation,
  type AgentLoopResult,
} from '@/agent-harness/agent-loop';
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import type { AgentEvent } from '@/agent-harness/events';
import type { AgentMessage, ModelMessage } from '@/agent-harness/messages';
import {
  AgentProviderError,
  MAX_PROVIDER_HISTORY_BYTES,
  MAX_PROVIDER_REQUEST_BYTES,
  type ExactRequestModelProvider,
  type ModelGenerateInput,
  type ModelResponse,
} from '@/agent-harness/provider';
import { resolveContextBudgetProfile } from '@/agent-harness/compaction/budgets';
import type {
  AgentRequiredBeforeFinalDirective,
  AgentTool,
  AgentToolResultAdmissionHost,
} from '@/agent-harness/tools';
import {
  BGSM_AGENT_MAX_OUTPUT_TOKENS,
  prepareBgsmAgentTurn,
} from '@/bgsm-agent/compaction';
import {
  agentArtifactCoverageDirectives,
  applyAgentArtifactCoverageEvidence,
  createAgentArtifactCoverage,
  createAgentArtifactCoverageReceipt,
  digestAgentArtifactTouchedChunks,
  type AgentArtifactCoverageEvidence,
  type AgentArtifactCoverageReceipt,
  type AgentArtifactCoverageRecord,
} from '@/bgsm-agent/artifact-coverage';
import {
  createBgsmAgentArtifactContinuationToolRegistry,
} from '@/bgsm-agent/tools';
import {
  createBgsmAgentArtifactEvidenceHandoff,
  createBgsmAgentToolResultExternalizer,
  type BgsmAgentArtifactReadArgs,
  type BgsmAgentArtifactReadResult,
  type BgsmAgentStoredToolResultArtifact,
} from '@/bgsm-agent/tool-result-externalizer';
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
  | ((
    signal: AbortSignal | undefined,
    input: Omit<ModelGenerateInput, 'signal'>,
  ) => ModelResponse | Error | Promise<ModelResponse | Error>);

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
    case 'cubby-artifact-continuation-coverage':
      return runArtifactContinuationCoverageAdmission(runtime);
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

const SCENARIO_ARTIFACT_PAGE_BYTES = 6 * 1024;
const SCENARIO_ARTIFACT_PAGE_COUNT = 12;
const SCENARIO_LARGE_READ_TOOL = 'scenario_large_repository_read';
const SCENARIO_ARTIFACT_FINAL_TEXT = 'Artifact coverage admitted the final answer.';
const SCENARIO_PROVISIONAL_TEXT = 'This provisional answer must never be published.';

type ScenarioStoredArtifact = BgsmAgentStoredToolResultArtifact & Readonly<{
  content: string;
}>;

type ScenarioArtifactRead = Readonly<{
  kind: 'page' | 'offset' | 'search';
  cursor: string | undefined;
  nextCursor: string | null;
  bytes: number;
}>;

async function runArtifactContinuationCoverageAdmission(
  runtime: ScenarioRuntime,
): Promise<string> {
  const trace = createAgentTrace(runtime);
  const userMessage = scenarioUserMessage(runtime);
  const evidenceHandoff = createBgsmAgentArtifactEvidenceHandoff();
  const artifacts = new Map<string, ScenarioStoredArtifact>();
  const admittedCheckpoints: Array<Readonly<{
    record: AgentArtifactCoverageRecord;
    directives: readonly AgentRequiredBeforeFinalDirective[];
    sourceMessageId: string;
  }>> = [];
  const artifactReads: ScenarioArtifactRead[] = [];
  let coverage: AgentArtifactCoverageRecord | null = null;
  let receipt: AgentArtifactCoverageReceipt | null = null;
  let disposedArtifacts = 0;
  let repromptUsed = false;
  let noProgressCount = 0;
  let episodeBoundaryCount = 0;
  let resumeExpectedCursor: string | null | undefined;
  let targetedReadsExercised = false;
  let continuationDiagnosticEpisode = 0;
  let repromptCheckpoint: Readonly<{
    coverageId: string;
    expectedCursor: string | null;
    progressToken: string;
    instruction: string;
    used: true;
  }> | null = null;
  let agentDoneCount = 0;
  const currentCoverage = (): AgentArtifactCoverageRecord | null => coverage;
  const currentReceipt = (): AgentArtifactCoverageReceipt | null => receipt;
  const currentRepromptCheckpoint = (): typeof repromptCheckpoint => repromptCheckpoint;
  const publishedText: string[] = [];

  const admissionHost: AgentToolResultAdmissionHost = createBgsmAgentToolResultExternalizer({
    turnAttemptId: scenarioAttemptId(runtime),
    now: runtime.now,
    evidenceHandoff,
    async artifactStore(input) {
      const artifactSha256 = await sha256Base64Url(input.content);
      const integrityManifestSha256 = await sha256Base64Url(canonicalJson({
        artifactSha256,
        byteLength: utf8Bytes(input.content),
        pageBytes: SCENARIO_ARTIFACT_PAGE_BYTES,
      }));
      const stored: ScenarioStoredArtifact = Object.freeze({
        artifactId: input.artifactId,
        byteLength: utf8Bytes(input.content),
        contentType: input.contentType,
        artifactSha256,
        integrityManifestSha256,
        content: input.content,
      });
      artifacts.set(stored.artifactId, stored);
      return stored;
    },
    async artifactDisposer(input) {
      if (artifacts.delete(input.artifactId)) disposedArtifacts += 1;
    },
    admissionAuthority: {
      async startCoverage(input) {
        if (coverage) throw new TypeError('Scenario admitted duplicate artifact coverage.');
        const started = await createAgentArtifactCoverage({
          artifactId: input.artifact.artifactId,
          sourceToolCallId: input.sourceToolCallId,
          expectedBytes: input.artifact.byteLength,
          artifactSha256: input.artifact.artifactSha256,
          integrityManifestSha256: input.artifact.integrityManifestSha256,
        });
        coverage = started;
        return {
          requiredBeforeFinal: agentArtifactCoverageDirectives([started]),
          admissionToken: { kind: 'coverage_started', coverageId: started.coverageId },
        };
      },
      async admitInspection(input) {
        if (!coverage) throw new TypeError('Scenario artifact inspection has no coverage record.');
        const before = coverage;
        const applied = await applyAgentArtifactCoverageEvidence(coverage, input.evidence);
        coverage = applied.record;
        if (input.accessKind !== 'page' && (
          applied.advanced
          || coverage.progressToken !== before.progressToken
          || coverage.bytesDelivered !== before.bytesDelivered
          || coverage.expectedCursor !== before.expectedCursor
        )) {
          throw new TypeError('Targeted artifact inspection advanced exhaustive coverage.');
        }
        return {
          requiredBeforeFinal: agentArtifactCoverageDirectives([coverage]),
          admissionToken: {
            kind: 'coverage_inspection',
            coverageId: coverage.coverageId,
            progressToken: coverage.progressToken,
          },
        };
      },
      async admitEnvelope(input) {
        const checkpoint = coverage;
        if (!checkpoint) throw new TypeError('Scenario artifact envelope has no coverage record.');
        const expectedEnvelopeKind = admittedCheckpoints.length === 0
          ? 'canonical_source'
          : 'internal_continuation';
        if (
          input.admissionTokens.length !== 1
          || input.envelopeKind !== expectedEnvelopeKind
        ) throw new TypeError('Scenario artifact envelope checkpoint metadata is incomplete.');
        const expectedDirectives = agentArtifactCoverageDirectives([checkpoint]);
        if (canonicalJson(input.requiredBeforeFinal) !== canonicalJson(expectedDirectives)) {
          throw new TypeError('Scenario artifact envelope checkpoint lost directive authority.');
        }
        const sourceMessage = input.canonicalRawMessages.find((message) => (
          message.role === 'tool'
          && message.toolCallId === checkpoint.sourceToolCallId
          && message.opaqueReferences?.includes(checkpoint.artifactId)
        ));
        if (!sourceMessage) {
          throw new TypeError('Scenario artifact checkpoint lost its canonical source association.');
        }
        admittedCheckpoints.push(Object.freeze({
          record: cloneScenarioValue(checkpoint),
          directives: cloneScenarioValue(expectedDirectives),
          sourceMessageId: sourceMessage.id,
        }));
        if (checkpoint.state === 'complete' && !receipt) {
          receipt = createAgentArtifactCoverageReceipt(checkpoint, runtime.now());
        }
      },
    },
  });

  const artifactReader = async (input: Readonly<{
    sessionId: string;
    toolCallId: string;
    arguments: BgsmAgentArtifactReadArgs;
    maxSerializedResultBytes: number;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    result: BgsmAgentArtifactReadResult;
    evidence: AgentArtifactCoverageEvidence;
  }>> => {
    input.signal?.throwIfAborted();
    const stored = artifacts.get(input.arguments.artifactId);
    if (!stored || !coverage) throw new TypeError('Scenario artifact is unavailable.');
    const kind = input.arguments.search
      ? 'search' as const
      : input.arguments.byteOffset !== undefined ? 'offset' as const : 'page' as const;
    if (kind === 'page') {
      if (coverage.bytesDelivered === 0) {
        if (input.arguments.cursor !== undefined) {
          throw new TypeError('Scenario first exhaustive page did not omit cursor.');
        }
      } else if (input.arguments.cursor !== coverage.expectedCursor) {
        throw new TypeError('Scenario did not consume the exact durable cursor.');
      }
      if (resumeExpectedCursor !== undefined) {
        if ((input.arguments.cursor ?? null) !== resumeExpectedCursor) {
          throw new TypeError('Scenario episode resume did not consume the persisted cursor.');
        }
        resumeExpectedCursor = undefined;
      }
    }

    const searchOffset = input.arguments.search
      ? stored.content.indexOf(input.arguments.search.query, input.arguments.search.fromByte)
      : -1;
    const start = kind === 'page'
      ? scenarioCursorOffset(input.arguments.cursor)
      : kind === 'offset'
        ? input.arguments.byteOffset!
        : Math.max(0, searchOffset);
    const contentBytes = new TextEncoder().encode(stored.content);
    const boundedEnd = kind === 'page'
      ? Math.min(contentBytes.byteLength, start + SCENARIO_ARTIFACT_PAGE_BYTES)
      : Math.min(contentBytes.byteLength, start + 256);
    const pageBytes = searchOffset < 0 && kind === 'search'
      ? new Uint8Array()
      : contentBytes.slice(start, boundedEnd);
    const content = new TextDecoder().decode(pageBytes);
    const nextCursor = kind === 'page' && boundedEnd < contentBytes.byteLength
      ? scenarioCursor(boundedEnd)
      : null;
    const result: BgsmAgentArtifactReadResult = Object.freeze({
      artifactId: stored.artifactId,
      content,
      contentType: stored.contentType,
      byteLength: pageBytes.byteLength,
      totalBytes: contentBytes.byteLength,
      nextCursor,
      ...(kind === 'search' ? { matchByteOffset: searchOffset < 0 ? null : searchOffset } : {}),
    });
    const touchedChunks = pageBytes.byteLength === 0
      ? []
      : [Object.freeze({
          index: Math.floor(start / SCENARIO_ARTIFACT_PAGE_BYTES),
          byteLength: pageBytes.byteLength,
          sha256: await sha256Base64Url(content),
        })];
    const evidence: AgentArtifactCoverageEvidence = Object.freeze({
      schemaVersion: 1,
      artifactId: stored.artifactId,
      artifactBytes: contentBytes.byteLength,
      artifactSha256: stored.artifactSha256,
      integrityManifestSha256: stored.integrityManifestSha256,
      readKind: kind,
      cursorSupplied: input.arguments.cursor !== undefined,
      inputCursor: input.arguments.cursor ?? null,
      pageBytes: kind === 'search' ? 0 : pageBytes.byteLength,
      nextCursor,
      touchedChunks: Object.freeze(touchedChunks),
      touchedChunkCount: touchedChunks.length,
      touchedChunkBytes: pageBytes.byteLength,
      touchedChunkDigest: await digestAgentArtifactTouchedChunks(touchedChunks),
      integrityVerified: true,
    });
    artifactReads.push(Object.freeze({
      kind,
      cursor: input.arguments.cursor,
      nextCursor,
      bytes: pageBytes.byteLength,
    }));
    return Object.freeze({ result, evidence });
  };
  const exerciseTargetedReads = async (pending: AgentArtifactCoverageRecord): Promise<void> => {
    if (
      pending.state !== 'pending'
      || pending.bytesDelivered === 0
      || pending.expectedCursor === null
    ) throw new TypeError('Scenario targeted reads require an issued pending coverage cursor.');
    const storedArtifact = artifacts.values().next().value;
    if (!storedArtifact) throw new TypeError('Scenario lost its stored artifact.');
    for (const [toolCallId, args] of [
      ['scenario-targeted-offset', {
        artifactId: storedArtifact.artifactId,
        byteOffset: 32,
      }],
      ['scenario-targeted-search', {
        artifactId: storedArtifact.artifactId,
        search: { query: 'SCENARIO_COVERAGE_NEEDLE', fromByte: 0 },
      }],
    ] as const) {
      const targeted = await artifactReader({
        sessionId: scenarioSessionId(runtime),
        toolCallId,
        arguments: args,
        maxSerializedResultBytes: 8 * 1024,
      });
      const transition = await applyAgentArtifactCoverageEvidence(pending, targeted.evidence);
      if (
        transition.advanced
        || transition.record.progressToken !== pending.progressToken
        || transition.record.expectedCursor !== pending.expectedCursor
        || transition.record.bytesDelivered !== pending.bytesDelivered
      ) throw new TypeError('Scenario targeted read advanced sequential coverage.');
    }
    targetedReadsExercised = true;
  };

  const continuationRegistry = createBgsmAgentArtifactContinuationToolRegistry({
    artifactReader,
    artifactEvidenceHandoff: evidenceHandoff,
    authorize: ({ arguments: args }) => {
      if (
        !coverage
        || coverage.state !== 'pending'
        || args.artifactId !== coverage.artifactId
      ) return false;
      if (args.byteOffset !== undefined || args.search !== undefined) {
        return coverage.bytesDelivered > 0 && coverage.expectedCursor !== null;
      }
      return coverage.bytesDelivered === 0
        ? args.cursor === undefined
        : args.cursor === coverage.expectedCursor;
    },
  });
  const continuationTools = [...continuationRegistry.getActiveTools()];
  const ordinaryTools: AgentTool[] = [
    scenarioLargeArtifactReadTool(),
    ...continuationTools,
  ];

  let providerStage: 'source' | 'first_page' | 'premature' | 'paging' = 'source';
  let providerRequestCount = 0;
  const provider = createScriptedProvider([(_signal, providerInput) => {
    providerRequestCount += 1;
    const latest = latestScenarioToolData(providerInput.messages);
    if (providerStage === 'source') {
      providerStage = 'first_page';
      return toolResponse('scenario-large-source', SCENARIO_LARGE_READ_TOOL, {});
    }
    if (coverage?.state === 'pending' && (
      providerInput.tools.length !== 1
      || providerInput.tools[0]?.name !== 'read_agent_artifact'
    )) throw new TypeError('Scenario continuation exposed a non-reader capability.');
    if (coverage?.state === 'complete' && !providerInput.tools.some((tool) => (
      tool.name === SCENARIO_LARGE_READ_TOOL
    ))) throw new TypeError('Scenario did not restore ordinary tools after coverage completion.');
    if (!latest || typeof latest.artifactId !== 'string') {
      throw new TypeError('Scenario Provider could not recover the issued artifact ID.');
    }
    const trustedInstruction = providerInput.messages.find((message) => (
      message.role === 'system' && message.content.startsWith('Continue artifact ')
    ))?.content ?? null;
    if (coverage?.state === 'pending') {
      const expectedInstructionValue = coverage.expectedCursor ?? 'omitting cursor';
      if (!trustedInstruction?.includes(expectedInstructionValue)) {
        throw new TypeError('Scenario Provider request did not receive the exact durable continuation prompt.');
      }
    } else if (trustedInstruction !== null) {
      throw new TypeError('Scenario retained a continuation prompt after coverage completion.');
    }
    if (providerStage === 'first_page') {
      providerStage = 'premature';
      return toolResponse('scenario-artifact-page-1', 'read_agent_artifact', {
        artifactId: latest.artifactId,
      });
    }
    if (providerStage === 'premature') {
      providerStage = 'paging';
      return { content: SCENARIO_PROVISIONAL_TEXT, finishReason: 'stop' };
    }
    if (latest.nextCursor === null) {
      return { content: SCENARIO_ARTIFACT_FINAL_TEXT, finishReason: 'stop' };
    }
    if (typeof latest.nextCursor !== 'string') {
      throw new TypeError('Scenario Provider did not receive an issued continuation cursor.');
    }
    return toolResponse(
      `scenario-artifact-page-${providerRequestCount}`,
      'read_agent_artifact',
      { artifactId: latest.artifactId, cursor: latest.nextCursor },
    );
  }], runtime);

  const policy = scenarioPolicy(runtime);
  const continuationPolicy = {
    ...resolveContextBudgetProfile(1_000_000),
    softLimit: 0,
  };
  const instructionMessageId = `scenario-continuation-instruction:${scenarioAttemptId(runtime)}`;
  const projectContinuationInstruction = (
    messages: readonly AgentMessage[],
    checkpoint: AgentArtifactCoverageRecord,
  ) => {
    const projected = messages.filter((message) => message.id !== instructionMessageId);
    if (checkpoint.state !== 'pending') return { messages: projected, instruction: null };
    const instruction = checkpoint.expectedCursor === null
      ? `Continue artifact ${checkpoint.artifactId} by omitting cursor on the next exhaustive read.`
      : `Continue artifact ${checkpoint.artifactId} with exact cursor ${checkpoint.expectedCursor}.`;
    projected.unshift({
      id: instructionMessageId,
      role: 'system',
      content: instruction,
      createdAt: runtime.now(),
    });
    return { messages: projected, instruction };
  };
  let projectedMessages: AgentMessage[] = [userMessage];
  let canonicalRawMessages: AgentMessage[] = [userMessage];
  let requiredBeforeFinal: readonly AgentRequiredBeforeFinalDirective[] = [];
  let terminal: AgentLoopResult | null = null;

  while (!terminal || terminal.reason === undefined) {
    const episodeCoverage = currentCoverage();
    const result = await runAgentLoop({
      sessionId: scenarioSessionId(runtime),
      messages: [...projectedMessages],
      rawMessages: [...canonicalRawMessages],
      provider,
      tools: episodeCoverage?.state === 'pending' ? continuationTools : ordinaryTools,
      contextPolicy: continuationPolicy,
      onToolEnvelopeSettled: async ({ messages }) => {
        const checkpoint = currentCoverage();
        if (!checkpoint) return { kind: 'ready' as const, messages: [...messages] };
        const latestToolIndex = messages.findLastIndex((message) => message.role === 'tool');
        const latestAssistantIndex = latestToolIndex > 0 && messages[latestToolIndex - 1]?.role === 'agent'
          ? latestToolIndex - 1
          : -1;
        const canonicalIds = new Set(canonicalRawMessages.map((message) => message.id));
        const reduced = messages.filter((message, index) => (
          message.role === 'system'
          || canonicalIds.has(message.id)
          || index === latestAssistantIndex
          || index === latestToolIndex
        ));
        return {
          kind: 'ready' as const,
          messages: projectContinuationInstruction(reduced, checkpoint).messages,
        };
      },
      maxSteps: episodeCoverage ? 8 : 1,
      maxOutputTokens: policy.requestedOutputTokens,
      toolResultAdmissionHost: admissionHost,
      requiredBeforeFinal,
      trace: trace.execution,
      traceProvider: TRACE_PROVIDER,
      emit(event) {
        trace.recordAgentEvent(event);
        if (event.type === 'agent_done') {
          if (!currentReceipt() || currentCoverage()?.state !== 'complete') {
            throw new TypeError('Scenario emitted agent_done before artifact coverage receipt completion.');
          }
          agentDoneCount += 1;
        }
        if (event.type === 'assistant_text_delta') {
          if (!currentReceipt() || currentCoverage()?.state !== 'complete') {
            throw new TypeError('Scenario published assistant text before artifact coverage completion.');
          }
          publishedText.push(event.delta);
        }
      },
      idFactory: () => `scenario-message:${runtime.randomId()}`,
      now: runtime.now,
    });
    terminal = result;
    if (result.reason !== undefined) break;

    projectedMessages = [...result.continuation.projectedMessages];
    canonicalRawMessages = [...result.continuation.canonicalRawMessages];
    requiredBeforeFinal = [...result.continuation.requiredBeforeFinal];
    const durableCoverage = currentCoverage();
    if (!durableCoverage) {
      throw new TypeError('Scenario continuation returned without durable coverage.');
    }
    const persisted = cloneScenarioValue(durableCoverage);
    if (persisted.state === 'complete') {
      if (requiredBeforeFinal.length !== 0 || !receipt) {
        throw new TypeError('Scenario completed coverage without clearing its durable obligation.');
      }
      projectedMessages = projectContinuationInstruction(projectedMessages, persisted).messages;
      resumeExpectedCursor = undefined;
      episodeBoundaryCount += 1;
      const completionEpisode = ++continuationDiagnosticEpisode;
      trace.execution.emit({
        kind: 'continuation_started',
        providerStep: Math.max(0, providerRequestCount - 1),
        episode: completionEpisode,
        attempt: 1,
        reason: 'artifact_completion_boundary',
      });
      trace.execution.emit({
        kind: 'continuation_finished',
        providerStep: Math.max(0, providerRequestCount - 1),
        episode: completionEpisode,
        attempt: 1,
        outcome: 'continued',
      });
      continue;
    }
    if (persisted.state !== 'pending') {
      throw new TypeError('Scenario continuation restored non-pending artifact coverage.');
    }
    resumeExpectedCursor = persisted.expectedCursor;
    if (
      !targetedReadsExercised
      && persisted.bytesDelivered > 0
      && persisted.expectedCursor !== null
    ) {
      await exerciseTargetedReads(persisted);
    }
    const projectedContinuation = projectContinuationInstruction(projectedMessages, persisted);
    projectedMessages = projectedContinuation.messages;
    const continuationInstruction = projectedContinuation.instruction;
    if (!continuationInstruction) {
      throw new TypeError('Scenario pending coverage lost its trusted continuation instruction.');
    }
    const diagnosticEpisode = ++continuationDiagnosticEpisode;
    trace.execution.emit({
      kind: 'continuation_started',
      providerStep: Math.max(0, providerRequestCount - 1),
      episode: diagnosticEpisode,
      attempt: 1,
      reason: `artifact_${result.continuation.cause}`,
    });
    if (result.continuation.cause === 'no_progress') {
      noProgressCount += 1;
      if (repromptUsed || noProgressCount !== 1) {
        throw new TypeError('Scenario used more than one artifact no-progress re-prompt.');
      }
      repromptUsed = true;
      repromptCheckpoint = Object.freeze({
        coverageId: persisted.coverageId,
        expectedCursor: persisted.expectedCursor,
        progressToken: persisted.progressToken,
        instruction: continuationInstruction,
        used: true,
      });
      trace.execution.emit({
        kind: 'continuation_finished',
        providerStep: Math.max(0, providerRequestCount - 1),
        episode: diagnosticEpisode,
        attempt: 1,
        outcome: 'continued',
      });
      continue;
    }
    episodeBoundaryCount += 1;
    trace.recordAgentEvent({
      type: 'context_compaction_start',
      sessionId: scenarioSessionId(runtime),
    });
    trace.recordAgentEvent({
      ...contextDiagnostic(runtime),
      action: 'terminal',
      category: 'succeeded',
    });
    trace.recordAgentEvent({
      type: 'context_compaction_end',
      sessionId: scenarioSessionId(runtime),
      ok: true,
      summarizedMessageCount: Math.max(1, projectedMessages.length - canonicalRawMessages.length),
    });
    trace.execution.emit({
      kind: 'continuation_finished',
      providerStep: Math.max(0, providerRequestCount - 1),
      episode: diagnosticEpisode,
      attempt: 1,
      outcome: 'continued',
    });
  }

  if (!terminal || terminal.reason !== 'final_answer') {
    throw new TypeError('Scenario artifact continuation did not reach one final answer.');
  }
  const completedCoverage = currentCoverage();
  if (!completedCoverage || completedCoverage.state !== 'complete' || completedCoverage.expectedCursor !== null) {
    throw new TypeError('Scenario final answer escaped before exact null-cursor completion.');
  }
  if (completedCoverage.bytesDelivered !== completedCoverage.expectedBytes) {
    throw new TypeError('Scenario final answer escaped before exact byte coverage.');
  }
  if (!targetedReadsExercised) {
    throw new TypeError('Scenario did not exercise targeted reads before sequential continuation.');
  }
  const exhaustiveReads = artifactReads.filter((read) => read.kind === 'page');
  if (exhaustiveReads.length <= 8 || exhaustiveReads[0]?.cursor !== undefined) {
    throw new TypeError('Scenario did not exercise more than eight omitted-first-cursor pages.');
  }
  for (let index = 1; index < exhaustiveReads.length; index += 1) {
    if (exhaustiveReads[index]?.cursor !== exhaustiveReads[index - 1]?.nextCursor) {
      throw new TypeError('Scenario exhaustive read did not reuse the exact issued cursor.');
    }
  }
  if (
    !artifactReads.some((read) => read.kind === 'offset')
    || !artifactReads.some((read) => read.kind === 'search')
  ) throw new TypeError('Scenario did not exercise non-advancing targeted reads.');
  const persistedReprompt = currentRepromptCheckpoint();
  if (
    !repromptUsed
    || noProgressCount !== 1
    || !persistedReprompt
    || persistedReprompt.coverageId !== completedCoverage.coverageId
    || (persistedReprompt.expectedCursor !== null
      && !persistedReprompt.instruction.includes(persistedReprompt.expectedCursor))
  ) {
    throw new TypeError('Scenario did not persist exactly one exact-cursor no-progress re-prompt.');
  }
  if (episodeBoundaryCount < 1 || admittedCheckpoints.length <= 8) {
    throw new TypeError('Scenario did not resume durable coverage across an episode boundary.');
  }
  if (agentDoneCount !== 1 || publishedText.join('') !== SCENARIO_ARTIFACT_FINAL_TEXT) {
    throw new TypeError('Scenario leaked provisional text or emitted multiple terminal results.');
  }
  const completedReceipt = currentReceipt();
  if (!completedReceipt || completedReceipt.sourceToolCallId !== completedCoverage.sourceToolCallId) {
    throw new TypeError('Scenario coverage receipt is not associated with its exact source tool call.');
  }
  const reloadedReceipt = cloneScenarioValue(completedReceipt);
  const committedSource = terminal.rawMessages?.find((message) => (
    message.role === 'tool' && message.toolCallId === completedReceipt.sourceToolCallId
  ));
  if (
    !committedSource
    || committedSource.id !== admittedCheckpoints[0]?.sourceMessageId
    || !committedSource.opaqueReferences?.includes(completedReceipt.artifactId)
  ) throw new TypeError('Scenario attached the artifact receipt to the wrong canonical row.');
  if (
    terminal.rawMessages?.some((message) => (
      message.role === 'system' || message.content.includes(SCENARIO_PROVISIONAL_TEXT)
    ))
  ) throw new TypeError('Scenario committed internal continuation state into canonical history.');
  if (canonicalJson(reloadedReceipt) !== canonicalJson(completedReceipt)) {
    throw new TypeError('Scenario coverage receipt did not survive durable reload.');
  }
  if (disposedArtifacts !== 0 || artifacts.size !== 1) {
    throw new TypeError('Scenario disposed a committed artifact during continuation.');
  }

  trace.finish('completed', terminal.reason);
  await trace.flush();
  return traceRootOperationId(runtime);
}

function scenarioLargeArtifactReadTool(): AgentTool<Record<string, never>, { payload: string }> {
  return {
    name: SCENARIO_LARGE_READ_TOOL,
    description: 'Return a controlled oversized repository read for Scenario Lab.',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    validate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
        throw new TypeError('Scenario oversized read arguments must be empty.');
      }
      return {};
    },
    async execute() {
      const prefix = 'SCENARIO_COVERAGE_NEEDLE:';
      return {
        payload: prefix + 'x'.repeat(
          SCENARIO_ARTIFACT_PAGE_BYTES * SCENARIO_ARTIFACT_PAGE_COUNT,
        ),
      };
    },
  };
}

function latestScenarioToolData(messages: readonly ModelMessage[]): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool') continue;
    try {
      const result = JSON.parse(message.content) as { ok?: unknown; data?: unknown };
      if (result.ok === true && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        return result.data as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function scenarioCursor(byteOffset: number): string {
  return `scenario-cursor:${byteOffset}`;
}

function scenarioCursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^scenario-cursor:(\d+)$/u.exec(cursor);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset <= 0) {
    throw new TypeError('Scenario cursor is malformed.');
  }
  return offset;
}

function cloneScenarioValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  if (result.reason === undefined) throw new TypeError('Scenario fixture returned a continuation.');
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
        const resolved = typeof step === 'function' ? await step(signal, input) : step;
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
