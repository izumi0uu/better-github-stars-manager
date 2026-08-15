import { ExternalLink, Heart, Star, Tag, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type {
  RadarActivityPresentation,
  RadarProjectPresentation,
} from '@/radar/radar-model';
import type {
  RadarActionError,
  RadarPendingAction,
  RadarProps,
} from '@/ui/radar-types';
import { useDelayedHoverIntent } from '@/ui/hooks/use-delayed-hover-intent';
import { SearchMatchText } from '@/ui/components/SearchMatchText';
import { RepositoryOwnerAvatar } from '@/ui/components/RepositoryOwnerAvatar';
import type {
  RadarActivitySearchResult,
  RadarProjectSearchResult,
} from '@/ui/radar-search';
import { formatRadarAbsoluteTime, formatRadarRelativeTime } from '@/ui/radar-time';
import { Input } from '@/ui/shadcn/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Spinner } from '@/ui/shadcn/spinner';

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
  onStar: RadarProps['onStar'];
  onUnstar: RadarProps['onUnstar'];
  onSetFavorite: RadarProps['onSetFavorite'];
  onAddTag: RadarProps['onAddTag'];
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

export function RadarFeedRow({
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
  onStar: RadarProps['onStar'];
  onUnstar: RadarProps['onUnstar'];
  onSetFavorite: RadarProps['onSetFavorite'];
  onAddTag: RadarProps['onAddTag'];
  onDismiss: () => void;
  onMarkSeen: RadarProps['onMarkSeen'];
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
            title={formatRadarAbsoluteTime(activity.starredAt, locale) ?? undefined}
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
              title={formatRadarAbsoluteTime(activity.starredAt, locale) ?? undefined}
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
  onStar: RadarProps['onStar'];
  onUnstar: RadarProps['onUnstar'];
  onSetFavorite: RadarProps['onSetFavorite'];
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

export function RadarProjectRow({
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
  onStar: RadarProps['onStar'];
  onUnstar: RadarProps['onUnstar'];
  onSetFavorite: RadarProps['onSetFavorite'];
  onAddTag: RadarProps['onAddTag'];
  onDismiss: () => void;
  onMarkSeen: RadarProps['onMarkSeen'];
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
