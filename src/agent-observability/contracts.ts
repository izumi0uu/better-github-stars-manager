export const DEV_TRACE_SCHEMA_VERSION = 1 as const;
export const TRACE_ARTIFACT_SCHEMA_VERSION = 1 as const;
type ProviderRequestKind = 'turn' | 'historical_summary' | 'active_turn_summary' | 'organize_analysis';
// Retained records are capped at 100 MiB. A complete JSON artifact also needs
// room for array separators, document fields, and the integrity envelope.
export const MAX_TRACE_ARTIFACT_BYTES = 128 * 1024 * 1024;

export const DEV_TRACE_OPERATION_KINDS = [
  'agent_turn',
  'organize_job',
  'scenario',
] as const;

export type DevTraceOperationKind = typeof DEV_TRACE_OPERATION_KINDS[number];

export const DEV_TRACE_EVENT_KINDS = [
  'root_started',
  'phase_changed',
  'root_cancelled',
  'root_terminal',
  'provider_request_prepared',
  'provider_response_started',
  'provider_stream_item',
  'provider_usage',
  'provider_finished',
  'provider_error',
  'tool_queued',
  'tool_authorized',
  'tool_started',
  'tool_result_admitted',
  'tool_completed',
  'tool_write_outcome',
  'context_preflight',
  'context_reduction_started',
  'context_reduction_finished',
  'continuation_started',
  'continuation_finished',
  'watchdog_state',
  'organize_preflight_state',
  'organize_generation_state',
  'organize_batch_state',
  'organize_provider_attempt',
  'organize_durable_state',
  'organize_review_state',
  'organize_selection_state',
  'organize_apply_state',
  'organize_apply_chunk',
  'organize_receipt_state',
  'organize_progress',
  'attempt_rejected',
  'delivery_state',
  'port_disconnected',
  'trace_storage_state',
] as const;

export type DevTraceEventKind = typeof DEV_TRACE_EVENT_KINDS[number];

export type DevTraceTerminalState =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'attempt_state_lost';

export type DevTraceEventDataByKind = Readonly<{
  root_started: Readonly<{
    executionEpochId: string;
    attemptId: string | null;
    sessionId: string | null;
    baseRevision: number | null;
  }>;
  phase_changed: Readonly<{ phase: string; previousPhase: string | null }>;
  root_cancelled: Readonly<{ source: 'user' | 'port' | 'runtime' | 'scenario' }>;
  root_terminal: Readonly<{
    state: DevTraceTerminalState;
    reasonCode: string | null;
    durationMs: number;
  }>;
  provider_request_prepared: Readonly<{
    requestId: string;
    requestKind: ProviderRequestKind;
    providerStep: number | null;
    requestAttempt: number;
    providerClass: 'openai' | 'openrouter' | 'anthropic' | 'custom';
    protocol: 'chat_completions' | 'responses' | 'anthropic_messages';
    modelCapabilityRevision: string;
    requestBytes: number;
    historyBytes: number;
    estimatedInputTokens: number | null;
    maxOutputTokens: number;
  }>;
  provider_response_started: Readonly<{
    requestId: string;
    requestKind: ProviderRequestKind;
    providerStep: number | null;
    requestAttempt: number;
    latencyMs: number;
  }>;
  provider_stream_item: Readonly<{
    requestId: string;
    requestKind: ProviderRequestKind;
    providerStep: number | null;
    requestAttempt: number;
    streamClass: 'text' | 'refusal' | 'tool_start' | 'tool_arguments' | 'tool_end' | 'usage' | 'response_end';
    utf8Bytes: number;
  }>;
  provider_usage: Readonly<{
    requestId: string;
    requestKind: ProviderRequestKind;
    providerStep: number | null;
    requestAttempt: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    source: 'provider' | 'estimated';
  }>;
  provider_finished: Readonly<{
    requestId: string;
    requestKind: ProviderRequestKind;
    providerStep: number | null;
    requestAttempt: number;
    finishReason: string;
    durationMs: number;
  }>;
  provider_error: Readonly<{
    requestId: string;
    requestKind: ProviderRequestKind;
    providerStep: number | null;
    requestAttempt: number;
    code: string;
    status: number | null;
    retryable: boolean;
    overflow: boolean;
  }>;
  tool_queued: Readonly<{
    providerStep: number;
    toolName: string;
    toolClass: 'read' | 'suggest' | 'write';
    risk: 'read' | 'suggest' | 'write';
    toolCallId: string;
  }>;
  tool_authorized: Readonly<{
    providerStep: number;
    toolName: string;
    toolCallId: string;
    decision: 'allow' | 'deny' | 'confirm';
  }>;
  tool_started: Readonly<{
    providerStep: number;
    toolName: string;
    toolCallId: string;
    attempt: number;
  }>;
  tool_result_admitted: Readonly<{
    providerStep: number;
    toolName: string;
    toolCallId: string;
    originalBytes: number;
    admittedBytes: number;
    reduction: 'none' | 'structural' | 'error_envelope';
  }>;
  tool_completed: Readonly<{
    providerStep: number;
    toolName: string;
    toolCallId: string;
    outcome: 'success' | 'error' | 'cancelled';
    durationMs: number | null;
  }>;
  tool_write_outcome: Readonly<{
    providerStep: number;
    toolName: string;
    toolCallId: string;
    effectCount: number | null;
    state: 'committed' | 'unchanged' | 'failed' | 'unknown';
  }>;
  context_preflight: Readonly<{
    requestId: string;
    requestKind: ProviderRequestKind;
    providerStep: number | null;
    requestAttempt: number;
    workingWindowTokens: number;
    reserveTokens: number;
    estimatedInputTokens: number;
    requestBytes: number;
    historyBytes: number;
    decision: 'admit' | 'reduce' | 'irreducible';
    reasonCode: string | null;
  }>;
  context_reduction_started: Readonly<{
    providerStep: number | null;
    episode: number;
    trigger: 'threshold' | 'provider_overflow' | 'history_bytes' | 'request_bytes';
    splitActiveTurn: boolean | null;
  }>;
  context_reduction_finished: Readonly<{
    providerStep: number | null;
    episode: number;
    outcome: 'summary' | 'corrected_summary' | 'fallback' | 'failed' | 'cancelled';
    projectedTokens: number | null;
    projectedBytes: number | null;
  }>;
  continuation_started: Readonly<{
    providerStep: number;
    episode: number;
    attempt: number;
    reason: string;
  }>;
  continuation_finished: Readonly<{
    providerStep: number;
    episode: number;
    attempt: number;
    outcome: 'continued' | 'failed' | 'cancelled' | 'exhausted';
  }>;
  watchdog_state: Readonly<{
    watchdog:
      | 'first_response'
      | 'stream_idle'
      | 'agent_idle'
      | 'absolute_turn'
      | 'organize_heartbeat'
      | 'organize_wall_deadline';
    state: 'armed' | 'progress' | 'expired' | 'cancelled';
    limitMs: number;
  }>;
  organize_preflight_state: Readonly<{
    state:
      | 'requested'
      | 'ready'
      | 'no_work'
      | 'started'
      | 'cancelled'
      | 'expired'
      | 'stale'
      | 'disconnected'
      | 'worker_lost';
    repositoryCount: number | null;
  }>;
  organize_generation_state: Readonly<{
    runId: string;
    generation: number;
    state: 'frozen' | 'prepared' | 'restored';
    cause: 'initial' | 'continuation' | 'restore';
    parentRunId: string | null;
    parentGeneration: number | null;
    repositoryCount: number;
  }>;
  organize_batch_state: Readonly<{
    runId: string;
    generation: number;
    batchStart: number;
    batchEnd: number;
    repositoryCount: number;
    localOnlyCount: number;
    providerCount: number;
    state: 'scheduled' | 'loaded' | 'split' | 'local_only_completed' | 'provider_completed' | 'analysis_failed' | 'budget_exhausted' | 'cancelled';
  }>;
  organize_provider_attempt: Readonly<{
    runId: string;
    generation: number;
    batchStart: number;
    batchEnd: number;
    attempt: 1 | 2;
    state: 'prepared' | 'admitted' | 'succeeded' | 'failed' | 'budget_exhausted' | 'cancelled';
    requestBytes: number;
    requestedOutputTokens: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    reasonCode: string | null;
  }>;
  organize_durable_state: Readonly<{
    revision: number;
    previousRevision: number | null;
    observation: 'initial' | 'advanced' | 'duplicate' | 'stale' | 'gap_reconciled';
    missingFromRevision: number | null;
    missingToRevision: number | null;
    source: 'mutation' | 'restore' | 'reconnect';
  }>;
  organize_review_state: Readonly<{
    runId: string;
    generation: number;
    revision: number;
    state: 'ready' | 'page_delivered';
    actionableRepositories: number;
    selectedRepositories: number;
    selectedActions: number;
    rowOffset: number | null;
    rowCount: number;
    nextRowOffset: number | null;
  }>;
  organize_selection_state: Readonly<{
    runId: string;
    generation: number;
    previousRevision: number;
    revision: number;
    mode: 'partial' | 'all';
    affectedRepositories: number;
    selectedRepositories: number;
    selectedActions: number;
  }>;
  organize_apply_state: Readonly<{
    applyId: string;
    executionId: string | null;
    revision: number | null;
    state:
      | 'sealed'
      | 'resumed'
      | 'pause_requested'
      | 'paused'
      | 'attempt_started'
      | 'attempt_idle'
      | 'attempt_completed'
      | 'attempt_failed'
      | 'completed';
    total: number | null;
    settled: number | null;
    changed: number | null;
    unchanged: number | null;
    skipped: number | null;
    failed: number | null;
  }>;
  organize_apply_chunk: Readonly<{
    applyId: string;
    executionId: string;
    chunkSequence: number;
    state: 'claimed' | 'settled';
    positionStart: number | null;
    positionEnd: number | null;
    rowCount: number;
    maxAttemptCount: number | null;
    changed: number;
    unchanged: number;
    skipped: number;
    failed: number;
    complete: boolean | null;
  }>;
  organize_receipt_state: Readonly<{
    applyId: string;
    state: 'available' | 'page_delivered' | 'dismissed';
    total: number;
    changed: number;
    unchanged: number;
    skipped: number;
    failed: number;
    rowOffset: number | null;
    rowCount: number;
    nextRowOffset: number | null;
    filter: 'all' | 'changed_or_failed' | null;
  }>;
  organize_progress: Readonly<{
    phase: string;
    durableRevision: number;
    batchStart: number | null;
    batchEnd: number | null;
    frozen: number;
    analyzed: number;
    selected: number;
    applied: number;
    failed: number;
  }>;
  attempt_rejected: Readonly<{
    reason:
      | 'execution_epoch_mismatch'
      | 'acknowledged_attempt'
      | 'completed_revision'
      | 'active_session_conflict'
      | 'identity_conflict';
  }>;
  delivery_state: Readonly<{
    connectionEpochId: string;
    deliverySequence: number;
    deliveryKind: 'live' | 'replay' | 'authoritative_snapshot';
    durableRevision: number | null;
  }>;
  port_disconnected: Readonly<{
    connectionEpochId: string;
    lastDeliverySequence: number | null;
    attemptState: 'active' | 'terminal' | 'rejected';
  }>;
  trace_storage_state: Readonly<{
    state: 'flushed' | 'evicted' | 'capacity_exhausted' | 'append_failed' | 'reconciled';
    affectedEvents: number;
    affectedRoots: number;
    reasonCode: string | null;
  }>;
}>;

export type DevTraceEventData = DevTraceEventDataByKind[DevTraceEventKind];

export type DevTraceEvent = Readonly<{
  schemaVersion: typeof DEV_TRACE_SCHEMA_VERSION;
  eventId: string;
  rootOperationId: string;
  operationKind: DevTraceOperationKind;
  spanId: string;
  parentSpanId: string | null;
  sequence: number;
  wallTimeMs: number;
  clockSegmentId: string;
  monotonicOffsetMs: number;
  kind: DevTraceEventKind;
  data: DevTraceEventData;
}>;

export type TraceRootSummaryV1 = Readonly<{
  rootOperationId: string;
  operationKind: DevTraceOperationKind;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  terminalState: DevTraceTerminalState | null;
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
}>;

export type TraceSpanSummaryV1 = Readonly<{
  spanId: string;
  rootOperationId: string;
  parentSpanId: string | null;
  spanKind: string;
  startedAt: number;
  endedAt: number | null;
}>;

export type TraceSequenceGapV1 = Readonly<{
  rootOperationId: string;
  firstMissingSequence: number;
  lastMissingSequence: number;
  reason: 'reservation_lost' | 'persistence_failure' | 'capacity' | 'unknown';
}>;

export type TraceArtifactV1 = Readonly<{
  schemaVersion: typeof TRACE_ARTIFACT_SCHEMA_VERSION;
  exporterVersion: string;
  exportedAt: number;
  scope: Readonly<{
    kind: 'root' | 'session' | 'all_retained';
    id: string | null;
  }>;
  build: Readonly<{
    versionHash: string;
    extensionVersion: string;
    runtime: 'dev_page' | 'service_worker' | 'puppeteer';
    dev: true;
  }>;
  completeness: Readonly<{
    retainedFromMs: number | null;
    retainedToMs: number | null;
    evictedRootCount: number;
    droppedEventCount: number;
    truncatedFieldCount: number;
    unknownEventCount: number;
    activeBeforeTracing: boolean;
    sequenceGaps: readonly TraceSequenceGapV1[];
  }>;
  roots: readonly TraceRootSummaryV1[];
  spans: readonly TraceSpanSummaryV1[];
  events: readonly DevTraceEvent[];
  aggregates: Readonly<{
    rootCount: number;
    eventCount: number;
    failedRootCount: number;
  }>;
  integrity: Readonly<{
    rootCount: number;
    spanCount: number;
    eventCount: number;
  }>;
}>;

export function parseTraceArtifactJson(
  serialized: string,
  maxBytes = MAX_TRACE_ARTIFACT_BYTES,
): TraceArtifactV1 {
  if (utf8Bytes(serialized) > maxBytes) throw new TypeError('Trace artifact exceeds the size limit.');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new TypeError('Trace artifact is not valid JSON.');
  }
  return validateTraceArtifact(value);
}

export function validateTraceArtifact(value: unknown): TraceArtifactV1 {
  const artifact = record(value, 'Trace artifact');
  integer(artifact.schemaVersion, 'Trace artifact schemaVersion', 1);
  if (artifact.schemaVersion !== TRACE_ARTIFACT_SCHEMA_VERSION) {
    throw new TypeError('Trace artifact schema version is unsupported.');
  }
  nonEmptyString(artifact.exporterVersion, 'Trace artifact exporterVersion');
  finiteNumber(artifact.exportedAt, 'Trace artifact exportedAt', 0);
  validateScope(artifact.scope);
  validateBuild(artifact.build);
  validateCompleteness(artifact.completeness);
  const roots = array(artifact.roots, 'Trace artifact roots');
  const spans = array(artifact.spans, 'Trace artifact spans');
  const events = array(artifact.events, 'Trace artifact events');
  validateCounts(artifact.aggregates, artifact.integrity, roots.length, spans.length, events.length);

  const rootIds = new Set<string>();
  const rootsById = new Map<string, Record<string, unknown>>();
  for (const candidate of roots) {
    const root = validateRoot(candidate);
    if (rootIds.has(root.rootOperationId as string)) throw new TypeError('Trace artifact has a duplicate root ID.');
    rootIds.add(root.rootOperationId as string);
    rootsById.set(root.rootOperationId as string, root);
  }

  const spanIds = new Set<string>();
  for (const candidate of spans) {
    const span = validateSpan(candidate);
    if (!rootIds.has(span.rootOperationId as string)) throw new TypeError('Trace span references an unknown root.');
    if (spanIds.has(span.spanId as string)) throw new TypeError('Trace artifact has a duplicate span ID.');
    spanIds.add(span.spanId as string);
  }
  for (const candidate of spans) {
    const span = candidate as Record<string, unknown>;
    if (span.parentSpanId !== null && !spanIds.has(span.parentSpanId as string)) {
      throw new TypeError('Trace span references an unknown parent span.');
    }
  }

  const eventIds = new Set<string>();
  const previousSequence = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  for (const candidate of events) {
    const event = validateDevTraceEvent(candidate);
    if (!rootIds.has(event.rootOperationId)) throw new TypeError('Trace event references an unknown root.');
    if (!spanIds.has(event.spanId)) throw new TypeError('Trace event references an unknown span.');
    if (event.parentSpanId !== null && !spanIds.has(event.parentSpanId)) {
      throw new TypeError('Trace event references an unknown parent span.');
    }
    if (eventIds.has(event.eventId)) throw new TypeError('Trace artifact has a duplicate event ID.');
    eventIds.add(event.eventId);
    const previous = previousSequence.get(event.rootOperationId);
    if (previous !== undefined && event.sequence <= previous) {
      throw new TypeError('Trace event sequences are not strictly increasing per root.');
    }
    previousSequence.set(event.rootOperationId, event.sequence);
    eventCounts.set(event.rootOperationId, (eventCounts.get(event.rootOperationId) ?? 0) + 1);
  }

  for (const [rootId, root] of rootsById) {
    if (root.eventCount !== (eventCounts.get(rootId) ?? 0)) {
      throw new TypeError('Trace root event count does not match its events.');
    }
  }
  return value as TraceArtifactV1;
}

export function validateDevTraceEvent(value: unknown): DevTraceEvent {
  const event = record(value, 'Trace event');
  integer(event.schemaVersion, 'Trace event schemaVersion', 1);
  if (event.schemaVersion !== DEV_TRACE_SCHEMA_VERSION) throw new TypeError('Trace event schema version is unsupported.');
  nonEmptyString(event.eventId, 'Trace event eventId');
  nonEmptyString(event.rootOperationId, 'Trace event rootOperationId');
  enumValue(event.operationKind, DEV_TRACE_OPERATION_KINDS, 'Trace event operationKind');
  nonEmptyString(event.spanId, 'Trace event spanId');
  nullableString(event.parentSpanId, 'Trace event parentSpanId');
  integer(event.sequence, 'Trace event sequence', 1);
  finiteNumber(event.wallTimeMs, 'Trace event wallTimeMs', 0);
  nonEmptyString(event.clockSegmentId, 'Trace event clockSegmentId');
  finiteNumber(event.monotonicOffsetMs, 'Trace event monotonicOffsetMs', 0);
  enumValue(event.kind, DEV_TRACE_EVENT_KINDS, 'Trace event kind');
  validateEventData(event.kind as DevTraceEventKind, event.data);
  return value as DevTraceEvent;
}

function validateEventData(kind: DevTraceEventKind, value: unknown): void {
  const data = record(value, `Trace ${kind} data`);
  const schema = EVENT_DATA_SCHEMAS[kind];
  for (const [field, validator] of Object.entries(schema)) validator(data[field], field);
  if (kind === 'organize_generation_state') {
    const hasParent = data.parentRunId !== null && data.parentGeneration !== null;
    const requiresParent = data.cause === 'continuation';
    if (hasParent !== requiresParent) {
      throw new TypeError('OrganizeJobRun generation parent identity does not match its cause.');
    }
  }
  if (kind === 'organize_durable_state') {
    if ((data.missingFromRevision === null) !== (data.missingToRevision === null)) {
      throw new TypeError('OrganizeJobRun durable revision gap range must be complete.');
    }
    const hasGap = data.missingFromRevision !== null && data.missingToRevision !== null;
    if ((data.observation === 'gap_reconciled') !== hasGap) {
      throw new TypeError('OrganizeJobRun durable revision gap fields do not match its observation.');
    }
    if (
      hasGap &&
      ((data.missingFromRevision as number) > (data.missingToRevision as number) ||
        (data.missingToRevision as number) >= (data.revision as number))
    ) {
      throw new TypeError('OrganizeJobRun durable revision gap range is invalid.');
    }
  }
  if (kind === 'organize_selection_state' && (data.revision as number) <= (data.previousRevision as number)) {
    throw new TypeError('OrganizeJobRun selection revision must advance.');
  }
  if (kind === 'organize_apply_state') {
    const isAttempt = typeof data.state === 'string' && data.state.startsWith('attempt_');
    if (isAttempt !== (data.executionId !== null)) {
      throw new TypeError('OrganizeJobRun Apply execution identity does not match its state.');
    }
  }
  if (kind === 'organize_apply_chunk') {
    const hasStart = data.positionStart !== null;
    const hasEnd = data.positionEnd !== null;
    if (hasStart !== hasEnd) throw new TypeError('OrganizeJobRun Apply chunk position range must be complete.');
    if (hasStart && (data.positionEnd as number) <= (data.positionStart as number)) {
      throw new TypeError('OrganizeJobRun Apply chunk position range is invalid.');
    }
  }
  if (kind === 'organize_receipt_state') {
    const isPage = data.state === 'page_delivered';
    if (isPage !== (data.rowOffset !== null && data.filter !== null)) {
      throw new TypeError('OrganizeJobRun receipt page coordinates do not match its state.');
    }
  }
}

type FieldValidator = (value: unknown, label: string) => void;

const PROVIDER_REQUEST_KINDS = [
  'turn',
  'historical_summary',
  'active_turn_summary',
  'organize_analysis',
] as const;

const EVENT_DATA_SCHEMAS: Readonly<Record<DevTraceEventKind, Readonly<Record<string, FieldValidator>>>> = {
  root_started: {
    executionEpochId: requiredString,
    attemptId: nullableString,
    sessionId: nullableString,
    baseRevision: nullableInteger,
  },
  phase_changed: { phase: requiredString, previousPhase: nullableString },
  root_cancelled: { source: oneOf(['user', 'port', 'runtime', 'scenario']) },
  root_terminal: {
    state: oneOf(['completed', 'failed', 'cancelled', 'timed_out', 'attempt_state_lost']),
    reasonCode: nullableString,
    durationMs: nonNegativeNumber,
  },
  provider_request_prepared: {
    requestId: requiredString,
    requestKind: oneOf(PROVIDER_REQUEST_KINDS),
    providerStep: nullableInteger,
    requestAttempt: positiveInteger,
    providerClass: oneOf(['openai', 'openrouter', 'anthropic', 'custom']),
    protocol: oneOf(['chat_completions', 'responses', 'anthropic_messages']),
    modelCapabilityRevision: requiredString,
    requestBytes: nonNegativeInteger,
    historyBytes: nonNegativeInteger,
    estimatedInputTokens: nullableInteger,
    maxOutputTokens: nonNegativeInteger,
  },
  provider_response_started: { requestId: requiredString, requestKind: oneOf(PROVIDER_REQUEST_KINDS), providerStep: nullableInteger, requestAttempt: positiveInteger, latencyMs: nonNegativeNumber },
  provider_stream_item: {
    requestId: requiredString,
    requestKind: oneOf(PROVIDER_REQUEST_KINDS),
    providerStep: nullableInteger,
    requestAttempt: positiveInteger,
    streamClass: oneOf(['text', 'refusal', 'tool_start', 'tool_arguments', 'tool_end', 'usage', 'response_end']),
    utf8Bytes: nonNegativeInteger,
  },
  provider_usage: {
    requestId: requiredString,
    requestKind: oneOf(PROVIDER_REQUEST_KINDS),
    providerStep: nullableInteger,
    requestAttempt: positiveInteger,
    inputTokens: nullableInteger,
    outputTokens: nullableInteger,
    totalTokens: nullableInteger,
    source: oneOf(['provider', 'estimated']),
  },
  provider_finished: { requestId: requiredString, requestKind: oneOf(PROVIDER_REQUEST_KINDS), providerStep: nullableInteger, requestAttempt: positiveInteger, finishReason: requiredString, durationMs: nonNegativeNumber },
  provider_error: { requestId: requiredString, requestKind: oneOf(PROVIDER_REQUEST_KINDS), providerStep: nullableInteger, requestAttempt: positiveInteger, code: requiredString, status: nullableInteger, retryable: booleanValue, overflow: booleanValue },
  tool_queued: { providerStep: nonNegativeInteger, toolName: requiredString, toolClass: oneOf(['read', 'suggest', 'write']), risk: oneOf(['read', 'suggest', 'write']), toolCallId: requiredString },
  tool_authorized: { providerStep: nonNegativeInteger, toolName: requiredString, toolCallId: requiredString, decision: oneOf(['allow', 'deny', 'confirm']) },
  tool_started: { providerStep: nonNegativeInteger, toolName: requiredString, toolCallId: requiredString, attempt: positiveInteger },
  tool_result_admitted: {
    providerStep: nonNegativeInteger,
    toolName: requiredString,
    toolCallId: requiredString,
    originalBytes: nonNegativeInteger,
    admittedBytes: nonNegativeInteger,
    reduction: oneOf(['none', 'structural', 'error_envelope']),
  },
  tool_completed: { providerStep: nonNegativeInteger, toolName: requiredString, toolCallId: requiredString, outcome: oneOf(['success', 'error', 'cancelled']), durationMs: nullableNumber },
  tool_write_outcome: { providerStep: nonNegativeInteger, toolName: requiredString, toolCallId: requiredString, effectCount: nullableInteger, state: oneOf(['committed', 'unchanged', 'failed', 'unknown']) },
  context_preflight: {
    requestId: requiredString,
    requestKind: oneOf(PROVIDER_REQUEST_KINDS),
    providerStep: nullableInteger,
    requestAttempt: positiveInteger,
    workingWindowTokens: positiveInteger,
    reserveTokens: nonNegativeInteger,
    estimatedInputTokens: nonNegativeInteger,
    requestBytes: nonNegativeInteger,
    historyBytes: nonNegativeInteger,
    decision: oneOf(['admit', 'reduce', 'irreducible']),
    reasonCode: nullableString,
  },
  context_reduction_started: { providerStep: nullableInteger, episode: positiveInteger, trigger: oneOf(['threshold', 'provider_overflow', 'history_bytes', 'request_bytes']), splitActiveTurn: nullableBoolean },
  context_reduction_finished: { providerStep: nullableInteger, episode: positiveInteger, outcome: oneOf(['summary', 'corrected_summary', 'fallback', 'failed', 'cancelled']), projectedTokens: nullableInteger, projectedBytes: nullableInteger },
  continuation_started: { providerStep: nonNegativeInteger, episode: positiveInteger, attempt: positiveInteger, reason: requiredString },
  continuation_finished: { providerStep: nonNegativeInteger, episode: positiveInteger, attempt: positiveInteger, outcome: oneOf(['continued', 'failed', 'cancelled', 'exhausted']) },
  watchdog_state: { watchdog: oneOf(['first_response', 'stream_idle', 'agent_idle', 'absolute_turn', 'organize_heartbeat', 'organize_wall_deadline']), state: oneOf(['armed', 'progress', 'expired', 'cancelled']), limitMs: positiveInteger },
  organize_preflight_state: {
    state: oneOf(['requested', 'ready', 'no_work', 'started', 'cancelled', 'expired', 'stale', 'disconnected', 'worker_lost']),
    repositoryCount: nullableInteger,
  },
  organize_generation_state: {
    runId: requiredString,
    generation: nonNegativeInteger,
    state: oneOf(['frozen', 'prepared', 'restored']),
    cause: oneOf(['initial', 'continuation', 'restore']),
    parentRunId: nullableString,
    parentGeneration: nullableInteger,
    repositoryCount: nonNegativeInteger,
  },
  organize_batch_state: {
    runId: requiredString,
    generation: nonNegativeInteger,
    batchStart: nonNegativeInteger,
    batchEnd: nonNegativeInteger,
    repositoryCount: nonNegativeInteger,
    localOnlyCount: nonNegativeInteger,
    providerCount: nonNegativeInteger,
    state: oneOf(['scheduled', 'loaded', 'split', 'local_only_completed', 'provider_completed', 'analysis_failed', 'budget_exhausted', 'cancelled']),
  },
  organize_provider_attempt: {
    runId: requiredString,
    generation: nonNegativeInteger,
    batchStart: nonNegativeInteger,
    batchEnd: nonNegativeInteger,
    attempt: oneOf([1, 2]),
    state: oneOf(['prepared', 'admitted', 'succeeded', 'failed', 'budget_exhausted', 'cancelled']),
    requestBytes: nonNegativeInteger,
    requestedOutputTokens: positiveInteger,
    inputTokens: nullableInteger,
    outputTokens: nullableInteger,
    totalTokens: nullableInteger,
    reasonCode: nullableString,
  },
  organize_durable_state: {
    revision: nonNegativeInteger,
    previousRevision: nullableInteger,
    observation: oneOf(['initial', 'advanced', 'duplicate', 'stale', 'gap_reconciled']),
    missingFromRevision: nullableInteger,
    missingToRevision: nullableInteger,
    source: oneOf(['mutation', 'restore', 'reconnect']),
  },
  organize_review_state: {
    runId: requiredString,
    generation: nonNegativeInteger,
    revision: nonNegativeInteger,
    state: oneOf(['ready', 'page_delivered']),
    actionableRepositories: nonNegativeInteger,
    selectedRepositories: nonNegativeInteger,
    selectedActions: nonNegativeInteger,
    rowOffset: nullableInteger,
    rowCount: nonNegativeInteger,
    nextRowOffset: nullableInteger,
  },
  organize_selection_state: {
    runId: requiredString,
    generation: nonNegativeInteger,
    previousRevision: nonNegativeInteger,
    revision: nonNegativeInteger,
    mode: oneOf(['partial', 'all']),
    affectedRepositories: nonNegativeInteger,
    selectedRepositories: nonNegativeInteger,
    selectedActions: nonNegativeInteger,
  },
  organize_apply_state: {
    applyId: requiredString,
    executionId: nullableString,
    revision: nullableInteger,
    state: oneOf(['sealed', 'resumed', 'pause_requested', 'paused', 'attempt_started', 'attempt_idle', 'attempt_completed', 'attempt_failed', 'completed']),
    total: nullableInteger,
    settled: nullableInteger,
    changed: nullableInteger,
    unchanged: nullableInteger,
    skipped: nullableInteger,
    failed: nullableInteger,
  },
  organize_apply_chunk: {
    applyId: requiredString,
    executionId: requiredString,
    chunkSequence: positiveInteger,
    state: oneOf(['claimed', 'settled']),
    positionStart: nullableInteger,
    positionEnd: nullableInteger,
    rowCount: nonNegativeInteger,
    maxAttemptCount: nullableInteger,
    changed: nonNegativeInteger,
    unchanged: nonNegativeInteger,
    skipped: nonNegativeInteger,
    failed: nonNegativeInteger,
    complete: nullableBoolean,
  },
  organize_receipt_state: {
    applyId: requiredString,
    state: oneOf(['available', 'page_delivered', 'dismissed']),
    total: nonNegativeInteger,
    changed: nonNegativeInteger,
    unchanged: nonNegativeInteger,
    skipped: nonNegativeInteger,
    failed: nonNegativeInteger,
    rowOffset: nullableInteger,
    rowCount: nonNegativeInteger,
    nextRowOffset: nullableInteger,
    filter: (value, label) => {
      if (value === null) return;
      oneOf(['all', 'changed_or_failed'])(value, label);
    },
  },
  organize_progress: {
    phase: requiredString,
    durableRevision: nonNegativeInteger,
    batchStart: nullableInteger,
    batchEnd: nullableInteger,
    frozen: nonNegativeInteger,
    analyzed: nonNegativeInteger,
    selected: nonNegativeInteger,
    applied: nonNegativeInteger,
    failed: nonNegativeInteger,
  },
  attempt_rejected: {
    reason: oneOf(['execution_epoch_mismatch', 'acknowledged_attempt', 'completed_revision', 'active_session_conflict', 'identity_conflict']),
  },
  delivery_state: { connectionEpochId: requiredString, deliverySequence: nonNegativeInteger, deliveryKind: oneOf(['live', 'replay', 'authoritative_snapshot']), durableRevision: nullableInteger },
  port_disconnected: { connectionEpochId: requiredString, lastDeliverySequence: nullableInteger, attemptState: oneOf(['active', 'terminal', 'rejected']) },
  trace_storage_state: { state: oneOf(['flushed', 'evicted', 'capacity_exhausted', 'append_failed', 'reconciled']), affectedEvents: nonNegativeInteger, affectedRoots: nonNegativeInteger, reasonCode: nullableString },
};

function validateScope(value: unknown): void {
  const scope = record(value, 'Trace artifact scope');
  enumValue(scope.kind, ['root', 'session', 'all_retained'] as const, 'Trace artifact scope kind');
  nullableString(scope.id, 'Trace artifact scope id');
  if (scope.kind !== 'all_retained' && scope.id === null) throw new TypeError('Selected trace scope requires an ID.');
  if (scope.kind === 'all_retained' && scope.id !== null) throw new TypeError('All-retained trace scope cannot have an ID.');
}

function validateBuild(value: unknown): void {
  const build = record(value, 'Trace artifact build');
  nonEmptyString(build.versionHash, 'Trace artifact build versionHash');
  nonEmptyString(build.extensionVersion, 'Trace artifact build extensionVersion');
  enumValue(build.runtime, ['dev_page', 'service_worker', 'puppeteer'] as const, 'Trace artifact build runtime');
  if (build.dev !== true) throw new TypeError('Trace artifacts must come from a development build.');
}

function validateCompleteness(value: unknown): void {
  const completeness = record(value, 'Trace artifact completeness');
  nullableNumber(completeness.retainedFromMs, 'retainedFromMs');
  nullableNumber(completeness.retainedToMs, 'retainedToMs');
  nonNegativeInteger(completeness.evictedRootCount, 'evictedRootCount');
  nonNegativeInteger(completeness.droppedEventCount, 'droppedEventCount');
  nonNegativeInteger(completeness.truncatedFieldCount, 'truncatedFieldCount');
  nonNegativeInteger(completeness.unknownEventCount, 'unknownEventCount');
  booleanValue(completeness.activeBeforeTracing, 'activeBeforeTracing');
  for (const candidate of array(completeness.sequenceGaps, 'sequenceGaps')) {
    const gap = record(candidate, 'Trace sequence gap');
    nonEmptyString(gap.rootOperationId, 'Trace sequence gap rootOperationId');
    positiveInteger(gap.firstMissingSequence, 'firstMissingSequence');
    positiveInteger(gap.lastMissingSequence, 'lastMissingSequence');
    if ((gap.lastMissingSequence as number) < (gap.firstMissingSequence as number)) throw new TypeError('Trace sequence gap is reversed.');
    enumValue(gap.reason, ['reservation_lost', 'persistence_failure', 'capacity', 'unknown'] as const, 'Trace sequence gap reason');
  }
}

function validateRoot(value: unknown): Record<string, unknown> {
  const root = record(value, 'Trace root');
  nonEmptyString(root.rootOperationId, 'Trace root rootOperationId');
  enumValue(root.operationKind, DEV_TRACE_OPERATION_KINDS, 'Trace root operationKind');
  nullableString(root.sessionId, 'Trace root sessionId');
  finiteNumber(root.startedAt, 'Trace root startedAt', 0);
  nullableNumber(root.endedAt, 'Trace root endedAt');
  if (root.terminalState !== null) enumValue(root.terminalState, ['completed', 'failed', 'cancelled', 'timed_out', 'attempt_state_lost'] as const, 'Trace root terminalState');
  positiveInteger(root.firstSequence, 'Trace root firstSequence');
  positiveInteger(root.lastSequence, 'Trace root lastSequence');
  nonNegativeInteger(root.eventCount, 'Trace root eventCount');
  return root;
}

function validateSpan(value: unknown): Record<string, unknown> {
  const span = record(value, 'Trace span');
  nonEmptyString(span.spanId, 'Trace span spanId');
  nonEmptyString(span.rootOperationId, 'Trace span rootOperationId');
  nullableString(span.parentSpanId, 'Trace span parentSpanId');
  nonEmptyString(span.spanKind, 'Trace span spanKind');
  finiteNumber(span.startedAt, 'Trace span startedAt', 0);
  nullableNumber(span.endedAt, 'Trace span endedAt');
  return span;
}

function validateCounts(aggregatesValue: unknown, integrityValue: unknown, roots: number, spans: number, events: number): void {
  const aggregates = record(aggregatesValue, 'Trace artifact aggregates');
  const integrity = record(integrityValue, 'Trace artifact integrity');
  nonNegativeInteger(aggregates.rootCount, 'Trace aggregate rootCount');
  nonNegativeInteger(aggregates.eventCount, 'Trace aggregate eventCount');
  nonNegativeInteger(aggregates.failedRootCount, 'Trace aggregate failedRootCount');
  nonNegativeInteger(integrity.rootCount, 'Trace integrity rootCount');
  nonNegativeInteger(integrity.spanCount, 'Trace integrity spanCount');
  nonNegativeInteger(integrity.eventCount, 'Trace integrity eventCount');
  if (aggregates.rootCount !== roots || aggregates.eventCount !== events || integrity.rootCount !== roots || integrity.spanCount !== spans || integrity.eventCount !== events) {
    throw new TypeError('Trace artifact integrity counts do not match its records.');
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
}

function requiredString(value: unknown, label: string): void {
  nonEmptyString(value, label);
}

function nullableString(value: unknown, label: string): void {
  if (value !== null) nonEmptyString(value, label);
}

function finiteNumber(value: unknown, label: string, minimum = Number.NEGATIVE_INFINITY): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new TypeError(`${label} must be a finite number.`);
}

function nullableNumber(value: unknown, label: string): void {
  if (value !== null) finiteNumber(value, label, 0);
}

function integer(value: unknown, label: string, minimum = Number.MIN_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`${label} must be an integer.`);
}

function nonNegativeInteger(value: unknown, label: string): void {
  integer(value, label, 0);
}

function positiveInteger(value: unknown, label: string): void {
  integer(value, label, 1);
}

function nullableInteger(value: unknown, label: string): void {
  if (value !== null) integer(value, label, 0);
}

function nonNegativeNumber(value: unknown, label: string): void {
  finiteNumber(value, label, 0);
}

function booleanValue(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean.`);
}

function nullableBoolean(value: unknown, label: string): void {
  if (value !== null) booleanValue(value, label);
}

function oneOf<const T extends readonly (string | number)[]>(values: T): FieldValidator {
  return (value, label) => enumValue(value, values, label);
}

function enumValue<const T extends readonly (string | number)[]>(value: unknown, values: T, label: string): asserts value is T[number] {
  if (!values.includes(value as T[number])) throw new TypeError(`${label} is invalid.`);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
