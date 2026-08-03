import { describe, expect, it, vi } from 'vitest';
import {
  DEV_TRACE_CONTROL_PORT,
  DEV_TRACE_EVIDENCE_PORT,
  type DevTraceEvidenceChunk,
  type DevTracePortResponse,
  type TraceArtifactV1,
} from '@/agent-observability';
import { attachDevTracePort } from '@/agent-observability/dev-port';
import type { DevTraceDB } from '@/agent-observability/dev-trace-db';
import type { DevRawCaptureCoordinator } from '@/agent-observability/raw-capture';

class FakePort {
  readonly posted: DevTracePortResponse[] = [];
  readonly messageListeners: Array<(message: unknown) => void> = [];
  readonly disconnectListeners: Array<() => void> = [];
  disconnected = false;

  constructor(
    readonly name: string,
    readonly sender: Readonly<{ id?: string; url?: string }>,
  ) {}

  postMessage(message: DevTracePortResponse): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => this.messageListeners.push(listener),
  };

  readonly onDisconnect = {
    addListener: (listener: () => void) => this.disconnectListeners.push(listener),
  };

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

const diagnosticsUrl = 'chrome-extension://test-extension/src/dev-agent/index.html';

function artifact(): TraceArtifactV1 {
  return {
    schemaVersion: 1,
    exporterVersion: 'test',
    exportedAt: 1,
    scope: { kind: 'all_retained', id: null },
    build: { versionHash: 'test', extensionVersion: '1.0.8', runtime: 'service_worker', dev: true },
    completeness: {
      retainedFromMs: null,
      retainedToMs: null,
      evictedRootCount: 0,
      droppedEventCount: 0,
      truncatedFieldCount: 0,
      unknownEventCount: 0,
      activeBeforeTracing: false,
      sequenceGaps: [],
    },
    roots: [],
    spans: [],
    events: [],
    aggregates: { rootCount: 0, eventCount: 0, failedRootCount: 0 },
    integrity: { rootCount: 0, spanCount: 0, eventCount: 0 },
  };
}

function dependencies(db: {
  readArtifact: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  streamArtifactJson?: ReturnType<typeof vi.fn>;
}) {
  db.streamArtifactJson ??= vi.fn((input: unknown) => (async function* () {
    yield JSON.stringify(await db.readArtifact(input));
  })());
  return {
    dev: true,
    createDb: () => db as unknown as DevTraceDB,
    runtimeId: () => 'test-extension',
    diagnosticsPageUrl: () => diagnosticsUrl,
    extensionVersion: () => '1.0.8',
    runScenario: vi.fn().mockResolvedValue({
      scenarioId: 'overflow-then-success',
      rootOperationIds: ['agent_turn:scenario-overflow'],
    }),
  } as const;
}

async function flushPort(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('Agent observability development Port', () => {
  it('requires a development build, this extension ID, and the exact diagnostics page URL before opening a database', () => {
    const db = { readArtifact: vi.fn(), clearAll: vi.fn() };
    const createDb = vi.fn(() => db as unknown as DevTraceDB);
    const port = new FakePort(DEV_TRACE_EVIDENCE_PORT, { id: 'other-extension', url: diagnosticsUrl });

    attachDevTracePort(port, {
      dev: true,
      createDb,
      runtimeId: () => 'test-extension',
      diagnosticsPageUrl: () => diagnosticsUrl,
    });

    expect(port.disconnected).toBe(true);
    expect(createDb).not.toHaveBeenCalled();
    expect(port.posted).toEqual([]);

    const releasePort = new FakePort(DEV_TRACE_EVIDENCE_PORT, { id: 'test-extension', url: diagnosticsUrl });
    attachDevTracePort(releasePort, { ...dependencies(db), dev: false });
    expect(releasePort.disconnected).toBe(true);
    expect(db.readArtifact).not.toHaveBeenCalled();
  });

  it('delivers UTF-8 bounded evidence chunks without admitting a control command', async () => {
    const evidence = {
      ...artifact(),
      exporterVersion: 'diagnostics-\u732b'.repeat(300),
    };
    const db = { readArtifact: vi.fn().mockResolvedValue(evidence), clearAll: vi.fn() };
    const port = new FakePort(DEV_TRACE_EVIDENCE_PORT, { id: 'test-extension', url: diagnosticsUrl });
    attachDevTracePort(port, dependencies(db));

    expect(port.posted).toEqual([{ version: 1, type: 'ready', port: 'evidence' }]);
    port.emit({
      version: 1,
      requestId: 'evidence-1',
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 4_096,
    });
    await flushPort();

    expect(port.posted.filter((message) => message.type === 'snapshot_chunk')).toHaveLength(1);
    for (;;) {
      const latest = port.posted.at(-1);
      if (!latest || latest.type !== 'snapshot_chunk' || latest.cursor === null) break;
      port.emit({
        version: 1,
        requestId: 'evidence-1',
        type: 'get_snapshot',
        scope: { kind: 'all_retained', id: null },
        cursor: latest.cursor,
        maxBytes: 4_096,
      });
      await flushPort();
    }

    const chunks = port.posted.filter(
      (message): message is DevTraceEvidenceChunk => message.type === 'snapshot_chunk',
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (
      new TextEncoder().encode(JSON.stringify(chunk)).byteLength <= 4_096
    ))).toBe(true);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.map((chunk) => chunk.jsonChunk).join('')).toBe(JSON.stringify(evidence));
    expect(db.readArtifact).toHaveBeenCalledOnce();
    expect(db.readArtifact).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'all_retained', id: null },
      build: expect.objectContaining({ runtime: 'service_worker', dev: true }),
    }));

    port.emit({
      version: 1,
      requestId: 'evidence-control-attempt',
      type: 'clear_traces',
      confirmation: 'clear-local-agent-traces',
    });
    await flushPort();
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'evidence-control-attempt',
      type: 'evidence_error',
      code: 'invalid_request',
    });
    expect(db.clearAll).not.toHaveBeenCalled();
  });

  it('budgets the response envelope for escaped request IDs and bounds invalid echoes', async () => {
    const db = { readArtifact: vi.fn().mockResolvedValue(artifact()), clearAll: vi.fn() };
    const port = new FakePort(DEV_TRACE_EVIDENCE_PORT, { id: 'test-extension', url: diagnosticsUrl });
    attachDevTracePort(port, dependencies(db));
    const escapedRequestId = '\u0000'.repeat(512);
    port.emit({
      version: 1,
      requestId: escapedRequestId,
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 4_096,
    });
    await flushPort();
    expect(port.posted.at(-1)).toEqual(expect.objectContaining({
      requestId: escapedRequestId,
      type: 'snapshot_chunk',
    }));
    expect(new TextEncoder().encode(JSON.stringify(port.posted.at(-1))).byteLength)
      .toBeLessThanOrEqual(4_096);

    port.emit({
      version: 1,
      requestId: 'x'.repeat(10_000),
      type: 'clear_traces',
      confirmation: 'clear-local-agent-traces',
    });
    await flushPort();
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'invalid',
      type: 'evidence_error',
      code: 'invalid_request',
    });
  });

  it('reserves envelope room for a full byteLength field when escaping backslashes', async () => {
    const db = {
      readArtifact: vi.fn(),
      clearAll: vi.fn(),
      streamArtifactJson: vi.fn(() => (async function* () {
        yield '\\'.repeat(20_000);
      })()),
    };
    const port = new FakePort(DEV_TRACE_EVIDENCE_PORT, { id: 'test-extension', url: diagnosticsUrl });
    attachDevTracePort(port, dependencies(db));

    port.emit({
      version: 1,
      requestId: 'backslash-budget',
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 4_096,
    });
    await flushPort();

    const chunk = port.posted.at(-1);
    expect(chunk?.type).toBe('snapshot_chunk');
    expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThanOrEqual(4_096);
  });

  it('rejects stale or mismatched cursors without creating another artifact', async () => {
    const db = {
      readArtifact: vi.fn().mockResolvedValue({
        ...artifact(),
        exporterVersion: 'cursor-snapshot'.repeat(300),
      }),
      clearAll: vi.fn(),
    };
    const port = new FakePort(DEV_TRACE_EVIDENCE_PORT, { id: 'test-extension', url: diagnosticsUrl });
    attachDevTracePort(port, dependencies(db));

    port.emit({
      version: 1,
      requestId: 'snapshot',
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: null,
      maxBytes: 4_096,
    });
    await flushPort();
    const first = port.posted.at(-1);
    expect(first?.type).toBe('snapshot_chunk');
    if (!first || first.type !== 'snapshot_chunk' || first.cursor === null) {
      throw new TypeError('Expected a resumable snapshot chunk.');
    }

    port.emit({
      version: 1,
      requestId: 'snapshot-wrong-scope',
      type: 'get_snapshot',
      scope: { kind: 'root', id: 'agent_turn:other' },
      cursor: first.cursor,
      maxBytes: 4_096,
    });
    await flushPort();
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'snapshot-wrong-scope',
      type: 'evidence_error',
      code: 'invalid_cursor',
    });

    port.emit({
      version: 1,
      requestId: 'snapshot-resume',
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: first.cursor,
      maxBytes: 4_096,
    });
    await flushPort();
    const second = port.posted.at(-1);
    expect(second?.type).toBe('snapshot_chunk');

    port.emit({
      version: 1,
      requestId: 'snapshot-replay',
      type: 'get_snapshot',
      scope: { kind: 'all_retained', id: null },
      cursor: first.cursor,
      maxBytes: 4_096,
    });
    await flushPort();
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'snapshot-replay',
      type: 'evidence_error',
      code: 'invalid_cursor',
    });
    expect(db.readArtifact).toHaveBeenCalledOnce();
  });

  it('closes an abandoned stream when a new snapshot supersedes it', async () => {
    let closed = false;
    const db = {
      readArtifact: vi.fn(),
      clearAll: vi.fn(),
      streamArtifactJson: vi.fn(() => (async function* () {
        try {
          yield JSON.stringify({
            ...artifact(),
            exporterVersion: 'superseded'.repeat(500),
          });
        } finally {
          closed = true;
        }
      })()),
    };
    const port = new FakePort(DEV_TRACE_EVIDENCE_PORT, { id: 'test-extension', url: diagnosticsUrl });
    attachDevTracePort(port, dependencies(db));

    const request = {
      version: 1 as const,
      type: 'get_snapshot' as const,
      scope: { kind: 'all_retained' as const, id: null },
      cursor: null,
      maxBytes: 4_096,
    };
    port.emit({ ...request, requestId: 'first' });
    await flushPort();
    expect(port.posted.at(-1)).toEqual(expect.objectContaining({
      requestId: 'first',
      type: 'snapshot_chunk',
      done: false,
    }));

    port.emit({ ...request, requestId: 'replacement' });
    await flushPort();
    expect(closed).toBe(true);
    expect(port.posted.at(-1)).toEqual(expect.objectContaining({
      requestId: 'replacement',
      type: 'snapshot_chunk',
    }));
  });

  it('runs only a validated Scenario Lab fixture and clears only the development trace database', async () => {
    const db = { readArtifact: vi.fn(), clearAll: vi.fn().mockResolvedValue(undefined) };
    const port = new FakePort(DEV_TRACE_CONTROL_PORT, { id: 'test-extension', url: diagnosticsUrl });
    const deps = dependencies(db);
    attachDevTracePort(port, deps);

    port.emit({ version: 1, requestId: 'scenario', type: 'run_scenario', scenarioId: 'overflow-then-success', controls: { delayMs: 0, contextWindow: 8_192 } });
    await flushPort();
    expect(deps.runScenario).toHaveBeenCalledWith({
      scenarioId: 'overflow-then-success',
      controls: { delayMs: 0, contextWindow: 8_192 },
    }, db);
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'scenario',
      type: 'control_result',
      action: 'scenario_completed',
      scenarioId: 'overflow-then-success',
      rootOperationIds: ['agent_turn:scenario-overflow'],
    });
    expect(db.readArtifact).not.toHaveBeenCalled();
    expect(db.clearAll).not.toHaveBeenCalled();

    port.emit({
      version: 1,
      requestId: 'clear',
      type: 'clear_traces',
      confirmation: 'clear-local-agent-traces',
    });
    await flushPort();
    expect(db.clearAll).toHaveBeenCalledOnce();
    expect(db.readArtifact).not.toHaveBeenCalled();
    expect(port.posted.at(-1)).toEqual({ version: 1, requestId: 'clear', type: 'control_result', action: 'cleared' });
  });

  it('binds raw capture commands and disconnect cleanup to the exact control Port', async () => {
    const db = { readArtifact: vi.fn(), clearAll: vi.fn() };
    const rawCapture = {
      arm: vi.fn().mockResolvedValue({ kind: 'armed', captureId: 'raw_capture:test' }),
      disarm: vi.fn().mockReturnValue('raw_capture:test'),
      disconnect: vi.fn(),
      beginRoot: vi.fn(),
    } satisfies DevRawCaptureCoordinator;
    const port = new FakePort(DEV_TRACE_CONTROL_PORT, {
      id: 'test-extension',
      url: diagnosticsUrl,
    });
    attachDevTracePort(port, { ...dependencies(db), rawCapture });

    port.emit({ version: 1, requestId: 'arm', type: 'arm_raw_capture' });
    await flushPort();
    expect(rawCapture.arm).toHaveBeenCalledWith(port);
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'arm',
      type: 'control_result',
      action: 'raw_capture_armed',
      captureId: 'raw_capture:test',
    });

    port.emit({ version: 1, requestId: 'disarm', type: 'disarm_raw_capture' });
    await flushPort();
    expect(rawCapture.disarm).toHaveBeenCalledWith(port);
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'disarm',
      type: 'control_result',
      action: 'raw_capture_disarmed',
      captureId: 'raw_capture:test',
    });

    for (const listener of port.disconnectListeners) listener();
    expect(rawCapture.disconnect).toHaveBeenCalledWith(port);
  });

  it('controls Provider monitoring only through the authorized development Port', async () => {
    const db = { readArtifact: vi.fn(), clearAll: vi.fn() };
    const state = {
      sessionId: 'provider-monitor:test',
      startedAt: 100,
      expiresAt: 200,
    };
    const providerMonitor = {
      start: vi.fn().mockResolvedValue(state),
      stop: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue(state),
    };
    const port = new FakePort(DEV_TRACE_CONTROL_PORT, {
      id: 'test-extension',
      url: diagnosticsUrl,
    });
    attachDevTracePort(port, { ...dependencies(db), providerMonitor });

    port.emit({
      version: 1,
      requestId: 'monitor-start',
      type: 'start_provider_monitor',
      state,
    });
    await flushPort();
    expect(providerMonitor.start).toHaveBeenCalledWith(state);
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'monitor-start',
      type: 'control_result',
      action: 'provider_monitor_started',
      state,
    });

    port.emit({ version: 1, requestId: 'monitor-status', type: 'get_provider_monitor_status' });
    await flushPort();
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'monitor-status',
      type: 'control_result',
      action: 'provider_monitor_status',
      state,
    });

    port.emit({ version: 1, requestId: 'monitor-stop', type: 'stop_provider_monitor' });
    await flushPort();
    expect(providerMonitor.stop).toHaveBeenCalledOnce();
    expect(port.posted.at(-1)).toEqual({
      version: 1,
      requestId: 'monitor-stop',
      type: 'control_result',
      action: 'provider_monitor_stopped',
    });
  });
});
