import { X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { RadarProps } from '@/ui/radar-types';
import { formatRadarAbsoluteTime } from '@/ui/radar-time';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { useDismissableNotice } from '@/ui/hooks/use-dismissable-notice';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';

export function RadarStatusRibbon({
  result,
  loading,
  refreshing,
  error,
  onOpenOptions,
  fullReconciling,
}: Pick<
  RadarProps,
  'result' | 'loading' | 'refreshing' | 'fullReconciling' | 'error' | 'onOpenOptions'
>) {
  const busy = refreshing || fullReconciling;
  const { m, locale } = useI18n();
  const status = result?.status;
  const state = status?.state;
  const reconciliation = status?.reconciliation ?? null;
  const snapshotAt = formatRadarAbsoluteTime(state?.lastSuccessfulAt ?? null, locale);
  const provenanceWindow = state?.windowDays ?? null;
  const provenance = state?.lastRefreshMode && provenanceWindow !== null
    ? m.radar.snapshotProvenance(state.lastRefreshMode, provenanceWindow)
    : null;
  const permissionFailure = status?.errorCode === 'authentication_required'
    || status?.errorCode === 'permission_denied';
  const hasSavedActivity = (state?.activityCount ?? 0) > 0;
  const pauseTime = reconciliation?.nextAllowedAt
    ? formatRadarAbsoluteTime(reconciliation.nextAllowedAt, locale)
    : null;
  // A rate-reserve pause also writes a saved-state cooldown, and its own copy
  // already names the wait plus progress. Only a recorded failure outranks
  // paused-progress copy, otherwise the reason stays hidden behind it.
  const failureOwnsRibbon = status?.hasMainToken !== true || status.errorCode !== null;
  let text = m.common.loading;
  let tone: 'muted' | 'success' | 'warning' | 'destructive' = 'muted';

  if (loading && !result) {
    text = m.common.loading;
  } else if (busy) {
    text = result
      ? fullReconciling ? m.radar.statusReconcilingSaved : m.radar.statusRefreshingSaved
      : fullReconciling ? m.radar.fullReconciling : m.radar.refreshing;
  } else if (error === 'refresh' && result) {
    text = m.radar.statusRefreshFailedSaved;
    tone = 'warning';
  } else if (reconciliation && !failureOwnsRibbon) {
    text = reconciliation.pauseReason === 'rate_reserve' && pauseTime
      ? m.radar.statusReconciliationRatePaused(pauseTime)
      : m.radar.statusReconciliationPaused(
        reconciliation.completedCount,
        reconciliation.totalCount,
      );
    tone = 'warning';
  } else if (error === 'query' && !result) {
    text = m.radar.queryFailed;
    tone = 'destructive';
  } else if (!status?.hasMainToken) {
    text = m.radar.configureMainToken;
    tone = 'warning';
  } else {
    switch (status.snapshotStatus) {
      case 'fresh':
        text = m.radar.freshSummary(state?.activityCount ?? 0, state?.followingCount ?? 0);
        tone = 'success';
        break;
      case 'partial':
        text = m.radar.statusPartial;
        tone = 'warning';
        break;
      case 'stale':
        text = m.radar.statusRefreshFailedSaved;
        tone = 'warning';
        break;
      case 'cooldown': {
        const allowedAt = formatRadarAbsoluteTime(state?.nextAllowedAt ?? null, locale);
        text = allowedAt ? m.radar.statusCooldown(allowedAt) : m.radar.statusRefreshFailedSaved;
        tone = 'warning';
        break;
      }
      case 'error':
        text = permissionFailure
          ? m.radar.statusPermission
          : hasSavedActivity ? m.radar.statusRefreshFailedSaved : m.radar.refreshFailed;
        tone = hasSavedActivity ? 'warning' : 'destructive';
        break;
      case 'never_loaded':
        text = m.radar.neverLoadedBody;
        break;
      case 'not_configured':
        text = m.radar.configureMainToken;
        tone = 'warning';
        break;
    }
  }

  const { dismissed, dismiss } = useDismissableNotice(
    (tone === 'warning' || tone === 'destructive') && !loading && !busy,
  );
  if (dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="shrink-0 overflow-hidden border-b border-border bg-card text-xs"
      data-radar-status={busy ? 'refreshing' : status?.snapshotStatus ?? (loading ? 'loading' : 'error')}
    >
      <SurfaceWorkCanvas variant="following" className="relative flex min-h-[30px] items-center gap-2 px-3.5 py-1">
        {busy || (loading && !result) ? (
          <Spinner className="size-3 shrink-0" />
        ) : (
          <span className={cn('size-[7px] shrink-0 rounded-full', {
            'border border-muted-foreground bg-transparent': tone === 'muted',
            'bg-success': tone === 'success',
            'bg-warning': tone === 'warning',
            'bg-destructive': tone === 'destructive',
          })} aria-hidden="true" />
        )}
        <span className="min-w-0 truncate text-foreground/90">{text}</span>
        <span className="flex-1" />
        {permissionFailure && (
          <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={onOpenOptions}>
            {m.radar.openOptions}
          </Button>
        )}
        {snapshotAt && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground max-[640px]:hidden">
            {provenance ? `${provenance} · ` : ''}{m.radar.snapshotAt(snapshotAt)}
          </span>
        )}
        {(tone === 'warning' || tone === 'destructive') && !loading && !busy && (
          <button
            type="button"
            aria-label={m.common.close}
            onClick={dismiss}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
        {busy && <span className="gsm-watch-refresh-bar" aria-hidden="true" />}
      </SurfaceWorkCanvas>
    </div>
  );
}
