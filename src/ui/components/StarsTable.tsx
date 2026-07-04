import { useEffect, useRef, type CSSProperties, type PointerEvent, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { GripVertical, Heart, StickyNote } from 'lucide-react';
import type { Star, Tag } from '@/types';
import { COLUMN_DEFS, type ColumnId } from '@/ui/column-layout';
import { resolveFavoriteState, type FavoriteOverrideState } from '@/ui/favorite-state';
import { BROWSE_LAYOUT_TABLE_OPACITY_MS } from '@/ui/layout-edit-constants';
import { StarRow } from '@/ui/components/StarRow';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

const ROW_HEIGHT = 64;

export type StarsTablePhase = 'idle' | 'fading-out' | 'fading-in';

export function StarsTable({
  rows,
  loading,
  phase,
  tagsByFullName,
  favoriteOverrides = {},
  selectedTags,
  selectedFullName,
  visibleColumns,
  gridTemplateColumns,
  editingLayout,
  interactionLocked,
  layoutFaded,
  draggedColumnId,
  draggedColumnHideIntent,
  columnShifts,
  flashedColumn,
  trayCaretX,
  scrollRef,
  headerRef,
  onSelect,
  onToggleTag,
  onToggleFavorite,
  onBeginColumnDrag,
}: {
  rows: Star[];
  loading: boolean;
  phase: StarsTablePhase;
  tagsByFullName: Map<string, Tag>;
  favoriteOverrides?: Record<string, FavoriteOverrideState>;
  selectedTags: string[];
  selectedFullName: string | null;
  visibleColumns: ColumnId[];
  gridTemplateColumns: string;
  editingLayout: boolean;
  interactionLocked: boolean;
  layoutFaded: boolean;
  draggedColumnId: ColumnId | null;
  draggedColumnHideIntent: boolean;
  columnShifts: Partial<Record<ColumnId, number>>;
  flashedColumn: ColumnId | null;
  trayCaretX: number | null;
  scrollRef: RefObject<HTMLElement>;
  headerRef: RefObject<HTMLDivElement>;
  onSelect: (fullName: string) => void;
  onToggleTag: (tag: string) => void;
  onToggleFavorite: (fullName: string, favorite: boolean) => Promise<void>;
  onBeginColumnDrag: (event: PointerEvent<HTMLElement>, id: ColumnId) => void;
}) {
  const { m } = useI18n();
  const headerSentinelRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(false);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = headerSentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        stuckRef.current = !entry.isIntersecting;
        headerRef.current?.setAttribute('data-stuck', String(stuckRef.current));
        headerRef.current?.classList.toggle('gsm-table-head-stuck', stuckRef.current);
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [headerRef, scrollRef]);

  return (
    <div
      className="gsm-layout-table-shell"
      style={{
        opacity: phase === 'fading-out' || layoutFaded ? 0 : 1,
        '--gsm-table-opacity-duration': `${phase === 'fading-out' ? 120 : BROWSE_LAYOUT_TABLE_OPACITY_MS}ms`,
      } as CSSProperties & Record<'--gsm-table-opacity-duration', string>}
    >
      <div ref={headerSentinelRef} data-table-head-sentinel className="h-px" aria-hidden="true" />
      <div
        ref={headerRef}
        data-table-head
        data-stuck="false"
        className={cn(
          'gsm-layout-grid gsm-meta-label gsm-z-sticky sticky top-0 grid gap-2 border-b bg-background px-3 py-1.5',
          {
            'border-primary': editingLayout,
            'border-border': !editingLayout,
          },
        )}
        style={{ gridTemplateColumns }}
      >
        {visibleColumns.map((id, index) => {
          const def = COLUMN_DEFS[id];
          const label = def.label(m);
          return (
            <span
              key={id}
              data-header-col={id}
              className={cn(
                'gsm-hdr-cell group relative flex min-w-0 items-center gap-1 overflow-visible rounded-sm transition-[background-color,opacity,transform] duration-150',
                {
                  'justify-end text-right': def.align === 'end',
                  'justify-center': def.align === 'center',
                  'opacity-[0.35]': draggedColumnId === id,
                  'gsm-drag-hide-intent': draggedColumnId === id && draggedColumnHideIntent,
                  'gsm-flash-col': flashedColumn === id,
                },
              )}
              style={{
                transform: columnShifts[id] ? `translateX(${columnShifts[id]}px)` : undefined,
              }}
            >
              {editingLayout && !def.locked && (
                <button
                  type="button"
                  onPointerDown={(e) => onBeginColumnDrag(e, id)}
                  title={m.toolbar.dragColumnTitle(label)}
                  className="gsm-gear-in grid size-4 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
                  style={{ '--d': `${index * 28}ms` } as CSSProperties & Record<'--d', string>}
                >
                  <GripVertical className="size-3" />
                </button>
              )}
              {id === 'favorite' ? (
                <Heart className="size-3" aria-label={label} />
              ) : id === 'notes' ? (
                <StickyNote className="size-3" aria-label={label} />
              ) : (
                <span className="truncate">{label}</span>
              )}
            </span>
          );
        })}
        {trayCaretX != null && (
          <span className="gsm-insert-caret" style={{ left: trayCaretX }} />
        )}
      </div>
      {rows.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          {loading ? m.common.loading : m.manager.emptyState}
        </div>
      ) : (
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const star = rows[vi.index];
            const tag = tagsByFullName.get(star.full_name);
            const { favorite, busy: favoriteBusy } = resolveFavoriteState(
              tag,
              favoriteOverrides[star.full_name],
            );
            return (
              <div
                key={star.full_name}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <StarRow
                  star={star}
                  tags={tag?.tags ?? []}
                  hasNotes={!!(tag?.notes && tag.notes.trim())}
                  favorite={favorite}
                  favoriteBusy={favoriteBusy}
                  selectedTags={selectedTags}
                  onToggleTag={onToggleTag}
                  onToggleFavorite={onToggleFavorite}
                  selected={selectedFullName === star.full_name}
                  onSelect={onSelect}
                  columns={visibleColumns}
                  gridTemplateColumns={gridTemplateColumns}
                  flashedColumn={flashedColumn}
                  interactionLocked={interactionLocked}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
