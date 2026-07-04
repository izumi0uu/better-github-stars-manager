import { memo } from 'react';
import { Archive, Star as StarIcon, StickyNote } from 'lucide-react';
import type { Star } from '@/types';
import { Badge } from '@/ui/shadcn/badge';
import { FavoriteButton } from '@/ui/components/FavoriteButton';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { getLockedRegionProps } from '@/ui/interaction-lock';
import type { ColumnId } from '@/ui/column-layout';

/**
 * virtualized-list row. Fixed h-16 (64px) MUST match the virtualizer
 * estimateSize, else 10k+ row scroll math drifts.
 */
const COMPACT_VISIBLE = 2;

export const StarRow = memo(function StarRow({
  star,
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
}: {
  star: Star;
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
}) {
  const selectedSet = new Set(selectedTags);
  const overflow = tags.length > COMPACT_VISIBLE;
  const visible = overflow ? tags.slice(0, COMPACT_VISIBLE) : tags;
  const hiddenCount = tags.length - visible.length;
  const { m } = useI18n();

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
      style={{ gridTemplateColumns, minWidth }}
      {...getLockedRegionProps(interactionLocked)}
    >
      {columns.map((column) => {
        switch (column) {
          case 'repository':
            return (
              <div key={column} data-row-col={column} className={cn('flex items-center gap-1 overflow-hidden rounded-sm', { 'gsm-flash-col': flashedColumn === column })}>
                <span className="truncate text-primary">{star.full_name}</span>
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
              <div key={column} data-row-col={column} className={cn('flex items-center justify-end gap-0.5 rounded-sm text-xs text-muted-foreground', { 'gsm-flash-col': flashedColumn === column })}>
                <StarIcon className="size-3 fill-current" />
                <span className="tabular-nums">{fmt(star.stargazers_count)}</span>
              </div>
            );
          case 'updated':
            return (
              <div key={column} data-row-col={column} className={cn('rounded-sm text-xs text-muted-foreground/70', { 'gsm-flash-col': flashedColumn === column })}>
                {star.pushed_at ? star.pushed_at.slice(0, 10) : <span className="text-muted-foreground/60">{m.common.none}</span>}
              </div>
            );
          case 'created':
            return (
              <div key={column} data-row-col={column} className={cn('rounded-sm text-xs text-muted-foreground/70', { 'gsm-flash-col': flashedColumn === column })}>
                {star.created_at ? star.created_at.slice(0, 10) : <span className="text-muted-foreground/60">{m.common.none}</span>}
              </div>
            );
          case 'tags':
            return (
              <div key={column} data-row-col={column} onClick={(e) => e.stopPropagation()} className={cn('flex flex-wrap items-center gap-1 overflow-hidden rounded-sm', { 'gsm-flash-col': flashedColumn === column })}>
                {tags.length === 0 ? (
                  <span className="text-xs italic text-muted-foreground/50">{m.common.none}</span>
                ) : (
                  <>
                    {visible.map((t) => (
                      <button key={t} disabled={interactionLocked} onClick={() => onToggleTag(t)} title={selectedSet.has(t) ? m.starRow.clearTagFilter(t) : m.starRow.filterByTag(t)}>
                        <Badge
                          variant={selectedSet.has(t) ? 'tagActive' : 'tag'}
                          className={cn('hover:opacity-80', {
                            'cursor-pointer': !interactionLocked,
                            'cursor-default opacity-70': interactionLocked,
                          })}
                        >
                          {t}
                        </Badge>
                      </button>
                    ))}
                    {overflow && (
                      <span className="gsm-muted-count" title={m.starRow.moreHidden(hiddenCount)}>
                        +{hiddenCount}
                      </span>
                    )}
                  </>
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
