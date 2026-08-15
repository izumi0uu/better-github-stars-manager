import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/ui/shadcn/button';
import {
  parseProviderDiagnosticsBridgeRecord,
  parseProviderDiagnosticsEventsRecord,
  parseProviderDiagnosticsHealth,
  PROVIDER_DIAGNOSTICS_BRIDGE_PATH,
  PROVIDER_DIAGNOSTICS_EVENTS_PATH,
  PROVIDER_DIAGNOSTICS_HEALTH_PATH,
  type ProviderDiagnosticsBridgeRecord,
  type ProviderDiagnosticsEventsRecord,
  type ProviderDiagnosticsHealth,
} from './provider-diagnostics-bridge';
import { getAgentDiagnosticsMessages } from './messages';

type SharedProviderState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | {
      kind: 'ready';
      record: ProviderDiagnosticsBridgeRecord;
      events: ProviderDiagnosticsEventsRecord;
      health: ProviderDiagnosticsHealth;
    }
  | { kind: 'error'; message: string };

export function SharedProviderDiagnosticsPanel() {
  const { locale } = useI18n();
  const d = getAgentDiagnosticsMessages(locale);
  const [state, setState] = useState<SharedProviderState>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const [healthResponse, latestResponse, eventsResponse] = await Promise.all([
        fetch(PROVIDER_DIAGNOSTICS_HEALTH_PATH, { cache: 'no-store' }),
        fetch(PROVIDER_DIAGNOSTICS_BRIDGE_PATH, { cache: 'no-store' }),
        fetch(PROVIDER_DIAGNOSTICS_EVENTS_PATH, { cache: 'no-store' }),
      ]);
      const healthValue = await healthResponse.json() as unknown;
      const health = parseProviderDiagnosticsHealth(healthValue);
      if (!healthResponse.ok || !health) {
        setState({ kind: 'error', message: `HTTP ${healthResponse.status}` });
        return;
      }
      if (health.state === 'idle' || latestResponse.status === 404) {
        setState({ kind: 'empty' });
        return;
      }
      const [latestValue, eventsValue] = await Promise.all([
        latestResponse.json() as Promise<unknown>,
        eventsResponse.json() as Promise<unknown>,
      ]);
      const record = parseProviderDiagnosticsBridgeRecord(latestValue);
      const events = parseProviderDiagnosticsEventsRecord(eventsValue);
      if (!latestResponse.ok || !eventsResponse.ok || !record || !events) {
        setState({ kind: 'error', message: `HTTP ${!latestResponse.ok ? latestResponse.status : eventsResponse.status}` });
        return;
      }
      setState({ kind: 'ready', record, events, health });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const serialized = useMemo(
    () => state.kind === 'ready' ? JSON.stringify({
      latest: state.record,
      events: state.events,
      health: state.health,
    }, null, 2) : '',
    [state],
  );

  return (
    <section
      className="mx-auto mt-5 grid max-w-[960px] gap-4"
      role="tabpanel"
      aria-label={d.provider}
      data-testid="agent-diagnostics-shared-provider"
    >
      <div className="border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-sm font-semibold">{d.sharedProviderDiagnostics}</h2>
            <p className="mb-0 mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              {d.localAgentBridgeNotice}
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            title={d.refreshSharedProviderDiagnostics}
            aria-label={d.refreshSharedProviderDiagnostics}
            onClick={() => void refresh()}
            disabled={state.kind === 'loading'}
            data-testid="agent-diagnostics-refresh-shared-provider"
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>

        {state.kind === 'loading' && (
          <p className="mb-0 mt-4 text-sm text-muted-foreground" role="status">
            {d.loadingSharedProviderDiagnostics}
          </p>
        )}
        {state.kind === 'empty' && (
          <p className="mb-0 mt-4 text-sm text-muted-foreground" role="status">
            {d.noSharedProviderDiagnostics}
          </p>
        )}
        {state.kind === 'error' && (
          <p className="mb-0 mt-4 text-sm text-destructive" role="alert">
            {d.sharedProviderDiagnosticsFailed(state.message)}
          </p>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted-foreground">{d.providerService}</dt>
              <dd className="m-0">{state.record.report.provider.label}</dd>
              <dt className="text-muted-foreground">{d.providerModel}</dt>
              <dd className="m-0 break-all font-mono">{state.record.report.provider.model}</dd>
              <dt className="text-muted-foreground">{d.providerEndpoint}</dt>
              <dd className="m-0 break-all font-mono">{state.record.report.provider.completionEndpoint}</dd>
              <dt className="text-muted-foreground">{d.providerFailurePhase}</dt>
              <dd className="m-0 font-mono">{state.record.report.probe.failure?.phase ?? 'n/a'}</dd>
              <dt className="text-muted-foreground">{d.providerFailureCode}</dt>
              <dd className="m-0 break-all font-mono">{state.record.report.probe.failure?.code ?? 'n/a'}</dd>
              <dt className="text-muted-foreground">{d.providerFailureStatus}</dt>
              <dd className="m-0 font-mono">{state.record.report.probe.failure?.status ?? 'n/a'}</dd>
              <dt className="text-muted-foreground">{d.providerMonitorEvents}</dt>
              <dd className="m-0 font-mono">{state.events.eventCount}</dd>
              <dt className="text-muted-foreground">{d.providerMonitorLatestEvent}</dt>
              <dd className="m-0 break-all font-mono">{state.record.latestEvent.event.kind}</dd>
            </dl>
            <p className="mb-0 mt-3 text-xs text-muted-foreground">
              {d.providerDiagnosticsSharedUntil(new Date(state.record.expiresAt).toLocaleString(locale))}
            </p>
            <section className="mt-4 border-t border-border pt-4" aria-labelledby="provider-monitor-events-heading">
              <h3 id="provider-monitor-events-heading" className="m-0 text-sm font-semibold">{d.providerMonitorRecentEvents}</h3>
              {state.events.events.length === 0 ? (
                <p className="mb-0 mt-2 text-xs text-muted-foreground">{d.providerMonitorNoEvents}</p>
              ) : (
                <ol className="m-0 mt-3 grid max-h-56 list-none gap-2 overflow-auto p-0 text-xs" data-testid="agent-diagnostics-provider-monitor-events">
                  {state.events.events.slice(-20).reverse().map((stored) => (
                    <li key={stored.sequence} className="border border-border p-2">
                      <p className="m-0 break-all font-mono">#{stored.sequence} {stored.event.kind}</p>
                      <p className="mb-0 mt-1 break-all text-muted-foreground">
                        {new Date(stored.receivedAt).toLocaleTimeString(locale)}
                        {stored.event.requestId ? ` · ${stored.event.requestId}` : ''}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <pre
              className="m-0 mt-4 max-h-[560px] overflow-auto whitespace-pre-wrap break-all border border-border p-3 text-xs"
              data-testid="agent-diagnostics-shared-provider-report"
              data-agent-readable="bgsm-provider-monitor-v2"
              tabIndex={0}
            >
              {serialized}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}
