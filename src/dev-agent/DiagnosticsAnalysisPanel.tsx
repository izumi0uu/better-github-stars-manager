import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Download, Search } from 'lucide-react';
import type { TraceArtifact } from '@/agent-observability';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/shadcn/button';
import {
  createAgentDiagnosticReport,
  type AgentDiagnosticFinding,
  type AgentDiagnosticProviderRequest,
} from './diagnostic-report';
import {
  getAgentDiagnosticsFindingText,
  getAgentDiagnosticsMessages,
} from './messages';

type AnalysisScope = 'all' | 'selected';

type DiagnosticsAnalysisPanelProps = Readonly<{
  artifact: TraceArtifact | null;
  selectedRootId: string | null;
  onInspectEvidence(rootOperationId: string, eventId: string | null): void;
}>;

const UI_LIST_LIMIT = 50;

export function DiagnosticsAnalysisPanel({
  artifact,
  selectedRootId,
  onInspectEvidence,
}: DiagnosticsAnalysisPanelProps) {
  const { locale } = useI18n();
  const d = getAgentDiagnosticsMessages(locale);
  const [scope, setScope] = useState<AnalysisScope>('all');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const effectiveRootId = scope === 'selected' ? selectedRootId : null;
  const report = useMemo(
    () => artifact ? createAgentDiagnosticReport(artifact, effectiveRootId) : null,
    [artifact, effectiveRootId],
  );
  const serializedReport = useMemo(
    () => report ? JSON.stringify(report, null, 2) : '',
    [report],
  );

  useEffect(() => {
    if (!selectedRootId && scope === 'selected') setScope('all');
  }, [scope, selectedRootId]);

  const copyReport = async () => {
    if (!serializedReport || !navigator.clipboard?.writeText) {
      setCopyState('error');
      return;
    }
    try {
      await navigator.clipboard.writeText(serializedReport);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  const downloadReport = () => {
    if (!serializedReport) return;
    const url = URL.createObjectURL(new Blob([serializedReport], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'bgsm-agent-diagnostic-report.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className="mx-auto mt-5 grid max-w-[1440px] gap-4"
      role="tabpanel"
      aria-label={d.analysis}
      data-testid="agent-diagnostics-analysis"
    >
      <div className="border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-4xl">
            <h2 className="m-0 text-sm font-semibold">{d.deterministicAnalysis}</h2>
            <p className="mb-0 mt-1 text-xs leading-5 text-muted-foreground">{d.analysisNotice}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="diagnostic-analysis-scope">
              {d.analysisScope}
              <select
                id="diagnostic-analysis-scope"
                className="h-8 border border-input bg-background px-2 text-foreground"
                value={scope}
                onChange={(event) => setScope(event.target.value as AnalysisScope)}
                data-testid="agent-diagnostics-analysis-scope"
              >
                <option value="all">{d.allOperations}</option>
                <option value="selected" disabled={!selectedRootId}>{d.currentOperation}</option>
              </select>
            </label>
            <Button
              variant="outline"
              size="icon"
              title={d.copyAgentReport}
              aria-label={d.copyAgentReport}
              onClick={() => void copyReport()}
              disabled={!report}
              data-testid="agent-diagnostics-copy-report"
            >
              <Copy className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              title={d.downloadAgentReport}
              aria-label={d.downloadAgentReport}
              onClick={downloadReport}
              disabled={!report}
              data-testid="agent-diagnostics-download-report"
            >
              <Download className="size-4" />
            </Button>
          </div>
        </div>
        {copyState !== 'idle' && (
          <p
            className={cn('mb-0 mt-2 text-xs', {
              'text-foreground': copyState === 'copied',
              'text-destructive': copyState === 'error',
            })}
            role="status"
          >
            {copyState === 'copied' ? d.agentReportCopied : d.agentReportCopyFailed}
          </p>
        )}
      </div>

      {report ? (
        <>
          <section className="border-y border-border" aria-label={d.health} data-report-status={report.summary.status}>
            <dl className="m-0 grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-3 lg:grid-cols-6">
              <SummaryMetric label={d.health} value={statusLabel(report.summary.status, d)} />
              <SummaryMetric label={d.errors} value={report.summary.findingCounts.error} />
              <SummaryMetric label={d.warnings} value={report.summary.findingCounts.warning} />
              <SummaryMetric label={d.providerRequests} value={report.summary.providerRequestCount} />
              <SummaryMetric label={d.contextReductions} value={report.summary.contextReductionCount} />
              <SummaryMetric label={d.toolCalls} value={report.summary.toolCallCount} />
            </dl>
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
            <section className="border border-border p-4" aria-labelledby="diagnostic-findings-heading">
              <h2 id="diagnostic-findings-heading" className="m-0 text-sm font-semibold">{d.findings}</h2>
              {report.findings.length > 0 ? (
                <ol className="m-0 mt-3 grid list-none gap-2 p-0" data-testid="agent-diagnostics-findings">
                  {report.findings.map((finding, index) => (
                    <FindingRow
                      key={`${finding.code}:${finding.eventId ?? finding.rootOperationId ?? index}`}
                      finding={finding}
                      text={getAgentDiagnosticsFindingText(locale, finding)}
                      inspectLabel={d.inspectEvidence}
                      onInspectEvidence={onInspectEvidence}
                    />
                  ))}
                </ol>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" data-testid="agent-diagnostics-no-findings">
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                  <p className="m-0">{d.noFindings}</p>
                </div>
              )}
              {report.omitted.findings > 0 && (
                <p className="mb-0 mt-3 text-xs text-muted-foreground">{d.reportOmitted(report.omitted.findings)}</p>
              )}
            </section>

            <section className="border border-border p-4" aria-labelledby="diagnostic-context-heading">
              <h2 id="diagnostic-context-heading" className="m-0 text-sm font-semibold">{d.contextActivity}</h2>
              {report.contextActivity.length > 0 ? (
                <ol className="m-0 mt-3 grid max-h-[420px] list-none gap-2 overflow-auto p-0" data-testid="agent-diagnostics-context-activity">
                  {report.contextActivity.slice(0, UI_LIST_LIMIT).map((event) => (
                    <li key={event.eventId} className="border-l-2 border-border pl-3 text-xs">
                      <button
                        type="button"
                        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onInspectEvidence(event.rootOperationId, event.eventId)}
                      >
                        <span className="block font-medium">{event.sequence}. {event.kind}</span>
                        <span className="block break-all text-muted-foreground">{contextEventSummary(event.data)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mb-0 mt-3 text-sm text-muted-foreground">{d.noContextActivity}</p>
              )}
              {report.contextActivity.length > UI_LIST_LIMIT || report.omitted.contextEvents > 0 ? (
                <p className="mb-0 mt-3 text-xs text-muted-foreground">
                  {d.reportOmitted(Math.max(0, report.contextActivity.length - UI_LIST_LIMIT) + report.omitted.contextEvents)}
                </p>
              ) : null}
            </section>
          </div>

          <section className="border border-border p-4" aria-labelledby="diagnostic-provider-requests-heading">
            <h2 id="diagnostic-provider-requests-heading" className="m-0 text-sm font-semibold">{d.providerRequests}</h2>
            {report.providerRequests.length > 0 ? (
              <ol className="m-0 mt-3 grid list-none gap-2 p-0" data-testid="agent-diagnostics-provider-requests">
                {report.providerRequests.slice(0, UI_LIST_LIMIT).map((request) => (
                  <ProviderRequestRow
                    key={request.key}
                    request={request}
                    locale={locale}
                    d={d}
                    onInspectEvidence={onInspectEvidence}
                  />
                ))}
              </ol>
            ) : (
              <p className="mb-0 mt-3 text-sm text-muted-foreground">{d.noProviderRequests}</p>
            )}
            {report.providerRequests.length > UI_LIST_LIMIT || report.omitted.providerRequests > 0 ? (
              <p className="mb-0 mt-3 text-xs text-muted-foreground">
                {d.reportOmitted(Math.max(0, report.providerRequests.length - UI_LIST_LIMIT) + report.omitted.providerRequests)}
              </p>
            ) : null}
          </section>

          <section className="border border-border p-4" aria-labelledby="diagnostic-tools-heading">
            <h2 id="diagnostic-tools-heading" className="m-0 text-sm font-semibold">{d.toolLifecycle}</h2>
            {report.toolCalls.length > 0 ? (
              <ol className="m-0 mt-3 grid list-none gap-2 p-0 sm:grid-cols-2" data-testid="agent-diagnostics-tool-calls">
                {report.toolCalls.slice(0, UI_LIST_LIMIT).map((tool) => (
                  <li
                    key={tool.key}
                    className="border border-border p-3 text-xs"
                    data-tool-call-id={tool.toolCallId}
                    data-tool-name={tool.toolName}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="m-0 truncate font-medium" title={tool.toolName}>{tool.toolName}</p>
                        <p className="mb-0 mt-1 break-all font-mono text-muted-foreground">{tool.toolCallId}</p>
                      </div>
                      <Button
                        variant="outline"
                        size="icon"
                        title={d.inspectEvidence}
                        aria-label={d.inspectEvidence}
                        onClick={() => onInspectEvidence(tool.rootOperationId, tool.evidenceEventIds.at(-1) ?? null)}
                      >
                        <Search className="size-3.5" />
                      </Button>
                    </div>
                    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground">{d.providerStep}</dt>
                      <dd className="m-0">{tool.providerStep}</dd>
                      <dt className="text-muted-foreground">{d.toolClass}</dt>
                      <dd className="m-0">{tool.toolClass ?? 'n/a'}</dd>
                      <dt className="text-muted-foreground">{d.risk}</dt>
                      <dd className="m-0">{tool.risk ?? 'n/a'}</dd>
                      <dt className="text-muted-foreground">{d.authorization}</dt>
                      <dd className="m-0">{tool.authorization ?? 'n/a'}</dd>
                      <dt className="text-muted-foreground">{d.resultReduction}</dt>
                      <dd className="m-0">{tool.result.reduction ?? 'n/a'}</dd>
                      <dt className="text-muted-foreground">{d.admittedResult}</dt>
                      <dd className="m-0">{formatPair(tool.result.admittedBytes, tool.result.originalBytes, locale)}</dd>
                      <dt className="text-muted-foreground">{d.toolOutcome}</dt>
                      <dd className="m-0">{tool.result.outcome ?? 'n/a'}</dd>
                      <dt className="text-muted-foreground">{d.writeOutcome}</dt>
                      <dd className="m-0">{tool.write.state ?? 'n/a'}{tool.write.effectCount === null ? '' : ` (${tool.write.effectCount})`}</dd>
                    </dl>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mb-0 mt-3 text-sm text-muted-foreground">{d.noToolCalls}</p>
            )}
            {report.toolCalls.length > UI_LIST_LIMIT || report.omitted.toolCalls > 0 ? (
              <p className="mb-0 mt-3 text-xs text-muted-foreground">
                {d.reportOmitted(Math.max(0, report.toolCalls.length - UI_LIST_LIMIT) + report.omitted.toolCalls)}
              </p>
            ) : null}
          </section>

          <details className="border border-border p-4" open>
            <summary className="cursor-pointer text-sm font-semibold">{d.agentReadableReport}</summary>
            <p className="mb-0 mt-2 max-w-5xl text-xs leading-5 text-muted-foreground">{d.agentReadableReportNotice}</p>
            <pre
              className="m-0 mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap break-all border border-border p-3 text-xs"
              aria-label={d.agentReadableReport}
              data-testid="agent-diagnostics-machine-report"
              data-agent-readable="bgsm-diagnostics"
              data-report-status={report.summary.status}
              tabIndex={0}
            >
              {serializedReport}
            </pre>
          </details>
        </>
      ) : (
        <p className="m-0 border border-border p-4 text-sm text-muted-foreground">{d.noOperations}</p>
      )}
    </section>
  );
}

function SummaryMetric({ label, value }: Readonly<{ label: string; value: string | number }>) {
  return (
    <div className="min-w-0 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 mt-1 truncate text-sm font-semibold" title={String(value)}>{value}</dd>
    </div>
  );
}

function FindingRow({
  finding,
  text,
  inspectLabel,
  onInspectEvidence,
}: Readonly<{
  finding: AgentDiagnosticFinding;
  text: string;
  inspectLabel: string;
  onInspectEvidence(rootOperationId: string, eventId: string | null): void;
}>) {
  const canInspect = finding.rootOperationId !== null;
  return (
    <li
      className={cn('border-l-2 p-3 text-xs', {
        'border-destructive bg-destructive/5': finding.severity === 'error',
        'border-foreground/40 bg-muted/30': finding.severity === 'warning',
        'border-border': finding.severity === 'info',
      })}
      data-diagnostic-code={finding.code}
      data-diagnostic-severity={finding.severity}
      data-root-operation-id={finding.rootOperationId ?? undefined}
      data-request-id={finding.requestId ?? undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
            <p className="m-0 break-all font-mono font-medium">{finding.code}</p>
          </div>
          <p className="mb-0 mt-1 leading-5">{text}</p>
          {finding.rootOperationId && (
            <p className="mb-0 mt-1 break-all font-mono text-muted-foreground">{finding.rootOperationId}</p>
          )}
        </div>
        {canInspect && (
          <Button
            variant="outline"
            size="icon"
            title={inspectLabel}
            aria-label={inspectLabel}
            onClick={() => onInspectEvidence(finding.rootOperationId!, finding.eventId)}
          >
            <Search className="size-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}

function ProviderRequestRow({
  request,
  locale,
  d,
  onInspectEvidence,
}: Readonly<{
  request: AgentDiagnosticProviderRequest;
  locale: string;
  d: ReturnType<typeof getAgentDiagnosticsMessages>;
  onInspectEvidence(rootOperationId: string, eventId: string | null): void;
}>) {
  return (
    <li
      className="border border-border"
      data-provider-request-id={request.requestId}
      data-provider-request-attempt={request.requestAttempt}
      data-provider-request-state={request.state}
    >
      <details>
        <summary className="cursor-pointer p-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center sm:gap-3">
            <span className="min-w-0">
              <span className="block truncate font-mono font-medium" title={request.requestId}>{request.requestId}</span>
              <span className="block break-all text-muted-foreground">{request.requestKind} · {request.protocol ?? 'n/a'}</span>
            </span>
            <span>{request.state}</span>
            <span>{formatMs(request.timing.firstResponseMs, locale)}</span>
            <span>{formatUsage(request, locale)}</span>
          </span>
        </summary>
        <div className="border-t border-border p-3">
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onInspectEvidence(request.rootOperationId, request.evidenceEventIds.at(-1) ?? null)}
            >
              <Search className="size-3.5" data-icon="inline-start" />
              {d.inspectEvidence}
            </Button>
          </div>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
            <RequestMetric label={d.requestKind} value={request.requestKind} />
            <RequestMetric label={d.rootOperation} value={request.rootOperationId} />
            <RequestMetric label={d.providerClass} value={request.providerClass} />
            <RequestMetric label={d.capabilityRevision} value={request.modelCapabilityRevision} />
            <RequestMetric label={d.requestAttempt} value={request.requestAttempt} />
            <RequestMetric label={d.providerStep} value={request.providerStep} />
            <RequestMetric label={d.providerState} value={request.state} />
            <RequestMetric label={d.requestSize} value={formatNumber(request.request.requestBytes, locale)} />
            <RequestMetric label={d.historySize} value={formatNumber(request.request.historyBytes, locale)} />
            <RequestMetric label={d.estimatedInput} value={formatNumber(request.request.estimatedInputTokens, locale)} />
            <RequestMetric label={d.outputReserve} value={formatNumber(request.request.maxOutputTokens, locale)} />
            <RequestMetric label={d.workingWindow} value={formatNumber(request.context.workingWindowTokens, locale)} />
            <RequestMetric label={d.preflightDecision} value={request.context.decision} />
            <RequestMetric label={d.preflightReason} value={request.context.reasonCode} />
            <RequestMetric label={d.firstResponse} value={formatMs(request.timing.firstResponseMs, locale)} />
            <RequestMetric label={d.totalDuration} value={formatMs(request.timing.totalDurationMs, locale)} />
            <RequestMetric label={d.streamItems} value={formatNumber(request.stream.itemCount, locale)} />
            <RequestMetric label={d.streamBytes} value={formatNumber(request.stream.utf8Bytes, locale)} />
            <RequestMetric label={d.usage} value={formatUsage(request, locale)} />
            <RequestMetric label={d.finishReason} value={request.outcome.finishReason} />
            <RequestMetric label={d.providerError} value={request.outcome.errorCode} />
            <RequestMetric label={d.httpStatus} value={request.outcome.httpStatus} />
            <RequestMetric label={d.retryable} value={formatBoolean(request.outcome.retryable, d)} />
            <RequestMetric label={d.overflow} value={formatBoolean(request.outcome.overflow, d)} />
          </dl>
          {Object.keys(request.stream.classes).length > 0 && (
            <pre className="m-0 mt-3 overflow-auto border border-border p-2 text-xs">
              {JSON.stringify(request.stream.classes, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </li>
  );
}

function RequestMetric({ label, value }: Readonly<{ label: string; value: unknown }>) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 break-all">{value === null || value === undefined ? 'n/a' : String(value)}</dd>
    </>
  );
}

function statusLabel(
  status: 'healthy' | 'running' | 'degraded' | 'failed',
  d: ReturnType<typeof getAgentDiagnosticsMessages>,
): string {
  if (status === 'healthy') return d.healthy;
  if (status === 'running') return d.active;
  if (status === 'degraded') return d.degraded;
  return d.failed;
}

function formatNumber(value: number | null, locale: string): string {
  return value === null ? 'n/a' : new Intl.NumberFormat(locale).format(value);
}

function formatPair(left: number | null, right: number | null, locale: string): string {
  return `${formatNumber(left, locale)} / ${formatNumber(right, locale)}`;
}

function formatMs(value: number | null, locale: string): string {
  return value === null ? 'n/a' : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ms`;
}

function formatUsage(request: AgentDiagnosticProviderRequest, locale: string): string {
  return `${formatNumber(request.usage.inputTokens, locale)} / ${formatNumber(request.usage.outputTokens, locale)} / ${formatNumber(request.usage.totalTokens, locale)}`;
}

function formatBoolean(
  value: boolean | null,
  d: ReturnType<typeof getAgentDiagnosticsMessages>,
): string {
  if (value === null) return 'n/a';
  return value ? d.yes : d.no;
}

function contextEventSummary(data: Readonly<Record<string, unknown>>): string {
  const parts = ['decision', 'outcome', 'trigger', 'reasonCode', 'watchdog', 'state', 'episode']
    .flatMap((key) => data[key] === null || data[key] === undefined ? [] : [`${key}=${String(data[key])}`]);
  return parts.join(' · ') || JSON.stringify(data);
}
