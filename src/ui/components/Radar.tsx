import {
  AlertTriangle,
  Check,
  Clock3,
  ListFilter,
  Radar as RadarIcon,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/i18n';
import type { RadarProps } from '@/ui/radar-types';
import { useDismissableNotice } from '@/ui/hooks/use-dismissable-notice';
import { RadarFeedRow, RadarProjectRow } from '@/ui/components/RadarActivityRows';
import { formatRadarAbsoluteTime } from '@/ui/radar-time';
import { RadarCommandBar, RadarEmptyState } from '@/ui/components/RadarCommandBar';
import { RadarRecommendations } from '@/ui/components/RadarRecommendations';
import { SurfaceListEndMarker } from '@/ui/components/SurfaceListEndMarker';
import {
  searchRadarActivities,
  searchRadarProjects,
} from '@/ui/radar-search';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';

export function Radar({
  result,
  recommendations,
  scrollElement,
  discoverView,
  loading,
  recommendationLoading,
  refreshing,
  fullReconciling,
  recommendationRefreshing,
  error,
  recommendationError,
  actionError,
  pendingAction,
  recommendationFavorites,
  view,
  sources,
  onDiscoverViewChange,
  onViewChange,
  onSourceEnabledChange,
  onRefresh,
  onFullReconcile,
  onRefreshRecommendations,
  onRetryQuery,
  onRetryRecommendations,
  onOpenOptions,
  onStar,
  onUnstar,
  onIgnore,
  onRestoreIgnored,
  onSetFavorite,
  onAddTag,
  onDismiss,
  onMarkSeen,
}: RadarProps) {
  const { m, locale } = useI18n();
  const [openRowKey, setOpenRowKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const { dismissed: partialDismissed, dismiss: dismissPartial } = useDismissableNotice(
    (result?.status.state?.partialReasons.length ?? 0) > 0 && !refreshing,
  );
  const pendingFocusIndexRef = useRef<number | null>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const sourceActivities = useMemo(
    () => (result?.activities ?? []).filter((activity) => sources[activity.source]),
    [result?.activities, sources.following, sources.self],
  );
  const activitySearchResults = useMemo(
    () => searchRadarActivities(sourceActivities, query),
    [query, sourceActivities],
  );
  const projectSearchResults = useMemo(
    () => searchRadarProjects(sourceActivities, query),
    [query, sourceActivities],
  );
  const queryActive = query.trim().length > 0;
  const visibleResultCount = view === 'feed'
    ? activitySearchResults.length
    : projectSearchResults.length;
  const radarVirtualizer = useVirtualizer({
    count: view === 'feed' ? activitySearchResults.length : projectSearchResults.length,
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => (view === 'feed' ? 84 : 168),
    overscan: 8,
  });

  useEffect(() => {
    setOpenRowKey(null);
  }, [query, sources.following, sources.self, view]);

  useEffect(() => {
    if (!openRowKey || openRowKey.startsWith('project:')) return;
    const close = () => setOpenRowKey(null);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [openRowKey]);

  useEffect(() => {
    if (pendingAction || pendingFocusIndexRef.current === null) return;
    const index = pendingFocusIndexRef.current;
    pendingFocusIndexRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const buttons = surfaceRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-radar-dismiss]',
      ) ?? [];
      buttons[Math.min(index, buttons.length - 1)]?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activitySearchResults.length, pendingAction, projectSearchResults.length, view]);

  const dismissAt = (repositoryKey: string, activityIds: readonly string[], index: number) => {
    setOpenRowKey(null);
    pendingFocusIndexRef.current = index;
    void onDismiss(repositoryKey, activityIds);
  };

  if (discoverView === 'for-you') {
    return (
      <RadarRecommendations
        recommendations={recommendations}
        discoverView={discoverView}
        loading={recommendationLoading}
        refreshing={recommendationRefreshing}
        error={recommendationError}
        pendingAction={pendingAction}
        recommendationFavorites={recommendationFavorites}
        actionError={actionError}
        onDiscoverViewChange={onDiscoverViewChange}
        onRefresh={onRefreshRecommendations}
        onRetryQuery={onRetryRecommendations}
        onOpenOptions={onOpenOptions}
        onStar={onStar}
        onIgnore={onIgnore}
        onRestoreIgnored={onRestoreIgnored}
        onSetFavorite={onSetFavorite}
        onAddTag={onAddTag}
      />
    );
  }

  const renderFrame = (content: ReactNode) => (
    <section ref={surfaceRef} className="min-h-full bg-background" aria-label={m.radar.title} data-radar-surface data-radar-discover-view="following">
      <RadarCommandBar
        result={result}
        loading={loading}
        discoverView={discoverView}
        view={view}
        refreshing={refreshing}
        fullReconciling={fullReconciling}
        sources={sources}
        query={query}
        resultCount={visibleResultCount}
        onDiscoverViewChange={onDiscoverViewChange}
        onViewChange={onViewChange}
        onRefresh={onRefresh}
        onFullReconcile={onFullReconcile}
        onSourceEnabledChange={onSourceEnabledChange}
        onQueryChange={setQuery}
      />
      {content}
    </section>
  );
  if (loading && !result) {
    return renderFrame(
      <RadarEmptyState icon={<Spinner className="size-4" aria-hidden="true" />} />,
    );
  }
  if (!result) {
    return renderFrame(
      <RadarEmptyState
        icon={<AlertTriangle className="size-4" />}
        title={m.radar.title}
        text={m.radar.queryFailed}
        tone="destructive"
        action={<Button onClick={onRetryQuery}>{m.radar.retry}</Button>}
      />,
    );
  }
  const status = result.status;
  const state = status.state;
  const permissionFailure = status.errorCode === 'authentication_required'
    || status.errorCode === 'permission_denied';
  if (!status.hasMainToken) {
    return renderFrame(
      <RadarEmptyState
        icon={<Settings2 className="size-4" />}
        title={m.radar.title}
        text={m.radar.configureMainToken}
        action={<Button onClick={onOpenOptions}>{m.radar.openOptions}</Button>}
      />,
    );
  }
  if (status.snapshotStatus === 'error' && !state?.lastSuccessfulAt && result.activities.length === 0) {
    return renderFrame(
      <RadarEmptyState
        icon={<AlertTriangle className="size-4" />}
        title={permissionFailure ? m.radar.permissionTitle : m.radar.title}
        text={permissionFailure ? m.radar.permissionBody : m.radar.refreshFailed}
        tone="destructive"
        action={(
          <>
            {permissionFailure && <Button onClick={onOpenOptions}>{m.radar.openOptions}</Button>}
            <Button variant={permissionFailure ? 'outline' : 'default'} onClick={onRefresh} disabled={refreshing}>
              {m.radar.retry}
            </Button>
          </>
        )}
      />,
    );
  }
  if (status.snapshotStatus === 'never_loaded' && result.activities.length === 0) {
    return renderFrame(
      <RadarEmptyState
        icon={<RadarIcon className="size-4" />}
        title={m.radar.neverLoadedTitle}
        text={m.radar.neverLoadedBody}
        action={<Button onClick={onRefresh} disabled={refreshing}>{m.radar.runFirstScan}</Button>}
      />,
    );
  }
  if (result.activities.length === 0) {
    if (status.snapshotStatus === 'cooldown') {
      const allowedAt = formatRadarAbsoluteTime(state?.nextAllowedAt ?? null, locale);
      return renderFrame(
        <RadarEmptyState
          icon={<Clock3 className="size-4" />}
          title={m.radar.title}
          text={allowedAt ? m.radar.cooldownUntil(allowedAt) : m.radar.staleSnapshot}
          tone="warning"
        />,
      );
    }
    if (status.snapshotStatus === 'partial') {
      return renderFrame(
        <RadarEmptyState
          icon={<AlertTriangle className="size-4" />}
          title={m.radar.title}
          text={m.radar.partialSnapshot(state?.partialReasons.length ?? 0)}
          tone="warning"
        />,
      );
    }
    if (status.snapshotStatus === 'stale') {
      return renderFrame(
        <RadarEmptyState
          icon={<AlertTriangle className="size-4" />}
          title={m.radar.title}
          text={m.radar.staleSnapshot}
          tone="warning"
          action={<Button onClick={onRefresh} disabled={refreshing}>{m.radar.retry}</Button>}
        />,
      );
    }
    return renderFrame(
      <RadarEmptyState
        icon={<Check className="size-4" />}
        title={m.radar.emptyTitle}
        text={m.radar.emptyBody(status.windowDays)}
        tone="success"
      />,
    );
  }
  const listEndTone = status.snapshotStatus === 'partial'
    ? 'info'
    : status.snapshotStatus === 'stale'
      || status.snapshotStatus === 'cooldown'
      || status.snapshotStatus === 'error'
      || error !== null
      ? 'warning'
      : 'muted';
  const listEndText = status.snapshotStatus === 'partial'
    ? m.radar.listEndPartial
    : listEndTone === 'warning'
      ? m.radar.listEndSaved(visibleResultCount)
      : queryActive
        ? m.radar.listEndMatches(visibleResultCount)
        : view === 'feed'
          ? m.radar.listEndActivities(status.windowDays, visibleResultCount)
          : m.radar.listEndProjects(status.windowDays, visibleResultCount);
  const renderRadarRow = (index: number) => {
    if (view === 'feed') {
      const searchResult = activitySearchResults[index];
      const { activity } = searchResult;
      return (
        <RadarFeedRow
          searchResult={searchResult}
          open={openRowKey === activity.id}
          onOpenChange={(open) => setOpenRowKey(open ? activity.id : null)}
          pendingAction={pendingAction}
          actionError={actionError}
          onStar={onStar}
          onUnstar={onUnstar}
          onSetFavorite={onSetFavorite}
          onAddTag={onAddTag}
          onDismiss={() => dismissAt(activity.repositoryKey, [activity.id], index)}
          onMarkSeen={onMarkSeen}
        />
      );
    }
    const searchResult = projectSearchResults[index];
    const { project } = searchResult;
    return (
      <RadarProjectRow
        searchResult={searchResult}
        open={openRowKey === `project:${project.repositoryKey}`}
        onOpenChange={(open) => setOpenRowKey(open ? `project:${project.repositoryKey}` : null)}
        pendingAction={pendingAction}
        actionError={actionError}
        onStar={onStar}
        onUnstar={onUnstar}
        onSetFavorite={onSetFavorite}
        onAddTag={onAddTag}
        onDismiss={() => dismissAt(project.repositoryKey, project.activityIds, index)}
        onMarkSeen={onMarkSeen}
      />
    );
  };
  return renderFrame(
    <>
      {!partialDismissed && state?.partialReasons.length ? (
        <div className="border-b border-warning/25 bg-warning/[0.07] text-[11px] leading-4 text-foreground/90" data-radar-partial-banner>
          <SurfaceWorkCanvas variant="following" className="flex items-start gap-2 px-3.5 py-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0">
              {m.radar.statusPartial}:{' '}
              {state.partialReasons.map((reason) => m.radar.partialReason(reason, status.windowDays)).join(' ')}
            </span>
            <button
              type="button"
              aria-label={m.common.close}
              onClick={dismissPartial}
              className="ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </SurfaceWorkCanvas>
        </div>
      ) : null}
      {sourceActivities.length === 0 ? (
        <RadarEmptyState
          icon={<ListFilter className="size-4" />}
          title={m.radar.filteredEmptyTitle}
          text={m.radar.filteredEmptyBody(status.windowDays)}
        />
      ) : visibleResultCount === 0 && queryActive ? (
        <RadarEmptyState
          icon={<Search className="size-4" />}
          title={m.radar.searchPlaceholder}
          text={m.radar.searchEmpty(query.trim())}
        />
      ) : (
        <SurfaceWorkCanvas
          variant={view === 'feed' ? 'following-feed' : 'following'}
          data-radar-view={view}
        >
          {scrollElement ? (
            <div style={{ height: radarVirtualizer.getTotalSize(), position: 'relative' }}>
              {radarVirtualizer.getVirtualItems().map((vi) => {
                const index = vi.index;
                const itemKey = view === 'feed'
                  ? activitySearchResults[index].activity.id
                  : projectSearchResults[index].project.repositoryKey;
                return (
                  <div
                    key={itemKey}
                    ref={radarVirtualizer.measureElement}
                    data-index={index}
                    className="border-b border-border/70"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {renderRadarRow(index)}
                  </div>
                );
              })}
            </div>
          ) : (
            (view === 'feed' ? activitySearchResults : projectSearchResults).map((searchResult, index) => {
              const itemKey = 'activity' in searchResult
                ? searchResult.activity.id
                : searchResult.project.repositoryKey;
              return (
                <div key={itemKey} className="border-b border-border/70">
                  {renderRadarRow(index)}
                </div>
              );
            })
          )}
          <SurfaceListEndMarker tone={listEndTone} text={listEndText} />
        </SurfaceWorkCanvas>
      )}
    </>,
  );
}
