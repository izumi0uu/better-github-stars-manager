import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, GitFork, Star as StarIcon, StickyNote } from 'lucide-react';
import type { Star } from '@/types';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { FavoriteButton } from '@/ui/components/FavoriteButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { getLockedRegionProps } from '@/ui/interaction-lock';
import type { ColumnId } from '@/ui/column-layout';
import { fitInlineTags } from '@/ui/inline-tag-fit';
import { createRepositorySearchMatcher } from '@/search/repository-search';
import { SearchMatchText } from '@/ui/components/SearchMatchText';
import { RepositoryOwnerAvatar } from '@/ui/components/RepositoryOwnerAvatar';

/**
 * virtualized-list row. Fixed h-16 (64px) MUST match the virtualizer
 * estimateSize, else 10k+ row scroll math drifts.
 */
const INITIAL_VISIBLE_TAGS = 2;
const INLINE_TAG_GAP_PX = 4;

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;


export const StarRow = memo(function StarRow({
  star,
  searchQuery = '',
  showRepositoryOwner = true,
  showRepositoryAvatar = true,
  tags,
  hasNotes,
  favorite,
  favoriteBusy,
  selectedTags,
  onToggleTag,
  onToggleFavorite,
  selected,
  onSelect,
  columns,
  gridTemplateColumns,
  flashedColumn,
  interactionLocked = false,
  minWidth,
  onConfirmUnstar,
  unstarPopoverOpen,
  onUnstarPopoverOpenChange,
}: {
  star: Star;
  searchQuery?: string;
  showRepositoryOwner?: boolean;
  showRepositoryAvatar?: boolean;
  tags: string[];
  hasNotes: boolean;
  favorite: boolean;
  favoriteBusy: boolean;
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onToggleFavorite: (full_name: string, favorite: boolean) => Promise<void>;
  selected: boolean;
  onSelect: (full_name: string) => void;
  columns: ColumnId[];
  gridTemplateColumns: string;
  flashedColumn: ColumnId | null;
  interactionLocked?: boolean;
  minWidth?: number;
  onConfirmUnstar?: (fullName: string) => void;
  unstarPopoverOpen?: boolean;
  onUnstarPopoverOpenChange?: (open: boolean) => void;
}) {
  const selectedSet = useMemo(() => new Set(selectedTags), [selectedTags]);
  const tagCellRef = useRef<HTMLDivElement | null>(null);
  const tagMeasureRef = useRef<HTMLDivElement | null>(null);
  const tagsKey = useMemo(() => tags.join('\u0000'), [tags]);
  const hasTagsColumn = columns.includes('tags');
  const [tagFit, setTagFit] = useState<{ tagsKey: string; visibleCount: number } | null>(null);
  const [uncontrolledUnstarOpen, setUncontrolledUnstarOpen] = useState(false);
  const unstarOpen = unstarPopoverOpen ?? uncontrolledUnstarOpen;
  const setUnstarOpen = onUnstarPopoverOpenChange ?? setUncontrolledUnstarOpen;
  const handlePopoverOpenChange = (open: boolean) => {
    setUnstarOpen(open);
  };
  const initialVisibleCount = Math.min(INITIAL_VISIBLE_TAGS, tags.length);
  const fittedVisibleCount = tagFit?.tagsKey === tagsKey ? tagFit.visibleCount : initialVisibleCount;
  const visibleCount = Math.max(0, Math.min(tags.length, fittedVisibleCount));
  const visible = tags.slice(0, visibleCount);
  const hiddenCount = tags.length - visible.length;
  const overflow = hiddenCount > 0;
  const repositoryNameMatch = useMemo(
    () => createRepositorySearchMatcher(searchQuery).matchName(star.full_name),
    [searchQuery, star.full_name],
  );
  const repositorySourceOffset = showRepositoryOwner
    ? 0
    : Math.max(0, star.full_name.lastIndexOf('/') + 1);
  const repositoryLabel = star.full_name.slice(repositorySourceOffset);
  const { m } = useI18n();

  useIsomorphicLayoutEffect(() => {
    if (!hasTagsColumn || tags.length === 0) return;

    const cell = tagCellRef.current;
    const measure = tagMeasureRef.current;
    if (!cell || !measure) return;

    const updateFit = () => {
      const tagWidths = [...measure.querySelectorAll<HTMLElement>('[data-inline-tag-measure="tag"]')]
        .map((element) => element.offsetWidth);
      if (tagWidths.length !== tags.length) return;

      const countWidths = new Map<number, number>();
      for (const element of measure.querySelectorAll<HTMLElement>('[data-inline-tag-measure="count"]')) {
        const count = Number(element.dataset.count);
        if (Number.isFinite(count)) countWidths.set(count, element.offsetWidth);
      }

      const next = fitInlineTags({
        availableWidth: cell.clientWidth,
        tagWidths,
        gapWidth: INLINE_TAG_GAP_PX,
        hiddenCountWidth: (count) => countWidths.get(count) ?? 0,
      });

      setTagFit((current) => {
        if (current?.tagsKey === tagsKey && current.visibleCount === next.visibleCount) return current;
        return { tagsKey, visibleCount: next.visibleCount };
      });
    };

    updateFit();

    if (typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(updateFit);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [hasTagsColumn, tags.length, tagsKey]);

  return (
    <div
      onClick={() => {
        if (!interactionLocked) onSelect(star.full_name);
      }}
      className={cn(
        'gsm-layout-grid grid h-16 items-center gap-2 border-b border-border px-3 text-sm',
        {
          'cursor-pointer': !interactionLocked,
          'cursor-default': interactionLocked,
          'bg-primary/10': selected,
          'bg-muted/40': !selected && star.tombstone,
          'bg-transparent': !selected && !star.tombstone,
          'border-l-2 border-l-primary': selected,
          'border-l-2 border-l-transparent': !selected,
          'opacity-55': star.tombstone,
          'pointer-events-none opacity-55': interactionLocked,
        },
      )}
      data-layout-row-grid
      style={{ gridTemplateColumns, minWidth }}
      {...getLockedRegionProps(interactionLocked)}
    >
      {columns.map((column) => {
        switch (column) {
          case 'repository':
            return (
              <div key={column} data-row-col={column} className={cn('flex min-w-0 items-center gap-1 overflow-hidden rounded-sm', { 'gsm-flash-col': flashedColumn === column })}>
                {showRepositoryAvatar ? <RepositoryOwnerAvatar fullName={star.full_name} url={star.owner_avatar_url} /> : null}
                <span
                  className="min-w-0 flex-1 truncate text-primary"
                  title={showRepositoryOwner ? undefined : star.full_name}
                  aria-label={showRepositoryOwner ? undefined : star.full_name}
                >
                  <SearchMatchText
                    text={repositoryLabel}
                    ranges={repositoryNameMatch.nameRanges}
                    sourceOffset={repositorySourceOffset}
                  />
                </span>
                {star.fork && (
                  <Badge
                    data-row-badge="fork"
                    variant="outline"
                    className="h-4 shrink-0 gap-1 border-info/35 bg-info/10 px-1.5 text-[10px] font-medium leading-none text-info"
                  >
                    <GitFork className="size-2.5" aria-hidden="true" />
                    {m.starRow.fork}
                  </Badge>
                )}
                {star.archived && <Archive className="size-3 shrink-0 text-warning" aria-label={m.starRow.archived} />}
              </div>
            );
          case 'description':
            return (
              <div key={column} data-row-col={column} className={cn('truncate rounded-sm text-xs text-muted-foreground', { 'gsm-flash-col': flashedColumn === column })}>
                {star.description || <span className="text-muted-foreground/60">{m.common.none}</span>}
              </div>
            );
          case 'language':
            return (
              <div key={column} data-row-col={column} className={cn('truncate rounded-sm text-xs text-primary', { 'gsm-flash-col': flashedColumn === column })}>
                {star.language ?? <span className="text-muted-foreground/60">{m.common.none}</span>}
              </div>
            );
          case 'stars':
            return (
              <div
                key={column}
                data-row-col={column}
                className={cn(
                  'flex min-w-0 items-center justify-start gap-0.5 overflow-hidden rounded-sm text-xs text-muted-foreground',
                  {
                    'gsm-flash-col': flashedColumn === column,
                  },
                )}
              >
                <StarIcon className="size-3 shrink-0 fill-current" />
                <span className="min-w-0 truncate tabular-nums">{fmt(star.stargazers_count)}</span>
              </div>
            );
          case 'updated':
            return (
              <div key={column} data-row-col={column} className={cn('min-w-0 truncate rounded-sm text-xs text-muted-foreground/70', { 'gsm-flash-col': flashedColumn === column })}>
                {star.pushed_at ? star.pushed_at.slice(0, 10) : <span className="text-muted-foreground/60">{m.common.none}</span>}
              </div>
            );
          case 'created':
            return (
              <div key={column} data-row-col={column} className={cn('min-w-0 truncate rounded-sm text-xs text-muted-foreground/70', { 'gsm-flash-col': flashedColumn === column })}>
                {star.created_at ? star.created_at.slice(0, 10) : <span className="text-muted-foreground/60">{m.common.none}</span>}
              </div>
            );
          case 'tags':
            return (
              <div
                key={column}
                ref={tagCellRef}
                data-row-col={column}
                className={cn('relative flex min-w-0 items-center overflow-hidden rounded-sm', { 'gsm-flash-col': flashedColumn === column })}
              >
                {tags.length === 0 ? (
                  <span className="text-xs italic text-muted-foreground/50">{m.common.none}</span>
                ) : (
                  <>
                    <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
                      {visible.map((t) => (
                        <button
                          key={t}
                          type="button"
                          className="min-w-0 max-w-full shrink-0"
                          disabled={interactionLocked}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleTag(t);
                          }}
                          title={selectedSet.has(t) ? m.starRow.clearTagFilter(t) : m.starRow.filterByTag(t)}
                        >
                          <Badge
                            variant={selectedSet.has(t) ? 'tagActive' : 'tag'}
                            className={cn('max-w-full truncate hover:opacity-80', {
                              'cursor-pointer': !interactionLocked,
                              'cursor-default opacity-70': interactionLocked,
                            })}
                          >
                            {t}
                          </Badge>
                        </button>
                      ))}
                      {overflow && (
                        <span className="gsm-muted-count shrink-0" title={m.starRow.moreHidden(hiddenCount)}>
                          +{hiddenCount}
                        </span>
                      )}
                    </div>
                    <div
                      ref={tagMeasureRef}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-0 top-0 flex items-center gap-1 whitespace-nowrap opacity-0"
                    >
                      {tags.map((t, index) => (
                        <Badge key={`${t}-${index}`} data-inline-tag-measure="tag" variant="tag" className="max-w-none">
                          {t}
                        </Badge>
                      ))}
                      {tags.map((_, index) => {
                        const count = index + 1;
                        return (
                          <span
                            key={count}
                            data-count={count}
                            data-inline-tag-measure="count"
                            className="gsm-muted-count"
                          >
                            +{count}
                          </span>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            );
          case 'starAction':
            return (
              <div key={column} data-row-col={column} className={cn('flex justify-center rounded-sm', { 'gsm-flash-col': flashedColumn === column })}>
                {!onConfirmUnstar ? (
                  <button
                    type="button"
                    disabled
                    className="grid size-8 place-items-center rounded-md text-muted-foreground/45"
                    title={m.starRow.alreadyUnstarred}
                    aria-label={m.starRow.alreadyUnstarred}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <StarIcon className="size-4" />
                  </button>
                ) : star.tombstone || star.viewer_has_starred === false ? (
                  <button
                    type="button"
                    disabled
                    className="grid size-8 place-items-center rounded-md text-muted-foreground/45"
                    title={star.tombstone ? m.starRow.alreadyUnstarred : m.starRow.notStarred}
                    aria-label={star.tombstone ? m.starRow.alreadyUnstarred : m.starRow.notStarred}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <StarIcon className="size-4" />
                  </button>
                ) : (
                  <Popover open={unstarOpen} onOpenChange={handlePopoverOpenChange}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        disabled={interactionLocked}
                        className="grid size-7 place-items-center text-primary transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                        title={m.starRow.unstarTitle(star.full_name)}
                        aria-label={m.starRow.unstarTitle(star.full_name)}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <StarIcon className="size-3.5 fill-current" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      className="flex w-auto items-center gap-1 rounded-lg border-0 p-1.5 shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 origin-[--radix-popover-content-transform-origin]"
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onInteractOutside={() => setUnstarOpen(false)}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-5 px-1.5 text-[10px]"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUnstarOpen(false);
                        }}
                      >
                        {m.starRow.unstarCancel}
                      </Button>
                      <Button
                        type="button"
                        className="h-5 px-1.5 text-[10px]"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUnstarOpen(false);
                          onConfirmUnstar(star.full_name);
                        }}
                      >
                        {m.starRow.unstar}
                      </Button>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            );
          case 'favorite':
            return (
              <div key={column} data-row-col={column} className={cn('flex justify-center rounded-sm', { 'gsm-flash-col': flashedColumn === column })}>
                <FavoriteButton
                  active={favorite}
                  busy={favoriteBusy || interactionLocked}
                  activeLabel={m.starRow.removeFavorite}
                  inactiveLabel={m.starRow.markFavorite}
                  onToggle={(next) => {
                    if (interactionLocked) return;
                    onToggleFavorite(star.full_name, next)
                      .catch(() => {});
                  }}
                />
              </div>
            );
          case 'notes':
            return (
              <div
                key={column}
                data-row-col={column}
                className={cn('flex justify-center rounded-sm', { 'gsm-flash-col': flashedColumn === column })}
                title={hasNotes ? m.starRow.hasNotes : m.starRow.noNotes}
              >
                {hasNotes && <StickyNote className="size-3.5 text-muted-foreground" />}
              </div>
            );
        }
        const exhaustive: never = column;
        return exhaustive;
      })}
    </div>
  );
});


function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
