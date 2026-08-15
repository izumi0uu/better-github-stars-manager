import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, RefreshCw, ShieldAlert, Trash2, Upload } from 'lucide-react';
import {
  DEV_TRACE_CONTROL_PORT,
  DEV_TRACE_EVIDENCE_PORT,
  DEV_TRACE_SCENARIO_IDS,
  MAX_TRACE_ARTIFACT_BYTES,
  type DevTracePortResponse,
  type DevRawCaptureEvent,
  type DevTraceEventKind,
  type DevTraceScenarioId,
  type DevTraceScope,
  type TraceArtifact,
} from '@/agent-observability';
import { VERSION_HASH } from '@/dev';
import { useI18n } from '@/i18n';
import { Button } from '@/ui/shadcn/button';
import { cn } from '@/lib/utils';
import type {
  ArtifactWorkerRequest,
  ArtifactWorkerResponse,
} from './artifact-worker-protocol';
import { DiagnosticsAnalysisPanel } from './DiagnosticsAnalysisPanel';
import { getAgentDiagnosticsMessages } from './messages';
import { ProviderDebugPanel } from './ProviderDebugPanel';
import { SharedProviderDiagnosticsPanel } from './SharedProviderDiagnosticsPanel';

type TracePort = ReturnType<typeof chrome.runtime.connect>;
type ArtifactSource = 'live' | 'imported';
type EvidenceTransferBase = {
  requestId: string;
  requestType: 'get_snapshot' | 'export';
  scope: DevTraceScope;
  snapshotId: string | null;
  nextChunkIndex: number;
  artifactBytes: number;
};
type ArtifactBlobSink = Readonly<{
  write(chunk: Uint8Array): void;
  close(): Promise<Blob>;
  abort(): void;
}>;
type EvidenceTransfer = EvidenceTransferBase & ({
  kind: 'snapshot';
} | {
  kind: 'export';
  blobSink: ArtifactBlobSink;
});

const EVIDENCE_MESSAGE_BYTES = 256 * 1024;

function newRequestId(): string {
  return `diagnostics:${crypto.randomUUID()}`;
}

export function AgentDiagnostics() {
  const { locale } = useI18n();
  const d = getAgentDiagnosticsMessages(locale);
  const messagesRef = useRef(d);
  messagesRef.current = d;

  useEffect(() => {
    document.title = `BGSM ${d.title}`;
  }, [d.title]);

  const [artifactSource, setArtifactSource] = useState<ArtifactSource>(() => (
    !hasExtensionDiagnosticsRuntime()
      || new URLSearchParams(window.location.search).get('source') === 'imported'
      ? 'imported'
      : 'live'
  ));
  const extensionRuntimeAvailable = hasExtensionDiagnosticsRuntime();
  const [activeTab, setActiveTab] = useState<'traces' | 'analysis' | 'scenarios' | 'provider'>('traces');
  const [artifact, setArtifact] = useState<TraceArtifact | null>(null);
  const [status, setStatus] = useState<'connecting' | 'loading' | 'ready' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventKindFilter, setEventKindFilter] = useState<DevTraceEventKind | 'all'>('all');
  const [scenarioId, setScenarioId] = useState<DevTraceScenarioId>(DEV_TRACE_SCENARIO_IDS[0]);
  const [scenarioControls, setScenarioControls] = useState({ delayMs: 0, contextWindow: 8_192 });
  const [scenarioState, setScenarioState] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [controlReady, setControlReady] = useState(false);
  const [importState, setImportState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [importError, setImportError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportScopeKind, setExportScopeKind] = useState<DevTraceScope['kind']>('all_retained');
  const [rawCaptureState, setRawCaptureState] = useState<
    'idle' | 'arming' | 'armed' | 'capturing' | 'completed' | 'error'
  >('idle');
  const [rawCaptureId, setRawCaptureId] = useState<string | null>(null);
  const [rawCaptureRootId, setRawCaptureRootId] = useState<string | null>(null);
  const [rawCaptureError, setRawCaptureError] = useState<string | null>(null);
  const [rawCaptureEvents, setRawCaptureEvents] = useState<DevRawCaptureEvent[]>([]);
  const evidenceRef = useRef<TracePort | null>(null);
  const controlRef = useRef<TracePort | null>(null);
  const artifactWorkerRef = useRef<Worker | null>(null);
  const parseJobsRef = useRef(new Map<string, ArtifactSource>());
  const activeImportJobRef = useRef<string | null>(null);
  const activeEvidenceTransferRef = useRef<EvidenceTransfer | null>(null);
  const snapshotAfterExportRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const rawRequestIdsRef = useRef(new Set<string>());

  const selectedRoot = useMemo(
    () => artifact?.roots.find((root) => root.rootOperationId === selectedRootId) ?? null,
    [artifact, selectedRootId],
  );
  const selectedEvents = useMemo(() => selectedRoot
    ? artifact?.events.filter((event) => (
      event.rootOperationId === selectedRoot.rootOperationId
      && (eventKindFilter === 'all' || event.kind === eventKindFilter)
    )) ?? []
    : [], [artifact, eventKindFilter, selectedRoot]);
  const selectedEvent = useMemo(
    () => selectedEvents.find((event) => event.eventId === selectedEventId) ?? null,
    [selectedEventId, selectedEvents],
  );
  const eventKinds = useMemo(() => [...new Set(
    selectedRoot
      ? (artifact?.events.filter((event) => event.rootOperationId === selectedRoot.rootOperationId) ?? [])
        .map((event) => event.kind)
      : [],
  )].sort(), [artifact, selectedRoot]);
  const timelineVirtualizer = useVirtualizer({
    count: selectedEvents.length,
    getScrollElement: () => timelineScrollRef.current,
    getItemKey: (index) => selectedEvents[index]?.eventId ?? index,
    estimateSize: () => 52,
    overscan: 12,
    initialRect: { width: 720, height: 560 },
  });

  const requestSnapshot = useCallback(() => {
    const port = evidenceRef.current;
    const worker = artifactWorkerRef.current;
    if (artifactSource !== 'live' || !port || !worker) return;
    const previous = activeEvidenceTransferRef.current;
    if (previous?.kind === 'export') {
      snapshotAfterExportRef.current = true;
      return;
    }
    if (previous?.kind === 'snapshot') {
      worker.postMessage({
        type: 'artifact_parse_cancel',
        jobId: previous.requestId,
      } satisfies ArtifactWorkerRequest);
      parseJobsRef.current.delete(previous.requestId);
    }
    const requestId = newRequestId();
    const scope = { kind: 'all_retained' as const, id: null };
    activeEvidenceTransferRef.current = {
      kind: 'snapshot',
      requestId,
      requestType: 'get_snapshot',
      scope,
      snapshotId: null,
      nextChunkIndex: 0,
      artifactBytes: 0,
    };
    parseJobsRef.current.set(requestId, 'live');
    worker.postMessage({
      type: 'artifact_parse_start',
      jobId: requestId,
      maxBytes: MAX_TRACE_ARTIFACT_BYTES,
    } satisfies ArtifactWorkerRequest);
    setStatus('loading');
    setError(null);
    port.postMessage({
      version: 1,
      requestId,
      type: 'get_snapshot',
      scope,
      cursor: null,
      maxBytes: EVIDENCE_MESSAGE_BYTES,
    });
  }, [artifactSource]);

  useEffect(() => {
    const worker = new Worker(new URL('./artifact-worker.ts', import.meta.url), { type: 'module' });
    artifactWorkerRef.current = worker;
    worker.onmessage = (message: MessageEvent<ArtifactWorkerResponse>) => {
      const source = parseJobsRef.current.get(message.data.jobId);
      if (!source) return;
      parseJobsRef.current.delete(message.data.jobId);
      if (source === 'imported' && activeImportJobRef.current === message.data.jobId) {
        activeImportJobRef.current = null;
      }
      if (message.data.type === 'artifact_parse_error') {
        if (source === 'live') {
          setStatus('error');
          setError(`${message.data.code}: ${message.data.message}`);
        } else {
          setImportState('error');
          setImportError(`${message.data.code}: ${message.data.message}`);
        }
        return;
      }

      const next = message.data.artifact;
      setArtifact(next);
      setSelectedRootId(selectInitialRoot(next));
      setSelectedEventId(null);
      setEventKindFilter('all');
      setActiveTab('traces');
      setStatus('ready');
      if (source === 'imported') {
        setArtifactSourceUrl('imported');
        setArtifactSource('imported');
        setImportState('ready');
        setImportError(null);
        setExportState('idle');
        setExportError(null);
      }
    };
    worker.onerror = () => {
      for (const source of parseJobsRef.current.values()) {
        if (source === 'live') {
          setStatus('error');
          setError(messagesRef.current.artifactWorkerFailed);
        } else {
          setImportState('error');
          setImportError(messagesRef.current.artifactWorkerFailed);
        }
      }
      parseJobsRef.current.clear();
      activeImportJobRef.current = null;
    };
    return () => {
      worker.terminate();
      artifactWorkerRef.current = null;
      parseJobsRef.current.clear();
      activeImportJobRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (artifactSource !== 'live') {
      setControlReady(false);
      setStatus('ready');
      setError(null);
      return;
    }
    const evidence = chrome.runtime.connect({ name: DEV_TRACE_EVIDENCE_PORT });
    const control = chrome.runtime.connect({ name: DEV_TRACE_CONTROL_PORT });
    let closing = false;
    evidenceRef.current = evidence;
    controlRef.current = control;

    evidence.onMessage.addListener((message: DevTracePortResponse) => {
      if (message.type === 'ready' && message.port === 'evidence') {
        requestSnapshot();
        return;
      }
      if (message.type === 'evidence_error') {
        const active = activeEvidenceTransferRef.current;
        if (!active || active.requestId !== message.requestId) return;
        activeEvidenceTransferRef.current = null;
        if (active.kind === 'snapshot') {
          artifactWorkerRef.current?.postMessage({
            type: 'artifact_parse_cancel',
            jobId: active.requestId,
          } satisfies ArtifactWorkerRequest);
          parseJobsRef.current.delete(active.requestId);
          setStatus('error');
          setError(messagesRef.current.evidenceRequestFailed(message.code));
        } else {
          active.blobSink.abort();
          setExportState('error');
          setExportError(messagesRef.current.exportRequestFailed(message.code));
          if (snapshotAfterExportRef.current) {
            snapshotAfterExportRef.current = false;
            requestSnapshot();
          }
        }
        return;
      }
      if (message.type !== 'snapshot_chunk' && message.type !== 'export_chunk') return;
      const active = activeEvidenceTransferRef.current;
      if (!active || message.requestId !== active.requestId) return;
      const expectedType = active.kind === 'snapshot' ? 'snapshot_chunk' : 'export_chunk';
      const encodedChunk = new TextEncoder().encode(message.jsonChunk);
      const actualBytes = encodedChunk.byteLength;
      const invalid = message.type !== expectedType
        || (active.snapshotId !== null && message.snapshotId !== active.snapshotId)
        || message.chunkIndex !== active.nextChunkIndex
        || message.byteLength !== actualBytes
        || message.done !== (message.cursor === null)
        || active.artifactBytes + actualBytes > MAX_TRACE_ARTIFACT_BYTES;
      if (invalid) {
        activeEvidenceTransferRef.current = null;
        if (active.kind === 'snapshot') {
          artifactWorkerRef.current?.postMessage({
            type: 'artifact_parse_cancel',
            jobId: active.requestId,
          } satisfies ArtifactWorkerRequest);
          parseJobsRef.current.delete(active.requestId);
          setStatus('error');
          setError(messagesRef.current.evidenceIntegrityFailed);
        } else {
          active.blobSink.abort();
          setExportState('error');
          setExportError(messagesRef.current.exportIntegrityFailed);
          if (snapshotAfterExportRef.current) {
            snapshotAfterExportRef.current = false;
            requestSnapshot();
          }
        }
        return;
      }
      if (active.kind === 'export') active.blobSink.write(encodedChunk);
      const next: EvidenceTransfer = {
        ...active,
        snapshotId: message.snapshotId,
        nextChunkIndex: active.nextChunkIndex + 1,
        artifactBytes: active.artifactBytes + actualBytes,
      };
      if (active.kind === 'snapshot') {
        artifactWorkerRef.current?.postMessage({
          type: 'artifact_parse_chunk',
          jobId: active.requestId,
          jsonChunk: message.jsonChunk,
          done: message.done,
        } satisfies ArtifactWorkerRequest);
      }
      if (message.done) {
        activeEvidenceTransferRef.current = null;
        if (active.kind === 'export') {
          void active.blobSink.close().then((blob) => {
            if (closing) return;
            downloadArtifactBlob(blob);
            setExportState('completed');
            setExportError(null);
            if (snapshotAfterExportRef.current) {
              snapshotAfterExportRef.current = false;
              requestSnapshot();
            }
          }).catch(() => {
            if (closing) return;
            setExportState('error');
            setExportError(messagesRef.current.exportFinalizeFailed);
            if (snapshotAfterExportRef.current) {
              snapshotAfterExportRef.current = false;
              requestSnapshot();
            }
          });
        }
        return;
      }
      activeEvidenceTransferRef.current = next;
      evidence.postMessage({
        version: 1,
        requestId: next.requestId,
        type: next.requestType,
        scope: next.scope,
        cursor: message.cursor,
        maxBytes: EVIDENCE_MESSAGE_BYTES,
      });
    });
    control.onMessage.addListener((message: DevTracePortResponse) => {
      if (message.type === 'ready') {
        if (message.port === 'control') setControlReady(true);
        return;
      }
      if (message.type === 'raw_capture_event') {
        setRawCaptureId(message.captureId);
        setRawCaptureRootId(message.rootOperationId);
        setRawCaptureEvents((current) => [...current, message]);
        setRawCaptureState(message.event.kind === 'capture_completed' ? 'completed' : 'capturing');
        return;
      }
      if (message.type === 'control_error') {
        if (rawRequestIdsRef.current.delete(message.requestId)) {
          setRawCaptureState('error');
          setRawCaptureError(messagesRef.current.rawCaptureRequestFailed(message.code));
          return;
        }
        setScenarioState('error');
        setScenarioError(messagesRef.current.scenarioRequestFailed(message.code));
        return;
      }
      if (message.type !== 'control_result') return;
      if (message.action === 'raw_capture_armed') {
        rawRequestIdsRef.current.delete(message.requestId);
        setRawCaptureId(message.captureId);
        setRawCaptureRootId(null);
        setRawCaptureEvents([]);
        setRawCaptureError(null);
        setRawCaptureState('armed');
        return;
      }
      if (message.action === 'raw_capture_disarmed') {
        rawRequestIdsRef.current.delete(message.requestId);
        setRawCaptureId(null);
        setRawCaptureRootId(null);
        setRawCaptureEvents([]);
        setRawCaptureError(null);
        setRawCaptureState('idle');
        return;
      }
      if (message.action === 'cleared') {
        requestSnapshot();
        return;
      }
      if (message.action !== 'scenario_completed') return;
      setScenarioState('completed');
      setScenarioError(null);
      setSelectedRootId(message.rootOperationIds.at(-1) ?? null);
      setActiveTab('traces');
      requestSnapshot();
    });
    const disconnected = () => {
      if (closing) return;
      const active = activeEvidenceTransferRef.current;
      if (active?.kind === 'snapshot') {
        artifactWorkerRef.current?.postMessage({
          type: 'artifact_parse_cancel',
          jobId: active.requestId,
        } satisfies ArtifactWorkerRequest);
        parseJobsRef.current.delete(active.requestId);
      } else if (active?.kind === 'export') {
        active.blobSink.abort();
        setExportState('error');
        setExportError(messagesRef.current.exportConnectionClosed);
      }
      activeEvidenceTransferRef.current = null;
      snapshotAfterExportRef.current = false;
      setControlReady(false);
      setRawCaptureState('idle');
      setRawCaptureId(null);
      setRawCaptureRootId(null);
      setRawCaptureError(null);
      setRawCaptureEvents([]);
      rawRequestIdsRef.current.clear();
      setStatus('error');
      setError(messagesRef.current.connectionClosed);
    };
    evidence.onDisconnect.addListener(disconnected);
    control.onDisconnect.addListener(disconnected);
    return () => {
      closing = true;
      evidence.disconnect();
      control.disconnect();
      evidenceRef.current = null;
      controlRef.current = null;
      const active = activeEvidenceTransferRef.current;
      if (active?.kind === 'snapshot') {
        artifactWorkerRef.current?.postMessage({
          type: 'artifact_parse_cancel',
          jobId: active.requestId,
        } satisfies ArtifactWorkerRequest);
        parseJobsRef.current.delete(active.requestId);
      } else if (active?.kind === 'export') {
        active.blobSink.abort();
      }
      activeEvidenceTransferRef.current = null;
      snapshotAfterExportRef.current = false;
      setControlReady(false);
      setRawCaptureState('idle');
      setRawCaptureId(null);
      setRawCaptureRootId(null);
      setRawCaptureError(null);
      setRawCaptureEvents([]);
      rawRequestIdsRef.current.clear();
    };
  }, [artifactSource, requestSnapshot]);

  const clearTraces = () => {
    if (activeEvidenceTransferRef.current !== null || activeImportJobRef.current !== null) return;
    if (!window.confirm(d.clearTraceConfirmation)) return;
    controlRef.current?.postMessage({
      version: 1,
      requestId: newRequestId(),
      type: 'clear_traces',
      confirmation: 'clear-local-agent-traces',
    });
  };

  const exportArtifact = () => {
    const port = evidenceRef.current;
    if (
      artifactSource !== 'live'
      || !port
      || !artifact
      || activeEvidenceTransferRef.current
      || activeImportJobRef.current !== null
    ) return;
    const scope = exportScope(exportScopeKind, selectedRoot);
    if (!scope) {
      setExportState('error');
      setExportError(d.selectExportScope);
      return;
    }
    const requestId = newRequestId();
    activeEvidenceTransferRef.current = {
      kind: 'export',
      requestId,
      requestType: 'export',
      scope,
      snapshotId: null,
      nextChunkIndex: 0,
      artifactBytes: 0,
      blobSink: createArtifactBlobSink(),
    };
    setExportState('running');
    setExportError(null);
    port.postMessage({
      version: 1,
      requestId,
      type: 'export',
      scope,
      cursor: null,
      maxBytes: EVIDENCE_MESSAGE_BYTES,
    });
  };

  const importArtifact = (file: File | undefined) => {
    const worker = artifactWorkerRef.current;
    if (!worker || !file) return;
    if (activeEvidenceTransferRef.current?.kind === 'export') {
      setImportState('error');
      setImportError(d.waitForExport);
      return;
    }
    if (file.size > MAX_TRACE_ARTIFACT_BYTES) {
      setImportState('error');
      setImportError(d.artifactTooLarge);
      return;
    }
    const jobId = newRequestId();
    parseJobsRef.current.set(jobId, 'imported');
    activeImportJobRef.current = jobId;
    setImportState('loading');
    setImportError(null);
    worker.postMessage({
      type: 'artifact_parse_file',
      jobId,
      file,
      maxBytes: MAX_TRACE_ARTIFACT_BYTES,
    } satisfies ArtifactWorkerRequest);
  };

  const returnToLive = () => {
    const importJobId = activeImportJobRef.current;
    if (importJobId) {
      artifactWorkerRef.current?.postMessage({
        type: 'artifact_parse_cancel',
        jobId: importJobId,
      } satisfies ArtifactWorkerRequest);
      parseJobsRef.current.delete(importJobId);
      activeImportJobRef.current = null;
    }
    setArtifactSourceUrl('live');
    setArtifactSource('live');
    setArtifact(null);
    setSelectedRootId(null);
    setSelectedEventId(null);
    setEventKindFilter('all');
    setImportState('idle');
    setImportError(null);
    setExportState('idle');
    setExportError(null);
    setStatus('connecting');
    setError(null);
  };

  const runScenario = () => {
    const port = controlRef.current;
    if (!controlReady || !port) {
      setScenarioState('error');
      setScenarioError(d.scenarioControlNotReady);
      return;
    }
    const controls = {
      delayMs: Math.max(0, Math.min(30_000, Math.trunc(scenarioControls.delayMs))),
      contextWindow: Math.max(4_096, Math.min(1_000_000, Math.trunc(scenarioControls.contextWindow))),
    };
    setScenarioControls(controls);
    setScenarioState('running');
    setScenarioError(null);
    port.postMessage({
      version: 1,
      requestId: newRequestId(),
      type: 'run_scenario',
      scenarioId,
      controls,
    });
  };

  const toggleRawCapture = () => {
    const port = controlRef.current;
    if (!controlReady || !port) {
      setRawCaptureState('error');
      setRawCaptureError(d.rawCaptureControlNotReady);
      return;
    }
    const requestId = newRequestId();
    rawRequestIdsRef.current.add(requestId);
    const active = rawCaptureState === 'armed' || rawCaptureState === 'capturing';
    if (active) {
      port.postMessage({ version: 1, requestId, type: 'disarm_raw_capture' });
      return;
    }
    setRawCaptureState('arming');
    setRawCaptureId(null);
    setRawCaptureRootId(null);
    setRawCaptureEvents([]);
    setRawCaptureError(null);
    port.postMessage({ version: 1, requestId, type: 'arm_raw_capture' });
  };

  const inspectEvidence = (rootOperationId: string, eventId: string | null) => {
    setSelectedRootId(rootOperationId);
    setEventKindFilter('all');
    setSelectedEventId(eventId);
    setActiveTab('traces');
  };

  return (
    <main className="min-h-screen bg-background p-5 text-foreground" data-testid="agent-diagnostics-page">
      <header className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="m-0 text-xl font-semibold">{d.title}</h1>
          <p className="mb-0 mt-1 text-sm text-muted-foreground" data-testid="agent-diagnostics-build">
            {d.developmentBuild(VERSION_HASH)}
            {!extensionRuntimeAvailable && ` · ${d.standaloneViewer}`}
          </p>
          <p className="mb-0 mt-1 text-sm text-muted-foreground" data-testid="agent-diagnostics-status" role="status">
            {artifactSource === 'imported' && importState === 'loading' && d.openingImportedArtifact}
            {artifactSource === 'imported' && importState !== 'loading'
              && d.importedArtifact(artifact?.aggregates.rootCount ?? 0)}
            {artifactSource === 'live' && status === 'connecting' && d.connectingTraceRecorder}
            {artifactSource === 'live' && status === 'loading' && d.loadingTraceEvidence}
            {artifactSource === 'live' && status === 'ready' && d.retainedOperations(artifact?.aggregates.rootCount ?? 0)}
            {artifactSource === 'live' && status === 'error' && error}
          </p>
          {(importError || exportError) && (
            <p className="mb-0 mt-1 text-xs text-destructive" role="alert" data-testid="agent-diagnostics-transfer-error">
              {importError ?? exportError}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            data-testid="agent-diagnostics-import-input"
            onChange={(event) => {
              importArtifact(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <Button
            variant="outline"
            size="icon"
            title={d.importTraceArtifact}
            aria-label={d.importTraceArtifact}
            onClick={() => importInputRef.current?.click()}
            disabled={importState === 'loading' || exportState === 'running'}
          >
            <Upload className="size-4" />
          </Button>
          {artifactSource === 'imported' && extensionRuntimeAvailable ? (
            <Button variant="outline" onClick={returnToLive} data-testid="agent-diagnostics-return-live">
              {d.returnToLiveTraces}
            </Button>
          ) : artifactSource === 'live' ? (
            <>
              <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="diagnostic-export-scope">
                {d.export}
                <select
                  id="diagnostic-export-scope"
                  className="h-8 border border-input bg-background px-2 text-foreground"
                  value={exportScopeKind}
                  onChange={(event) => setExportScopeKind(event.target.value as DevTraceScope['kind'])}
                  disabled={exportState === 'running' || importState === 'loading'}
                  data-testid="agent-diagnostics-export-scope"
                >
                  <option value="all_retained">{d.allRetained}</option>
                  <option value="session" disabled={!selectedRoot?.sessionId}>{d.selectedSession}</option>
                  <option value="root" disabled={!selectedRoot}>{d.selectedOperation}</option>
                </select>
              </label>
              <Button
                variant="outline"
                size="icon"
                title={d.refreshTraces}
                aria-label={d.refreshTraces}
                onClick={requestSnapshot}
                disabled={status === 'loading' || exportState === 'running'}
              >
                <RefreshCw className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                title={d.exportTraces}
                aria-label={d.exportTraces}
                onClick={exportArtifact}
                disabled={!artifact || status === 'loading' || importState === 'loading' || exportState === 'running'}
              >
                <Download className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                title={d.clearLocalTraces}
                aria-label={d.clearLocalTraces}
                onClick={clearTraces}
                disabled={!controlReady || status === 'loading' || importState === 'loading' || exportState === 'running'}
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <div className="mx-auto mt-4 flex max-w-[1440px] border-b border-border" role="tablist" aria-label={d.viewsLabel}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'traces'}
          className={cn('border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
            'border-primary text-foreground': activeTab === 'traces',
            'border-transparent text-muted-foreground': activeTab !== 'traces',
          })}
          onClick={() => setActiveTab('traces')}
        >
          {d.traces}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'analysis'}
          className={cn('border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
            'border-primary text-foreground': activeTab === 'analysis',
            'border-transparent text-muted-foreground': activeTab !== 'analysis',
          })}
          onClick={() => setActiveTab('analysis')}
        >
          {d.analysis}
        </button>
        {artifactSource === 'live' && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'scenarios'}
            className={cn('border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
              'border-primary text-foreground': activeTab === 'scenarios',
              'border-transparent text-muted-foreground': activeTab !== 'scenarios',
            })}
            onClick={() => setActiveTab('scenarios')}
          >
            {d.scenarioLab}
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'provider'}
          className={cn('border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
            'border-primary text-foreground': activeTab === 'provider',
            'border-transparent text-muted-foreground': activeTab !== 'provider',
          })}
          onClick={() => setActiveTab('provider')}
        >
          {d.provider}
        </button>
      </div>

      {artifactSource === 'live' && <section
        className="mx-auto mt-4 max-w-[1440px] border-y border-border py-4"
        aria-labelledby="raw-capture-heading"
        data-testid="agent-diagnostics-raw-capture"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-4xl">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-amber-500" aria-hidden="true" />
              <h2 id="raw-capture-heading" className="m-0 text-sm font-semibold">{d.rawCapture}</h2>
            </div>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted-foreground">
              {d.rawCaptureNotice}
            </p>
            <p className="mb-0 mt-2 break-all text-xs" role="status" data-testid="agent-diagnostics-raw-status">
              {rawCaptureState === 'idle' && d.rawNotArmed}
              {rawCaptureState === 'arming' && d.rawLoadingExclusions}
              {rawCaptureState === 'armed' && d.rawArmed(rawCaptureId)}
              {rawCaptureState === 'capturing' && d.rawCapturing(rawCaptureRootId)}
              {rawCaptureState === 'completed' && d.rawCompleted(rawCaptureRootId)}
              {rawCaptureState === 'error' && rawCaptureError}
            </p>
          </div>
          <Button
            variant={rawCaptureState === 'armed' || rawCaptureState === 'capturing' ? 'outline' : 'default'}
            onClick={toggleRawCapture}
            disabled={!controlReady || rawCaptureState === 'arming'}
            data-testid="agent-diagnostics-toggle-raw-capture"
          >
            {rawCaptureState === 'armed' || rawCaptureState === 'capturing' ? d.disarm : d.captureNextRun}
          </Button>
        </div>
        {rawCaptureEvents.length > 0 && (
          <ol className="m-0 mt-4 grid list-none gap-2 p-0" data-testid="agent-diagnostics-raw-events">
            {rawCaptureEvents.map((message) => (
              <li key={`${message.captureId}:${message.sequence}`} className="border-l-2 border-border pl-3">
                <p className="m-0 text-xs font-medium">
                  {message.sequence}. {message.event.kind}
                </p>
                {'content' in message.event && (
                  <pre className="m-0 mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all border border-border p-2 text-xs">
                    {message.event.content.text}
                  </pre>
                )}
                {message.event.kind === 'evidence_dropped' && (
                  <p className="mb-0 mt-1 text-xs text-muted-foreground">
                    {d.droppedEvents(message.event.droppedEventCount, message.event.droppedBytes, message.event.reason)}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>}

      {activeTab === 'traces' ? (
        <div className="mx-auto mt-5 grid max-w-[1440px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)_360px]" role="tabpanel" aria-label={d.traces}>
        <section aria-labelledby="diagnostic-runs-heading" className="border border-border p-3">
          <h2 id="diagnostic-runs-heading" className="m-0 text-sm font-semibold">{d.operations}</h2>
          {artifact?.roots.length ? (
            <ul className="m-0 mt-3 list-none space-y-1 p-0" data-testid="agent-diagnostics-runs">
              {artifact.roots.map((root) => (
                <li key={root.rootOperationId}>
                  <button
                    type="button"
                    className="w-full border border-transparent px-2 py-2 text-left text-xs hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={`agent-diagnostics-run-${root.rootOperationId}`}
                    aria-pressed={root.rootOperationId === selectedRootId}
                    onClick={() => setSelectedRootId(root.rootOperationId)}
                  >
                    <span className="block font-medium">{root.operationKind}</span>
                    <span className="block break-all text-muted-foreground">{root.rootOperationId}</span>
                    <span className="block text-muted-foreground">{root.terminalState ?? 'active'}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-0 mt-3 text-sm text-muted-foreground" data-testid="agent-diagnostics-empty">
              {d.noOperations}
            </p>
          )}
        </section>

        <section aria-labelledby="diagnostic-timeline-heading" className="border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="diagnostic-timeline-heading" className="m-0 text-sm font-semibold">{d.timeline}</h2>
            <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="diagnostic-event-filter">
              {d.eventType}
              <select
                id="diagnostic-event-filter"
                className="h-7 max-w-48 border border-input bg-background px-2 text-foreground"
                data-testid="agent-diagnostics-event-filter"
                value={eventKindFilter}
                onChange={(event) => {
                  setEventKindFilter(event.target.value as DevTraceEventKind | 'all');
                  setSelectedEventId(null);
                }}
              >
                <option value="all">{d.allEvents}</option>
                {eventKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
          </div>
          {selectedRoot ? (
            <div
              ref={timelineScrollRef}
              className="mt-3 h-[min(60vh,720px)] min-h-72 overflow-auto"
              data-testid="agent-diagnostics-timeline"
            >
              <ol
                className="relative m-0 list-none p-0"
                style={{ height: timelineVirtualizer.getTotalSize() }}
              >
                {timelineVirtualizer.getVirtualItems().map((virtualItem) => {
                  const event = selectedEvents[virtualItem.index];
                  if (!event) return null;
                  return (
                    <li
                      key={event.eventId}
                      className="absolute left-0 top-0 h-[52px] w-full border-l-2 border-border pl-3 pr-2"
                      style={{ transform: `translateY(${virtualItem.start}px)` }}
                      data-testid={`agent-diagnostics-event-${event.eventId}`}
                      aria-posinset={virtualItem.index + 1}
                      aria-setsize={selectedEvents.length}
                    >
                      <button
                        type="button"
                        className="h-full w-full overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-pressed={event.eventId === selectedEventId}
                        onClick={() => setSelectedEventId(event.eventId)}
                      >
                        <span className="block text-xs font-medium">{event.sequence}. {event.kind}</span>
                        <span className="block truncate text-xs text-muted-foreground" title={event.spanId}>{event.spanId}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : (
            <p className="mb-0 mt-3 text-sm text-muted-foreground">{d.selectOperation}</p>
          )}
        </section>

        <aside aria-labelledby="diagnostic-details-heading" className="border border-border p-3">
          <h2 id="diagnostic-details-heading" className="m-0 text-sm font-semibold">{d.details}</h2>
          {selectedEvent ? (
            <div data-testid="agent-diagnostics-event-details">
              <p className="m-0 text-xs font-medium">{selectedEvent.kind}</p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">{d.sequence}</dt>
                <dd className="m-0">{selectedEvent.sequence}</dd>
                <dt className="text-muted-foreground">{d.span}</dt>
                <dd className="m-0 break-all">{selectedEvent.spanId}</dd>
              </dl>
              <pre className="m-0 mt-3 max-h-96 overflow-auto border border-border p-2 text-xs" data-testid="agent-diagnostics-event-data">
                {JSON.stringify(selectedEvent.data, null, 2)}
              </pre>
            </div>
          ) : selectedRoot ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs" data-testid="agent-diagnostics-details">
              <dt className="text-muted-foreground">{d.state}</dt>
              <dd className="m-0">{selectedRoot.terminalState ?? 'active'}</dd>
              <dt className="text-muted-foreground">{d.events}</dt>
              <dd className="m-0">{selectedRoot.eventCount}</dd>
              <dt className="text-muted-foreground">{d.firstSequence}</dt>
              <dd className="m-0">{selectedRoot.firstSequence}</dd>
              <dt className="text-muted-foreground">{d.lastSequence}</dt>
              <dd className="m-0">{selectedRoot.lastSequence}</dd>
            </dl>
          ) : (
            <p className="mb-0 mt-3 text-sm text-muted-foreground">{d.noOperationSelected}</p>
          )}
        </aside>
        </div>
      ) : activeTab === 'analysis' ? (
        <DiagnosticsAnalysisPanel
          artifact={artifact}
          selectedRootId={selectedRootId}
          onInspectEvidence={inspectEvidence}
        />
      ) : activeTab === 'provider' ? (
        extensionRuntimeAvailable ? <ProviderDebugPanel /> : <SharedProviderDiagnosticsPanel />
      ) : (
        <section className="mx-auto mt-5 grid max-w-[720px] gap-5" role="tabpanel" aria-label={d.scenarioLab} data-testid="agent-diagnostics-scenarios">
          <div className="border border-border p-4">
            <h2 className="m-0 text-sm font-semibold">{d.scenarioLab}</h2>
            <fieldset className="mt-4 grid gap-3 border-0 p-0">
              <label className="grid gap-1 text-sm" htmlFor="diagnostic-scenario-id">
                {d.scenario}
                <select
                  id="diagnostic-scenario-id"
                  className="h-8 border border-input bg-background px-2 text-foreground"
                  data-testid="agent-diagnostics-scenario-id"
                  value={scenarioId}
                  disabled={scenarioState === 'running'}
                  onChange={(event) => setScenarioId(event.target.value as DevTraceScenarioId)}
                >
                  {DEV_TRACE_SCENARIO_IDS.map((fixture) => <option key={fixture} value={fixture}>{fixture}</option>)}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm" htmlFor="diagnostic-scenario-delay">
                  {d.delay}
                  <input
                    id="diagnostic-scenario-delay"
                    type="number"
                    min={0}
                    max={30_000}
                    step={1}
                    className="h-8 border border-input bg-background px-2 text-foreground"
                    value={scenarioControls.delayMs}
                    disabled={scenarioState === 'running'}
                    onChange={(event) => setScenarioControls((current) => ({
                      ...current,
                      delayMs: Number(event.target.value),
                    }))}
                  />
                </label>
                <label className="grid gap-1 text-sm" htmlFor="diagnostic-scenario-window">
                  {d.contextWindow}
                  <input
                    id="diagnostic-scenario-window"
                    type="number"
                    min={4_096}
                    max={1_000_000}
                    step={1}
                    className="h-8 border border-input bg-background px-2 text-foreground"
                    value={scenarioControls.contextWindow}
                    disabled={scenarioState === 'running'}
                    onChange={(event) => setScenarioControls((current) => ({
                      ...current,
                      contextWindow: Number(event.target.value),
                    }))}
                  />
                </label>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="m-0 text-xs text-muted-foreground" data-testid="agent-diagnostics-scenario-status" role="status">
                  {scenarioState === 'idle' && (controlReady ? d.ready : d.connecting)}
                  {scenarioState === 'running' && d.running}
                  {scenarioState === 'completed' && d.completed}
                  {scenarioState === 'error' && scenarioError}
                </p>
                <Button onClick={runScenario} disabled={!controlReady || scenarioState === 'running'} data-testid="agent-diagnostics-run-scenario">
                  {d.runScenario}
                </Button>
              </div>
            </fieldset>
          </div>
        </section>
      )}
    </main>
  );
}

function selectInitialRoot(artifact: TraceArtifact): string | null {
  const newestFirst = [...artifact.roots].sort((left, right) => right.startedAt - left.startedAt);
  return newestFirst.find((root) => root.endedAt === null)?.rootOperationId
    ?? newestFirst.find((root) => root.terminalState === 'failed')?.rootOperationId
    ?? newestFirst[0]?.rootOperationId
    ?? null;
}

function exportScope(
  kind: DevTraceScope['kind'],
  root: TraceArtifact['roots'][number] | null,
): DevTraceScope | null {
  if (kind === 'all_retained') return { kind, id: null };
  if (kind === 'root') return root ? { kind, id: root.rootOperationId } : null;
  return root?.sessionId ? { kind, id: root.sessionId } : null;
}

function setArtifactSourceUrl(source: ArtifactSource): void {
  const url = new URL(window.location.href);
  if (source === 'imported') url.searchParams.set('source', 'imported');
  else url.searchParams.delete('source');
  window.history.replaceState(null, '', url);
}

function downloadArtifactBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'bgsm-agent-trace.json';
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

function createArtifactBlobSink(): ArtifactBlobSink {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });
  const blob = new Response(stream, {
    headers: { 'content-type': 'application/json' },
  }).blob();
  return {
    write(chunk) {
      if (settled) throw new TypeError('Artifact export stream is already closed.');
      controller.enqueue(chunk);
    },
    close() {
      if (!settled) {
        settled = true;
        controller.close();
      }
      return blob;
    },
    abort() {
      if (settled) return;
      settled = true;
      controller.error(new TypeError('Artifact export stream was cancelled.'));
      void blob.catch(() => undefined);
    },
  };
}

function hasExtensionDiagnosticsRuntime(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function';
}
