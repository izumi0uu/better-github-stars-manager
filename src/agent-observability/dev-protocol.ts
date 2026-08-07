import type { TraceArtifactV1 } from './contracts';
import type { RawCaptureField } from './redaction';

export const DEV_TRACE_EVIDENCE_PORT = 'bgsm-agent-dev-evidence-v1';
export const DEV_TRACE_CONTROL_PORT = 'bgsm-agent-dev-control-v1';
export const DEV_TRACE_PROTOCOL_VERSION = 1 as const;
export const DEV_TRACE_SNAPSHOT_CHUNK_MIN_BYTES = 4 * 1024;
export const DEV_TRACE_SNAPSHOT_CHUNK_MAX_BYTES = 256 * 1024;

export const DEV_TRACE_SCENARIO_IDS = [
  'small-window-multiple-tools',
  'overflow-then-success',
  'malformed-summary-fallback',
  'cancel-during-compaction',
  'agent-port-disconnect',
  'organize-cross-batch-recovery',
  'organize-cancel-during-apply',
  'organize-port-reconnect',
  'cubby-artifact-continuation-coverage',
] as const;

export type DevTraceScenarioId = typeof DEV_TRACE_SCENARIO_IDS[number];
export type DevTraceScope = TraceArtifactV1['scope'];
export type DevProviderMonitorState = Readonly<{
  sessionId: string;
  startedAt: number;
  expiresAt: number;
}>;

export type DevTraceEvidenceRequest =
  | Readonly<{ version: 1; requestId: string; type: 'subscribe'; cursor: string | null }>
  | Readonly<{ version: 1; requestId: string; type: 'get_snapshot'; scope: DevTraceScope; cursor: string | null; maxBytes: number }>
  | Readonly<{ version: 1; requestId: string; type: 'export'; scope: DevTraceScope; cursor: string | null; maxBytes: number }>;

export type DevTraceControlRequest =
  | Readonly<{ version: 1; requestId: string; type: 'arm_raw_capture' }>
  | Readonly<{ version: 1; requestId: string; type: 'disarm_raw_capture' }>
  | Readonly<{ version: 1; requestId: string; type: 'run_scenario'; scenarioId: DevTraceScenarioId; controls: Readonly<{ delayMs: number; contextWindow: number }> }>
  | Readonly<{ version: 1; requestId: string; type: 'start_provider_monitor'; state: DevProviderMonitorState }>
  | Readonly<{ version: 1; requestId: string; type: 'stop_provider_monitor' }>
  | Readonly<{ version: 1; requestId: string; type: 'get_provider_monitor_status' }>
  | Readonly<{ version: 1; requestId: string; type: 'clear_traces'; confirmation: 'clear-local-agent-traces' }>;

export type DevTraceEvidenceChunk = Readonly<{
  version: 1;
  requestId: string;
  type: 'snapshot_chunk' | 'export_chunk';
  snapshotId: string;
  cursor: string | null;
  chunkIndex: number;
  byteLength: number;
  done: boolean;
  jsonChunk: string;
}>;

export type DevTraceEvidenceError = Readonly<{
  version: 1;
  requestId: string;
  type: 'evidence_error';
  code: 'invalid_request' | 'invalid_cursor' | 'internal_error';
}>;

export type DevTraceEvidenceResponse = DevTraceEvidenceChunk | DevTraceEvidenceError;

export type DevTracePortReady = Readonly<{
  version: 1;
  type: 'ready';
  port: 'evidence' | 'control';
}>;

export type DevRawCaptureContentKind =
  | 'provider_prompt'
  | 'provider_response'
  | 'provider_refusal'
  | 'tool_arguments'
  | 'tool_result';

export type DevRawCaptureEventData =
  | Readonly<{ kind: 'root_started' }>
  | Readonly<{
      kind: DevRawCaptureContentKind;
      requestId: string | null;
      requestKind: 'turn' | 'historical_summary' | 'active_turn_summary' | 'organize_analysis' | null;
      providerStep: number | null;
      requestAttempt: number | null;
      toolName: string | null;
      toolNameTruncated: boolean;
      toolCallId: string | null;
      toolCallIdTruncated: boolean;
      content: RawCaptureField;
    }>
  | Readonly<{
      kind: 'evidence_dropped';
      reason: 'event_limit' | 'root_limit' | 'pending_queue_limit';
      droppedEventCount: number;
      droppedBytes: number;
    }>
  | Readonly<{
      kind: 'capture_completed';
      reason: string;
      contentEventCount: number;
      truncatedFieldCount: number;
      droppedEventCount: number;
      droppedBytes: number;
      retainedBytes: number;
    }>;

export type DevRawCaptureEvent = Readonly<{
  version: 1;
  type: 'raw_capture_event';
  captureId: string;
  rootOperationId: string;
  sequence: number;
  event: DevRawCaptureEventData;
}>;

export type DevTraceControlResponse =
  | Readonly<{
      version: 1;
      requestId: string;
      type: 'control_result';
      action: 'cleared';
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      type: 'control_result';
      action: 'scenario_completed';
      scenarioId: DevTraceScenarioId;
      rootOperationIds: readonly string[];
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      type: 'control_result';
      action: 'raw_capture_armed';
      captureId: string;
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      type: 'control_result';
      action: 'raw_capture_disarmed';
      captureId: string | null;
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      type: 'control_result';
      action: 'provider_monitor_started' | 'provider_monitor_status';
      state: DevProviderMonitorState | null;
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      type: 'control_result';
      action: 'provider_monitor_stopped';
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      type: 'control_error';
      code: 'unavailable' | 'invalid_request' | 'internal_error';
    }>;

export type DevTracePortResponse =
  | DevTraceEvidenceResponse
  | DevTraceControlResponse
  | DevRawCaptureEvent
  | DevTracePortReady;

export function validateDevTraceEvidenceRequest(value: unknown): DevTraceEvidenceRequest {
  const request = exactRecord(value, ['version', 'requestId', 'type', 'cursor', 'scope', 'maxBytes'], 'Evidence request', true);
  commonRequest(request);
  if (request.type === 'subscribe') {
    exactKeys(request, ['version', 'requestId', 'type', 'cursor'], 'Evidence subscribe request');
    nullableString(request.cursor, 'Evidence cursor');
  } else if (request.type === 'get_snapshot' || request.type === 'export') {
    exactKeys(request, ['version', 'requestId', 'type', 'scope', 'cursor', 'maxBytes'], 'Evidence snapshot request');
    validateScope(request.scope);
    nullableString(request.cursor, 'Evidence cursor');
    integerRange(
      request.maxBytes,
      DEV_TRACE_SNAPSHOT_CHUNK_MIN_BYTES,
      DEV_TRACE_SNAPSHOT_CHUNK_MAX_BYTES,
      'Evidence maxBytes',
    );
  } else {
    throw new TypeError('Evidence request type is invalid.');
  }
  return value as DevTraceEvidenceRequest;
}

export function validateDevTraceControlRequest(value: unknown): DevTraceControlRequest {
  const request = exactRecord(value, ['version', 'requestId', 'type', 'scenarioId', 'controls', 'state', 'confirmation'], 'Control request', true);
  commonRequest(request);
  if (request.type === 'arm_raw_capture' || request.type === 'disarm_raw_capture') {
    exactKeys(request, ['version', 'requestId', 'type'], 'Raw capture request');
  } else if (request.type === 'run_scenario') {
    exactKeys(request, ['version', 'requestId', 'type', 'scenarioId', 'controls'], 'Scenario request');
    if (!DEV_TRACE_SCENARIO_IDS.includes(request.scenarioId as DevTraceScenarioId)) throw new TypeError('Scenario ID is invalid.');
    const controls = exactRecord(request.controls, ['delayMs', 'contextWindow'], 'Scenario controls');
    integerRange(controls.delayMs, 0, 30_000, 'Scenario delayMs');
    integerRange(controls.contextWindow, 4_096, 1_000_000, 'Scenario contextWindow');
  } else if (request.type === 'start_provider_monitor') {
    exactKeys(request, ['version', 'requestId', 'type', 'state'], 'Start Provider monitor request');
    validateProviderMonitorState(request.state);
  } else if (
    request.type === 'stop_provider_monitor'
    || request.type === 'get_provider_monitor_status'
  ) {
    exactKeys(request, ['version', 'requestId', 'type'], 'Provider monitor request');
  } else if (request.type === 'clear_traces') {
    exactKeys(request, ['version', 'requestId', 'type', 'confirmation'], 'Clear traces request');
    if (request.confirmation !== 'clear-local-agent-traces') throw new TypeError('Clear traces confirmation is invalid.');
  } else {
    throw new TypeError('Control request type is invalid.');
  }
  return value as DevTraceControlRequest;
}

function validateProviderMonitorState(value: unknown): void {
  const state = exactRecord(value, ['sessionId', 'startedAt', 'expiresAt'], 'Provider monitor state');
  boundedString(state.sessionId, 'Provider monitor sessionId');
  if (
    (state.sessionId as string).length > 128
    || !/^[a-zA-Z0-9:_-]+$/u.test(state.sessionId as string)
  ) throw new TypeError('Provider monitor sessionId is invalid.');
  integerRange(state.startedAt, 0, Number.MAX_SAFE_INTEGER, 'Provider monitor startedAt');
  integerRange(state.expiresAt, 0, Number.MAX_SAFE_INTEGER, 'Provider monitor expiresAt');
  if ((state.expiresAt as number) <= (state.startedAt as number)) {
    throw new TypeError('Provider monitor expiry must follow its start time.');
  }
}

function commonRequest(request: Record<string, unknown>): void {
  if (request.version !== DEV_TRACE_PROTOCOL_VERSION) throw new TypeError('Development trace protocol version is unsupported.');
  boundedString(request.requestId, 'Development trace requestId');
}

function validateScope(value: unknown): void {
  const scope = exactRecord(value, ['kind', 'id'], 'Development trace scope');
  if (scope.kind !== 'root' && scope.kind !== 'session' && scope.kind !== 'all_retained') throw new TypeError('Development trace scope kind is invalid.');
  nullableString(scope.id, 'Development trace scope ID');
  if (scope.kind === 'all_retained' ? scope.id !== null : scope.id === null) throw new TypeError('Development trace scope ID does not match its kind.');
}

function exactRecord(value: unknown, allowed: readonly string[], label: string, allowSubset = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} contains an unknown field.`);
  }
  if (!allowSubset) exactKeys(record, allowed, label);
  return record;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function nonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
}

function nullableString(value: unknown, label: string): void {
  if (value !== null) boundedString(value, label);
}

function boundedString(value: unknown, label: string): void {
  nonEmptyString(value, label);
  if (new TextEncoder().encode(value as string).byteLength > 512) {
    throw new TypeError(`${label} exceeds the size limit.`);
  }
}

function integerRange(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} is outside the allowed range.`);
  }
}
