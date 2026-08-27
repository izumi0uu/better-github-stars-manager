import { useCallback, useEffect, useState } from 'react';
import { Activity, Plug, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { authStore } from '@/auth/auth-store';
import {
  hasAgentProviderHostPermission,
  requestAgentProviderHostPermission,
} from '@/agent-harness/provider-access';
import type { AgentProviderConnectionResult } from '@/agent-harness/provider-registry';
import { VERSION_HASH } from '@/dev';
import {
  DEV_TRACE_CONTROL_PORT,
  type DevTraceControlRequest,
  type DevTraceControlResponse,
  type DevTracePortResponse,
} from '@/agent-observability/dev-protocol';
import type { AgentProviderConfig } from '@/types';
import { BackgroundCallError, bgCall } from '@/utils/messaging';
import { useI18n } from '@/i18n';
import { Button } from '@/ui/shadcn/button';
import { getAgentDiagnosticsMessages } from './messages';
import {
  createProviderDebugSnapshot,
  createProviderDiagnosticsShare,
  createSavedProviderProbeRequest,
  readProviderConnectionFailureDetails,
  type ProviderDebugHostAccess,
  type ProviderDebugProbeState,
  type ProviderDebugSnapshot,
} from './provider-debug';
import {
  PROVIDER_DIAGNOSTICS_BRIDGE_PERMISSION,
  PROVIDER_DIAGNOSTICS_BRIDGE_URL,
  type ProviderDiagnosticsBridgeRecord,
} from './provider-diagnostics-bridge';
import { monitorStateFromBridgeRecord } from '@/agent-observability/provider-monitor';

type ShareState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'published'; expiresAt: number }
  | { kind: 'stopping' }
  | { kind: 'error'; message: string };

export function ProviderDebugPanel() {
  const { locale } = useI18n();
  const d = getAgentDiagnosticsMessages(locale);
  const [config, setConfig] = useState<AgentProviderConfig | null>(null);
  const [snapshot, setSnapshot] = useState<ProviderDebugSnapshot | null>(null);
  const [hostAccess, setHostAccess] = useState<ProviderDebugHostAccess>('checking');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [grantingAccess, setGrantingAccess] = useState(false);
  const [probeState, setProbeState] = useState<ProviderDebugProbeState>({ kind: 'idle' });
  const [shareState, setShareState] = useState<ShareState>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const nextConfig = (await authStore.getConfig()).agentProvider;
      const nextSnapshot = createProviderDebugSnapshot(nextConfig);
      setConfig(nextConfig);
      setSnapshot(nextSnapshot);
      setHostAccess(
        await hasAgentProviderHostPermission(nextConfig.provider, nextConfig.baseUrl)
          ? 'granted'
          : 'required',
      );
    } catch (error) {
      setConfig(null);
      setSnapshot(null);
      setHostAccess('checking');
      setLoadError(formatDebugError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void runProviderMonitorControl({
      version: 1,
      requestId: providerMonitorRequestId(),
      type: 'get_provider_monitor_status',
    }).then((response) => {
      const state = response.action === 'provider_monitor_status' ? response.state : null;
      if (state) setShareState({ kind: 'published', expiresAt: state.expiresAt });
    }).catch(() => undefined);
  }, []);

  const grantHostAccess = async () => {
    if (!config) return;
    setGrantingAccess(true);
    setLoadError(null);
    try {
      await requestAgentProviderHostPermission(config.provider, config.baseUrl);
      await refresh();
    } catch (error) {
      setLoadError(d.providerHostAccessFailed(formatDebugError(error)));
    } finally {
      setGrantingAccess(false);
    }
  };

  const testSavedProvider = async () => {
    if (!config) return;
    const startedAt = Date.now();
    setProbeState({ kind: 'running', startedAt });
    try {
      const result = await bgCall<AgentProviderConnectionResult>(
        'testAgentProviderConnection',
        createSavedProviderProbeRequest(config),
      );
      setProbeState({ kind: 'success', startedAt, completedAt: Date.now(), result });
      await refresh();
    } catch (error) {
      setProbeState({
        kind: 'error',
        startedAt,
        completedAt: Date.now(),
        message: formatDebugError(error),
        failure: error instanceof BackgroundCallError
          ? readProviderConnectionFailureDetails(error.details)
          : null,
      });
    }
  };

  const startProviderDiagnosticsMonitor = async () => {
    if (!snapshot) return;
    setShareState({ kind: 'publishing' });
    try {
      const hasPermission = await chrome.permissions.contains({
        origins: [PROVIDER_DIAGNOSTICS_BRIDGE_PERMISSION],
      });
      if (!hasPermission) {
        const granted = await chrome.permissions.request({
          origins: [PROVIDER_DIAGNOSTICS_BRIDGE_PERMISSION],
        });
        if (!granted) throw new Error('Loopback host access was not granted.');
      }
      const report = createProviderDiagnosticsShare({
        snapshot,
        hostAccess,
        probe: probeState,
        versionHash: VERSION_HASH,
      });
      const response = await fetch(PROVIDER_DIAGNOSTICS_BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      const body = await readBridgeResponse(response);
      const monitorState = response.ok ? monitorStateFromBridgeRecord(body) : null;
      if (!monitorState) {
        throw new Error(readBridgeError(body, response.status));
      }
      try {
        const response = await runProviderMonitorControl({
          version: 1,
          requestId: providerMonitorRequestId(),
          type: 'start_provider_monitor',
          state: monitorState,
        });
        if (response.action !== 'provider_monitor_started' || !response.state) {
          throw new Error('Provider monitor returned an unexpected start acknowledgement.');
        }
      } catch (error) {
        await fetch(PROVIDER_DIAGNOSTICS_BRIDGE_URL, { method: 'DELETE' }).catch(() => undefined);
        throw error;
      }
      setShareState({ kind: 'published', expiresAt: monitorState.expiresAt });
    } catch (error) {
      setShareState({ kind: 'error', message: formatDebugError(error) });
    }
  };

  const stopProviderDiagnosticsMonitor = async () => {
    setShareState({ kind: 'stopping' });
    try {
      const [backgroundResult, bridgeResult] = await Promise.allSettled([
        runProviderMonitorControl({
          version: 1,
          requestId: providerMonitorRequestId(),
          type: 'stop_provider_monitor',
        }),
        fetch(PROVIDER_DIAGNOSTICS_BRIDGE_URL, { method: 'DELETE' }),
      ]);
      if (backgroundResult.status === 'rejected') throw backgroundResult.reason;
      if (bridgeResult.status === 'rejected') throw bridgeResult.reason;
      const response = bridgeResult.value;
      if (!response.ok && response.status !== 404) {
        const body = await readBridgeResponse(response);
        throw new Error(readBridgeError(body, response.status));
      }
      setShareState({ kind: 'idle' });
    } catch (error) {
      setShareState({ kind: 'error', message: formatDebugError(error) });
    }
  };

  return (
    <section
      className="mx-auto mt-5 grid max-w-[960px] gap-4"
      role="tabpanel"
      aria-label={d.provider}
      data-testid="agent-diagnostics-provider"
    >
      <div className="border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-sm font-semibold">{d.providerDebug}</h2>
            <p className="mb-0 mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              {d.providerDebugNotice}
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            title={d.refreshProvider}
            aria-label={d.refreshProvider}
            onClick={() => void refresh()}
            disabled={loading || grantingAccess || probeState.kind === 'running'}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>

        {loading ? (
          <p className="mb-0 mt-4 text-sm text-muted-foreground" role="status">
            {d.loadingProvider}
          </p>
        ) : loadError ? (
          <p className="mb-0 mt-4 text-sm text-destructive" role="alert">
            {d.providerLoadFailed(loadError)}
          </p>
        ) : snapshot ? (
          <>
            <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted-foreground">{d.providerService}</dt>
              <dd className="m-0">{snapshot.providerLabel} <span className="text-muted-foreground">({snapshot.provider})</span></dd>
              <dt className="text-muted-foreground">{d.providerModel}</dt>
              <dd className="m-0 break-all font-mono">{snapshot.model}</dd>
              <dt className="text-muted-foreground">{d.providerProtocol}</dt>
              <dd className="m-0 font-mono">{snapshot.protocol}</dd>
              <dt className="text-muted-foreground">{d.providerEndpoint}</dt>
              <dd className="m-0 break-all font-mono">{snapshot.completionEndpoint}</dd>
              <dt className="text-muted-foreground">{d.providerCredential}</dt>
              <dd className="m-0">{snapshot.credentialState === 'saved' ? d.providerCredentialSaved : d.providerCredentialMissing}</dd>
              <dt className="text-muted-foreground">{d.providerHostAccess}</dt>
              <dd className="m-0">{hostAccessLabel(hostAccess, d)}</dd>
              <dt className="text-muted-foreground">{d.providerDeclaredContext}</dt>
              <dd className="m-0">{snapshot.declaredContextWindow ?? d.notConfigured}</dd>
              <dt className="text-muted-foreground">{d.providerWorkingContext}</dt>
              <dd className="m-0">{snapshot.workingContextWindow ?? d.notConfigured}</dd>
            </dl>

            {snapshot.capability ? (
              <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border pt-4 text-xs">
                <dt className="text-muted-foreground">{d.providerCapability}</dt>
                <dd className="m-0">{snapshot.capability.contextCapability?.contextWindow ?? d.notConfigured}</dd>
                <dt className="text-muted-foreground">{d.providerCapabilitySource}</dt>
                <dd className="m-0">{snapshot.capability.contextCapability?.source ?? d.notConfigured}</dd>
                <dt className="text-muted-foreground">{d.providerVerifiedAt}</dt>
                <dd className="m-0">{new Date(snapshot.capability.verifiedAt).toISOString()}</dd>
                <dt className="text-muted-foreground">{d.providerFingerprint}</dt>
                <dd className="m-0 break-all font-mono">{snapshot.capability.fingerprint}</dd>
              </dl>
            ) : (
              <p className="mb-0 mt-4 text-xs text-muted-foreground">{d.providerCapabilityMissing}</p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
              {hostAccess === 'required' && (
                <Button
                  variant="outline"
                  onClick={() => void grantHostAccess()}
                  disabled={grantingAccess || probeState.kind === 'running'}
                >
                  <ShieldCheck className="size-4" data-icon="inline-start" />
                  {grantingAccess ? d.grantingProviderHostAccess : d.grantProviderHostAccess}
                </Button>
              )}
              <Button
                onClick={() => void testSavedProvider()}
                disabled={
                  snapshot.credentialState !== 'saved'
                  || hostAccess === 'required'
                  || hostAccess === 'checking'
                  || grantingAccess
                  || probeState.kind === 'running'
                }
                data-testid="agent-diagnostics-test-provider"
              >
                <Plug className="size-4" data-icon="inline-start" />
                {probeState.kind === 'running' ? d.testingProvider : d.testSavedProvider}
              </Button>
            </div>
          </>
        ) : null}

        {probeState.kind === 'success' && (
          <div className="mt-4 border border-border p-3 text-xs" role="status" data-testid="agent-diagnostics-provider-success">
            <p className="m-0 font-medium">
              {d.providerTestSucceeded(probeState.result.providerLabel, probeState.result.model, probeState.result.latencyMs)}
            </p>
            <p className="mb-0 mt-2 break-all font-mono text-muted-foreground">
              {probeState.result.completionEndpoint}
            </p>
            {probeState.result.preview && (
              <pre className="m-0 mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border border-border p-2">
                {probeState.result.preview}
              </pre>
            )}
          </div>
        )}
        {probeState.kind === 'error' && (
          <div className="mt-4 border border-destructive p-3 text-xs" role="alert" data-testid="agent-diagnostics-provider-error">
            <p className="m-0 text-sm text-destructive">{d.providerTestFailed(probeState.message)}</p>
            {probeState.failure && (
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{d.providerFailurePhase}</dt>
                <dd className="m-0 font-mono">{probeState.failure.phase}</dd>
                <dt className="text-muted-foreground">{d.providerFailureCode}</dt>
                <dd className="m-0 break-all font-mono">{probeState.failure.code}</dd>
                <dt className="text-muted-foreground">{d.providerFailureStatus}</dt>
                <dd className="m-0 font-mono">{probeState.failure.status ?? 'n/a'}</dd>
              </dl>
            )}
          </div>
        )}

        {snapshot && (
          <section className="mt-4 border-t border-border pt-4" aria-labelledby="provider-local-agent-bridge-heading">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-3xl">
                <h3 id="provider-local-agent-bridge-heading" className="m-0 text-sm font-semibold">{d.localAgentBridge}</h3>
                <p className="mb-0 mt-1 text-xs leading-5 text-muted-foreground">{d.localAgentBridgeNotice}</p>
                <p className="mb-0 mt-2 break-all font-mono text-xs" data-testid="agent-diagnostics-provider-bridge-url">
                  {PROVIDER_DIAGNOSTICS_BRIDGE_URL}
                </p>
              </div>
              {shareState.kind === 'published' || shareState.kind === 'stopping' ? (
                <Button
                  variant="outline"
                  onClick={() => void stopProviderDiagnosticsMonitor()}
                  disabled={shareState.kind === 'stopping'}
                  data-testid="agent-diagnostics-stop-provider-share"
                >
                  <Square className="size-4" data-icon="inline-start" />
                  {shareState.kind === 'stopping'
                    ? d.stoppingProviderDiagnostics
                    : d.stopSharingProviderDiagnostics}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => void startProviderDiagnosticsMonitor()}
                  disabled={shareState.kind === 'publishing'}
                  data-testid="agent-diagnostics-share-provider"
                >
                  <Activity className="size-4" data-icon="inline-start" />
                  {shareState.kind === 'publishing'
                    ? d.sharingProviderDiagnostics
                    : d.shareProviderDiagnostics}
                </Button>
              )}
            </div>
            {shareState.kind === 'published' && (
              <p className="mb-0 mt-3 text-xs" role="status" data-testid="agent-diagnostics-provider-shared">
                {d.providerDiagnosticsSharedUntil(new Date(shareState.expiresAt).toLocaleString(locale))}
              </p>
            )}
            {shareState.kind === 'error' && (
              <p className="mb-0 mt-3 text-xs text-destructive" role="alert" data-testid="agent-diagnostics-provider-share-error">
                {d.providerDiagnosticsShareFailed(shareState.message)}
              </p>
            )}
          </section>
        )}
      </div>
    </section>
  );
}

function hostAccessLabel(
  state: ProviderDebugHostAccess,
  d: ReturnType<typeof getAgentDiagnosticsMessages>,
): string {
  if (state === 'built-in') return d.providerHostAccessBuiltIn;
  if (state === 'granted') return d.providerHostAccessGranted;
  if (state === 'required') return d.providerHostAccessRequired;
  return d.checkingProviderHostAccess;
}

async function readBridgeResponse(response: Response): Promise<Partial<ProviderDiagnosticsBridgeRecord> & { error?: string } | null> {
  try {
    return await response.json() as Partial<ProviderDiagnosticsBridgeRecord> & { error?: string };
  } catch {
    return null;
  }
}

function readBridgeError(
  body: (Partial<ProviderDiagnosticsBridgeRecord> & { error?: string }) | null,
  status: number,
): string {
  return body?.error ?? `Loopback diagnostics server returned HTTP ${status}.`;
}

function formatDebugError(error: unknown): string {
  if (error instanceof BackgroundCallError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function providerMonitorRequestId(): string {
  return `provider-monitor-control:${crypto.randomUUID()}`;
}

function runProviderMonitorControl(
  request: Extract<DevTraceControlRequest, {
    type: 'start_provider_monitor' | 'stop_provider_monitor' | 'get_provider_monitor_status';
  }>,
): Promise<Extract<DevTraceControlResponse, {
  action: 'provider_monitor_started' | 'provider_monitor_stopped' | 'provider_monitor_status';
}>> {
  const port = chrome.runtime.connect({ name: DEV_TRACE_CONTROL_PORT });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: number;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      complete();
      try {
        port.disconnect();
      } catch {
        // The Service Worker may already have closed the development Port.
      }
    };
    timeout = window.setTimeout(() => {
      finish(() => reject(new Error('Provider monitor control request timed out.')));
    }, 10_000);
    port.onMessage.addListener((message: DevTracePortResponse) => {
      if (message.type === 'ready') {
        if (message.port === 'control') port.postMessage(request);
        return;
      }
      if (!('requestId' in message) || message.requestId !== request.requestId) return;
      if (message.type === 'control_error') {
        finish(() => reject(new Error(`Provider monitor control failed: ${message.code}.`)));
        return;
      }
      if (
        message.type === 'control_result'
        && (
          message.action === 'provider_monitor_started'
          || message.action === 'provider_monitor_stopped'
          || message.action === 'provider_monitor_status'
        )
      ) finish(() => resolve(message));
    });
    port.onDisconnect.addListener(() => {
      finish(() => reject(new Error('Provider monitor control connection closed.')));
    });
  });
}
