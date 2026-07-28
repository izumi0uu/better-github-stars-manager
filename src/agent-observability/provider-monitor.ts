import type {
  AgentExecutionTraceEvent,
  AgentTraceProviderRequestIdentity,
} from '@/agent-harness';
import {
  parseProviderDiagnosticsBridgeRecord,
  parseProviderDiagnosticsShare,
  PROVIDER_DIAGNOSTICS_EVENTS_URL,
  PROVIDER_DIAGNOSTICS_TTL_MS,
  type ProviderDiagnosticsBridgeRecordV1,
  type ProviderDiagnosticsEventData,
  type ProviderDiagnosticsEventKind,
  type ProviderDiagnosticsEventPostV1,
  type ProviderDiagnosticsMonitorEventV1,
  type ProviderDiagnosticsShareV1,
} from '@/dev-agent/provider-diagnostics-bridge';

export const PROVIDER_DIAGNOSTICS_MONITOR_STORAGE_KEY = 'bgsm_provider_diagnostics_monitor_v1';

export type ProviderDiagnosticsMonitorState = Readonly<{
  sessionId: string;
  startedAt: number;
  expiresAt: number;
}>;

type SessionStorage = Readonly<{
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}>;

type StreamAggregate = {
  identity: AgentTraceProviderRequestIdentity;
  rootOperationId: string;
  textBytes: number;
  refusalBytes: number;
  toolArgumentBytes: number;
  itemCount: number;
};

export type ProviderDiagnosticsMonitor = Readonly<{
  start(state: ProviderDiagnosticsMonitorState): Promise<ProviderDiagnosticsMonitorState>;
  stop(): Promise<void>;
  status(): Promise<ProviderDiagnosticsMonitorState | null>;
  recordConfigurationChanged(report: ProviderDiagnosticsShareV1): void;
  recordProbeStarted(input: Readonly<{
    requestId: string;
    report: ProviderDiagnosticsShareV1;
  }>): void;
  recordProbeSucceeded(input: Readonly<{
    requestId: string;
    report: ProviderDiagnosticsShareV1;
    providerLabel: string;
    model: string;
    completionEndpoint: string;
    latencyMs: number;
  }>): void;
  recordProbeFailed(input: Readonly<{
    requestId: string;
    report: ProviderDiagnosticsShareV1;
    latencyMs: number;
    phase: string;
    code: string;
    status: number | null;
    message: string;
  }>): void;
  observeExecutionEvent(rootOperationId: string, event: AgentExecutionTraceEvent): void;
  flush(): Promise<void>;
}>;

export function createProviderDiagnosticsMonitor(input: Readonly<{
  storage: SessionStorage;
  fetchImpl?: typeof fetch;
  now?: () => number;
  getCurrentReport?: () => Promise<ProviderDiagnosticsShareV1 | null>;
}>): ProviderDiagnosticsMonitor {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const streamAggregates = new Map<string, StreamAggregate>();
  let cachedState: ProviderDiagnosticsMonitorState | null | undefined;
  let tail = Promise.resolve();
  let stateGeneration = 0;

  const schedule = (work: (generation: number) => Promise<void>): void => {
    const scheduledGeneration = stateGeneration;
    const guarded = () => scheduledGeneration === stateGeneration
      ? work(scheduledGeneration)
      : Promise.resolve();
    tail = tail.then(guarded, guarded).catch(() => undefined);
  };

  const readState = async (): Promise<ProviderDiagnosticsMonitorState | null> => {
    if (cachedState === undefined) {
      const stored = await input.storage.get(PROVIDER_DIAGNOSTICS_MONITOR_STORAGE_KEY);
      cachedState = parseMonitorState(stored[PROVIDER_DIAGNOSTICS_MONITOR_STORAGE_KEY]);
    }
    if (cachedState && cachedState.expiresAt <= now()) {
      cachedState = null;
      stateGeneration += 1;
      streamAggregates.clear();
      await input.storage.remove(PROVIDER_DIAGNOSTICS_MONITOR_STORAGE_KEY);
    }
    return cachedState;
  };

  const publish = async (
    kind: ProviderDiagnosticsEventKind,
    data: ProviderDiagnosticsEventData,
    identity: Readonly<{
      rootOperationId?: string | null;
      requestId?: string | null;
    }> = {},
    report?: ProviderDiagnosticsShareV1,
    expectedGeneration = stateGeneration,
  ): Promise<void> => {
    const state = await readState();
    if (!state) return;
    const event: ProviderDiagnosticsMonitorEventV1 = Object.freeze({
      schemaVersion: 1,
      sessionId: state.sessionId,
      emittedAt: now(),
      kind,
      rootOperationId: identity.rootOperationId ?? null,
      requestId: identity.requestId ?? null,
      data: Object.freeze({ ...data }),
    });
    const post: ProviderDiagnosticsEventPostV1 = Object.freeze({
      schemaVersion: 1,
      ...state,
      event,
      ...(report ? { report } : {}),
    });
    let response = await postEvent(fetchImpl, post);
    if (
      response.status === 409
      && expectedGeneration === stateGeneration
      && !report
      && input.getCurrentReport
    ) {
      const recoveryReport = await input.getCurrentReport();
      if (recoveryReport && expectedGeneration === stateGeneration) {
        response = await postEvent(fetchImpl, { ...post, report: recoveryReport });
      }
    }
    if (response.status === 409 && expectedGeneration === stateGeneration) {
      cachedState = null;
      stateGeneration += 1;
      streamAggregates.clear();
      await input.storage.remove(PROVIDER_DIAGNOSTICS_MONITOR_STORAGE_KEY);
    }
  };

  const flushStream = (rootOperationId: string, event: AgentTraceProviderRequestIdentity): void => {
    const key = requestKey(rootOperationId, event.requestId);
    const aggregate = streamAggregates.get(key);
    if (!aggregate) return;
    streamAggregates.delete(key);
    if (aggregate.itemCount === 0) return;
    schedule((generation) => publish('provider_stream_activity', {
      ...requestIdentityData(aggregate.identity),
      textBytes: aggregate.textBytes,
      refusalBytes: aggregate.refusalBytes,
      toolArgumentBytes: aggregate.toolArgumentBytes,
      itemCount: aggregate.itemCount,
    }, { rootOperationId, requestId: event.requestId }, undefined, generation));
  };

  const monitor: ProviderDiagnosticsMonitor = {
    async start(state) {
      const parsed = parseMonitorState(state);
      const currentTime = now();
      if (
        !parsed
        || parsed.startedAt > currentTime
        || parsed.expiresAt <= currentTime
        || parsed.expiresAt - parsed.startedAt > PROVIDER_DIAGNOSTICS_TTL_MS
      ) throw new TypeError('Provider diagnostics monitor session is invalid.');
      stateGeneration += 1;
      streamAggregates.clear();
      cachedState = parsed;
      await input.storage.set({ [PROVIDER_DIAGNOSTICS_MONITOR_STORAGE_KEY]: parsed });
      return parsed;
    },

    async stop() {
      stateGeneration += 1;
      cachedState = null;
      streamAggregates.clear();
      await input.storage.remove(PROVIDER_DIAGNOSTICS_MONITOR_STORAGE_KEY);
    },

    status: readState,

    recordConfigurationChanged(report) {
      schedule((generation) => publish('configuration_changed', {}, {}, report, generation));
    },

    recordProbeStarted({ requestId, report }) {
      schedule((generation) => publish('probe_started', {
        provider: report.provider.id,
        protocol: report.provider.protocol,
        model: report.provider.model,
        completionEndpoint: report.provider.completionEndpoint,
      }, { requestId }, report, generation));
    },

    recordProbeSucceeded({
      requestId,
      report,
      providerLabel,
      model,
      completionEndpoint,
      latencyMs,
    }) {
      schedule((generation) => publish('probe_succeeded', {
        providerLabel,
        model,
        completionEndpoint,
        latencyMs,
      }, { requestId }, report, generation));
    },

    recordProbeFailed({ requestId, report, latencyMs, phase, code, status, message }) {
      schedule((generation) => publish('probe_failed', {
        latencyMs,
        phase,
        code,
        status,
        message,
      }, { requestId }, report, generation));
    },

    observeExecutionEvent(rootOperationId, event) {
      if (!('requestId' in event)) return;
      if (event.kind === 'provider_stream_item') {
        if (!['text', 'refusal', 'tool_arguments'].includes(event.streamClass)) return;
        const key = requestKey(rootOperationId, event.requestId);
        const aggregate = streamAggregates.get(key) ?? {
          identity: event,
          rootOperationId,
          textBytes: 0,
          refusalBytes: 0,
          toolArgumentBytes: 0,
          itemCount: 0,
        };
        aggregate.itemCount += 1;
        if (event.streamClass === 'text') aggregate.textBytes += event.utf8Bytes;
        if (event.streamClass === 'refusal') aggregate.refusalBytes += event.utf8Bytes;
        if (event.streamClass === 'tool_arguments') aggregate.toolArgumentBytes += event.utf8Bytes;
        streamAggregates.set(key, aggregate);
        return;
      }
      if (
        event.kind === 'provider_usage'
        || event.kind === 'provider_finished'
        || event.kind === 'provider_error'
      ) flushStream(rootOperationId, event);
      const projected = projectExecutionEvent(event);
      if (!projected) return;
      schedule((generation) => publish(projected.kind, projected.data, {
        rootOperationId,
        requestId: event.requestId,
      }, undefined, generation));
    },

    flush() {
      return tail;
    },
  };
  return monitor;
}

async function postEvent(
  fetchImpl: typeof fetch,
  post: ProviderDiagnosticsEventPostV1,
): Promise<Response> {
  return fetchImpl(PROVIDER_DIAGNOSTICS_EVENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(post),
  });
}

function projectExecutionEvent(event: AgentExecutionTraceEvent): Readonly<{
  kind: ProviderDiagnosticsEventKind;
  data: ProviderDiagnosticsEventData;
}> | null {
  if (!('requestId' in event)) return null;
  const identity = requestIdentityData(event);
  switch (event.kind) {
    case 'provider_request_prepared':
      return {
        kind: event.kind,
        data: {
          ...identity,
          providerClass: event.providerClass,
          protocol: event.protocol,
          requestBytes: event.requestBytes,
          historyBytes: event.historyBytes,
          estimatedInputTokens: event.estimatedInputTokens,
          maxOutputTokens: event.maxOutputTokens,
        },
      };
    case 'provider_response_started':
      return { kind: event.kind, data: { ...identity, latencyMs: event.latencyMs } };
    case 'provider_usage':
      return {
        kind: event.kind,
        data: {
          ...identity,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          source: event.source,
        },
      };
    case 'provider_finished':
      return {
        kind: event.kind,
        data: { ...identity, finishReason: event.finishReason, durationMs: event.durationMs },
      };
    case 'provider_error':
      return {
        kind: event.kind,
        data: {
          ...identity,
          code: event.code,
          status: event.status,
          retryable: event.retryable,
          overflow: event.overflow,
        },
      };
    case 'provider_stream_item':
      return null;
    default:
      return null;
  }
}

function requestIdentityData(event: AgentTraceProviderRequestIdentity): ProviderDiagnosticsEventData {
  return {
    requestKind: event.requestKind,
    providerStep: event.providerStep,
    requestAttempt: event.requestAttempt,
  };
}

function requestKey(rootOperationId: string, requestId: string): string {
  return `${rootOperationId}\u0000${requestId}`;
}

function parseMonitorState(value: unknown): ProviderDiagnosticsMonitorState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Partial<ProviderDiagnosticsMonitorState>;
  if (
    typeof state.sessionId !== 'string'
    || !/^[a-zA-Z0-9:_-]+$/u.test(state.sessionId)
    || state.sessionId.length > 128
    || !Number.isSafeInteger(state.startedAt)
    || Number(state.startedAt) < 0
    || !Number.isSafeInteger(state.expiresAt)
    || Number(state.expiresAt) <= Number(state.startedAt)
  ) return null;
  return Object.freeze({
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    expiresAt: state.expiresAt,
  }) as ProviderDiagnosticsMonitorState;
}

export function monitorStateFromBridgeRecord(
  value: unknown,
): ProviderDiagnosticsMonitorState | null {
  const record: ProviderDiagnosticsBridgeRecordV1 | null = parseProviderDiagnosticsBridgeRecord(value);
  return record ? Object.freeze({
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    expiresAt: record.expiresAt,
  }) : null;
}

export function safeMonitorReport(value: unknown): ProviderDiagnosticsShareV1 | null {
  return parseProviderDiagnosticsShare(value);
}
