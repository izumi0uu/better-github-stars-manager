import { AlertTriangle, Inbox, RefreshCw, Settings2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/i18n';
import { useManagerNow } from '@/ui/manager-runtime-context';

import { cn } from '@/lib/utils';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { WatchInboxCommandBar } from '@/ui/components/WatchInboxCommandBar';
import { WatchRepositoryHeader } from '@/ui/components/WatchRepositoryHeader';
import { WatchThreadRow } from '@/ui/components/WatchThreadRow';
import { SurfaceListEndMarker } from '@/ui/components/SurfaceListEndMarker';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import {
  adjacentWatchThreadRowIndex,
  buildWatchInboxRows,
  countWatchReasons,
  filterWatchInboxProjection,
  hasNewWatchGroupContent,
  watchGroupContentSignature,
  type WatchThreadNavigationKey,
} from '@/ui/watch-inbox-presentation';
import { projectWatchInbox } from '@/watch/watch-model';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';
import type { WatchInboxProps } from '@/ui/watch-inbox-types';

const WATCH_REPOSITORY_ROW_ESTIMATE = 34;
const WATCH_THREAD_ROW_ESTIMATE = 37;
const WATCH_ROW_OVERSCAN = 8;

/**
 * Revoked authentication and missing permission both mean the selected
 * credential can no longer read GitHub. Only Watch pauses in that case; Stars,
 * tags, Gist, and sync keep working, so these states offer credential recovery
 * instead of a plain retry.
 */
function isWatchCredentialError(code: string | null | undefined): boolean {
  return code === 'authentication_required' || code === 'permission_denied';
}

function formatWatchTimelineDay(
  value: string,
  locale: string,
  now: number,
  todayLabel: string,
  yesterdayLabel: string,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const today = new Date(now);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (dayStart === todayStart.getTime()) return todayLabel;
  todayStart.setDate(todayStart.getDate() - 1);
  if (dayStart === todayStart.getTime()) return yesterdayLabel;
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

function EmptyState({
  icon,
  title,
  text,
  action,
  tone = 'muted',
}: {
  icon: React.ReactNode;
  title?: string;
  text: string;
  action?: React.ReactNode;
  tone?: 'muted' | 'success' | 'destructive';
}) {
  return (
    <SurfaceWorkCanvas variant="watch">
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-5 py-12 text-center">
        <div className={cn('grid size-8 place-items-center rounded-lg', {
          'bg-muted text-muted-foreground': tone === 'muted',
          'bg-success/10 text-success': tone === 'success',
          'bg-destructive/10 text-destructive': tone === 'destructive',
        })}>
          {icon}
        </div>
        {title && <p className="text-[13.5px] font-semibold text-foreground">{title}</p>}
        <p className="max-w-md text-xs leading-5 text-muted-foreground">{text}</p>
        {action && <div className="mt-2 flex gap-2">{action}</div>}
      </div>
    </SurfaceWorkCanvas>
  );
}

export function WatchInbox({
  result,
  newerThan,
  scrollElement,
  loading,
  refreshing,
  loadingOlder,
  loadOlderError,
  actionPending,
  actionError,
  unreadOnly,
  onUnreadOnlyChange,
  onRefresh,
  onRetryQuery,
  onLoadOlder,
  onOpenOptions,
  onOpenMainTokenOptions,
  onMarkThreadsRead,
  onMarkThreadsDone,
  collapsedRepositories = {},
  onRepositoryCollapseChange,
  onSelectRepository,
}: WatchInboxProps) {
  const { m, locale } = useI18n();
  const now = useManagerNow();
  const [query, setQuery] = useState('');
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const [manualRepositoryExpansions, setManualRepositoryExpansions] = useState<
    Record<string, 'expanded' | 'collapsed'>
  >({});
  const [expandedThreadIds, setExpandedThreadIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingFocusThreadId, setPendingFocusThreadId] = useState<string | null>(null);
  const [autoExpandedRepositories, setAutoExpandedRepositories] = useState<Record<string, true>>({});
  const reconciledCollapseSignatures = useRef<Record<string, string>>({});
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  const historySentinelVisibleRef = useRef(false);
  const historyScrollIntentRef = useRef(false);
  const requestedHistoryKeyRef = useRef<string | null>(null);
  const searchInput = useImeBufferedInput(query, setQuery);
  const status = result?.status;
  const state = status?.state;
  const historyNextPage = state?.inbox.historyNextPage ?? null;
  const historyExhausted = state?.inbox.historyExhausted ?? true;
  const canLoadOlder = historyNextPage !== null && !historyExhausted;
  const historyRequestKey = canLoadOlder
    ? `${status?.accountLogin ?? ''}:${state?.inbox.historyBefore ?? ''}:${historyNextPage}`
    : null;
  const newerThanMs = Date.parse(newerThan ?? '');
  const modeProjection = useMemo(
    () => result ? projectWatchInbox(result.threads, { unreadOnly }) : null,
    [result, unreadOnly],
  );
  const reasonCounts = useMemo(
    () => countWatchReasons(modeProjection?.threads ?? []),
    [modeProjection?.threads],
  );
  const visibleProjection = useMemo(
    () => modeProjection
      ? filterWatchInboxProjection(modeProjection, { query, reasons: selectedReasons })
      : null,
    [modeProjection, query, selectedReasons],
  );
  const sourceGroupsByRepository = useMemo(() => new Map(
    (result?.groups ?? []).map((group) => [group.repositoryFullName.toLowerCase(), group]),
  ), [result?.groups]);
  const groups = visibleProjection?.groups ?? [];
  const hasPresentationFilters = query.trim().length > 0 || selectedReasons.length > 0;
  const expandedRepositories = useMemo(() => {
    const expanded = new Set<string>();
    for (const group of groups) {
      const repository = group.repositoryFullName.toLowerCase();
      const sourceGroup = sourceGroupsByRepository.get(repository) ?? group;
      const persistedSignature = collapsedRepositories[repository] ?? null;
      const hasNewContent = persistedSignature !== null
        && hasNewWatchGroupContent(persistedSignature, sourceGroup.threads);
      const manualExpansion = manualRepositoryExpansions[repository] ?? null;
      const persistentlyCollapsed = persistedSignature !== null && !hasNewContent;
      if (
        hasPresentationFilters
        || hasNewContent
        || manualExpansion === 'expanded'
        || (!persistentlyCollapsed && manualExpansion !== 'collapsed')
      ) expanded.add(repository);
    }
    return expanded;
  }, [
    collapsedRepositories,
    groups,
    hasPresentationFilters,
    manualRepositoryExpansions,
    sourceGroupsByRepository,
  ]);
  const flatRows = useMemo(
    () => buildWatchInboxRows(visibleProjection?.threads ?? [], expandedRepositories),
    [expandedRepositories, visibleProjection?.threads],
  );
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollElement ?? null,
    getItemKey: (index) => flatRows[index]?.key ?? index,
    estimateSize: (index) => flatRows[index]?.kind === 'day'
      ? 32
      : flatRows[index]?.kind === 'repository'
        ? WATCH_REPOSITORY_ROW_ESTIMATE
        : WATCH_THREAD_ROW_ESTIMATE,
    overscan: WATCH_ROW_OVERSCAN,
  });

  useEffect(() => {
    const sentinel = historySentinelRef.current;
    if (
      !sentinel
      || !historyRequestKey
      || loadingOlder
      || loadOlderError
      || refreshing
      || typeof IntersectionObserver === 'undefined'
    ) return;
    historySentinelVisibleRef.current = false;
    historyScrollIntentRef.current = false;
    const requestOlder = () => {
      if (!historyScrollIntentRef.current || !historySentinelVisibleRef.current) return;
      if (requestedHistoryKeyRef.current === historyRequestKey) return;
      requestedHistoryKeyRef.current = historyRequestKey;
      onLoadOlder();
    };
    const handleScroll = () => {
      historyScrollIntentRef.current = true;
      requestOlder();
    };
    const observer = new IntersectionObserver((entries) => {
      historySentinelVisibleRef.current = entries.some((entry) => entry.isIntersecting);
      requestOlder();
    }, {
      root: scrollElement ?? null,
      rootMargin: '320px 0px',
    });
    const scrollTarget: EventTarget = scrollElement ?? window;
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
    observer.observe(sentinel);
    return () => {
      historySentinelVisibleRef.current = false;
      historyScrollIntentRef.current = false;
      scrollTarget.removeEventListener('scroll', handleScroll);
      observer.disconnect();
    };
  }, [historyRequestKey, loadOlderError, loadingOlder, onLoadOlder, refreshing, scrollElement]);

  const handleLoadOlder = useCallback(() => {
    if (historyRequestKey) requestedHistoryKeyRef.current = historyRequestKey;
    onLoadOlder();
  }, [historyRequestKey, onLoadOlder]);
  const refreshDisabled = refreshing || actionPending !== null || status?.inboxStatus === 'cooldown';

  const handleRepositoryToggle = useCallback((
    group: WatchInboxQueryResponse['groups'][number],
  ) => {
    if (hasPresentationFilters) return;
    const repository = group.repositoryFullName.toLowerCase();
    const sourceGroup = sourceGroupsByRepository.get(repository) ?? group;
    const expanded = expandedRepositories.has(repository);
    setManualRepositoryExpansions((current) => ({
      ...current,
      [repository]: expanded ? 'collapsed' : 'expanded',
    }));
    if (expanded) {
      const threadIds = new Set(sourceGroup.threads.map((thread) => thread.id));
      setExpandedThreadIds((current) => {
        let changed = false;
        const next = new Set<string>();
        for (const id of current) {
          if (threadIds.has(id)) changed = true;
          else next.add(id);
        }
        return changed ? next : current;
      });
      if (pendingFocusThreadId && threadIds.has(pendingFocusThreadId)) {
        setPendingFocusThreadId(null);
      }
      onRepositoryCollapseChange?.(
        group.repositoryFullName,
        watchGroupContentSignature(sourceGroup.threads),
      );
    } else {
      onRepositoryCollapseChange?.(group.repositoryFullName, null);
    }
  }, [
    expandedRepositories,
    hasPresentationFilters,
    onRepositoryCollapseChange,
    pendingFocusThreadId,
    sourceGroupsByRepository,
  ]);

  const handleThreadExpandedChange = useCallback((threadId: string, expanded: boolean) => {
    setExpandedThreadIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }, []);

  const handleFocusRequestHandled = useCallback((threadId: string) => {
    setPendingFocusThreadId((current) => current === threadId ? null : current);
  }, []);

  useEffect(() => {
    if (hasPresentationFilters) return;
    const collapsedThreadIds = new Set<string>();
    for (const group of groups) {
      const repository = group.repositoryFullName.toLowerCase();
      if (expandedRepositories.has(repository)) continue;
      const sourceGroup = sourceGroupsByRepository.get(repository) ?? group;
      for (const thread of sourceGroup.threads) collapsedThreadIds.add(thread.id);
    }
    if (collapsedThreadIds.size === 0) return;
    setExpandedThreadIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (collapsedThreadIds.has(id)) changed = true;
        else next.add(id);
      }
      return changed ? next : current;
    });
    setPendingFocusThreadId((current) => (
      current && collapsedThreadIds.has(current) ? null : current
    ));
  }, [expandedRepositories, groups, hasPresentationFilters, sourceGroupsByRepository]);

  const handleThreadListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-watch-thread]')
      : null;
    const currentThreadId = target?.dataset.watchThread;
    if (!target || !currentThreadId || !event.currentTarget.contains(target)) return;
    const nextRowIndex = adjacentWatchThreadRowIndex(
      flatRows,
      currentThreadId,
      event.key as WatchThreadNavigationKey,
    );
    if (nextRowIndex === null) return;
    const nextRow = flatRows[nextRowIndex];
    if (nextRow.kind !== 'thread') return;
    event.preventDefault();
    const mountedTarget = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-watch-thread]'),
    ).find((button) => button.dataset.watchThread === nextRow.thread.id);
    if (mountedTarget) {
      mountedTarget.focus();
      return;
    }
    setPendingFocusThreadId(nextRow.thread.id);
    rowVirtualizer.scrollToIndex(nextRowIndex, { align: 'auto' });
  };

  useEffect(() => {
    if (!result || !onRepositoryCollapseChange) return;
    const newlyExpanded: Record<string, true> = {};
    for (const group of result.groups) {
      const repository = group.repositoryFullName.toLowerCase();
      const persistedSignature = collapsedRepositories[repository];
      if (!persistedSignature) {
        delete reconciledCollapseSignatures.current[repository];
        continue;
      }
      const currentSignature = watchGroupContentSignature(group.threads);
      const reconciliation = `${persistedSignature}\n${currentSignature}`;
      if (reconciledCollapseSignatures.current[repository] === reconciliation) continue;
      reconciledCollapseSignatures.current[repository] = reconciliation;
      if (hasNewWatchGroupContent(persistedSignature, group.threads)) {
        newlyExpanded[repository] = true;
        onRepositoryCollapseChange(group.repositoryFullName, null);
      } else if (persistedSignature !== currentSignature) {
        onRepositoryCollapseChange(group.repositoryFullName, currentSignature);
      }
    }
    if (Object.keys(newlyExpanded).length > 0) {
      setManualRepositoryExpansions((current) => {
        const next = { ...current };
        for (const repository of Object.keys(newlyExpanded)) next[repository] = 'expanded';
        return next;
      });
      setAutoExpandedRepositories((current) => ({ ...current, ...newlyExpanded }));
    }
  }, [collapsedRepositories, onRepositoryCollapseChange, result]);

  useEffect(() => {
    if (Object.keys(autoExpandedRepositories).length === 0) return;
    const timer = window.setTimeout(() => setAutoExpandedRepositories({}), 1_000);
    return () => window.clearTimeout(timer);
  }, [autoExpandedRepositories]);

  if (loading && !result) {
    return <EmptyState icon={<Spinner className="size-4" />} text={m.common.loading} />;
  }

  if (!result || !status) {
    return (
      <EmptyState
        icon={<AlertTriangle className="size-4" />}
        title={m.watch.title}
        text={m.watch.queryFailed}
        tone="destructive"
        action={<Button onClick={onRetryQuery}>{m.watch.retry}</Button>}
      />
    );
  }

  if (!status.hasMainToken) {
    return (
      <EmptyState
        icon={<Settings2 className="size-4" />}
        title={m.watch.title}
        text={m.watch.configureMainToken}
        action={<Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>}
      />
    );
  }

  const inboxNeverLoaded = !state?.inbox.lastSuccessfulAt;
  const inboxCredentialFailure = isWatchCredentialError(state?.inbox.errorCode);

  const rowSpacingClass = (index: number) => {
    const row = flatRows[index];
    const nextRow = flatRows[index + 1];
    if (row.kind === 'day') return index === 0 ? 'pb-1.5' : 'pb-1.5 pt-3';
    if (row.kind === 'repository' && nextRow?.kind === 'thread') return 'pb-1';
    return !nextRow || nextRow.kind !== 'thread' ? 'pb-3.5' : undefined;
  };

  const renderRowContent = (row: (typeof flatRows)[number]) => {
    if (row.kind === 'day') {
      return (
        <div
          className="relative z-10 flex min-h-7 items-center bg-background"
          data-watch-day={row.dayKey}
        >
          <time
            dateTime={row.updatedAt}
            className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {formatWatchTimelineDay(
              row.updatedAt,
              locale,
              now,
              m.watch.timelineToday,
              m.watch.timelineYesterday,
            )}
          </time>
        </div>
      );
    }
    if (row.kind === 'repository') {
      const repository = row.group.repositoryFullName.toLowerCase();
      const sourceGroup = sourceGroupsByRepository.get(repository) ?? row.group;
      return (
        <WatchRepositoryHeader
          group={row.group}
          sourceGroup={sourceGroup}
          expanded={expandedRepositories.has(repository)}
          revealMatches={hasPresentationFilters}
          autoExpanded={autoExpandedRepositories[repository] === true}
          actionPending={actionPending}
          onToggleExpanded={() => handleRepositoryToggle(row.group)}
          onSelectRepository={onSelectRepository}
          onMarkThreadsRead={onMarkThreadsRead}
          onMarkThreadsDone={onMarkThreadsDone}
        />
      );
    }
    const updatedAt = Date.parse(row.thread.updatedAt);
    const newSinceLastVisit = Number.isFinite(updatedAt)
      && Number.isFinite(newerThanMs)
      && updatedAt > newerThanMs;
    return (
      <WatchThreadRow
        thread={row.thread}
        locale={locale}
        newSinceLastVisit={newSinceLastVisit}
        expanded={expandedThreadIds.has(row.thread.id)}
        focusRequested={pendingFocusThreadId === row.thread.id}
        actionPending={actionPending}
        onExpandedChange={(expanded) => handleThreadExpandedChange(row.thread.id, expanded)}
        onFocusRequestHandled={handleFocusRequestHandled}
        onOpenMainTokenOptions={onOpenMainTokenOptions}
        onMarkThreadsRead={onMarkThreadsRead}
        onMarkThreadsDone={onMarkThreadsDone}
      />
    );
  };

  const renderHistoryBoundary = (
    visibleThreadCount: number,
    variant: 'plain' | 'timeline' = 'timeline',
  ) => {
    const stale = status.inboxStatus === 'error'
      || status.inboxStatus === 'stale'
      || status.inboxStatus === 'cooldown';
    const boundaryState = loadOlderError
      ? 'error'
      : loadingOlder
        ? 'loading'
        : canLoadOlder ? 'more' : 'complete';
    const tone: 'muted' | 'info' | 'warning' = loadOlderError
      ? 'warning'
      : canLoadOlder ? 'info' : stale ? 'warning' : 'muted';
    const text = loadOlderError
      ? m.watch.loadOlderFailed
      : loadingOlder
        ? m.watch.loadingOlder
        : canLoadOlder
          ? m.watch.listEndWindow
          : stale
            ? m.watch.listEndSaved(visibleThreadCount)
            : hasPresentationFilters
              ? m.watch.listEndMatches(visibleThreadCount)
              : m.watch.historyComplete(visibleThreadCount);
    return (
      <div
        ref={historySentinelRef}
        data-watch-history-sentinel={boundaryState}
        aria-busy={loadingOlder}
      >
        <SurfaceListEndMarker variant={variant} tone={tone} text={text} />
        {canLoadOlder && (
          <div className={cn('flex pb-1', {
            'pl-[23px]': variant === 'timeline',
            'justify-center px-3': variant === 'plain',
          })}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={loadingOlder || refreshing}
              onClick={handleLoadOlder}
            >
              {loadingOlder && <Spinner data-icon="inline-start" aria-label={m.watch.loadingOlder} />}
              {loadOlderError ? m.watch.retry : loadingOlder ? m.watch.loadingOlder : m.watch.loadOlder}
            </Button>
          </div>
        )}
      </div>
    );
  };

  let content: React.ReactNode;
  if (!status.hasNotificationsToken) {
    content = (
      <EmptyState
        icon={<Settings2 className="size-4" />}
        title={m.watch.title}
        text={m.watch.configureNotificationsToken}
        action={<Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>}
      />
    );
  } else if (status.inboxStatus === 'error' && inboxNeverLoaded) {
    content = (
      <EmptyState
        icon={<AlertTriangle className="size-4" />}
        title={m.watch.title}
        text={inboxCredentialFailure ? m.watch.inboxPermissionDenied : m.watch.inboxFailed}
        tone="destructive"
        action={inboxCredentialFailure
          ? <Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>
          : <Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.retry}</Button>}
      />
    );
  } else if (inboxNeverLoaded) {
    content = (
      <EmptyState
        icon={<RefreshCw className="size-4" />}
        title={m.watch.title}
        text={m.watch.inboxNeverLoaded}
        action={<Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.refresh}</Button>}
      />
    );
  } else if (groups.length === 0) {
    const visibleThreadCount = visibleProjection?.threads.length ?? 0;
    content = (
      <>
        <EmptyState
          icon={<Inbox className="size-4" />}
          title={hasPresentationFilters ? m.watch.reasonPresetAll : m.watch.watchSurface}
          text={(modeProjection?.threads.length ?? 0) > 0 && hasPresentationFilters
            ? m.watch.noMatchingThreads
            : unreadOnly ? m.watch.noUnreadThreads : m.watch.noThreads}
          tone={hasPresentationFilters ? 'muted' : 'success'}
        />
        {(canLoadOlder || loadOlderError) && renderHistoryBoundary(visibleThreadCount, 'plain')}
      </>
    );
  } else {
    const visibleThreadCount = visibleProjection?.threads.length ?? 0;
    content = (
      <SurfaceWorkCanvas variant="watch" className="px-4 py-3 max-sm:px-3">
        <div
          className="relative before:absolute before:bottom-3 before:left-[7px] before:top-3 before:w-px before:bg-muted-foreground/30 before:content-['']"
          data-watch-thread-list
          onKeyDown={handleThreadListKeyDown}
        >
          {scrollElement ? (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = flatRows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    className={rowSpacingClass(virtualRow.index)}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {renderRowContent(row)}
                  </div>
                );
              })}
            </div>
          ) : (
            flatRows.map((row, index) => (
              <div key={row.key} className={rowSpacingClass(index)}>
                {renderRowContent(row)}
              </div>
            ))
          )}
          {renderHistoryBoundary(visibleThreadCount)}
        </div>
      </SurfaceWorkCanvas>
    );
  }

  return (
    <section className="min-h-full bg-background" aria-label={m.watch.title}>
      <WatchInboxCommandBar
        searchInput={searchInput}
        reasonCounts={reasonCounts}
        selectedReasons={selectedReasons}
        onSelectedReasonsChange={setSelectedReasons}
        unreadOnly={unreadOnly}
        refreshing={refreshing}
        refreshDisabled={refreshDisabled}
        onUnreadOnlyChange={onUnreadOnlyChange}
        onRefresh={onRefresh}
      />
      <div
        aria-live="polite"
        aria-atomic="true"
        className={cn('border-b border-border bg-destructive/[0.07] text-xs text-destructive', {
          hidden: actionError === null,
        })}
      >
        <SurfaceWorkCanvas variant="watch" className="flex min-h-7 items-center gap-2 px-4 py-1 max-sm:px-3">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {actionError === 'read'
              ? m.watch.actionReadFailed
              : actionError === 'done' ? m.watch.actionDoneFailed : ''}
          </span>
        </SurfaceWorkCanvas>
      </div>
      {content}
    </section>
  );
}
