import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  Clock3,
  EyeOff,
  ExternalLink,
  Heart,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Tag,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type {
  RecommendationQueryResponse,
  RecommendationRecord,
} from '@/recommendations/recommendation-model';
import type {
  RadarActionError,
  RadarDiscoverView,
  RadarPendingAction,
  RadarProps,
} from '@/ui/radar-types';
import { formatRadarAbsoluteTime } from '@/ui/radar-time';
import { RadarDiscoverSwitcher, RadarEmptyState } from '@/ui/components/RadarCommandBar';
import { repositoryAvatarFallback } from '@/ui/components/RepositoryOwnerAvatar';
import { SurfaceListEndMarker } from '@/ui/components/SurfaceListEndMarker';
import { ManagerResourceLink, useManagerImage } from '@/ui/components/ManagerResource';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { useDismissableNotice } from '@/ui/hooks/use-dismissable-notice';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Spinner } from '@/ui/shadcn/spinner';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';

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
  const avatarUrl = useManagerImage({
    kind: 'actor-avatar',
    identity: owner,
    remoteUrl: `https://github.com/${encodeURIComponent(owner)}.png?size=64`,
  });
  const fallback = repositoryAvatarFallback(owner);
  return (
    <span
      data-avatar-color={fallback.color}
      className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-border text-xs font-semibold uppercase"
    >
      {failed || !avatarUrl ? (
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
  favorite,
  pendingAction,
  actionError,
  onStar,
  onIgnore,
  onSetFavorite,
  onAddTag,
}: {
  recommendation: RecommendationRecord;
  favorite: boolean;
  pendingAction: RadarPendingAction | null;
  actionError: RadarActionError | null;
  onStar: RadarProps['onStar'];
  onIgnore: RadarProps['onIgnore'];
  onSetFavorite: RadarProps['onSetFavorite'];
  onAddTag: RadarProps['onAddTag'];
}) {
  const { m, locale } = useI18n();
  const [tagDraft, setTagDraft] = useState('');
  const [tagOpen, setTagOpen] = useState(false);
  const pending = pendingAction?.repositoryKey === recommendation.repositoryKey;
  const starPending = pendingAction?.kind === 'star' && pending;
  const favoritePending = pendingAction?.kind === 'favorite' && pending;
  const tagPending = pendingAction?.kind === 'tag' && pending;
  const ignorePending = pendingAction?.kind === 'ignore' && pending;
  const actionFailed = actionError?.repositoryKey === recommendation.repositoryKey;
  const toggleFavorite = () => {
    if (pending) return;
    void onSetFavorite(
      recommendation.repositoryKey,
      recommendation.repositoryFullName,
      !favorite,
    );
  };
  const addTag = async (rawTag: string) => {
    const tag = rawTag.trim();
    if (!tag || pending) return;
    const result = await onAddTag(
      recommendation.repositoryKey,
      recommendation.repositoryFullName,
      tag,
    );
    if (result !== null) {
      setTagDraft('');
      setTagOpen(false);
    }
  };
  return (
    <article
      className="flex min-w-0 items-start gap-3 px-3.5 py-3 max-[520px]:px-2.5"
      data-recommendation-row={recommendation.repositoryKey}
    >
      <RecommendationOwnerAvatar owner={recommendation.owner} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <ManagerResourceLink
            resource={{
              kind: 'repository',
              fullName: recommendation.repositoryFullName,
              remoteUrl: recommendation.repositoryHtmlUrl,
            }}
            className="min-w-0 truncate rounded-sm font-mono text-[13px] font-semibold text-foreground underline underline-offset-2 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {recommendation.repositoryFullName}
          </ManagerResourceLink>
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
      <div className="flex shrink-0 items-center gap-1 max-[520px]:gap-0.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[30px] gap-1.5 px-2.5 text-[11px]"
          disabled={pending}
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
              className={cn('size-[30px] text-muted-foreground', favorite && 'text-favorite')}
              data-recommendation-action="favorite"
              data-active={favorite}
              aria-label={`${m.radar.favorite}: ${recommendation.repositoryFullName}`}
              aria-pressed={favorite}
              disabled={pending}
              onClick={() => { void toggleFavorite(); }}
            >
              {favoritePending
                ? <Spinner className="size-3.5" />
                : <Heart className={cn('size-3.5', favorite && 'fill-current')} aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.radar.favorite}</TooltipContent>
        </Tooltip>
        <Popover open={tagOpen} onOpenChange={setTagOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-[30px] text-muted-foreground"
              data-recommendation-action="tag"
              aria-label={`${m.radar.addTagAction}: ${recommendation.repositoryFullName}`}
              disabled={pending}
            >
              {tagPending ? <Spinner className="size-3.5" /> : <Tag className="size-3.5" aria-hidden="true" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-3" data-recommendation-tag-composer={recommendation.repositoryKey}>
            <p className="mb-2 text-[10px] leading-4 text-muted-foreground">{m.radar.addingTagStars}</p>
            <div className="flex items-center gap-2">
              <Input
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
                aria-label={m.radar.addTagAction}
                autoComplete="off"
                spellCheck={false}
                className="h-8 min-w-0 text-xs"
              />
              <Button
                type="button"
                size="sm"
                className="h-8 shrink-0 px-2 text-[11px]"
                disabled={pending || tagDraft.trim().length === 0}
                onClick={() => { void addTag(tagDraft); }}
              >
                {m.radar.addTagAction}
              </Button>
            </div>
            {recommendation.topics.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1" aria-label={m.radar.suggestedTags}>
                {recommendation.topics.slice(0, 6).map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    disabled={pending}
                    onClick={() => { void addTag(topic); }}
                    className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {topic}
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-[30px] text-muted-foreground hover:text-destructive"
              disabled={pending}
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

export function RadarRecommendations({
  recommendations,
  discoverView,
  loading,
  refreshing,
  error,
  pendingAction,
  recommendationFavorites,
  actionError,
  onDiscoverViewChange,
  onRefresh,
  onRetryQuery,
  onOpenOptions,
  onStar,
  onIgnore,
  onRestoreIgnored,
  onSetFavorite,
  onAddTag,
}: {
  recommendations: RecommendationQueryResponse | null;
  discoverView: RadarDiscoverView;
  loading: boolean;
  refreshing: boolean;
  error: 'query' | 'refresh' | null;
  pendingAction: RadarPendingAction | null;
  recommendationFavorites: Readonly<Record<string, boolean>>;
  actionError: RadarActionError | null;
  onDiscoverViewChange: (view: RadarDiscoverView) => void;
  onRefresh: () => void;
  onRetryQuery: () => void;
  onOpenOptions: () => void;
  onStar: RadarProps['onStar'];
  onIgnore: RadarProps['onIgnore'];
  onRestoreIgnored: RadarProps['onRestoreIgnored'];
  onSetFavorite: RadarProps['onSetFavorite'];
  onAddTag: RadarProps['onAddTag'];
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
  const snapshotAt = formatRadarAbsoluteTime(state?.lastSuccessfulAt ?? null, locale);
  const refreshDisabled = loading || refreshing || status?.snapshotStatus === 'cooldown'
    || status?.snapshotStatus === 'not_configured';
  const ignoredSection = ignored.length > 0 ? (
    <div className="border-t border-border/70 pb-16" data-radar-ignored-section>
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
          <ManagerResourceLink
            resource={{ kind: 'subject', label: 'github-trending', remoteUrl: 'https://github.com/trending' }}
            className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            <span className="max-[620px]:hidden">{m.radar.openTrending}</span>
          </ManagerResourceLink>
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
    return frame(<RadarEmptyState icon={<Spinner className="size-4" aria-hidden="true" />} />);
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
      const allowedAt = formatRadarAbsoluteTime(state?.nextAllowedAt ?? null, locale);
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
            favorite={recommendationFavorites[recommendation.repositoryKey] ?? false}
            pendingAction={pendingAction}
            actionError={actionError}
            onStar={onStar}
            onIgnore={onIgnore}
            onSetFavorite={onSetFavorite}
            onAddTag={onAddTag}
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
