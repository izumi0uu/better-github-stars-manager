import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  Clock3,
  EyeOff,
  ExternalLink,
  Heart,
  ListFilter,
  Radar as RadarIcon,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Tag,
  User,
  Users,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type {
  RadarActivityPresentation,
  RadarActivitySource,
  RadarProjectPresentation,
} from '@/radar/radar-model';
import type { RadarQueryResponse } from '@/radar/radar-contract';
import type {
  RecommendationQueryResponse,
  RecommendationRecord,
} from '@/recommendations/recommendation-model';
import type {
  RadarActionError,
  RadarDiscoverView,
  RadarPendingAction,
  RadarSourceFilters,
  RadarView,
} from '@/ui/hooks/use-radar';
import { useDelayedHoverIntent } from '@/ui/hooks/use-delayed-hover-intent';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useDismissableNotice } from '@/ui/hooks/use-dismissable-notice';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { SearchMatchText } from '@/ui/components/SearchMatchText';
import { RepositoryOwnerAvatar, repositoryAvatarFallback } from '@/ui/components/RepositoryOwnerAvatar';
import { SurfaceListEndMarker } from '@/ui/components/SurfaceListEndMarker';
import {
  searchRadarActivities,
  searchRadarProjects,
  type RadarActivitySearchResult,
  type RadarProjectSearchResult,
} from '@/ui/radar-search';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Spinner } from '@/ui/shadcn/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';

interface RadarSurfaceProps {
  result: RadarQueryResponse | null;
  recommendations: RecommendationQueryResponse | null;
  scrollElement?: HTMLElement | null;
  discoverView: RadarDiscoverView;
  loading: boolean;
  recommendationLoading: boolean;
  refreshing: boolean;
  recommendationRefreshing: boolean;
  error: 'query' | 'refresh' | null;
  recommendationError: 'query' | 'refresh' | null;
  actionError: RadarActionError | null;
  pendingAction: RadarPendingAction | null;
  view: RadarView;
  sources: RadarSourceFilters;
  onDiscoverViewChange: (view: RadarDiscoverView) => void;
  onViewChange: (view: RadarView) => void;
  onSourceEnabledChange: (source: RadarActivitySource, enabled: boolean) => void;
  onRefresh: () => void;
  onRefreshRecommendations: () => void;
  onRetryQuery: () => void;
  onRetryRecommendations: () => void;
  onOpenOptions: () => void;
  onStar: (repositoryKey: string, fullName: string) => Promise<unknown>;
  onUnstar: (repositoryKey: string, fullName: string) => Promise<unknown>;
  onIgnore: (repositoryKey: string, repositoryFullName: string) => Promise<unknown>;
  onRestoreIgnored: (repositoryKey: string) => Promise<unknown>;
  onSetFavorite: (
    repositoryKey: string,
    fullName: string,
    favorite: boolean,
  ) => Promise<unknown>;
  onAddTag: (repositoryKey: string, fullName: string, tag: string) => Promise<unknown>;
  onDismiss: (repositoryKey: string, activityIds: readonly string[]) => Promise<unknown>;
  onMarkSeen: (activityIds: readonly string[]) => void;
}

interface RadarRepositoryTarget {
  repositoryKey: string;
  repositoryFullName: string;
  repositoryDisplayName: string;
  repositoryHtmlUrl: string;
  displayedStargazerCount: number;
  viewerHasStarred: boolean;
  favorite: boolean;
  tags: string[];
  suggestedTags: string[];
}

interface RadarPopoverVirtualAnchor {
  getBoundingClientRect: () => DOMRect;
}

function radarPopoverAnchorFromRect(rect: DOMRect): RadarPopoverVirtualAnchor {
  return { getBoundingClientRect: () => rect };
}

function radarPopoverPointRect(clientX: number, clientY: number): DOMRect {
  return {
    bottom: clientY,
    height: 0,
    left: clientX,
    right: clientX,
    top: clientY,
    width: 0,
    x: clientX,
    y: clientY,
    toJSON: () => ({
      bottom: clientY,
      height: 0,
      left: clientX,
      right: clientX,
      top: clientY,
      width: 0,
      x: clientX,
      y: clientY,
    }),
  };
}

function stopQuickActionPropagation(event: React.KeyboardEvent | React.MouseEvent | Event) {
  event.stopPropagation();
}

const RADAR_SEEN_HOVER_DELAY_MS = 180;
const noopRadarSeenIntent = () => {};

function isRadarDismissTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('[data-radar-dismiss]') !== null;
}
function acceptsRadarSeenIntent(currentTarget: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Node
    && currentTarget.contains(target)
    && !isRadarDismissTarget(target);
}


function supportsRadarSeenHoverIntent(): boolean {
  return typeof window === 'undefined'
    || typeof window.matchMedia !== 'function'
    || window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function useRadarSeenIntent({
  activityIds,
  enabled,
  onMarkSeen,
}: {
  activityIds: readonly string[];
  enabled: boolean;
  onMarkSeen: (activityIds: readonly string[]) => void;
}) {
  const immediateSourceRef = useRef<'mouse' | 'direct' | 'focus' | null>(null);
  const markSeen = useCallback(() => {
    if (!enabled) return;
    const uniqueIds = [...new Set(activityIds.filter((activityId) => activityId.length > 0))];
    if (uniqueIds.length > 0) onMarkSeen(uniqueIds);
  }, [activityIds, enabled, onMarkSeen]);
  const hoverIntent = useDelayedHoverIntent({
    enabled,
    delayMs: RADAR_SEEN_HOVER_DELAY_MS,
    onOpen: markSeen,
    onClose: noopRadarSeenIntent,
  });

  useEffect(() => {
    if (!enabled) immediateSourceRef.current = null;
  }, [enabled]);

  const clear = useCallback(() => {
    immediateSourceRef.current = null;
    hoverIntent.clear();
  }, [hoverIntent.clear]);
  const onMouseEnter = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!acceptsRadarSeenIntent(event.currentTarget, event.target) || !supportsRadarSeenHoverIntent()) {
      clear();
      return;
    }
    hoverIntent.onMouseEnter();
  }, [clear, hoverIntent.onMouseEnter]);
  const onPointerDownCapture = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!acceptsRadarSeenIntent(event.currentTarget, event.target)) {
      clear();
      return;
    }
    if (!event.pointerType || event.pointerType === 'mouse') {
      immediateSourceRef.current = 'mouse';
      return;
    }
    immediateSourceRef.current = 'direct';
    hoverIntent.clear();
    markSeen();
  }, [clear, hoverIntent.clear, markSeen]);
  const onFocusCapture = useCallback((event: React.FocusEvent<HTMLElement>) => {
    if (!acceptsRadarSeenIntent(event.currentTarget, event.target)) {
      clear();
      return;
    }
    hoverIntent.clear();
    if (immediateSourceRef.current !== null) return;
    immediateSourceRef.current = 'focus';
    markSeen();
  }, [clear, hoverIntent.clear, markSeen]);
  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!acceptsRadarSeenIntent(event.currentTarget, event.target)) {
      clear();
      return;
    }
    const immediateSource = immediateSourceRef.current;
    immediateSourceRef.current = null;
    hoverIntent.clear();
    if (immediateSource === null || immediateSource === 'mouse') markSeen();
  }, [clear, hoverIntent.clear, markSeen]);

  return {
    clear,
    onBlurCapture: clear,
    onClickCapture,
    onFocusCapture,
    onMouseEnter,
    onMouseLeave: clear,
    onPointerCancelCapture: clear,
    onPointerDownCapture,
  };
}

function formatAbsoluteTime(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatRadarRelativeTime(
  value: string,
  locale: string,
  nowMillis = Date.now(),
): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return '—';
  const minutes = Math.max(0, Math.round((nowMillis - then) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.round(hours / 24), 'day');
}

function RadarEmptyState({
  icon,
  title,
  text,
  action,
  tone = 'muted',
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
  tone?: 'muted' | 'success' | 'warning' | 'destructive';
}) {
  return (
    <SurfaceWorkCanvas variant="following">
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-5 py-12 text-center">
        <div className={cn('grid size-8 place-items-center rounded-lg', {
          'bg-muted text-muted-foreground': tone === 'muted',
          'bg-success/10 text-success': tone === 'success',
          'bg-destructive/10 text-destructive': tone === 'destructive',
          'bg-warning/10 text-warning': tone === 'warning',
        })}>
          {icon}
        </div>
        <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
        <p className="max-w-lg text-xs leading-5 text-muted-foreground">{text}</p>
        {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
      </div>
    </SurfaceWorkCanvas>
  );
}
function RadarDiscoverSwitcher({
  view,
  onViewChange,
}: {
  view: RadarDiscoverView;
  onViewChange: (view: RadarDiscoverView) => void;
}) {
  const { m } = useI18n();
  const followingRef = useRef<HTMLButtonElement>(null);
  const forYouRef = useRef<HTMLButtonElement>(null);
  const select = (candidate: RadarDiscoverView) => {
    onViewChange(candidate);
    (candidate === 'following' ? followingRef : forYouRef).current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
      && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'Home') select('following');
    else if (event.key === 'End') select('for-you');
    else select(view === 'following' ? 'for-you' : 'following');
  };
  return (
    <div
      role="tablist"
      aria-label={m.radar.discoverViewLabel}
      className="inline-flex h-[28px] shrink-0 items-center rounded-md bg-muted p-0.5"
      data-radar-discover-switcher
    >
      {(['following', 'for-you'] as const).map((candidate) => (
        <button
          key={candidate}
          ref={candidate === 'following' ? followingRef : forYouRef}
          type="button"
          role="tab"
          aria-selected={view === candidate}
          tabIndex={view === candidate ? 0 : -1}
          onKeyDown={onKeyDown}
          onClick={() => onViewChange(candidate)}
          className={cn('inline-flex h-6 items-center gap-1.5 rounded-sm px-2.5 text-[11px] font-medium text-muted-foreground outline-none transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring', {
            'bg-card text-foreground shadow-sm': view === candidate,
          })}
        >
          {candidate === 'for-you' && <Sparkles className="size-3" aria-hidden="true" />}
          {candidate === 'following' ? m.radar.following : m.radar.forYou}
        </button>
      ))}
    </div>
  );
}

function RadarSourceToggleGroup({
  sources,
  onSourceEnabledChange,
}: {
  sources: RadarSourceFilters;
  onSourceEnabledChange: (source: RadarActivitySource, enabled: boolean) => void;
}) {
  const { m } = useI18n();
  const entries = [
    {
      source: 'following' as const,
      label: m.radar.sourceFollowing,
      hint: m.radar.sourceFollowingHint,
    },
    {
      source: 'self' as const,
      label: m.radar.sourceSelf,
      hint: m.radar.sourceSelfHint,
    },
  ];
  return (
    <div
      className="inline-flex h-[26px] shrink-0 items-center rounded-md bg-muted p-0.5"
      role="group"
      aria-label={m.radar.sourceLabel}
    >
      {entries.map(({ source, label, hint }) => {
        const enabled = sources[source];
        return (
          <Tooltip key={source}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={hint}
                aria-pressed={enabled}
                onClick={() => onSourceEnabledChange(source, !enabled)}
                className={cn('inline-flex h-[22px] min-w-[26px] items-center justify-center gap-1 rounded-sm px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[520px]:w-[26px] max-[520px]:px-0', {
                  'bg-card text-foreground shadow-sm': enabled,
                })}
              >
                {source === 'following'
                  ? <Users className="size-3.5" aria-hidden="true" />
                  : <User className="size-3.5" aria-hidden="true" />}
                <span className="max-[520px]:hidden">{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

type RadarSurfaceActionsProps = Pick<
  RadarSurfaceProps,
  'result' | 'loading' | 'refreshing' | 'onRefresh' | 'sources'
> & {
  view: RadarView;
  onViewChange: (view: RadarView) => void;
  onSourceEnabledChange: (source: RadarActivitySource, enabled: boolean) => void;
};

export function RadarSurfaceActions({
  result,
  loading,
  view,
  refreshing,
  sources,
  onViewChange,
  onRefresh,
  onSourceEnabledChange,
}: RadarSurfaceActionsProps) {
  const { m } = useI18n();
  const status = result?.status.snapshotStatus;
  const refreshDisabled = loading || refreshing || status === 'cooldown' || status === 'not_configured';
  return (
    <div className="flex items-center gap-2">
      <div
        className="inline-flex h-[26px] items-center rounded-md bg-muted p-0.5"
        role="group"
        aria-label={m.radar.viewLabel}
        title={m.radar.toggleView}
      >
        {(['feed', 'projects'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={view === candidate}
            onClick={() => onViewChange(candidate)}
            className={cn('h-[22px] rounded-sm px-2.5 text-[11px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
              'bg-card text-foreground shadow-sm': view === candidate,
            })}
          >
            {candidate === 'feed' ? m.radar.feed : m.radar.projects}
          </button>
        ))}
      </div>
      <RadarSourceToggleGroup
        sources={sources}
        onSourceEnabledChange={onSourceEnabledChange}
      />
      {status && status !== 'fresh' && status !== 'never_loaded' && status !== 'not_configured' && status !== 'stale' && (
        <span className={cn('max-[700px]:hidden rounded-full border px-2 py-px font-mono text-[10px]', {
          'border-warning/35 bg-warning/10 text-warning': status === 'partial' || status === 'cooldown',
          'border-destructive/35 bg-destructive/10 text-destructive': status === 'error',
        })}>
          {m.radar.statusLabel(status)}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-[30px] gap-1.5 px-2.5 text-xs"
        disabled={refreshDisabled}
        onClick={onRefresh}
        aria-label={refreshing ? m.radar.refreshing : m.radar.refresh}
      >
        {refreshing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        <span className="max-[520px]:hidden">
          {refreshing ? m.radar.refreshing : m.radar.refresh}
        </span>
      </Button>
    </div>
  );
}

type RadarSurfaceCommandBarProps = RadarSurfaceActionsProps & {
  discoverView: RadarDiscoverView;
  query: string;
  resultCount: number;
  onDiscoverViewChange: (view: RadarDiscoverView) => void;
  onQueryChange: (query: string) => void;
};

function RadarSurfaceCommandBar({
  result,
  loading,
  discoverView,
  view,
  refreshing,
  sources,
  query,
  resultCount,
  onDiscoverViewChange,
  onViewChange,
  onRefresh,
  onSourceEnabledChange,
  onQueryChange,
}: RadarSurfaceCommandBarProps) {
  const { m } = useI18n();
  const searchInput = useImeBufferedInput(query, onQueryChange);
  const searchInputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className="gsm-z-sticky sticky top-0 border-b border-border bg-card"
      data-surface-command-bar="following"
    >
      <SurfaceWorkCanvas
        variant="following"
        className="flex min-h-10 min-w-0 flex-wrap items-center gap-2 px-3.5 py-1.5"
      >
        <RadarDiscoverSwitcher view={discoverView} onViewChange={onDiscoverViewChange} />
        <div className="relative min-w-0 flex-1 basis-72 max-[700px]:order-3 max-[700px]:basis-full sm:max-w-sm">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={searchInputRef}
            {...searchInput.inputProps}
            placeholder={`${m.radar.searchPlaceholder}…`}
            aria-label={m.radar.searchPlaceholder}
            className="h-[30px] bg-card pl-8 pr-8 text-xs shadow-none"
          />
          {query.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
              aria-label={m.radar.clearSearch}
              onClick={() => {
                onQueryChange('');
                searchInputRef.current?.focus();
              }}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
        {query.trim().length > 0 && (
          <span role="status" aria-live="polite" className="sr-only">
            {m.radar.searchResultCount(resultCount)}
          </span>
        )}
        <span className="inline-flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground max-[700px]:basis-full">
          <Clock3 className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{m.radar.publicActivityOnly}</span>
        </span>
        <span className="min-w-0 flex-1 max-[700px]:hidden" />
        <RadarSurfaceActions
          result={result}
          loading={loading}
          view={view}
          refreshing={refreshing}
          sources={sources}
          onViewChange={onViewChange}
          onRefresh={onRefresh}
          onSourceEnabledChange={onSourceEnabledChange}
        />
      </SurfaceWorkCanvas>
    </div>
  );
}

export function RadarStatusRibbon({
  result,
  loading,
  refreshing,
  error,
  onOpenOptions,
}: Pick<RadarSurfaceProps, 'result' | 'loading' | 'refreshing' | 'error' | 'onOpenOptions'>) {
  const { m, locale } = useI18n();
  const status = result?.status;
  const state = status?.state;
  const snapshotAt = formatAbsoluteTime(state?.lastSuccessfulAt ?? null, locale);
  const permissionFailure = status?.errorCode === 'authentication_required'
    || status?.errorCode === 'permission_denied';
  const hasSavedActivity = (state?.activityCount ?? 0) > 0;
  let text = m.common.loading;
  let tone: 'muted' | 'success' | 'warning' | 'destructive' = 'muted';

  if (loading && !result) {
    text = m.common.loading;
  } else if (refreshing) {
    text = result ? m.radar.statusRefreshingSaved : m.radar.refreshing;
  } else if (error === 'refresh' && result) {
    text = m.radar.statusRefreshFailedSaved;
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
        const allowedAt = formatAbsoluteTime(state?.nextAllowedAt ?? null, locale);
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
    (tone === 'warning' || tone === 'destructive') && !loading && !refreshing,
  );
  if (dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="shrink-0 overflow-hidden border-b border-border bg-card text-xs"
      data-radar-status={refreshing ? 'refreshing' : status?.snapshotStatus ?? (loading ? 'loading' : 'error')}
    >
      <SurfaceWorkCanvas variant="following" className="relative flex min-h-[30px] items-center gap-2 px-3.5 py-1">
        {refreshing || (loading && !result) ? (
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
            {m.radar.snapshotAt(snapshotAt)}
          </span>
        )}
        {(tone === 'warning' || tone === 'destructive') && !loading && !refreshing && (
          <button
            type="button"
            aria-label={m.common.close}
            onClick={dismiss}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
        {refreshing && <span className="gsm-watch-refresh-bar" aria-hidden="true" />}
      </SurfaceWorkCanvas>
    </div>
  );
}

function handleQuickActionKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  options: {
    pending: boolean;
    onToggleStar: () => void;
    onFavorite: () => void;
    tagInput: HTMLInputElement | null;
  },
) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const inInput = event.target instanceof HTMLInputElement;
  if (!inInput && event.key.toLocaleLowerCase('en-US') === 's') {
    event.preventDefault();
    if (!options.pending) options.onToggleStar();
    return;
  }
  if (!inInput && event.key.toLocaleLowerCase('en-US') === 'f') {
    event.preventDefault();
    if (!options.pending) options.onFavorite();
    return;
  }
  if (!inInput && event.key.toLocaleLowerCase('en-US') === 't') {
    event.preventDefault();
    options.tagInput?.focus({ preventScroll: true });
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const stops = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[data-radar-action-stop]:not(:disabled)'),
  );
  const activeElement = (event.currentTarget.getRootNode() as Document | ShadowRoot).activeElement;
  const index = stops.indexOf(activeElement as HTMLElement);
  if (stops.length === 0) return;
  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const next = index < 0
    ? direction > 0 ? 0 : stops.length - 1
    : (index + direction + stops.length) % stops.length;
  stops[next]?.focus({ preventScroll: true });
}

function RadarQuickActions({
  triggerLabel,
  target,
  open,
  onOpenChange,
  pendingAction,
  actionError,
  onStar,
  onUnstar,
  onSetFavorite,
  onAddTag,
}: {
  triggerLabel: string;
  target: RadarRepositoryTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingAction: RadarPendingAction | null;
  actionError: RadarActionError | null;
  onStar: RadarSurfaceProps['onStar'];
  onUnstar: RadarSurfaceProps['onUnstar'];
  onSetFavorite: RadarSurfaceProps['onSetFavorite'];
  onAddTag: RadarSurfaceProps['onAddTag'];
}) {
  const { m, locale } = useI18n();
  const actionBarId = useId();
  const statusId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const virtualAnchorRef = useRef<RadarPopoverVirtualAnchor | null>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [tagDraft, setTagDraft] = useState('');
  const pending = pendingAction?.repositoryKey === target.repositoryKey;
  const availableSuggestions = useMemo(() => {
    const applied = new Set(target.tags.map((tagName) => tagName.toLocaleLowerCase('en-US')));
    const query = tagDraft.trim().toLocaleLowerCase('en-US');
    return target.suggestedTags.filter((tagName) => (
      !applied.has(tagName.toLocaleLowerCase('en-US'))
      && (!query || tagName.toLocaleLowerCase('en-US').includes(query))
    )).slice(0, 8);
  }, [tagDraft, target.suggestedTags, target.tags]);

  useEffect(() => {
    if (!open) setTagDraft('');
  }, [open]);

  const addTag = async (raw: string) => {
    const tagName = raw.trim();
    if (!tagName || pending) return;
    const result = await onAddTag(target.repositoryKey, target.repositoryFullName, tagName);
    if (result !== null) setTagDraft('');
  };
  const toggleStar = () => {
    if (pending) return;
    const operation = target.viewerHasStarred ? onUnstar : onStar;
    void operation(target.repositoryKey, target.repositoryFullName);
  };
  const favorite = () => {
    if (!pending) {
      void onSetFavorite(
        target.repositoryKey,
        target.repositoryFullName,
        !target.favorite,
      );
    }
  };

  const handleTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.detail === 0
      ? event.currentTarget.getBoundingClientRect()
      : radarPopoverPointRect(event.clientX, event.clientY);
    virtualAnchorRef.current = radarPopoverAnchorFromRect(rect);
  };
  const collisionBoundary = triggerRef.current?.closest<HTMLElement>('[data-radar-surface]')
    ?? undefined;

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverAnchor virtualRef={virtualAnchorRef} />
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={triggerLabel}
          aria-expanded={open}
          aria-controls={open ? actionBarId : undefined}
          onClick={handleTriggerClick}
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={8}
        collisionBoundary={collisionBoundary}
        role="dialog"
        aria-label={m.radar.quickActions(target.repositoryDisplayName)}
        className="gsm-radar-popover w-[280px] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstActionRef.current?.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => handleQuickActionKeyDown(event, {
          pending,
          onToggleStar: toggleStar,
          onFavorite: favorite,
          tagInput: tagInputRef.current,
        })}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <a
            href={target.repositoryHtmlUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate rounded-sm font-mono text-xs font-semibold text-foreground underline underline-offset-2 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={stopQuickActionPropagation}
            onClick={stopQuickActionPropagation}
          >
            {target.repositoryDisplayName}
          </a>
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            <Star className="size-3" aria-hidden="true" />
            {target.displayedStargazerCount.toLocaleString(locale)}
          </span>
        </div>
        <div id={actionBarId} className="grid gap-0">
          <button
            ref={firstActionRef}
            type="button"
            data-radar-action-stop
            disabled={pending}
            onClick={toggleStar}
            className={cn('flex h-[30px] w-full items-center gap-2 px-3 text-left text-xs text-foreground outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-60', {
              'text-favorite': target.viewerHasStarred,
            })}
          >
            {pendingAction?.kind === 'star' && pending ? (
              <Spinner className="size-3.5" />
            ) : target.viewerHasStarred ? (
              <Star className="size-3.5 fill-current" aria-hidden="true" />
            ) : (
              <Star className="size-3.5" aria-hidden="true" />
            )}
            <span className="flex-1">{target.viewerHasStarred ? m.radar.unstarOnGitHub : m.radar.starOnGitHub}</span>
            <kbd className="font-mono text-[10px] text-muted-foreground">S</kbd>
          </button>
          <button
            type="button"
            data-radar-action-stop
            aria-pressed={target.favorite}
            disabled={pending}
            onClick={favorite}
            className={cn('flex h-[30px] w-full items-center gap-2 px-3 text-left text-xs text-foreground outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-60', {
              'text-favorite': target.favorite,
            })}
          >
            {pendingAction?.kind === 'favorite' && pending ? (
              <Spinner className="size-3.5" />
            ) : (
              <Heart className={cn('size-3.5', { 'fill-current': target.favorite })} aria-hidden="true" />
            )}
            <span className="flex-1">{m.radar.favorite}</span>
            <kbd className="font-mono text-[10px] text-muted-foreground">F</kbd>
          </button>
          <div className="border-t border-border px-3 py-2.5">
            {target.tags.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-[10px] font-medium text-foreground">
                  {m.radar.repositoryTags}
                </p>
                <div className="flex flex-wrap gap-1" aria-label={m.radar.repositoryTags}>
                  {target.tags.map((tagName) => (
                    <span key={tagName} className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                      {tagName}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-[9px] leading-3 text-muted-foreground">
                  {m.radar.repositoryTagScope}
                </p>
              </div>
            )}
            <div className="relative">
              <Tag className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                ref={tagInputRef}
                data-radar-action-stop
                value={tagDraft}
                disabled={pending}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addTag(tagDraft);
                  }
                }}
                placeholder={m.radar.addTag}
                aria-label={m.radar.addTag}
                autoComplete="off"
                spellCheck={false}
                className="h-8 pl-7 pr-7 text-xs"
              />
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground">T</kbd>
            </div>
            {!target.viewerHasStarred && (
              <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Star className="size-3" aria-hidden="true" />
                {m.radar.addingTagStars}
              </p>
            )}
            {availableSuggestions.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 text-[10px] text-muted-foreground">
                  {m.radar.suggestedTags}
                </p>
                <div className="flex flex-wrap gap-1" aria-label={m.radar.suggestedTags}>
                  {availableSuggestions.map((tagName) => (
                    <button
                      key={tagName}
                      type="button"
                      data-radar-action-stop
                      disabled={pending}
                      onClick={() => { void addTag(tagName); }}
                      className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                    >
                      {tagName}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {actionError?.repositoryKey === target.repositoryKey && (
              <p role="alert" className="mt-2 text-[10px] leading-4 text-destructive">
                {m.radar.actionFailed(actionError.message)}
              </p>
            )}
          </div>
          <div className="border-t border-border bg-muted/35 px-3 py-1.5 text-center font-mono text-[9px] text-muted-foreground">
            {m.radar.keyboardHint}
          </div>
        </div>
        <span id={statusId} className="sr-only">
          {target.viewerHasStarred ? m.radar.unstarOnGitHub : m.radar.starOnGitHub}
        </span>
      </PopoverContent>
    </Popover>
  );
}
function ActorChip({
  login,
  avatarUrl,
  className,
}: {
  login: string;
  avatarUrl: string | null;
  className?: string;
}) {
  const { m } = useI18n();
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const githubAvatarUrl = `https://github.com/${encodeURIComponent(login)}.png?size=48`;
  const displayedAvatarUrl = avatarUrl && failedAvatarUrl !== avatarUrl
    ? avatarUrl
    : failedAvatarUrl !== githubAvatarUrl
      ? githubAvatarUrl
      : null;
  const label = m.radar.openActorProfile(login);
  return (
    <a
      href={`https://github.com/${encodeURIComponent(login)}`}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className={cn(
        'inline-grid size-6 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-[10px] font-semibold uppercase text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {displayedAvatarUrl ? (
        <img
          src={displayedAvatarUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedAvatarUrl(displayedAvatarUrl)}
        />
      ) : (
        login.slice(0, 1)
      )}
    </a>
  );
}

function RepositoryMetadata({
  language,
  languageColor,
  stars,
  inLibrary,
  tags,
}: {
  language: string | null;
  languageColor: string | null;
  stars: number;
  inLibrary: boolean;
  tags: readonly string[];
}) {
  const { m, locale } = useI18n();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {language && (
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ backgroundColor: languageColor ?? undefined }} aria-hidden="true" />
          {language}
        </span>
      )}
      <span className="inline-flex items-center gap-1 font-mono tabular-nums">
        <Star className="size-3" aria-hidden="true" />
        {stars.toLocaleString(locale)}
      </span>
      {inLibrary && (
        <span className="inline-flex items-center gap-1 text-favorite">
          <Star className="size-3 fill-current" aria-hidden="true" />
          {m.radar.inLibrary}
        </span>
      )}
      {tags.slice(0, 2).map((tagName) => (
        <span key={tagName} className="rounded-md border border-border bg-muted px-1.5 py-px text-[10px] text-foreground">
          {tagName}
        </span>
      ))}
      {tags.length > 2 && (
        <span className="rounded-md border border-border bg-muted px-1.5 py-px text-[10px] text-foreground">
          +{tags.length - 2}
        </span>
      )}
    </span>
  );
}

function RadarFeedRow({
  searchResult,
  open,
  onOpenChange,
  pendingAction,
  actionError,
  onStar,
  onUnstar,
  onSetFavorite,
  onAddTag,
  onDismiss,
  onMarkSeen,
}: {
  searchResult: RadarActivitySearchResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingAction: RadarPendingAction | null;
  actionError: RadarActionError | null;
  onStar: RadarSurfaceProps['onStar'];
  onUnstar: RadarSurfaceProps['onUnstar'];
  onSetFavorite: RadarSurfaceProps['onSetFavorite'];
  onAddTag: RadarSurfaceProps['onAddTag'];
  onDismiss: () => void;
  onMarkSeen: RadarSurfaceProps['onMarkSeen'];
}) {
  const { m, locale } = useI18n();
  const { activity, actorRanges, repositoryRanges } = searchResult;
  const dismissing = pendingAction?.kind === 'dismiss'
    && pendingAction.repositoryKey === activity.repositoryKey;
  const target: RadarRepositoryTarget = activity;
  const unseen = !activity.seen;
  const seenIntent = useRadarSeenIntent({
    activityIds: activity.source === 'following' && unseen ? [activity.id] : [],
    enabled: activity.source === 'following' && unseen,
    onMarkSeen,
  });
  return (
    <div
      className="gsm-radar-seen-row flex min-w-0 items-center gap-1 px-1.5"
      data-radar-row={activity.id}
      data-radar-unseen={unseen ? 'true' : 'false'}
      onBlurCapture={seenIntent.onBlurCapture}
      onClickCapture={seenIntent.onClickCapture}
      onFocusCapture={seenIntent.onFocusCapture}
      onMouseEnter={seenIntent.onMouseEnter}
      onMouseLeave={seenIntent.onMouseLeave}
      onPointerCancelCapture={seenIntent.onPointerCancelCapture}
      onPointerDownCapture={seenIntent.onPointerDownCapture}
    >
      {unseen && <span className="sr-only">{m.radar.unseenActivity}</span>}
      <ActorChip login={activity.actorLogin} avatarUrl={activity.actorAvatarUrl} />
      <div className="relative flex min-h-[58px] min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left">
        <RadarQuickActions
          triggerLabel={m.radar.quickActions(activity.repositoryDisplayName)}
          target={target}
          open={open}
          onOpenChange={onOpenChange}
          pendingAction={pendingAction}
          actionError={actionError}
          onStar={onStar}
          onUnstar={onUnstar}
          onSetFavorite={onSetFavorite}
          onAddTag={onAddTag}
        />
        <span className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-2.5">
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
              <span className="shrink-0 font-semibold text-foreground">
                <SearchMatchText text={activity.actorLogin} ranges={actorRanges} />
              </span>
              <span className="shrink-0 text-muted-foreground">{m.radar.actorStarred}</span>
              <RepositoryOwnerAvatar
                fullName={activity.repositoryDisplayName}
                url={activity.repositoryOwnerAvatarUrl ?? null}
                className="size-4"
              />
              <a
                href={activity.repositoryHtmlUrl}
                target="_blank"
                rel="noreferrer"
                className="pointer-events-auto min-w-0 truncate rounded-sm font-mono font-semibold text-foreground underline underline-offset-2 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                onPointerDown={stopQuickActionPropagation}
                onClick={stopQuickActionPropagation}
              >
                <SearchMatchText text={activity.repositoryDisplayName} ranges={repositoryRanges} />
              </a>
            </span>
            <RepositoryMetadata
              language={activity.repositoryLanguage}
              languageColor={activity.repositoryLanguageColor}
              stars={activity.displayedStargazerCount}
              inLibrary={activity.viewerHasStarred}
              tags={activity.tags}
            />
          </span>
          <time
            dateTime={activity.starredAt}
            title={formatAbsoluteTime(activity.starredAt, locale) ?? undefined}
            className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground max-[520px]:hidden"
          >
            {formatRadarRelativeTime(activity.starredAt, locale)}
          </time>
        </span>
      </div>
      {activity.source === 'following' && (
        <button
          type="button"
          data-radar-dismiss
          disabled={dismissing}
          aria-label={m.radar.dismissActivity(activity.actorLogin, activity.repositoryDisplayName)}
          title={m.radar.dismissActivity(activity.actorLogin, activity.repositoryDisplayName)}
          onMouseEnter={seenIntent.clear}
          onClick={onDismiss}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground opacity-40 outline-none transition-opacity hover:bg-muted hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {dismissing ? <Spinner className="size-3.5" /> : <X className="size-3.5" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

function RadarProjectTimeline({
  activities,
  actorRangesByLogin,
}: {
  activities: readonly RadarActivityPresentation[];
  actorRangesByLogin: RadarProjectSearchResult['actorRangesByLogin'];
}) {
  const { m, locale } = useI18n();
  return (
    <div className="min-w-0" data-radar-project-timeline>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {m.radar.followedStarTimeline}
      </p>
      <ol className="mt-1.5 grid gap-1.5 p-0">
        {activities.map((activity) => (
          <li key={activity.id} className="flex min-w-0 items-baseline gap-x-2 text-[11.5px] text-muted-foreground">
            <a
              href={`https://github.com/${encodeURIComponent(activity.actorLogin)}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-sm font-mono text-[11px] font-semibold text-foreground underline decoration-muted-foreground/45 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SearchMatchText
                text={activity.actorLogin}
                ranges={actorRangesByLogin[activity.actorLogin.toLocaleLowerCase('en-US')] ?? []}
              />
            </a>
            <span className="min-w-0 truncate">{m.radar.starredThisRepository}</span>
            <time
              dateTime={activity.starredAt}
              title={formatAbsoluteTime(activity.starredAt, locale) ?? undefined}
              className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
            >
              {formatRadarRelativeTime(activity.starredAt, locale)}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RadarProjectActionBar({
  project,
  composerOpen,
  composerId,
  tagButtonRef,
  pendingAction,
  onStar,
  onUnstar,
  onSetFavorite,
  onToggleComposer,
}: {
  project: RadarProjectPresentation;
  composerOpen: boolean;
  composerId: string;
  tagButtonRef: RefObject<HTMLButtonElement>;
  pendingAction: RadarPendingAction | null;
  onStar: RadarSurfaceProps['onStar'];
  onUnstar: RadarSurfaceProps['onUnstar'];
  onSetFavorite: RadarSurfaceProps['onSetFavorite'];
  onToggleComposer: () => void;
}) {
  const { m } = useI18n();
  const pending = pendingAction?.repositoryKey === project.repositoryKey;
  const starPending = pending && pendingAction?.kind === 'star';
  const favoritePending = pending && pendingAction?.kind === 'favorite';
  const toggleStar = () => {
    if (pending) return;
    const operation = project.viewerHasStarred ? onUnstar : onStar;
    void operation(project.repositoryKey, project.repositoryFullName);
  };
  const favorite = () => {
    if (!pending) {
      void onSetFavorite(project.repositoryKey, project.repositoryFullName, !project.favorite);
    }
  };

  return (
    <div
      role="group"
      aria-label={m.radar.projectActions(project.repositoryDisplayName)}
      data-radar-project-actions
      className="grid grid-cols-4 gap-1.5 border-t border-border bg-card px-3 py-2 max-[520px]:grid-cols-2 max-[520px]:px-2.5"
    >
      <button
        type="button"
        data-radar-project-action="star"
        disabled={pending}
        aria-label={project.viewerHasStarred ? m.radar.unstarOnGitHub : m.radar.starOnGitHub}
        onClick={toggleStar}
        className={cn('flex min-w-0 h-[30px] items-center justify-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-2 text-[11.5px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70 max-[520px]:whitespace-normal max-[520px]:leading-4', {
          'border-favorite/40 text-favorite': project.viewerHasStarred,
        })}
      >
        {starPending ? <Spinner className="size-3 shrink-0" /> : <Star className={cn('size-3 shrink-0', { 'fill-current': project.viewerHasStarred })} aria-hidden="true" />}
        <span className="min-w-0 truncate">{project.viewerHasStarred ? m.radar.unstarOnGitHub : m.radar.starOnGitHub}</span>
      </button>
      <button
        type="button"
        data-radar-project-action="favorite"
        aria-pressed={project.favorite}
        disabled={pending}
        onClick={favorite}
        className={cn('flex min-w-0 h-[30px] items-center justify-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-2 text-[11.5px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 max-[520px]:whitespace-normal max-[520px]:leading-4', {
          'border-favorite/40 bg-background text-favorite': project.favorite,
        })}
      >
        {favoritePending ? <Spinner className="size-3 shrink-0" /> : <Heart className={cn('size-3 shrink-0', { 'fill-current': project.favorite })} aria-hidden="true" />}
        <span className="min-w-0 truncate">{m.radar.favorite}</span>
      </button>
      <button
        ref={tagButtonRef}
        type="button"
        data-radar-project-action="tag"
        aria-expanded={composerOpen}
        aria-controls={composerOpen ? composerId : undefined}
        onClick={onToggleComposer}
        className="flex min-w-0 h-[30px] items-center justify-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-2 text-[11.5px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-[520px]:whitespace-normal max-[520px]:leading-4"
      >
        <Tag className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{m.radar.addTagAction}</span>
      </button>
      <a
        href={project.repositoryHtmlUrl}
        target="_blank"
        rel="noreferrer"
        data-radar-project-action="open"
        className="flex min-w-0 h-[30px] items-center justify-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-2 text-[11.5px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-[520px]:whitespace-normal max-[520px]:leading-4"
      >
        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{m.radar.openRepository}</span>
      </a>
    </div>
  );
}

function RadarProjectRow({
  searchResult,
  open,
  onOpenChange,
  pendingAction,
  actionError,
  onStar,
  onUnstar,
  onSetFavorite,
  onAddTag,
  onDismiss,
  onMarkSeen,
}: {
  searchResult: RadarProjectSearchResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingAction: RadarPendingAction | null;
  actionError: RadarActionError | null;
  onStar: RadarSurfaceProps['onStar'];
  onUnstar: RadarSurfaceProps['onUnstar'];
  onSetFavorite: RadarSurfaceProps['onSetFavorite'];
  onAddTag: RadarSurfaceProps['onAddTag'];
  onDismiss: () => void;
  onMarkSeen: RadarSurfaceProps['onMarkSeen'];
}) {
  const { m, locale } = useI18n();
  const { project, actorRangesByLogin, repositoryRanges } = searchResult;
  const [composerOpen, setComposerOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [descriptionClipped, setDescriptionClipped] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const tagButtonRef = useRef<HTMLButtonElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const composerWasOpenRef = useRef(false);
  const rowId = useId();
  const inspectorId = useId();
  const composerId = useId();
  const dismissing = pendingAction?.kind === 'dismiss'
    && pendingAction.repositoryKey === project.repositoryKey;
  const pending = pendingAction?.repositoryKey === project.repositoryKey;
  const availableSuggestions = useMemo(() => {
    const applied = new Set(project.tags.map((tagName) => tagName.toLocaleLowerCase('en-US')));
    const query = tagDraft.trim().toLocaleLowerCase('en-US');
    return project.suggestedTags.filter((tagName) => (
      !applied.has(tagName.toLocaleLowerCase('en-US'))
      && (!query || tagName.toLocaleLowerCase('en-US').includes(query))
    )).slice(0, 8);
  }, [project.suggestedTags, project.tags, tagDraft]);
  const stackActivities = project.activities.length > 4
    ? project.activities.slice(0, 3)
    : project.activities;
  const extraActors = project.activities.length - stackActivities.length;
  const actorSummary = project.activities.length > 3
    ? project.activities.slice(0, 2)
    : project.activities;
  const projectUnseen = project.activities.some((activity) => !activity.seen);
  const unseenFollowingActivityIds = project.activities
    .filter((activity) => activity.source === 'following' && !activity.seen)
    .map((activity) => activity.id);
  const seenIntent = useRadarSeenIntent({
    activityIds: unseenFollowingActivityIds,
    enabled: unseenFollowingActivityIds.length > 0,
    onMarkSeen,
  });

  useEffect(() => {
    if (!open) {
      setComposerOpen(false);
      setTagDraft('');
      composerWasOpenRef.current = false;
      return;
    }
    if (composerOpen) {
      tagInputRef.current?.focus({ preventScroll: true });
    } else if (composerWasOpenRef.current) {
      tagButtonRef.current?.focus({ preventScroll: true });
    }
    composerWasOpenRef.current = composerOpen;
  }, [composerOpen, open]);

  const addTag = async (raw: string) => {
    const tagName = raw.trim();
    if (!tagName || pending) return;
    const result = await onAddTag(project.repositoryKey, project.repositoryFullName, tagName);
    if (result !== null) setTagDraft('');
  };

  const handleInspectorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (composerOpen) {
      setComposerOpen(false);
      return;
    }
    onOpenChange(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (composerOpen) {
        setComposerOpen(false);
        return;
      }
      onOpenChange(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [composerOpen, onOpenChange, open]);

  useLayoutEffect(() => {
    const summary = summaryRef.current;
    if (!open || !summary) return;
    const measure = () => {
      if (summary.clientWidth === 0) return;
      const clipped = summary.scrollWidth > summary.clientWidth + 1
        || summary.scrollHeight > summary.clientHeight + 1;
      setDescriptionClipped((current) => current === clipped ? current : clipped);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(summary);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, project.repositoryDescription]);

  return (
    <div className="relative min-w-0" data-radar-project={project.repositoryKey}>
      <div
        className="gsm-radar-seen-row group relative min-w-0"
        data-radar-project-row
        data-radar-unseen={projectUnseen ? 'true' : 'false'}
        onBlurCapture={seenIntent.onBlurCapture}
        onClickCapture={seenIntent.onClickCapture}
        onFocusCapture={seenIntent.onFocusCapture}
        onMouseEnter={seenIntent.onMouseEnter}
        onMouseLeave={seenIntent.onMouseLeave}
        onPointerCancelCapture={seenIntent.onPointerCancelCapture}
        onPointerDownCapture={seenIntent.onPointerDownCapture}
      >
      {projectUnseen && <span className="sr-only">{m.radar.unseenProject}</span>}
      <button
        ref={triggerRef}
        type="button"
        id={rowId}
        aria-expanded={open}
        aria-controls={inspectorId}
        aria-label={open
          ? m.radar.collapseProject(project.repositoryDisplayName)
          : m.radar.expandProject(project.repositoryDisplayName)}
        onClick={() => onOpenChange(!open)}
        data-radar-project-trigger
        className={cn('absolute inset-0 z-0 cursor-pointer rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', {
          'bg-muted/45': open,
        })}
      />
      <div className="pointer-events-none relative z-10 flex min-h-[90px] min-w-0 items-start gap-4 px-2.5 py-[13px] max-[520px]:gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <RepositoryOwnerAvatar
              fullName={project.repositoryDisplayName}
              url={project.repositoryOwnerAvatarUrl}
              className="size-4"
            />
            <a
              href={project.repositoryHtmlUrl}
              target="_blank"
              rel="noreferrer"
              className="pointer-events-auto min-w-0 truncate rounded-sm text-[13.5px] font-semibold tracking-[-0.01em] text-foreground underline decoration-muted-foreground/45 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SearchMatchText text={project.repositoryDisplayName} ranges={repositoryRanges} />
            </a>
            {project.viewerHasStarred && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-favorite/30 bg-favorite/10 px-2 py-px text-[10px] font-semibold text-favorite">
                <Star className="size-2.5 fill-current" aria-hidden="true" />
                {m.radar.inLibrary}
              </span>
            )}
            {project.favorite && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-favorite/35 px-2 py-px text-[10px] font-semibold text-favorite">
                <Heart className="size-2.5 fill-current" aria-hidden="true" />
                {m.radar.favorite}
              </span>
            )}
          </div>
          <p
            ref={summaryRef}
            className="mt-1 max-w-[620px] truncate text-xs leading-4 text-muted-foreground"
          >
            {project.repositoryDescription || '—'}
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <RepositoryMetadata
              language={project.repositoryLanguage}
              languageColor={project.repositoryLanguageColor}
              stars={project.displayedStargazerCount}
              inLibrary={false}
              tags={project.tags}
            />
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {m.radar.followedStars(project.activityCount)} · {m.radar.latest} {formatRadarRelativeTime(project.latestStarredAt, locale)}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 flex-col items-end pr-7 max-[520px]:max-w-[34%]">
          <div
            className="flex max-w-full items-center justify-end pl-1"
            data-radar-project-avatar-stack
          >
            {stackActivities.map((activity, index) => (
              <span
                key={`${activity.id}-${index}`}
                className="gsm-radar-project-avatar-slot"
                data-radar-project-avatar-slot
              >
                <ActorChip
                  login={activity.actorLogin}
                  avatarUrl={activity.actorAvatarUrl}
                  className="gsm-radar-project-avatar pointer-events-auto size-[var(--gsm-radar-project-avatar-size)] border-2 border-card shadow-sm"
                />
              </span>
            ))}
            {extraActors > 0 && (
              <span className="gsm-radar-project-avatar-slot" data-radar-project-avatar-slot>
                <span
                  title={m.radar.followedStars(extraActors)}
                  aria-label={m.radar.followedStars(extraActors)}
                  data-radar-project-avatar-overflow
                  className="gsm-radar-project-avatar-more grid size-[var(--gsm-radar-project-avatar-size)] place-items-center rounded-full border-2 border-card bg-muted text-[10px] font-medium text-muted-foreground"
                >
                  +{extraActors}
                </span>
              </span>
            )}
          </div>
          <div data-radar-project-actor-summary className="mt-1 flex max-w-[260px] items-center justify-end gap-1 truncate font-mono text-[11px] tabular-nums text-muted-foreground max-[760px]:hidden">
            {actorSummary.map((activity, index) => (
              <span key={`${activity.id}-summary`} className="truncate">
                {index > 0 && <span aria-hidden="true"> · </span>}
                <SearchMatchText
                  text={activity.actorLogin}
                  ranges={actorRangesByLogin[activity.actorLogin.toLocaleLowerCase('en-US')] ?? []}
                />{' '}{formatRadarRelativeTime(activity.starredAt, locale)}
              </span>
            ))}
            {project.activities.length > 3 && <span className="shrink-0"> · +{project.activities.length - 2}</span>}
          </div>
        </div>
      </div>
      {project.activityIds.length > 0 && (
        <button
          type="button"
          data-radar-dismiss
          disabled={dismissing}
          aria-label={m.radar.dismissProject(project.repositoryDisplayName)}
          title={m.radar.dismissProject(project.repositoryDisplayName)}
          onMouseEnter={seenIntent.clear}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          className="absolute right-2 top-3.5 z-20 grid size-4 place-items-center rounded-sm text-muted-foreground opacity-40 outline-none transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {dismissing ? <Spinner className="size-3" /> : <X className="size-3" aria-hidden="true" />}
        </button>
      )}
      </div>
      <div
        id={inspectorId}
        role="region"
        aria-labelledby={rowId}
        aria-hidden={!open}
        aria-busy={pending}
        data-open={open ? 'true' : 'false'}
        data-radar-project-inspector
        className={cn('gsm-radar-project-inspector', {
          'gsm-radar-project-inspector-open': open,
        })}
        onKeyDown={handleInspectorKeyDown}
        {...(!open ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>) : {})}
      >
        <div className="min-h-0 overflow-hidden border-y border-border bg-muted/45">
          <div className="min-w-0 px-3 py-2.5 max-[520px]:px-2.5">
            <div className={cn('min-w-0', {
              'pb-2.5': descriptionClipped,
            })}>
              {descriptionClipped && (
                <p data-radar-full-description className="text-xs leading-4 text-foreground/85">
                  {project.repositoryDescription}
                </p>
              )}
              <RadarProjectTimeline
                activities={project.activities}
                actorRangesByLogin={actorRangesByLogin}
              />
            </div>
          </div>
          <RadarProjectActionBar
            project={project}
            composerOpen={composerOpen}
            composerId={composerId}
            tagButtonRef={tagButtonRef}
            pendingAction={pendingAction}
            onStar={onStar}
            onUnstar={onUnstar}
            onSetFavorite={onSetFavorite}
            onToggleComposer={() => setComposerOpen((current) => !current)}
          />
          {composerOpen && (
            <div
              id={composerId}
              data-radar-project-composer
              className="grid gap-1.5 border-t border-border bg-muted/20 px-3 py-2.5 max-[520px]:px-2.5"
            >
              <div className="flex min-w-0 items-baseline justify-between gap-2 font-mono text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate">{m.radar.addTagAction}</span>
                <span className="shrink-0">{m.radar.tagComposerHint}</span>
              </div>
              {project.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1" aria-label={m.radar.suggestedTags}>
                  {project.tags.map((tagName) => (
                    <span key={tagName} className="rounded-md border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-foreground">
                      {tagName}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">{m.radar.noTags}</p>
              )}
              <label className="flex h-[29px] min-w-0 items-center gap-1.5 rounded-md border border-border bg-card/70 px-2 text-muted-foreground focus-within:border-muted-foreground/65">
                <Tag className="size-3 shrink-0" aria-hidden="true" />
                <span className="sr-only">{m.radar.addTagAction}</span>
                <Input
                  ref={tagInputRef}
                  type="text"
                  value={tagDraft}
                  disabled={pending}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void addTag(tagDraft);
                  }}
                  placeholder={m.radar.addTag}
                  aria-label={m.radar.addTagAction}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-[29px] min-w-0 flex-1 border-0 bg-transparent px-0 font-mono text-xs text-foreground shadow-none outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0"
                />
              </label>
              {!project.viewerHasStarred && (
                <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Star className="size-3" aria-hidden="true" />
                  {m.radar.addingTagStars}
                </p>
              )}
              {availableSuggestions.length > 0 && (
                <div className="flex min-w-0 flex-wrap gap-1" aria-label={m.radar.suggestedTags}>
                  {availableSuggestions.map((tagName) => (
                    <button
                      key={tagName}
                      type="button"
                      disabled={pending}
                      onClick={() => { void addTag(tagName); }}
                      className="rounded-md border border-transparent bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground outline-none hover:border-border hover:bg-card hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                    >
                      {tagName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {actionError?.repositoryKey === project.repositoryKey && (
            <p role="alert" className="border-t border-border px-3 py-1.5 text-[10px] leading-4 text-destructive max-[520px]:px-2.5">
              {m.radar.actionFailed(actionError.message)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function recommendationMatchesQuery(
  recommendation: RecommendationRecord,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLocaleLowerCase('en-US');
  if (!query) return true;
  return [
    recommendation.repositoryFullName,
    recommendation.description,
    recommendation.language ?? '',
    recommendation.topics.join(' '),
    recommendation.reason.seedRepositoryFullName,
    recommendation.reason.value,
  ].some((value) => value.toLocaleLowerCase('en-US').includes(query));
}

function RecommendationOwnerAvatar({ owner }: { owner: string }) {
  const [failed, setFailed] = useState(false);
  const avatarUrl = `https://github.com/${encodeURIComponent(owner)}.png?size=64`;
  const fallback = repositoryAvatarFallback(owner);
  return (
    <span
      data-avatar-color={fallback.color}
      className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-border text-xs font-semibold uppercase"
    >
      {failed ? (
        <span className="gsm-repository-avatar-fallback grid size-full place-items-center text-primary-foreground dark:text-background">
          {fallback.initial}
        </span>
      ) : (
        <img
          src={avatarUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function RecommendationRow({
  recommendation,
  pendingAction,
  actionError,
  onStar,
  onIgnore,
}: {
  recommendation: RecommendationRecord;
  pendingAction: RadarPendingAction | null;
  actionError: RadarActionError | null;
  onStar: RadarSurfaceProps['onStar'];
  onIgnore: RadarSurfaceProps['onIgnore'];
}) {
  const { m, locale } = useI18n();
  const starPending = pendingAction?.kind === 'star'
    && pendingAction.repositoryKey === recommendation.repositoryKey;
  const ignorePending = pendingAction?.kind === 'ignore'
    && pendingAction.repositoryKey === recommendation.repositoryKey;
  const actionFailed = actionError?.repositoryKey === recommendation.repositoryKey;
  return (
    <article
      className="flex min-w-0 items-start gap-3 px-3.5 py-3 max-[520px]:px-2.5"
      data-recommendation-row={recommendation.repositoryKey}
    >
      <RecommendationOwnerAvatar owner={recommendation.owner} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={recommendation.repositoryHtmlUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate rounded-sm font-mono text-[13px] font-semibold text-foreground underline underline-offset-2 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {recommendation.repositoryFullName}
          </a>
          {recommendation.topics.slice(0, 2).map((topic) => (
            <span key={topic} className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-foreground">
              {topic}
            </span>
          ))}
          {recommendation.topics.length > 2 && (
            <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-px text-[10px] text-foreground">
              +{recommendation.topics.length - 2}
            </span>
          )}
        </div>
        {recommendation.description && (
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-muted-foreground">
            {recommendation.description}
          </p>
        )}
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
          {recommendation.language && <span>{recommendation.language}</span>}
          <span className="inline-flex items-center gap-1 font-mono tabular-nums">
            <Star className="size-3" aria-hidden="true" />
            {recommendation.stargazerCount.toLocaleString(locale)}
          </span>
          <span className="min-w-0 truncate text-foreground/80">
            {m.radar.becauseYouStarred(recommendation.reason.seedRepositoryFullName)}
          </span>
          <span className="rounded-md bg-muted px-1.5 py-px font-mono text-[9.5px]">
            {m.radar.recommendationReason(recommendation.reason.kind, recommendation.reason.value)}
          </span>
        </div>
        {actionFailed && (
          <p className="mt-1 text-[10px] leading-4 text-destructive" role="alert">
            {m.radar.actionFailed(actionError?.message ?? '')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[30px] gap-1.5 px-2.5 text-[11px]"
          disabled={starPending || ignorePending}
          aria-label={m.radar.starRecommendation(recommendation.repositoryFullName)}
          onClick={() => { void onStar(recommendation.repositoryKey, recommendation.repositoryFullName); }}
        >
          {starPending ? <Spinner className="size-3" /> : <Star className="size-3" aria-hidden="true" />}
          <span className="max-[520px]:hidden">{m.radar.recommendationStarAction}</span>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-[30px] text-muted-foreground hover:text-destructive"
              disabled={starPending || ignorePending}
              aria-label={m.radar.ignoreRecommendation(recommendation.repositoryFullName)}
              onClick={() => { void onIgnore(recommendation.repositoryKey, recommendation.repositoryFullName); }}
            >
              {ignorePending ? <Spinner className="size-3.5" /> : <Ban className="size-3.5" aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {m.radar.ignoreRecommendation(recommendation.repositoryFullName)}
            {' · '}
            {m.radar.recommendationIgnoreHint}
          </TooltipContent>
        </Tooltip>
      </div>
    </article>
  );
}

function ForYouSurface({
  recommendations,
  discoverView,
  loading,
  refreshing,
  error,
  pendingAction,
  actionError,
  onDiscoverViewChange,
  onRefresh,
  onRetryQuery,
  onOpenOptions,
  onStar,
  onIgnore,
  onRestoreIgnored,
}: {
  recommendations: RecommendationQueryResponse | null;
  discoverView: RadarDiscoverView;
  loading: boolean;
  refreshing: boolean;
  error: 'query' | 'refresh' | null;
  pendingAction: RadarPendingAction | null;
  actionError: RadarActionError | null;
  onDiscoverViewChange: (view: RadarDiscoverView) => void;
  onRefresh: () => void;
  onRetryQuery: () => void;
  onOpenOptions: () => void;
  onStar: RadarSurfaceProps['onStar'];
  onIgnore: RadarSurfaceProps['onIgnore'];
  onRestoreIgnored: RadarSurfaceProps['onRestoreIgnored'];
}) {
  const { m, locale } = useI18n();
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const ignored = recommendations?.ignored ?? [];
  const [query, setQuery] = useState('');
  const searchInput = useImeBufferedInput(query, setQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(
    () => (recommendations?.recommendations ?? [])
      .filter((recommendation) => recommendationMatchesQuery(recommendation, query)),
    [query, recommendations?.recommendations],
  );
  const status = recommendations?.status;
  const state = status?.state;
  const snapshotAt = formatAbsoluteTime(state?.lastSuccessfulAt ?? null, locale);
  const refreshDisabled = loading || refreshing || status?.snapshotStatus === 'cooldown'
    || status?.snapshotStatus === 'not_configured';
  const ignoredSection = ignored.length > 0 ? (
    <div className="border-t border-border/70" data-radar-ignored-section>
      <button
        type="button"
        aria-expanded={ignoredOpen}
        onClick={() => setIgnoredOpen((current) => !current)}
        className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-[10.5px] text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={cn('size-3 shrink-0 transition-transform', ignoredOpen && 'rotate-180')} aria-hidden="true" />
        <EyeOff className="size-3 shrink-0" aria-hidden="true" />
        <span>{m.radar.ignoredCount(ignored.length)}</span>
      </button>
      {ignoredOpen && (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {ignored.map((entry) => (
            <li key={entry.id} className="flex min-w-0 items-center justify-between gap-2 px-3.5 py-1.5">
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {entry.repositoryFullName}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-[26px] shrink-0 gap-1 px-2 text-[10.5px]"
                aria-label={m.radar.restoreIgnored(entry.repositoryFullName)}
                onClick={() => { void onRestoreIgnored(entry.repositoryKey); }}
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                <span>{m.radar.restoreIgnoredAction}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null;
  const savedWarning = status?.snapshotStatus === 'stale' || status?.snapshotStatus === 'cooldown'
    || status?.snapshotStatus === 'error' || error !== null;
  const dismissableWarning = savedWarning && !refreshing;
  const { dismissed: warningDismissed, dismiss: dismissWarning } = useDismissableNotice(dismissableWarning);
  const frame = (content: ReactNode) => (
    <section className="min-h-full bg-background" aria-label={m.radar.forYou} data-radar-surface data-radar-discover-view="for-you">
      <div className="gsm-z-sticky sticky top-0 border-b border-border bg-card" data-surface-command-bar="for-you">
        <SurfaceWorkCanvas variant="following" className="flex min-h-10 min-w-0 flex-wrap items-center gap-2 px-3.5 py-1.5">
          <RadarDiscoverSwitcher view={discoverView} onViewChange={onDiscoverViewChange} />
          <div className="relative min-w-0 flex-1 basis-64 max-[700px]:order-3 max-[700px]:basis-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              ref={searchInputRef}
              {...searchInput.inputProps}
              placeholder={`${m.radar.forYouSearchPlaceholder}…`}
              aria-label={m.radar.forYouSearchPlaceholder}
              className="h-[30px] bg-card pl-8 pr-8 text-xs shadow-none"
            />
            {query.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
                aria-label={m.radar.clearForYouSearch}
                onClick={() => { setQuery(''); searchInputRef.current?.focus(); }}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          <a
            href="https://github.com/trending"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            <span className="max-[620px]:hidden">{m.radar.openTrending}</span>
          </a>
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] gap-1.5 px-2.5 text-xs"
            disabled={refreshDisabled}
            onClick={onRefresh}
            aria-label={refreshing ? m.radar.recommendationsRefreshing : m.radar.recommendationsNewBatch}
          >
            {refreshing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            <span className="max-[520px]:hidden">{refreshing ? m.radar.refreshing : m.radar.recommendationsNewBatch}</span>
          </Button>
          <span role="status" aria-live="polite" className="sr-only">
            {query.trim() ? m.radar.forYouSearchResultCount(rows.length) : ''}
          </span>
        </SurfaceWorkCanvas>
      </div>
      {content}
    </section>
  );

  if (loading && !recommendations) {
    return frame(<RadarEmptyState icon={<Spinner className="size-4" />} title={m.radar.forYou} text={m.common.loading} />);
  }
  if (!recommendations) {
    return frame(<RadarEmptyState
      icon={<AlertTriangle className="size-4" />}
      title={m.radar.forYou}
      text={m.radar.recommendationsQueryFailed}
      tone="destructive"
      action={<Button onClick={onRetryQuery}>{m.radar.retry}</Button>}
    />);
  }
  if (!status?.hasMainToken) {
    return frame(<RadarEmptyState
      icon={<Settings2 className="size-4" />}
      title={m.radar.forYou}
      text={m.radar.configureMainToken}
      action={<Button onClick={onOpenOptions}>{m.radar.openOptions}</Button>}
    />);
  }
  if (status.snapshotStatus === 'error' && !state?.lastSuccessfulAt && recommendations.recommendations.length === 0) {
    return frame(<>
      <RadarEmptyState
        icon={<AlertTriangle className="size-4" />}
        title={m.radar.forYou}
        text={m.radar.recommendationsRefreshFailed}
        tone="destructive"
        action={<Button onClick={onRefresh} disabled={refreshing}>{m.radar.retry}</Button>}
      />
      {ignoredSection}
    </>);
  }
  if (status.snapshotStatus === 'never_loaded' && recommendations.recommendations.length === 0) {
    return frame(<>
      <RadarEmptyState
        icon={<Sparkles className="size-4" />}
        title={m.radar.recommendationsNeverLoadedTitle}
        text={m.radar.recommendationsNeverLoadedBody}
        action={<Button onClick={onRefresh} disabled={refreshing}>{m.radar.recommendationsRunFirstScan}</Button>}
      />
      {ignoredSection}
    </>);
  }
  if (recommendations.recommendations.length === 0) {
    if (status.snapshotStatus === 'cooldown') {
      const allowedAt = formatAbsoluteTime(state?.nextAllowedAt ?? null, locale);
      return frame(<>
        <RadarEmptyState
          icon={<Clock3 className="size-4" />}
          title={m.radar.forYou}
          text={allowedAt ? m.radar.recommendationsCooldownUntil(allowedAt) : m.radar.recommendationsStale}
          tone="warning"
        />
        {ignoredSection}
      </>);
    }
    return frame(<>
      <RadarEmptyState
        icon={<Check className="size-4" />}
        title={m.radar.recommendationsEmptyTitle}
        text={m.radar.recommendationsEmptyBody}
        tone="success"
      />
      {ignoredSection}
    </>);
  }
  return frame(<>
    {(dismissableWarning && warningDismissed) ? null : (
      <div
        className={cn('flex items-center gap-2 border-b px-3.5 py-1.5 text-[10.5px] leading-4', {
          'border-warning/25 bg-warning/[0.07] text-foreground/90': savedWarning,
          'border-border bg-card text-muted-foreground': !savedWarning,
        })}
        role="status"
        aria-live="polite"
        data-radar-saved-banner
      >
        <span className="min-w-0">{refreshing
          ? m.radar.recommendationsRefreshingSaved
          : savedWarning ? m.radar.recommendationsStale : m.radar.recommendationsFreshSummary(recommendations.recommendations.length)}</span>
        {snapshotAt && <span className="shrink-0 font-mono max-[520px]:hidden">{m.radar.recommendationsSnapshotAt(snapshotAt)}</span>}
        {dismissableWarning && (
          <button
            type="button"
            aria-label={m.common.close}
            onClick={dismissWarning}
            className="ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
    )}
    {rows.length === 0 && query.trim() ? (
      <RadarEmptyState icon={<Search className="size-4" />} title={m.radar.forYouSearchPlaceholder} text={m.radar.forYouSearchEmpty(query.trim())} />
    ) : (
      <SurfaceWorkCanvas variant="following" className="divide-y divide-border/70 py-1" data-radar-view="for-you">
        {rows.map((recommendation) => (
          <RecommendationRow
            key={recommendation.id}
            recommendation={recommendation}
            pendingAction={pendingAction}
            actionError={actionError}
            onStar={onStar}
            onIgnore={onIgnore}
          />
        ))}
        <SurfaceListEndMarker
          tone={savedWarning ? 'warning' : 'muted'}
          text={savedWarning ? m.radar.recommendationsListEndSaved(rows.length) : m.radar.recommendationsListEnd(rows.length)}
        />
      </SurfaceWorkCanvas>
    )}
    {ignoredSection}
  </>);
}

export function RadarSurface({
  result,
  recommendations,
  scrollElement,
  discoverView,
  loading,
  recommendationLoading,
  refreshing,
  recommendationRefreshing,
  error,
  recommendationError,
  actionError,
  pendingAction,
  view,
  sources,
  onDiscoverViewChange,
  onViewChange,
  onSourceEnabledChange,
  onRefresh,
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
}: RadarSurfaceProps) {
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
      <ForYouSurface
        recommendations={recommendations}
        discoverView={discoverView}
        loading={recommendationLoading}
        refreshing={recommendationRefreshing}
        error={recommendationError}
        pendingAction={pendingAction}
        actionError={actionError}
        onDiscoverViewChange={onDiscoverViewChange}
        onRefresh={onRefreshRecommendations}
        onRetryQuery={onRetryRecommendations}
        onOpenOptions={onOpenOptions}
        onStar={onStar}
        onIgnore={onIgnore}
        onRestoreIgnored={onRestoreIgnored}
      />
    );
  }

  const renderFrame = (content: ReactNode) => (
    <section ref={surfaceRef} className="min-h-full bg-background" aria-label={m.radar.title} data-radar-surface data-radar-discover-view="following">
      <RadarSurfaceCommandBar
        result={result}
        loading={loading}
        discoverView={discoverView}
        view={view}
        refreshing={refreshing}
        sources={sources}
        query={query}
        resultCount={visibleResultCount}
        onDiscoverViewChange={onDiscoverViewChange}
        onViewChange={onViewChange}
        onRefresh={onRefresh}
        onSourceEnabledChange={onSourceEnabledChange}
        onQueryChange={setQuery}
      />
      {content}
    </section>
  );
  if (loading && !result) {
    return renderFrame(
      <RadarEmptyState icon={<Spinner className="size-4" />} title={m.radar.title} text={m.common.loading} />,
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
      const allowedAt = formatAbsoluteTime(state?.nextAllowedAt ?? null, locale);
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
        text={m.radar.emptyBody}
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
          ? m.radar.listEndActivities(visibleResultCount)
          : m.radar.listEndProjects(visibleResultCount);
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
              {state.partialReasons.map(m.radar.partialReason).join(' ')}
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
          text={m.radar.filteredEmptyBody}
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
