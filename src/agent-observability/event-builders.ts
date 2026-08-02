import {
  DEV_TRACE_SCHEMA_VERSION,
  type DevTraceEvent,
  type DevTraceEventDataByKind,
  type DevTraceEventKind,
  type DevTraceOperationKind,
  validateDevTraceEvent,
} from './contracts';

export type DevTraceEventEnvelope = Readonly<{
  eventId: string;
  rootOperationId: string;
  operationKind: DevTraceOperationKind;
  spanId: string;
  parentSpanId: string | null;
  sequence: number;
  wallTimeMs: number;
  clockSegmentId: string;
  monotonicOffsetMs: number;
}>;

export type DevTraceEventInput = {
  [Kind in DevTraceEventKind]: Readonly<{
    kind: Kind;
    data: DevTraceEventDataByKind[Kind];
  }>;
}[DevTraceEventKind];

export function buildDevTraceEvent(
  envelope: DevTraceEventEnvelope,
  input: DevTraceEventInput,
): DevTraceEvent {
  const event = {
    schemaVersion: DEV_TRACE_SCHEMA_VERSION,
    eventId: envelope.eventId,
    rootOperationId: envelope.rootOperationId,
    operationKind: envelope.operationKind,
    spanId: envelope.spanId,
    parentSpanId: envelope.parentSpanId,
    sequence: envelope.sequence,
    wallTimeMs: envelope.wallTimeMs,
    clockSegmentId: envelope.clockSegmentId,
    monotonicOffsetMs: envelope.monotonicOffsetMs,
    kind: input.kind,
    data: copyAllowlistedData(input.kind, input.data),
  } as DevTraceEvent;
  validateDevTraceEvent(event);
  return deepFreeze(event);
}

function copyAllowlistedData(kind: DevTraceEventKind, input: unknown): DevTraceEvent['data'] {
  const value = input as Record<string, unknown>;
  switch (kind) {
    case 'root_started': return pick(value, ['executionEpochId', 'attemptId', 'sessionId', 'baseRevision']);
    case 'phase_changed': return pick(value, ['phase', 'previousPhase']);
    case 'root_cancelled': return pick(value, ['source']);
    case 'root_terminal': return pick(value, ['state', 'reasonCode', 'durationMs']);
    case 'provider_request_prepared': return pick(value, ['requestId', 'requestKind', 'providerStep', 'requestAttempt', 'providerClass', 'protocol', 'modelCapabilityRevision', 'requestBytes', 'historyBytes', 'estimatedInputTokens', 'maxOutputTokens']);
    case 'provider_response_started': return pick(value, ['requestId', 'requestKind', 'providerStep', 'requestAttempt', 'latencyMs']);
    case 'provider_stream_item': return pick(value, ['requestId', 'requestKind', 'providerStep', 'requestAttempt', 'streamClass', 'utf8Bytes']);
    case 'provider_usage': return pick(value, ['requestId', 'requestKind', 'providerStep', 'requestAttempt', 'inputTokens', 'outputTokens', 'totalTokens', 'source']);
    case 'provider_finished': return pick(value, ['requestId', 'requestKind', 'providerStep', 'requestAttempt', 'finishReason', 'durationMs']);
    case 'provider_error': return pick(value, ['requestId', 'requestKind', 'providerStep', 'requestAttempt', 'code', 'status', 'retryable', 'overflow']);
    case 'tool_queued': return pick(value, ['providerStep', 'toolName', 'toolClass', 'risk', 'toolCallId']);
    case 'tool_authorized': return pick(value, ['providerStep', 'toolName', 'toolCallId', 'decision']);
    case 'tool_started': return pick(value, ['providerStep', 'toolName', 'toolCallId', 'attempt']);
    case 'tool_result_admitted': return pick(value, ['providerStep', 'toolName', 'toolCallId', 'originalBytes', 'admittedBytes', 'reduction']);
    case 'tool_completed': return pick(value, ['providerStep', 'toolName', 'toolCallId', 'outcome', 'durationMs']);
    case 'tool_write_outcome': return pick(value, ['providerStep', 'toolName', 'toolCallId', 'effectCount', 'state']);
    case 'context_preflight': return pick(value, ['requestId', 'requestKind', 'providerStep', 'requestAttempt', 'workingWindowTokens', 'reserveTokens', 'estimatedInputTokens', 'requestBytes', 'historyBytes', 'decision', 'reasonCode']);
    case 'context_reduction_started': return pick(value, ['providerStep', 'episode', 'trigger', 'splitActiveTurn']);
    case 'context_reduction_finished': return pick(value, ['providerStep', 'episode', 'outcome', 'projectedTokens', 'projectedBytes']);
    case 'continuation_started': return pick(value, ['providerStep', 'episode', 'attempt', 'reason']);
    case 'continuation_finished': return pick(value, ['providerStep', 'episode', 'attempt', 'outcome']);
    case 'watchdog_state': return pick(value, ['watchdog', 'state', 'limitMs']);
    case 'organize_preflight_state': return pick(value, ['state', 'repositoryCount']);
    case 'organize_generation_state': return pick(value, ['runId', 'generation', 'state', 'cause', 'parentRunId', 'parentGeneration', 'repositoryCount']);
    case 'organize_batch_state': return pick(value, ['runId', 'generation', 'batchStart', 'batchEnd', 'repositoryCount', 'localOnlyCount', 'providerCount', 'state']);
    case 'organize_provider_attempt': return pick(value, ['runId', 'generation', 'batchStart', 'batchEnd', 'attempt', 'state', 'requestBytes', 'requestedOutputTokens', 'inputTokens', 'outputTokens', 'totalTokens', 'reasonCode']);
    case 'organize_durable_state': return pick(value, ['revision', 'previousRevision', 'observation', 'missingFromRevision', 'missingToRevision', 'source']);
    case 'organize_restore_state': return pick(value, ['state', 'reasonCode']);
    case 'organize_review_state': return pick(value, ['runId', 'generation', 'revision', 'state', 'actionableRepositories', 'selectedRepositories', 'selectedActions', 'rowOffset', 'rowCount', 'nextRowOffset']);
    case 'organize_selection_state': return pick(value, ['runId', 'generation', 'previousRevision', 'revision', 'mode', 'affectedRepositories', 'selectedRepositories', 'selectedActions']);
    case 'organize_apply_state': return pick(value, ['applyId', 'executionId', 'revision', 'state', 'total', 'settled', 'changed', 'unchanged', 'skipped', 'failed']);
    case 'organize_apply_chunk': return pick(value, ['applyId', 'executionId', 'chunkSequence', 'state', 'positionStart', 'positionEnd', 'rowCount', 'maxAttemptCount', 'changed', 'unchanged', 'skipped', 'failed', 'complete']);
    case 'organize_receipt_state': return pick(value, ['applyId', 'state', 'total', 'changed', 'unchanged', 'skipped', 'failed', 'rowOffset', 'rowCount', 'nextRowOffset', 'filter']);
    case 'organize_progress': return pick(value, ['phase', 'durableRevision', 'batchStart', 'batchEnd', 'frozen', 'analyzed', 'selected', 'applied', 'failed']);
    case 'attempt_rejected': return pick(value, ['reason']);
    case 'delivery_state': return pick(value, ['connectionEpochId', 'deliverySequence', 'deliveryKind', 'durableRevision']);
    case 'result_acknowledged': return pick(value, ['disposition', 'appliedRevision']);
    case 'port_disconnected': return pick(value, ['connectionEpochId', 'lastDeliverySequence', 'attemptState']);
    case 'trace_storage_state': return pick(value, ['state', 'affectedEvents', 'affectedRoots', 'reasonCode']);
  }
}

function pick(value: Record<string, unknown>, keys: readonly string[]): DevTraceEvent['data'] {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as DevTraceEvent['data'];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
