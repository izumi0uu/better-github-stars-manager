/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      start: index * 52,
      size: 52,
    })),
  }),
}));
import {
  DEV_TRACE_CONTROL_PORT,
  DEV_TRACE_EVIDENCE_PORT,
  parseTraceArtifactJson,
  type DevTracePortResponse,
  type TraceArtifact,
} from '@/agent-observability';
import { AgentDiagnostics } from '@/dev-agent/AgentDiagnostics';
import type {
  ArtifactWorkerRequest,
  ArtifactWorkerResponse,
} from '@/dev-agent/artifact-worker-protocol';
import { cleanupMountedRootsAndBody, mountReact, type MountedRoot } from './test-utils';

class FakeDiagnosticsPort {
  readonly posted: unknown[] = [];
  readonly messageListeners: Array<(message: DevTracePortResponse) => void> = [];
  readonly disconnectListeners: Array<() => void> = [];
  disconnected = false;

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  readonly onMessage = {
    addListener: (listener: (message: DevTracePortResponse) => void) => this.messageListeners.push(listener),
  };

  readonly onDisconnect = {
    addListener: (listener: () => void) => this.disconnectListeners.push(listener),
  };

  emit(message: DevTracePortResponse): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

class FakeArtifactWorker {
  readonly chunks = new Map<string, string[]>();
  readonly posted: ArtifactWorkerRequest[] = [];
  onmessage: ((message: MessageEvent<ArtifactWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;

  postMessage(message: ArtifactWorkerRequest): void {
    this.posted.push(message);
    if (message.type === 'artifact_parse_start') {
      this.chunks.set(message.jobId, []);
      return;
    }
    if (message.type === 'artifact_parse_cancel') {
      this.chunks.delete(message.jobId);
      return;
    }
    if (message.type === 'artifact_parse_file') {
      if (deferFileParse) return;
      this.emitResponse({
        type: 'artifact_parse_result',
        jobId: message.jobId,
        artifact: sampleArtifact(),
      });
      return;
    }
    const chunks = this.chunks.get(message.jobId);
    if (!chunks) return;
    chunks.push(message.jsonChunk);
    if (!message.done) return;
    this.chunks.delete(message.jobId);
    try {
      this.emitResponse({
        type: 'artifact_parse_result',
        jobId: message.jobId,
        artifact: parseTraceArtifactJson(chunks.join('')),
      });
    } catch (error) {
      this.emitResponse({
        type: 'artifact_parse_error',
        jobId: message.jobId,
        code: 'invalid_artifact',
        message: error instanceof Error ? error.message : 'invalid',
      });
    }
  }

  terminate(): void {
    this.chunks.clear();
  }

  emitResponse(data: ArtifactWorkerResponse): void {
    this.onmessage?.({ data } as MessageEvent<ArtifactWorkerResponse>);
  }
}

const mountedRoots: MountedRoot[] = [];
let ports: FakeDiagnosticsPort[] = [];
let workers: FakeArtifactWorker[] = [];
let requestSequence = 0;
let deferFileParse = false;

function sampleArtifact(): TraceArtifact {
  const activeRoot = 'agent_turn:active';
  const failedRoot = 'agent_turn:failed';
  return {
    schemaVersion: 1,
    exporterVersion: 'test',
    exportedAt: 400,
    scope: { kind: 'all_retained', id: null },
    build: { versionHash: 'test-build', extensionVersion: '1.0.8', runtime: 'service_worker', dev: true },
    completeness: {
      retainedFromMs: 100,
      retainedToMs: 400,
      evictedRootCount: 0,
      droppedEventCount: 0,
      truncatedFieldCount: 0,
      unknownEventCount: 0,
      activeBeforeTracing: false,
      sequenceGaps: [],
    },
    roots: [
      {
        rootOperationId: activeRoot,
        operationKind: 'agent_turn',
        sessionId: 'session-active',
        startedAt: 100,
        endedAt: null,
        terminalState: null,
        firstSequence: 1,
        lastSequence: 2,
        eventCount: 2,
      },
      {
        rootOperationId: failedRoot,
        operationKind: 'agent_turn',
        sessionId: 'session-failed',
        startedAt: 200,
        endedAt: 400,
        terminalState: 'failed',
        firstSequence: 1,
        lastSequence: 2,
        eventCount: 2,
      },
    ],
    spans: [
      { spanId: `${activeRoot}:root`, rootOperationId: activeRoot, parentSpanId: null, spanKind: 'root', startedAt: 100, endedAt: null },
      { spanId: `${failedRoot}:root`, rootOperationId: failedRoot, parentSpanId: null, spanKind: 'root', startedAt: 200, endedAt: 400 },
    ],
    events: [
      {
        schemaVersion: 1,
        eventId: 'active-start',
        rootOperationId: activeRoot,
        operationKind: 'agent_turn',
        spanId: `${activeRoot}:root`,
        parentSpanId: null,
        sequence: 1,
        wallTimeMs: 100,
        clockSegmentId: 'clock-active',
        monotonicOffsetMs: 0,
        kind: 'root_started',
        data: { executionEpochId: 'epoch-active', attemptId: 'attempt-active', sessionId: 'session-active', baseRevision: 1 },
      },
      {
        schemaVersion: 1,
        eventId: 'active-phase',
        rootOperationId: activeRoot,
        operationKind: 'agent_turn',
        spanId: `${activeRoot}:root`,
        parentSpanId: null,
        sequence: 2,
        wallTimeMs: 150,
        clockSegmentId: 'clock-active',
        monotonicOffsetMs: 50,
        kind: 'phase_changed',
        data: { phase: 'provider', previousPhase: 'preflight' },
      },
      {
        schemaVersion: 1,
        eventId: 'failed-start',
        rootOperationId: failedRoot,
        operationKind: 'agent_turn',
        spanId: `${failedRoot}:root`,
        parentSpanId: null,
        sequence: 1,
        wallTimeMs: 200,
        clockSegmentId: 'clock-failed',
        monotonicOffsetMs: 0,
        kind: 'root_started',
        data: { executionEpochId: 'epoch-failed', attemptId: 'attempt-failed', sessionId: 'session-failed', baseRevision: 2 },
      },
      {
        schemaVersion: 1,
        eventId: 'failed-terminal',
        rootOperationId: failedRoot,
        operationKind: 'agent_turn',
        spanId: `${failedRoot}:root`,
        parentSpanId: null,
        sequence: 2,
        wallTimeMs: 400,
        clockSegmentId: 'clock-failed',
        monotonicOffsetMs: 200,
        kind: 'root_terminal',
        data: { state: 'failed', reasonCode: 'provider_failure', durationMs: 200 },
      },
    ],
    aggregates: { rootCount: 2, eventCount: 4, failedRootCount: 1 },
    integrity: { rootCount: 2, spanCount: 2, eventCount: 4 },
  };
}

function diagnosticArtifact(): TraceArtifact {
  const base = sampleArtifact();
  const rootOperationId = 'agent_turn:active';
  const spanId = `${rootOperationId}:root`;
  const providerEvents: TraceArtifact['events'] = [
    {
      schemaVersion: 1,
      eventId: 'active-provider-preflight',
      rootOperationId,
      operationKind: 'agent_turn',
      spanId,
      parentSpanId: null,
      sequence: 3,
      wallTimeMs: 160,
      clockSegmentId: 'clock-active',
      monotonicOffsetMs: 60,
      kind: 'context_preflight',
      data: {
        requestId: 'provider:ui',
        requestKind: 'turn',
        providerStep: 0,
        requestAttempt: 1,
        workingWindowTokens: 8_192,
        reserveTokens: 1_024,
        estimatedInputTokens: 7_800,
        requestBytes: 31_000,
        historyBytes: 24_000,
        decision: 'irreducible',
        reasonCode: 'active_turn_too_large',
      },
    },
    {
      schemaVersion: 1,
      eventId: 'active-provider-prepared',
      rootOperationId,
      operationKind: 'agent_turn',
      spanId,
      parentSpanId: null,
      sequence: 4,
      wallTimeMs: 170,
      clockSegmentId: 'clock-active',
      monotonicOffsetMs: 70,
      kind: 'provider_request_prepared',
      data: {
        requestId: 'provider:ui',
        requestKind: 'turn',
        providerStep: 0,
        requestAttempt: 1,
        providerClass: 'custom',
        protocol: 'responses',
        modelCapabilityRevision: 'capability:ui',
        requestBytes: 31_000,
        historyBytes: 24_000,
        estimatedInputTokens: 7_800,
        maxOutputTokens: 1_024,
      },
    },
    {
      schemaVersion: 1,
      eventId: 'active-provider-started',
      rootOperationId,
      operationKind: 'agent_turn',
      spanId,
      parentSpanId: null,
      sequence: 5,
      wallTimeMs: 220,
      clockSegmentId: 'clock-active',
      monotonicOffsetMs: 120,
      kind: 'provider_response_started',
      data: {
        requestId: 'provider:ui',
        requestKind: 'turn',
        providerStep: 0,
        requestAttempt: 1,
        latencyMs: 50,
      },
    },
    {
      schemaVersion: 1,
      eventId: 'active-provider-usage',
      rootOperationId,
      operationKind: 'agent_turn',
      spanId,
      parentSpanId: null,
      sequence: 6,
      wallTimeMs: 230,
      clockSegmentId: 'clock-active',
      monotonicOffsetMs: 130,
      kind: 'provider_usage',
      data: {
        requestId: 'provider:ui',
        requestKind: 'turn',
        providerStep: 0,
        requestAttempt: 1,
        inputTokens: 7_700,
        outputTokens: 10,
        totalTokens: 7_710,
        source: 'provider',
      },
    },
    {
      schemaVersion: 1,
      eventId: 'active-provider-error',
      rootOperationId,
      operationKind: 'agent_turn',
      spanId,
      parentSpanId: null,
      sequence: 7,
      wallTimeMs: 240,
      clockSegmentId: 'clock-active',
      monotonicOffsetMs: 140,
      kind: 'provider_error',
      data: {
        requestId: 'provider:ui',
        requestKind: 'turn',
        providerStep: 0,
        requestAttempt: 1,
        code: 'context_length_exceeded',
        status: 400,
        retryable: false,
        overflow: true,
      },
    },
  ];
  return {
    ...base,
    roots: base.roots.map((root) => root.rootOperationId === rootOperationId
      ? { ...root, lastSequence: 7, eventCount: 7 }
      : root),
    events: [...base.events, ...providerEvents],
    aggregates: { ...base.aggregates, eventCount: 9 },
    integrity: { ...base.integrity, eventCount: 9 },
  };
}

beforeEach(() => {
  ports = [];
  workers = [];
  requestSequence = 0;
  deferFileParse = false;
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++requestSequence}` });
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'provider_diagnostics_not_shared' }),
  })));
  vi.stubGlobal('Worker', class extends FakeArtifactWorker {
    constructor() {
      super();
      workers.push(this);
    }
  });
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn((info: { name: string }) => {
        const port = new FakeDiagnosticsPort(info.name);
        ports.push(port);
        return port as unknown as chrome.runtime.Port;
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupMountedRootsAndBody(mountedRoots);
});

async function deliverArtifact(port: FakeDiagnosticsPort, artifact: TraceArtifact): Promise<void> {
  await act(async () => {
    port.emit({ version: 1, type: 'ready', port: 'evidence' });
    await Promise.resolve();
  });
  const request = port.posted.at(-1) as { requestId: string };
  await act(async () => {
    port.emit({
      version: 1,
      requestId: request.requestId,
      type: 'snapshot_chunk',
      snapshotId: 'snapshot-1',
      cursor: null,
      chunkIndex: 0,
      byteLength: new TextEncoder().encode(JSON.stringify(artifact)).byteLength,
      done: true,
      jsonChunk: JSON.stringify(artifact),
    });
    await Promise.resolve();
  });
}

describe('Agent diagnostics page', () => {
  it('opens as a standalone imported-artifact viewer without extension APIs', async () => {
    vi.stubGlobal('chrome', undefined);
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-diagnostics-import-input"]')).not.toBeNull();
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-testid="agent-diagnostics-raw-capture"]')).toBeNull();
    expect(container.querySelector('button[title="Export traces"]')).toBeNull();
    expect(container.querySelector('button[title="Clear local traces"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-diagnostics-return-live"]')).toBeNull();
    expect(ports).toHaveLength(0);
  });

  it('renders the shared Provider report as stable Agent-readable localhost data', async () => {
    vi.stubGlobal('chrome', undefined);
    const sessionId = 'provider-monitor:test-session';
    const reportPayload = {
      schemaVersion: 1,
      generatedAt: 90,
      source: { versionHash: 'test-build', runtime: 'chrome-extension' },
      privacy: {
        credentialsIncluded: false,
        rawCaptureIncluded: false,
        chatContentIncluded: false,
        providerResponseContentIncluded: false,
      },
      provider: {
        id: 'custom-openai-compatible',
        label: 'Custom OpenAI-compatible',
        protocol: 'responses',
        canonicalOrigin: 'https://relay.example.com',
        canonicalBaseUrl: 'https://relay.example.com/v1',
        completionEndpoint: 'https://relay.example.com/v1/responses',
        model: 'custom-model',
        credentialState: 'saved',
        hostAccess: 'granted',
        declaredContextWindow: 100_000,
        workingContextWindow: 80_000,
        capability: null,
      },
      probe: {
        state: 'failed',
        startedAt: 10,
        completedAt: 80,
        latencyMs: 70,
        failure: {
          schemaVersion: 1,
          phase: 'tool_request',
          code: 'http_error',
          status: 400,
          message: 'AI provider rejected the request (400).',
        },
      },
    };
    const latestEvent = {
      sequence: 2,
      receivedAt: 100,
      event: {
        schemaVersion: 1,
        sessionId,
        emittedAt: 100,
        kind: 'probe_failed',
        rootOperationId: null,
        requestId: 'provider_probe:test',
        data: {
          latencyMs: 70,
          phase: 'tool_request',
          code: 'http_error',
          status: 400,
          message: 'AI provider rejected the request (400).',
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bridgeVersion: 2,
            state: 'monitoring',
            serverTime: 100,
            sessionId,
            startedAt: 90,
            updatedAt: 100,
            expiresAt: 1_000,
            eventCount: 2,
            droppedEventCount: 0,
          }),
        };
      }
      if (path.endsWith('/events')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bridgeVersion: 2,
            sessionId,
            startedAt: 90,
            updatedAt: 100,
            expiresAt: 1_000,
            eventCount: 2,
            droppedEventCount: 0,
            events: [latestEvent],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          bridgeVersion: 2,
          sessionId,
          startedAt: 90,
          receivedAt: 90,
          updatedAt: 100,
          expiresAt: 1_000,
          eventCount: 2,
          droppedEventCount: 0,
          report: reportPayload,
          latestEvent,
        }),
      };
    }));
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const providerTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Provider')!;

    await act(async () => {
      providerTab.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const report = container.querySelector<HTMLElement>('[data-testid="agent-diagnostics-shared-provider-report"]')!;
    expect(report.dataset.agentReadable).toBe('bgsm-provider-monitor-v2');
    expect(report.textContent).toContain('"kind": "probe_failed"');
    expect(report.textContent).toContain('"phase": "tool_request"');
    expect(report.textContent).toContain('"status": 400');
    expect(report.textContent).toContain('"credentialsIncluded": false');
  });

  it('pulls every cursor chunk and becomes ready only after worker validation', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const evidence = ports.find((port) => port.name === DEV_TRACE_EVIDENCE_PORT)!;
    await act(async () => {
      evidence.emit({ version: 1, type: 'ready', port: 'evidence' });
      await Promise.resolve();
    });
    const request = evidence.posted.at(-1) as { requestId: string };
    const serialized = JSON.stringify(sampleArtifact());
    const splitAt = Math.floor(serialized.length / 2);
    const first = serialized.slice(0, splitAt);
    const second = serialized.slice(splitAt);

    await act(async () => {
      evidence.emit({
        version: 1,
        requestId: request.requestId,
        type: 'snapshot_chunk',
        snapshotId: 'snapshot-cursor',
        cursor: 'cursor-next',
        chunkIndex: 0,
        byteLength: new TextEncoder().encode(first).byteLength,
        done: false,
        jsonChunk: first,
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-diagnostics-runs"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[title="Refresh traces"]')?.disabled).toBe(true);
    expect(evidence.posted.at(-1)).toEqual(expect.objectContaining({
      requestId: request.requestId,
      type: 'get_snapshot',
      cursor: 'cursor-next',
    }));

    await act(async () => {
      evidence.emit({
        version: 1,
        requestId: request.requestId,
        type: 'snapshot_chunk',
        snapshotId: 'snapshot-cursor',
        cursor: null,
        chunkIndex: 1,
        byteLength: new TextEncoder().encode(second).byteLength,
        done: true,
        jsonChunk: second,
      });
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[data-testid^="agent-diagnostics-run-"]')).toHaveLength(2);
    expect(workers[0]?.posted.map((message) => message.type)).toEqual([
      'artifact_parse_start',
      'artifact_parse_chunk',
      'artifact_parse_chunk',
    ]);
  });

  it('prioritizes an active operation, exposes semantic timeline filtering, and shows selected event metadata', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const evidence = ports.find((port) => port.name === DEV_TRACE_EVIDENCE_PORT)!;
    await deliverArtifact(evidence, sampleArtifact());

    const activeRun = container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-run-agent_turn\\:active"]')!;
    expect(activeRun.getAttribute('aria-pressed')).toBe('true');

    expect(container.querySelector('[data-testid="agent-diagnostics-event-active-phase"]')).not.toBeNull();

    const filter = container.querySelector<HTMLSelectElement>('[data-testid="agent-diagnostics-event-filter"]')!;
    await act(async () => {
      filter.value = 'phase_changed';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-diagnostics-event-active-start"]')).toBeNull();

    const event = container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-event-active-phase"] button')!;
    await act(async () => {
      event.click();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-event-active-phase"] button')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(container.querySelector('[data-testid="agent-diagnostics-event-data"]')?.textContent)
      .toContain('"phase": "provider"');
  });

  it('renders empty and evidence-error states and sends a confirmed clear only over the control Port', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const evidence = ports.find((port) => port.name === DEV_TRACE_EVIDENCE_PORT)!;
    const control = ports.find((port) => port.name === DEV_TRACE_CONTROL_PORT)!;
    await deliverArtifact(evidence, { ...sampleArtifact(), roots: [], spans: [], events: [], aggregates: { rootCount: 0, eventCount: 0, failedRootCount: 0 }, integrity: { rootCount: 0, spanCount: 0, eventCount: 0 } });
    await act(async () => {
      control.emit({ version: 1, type: 'ready', port: 'control' });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-diagnostics-empty"]')).toBeTruthy();
    const clear = container.querySelector<HTMLButtonElement>('button[title="Clear local traces"]')!;
    await act(async () => {
      clear.click();
      await Promise.resolve();
    });
    expect(control.posted.at(-1)).toEqual(expect.objectContaining({
      type: 'clear_traces',
      confirmation: 'clear-local-agent-traces',
    }));

    const refresh = container.querySelector<HTMLButtonElement>('button[title="Refresh traces"]')!;
    await act(async () => {
      refresh.click();
      await Promise.resolve();
    });
    const request = evidence.posted.at(-1) as { requestId: string };
    await act(async () => {
      evidence.emit({ version: 1, requestId: request.requestId, type: 'evidence_error', code: 'internal_error' });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="agent-diagnostics-status"]')?.textContent).toContain('internal_error');
  });

  it('blocks destructive or export actions while snapshot or import evidence is transferring', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const evidence = ports.find((port) => port.name === DEV_TRACE_EVIDENCE_PORT)!;
    const control = ports.find((port) => port.name === DEV_TRACE_CONTROL_PORT)!;
    await act(async () => {
      control.emit({ version: 1, type: 'ready', port: 'control' });
      evidence.emit({ version: 1, type: 'ready', port: 'evidence' });
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLButtonElement>('button[title="Clear local traces"]')?.disabled).toBe(true);

    const initialRequest = evidence.posted.at(-1) as { requestId: string };
    const serialized = JSON.stringify(sampleArtifact());
    await act(async () => {
      evidence.emit({
        version: 1,
        requestId: initialRequest.requestId,
        type: 'snapshot_chunk',
        snapshotId: 'snapshot-transfer',
        cursor: null,
        chunkIndex: 0,
        byteLength: new TextEncoder().encode(serialized).byteLength,
        done: true,
        jsonChunk: serialized,
      });
      await Promise.resolve();
    });

    deferFileParse = true;
    const input = container.querySelector<HTMLInputElement>('[data-testid="agent-diagnostics-import-input"]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['{}'], 'slow-trace.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLButtonElement>('button[title="Export traces"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[title="Clear local traces"]')?.disabled).toBe(true);
  });

  it('runs only a named Scenario Lab fixture through the control Port and refreshes traces on completion', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const evidence = ports.find((port) => port.name === DEV_TRACE_EVIDENCE_PORT)!;
    const control = ports.find((port) => port.name === DEV_TRACE_CONTROL_PORT)!;
    const scenarioTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Scenario Lab')!;

    await act(async () => {
      scenarioTab.click();
      await Promise.resolve();
    });
    const scenario = container.querySelector<HTMLSelectElement>('[data-testid="agent-diagnostics-scenario-id"]')!;
    const run = container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-run-scenario"]')!;
    expect(run.disabled).toBe(true);
    await act(async () => {
      control.emit({ version: 1, type: 'ready', port: 'control' });
      await Promise.resolve();
    });
    expect(run.disabled).toBe(false);
    await act(async () => {
      scenario.value = 'overflow-then-success';
      scenario.dispatchEvent(new Event('change', { bubbles: true }));
      run.click();
      await Promise.resolve();
    });

    expect(control.posted.at(-1)).toEqual(expect.objectContaining({
      type: 'run_scenario',
      scenarioId: 'overflow-then-success',
      controls: { delayMs: 0, contextWindow: 8_192 },
    }));
    const request = control.posted.at(-1) as { requestId: string };
    await act(async () => {
      control.emit({
        version: 1,
        requestId: request.requestId,
        type: 'control_result',
        action: 'scenario_completed',
        scenarioId: 'overflow-then-success',
        rootOperationIds: ['agent_turn:scenario-overflow'],
      });
      await Promise.resolve();
    });

    expect(evidence.posted.at(-1)).toEqual(expect.objectContaining({ type: 'get_snapshot' }));
    expect([...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Traces')?.getAttribute('aria-selected')).toBe('true');
  });

  it('exposes the development-only Provider diagnostics tab', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const providerTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Provider')!;

    await act(async () => {
      providerTab.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-diagnostics-provider"]')).not.toBeNull();
  });

  it('exposes deterministic findings and an Agent-readable report that links to raw trace evidence', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const evidence = ports.find((port) => port.name === DEV_TRACE_EVIDENCE_PORT)!;
    await deliverArtifact(evidence, diagnosticArtifact());
    const analysisTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Analysis')!;

    await act(async () => {
      analysisTab.click();
      await Promise.resolve();
    });

    const report = container.querySelector<HTMLElement>('[data-testid="agent-diagnostics-machine-report"]')!;
    expect(report.dataset.agentReadable).toBe('bgsm-diagnostics');
    expect(report.dataset.reportStatus).toBe('failed');
    expect(report.textContent).toContain('context_length_exceeded');
    expect(report.textContent).toContain('"credentialsIncluded": false');
    expect(container.querySelector('[data-provider-request-id="provider:ui"]')).not.toBeNull();
    const finding = container.querySelector<HTMLElement>('[data-diagnostic-code="provider_request_failed"]')!;
    expect(finding.dataset.rootOperationId).toBe('agent_turn:active');
    expect(finding.dataset.requestId).toBe('provider:ui');

    await act(async () => {
      finding.querySelector<HTMLButtonElement>('button')!.click();
      await Promise.resolve();
    });

    expect([...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Traces')?.getAttribute('aria-selected')).toBe('true');

    expect(container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-event-active-provider-error"] button')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(container.querySelector('[data-testid="agent-diagnostics-event-data"]')?.textContent)
      .toContain('"code": "context_length_exceeded"');
  });

  it('warns about page-memory visibility and renders one-shot raw evidence without adding it to traces', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const control = ports.find((port) => port.name === DEV_TRACE_CONTROL_PORT)!;
    const section = container.querySelector('[data-testid="agent-diagnostics-raw-capture"]')!;
    expect(section.textContent).toContain('repository code and private notes');
    expect(section.textContent).toContain('Codex or browser automation');
    expect(section.textContent).toContain('configured API keys');
    expect(section.textContent).toContain('unrecognized secret');

    await act(async () => {
      control.emit({ version: 1, type: 'ready', port: 'control' });
      await Promise.resolve();
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-diagnostics-toggle-raw-capture"]',
    )!;
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    const arm = control.posted.at(-1) as { requestId: string };
    expect(control.posted.at(-1)).toEqual(expect.objectContaining({ type: 'arm_raw_capture' }));

    await act(async () => {
      control.emit({
        version: 1,
        requestId: arm.requestId,
        type: 'control_result',
        action: 'raw_capture_armed',
        captureId: 'raw_capture:ui',
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-diagnostics-raw-status"]')?.textContent)
      .toContain('raw_capture:ui');
    expect(container.querySelector('[data-testid="agent-diagnostics-raw-events"]')).toBeNull();

    const common = {
      version: 1 as const,
      type: 'raw_capture_event' as const,
      captureId: 'raw_capture:ui',
      rootOperationId: 'agent_turn:ui',
    };
    await act(async () => {
      control.emit({
        ...common,
        sequence: 0,
        event: { kind: 'root_started' },
      });
      control.emit({
        ...common,
        sequence: 1,
        event: {
          kind: 'provider_prompt',
          requestId: 'provider:ui',
          requestKind: 'turn',
          providerStep: 0,
          requestAttempt: 1,
          toolName: null,
          toolNameTruncated: false,
          toolCallId: null,
          toolCallIdTruncated: false,
          content: {
            text: 'captured prompt in page memory',
            originalBytes: 30,
            retainedBytes: 30,
            truncated: false,
            configuredSecretMatches: 0,
            knownPatternMatches: 0,
          },
        },
      });
      control.emit({
        ...common,
        sequence: 2,
        event: {
          kind: 'capture_completed',
          reason: 'final_answer',
          contentEventCount: 1,
          truncatedFieldCount: 0,
          droppedEventCount: 0,
          droppedBytes: 0,
          retainedBytes: 500,
        },
      });
      await Promise.resolve();
    });

    const rawEvents = container.querySelector('[data-testid="agent-diagnostics-raw-events"]')!;
    expect(rawEvents.querySelectorAll('li')).toHaveLength(3);
    expect(rawEvents.textContent).toContain('provider_prompt');
    expect(rawEvents.textContent).toContain('capture_completed');
    expect(rawEvents.textContent).toContain('captured prompt in page memory');
    expect(container.querySelector('[data-testid="agent-diagnostics-raw-status"]')?.textContent)
      .toContain('agent_turn:ui');
    expect(container.querySelector('[data-testid="agent-diagnostics-timeline"]')?.textContent ?? '')
      .not.toContain('captured prompt in page memory');

    await act(async () => {
      for (const listener of control.disconnectListeners) listener();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="agent-diagnostics-raw-events"]')).toBeNull();

    expect(container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-toggle-raw-capture"]')?.disabled).toBe(true);
  });

  it('exports the selected scope as Port chunks without stringifying React artifact state', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:trace-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const evidence = ports.find((port) => port.name === DEV_TRACE_EVIDENCE_PORT)!;
    const control = ports.find((port) => port.name === DEV_TRACE_CONTROL_PORT)!;
    await deliverArtifact(evidence, sampleArtifact());
    const scope = container.querySelector<HTMLSelectElement>('[data-testid="agent-diagnostics-export-scope"]')!;
    await act(async () => {
      scope.value = 'session';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const exportButton = container.querySelector<HTMLButtonElement>('button[title="Export traces"]')!;
    await act(async () => {
      exportButton.click();
      await Promise.resolve();
    });
    const request = evidence.posted.at(-1) as { requestId: string };
    expect(evidence.posted.at(-1)).toEqual(expect.objectContaining({
      type: 'export',
      scope: { kind: 'session', id: 'session-active' },
      cursor: null,
    }));
    expect(container.querySelector<HTMLButtonElement>('button[title="Import trace artifact"]')?.disabled)
      .toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[title="Clear local traces"]')?.disabled)
      .toBe(true);

    await act(async () => {
      evidence.emit({
        version: 1,
        requestId: request.requestId,
        type: 'export_chunk',
        snapshotId: 'export-snapshot',
        cursor: 'export-next',
        chunkIndex: 0,
        byteLength: 1,
        done: false,
        jsonChunk: '{',
      });
      await Promise.resolve();
    });
    expect(evidence.posted.at(-1)).toEqual(expect.objectContaining({
      type: 'export',
      cursor: 'export-next',
    }));
    const requestCountDuringExport = evidence.posted.length;
    await act(async () => {
      control.emit({
        version: 1,
        requestId: 'clear-during-export',
        type: 'control_result',
        action: 'cleared',
      });
      await Promise.resolve();
    });
    expect(evidence.posted).toHaveLength(requestCountDuringExport);
    await act(async () => {
      evidence.emit({
        version: 1,
        requestId: request.requestId,
        type: 'export_chunk',
        snapshotId: 'export-snapshot',
        cursor: null,
        chunkIndex: 1,
        byteLength: 1,
        done: true,
        jsonChunk: '}',
      });
      await Promise.resolve();
    });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(vi.mocked(URL.createObjectURL).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      size: 2,
      type: 'application/json',
    }));
    expect(click).toHaveBeenCalledOnce();
    expect(evidence.posted.at(-1)).toEqual(expect.objectContaining({
      type: 'get_snapshot',
      cursor: null,
    }));
  });

  it('disconnects privileged Ports after import and never opens them in imported-only mode', async () => {
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    expect(ports).toHaveLength(2);
    const input = container.querySelector<HTMLInputElement>('[data-testid="agent-diagnostics-import-input"]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['{}'], 'trace.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(ports.every((port) => port.disconnected)).toBe(true);
    expect(container.querySelector('[data-testid="agent-diagnostics-raw-capture"]')).toBeNull();

    expect(container.querySelector('[data-testid="agent-diagnostics-return-live"]')).not.toBeNull();
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');

    cleanupMountedRootsAndBody(mountedRoots);
    ports = [];
    window.history.replaceState(null, '', '/?source=imported');
    const importedContainer = mountReact(<AgentDiagnostics />, mountedRoots);
    expect(ports).toEqual([]);
    expect(importedContainer.querySelector('[data-testid="agent-diagnostics-return-live"]')).toBeTruthy();
  });

  it('cancels an in-flight imported file before returning to live traces', async () => {
    deferFileParse = true;
    window.history.replaceState(null, '', '/?source=imported');
    const container = mountReact(<AgentDiagnostics />, mountedRoots);
    const input = container.querySelector<HTMLInputElement>('[data-testid="agent-diagnostics-import-input"]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['{}'], 'slow-trace.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const parseRequest = workers[0]?.posted.find((message) => message.type === 'artifact_parse_file');
    if (!parseRequest || parseRequest.type !== 'artifact_parse_file') {
      throw new TypeError('Expected a deferred import request.');
    }

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-return-live"]')?.click();
      await Promise.resolve();
    });
    expect(workers[0]?.posted).toContainEqual({
      type: 'artifact_parse_cancel',
      jobId: parseRequest.jobId,
    });
    expect(ports).toHaveLength(2);

    await act(async () => {
      workers[0]?.emitResponse({
        type: 'artifact_parse_result',
        jobId: parseRequest.jobId,
        artifact: sampleArtifact(),
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-diagnostics-return-live"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-diagnostics-raw-capture"]')).not.toBeNull();
  });
});
