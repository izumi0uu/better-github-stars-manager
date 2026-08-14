import type {
  AgentProviderConnectionFailureDetails,
} from '@/agent-harness/provider-registry';

export const PROVIDER_DIAGNOSTICS_BRIDGE_BASE_PATH = '/__bgsm/diagnostics/provider';
export const PROVIDER_DIAGNOSTICS_BRIDGE_PATH = `${PROVIDER_DIAGNOSTICS_BRIDGE_BASE_PATH}/latest`;
export const PROVIDER_DIAGNOSTICS_EVENTS_PATH = `${PROVIDER_DIAGNOSTICS_BRIDGE_BASE_PATH}/events`;
export const PROVIDER_DIAGNOSTICS_HEALTH_PATH = `${PROVIDER_DIAGNOSTICS_BRIDGE_BASE_PATH}/health`;
export const PROVIDER_DIAGNOSTICS_BRIDGE_URL =
  `http://127.0.0.1:5173${PROVIDER_DIAGNOSTICS_BRIDGE_PATH}`;
export const PROVIDER_DIAGNOSTICS_EVENTS_URL =
  `http://127.0.0.1:5173${PROVIDER_DIAGNOSTICS_EVENTS_PATH}`;
export const PROVIDER_DIAGNOSTICS_HEALTH_URL =
  `http://127.0.0.1:5173${PROVIDER_DIAGNOSTICS_HEALTH_PATH}`;
export const PROVIDER_DIAGNOSTICS_BRIDGE_PERMISSION = 'http://127.0.0.1/*';
export const PROVIDER_DIAGNOSTICS_TTL_MS = 15 * 60 * 1_000;
export const PROVIDER_DIAGNOSTICS_MAX_BYTES = 32 * 1_024;
export const PROVIDER_DIAGNOSTICS_EVENT_LIMIT = 200;

export type ProviderDiagnosticsProbe = Readonly<{
  state: 'not_run' | 'running' | 'succeeded' | 'failed';
  startedAt: number | null;
  completedAt: number | null;
  latencyMs: number | null;
  failure: AgentProviderConnectionFailureDetails | null;
}>;

export type ProviderDiagnosticsShare = Readonly<{
  schemaVersion: 1;
  generatedAt: number;
  source: Readonly<{
    versionHash: string;
    runtime: 'chrome-extension';
  }>;
  privacy: Readonly<{
    credentialsIncluded: false;
    rawCaptureIncluded: false;
    chatContentIncluded: false;
    providerResponseContentIncluded: false;
  }>;
  provider: Readonly<{
    id: string;
    label: string;
    protocol: string;
    canonicalOrigin: string;
    canonicalBaseUrl: string;
    completionEndpoint: string;
    model: string;
    credentialState: 'saved' | 'missing';
    hostAccess: 'checking' | 'built-in' | 'granted' | 'required';
    declaredContextWindow: number | null;
    workingContextWindow: number | null;
    capability: Readonly<{
      contextWindow: number | null;
      source: string | null;
      verifiedAt: number;
      fingerprint: string;
    }> | null;
  }>;
  probe: ProviderDiagnosticsProbe;
}>;

export const PROVIDER_DIAGNOSTICS_EVENT_KINDS = [
  'monitor_started',
  'configuration_changed',
  'probe_started',
  'probe_succeeded',
  'probe_failed',
  'provider_request_prepared',
  'provider_response_started',
  'provider_stream_activity',
  'provider_usage',
  'provider_finished',
  'provider_error',
] as const;

export type ProviderDiagnosticsEventKind = typeof PROVIDER_DIAGNOSTICS_EVENT_KINDS[number];
export type ProviderDiagnosticsEventData = Readonly<Record<
  string,
  string | number | boolean | null
>>;

export type ProviderDiagnosticsMonitorEvent = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  emittedAt: number;
  kind: ProviderDiagnosticsEventKind;
  rootOperationId: string | null;
  requestId: string | null;
  data: ProviderDiagnosticsEventData;
}>;

export type ProviderDiagnosticsEventPost = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  startedAt: number;
  expiresAt: number;
  event: ProviderDiagnosticsMonitorEvent;
  report?: ProviderDiagnosticsShare;
}>;

export type ProviderDiagnosticsStoredEvent = Readonly<{
  sequence: number;
  receivedAt: number;
  event: ProviderDiagnosticsMonitorEvent;
}>;

export type ProviderDiagnosticsBridgeRecord = Readonly<{
  bridgeVersion: 2;
  sessionId: string;
  startedAt: number;
  receivedAt: number;
  updatedAt: number;
  expiresAt: number;
  eventCount: number;
  droppedEventCount: number;
  report: ProviderDiagnosticsShare;
  latestEvent: ProviderDiagnosticsStoredEvent;
}>;

export type ProviderDiagnosticsEventsRecord = Readonly<{
  bridgeVersion: 2;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  eventCount: number;
  droppedEventCount: number;
  events: readonly ProviderDiagnosticsStoredEvent[];
}>;

export type ProviderDiagnosticsHealth = Readonly<{
  bridgeVersion: 2;
  state: 'idle' | 'monitoring';
  serverTime: number;
  sessionId: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  expiresAt: number | null;
  eventCount: number;
  droppedEventCount: number;
}>;

const PROBE_STATES = /* @__PURE__ */ new Set(['not_run', 'running', 'succeeded', 'failed']);
const HOST_ACCESS_STATES = /* @__PURE__ */ new Set(['checking', 'built-in', 'granted', 'required']);
const PROBE_PHASES = /* @__PURE__ */ new Set([
  'configuration',
  'permission',
  'identity',
  'tool_request',
  'tool_acknowledgement',
  'unknown',
]);
const EVENT_KINDS = /* @__PURE__ */ new Set<string>(PROVIDER_DIAGNOSTICS_EVENT_KINDS);

type EventFieldKind =
  | 'string'
  | 'url'
  | 'non_negative_number'
  | 'positive_integer'
  | 'nullable_non_negative_integer'
  | 'nullable_status'
  | 'boolean';

const EVENT_DATA_FIELDS: Readonly<Record<ProviderDiagnosticsEventKind, Readonly<Record<string, EventFieldKind>>>> = {
  monitor_started: {},
  configuration_changed: {},
  probe_started: {
    provider: 'string',
    protocol: 'string',
    model: 'string',
    completionEndpoint: 'url',
  },
  probe_succeeded: {
    providerLabel: 'string',
    model: 'string',
    completionEndpoint: 'url',
    latencyMs: 'non_negative_number',
  },
  probe_failed: {
    latencyMs: 'non_negative_number',
    phase: 'string',
    code: 'string',
    status: 'nullable_status',
    message: 'string',
  },
  provider_request_prepared: {
    requestKind: 'string',
    providerStep: 'nullable_non_negative_integer',
    requestAttempt: 'positive_integer',
    providerClass: 'string',
    protocol: 'string',
    requestBytes: 'non_negative_number',
    historyBytes: 'non_negative_number',
    estimatedInputTokens: 'nullable_non_negative_integer',
    maxOutputTokens: 'positive_integer',
  },
  provider_response_started: {
    requestKind: 'string',
    providerStep: 'nullable_non_negative_integer',
    requestAttempt: 'positive_integer',
    latencyMs: 'non_negative_number',
  },
  provider_stream_activity: {
    requestKind: 'string',
    providerStep: 'nullable_non_negative_integer',
    requestAttempt: 'positive_integer',
    textBytes: 'non_negative_number',
    refusalBytes: 'non_negative_number',
    toolArgumentBytes: 'non_negative_number',
    itemCount: 'non_negative_number',
  },
  provider_usage: {
    requestKind: 'string',
    providerStep: 'nullable_non_negative_integer',
    requestAttempt: 'positive_integer',
    inputTokens: 'nullable_non_negative_integer',
    outputTokens: 'nullable_non_negative_integer',
    totalTokens: 'nullable_non_negative_integer',
    source: 'string',
  },
  provider_finished: {
    requestKind: 'string',
    providerStep: 'nullable_non_negative_integer',
    requestAttempt: 'positive_integer',
    finishReason: 'string',
    durationMs: 'non_negative_number',
  },
  provider_error: {
    requestKind: 'string',
    providerStep: 'nullable_non_negative_integer',
    requestAttempt: 'positive_integer',
    code: 'string',
    status: 'nullable_status',
    retryable: 'boolean',
    overflow: 'boolean',
  },
};

export function parseProviderDiagnosticsShare(
  value: unknown,
): ProviderDiagnosticsShare | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const source = value.source;
  const privacy = value.privacy;
  const provider = value.provider;
  const probe = value.probe;
  if (
    !isTimestamp(value.generatedAt)
    || !isRecord(source)
    || !isBoundedString(source.versionHash, 128)
    || source.runtime !== 'chrome-extension'
    || !isRecord(privacy)
    || privacy.credentialsIncluded !== false
    || privacy.rawCaptureIncluded !== false
    || privacy.chatContentIncluded !== false
    || privacy.providerResponseContentIncluded !== false
    || !isRecord(provider)
    || !isBoundedString(provider.id, 64)
    || !isBoundedString(provider.label, 128)
    || !isBoundedString(provider.protocol, 64)
    || !isSafeUrl(provider.canonicalOrigin)
    || !isSafeUrl(provider.canonicalBaseUrl)
    || !isSafeUrl(provider.completionEndpoint)
    || !isBoundedString(provider.model, 256)
    || (provider.credentialState !== 'saved' && provider.credentialState !== 'missing')
    || !HOST_ACCESS_STATES.has(String(provider.hostAccess))
    || !isNullablePositiveInteger(provider.declaredContextWindow)
    || !isNullablePositiveInteger(provider.workingContextWindow)
    || !isCapability(provider.capability)
    || !isProbe(probe)
  ) return null;

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    source: Object.freeze({
      versionHash: source.versionHash,
      runtime: 'chrome-extension',
    }),
    privacy: Object.freeze({
      credentialsIncluded: false,
      rawCaptureIncluded: false,
      chatContentIncluded: false,
      providerResponseContentIncluded: false,
    }),
    provider: Object.freeze({
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      canonicalOrigin: provider.canonicalOrigin,
      canonicalBaseUrl: provider.canonicalBaseUrl,
      completionEndpoint: provider.completionEndpoint,
      model: provider.model,
      credentialState: provider.credentialState,
      hostAccess: provider.hostAccess as ProviderDiagnosticsShare['provider']['hostAccess'],
      declaredContextWindow: provider.declaredContextWindow,
      workingContextWindow: provider.workingContextWindow,
      capability: provider.capability === null ? null : Object.freeze({
        contextWindow: provider.capability.contextWindow,
        source: provider.capability.source,
        verifiedAt: provider.capability.verifiedAt,
        fingerprint: provider.capability.fingerprint,
      }),
    }),
    probe: freezeProbe(probe),
  });
}

export function parseProviderDiagnosticsMonitorEvent(
  value: unknown,
): ProviderDiagnosticsMonitorEvent | null {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || !isSessionId(value.sessionId)
    || !isTimestamp(value.emittedAt)
    || !EVENT_KINDS.has(String(value.kind))
    || (value.rootOperationId !== null && !isBoundedString(value.rootOperationId, 256))
    || (value.requestId !== null && !isBoundedString(value.requestId, 256))
    || !isRecord(value.data)
  ) return null;
  const kind = value.kind as ProviderDiagnosticsEventKind;
  const data = projectEventData(kind, value.data);
  if (!data) return null;
  return Object.freeze({
    schemaVersion: 1,
    sessionId: value.sessionId,
    emittedAt: value.emittedAt,
    kind,
    rootOperationId: value.rootOperationId,
    requestId: value.requestId,
    data,
  });
}

export function parseProviderDiagnosticsEventPost(
  value: unknown,
): ProviderDiagnosticsEventPost | null {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || !isSessionId(value.sessionId)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.expiresAt)
    || value.expiresAt <= value.startedAt
  ) return null;
  const event = parseProviderDiagnosticsMonitorEvent(value.event);
  if (!event || event.sessionId !== value.sessionId) return null;
  const report = value.report === undefined
    ? undefined
    : parseProviderDiagnosticsShare(value.report);
  if (value.report !== undefined && !report) return null;
  return Object.freeze({
    schemaVersion: 1,
    sessionId: value.sessionId,
    startedAt: value.startedAt,
    expiresAt: value.expiresAt,
    event,
    ...(report ? { report } : {}),
  });
}

export function parseProviderDiagnosticsBridgeRecord(
  value: unknown,
): ProviderDiagnosticsBridgeRecord | null {
  if (
    !isRecord(value)
    || value.bridgeVersion !== 2
    || !isSessionId(value.sessionId)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.receivedAt)
    || !isTimestamp(value.updatedAt)
    || !isTimestamp(value.expiresAt)
    || value.expiresAt <= value.startedAt
    || !isNonNegativeInteger(value.eventCount)
    || !isNonNegativeInteger(value.droppedEventCount)
  ) return null;
  const report = parseProviderDiagnosticsShare(value.report);
  const latestEvent = parseStoredEvent(value.latestEvent);
  if (!report || !latestEvent || latestEvent.event.sessionId !== value.sessionId) return null;
  return Object.freeze({
    bridgeVersion: 2,
    sessionId: value.sessionId,
    startedAt: value.startedAt,
    receivedAt: value.receivedAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    eventCount: value.eventCount,
    droppedEventCount: value.droppedEventCount,
    report,
    latestEvent,
  });
}

export function parseProviderDiagnosticsEventsRecord(
  value: unknown,
): ProviderDiagnosticsEventsRecord | null {
  if (
    !isRecord(value)
    || value.bridgeVersion !== 2
    || !isSessionId(value.sessionId)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.updatedAt)
    || !isTimestamp(value.expiresAt)
    || value.expiresAt <= value.startedAt
    || !isNonNegativeInteger(value.eventCount)
    || !isNonNegativeInteger(value.droppedEventCount)
    || !Array.isArray(value.events)
  ) return null;
  const events = value.events.map(parseStoredEvent);
  if (events.some((event) => !event || event.event.sessionId !== value.sessionId)) return null;
  return Object.freeze({
    bridgeVersion: 2,
    sessionId: value.sessionId,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    eventCount: value.eventCount,
    droppedEventCount: value.droppedEventCount,
    events: Object.freeze(events as ProviderDiagnosticsStoredEvent[]),
  });
}

export function parseProviderDiagnosticsHealth(value: unknown): ProviderDiagnosticsHealth | null {
  if (
    !isRecord(value)
    || value.bridgeVersion !== 2
    || (value.state !== 'idle' && value.state !== 'monitoring')
    || !isTimestamp(value.serverTime)
    || !isNonNegativeInteger(value.eventCount)
    || !isNonNegativeInteger(value.droppedEventCount)
  ) return null;
  if (value.state === 'idle') {
    if (
      value.sessionId !== null
      || value.startedAt !== null
      || value.updatedAt !== null
      || value.expiresAt !== null
    ) return null;
  } else if (
    !isSessionId(value.sessionId)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.updatedAt)
    || !isTimestamp(value.expiresAt)
  ) return null;
  return Object.freeze({
    bridgeVersion: 2,
    state: value.state,
    serverTime: value.serverTime,
    sessionId: value.sessionId,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    eventCount: value.eventCount,
    droppedEventCount: value.droppedEventCount,
  }) as ProviderDiagnosticsHealth;
}

function parseStoredEvent(value: unknown): ProviderDiagnosticsStoredEvent | null {
  if (
    !isRecord(value)
    || !isPositiveInteger(value.sequence)
    || !isTimestamp(value.receivedAt)
  ) return null;
  const event = parseProviderDiagnosticsMonitorEvent(value.event);
  return event ? Object.freeze({ sequence: value.sequence, receivedAt: value.receivedAt, event }) : null;
}

function projectEventData(
  kind: ProviderDiagnosticsEventKind,
  value: Record<string, unknown>,
): ProviderDiagnosticsEventData | null {
  const projected: Record<string, string | number | boolean | null> = {};
  for (const [field, fieldKind] of Object.entries(EVENT_DATA_FIELDS[kind])) {
    const candidate = value[field];
    if (!isEventField(candidate, fieldKind)) return null;
    projected[field] = candidate;
  }
  return Object.freeze(projected);
}

function isEventField(value: unknown, kind: EventFieldKind): value is string | number | boolean | null {
  if (kind === 'string') return isBoundedString(value, 1_024);
  if (kind === 'url') return isSafeUrl(value);
  if (kind === 'non_negative_number') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
  if (kind === 'positive_integer') return isPositiveInteger(value);
  if (kind === 'nullable_non_negative_integer') return value === null || isNonNegativeInteger(value);
  if (kind === 'nullable_status') {
    return value === null || (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599);
  }
  return typeof value === 'boolean';
}

function isCapability(value: unknown): value is NonNullable<ProviderDiagnosticsShare['provider']['capability']> | null {
  if (value === null) return true;
  return isRecord(value)
    && isNullablePositiveInteger(value.contextWindow)
    && (value.source === null || isBoundedString(value.source, 64))
    && isTimestamp(value.verifiedAt)
    && isBoundedString(value.fingerprint, 512);
}

function isProbe(value: unknown): value is ProviderDiagnosticsProbe {
  if (!isRecord(value) || !PROBE_STATES.has(String(value.state))) return false;
  if (
    !isNullableTimestamp(value.startedAt)
    || !isNullableTimestamp(value.completedAt)
    || !isNullableNonNegativeNumber(value.latencyMs)
  ) return false;
  if (value.failure === null) return value.state !== 'failed';
  return value.state === 'failed' && isFailure(value.failure);
}

function freezeProbe(value: ProviderDiagnosticsProbe): ProviderDiagnosticsProbe {
  return Object.freeze({
    state: value.state,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    latencyMs: value.latencyMs,
    failure: value.failure === null ? null : Object.freeze({ ...value.failure }),
  });
}

function isFailure(value: unknown): value is AgentProviderConnectionFailureDetails {
  return isRecord(value)
    && value.schemaVersion === 1
    && PROBE_PHASES.has(String(value.phase))
    && isBoundedString(value.code, 128)
    && (value.status === null || (Number.isInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599))
    && isBoundedString(value.message, 1_024);
}

function isSafeUrl(value: unknown): value is string {
  if (!isBoundedString(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function isSessionId(value: unknown): value is string {
  return isBoundedString(value, 128) && /^[a-zA-Z0-9:_-]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
