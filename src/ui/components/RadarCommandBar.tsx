import { Clock3, RefreshCw, Search, Sparkles, User, Users, X } from 'lucide-react';
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { RadarActivitySource } from '@/radar/radar-model';
import type {
  RadarDiscoverView,
  RadarProps,
  RadarSourceFilters,
  RadarView,
} from '@/ui/radar-types';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Spinner } from '@/ui/shadcn/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import { DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS } from '@/preferences';

export function RadarEmptyState({
  icon,
  title,
  text,
  action,
  tone = 'muted',
}: {
  icon: ReactNode;
  title?: string;
  text?: string;
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
        {title && <p className="text-[13.5px] font-semibold text-foreground">{title}</p>}
        {text && <p className="max-w-lg text-xs leading-5 text-muted-foreground">{text}</p>}
        {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
      </div>
    </SurfaceWorkCanvas>
  );
}
export function RadarDiscoverSwitcher({
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

type RadarCommandBarActionsProps = Pick<
  RadarProps,
  'result' | 'loading' | 'refreshing' | 'fullReconciling' | 'onRefresh' | 'onFullReconcile' | 'sources'
> & {
  view: RadarView;
  onViewChange: (view: RadarView) => void;
  onSourceEnabledChange: (source: RadarActivitySource, enabled: boolean) => void;
};
export function RadarCommandBarActions({
  result,
  loading,
  view,
  refreshing,
  fullReconciling,
  sources,
  onViewChange,
  onRefresh,
  onFullReconcile,
  onSourceEnabledChange,
}: RadarCommandBarActionsProps) {
  const { m } = useI18n();
  const status = result?.status.snapshotStatus;
  const refreshDisabled = loading
    || refreshing
    || fullReconciling
    || result?.status.refreshing === true
    || result?.status.hasMainToken !== true
    || status === 'cooldown'
    || status === 'not_configured';
  const fullReconcileLabel = fullReconciling ? m.radar.fullReconciling : m.radar.fullReconcile;
  const fullReconcileHint = fullReconciling ? m.radar.fullReconciling : m.radar.fullReconcileHint;
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
      <RadarSourceToggleGroup sources={sources} onSourceEnabledChange={onSourceEnabledChange} />
      {status && status !== 'fresh' && status !== 'never_loaded' && status !== 'not_configured' && status !== 'stale' && (
        <span className={cn('max-[700px]:hidden rounded-full border px-2 py-px font-mono text-[10px]', {
          'border-warning/35 bg-warning/10 text-warning': status === 'partial' || status === 'cooldown',
          'border-destructive/35 bg-destructive/10 text-destructive': status === 'error',
        })}>
          {m.radar.statusLabel(status)}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-[30px] gap-1.5 px-2 text-xs"
            disabled={refreshDisabled}
            onClick={onFullReconcile}
            aria-label={fullReconcileLabel}
            aria-busy={fullReconciling}
            data-radar-action="full-reconcile"
          >
            {fullReconciling ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
            <span className="max-[620px]:hidden">{fullReconcileLabel}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{fullReconcileHint}</TooltipContent>
      </Tooltip>
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

type RadarCommandBarProps = RadarCommandBarActionsProps & {
  discoverView: RadarDiscoverView;
  query: string;
  resultCount: number;
  onDiscoverViewChange: (view: RadarDiscoverView) => void;
  onQueryChange: (query: string) => void;
};

export function RadarCommandBar({
  result,
  loading,
  discoverView,
  view,
  refreshing,
  fullReconciling,
  sources,
  query,
  resultCount,
  onDiscoverViewChange,
  onViewChange,
  onRefresh,
  onFullReconcile,
  onSourceEnabledChange,
  onQueryChange,
}: RadarCommandBarProps) {
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
          <span className="truncate">
            {m.radar.publicActivityOnly(
              result?.status.windowDays ?? DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
            )}
          </span>
        </span>
        <span className="min-w-0 flex-1 max-[700px]:hidden" />
        <RadarCommandBarActions
          result={result}
          loading={loading}
          view={view}
          refreshing={refreshing}
          fullReconciling={fullReconciling}
          sources={sources}
          onFullReconcile={onFullReconcile}
          onViewChange={onViewChange}
          onRefresh={onRefresh}
          onSourceEnabledChange={onSourceEnabledChange}
        />
      </SurfaceWorkCanvas>
    </div>
  );
}
