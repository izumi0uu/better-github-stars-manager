import type {
  DevTraceEvent,
  DevTraceEventDataByKind,
  DevTraceEventKind,
  TraceArtifactV1,
} from '@/agent-observability';

export const AGENT_DIAGNOSTIC_REPORT_VERSION = 1 as const;

const REPORT_LIMITS = {
  findings: 300,
  providerRequests: 200,
  contextEvents: 400,
  toolCalls: 200,
} as const;

const PROVIDER_EVENT_KINDS = new Set<DevTraceEventKind>([
  'provider_request_prepared',
  'provider_response_started',
  'provider_stream_item',
  'provider_usage',
  'provider_finished',
  'provider_error',
  'context_preflight',
]);

const CONTEXT_EVENT_KINDS = new Set<DevTraceEventKind>([
  'context_preflight',
  'context_reduction_started',
  'context_reduction_finished',
  'continuation_started',
  'continuation_finished',
  'watchdog_state',
]);

const TOOL_EVENT_KINDS = new Set<DevTraceEventKind>([
  'tool_queued',
  'tool_authorized',
  'tool_started',
  'tool_result_admitted',
  'tool_completed',
  'tool_write_outcome',
]);

type FindingSeverity = 'error' | 'warning' | 'info';
type ReportStatus = 'healthy' | 'running' | 'degraded' | 'failed';

export type AgentDiagnosticFinding = Readonly<{
  code: string;
  severity: FindingSeverity;
  message: string;
  rootOperationId: string | null;
  requestId: string | null;
  eventId: string | null;
  sequence: number | null;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type AgentDiagnosticProviderRequest = Readonly<{
  key: string;
  rootOperationId: string;
  operationKind: string;
  requestId: string;
  requestKind: 'turn' | 'historical_summary' | 'active_turn_summary' | 'organize_analysis';
  providerStep: number | null;
  requestAttempt: number;
  state: 'preflight' | 'prepared' | 'streaming' | 'completed' | 'error' | 'incomplete';
  providerClass: 'openai' | 'openrouter' | 'anthropic' | 'custom' | null;
  protocol: 'chat_completions' | 'responses' | 'anthropic_messages' | null;
  modelCapabilityRevision: string | null;
  preparedAt: number | null;
  responseStartedAt: number | null;
  timing: Readonly<{
    firstResponseMs: number | null;
    totalDurationMs: number | null;
  }>;
  request: Readonly<{
    requestBytes: number | null;
    historyBytes: number | null;
    estimatedInputTokens: number | null;
    maxOutputTokens: number | null;
  }>;
  context: Readonly<{
    workingWindowTokens: number | null;
    reserveTokens: number | null;
    decision: 'admit' | 'reduce' | 'irreducible' | null;
    reasonCode: string | null;
  }>;
  stream: Readonly<{
    itemCount: number;
    utf8Bytes: number;
    classes: Readonly<Record<string, number>>;
  }>;
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    source: 'provider' | 'estimated' | null;
  }>;
  outcome: Readonly<{
    finishReason: string | null;
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean | null;
    overflow: boolean | null;
  }>;
  evidenceEventIds: readonly string[];
}>;

export type AgentDiagnosticToolCall = Readonly<{
  key: string;
  rootOperationId: string;
  providerStep: number;
  toolCallId: string;
  toolName: string;
  toolClass: 'read' | 'suggest' | 'write' | null;
  risk: 'read' | 'suggest' | 'write' | null;
  authorization: 'allow' | 'deny' | 'confirm' | null;
  attempt: number | null;
  result: Readonly<{
    originalBytes: number | null;
    admittedBytes: number | null;
    reduction: 'none' | 'structural' | 'error_envelope' | null;
    outcome: 'success' | 'error' | 'cancelled' | null;
    durationMs: number | null;
  }>;
  write: Readonly<{
    effectCount: number | null;
    state: 'committed' | 'unchanged' | 'failed' | 'unknown' | null;
  }>;
  evidenceEventIds: readonly string[];
}>;

export type AgentDiagnosticContextEvent = Readonly<{
  rootOperationId: string;
  eventId: string;
  sequence: number;
  wallTimeMs: number;
  kind: DevTraceEventKind;
  data: Readonly<Record<string, unknown>>;
}>;

export type AgentDiagnosticReport = Readonly<{
  schemaVersion: typeof AGENT_DIAGNOSTIC_REPORT_VERSION;
  generatedFromArtifactAt: number;
  scope: Readonly<{ kind: 'all_retained' | 'root'; id: string | null }>;
  source: Readonly<{
    exporterVersion: string;
    versionHash: string;
    extensionVersion: string;
    runtime: string;
  }>;
  privacy: Readonly<{
    credentialsIncluded: false;
    rawCaptureIncluded: false;
    retainedTraceFieldsAreBoundedAndRedacted: true;
  }>;
  summary: Readonly<{
    status: ReportStatus;
    operationCount: number;
    activeOperationCount: number;
    failedOperationCount: number;
    eventCount: number;
    providerRequestCount: number;
    providerErrorCount: number;
    contextReductionCount: number;
    continuationCount: number;
    toolCallCount: number;
    findingCounts: Readonly<Record<FindingSeverity, number>>;
  }>;
  completeness: TraceArtifactV1['completeness'];
  findings: readonly AgentDiagnosticFinding[];
  providerRequests: readonly AgentDiagnosticProviderRequest[];
  contextActivity: readonly AgentDiagnosticContextEvent[];
  toolCalls: readonly AgentDiagnosticToolCall[];
  omitted: Readonly<{
    findings: number;
    providerRequests: number;
    contextEvents: number;
    toolCalls: number;
  }>;
}>;

type MutableProviderRequest = {
  key: string;
  rootOperationId: string;
  operationKind: string;
  requestId: string;
  requestKind: AgentDiagnosticProviderRequest['requestKind'];
  providerStep: number | null;
  requestAttempt: number;
  state: AgentDiagnosticProviderRequest['state'];
  providerClass: AgentDiagnosticProviderRequest['providerClass'];
  protocol: AgentDiagnosticProviderRequest['protocol'];
  modelCapabilityRevision: string | null;
  preparedAt: number | null;
  responseStartedAt: number | null;
  firstResponseMs: number | null;
  totalDurationMs: number | null;
  requestBytes: number | null;
  historyBytes: number | null;
  estimatedInputTokens: number | null;
  maxOutputTokens: number | null;
  workingWindowTokens: number | null;
  reserveTokens: number | null;
  decision: AgentDiagnosticProviderRequest['context']['decision'];
  reasonCode: string | null;
  streamItemCount: number;
  streamBytes: number;
  streamClasses: Record<string, number>;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageSource: AgentDiagnosticProviderRequest['usage']['source'];
  finishReason: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  retryable: boolean | null;
  overflow: boolean | null;
  evidenceEventIds: string[];
};

type MutableToolCall = {
  key: string;
  rootOperationId: string;
  providerStep: number;
  toolCallId: string;
  toolName: string;
  toolClass: AgentDiagnosticToolCall['toolClass'];
  risk: AgentDiagnosticToolCall['risk'];
  authorization: AgentDiagnosticToolCall['authorization'];
  attempt: number | null;
  originalBytes: number | null;
  admittedBytes: number | null;
  reduction: AgentDiagnosticToolCall['result']['reduction'];
  outcome: AgentDiagnosticToolCall['result']['outcome'];
  durationMs: number | null;
  effectCount: number | null;
  writeState: AgentDiagnosticToolCall['write']['state'];
  evidenceEventIds: string[];
};

export function createAgentDiagnosticReport(
  artifact: TraceArtifactV1,
  rootOperationId: string | null = null,
): AgentDiagnosticReport {
  const roots = rootOperationId
    ? artifact.roots.filter((root) => root.rootOperationId === rootOperationId)
    : artifact.roots;
  const rootIds = new Set(roots.map((root) => root.rootOperationId));
  const events = artifact.events.filter((event) => rootIds.has(event.rootOperationId));
  const requests = collectProviderRequests(events, roots);
  const toolCalls = collectToolCalls(events);
  const contextActivity = events
    .filter((event) => CONTEXT_EVENT_KINDS.has(event.kind))
    .map((event) => ({
      rootOperationId: event.rootOperationId,
      eventId: event.eventId,
      sequence: event.sequence,
      wallTimeMs: event.wallTimeMs,
      kind: event.kind,
      data: event.data as Readonly<Record<string, unknown>>,
    }))
    .sort((left, right) => right.wallTimeMs - left.wallTimeMs || right.sequence - left.sequence);
  const findings = collectFindings(artifact, roots, events, requests);
  const findingCounts = countFindings(findings);
  const activeOperationCount = roots.filter((root) => root.terminalState === null).length;
  const failedOperationCount = roots.filter((root) => (
    root.terminalState === 'failed'
    || root.terminalState === 'timed_out'
    || root.terminalState === 'attempt_state_lost'
  )).length;
  const status: ReportStatus = findingCounts.error > 0
    ? 'failed'
    : findingCounts.warning > 0
      ? 'degraded'
      : activeOperationCount > 0
        ? 'running'
        : 'healthy';

  return {
    schemaVersion: AGENT_DIAGNOSTIC_REPORT_VERSION,
    generatedFromArtifactAt: artifact.exportedAt,
    scope: rootOperationId
      ? { kind: 'root', id: rootOperationId }
      : { kind: 'all_retained', id: null },
    source: {
      exporterVersion: artifact.exporterVersion,
      versionHash: artifact.build.versionHash,
      extensionVersion: artifact.build.extensionVersion,
      runtime: artifact.build.runtime,
    },
    privacy: {
      credentialsIncluded: false,
      rawCaptureIncluded: false,
      retainedTraceFieldsAreBoundedAndRedacted: true,
    },
    summary: {
      status,
      operationCount: roots.length,
      activeOperationCount,
      failedOperationCount,
      eventCount: events.length,
      providerRequestCount: requests.length,
      providerErrorCount: requests.filter((request) => request.state === 'error').length,
      contextReductionCount: events.filter((event) => event.kind === 'context_reduction_started').length,
      continuationCount: events.filter((event) => event.kind === 'continuation_started').length,
      toolCallCount: toolCalls.length,
      findingCounts,
    },
    completeness: artifact.completeness,
    findings: findings.slice(0, REPORT_LIMITS.findings),
    providerRequests: requests.slice(0, REPORT_LIMITS.providerRequests),
    contextActivity: contextActivity.slice(0, REPORT_LIMITS.contextEvents),
    toolCalls: toolCalls.slice(0, REPORT_LIMITS.toolCalls),
    omitted: {
      findings: Math.max(0, findings.length - REPORT_LIMITS.findings),
      providerRequests: Math.max(0, requests.length - REPORT_LIMITS.providerRequests),
      contextEvents: Math.max(0, contextActivity.length - REPORT_LIMITS.contextEvents),
      toolCalls: Math.max(0, toolCalls.length - REPORT_LIMITS.toolCalls),
    },
  };
}

function collectProviderRequests(
  events: readonly DevTraceEvent[],
  roots: TraceArtifactV1['roots'],
): AgentDiagnosticProviderRequest[] {
  const requests = new Map<string, MutableProviderRequest>();
  const terminalRoots = new Set(roots.filter((root) => root.terminalState !== null).map((root) => root.rootOperationId));

  for (const event of events) {
    if (!PROVIDER_EVENT_KINDS.has(event.kind)) continue;
    const data = event.data as Partial<DevTraceEventDataByKind['provider_request_prepared']>;
    if (typeof data.requestId !== 'string' || typeof data.requestAttempt !== 'number' || !data.requestKind) continue;
    const key = providerRequestKey(event.rootOperationId, data.requestId, data.requestAttempt);
    const request = requests.get(key) ?? newProviderRequest(event, data, key);
    request.evidenceEventIds.push(event.eventId);

    if (event.kind === 'provider_request_prepared') {
      const prepared = eventData(event, 'provider_request_prepared');
      request.state = 'prepared';
      request.providerClass = prepared.providerClass;
      request.protocol = prepared.protocol;
      request.modelCapabilityRevision = prepared.modelCapabilityRevision;
      request.preparedAt = event.wallTimeMs;
      request.requestBytes = prepared.requestBytes;
      request.historyBytes = prepared.historyBytes;
      request.estimatedInputTokens = prepared.estimatedInputTokens;
      request.maxOutputTokens = prepared.maxOutputTokens;
    } else if (event.kind === 'provider_response_started') {
      const started = eventData(event, 'provider_response_started');
      request.state = 'streaming';
      request.responseStartedAt = event.wallTimeMs;
      request.firstResponseMs = started.latencyMs;
    } else if (event.kind === 'provider_stream_item') {
      const stream = eventData(event, 'provider_stream_item');
      request.state = request.state === 'error' ? 'error' : 'streaming';
      request.streamItemCount += 1;
      request.streamBytes += stream.utf8Bytes;
      request.streamClasses[stream.streamClass] = (request.streamClasses[stream.streamClass] ?? 0) + 1;
    } else if (event.kind === 'provider_usage') {
      const usage = eventData(event, 'provider_usage');
      request.inputTokens = usage.inputTokens;
      request.outputTokens = usage.outputTokens;
      request.totalTokens = usage.totalTokens;
      request.usageSource = usage.source;
    } else if (event.kind === 'provider_finished') {
      const finished = eventData(event, 'provider_finished');
      request.state = 'completed';
      request.finishReason = finished.finishReason;
      request.totalDurationMs = finished.durationMs;
    } else if (event.kind === 'provider_error') {
      const failed = eventData(event, 'provider_error');
      request.state = 'error';
      request.totalDurationMs = request.preparedAt === null
        ? null
        : Math.max(0, event.wallTimeMs - request.preparedAt);
      request.errorCode = failed.code;
      request.httpStatus = failed.status;
      request.retryable = failed.retryable;
      request.overflow = failed.overflow;
    } else if (event.kind === 'context_preflight') {
      const preflight = eventData(event, 'context_preflight');
      request.workingWindowTokens = preflight.workingWindowTokens;
      request.reserveTokens = preflight.reserveTokens;
      request.decision = preflight.decision;
      request.reasonCode = preflight.reasonCode;
      request.requestBytes ??= preflight.requestBytes;
      request.historyBytes ??= preflight.historyBytes;
      request.estimatedInputTokens ??= preflight.estimatedInputTokens;
    }
    requests.set(key, request);
  }

  return [...requests.values()]
    .map((request) => {
      if (
        terminalRoots.has(request.rootOperationId)
        && request.state !== 'completed'
        && request.state !== 'error'
      ) request.state = 'incomplete';
      return freezeProviderRequest(request);
    })
    .sort((left, right) => (
      (right.preparedAt ?? right.responseStartedAt ?? 0) - (left.preparedAt ?? left.responseStartedAt ?? 0)
      || right.requestAttempt - left.requestAttempt
    ));
}

function newProviderRequest(
  event: DevTraceEvent,
  data: Partial<DevTraceEventDataByKind['provider_request_prepared']>,
  key: string,
): MutableProviderRequest {
  return {
    key,
    rootOperationId: event.rootOperationId,
    operationKind: event.operationKind,
    requestId: data.requestId!,
    requestKind: data.requestKind!,
    providerStep: data.providerStep ?? null,
    requestAttempt: data.requestAttempt!,
    state: event.kind === 'context_preflight' ? 'preflight' : 'prepared',
    providerClass: null,
    protocol: null,
    modelCapabilityRevision: null,
    preparedAt: null,
    responseStartedAt: null,
    firstResponseMs: null,
    totalDurationMs: null,
    requestBytes: null,
    historyBytes: null,
    estimatedInputTokens: null,
    maxOutputTokens: null,
    workingWindowTokens: null,
    reserveTokens: null,
    decision: null,
    reasonCode: null,
    streamItemCount: 0,
    streamBytes: 0,
    streamClasses: {},
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usageSource: null,
    finishReason: null,
    errorCode: null,
    httpStatus: null,
    retryable: null,
    overflow: null,
    evidenceEventIds: [],
  };
}

function freezeProviderRequest(request: MutableProviderRequest): AgentDiagnosticProviderRequest {
  return {
    key: request.key,
    rootOperationId: request.rootOperationId,
    operationKind: request.operationKind,
    requestId: request.requestId,
    requestKind: request.requestKind,
    providerStep: request.providerStep,
    requestAttempt: request.requestAttempt,
    state: request.state,
    providerClass: request.providerClass,
    protocol: request.protocol,
    modelCapabilityRevision: request.modelCapabilityRevision,
    preparedAt: request.preparedAt,
    responseStartedAt: request.responseStartedAt,
    timing: { firstResponseMs: request.firstResponseMs, totalDurationMs: request.totalDurationMs },
    request: {
      requestBytes: request.requestBytes,
      historyBytes: request.historyBytes,
      estimatedInputTokens: request.estimatedInputTokens,
      maxOutputTokens: request.maxOutputTokens,
    },
    context: {
      workingWindowTokens: request.workingWindowTokens,
      reserveTokens: request.reserveTokens,
      decision: request.decision,
      reasonCode: request.reasonCode,
    },
    stream: {
      itemCount: request.streamItemCount,
      utf8Bytes: request.streamBytes,
      classes: request.streamClasses,
    },
    usage: {
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      totalTokens: request.totalTokens,
      source: request.usageSource,
    },
    outcome: {
      finishReason: request.finishReason,
      errorCode: request.errorCode,
      httpStatus: request.httpStatus,
      retryable: request.retryable,
      overflow: request.overflow,
    },
    evidenceEventIds: request.evidenceEventIds,
  };
}

function collectToolCalls(events: readonly DevTraceEvent[]): AgentDiagnosticToolCall[] {
  const calls = new Map<string, MutableToolCall>();
  for (const event of events) {
    if (!TOOL_EVENT_KINDS.has(event.kind)) continue;
    const common = event.data as Partial<DevTraceEventDataByKind['tool_queued']>;
    if (typeof common.toolCallId !== 'string' || typeof common.toolName !== 'string' || typeof common.providerStep !== 'number') continue;
    const key = `${event.rootOperationId}:${common.providerStep}:${common.toolCallId}`;
    const call = calls.get(key) ?? newToolCall(event.rootOperationId, common, key);
    call.evidenceEventIds.push(event.eventId);
    if (event.kind === 'tool_queued') {
      const queued = eventData(event, 'tool_queued');
      call.toolClass = queued.toolClass;
      call.risk = queued.risk;
    } else if (event.kind === 'tool_authorized') {
      call.authorization = eventData(event, 'tool_authorized').decision;
    } else if (event.kind === 'tool_started') {
      call.attempt = eventData(event, 'tool_started').attempt;
    } else if (event.kind === 'tool_result_admitted') {
      const admitted = eventData(event, 'tool_result_admitted');
      call.originalBytes = admitted.originalBytes;
      call.admittedBytes = admitted.admittedBytes;
      call.reduction = admitted.reduction;
    } else if (event.kind === 'tool_completed') {
      const completed = eventData(event, 'tool_completed');
      call.outcome = completed.outcome;
      call.durationMs = completed.durationMs;
    } else if (event.kind === 'tool_write_outcome') {
      const write = eventData(event, 'tool_write_outcome');
      call.effectCount = write.effectCount;
      call.writeState = write.state;
    }
    calls.set(key, call);
  }
  return [...calls.values()].reverse().map((call) => ({
    key: call.key,
    rootOperationId: call.rootOperationId,
    providerStep: call.providerStep,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    toolClass: call.toolClass,
    risk: call.risk,
    authorization: call.authorization,
    attempt: call.attempt,
    result: {
      originalBytes: call.originalBytes,
      admittedBytes: call.admittedBytes,
      reduction: call.reduction,
      outcome: call.outcome,
      durationMs: call.durationMs,
    },
    write: { effectCount: call.effectCount, state: call.writeState },
    evidenceEventIds: call.evidenceEventIds,
  }));
}

function newToolCall(
  rootOperationId: string,
  data: Partial<DevTraceEventDataByKind['tool_queued']>,
  key: string,
): MutableToolCall {
  return {
    key,
    rootOperationId,
    providerStep: data.providerStep!,
    toolCallId: data.toolCallId!,
    toolName: data.toolName!,
    toolClass: null,
    risk: null,
    authorization: null,
    attempt: null,
    originalBytes: null,
    admittedBytes: null,
    reduction: null,
    outcome: null,
    durationMs: null,
    effectCount: null,
    writeState: null,
    evidenceEventIds: [],
  };
}

function collectFindings(
  artifact: TraceArtifactV1,
  roots: TraceArtifactV1['roots'],
  events: readonly DevTraceEvent[],
  requests: readonly AgentDiagnosticProviderRequest[],
): AgentDiagnosticFinding[] {
  const findings: AgentDiagnosticFinding[] = [];
  const globalScope = roots.length === artifact.roots.length;
  if (globalScope) {
    addCompletenessFindings(findings, artifact);
  }
  for (const root of roots) {
    if (
      root.terminalState === 'failed'
      || root.terminalState === 'timed_out'
      || root.terminalState === 'attempt_state_lost'
    ) {
      findings.push(finding(
        'operation_terminal_failure',
        'error',
        `Operation ${root.rootOperationId} ended as ${root.terminalState}.`,
        root.rootOperationId,
        null,
        null,
        null,
        { terminalState: root.terminalState, endedAt: root.endedAt },
      ));
    }
  }
  const terminalStateByRoot = new Map(roots.map((root) => [
    root.rootOperationId,
    root.terminalState,
  ]));
  for (const request of requests) {
    if (request.state === 'error') {
      if (
        terminalStateByRoot.get(request.rootOperationId) === 'cancelled'
        && request.outcome.errorCode === 'caller_abort'
      ) continue;
      const suffix = request.outcome.httpStatus === null ? '' : ` (HTTP ${request.outcome.httpStatus})`;
      findings.push(finding(
        'provider_request_failed',
        'error',
        `Provider request ${request.requestId} failed with ${request.outcome.errorCode ?? 'unknown_error'}${suffix}.`,
        request.rootOperationId,
        request.requestId,
        request.evidenceEventIds.at(-1) ?? null,
        null,
        request.outcome,
      ));
    } else if (request.state === 'incomplete') {
      findings.push(finding(
        'provider_request_incomplete',
        'warning',
        `Provider request ${request.requestId} has no terminal Provider event although its operation ended.`,
        request.rootOperationId,
        request.requestId,
        request.evidenceEventIds.at(-1) ?? null,
        null,
        { state: request.state },
      ));
    }
  }
  for (const event of events) {
    addEventFinding(findings, event);
  }
  return findings.sort((left, right) => (
    severityRank(left.severity) - severityRank(right.severity)
    || (right.sequence ?? -1) - (left.sequence ?? -1)
    || left.code.localeCompare(right.code)
  ));
}

function addCompletenessFindings(findings: AgentDiagnosticFinding[], artifact: TraceArtifactV1): void {
  const { completeness } = artifact;
  const entries: Array<[number, string, string]> = [
    [completeness.evictedRootCount, 'trace_roots_evicted', 'retained operation(s) were evicted'],
    [completeness.droppedEventCount, 'trace_events_dropped', 'trace event(s) were dropped'],
    [completeness.truncatedFieldCount, 'trace_fields_truncated', 'trace field(s) were truncated'],
    [completeness.unknownEventCount, 'trace_events_unknown', 'unknown trace event(s) were retained'],
  ];
  for (const [count, code, label] of entries) {
    if (count > 0) findings.push(finding(code, 'warning', `${count} ${label}; evidence is incomplete.`, null, null, null, null, { count }));
  }
  if (completeness.activeBeforeTracing) {
    findings.push(finding(
      'trace_started_after_operation',
      'warning',
      'At least one operation was already active when tracing started.',
      null,
      null,
      null,
      null,
      { activeBeforeTracing: true },
    ));
  }
  for (const gap of completeness.sequenceGaps) {
    findings.push(finding(
      'trace_sequence_gap',
      'warning',
      `Trace sequence ${gap.firstMissingSequence}-${gap.lastMissingSequence} is missing for ${gap.rootOperationId}.`,
      gap.rootOperationId,
      null,
      null,
      gap.firstMissingSequence,
      gap,
    ));
  }
}

function addEventFinding(
  findings: AgentDiagnosticFinding[],
  event: DevTraceEvent,
): void {
  if (event.kind === 'context_preflight') {
    const data = eventData(event, 'context_preflight');
    if (data.decision === 'irreducible') pushEventFinding(findings, event, 'context_irreducible', 'error', `Context preflight could not admit or reduce request ${data.requestId}.`, data.requestId);
  } else if (event.kind === 'context_reduction_finished') {
    const data = eventData(event, 'context_reduction_finished');
    if (data.outcome === 'failed') pushEventFinding(findings, event, 'context_reduction_failed', 'error', `Context reduction episode ${data.episode} failed.`);
    if (data.outcome === 'fallback') pushEventFinding(findings, event, 'context_reduction_fallback', 'warning', `Context reduction episode ${data.episode} used a fallback summary.`);
  } else if (event.kind === 'continuation_finished') {
    const data = eventData(event, 'continuation_finished');
    if (data.outcome === 'failed' || data.outcome === 'exhausted') pushEventFinding(findings, event, 'continuation_failed', 'error', `Continuation episode ${data.episode} ${data.outcome}.`);
  } else if (event.kind === 'watchdog_state') {
    const data = eventData(event, 'watchdog_state');
    if (data.state === 'expired') pushEventFinding(findings, event, 'watchdog_expired', 'error', `${data.watchdog} watchdog expired after ${data.limitMs} ms.`);
  } else if (event.kind === 'tool_completed') {
    const data = eventData(event, 'tool_completed');
    if (data.outcome === 'error') pushEventFinding(findings, event, 'tool_failed', 'warning', `Tool ${data.toolName} returned an error.`);
  } else if (event.kind === 'tool_write_outcome') {
    const data = eventData(event, 'tool_write_outcome');
    if (data.state === 'failed') pushEventFinding(findings, event, 'tool_write_failed', 'error', `Write tool ${data.toolName} failed.`);
  } else if (event.kind === 'port_disconnected') {
    const data = eventData(event, 'port_disconnected');
    if (data.attemptState === 'active') pushEventFinding(findings, event, 'active_port_disconnected', 'warning', 'The Agent Port disconnected while its attempt was active.');
  } else if (event.kind === 'result_acknowledged') {
    const data = eventData(event, 'result_acknowledged');
    if (data.disposition === 'transition_rejected') pushEventFinding(findings, event, 'session_transition_not_applied', 'error', 'The UI rejected the Agent result because its session transition could not be applied.');
  } else if (event.kind === 'trace_storage_state') {
    const data = eventData(event, 'trace_storage_state');
    if (data.state === 'append_failed' || data.state === 'capacity_exhausted') pushEventFinding(findings, event, 'trace_storage_failure', 'error', `Trace storage entered ${data.state}.`);
  } else if (event.kind === 'organize_preflight_state') {
    const data = eventData(event, 'organize_preflight_state');
    if (data.state === 'expired' || data.state === 'disconnected' || data.state === 'worker_lost') pushEventFinding(findings, event, 'organize_preflight_failed', 'error', `OrganizeJobRun preflight ended as ${data.state}.`);
    if (data.state === 'stale') pushEventFinding(findings, event, 'organize_preflight_stale', 'warning', 'OrganizeJobRun preflight evidence became stale.');
  } else if (event.kind === 'organize_restore_state') {
    const data = eventData(event, 'organize_restore_state');
    if (data.state === 'failed') pushEventFinding(findings, event, 'organize_restore_failed', 'error', `OrganizeJobRun restore failed: ${data.reasonCode}.`);
  } else if (event.kind === 'organize_batch_state') {
    const data = eventData(event, 'organize_batch_state');
    if (data.state === 'analysis_failed' || data.state === 'budget_exhausted') pushEventFinding(findings, event, 'organize_batch_failed', 'error', `OrganizeJobRun batch ${data.batchStart}-${data.batchEnd} ended as ${data.state}.`);
  } else if (event.kind === 'organize_provider_attempt') {
    const data = eventData(event, 'organize_provider_attempt');
    if (data.state === 'failed' || data.state === 'budget_exhausted') pushEventFinding(findings, event, 'organize_provider_attempt_failed', 'error', `OrganizeJobRun Provider attempt ${data.attempt} ended as ${data.state}.`);
  } else if (event.kind === 'organize_apply_state') {
    const data = eventData(event, 'organize_apply_state');
    if (data.state === 'attempt_failed') pushEventFinding(findings, event, 'organize_apply_failed', 'error', `OrganizeJobRun apply ${data.applyId} failed.`);
  }
}

function pushEventFinding(
  findings: AgentDiagnosticFinding[],
  event: DevTraceEvent,
  code: string,
  severity: FindingSeverity,
  message: string,
  requestId: string | null = null,
): void {
  findings.push(finding(
    code,
    severity,
    message,
    event.rootOperationId,
    requestId,
    event.eventId,
    event.sequence,
    event.data as Readonly<Record<string, unknown>>,
  ));
}

function finding(
  code: string,
  severity: FindingSeverity,
  message: string,
  rootOperationId: string | null,
  requestId: string | null,
  eventId: string | null,
  sequence: number | null,
  evidence: Readonly<Record<string, unknown>>,
): AgentDiagnosticFinding {
  return { code, severity, message, rootOperationId, requestId, eventId, sequence, evidence };
}

function eventData<K extends DevTraceEventKind>(event: DevTraceEvent, kind: K): DevTraceEventDataByKind[K] {
  if (event.kind !== kind) throw new TypeError(`Expected ${kind}, received ${event.kind}.`);
  return event.data as DevTraceEventDataByKind[K];
}

function providerRequestKey(rootOperationId: string, requestId: string, attempt: number): string {
  return `${rootOperationId}:${requestId}:${attempt}`;
}

function countFindings(findings: readonly AgentDiagnosticFinding[]): Record<FindingSeverity, number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function severityRank(severity: FindingSeverity): number {
  if (severity === 'error') return 0;
  if (severity === 'warning') return 1;
  return 2;
}
