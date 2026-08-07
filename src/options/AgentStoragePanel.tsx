import { useRef } from "react";
import { AlertTriangle, Database, RefreshCw, Trash2 } from "lucide-react";
import { useI18n } from "@/i18n";
import type { AgentStorageUsageSnapshot } from "@/storage/agent-storage-store";
import { Button } from "@/ui/shadcn/button";
import { Progress } from "@/ui/shadcn/progress";
import { Spinner } from "@/ui/shadcn/spinner";
import { cn } from "@/lib/utils";

export interface AgentStoragePanelProps {
  usage: AgentStorageUsageSnapshot | null;
  loading: boolean;
  clearBusy: boolean;
  error: string | null;
  notice: string | null;
  onRefresh: () => void | Promise<void>;
  onClearToolCache: () => void | Promise<void>;
}

export function AgentStoragePanel({
  usage,
  loading,
  clearBusy,
  error,
  notice,
  onRefresh,
  onClearToolCache,
}: AgentStoragePanelProps) {
  const { locale, m } = useI18n();
  const clearRequestedRef = useRef(false);

  const clearToolCache = async () => {
    if (clearRequestedRef.current || clearBusy || !usage?.cacheBytes) return;
    clearRequestedRef.current = true;
    try {
      await onClearToolCache();
    } finally {
      clearRequestedRef.current = false;
    }
  };

  const hardLimitPercent = usage?.hardLimitBytes
    ? Math.min(100, Math.max(0, (usage.totalBytes / usage.hardLimitBytes) * 100))
    : 0;

  return (
    <section
      className="mt-4"
      aria-labelledby="agent-storage-heading"
      data-testid="agent-storage-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="agent-storage-heading" className="inline-flex items-center gap-1.5 text-sm font-medium">
            <Database className="size-4" aria-hidden="true" />
            {m.options.agentStorageHeading}
          </h3>
          <p className="gsm-body-note mt-1">{m.options.agentStorageIntro}</p>
          <p className="gsm-body-note mt-1">{m.options.agentStorageOrganizeRetention}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          title={m.options.agentStorageRefresh}
          aria-label={m.options.agentStorageRefresh}
          disabled={loading || clearBusy}
          onClick={() => void onRefresh()}
        >
          {loading ? (
            <Spinner data-icon />
          ) : (
            <RefreshCw data-icon aria-hidden="true" />
          )}
        </Button>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-muted/20 p-4">
        {loading && !usage ? (
          <div className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner className="size-4" />
            {m.options.agentStorageLoading}
          </div>
        ) : usage ? (
          <>
            <dl className="grid gap-4 sm:grid-cols-3">
              <StorageMetric
                label={m.options.agentStorageConversationData}
                value={formatStorageBytes(usage.canonicalBytes, locale)}
                detail={m.options.agentStorageConversationCount(
                  usage.sessionCount,
                  usage.messageCount,
                )}
              />
              <StorageMetric
                label={m.options.agentStorageToolCache}
                value={formatStorageBytes(usage.cacheBytes, locale)}
                detail={m.options.agentStorageArtifactCount(usage.cacheArtifactCount)}
              />
              <StorageMetric
                label={m.options.agentStorageTotal}
                value={formatStorageBytes(usage.totalBytes, locale)}
                detail={m.options.agentStorageLogicalLimit(
                  formatStorageBytes(usage.hardLimitBytes, locale),
                )}
              />
            </dl>

            <div className="mt-4">
              <Progress
                value={hardLimitPercent}
                aria-label={m.options.agentStorageUsageLabel}
                aria-valuemin={0}
                aria-valuemax={usage.hardLimitBytes}
                aria-valuenow={Math.min(usage.totalBytes, usage.hardLimitBytes)}
                className={cn("h-1.5", {
                  "[&>div]:bg-warning": usage.isWarning && !usage.isAtHardLimit,
                  "[&>div]:bg-destructive": usage.isAtHardLimit,
                })}
              />
              <p className="gsm-body-note mt-1.5">
                {m.options.agentStorageThresholds(
                  formatStorageBytes(usage.warningBytes, locale),
                  formatStorageBytes(usage.hardLimitBytes, locale),
                )}
              </p>
              <p className="gsm-body-note mt-1">
                {formatBrowserEstimate(
                  usage,
                  locale,
                  m.options.agentStorageBrowserUsage,
                  m.options.agentStorageBrowserUnavailable,
                )}
              </p>
            </div>

            {(usage.isWarning || usage.isAtHardLimit) && (
              <div
                className={cn(
                  "mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  {
                    "border-warning/40 bg-warning/10 text-warning": usage.isWarning && !usage.isAtHardLimit,
                    "border-destructive/40 bg-destructive/10 text-destructive": usage.isAtHardLimit,
                  },
                )}
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  {usage.isAtHardLimit
                    ? m.options.agentStorageLimitReached
                    : m.options.agentStorageWarning}
                </span>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <p className="gsm-body-note max-w-md">{m.options.agentStorageClearHint}</p>
              <Button
                type="button"
                variant="outline"
                disabled={clearBusy || loading || usage.cacheBytes === 0}
                onClick={() => void clearToolCache()}
              >
                {clearBusy ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
                {clearBusy
                  ? m.options.agentStorageClearingCache
                  : m.options.agentStorageClearCache}
              </Button>
            </div>
          </>
        ) : null}

        {error && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-destructive" role="alert">
            <span>{error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || clearBusy}
              onClick={() => void onRefresh()}
            >
              {m.options.agentStorageRetry}
            </Button>
          </div>
        )}
        {notice && !error && (
          <p className="mt-3 text-sm text-success" role="status" aria-live="polite">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}

function StorageMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-lg font-semibold tabular-nums">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted-foreground">{detail}</dd>
    </div>
  );
}

export function formatStorageBytes(bytes: number, locale: "en" | "zh-CN"): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const maximumFractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value)} ${units[unitIndex]}`;
}

function formatBrowserEstimate(
  usage: AgentStorageUsageSnapshot,
  locale: "en" | "zh-CN",
  format: (usage: string, quota: string) => string,
  unavailable: string,
): string {
  const browserUsage = usage.browser.usageBytes;
  const browserQuota = usage.browser.quotaBytes;
  if (browserUsage == null || browserQuota == null) return unavailable;
  return format(
    formatStorageBytes(browserUsage, locale),
    formatStorageBytes(browserQuota, locale),
  );
}
