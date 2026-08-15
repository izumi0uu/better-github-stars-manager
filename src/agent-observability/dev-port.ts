import { VERSION_HASH } from '@/dev';
import {
  createAsyncTraceArtifactJsonReader,
  type AsyncTraceArtifactJsonReader,
} from './artifact-json-stream';
import { DevTraceDB } from './dev-trace-db';
import { runDevTraceScenario, type DevTraceScenarioInput, type DevTraceScenarioResult } from './scenario-lab';
import type { DevRawCaptureCoordinator } from './raw-capture';
import type { ProviderDiagnosticsMonitor } from './provider-monitor';
import {
  DEV_TRACE_CONTROL_PORT,
  DEV_TRACE_EVIDENCE_PORT,
  validateDevTraceControlRequest,
  validateDevTraceEvidenceRequest,
  type DevTraceControlRequest,
  type DevTraceEvidenceRequest,
  type DevTracePortResponse,
} from './dev-protocol';

type DevTracePort = Readonly<{
  name: string;
  sender?: Readonly<{ id?: string; url?: string }>;
  postMessage(message: DevTracePortResponse): void;
  disconnect(): void;
  onMessage: Readonly<{ addListener(listener: (message: unknown) => void): void }>;
  onDisconnect: Readonly<{ addListener(listener: () => void): void }>;
}>;

type EvidenceTransfer = {
  snapshotId: string;
  cursor: string;
  requestType: DevTraceEvidenceRequest['type'];
  scopeKey: string;
  maxBytes: number;
  chunkIndex: number;
  reader: AsyncTraceArtifactJsonReader;
};

export type DevTracePortDependencies = Readonly<{
  dev?: boolean;
  createDb?: () => DevTraceDB;
  runtimeId?: () => string;
  diagnosticsPageUrl?: () => string;
  extensionVersion?: () => string;
  runScenario?: (
    input: DevTraceScenarioInput,
    db: DevTraceDB,
  ) => Promise<DevTraceScenarioResult>;
  rawCapture?: DevRawCaptureCoordinator;
  providerMonitor?: Pick<ProviderDiagnosticsMonitor, 'start' | 'stop' | 'status'>;
}>;

const DIAGNOSTICS_PAGE_PATH = 'src/dev-agent/index.html';

/**
 * Binds one authorized diagnostics Port. The page only receives the same
 * metadata artifact persisted by the recorder; it never reads product stores.
 */
export function attachDevTracePort(
  port: DevTracePort,
  dependencies: DevTracePortDependencies = {},
): void {
  const dev = dependencies.dev ?? __GSM_DEV__;
  const runtimeId = dependencies.runtimeId ?? (() => chrome.runtime.id);
  const diagnosticsPageUrl = dependencies.diagnosticsPageUrl
    ?? (() => chrome.runtime.getURL(DIAGNOSTICS_PAGE_PATH));
  const extensionVersion = dependencies.extensionVersion
    ?? (() => chrome.runtime.getManifest().version);
  if (
    !dev ||
    (port.name !== DEV_TRACE_EVIDENCE_PORT && port.name !== DEV_TRACE_CONTROL_PORT) ||
    port.sender?.id !== runtimeId() ||
    port.sender?.url !== diagnosticsPageUrl()
  ) {
    port.disconnect();
    return;
  }

  const ownsDb = !dependencies.createDb;
  const db = dependencies.createDb?.() ?? new DevTraceDB();
  const evidence = port.name === DEV_TRACE_EVIDENCE_PORT;
  const runScenario = dependencies.runScenario
    ?? ((input: DevTraceScenarioInput, scenarioDb: DevTraceDB) => runDevTraceScenario(input, {
      dev,
      db: scenarioDb,
    }));
  let evidenceTransfer: EvidenceTransfer | null = null;
  let messageTail = Promise.resolve();
  safePost(port, { version: 1, type: 'ready', port: evidence ? 'evidence' : 'control' });

  port.onMessage.addListener((message) => {
    messageTail = messageTail.then(async () => {
      if (evidence) {
        evidenceTransfer = await handleEvidence(
          port,
          db,
          message,
          extensionVersion,
          evidenceTransfer,
        );
        return;
      }
      await handleControl(
        port,
        db,
        message,
        runScenario,
        dependencies.rawCapture,
        dependencies.providerMonitor,
      );
    }).catch(() => undefined);
  });
  port.onDisconnect.addListener(() => {
    void evidenceTransfer?.reader.cancel().catch(() => undefined);
    evidenceTransfer = null;
    dependencies.rawCapture?.disconnect(port);
    if (ownsDb) db.close();
  });
}

async function handleEvidence(
  port: DevTracePort,
  db: DevTraceDB,
  value: unknown,
  extensionVersion: () => string,
  activeTransfer: EvidenceTransfer | null,
): Promise<EvidenceTransfer | null> {
  let request: DevTraceEvidenceRequest;
  try {
    request = validateDevTraceEvidenceRequest(value);
  } catch {
    safePost(port, { version: 1, requestId: requestIdFrom(value), type: 'evidence_error', code: 'invalid_request' });
    return activeTransfer;
  }
  let transferForCleanup = activeTransfer;
  try {
    const scope = request.type === 'subscribe'
      ? { kind: 'all_retained' as const, id: null }
      : request.scope;
    const maxBytes = request.type === 'subscribe' ? 256 * 1024 : request.maxBytes;
    const scopeKey = JSON.stringify(scope);
    let transfer: EvidenceTransfer;
    if (request.cursor === null) {
      await activeTransfer?.reader.cancel();
      const source = db.streamArtifactJson({
        scope,
        exporterVersion: 'bgsm-agent-dev-port',
        build: {
          versionHash: VERSION_HASH,
          extensionVersion: extensionVersion(),
          runtime: 'service_worker',
          dev: true,
        },
      });
      transfer = {
        snapshotId: crypto.randomUUID(),
        cursor: crypto.randomUUID(),
        requestType: request.type,
        scopeKey,
        maxBytes,
        chunkIndex: 0,
        reader: createAsyncTraceArtifactJsonReader(source),
      };
      transferForCleanup = transfer;
    } else {
      if (
        !activeTransfer
        || request.cursor !== activeTransfer.cursor
        || request.type !== activeTransfer.requestType
        || scopeKey !== activeTransfer.scopeKey
        || maxBytes !== activeTransfer.maxBytes
      ) {
        safePost(port, {
          version: 1,
          requestId: request.requestId,
          type: 'evidence_error',
          code: 'invalid_cursor',
        });
        return activeTransfer;
      }
      transfer = activeTransfer;
    }
    const kind = request.type === 'export' ? 'export_chunk' : 'snapshot_chunk';
    const candidateCursor = crypto.randomUUID();
    const envelopeBytes = utf8Bytes(JSON.stringify({
      version: 1,
      requestId: request.requestId,
      type: kind,
      snapshotId: transfer.snapshotId,
      cursor: candidateCursor,
      chunkIndex: transfer.chunkIndex,
      // A full chunk can have any byte length up to the caller's limit.
      // Reserve its widest decimal representation before choosing content.
      byteLength: maxBytes,
      done: false,
      jsonChunk: '',
    }));
    // The artifact source is already JSON, so embedding a chunk in the Port
    // envelope can at most double its bytes by escaping quotes and backslashes.
    const contentBudget = Math.floor((maxBytes - envelopeBytes) / 2);
    const chunk = await transfer.reader.read(contentBudget);
    const nextCursor = chunk.done ? null : candidateCursor;
    const response = {
      version: 1,
      requestId: request.requestId,
      type: kind,
      snapshotId: transfer.snapshotId,
      cursor: nextCursor,
      chunkIndex: transfer.chunkIndex,
      byteLength: chunk.byteLength,
      done: chunk.done,
      jsonChunk: chunk.jsonChunk,
    } as const;
    if (utf8Bytes(JSON.stringify(response)) > maxBytes) {
      throw new TypeError('Evidence response exceeds the requested message limit.');
    }
    safePost(port, response);
    if (chunk.done) return null;
    return {
      ...transfer,
      cursor: nextCursor!,
      chunkIndex: transfer.chunkIndex + 1,
    };
  } catch {
    await transferForCleanup?.reader.cancel().catch(() => undefined);
    safePost(port, { version: 1, requestId: request.requestId, type: 'evidence_error', code: 'internal_error' });
    return null;
  }
}

async function handleControl(
  port: DevTracePort,
  db: DevTraceDB,
  value: unknown,
  runScenario: NonNullable<DevTracePortDependencies['runScenario']>,
  rawCapture: DevRawCaptureCoordinator | undefined,
  providerMonitor: DevTracePortDependencies['providerMonitor'],
): Promise<void> {
  let request: DevTraceControlRequest;
  try {
    request = validateDevTraceControlRequest(value);
  } catch {
    safePost(port, { version: 1, requestId: requestIdFrom(value), type: 'control_error', code: 'invalid_request' });
    return;
  }
  if (request.type === 'run_scenario') {
    try {
      const result = await runScenario({
        scenarioId: request.scenarioId,
        controls: request.controls,
      }, db);
      safePost(port, {
        version: 1,
        requestId: request.requestId,
        type: 'control_result',
        action: 'scenario_completed',
        scenarioId: result.scenarioId,
        rootOperationIds: result.rootOperationIds,
      });
    } catch {
      safePost(port, { version: 1, requestId: request.requestId, type: 'control_error', code: 'internal_error' });
    }
    return;
  }
  if (request.type === 'arm_raw_capture') {
    if (!rawCapture) {
      safePost(port, { version: 1, requestId: request.requestId, type: 'control_error', code: 'unavailable' });
      return;
    }
    try {
      const result = await rawCapture.arm(port);
      if (result.kind === 'unavailable') {
        safePost(port, { version: 1, requestId: request.requestId, type: 'control_error', code: 'unavailable' });
        return;
      }
      safePost(port, {
        version: 1,
        requestId: request.requestId,
        type: 'control_result',
        action: 'raw_capture_armed',
        captureId: result.captureId,
      });
    } catch {
      safePost(port, { version: 1, requestId: request.requestId, type: 'control_error', code: 'internal_error' });
    }
    return;
  }
  if (request.type === 'disarm_raw_capture') {
    safePost(port, {
      version: 1,
      requestId: request.requestId,
      type: 'control_result',
      action: 'raw_capture_disarmed',
      captureId: rawCapture?.disarm(port) ?? null,
    });
    return;
  }
  if (
    request.type === 'start_provider_monitor'
    || request.type === 'stop_provider_monitor'
    || request.type === 'get_provider_monitor_status'
  ) {
    if (!providerMonitor) {
      safePost(port, { version: 1, requestId: request.requestId, type: 'control_error', code: 'unavailable' });
      return;
    }
    try {
      if (request.type === 'start_provider_monitor') {
        const state = await providerMonitor.start(request.state);
        safePost(port, {
          version: 1,
          requestId: request.requestId,
          type: 'control_result',
          action: 'provider_monitor_started',
          state,
        });
        return;
      }
      if (request.type === 'stop_provider_monitor') {
        await providerMonitor.stop();
        safePost(port, {
          version: 1,
          requestId: request.requestId,
          type: 'control_result',
          action: 'provider_monitor_stopped',
        });
        return;
      }
      safePost(port, {
        version: 1,
        requestId: request.requestId,
        type: 'control_result',
        action: 'provider_monitor_status',
        state: await providerMonitor.status(),
      });
    } catch {
      safePost(port, { version: 1, requestId: request.requestId, type: 'control_error', code: 'internal_error' });
    }
    return;
  }
  try {
    await db.clearAll();
    safePost(port, { version: 1, requestId: request.requestId, type: 'control_result', action: 'cleared' });
  } catch {
    safePost(port, { version: 1, requestId: request.requestId, type: 'control_error', code: 'internal_error' });
  }
}

function requestIdFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return 'invalid';
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' && requestId.trim() && utf8Bytes(requestId) <= 512
    ? requestId
    : 'invalid';
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safePost(port: DevTracePort, message: DevTracePortResponse): void {
  try {
    port.postMessage(message);
  } catch {
    // The diagnostics page may close while a bounded snapshot is in flight.
  }
}
