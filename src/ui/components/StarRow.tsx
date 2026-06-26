import { memo, useEffect, useState } from 'react';
import { Archive, Heart, Star as StarIcon, StickyNote } from 'lucide-react';
import type { Star, Tag } from '@/types';
import { Badge } from '@/ui/shadcn/badge';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

/**
 * virtualized-list row. Fixed h-16 (64px) MUST match the virtualizer
 * estimateSize, else 10k+ row scroll math drifts.
 */
const COMPACT_VISIBLE = 2;

export const StarRow = memo(function StarRow({
  star,
  tag,
  selectedTags,
  onToggleTag,
  onToggleFavorite,
  selected,
  onSelect,
}: {
  star: Star;
  tag: Tag | undefined;
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onToggleFavorite: (full_name: string, favorite: boolean) => Promise<void>;
  selected: boolean;
  onSelect: (full_name: string) => void;
}) {
  const myTags = tag?.tags ?? [];
  const persistedFavorite = !!tag?.favorite;
  const [optimisticFavorite, setOptimisticFavorite] = useState<boolean | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const hasNotes = !!(tag?.notes && tag.notes.trim());
  const selectedSet = new Set(selectedTags);
  const overflow = myTags.length > COMPACT_VISIBLE;
  const visible = overflow ? myTags.slice(0, COMPACT_VISIBLE) : myTags;
  const hiddenCount = myTags.length - visible.length;
  const { m } = useI18n();
  const favorite = optimisticFavorite ?? persistedFavorite;

  useEffect(() => {
    setOptimisticFavorite(null);
    setFavoriteBusy(false);
  }, [star.full_name, persistedFavorite]);

  return (
    <div
      onClick={() => onSelect(star.full_name)}
      className={cn(
        'grid h-16 cursor-pointer items-center gap-2 border-b border-border px-3 text-sm',
        // columns: repo | desc | lang | stars | updated | tags | favorite | note
        'grid-cols-[minmax(180px,1.4fr)_2fr_80px_64px_84px_1.6fr_28px_20px]',
        selected ? 'bg-primary/10' : star.tombstone ? 'bg-muted/40' : 'bg-transparent',
        selected ? 'border-l-2 border-l-primary' : 'border-l-2 border-l-transparent',
        star.tombstone && 'opacity-55',
      )}
    >
      {/* Repo name + status icons */}
      <div className="flex items-center gap-1 overflow-hidden">
        <span className="truncate text-primary">{star.full_name}</span>
        {star.archived && <Archive className="size-3 shrink-0 text-warning" aria-label={m.starRow.archived} />}
      </div>

      {/* Description */}
      <div className="truncate text-xs text-muted-foreground">
        {star.description || <span className="text-muted-foreground/60">{m.common.none}</span>}
      </div>

      {/* Language */}
      <div className="truncate text-xs text-primary">
        {star.language ?? <span className="text-muted-foreground/60">{m.common.none}</span>}
      </div>

      {/* Stars */}
      <div className="flex items-center justify-end gap-0.5 text-xs text-muted-foreground">
        <StarIcon className="size-3 fill-current" />
        <span className="tabular-nums">{fmt(star.stargazers_count)}</span>
      </div>

      {/* Updated */}
      <div className="text-xs text-muted-foreground/70">{star.pushed_at.slice(0, 10)}</div>

      {/* Tags */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-wrap items-center gap-1 overflow-hidden"
      >
        {myTags.length === 0 ? (
          <span className="text-xs italic text-muted-foreground/50">{m.common.none}</span>
        ) : (
          <>
            {visible.map((t) => (
              <button key={t} onClick={() => onToggleTag(t)} title={selectedSet.has(t) ? m.starRow.clearTagFilter(t) : m.starRow.filterByTag(t)}>
                <Badge variant={selectedSet.has(t) ? 'tagActive' : 'tag'} className="cursor-pointer hover:opacity-80">
                  {t}
                </Badge>
              </button>
            ))}
            {overflow && (
              <span className="text-[10px] text-muted-foreground" title={m.starRow.moreHidden(hiddenCount)}>
                +{hiddenCount}
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex justify-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (favoriteBusy) return;
            const next = !favorite;
            setFavoriteBusy(true);
            setOptimisticFavorite(next);
            onToggleFavorite(star.full_name, next)
              .then(() => setFavoriteBusy(false))
              .catch(() => {
                setOptimisticFavorite(null);
                setFavoriteBusy(false);
              });
          }}
          disabled={favoriteBusy}
          className={cn(
            'inline-flex items-center justify-center rounded p-1 transition-colors duration-200 disabled:opacity-70',
            favorite
              ? 'text-rose-500 hover:text-rose-600'
              : 'text-muted-foreground/45 hover:text-rose-400',
          )}
          aria-label={favorite ? m.starRow.removeFavorite : m.starRow.markFavorite}
          title={favorite ? m.starRow.removeFavorite : m.starRow.markFavorite}
        >
          <ActionIcon phase={favorite ? 'favorite-on' : 'favorite-off'}>
            <Heart className={cn('size-4', favorite && 'fill-current')} />
          </ActionIcon>
        </button>
      </div>

      {/* Note indicator */}
      <div className="flex justify-center" title={hasNotes ? m.starRow.hasNotes : m.starRow.noNotes}>
        {hasNotes && <StickyNote className="size-3.5 text-muted-foreground" />}
      </div>
    </div>
  );
});

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
