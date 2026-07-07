import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type PointerEvent, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { GripVertical, Heart, StickyNote } from 'lucide-react';
import type { Star, Tag } from '@/types';
import { COLUMN_DEFS, type ColumnId } from '@/ui/column-layout';
import { resolveFavoriteState, type FavoriteOverrideState } from '@/ui/favorite-state';
import { BROWSE_LAYOUT_TABLE_OPACITY_MS } from '@/ui/layout-edit-constants';
import {
  LayoutResizeSurface,
  layoutViewportFromMeasurements,
  resetLiveOverflowElements,
  type LayoutResizeOverlayState,
  type LayoutViewportState,
} from '@/ui/layout-resize-surface';
import type { LayoutResizeLiveAdapter, LayoutResizeLiveState } from '@/ui/layout-resize-tool';
import { StarRow } from '@/ui/components/StarRow';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { visibleTagNames } from '@/tags/tag-model';

const ROW_HEIGHT = 64;
const noopLayoutViewportChange = () => {};

export type StarsTablePhase = 'idle' | 'fading-out' | 'fading-in';

export interface StarsTableLayoutEdit {
  editing: boolean;
  faded: boolean;
  draggedColumnId: ColumnId | null;
  draggedColumnHideIntent: boolean;
  columnShifts: Partial<Record<ColumnId, number>>;
  flashedColumn: ColumnId | null;
  trayCaretX: number | null;
  onBeginColumnDrag: (event: PointerEvent<HTMLElement>, id: ColumnId) => void;
  onMoveColumnByKeyboard?: (id: ColumnId, direction: -1 | 1) => void;
}

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
  tableMinWidth,
  interactionLocked,
  layoutEdit,
  layoutResize,
  customColumnLayoutActive,
  scrollRef,
  rootRef,
  headerRef,
  layoutResizeLiveAdapterRef,
  onLayoutViewportChange = noopLayoutViewportChange,
  onSelect,
  onToggleTag,
  onToggleFavorite,
  onBeginColumnResize = () => {},
  onResizeColumnByKeyboard = () => {},
  onAutoFitColumnWidth = () => {},
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
  tableMinWidth?: number;
  interactionLocked: boolean;
  layoutEdit: StarsTableLayoutEdit;
  layoutResize?: LayoutResizeLiveState | null;
  customColumnLayoutActive?: boolean;
  scrollRef: RefObject<HTMLElement>;
  rootRef?: RefObject<HTMLElement>;
  headerRef: RefObject<HTMLDivElement>;
  layoutResizeLiveAdapterRef?: MutableRefObject<LayoutResizeLiveAdapter | null>;
  onLayoutViewportChange?: (viewport: LayoutViewportState | null) => void;
  onSelect: (fullName: string) => void;
  onToggleTag: (tag: string) => void;
  onToggleFavorite: (fullName: string, favorite: boolean) => Promise<void>;
  onBeginColumnResize?: (event: PointerEvent<HTMLElement>, id: ColumnId) => void;
  onResizeColumnByKeyboard?: (id: ColumnId, direction: -1 | 1, largeStep?: boolean) => void;
  onAutoFitColumnWidth?: (id: ColumnId) => void;
}) {
  const { m } = useI18n();
  const headerSentinelRef = useRef<HTMLDivElement>(null);
  const tableShellRef = useRef<HTMLDivElement>(null);
  const fallbackRootRef = useRef<HTMLDivElement>(null);
  const fallbackLiveAdapterRef = useRef<LayoutResizeLiveAdapter | null>(null);
  const stuckRef = useRef(false);
  const layoutResizeSurfaceRef = useRef<LayoutResizeSurface | null>(null);
  if (layoutResizeSurfaceRef.current === null) {
    layoutResizeSurfaceRef.current = new LayoutResizeSurface();
  }
  const layoutResizeSurface = layoutResizeSurfaceRef.current;
  const [layoutResizeOverlay, setLayoutResizeOverlay] = useState<LayoutResizeOverlayState | null>(null);
  const readoutRootRef = rootRef ?? fallbackRootRef;
  const liveAdapterRef = layoutResizeLiveAdapterRef ?? fallbackLiveAdapterRef;
  const [layoutViewport, setLayoutViewport] = useState<LayoutViewportState | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const virtualRowsSignature = layoutResize
    ? virtualItems.map((item) => `${item.index}:${item.start}`).join('|')
    : '';
  const buildSurfaceContext = () => ({
    visibleColumns,
    tableShell: tableShellRef.current,
    readoutRoot: readoutRootRef.current,
    header: headerRef.current,
    stage: scrollRef.current,
    m,
  });
  const onDragHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: ColumnId) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    layoutEdit.onMoveColumnByKeyboard?.(id, event.key === 'ArrowLeft' ? -1 : 1);
  };
  const onResizeHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: ColumnId) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      onResizeColumnByKeyboard(id, event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    onAutoFitColumnWidth(id);
  };

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

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const header = headerRef.current;
    if (!scroller || !header) return;

    const measure = () => {
      const nextViewport = layoutViewportFromMeasurements({
        panelWidth: scroller.clientWidth,
        headerScrollWidth: header.scrollWidth,
        headerRectWidth: header.getBoundingClientRect().width,
        tableMinWidth,
      });
      setLayoutViewport((current) => (
        current &&
        current.panelWidth === nextViewport.panelWidth &&
        current.tableWidth === nextViewport.tableWidth &&
        current.overflowPx === nextViewport.overflowPx
          ? current
          : nextViewport
      ));
      onLayoutViewportChange(nextViewport);
    };

    measure();
    if (layoutResize) return;
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resizeObserver?.observe(scroller);
    resizeObserver?.observe(header);
    window.addEventListener('resize', measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [headerRef, tableMinWidth, gridTemplateColumns, rows.length, layoutEdit.editing, layoutResize, onLayoutViewportChange, scrollRef]);

  useLayoutEffect(() => {
    const surface = layoutResizeSurface;
    surface.configure(buildSurfaceContext());
  }, [m, visibleColumns]);

  useLayoutEffect(() => {
    const surface = layoutResizeSurface;
    if (!layoutResize) {
      setLayoutResizeOverlay(null);
      return;
    }

    const measure = () => {
      surface.configure(buildSurfaceContext());
      setLayoutResizeOverlay(surface.refreshGeometry(layoutResize));
    };

    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
    };
  }, [layoutResize, m, visibleColumns]);

  useLayoutEffect(() => {
    if (!layoutResizeOverlay) return;
    layoutResizeSurface.refreshLiveNodes();
  }, [layoutResizeOverlay]);

  useLayoutEffect(() => {
    if (!layoutResize) return;
    layoutResizeSurface.refreshVisibleRows();
  }, [layoutResize, virtualRowsSignature]);

  useLayoutEffect(() => {
    const surface = layoutResizeSurface;
    liveAdapterRef.current = {
      measureStart: (resize) => {
        surface.configure(buildSurfaceContext());
        surface.measureStart(resize);
      },
      paint: (resize) => surface.paint(resize),
      cleanup: (outcome) => surface.cleanup(outcome),
    };
    return () => {
      liveAdapterRef.current = null;
    };
  }, [liveAdapterRef, m, visibleColumns]);

  useLayoutEffect(() => {
    if (layoutResize) return;
    resetLiveOverflowElements(tableShellRef.current);
  }, [layoutResize]);

  return (
    <div
      ref={tableShellRef}
      className="gsm-layout-table-shell relative"
      style={{
        opacity: phase === 'fading-out' || layoutEdit.faded ? 0 : 1,
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
            'border-primary': layoutEdit.editing,
            'border-border': !layoutEdit.editing,
          },
        )}
        style={{ gridTemplateColumns, minWidth: tableMinWidth }}
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
                  'justify-end text-right': def.align === 'end' && !customColumnLayoutActive,
                  'justify-center': def.align === 'center',
                  'gsm-active-resize-col': layoutResize?.id === id,
                  'opacity-[0.35]': layoutEdit.draggedColumnId === id,
                  'gsm-drag-hide-intent': layoutEdit.draggedColumnId === id && layoutEdit.draggedColumnHideIntent,
                  'gsm-flash-col': layoutEdit.flashedColumn === id,
                },
              )}
              style={{
                transform: layoutEdit.columnShifts[id] ? `translateX(${layoutEdit.columnShifts[id]}px)` : undefined,
              }}
            >
              {layoutEdit.editing && !def.locked && (
                <button
                  type="button"
                  onPointerDown={(e) => layoutEdit.onBeginColumnDrag(e, id)}
                  onKeyDown={(e) => onDragHandleKeyDown(e, id)}
                  title={m.toolbar.dragColumnTitle(label)}
                  aria-label={m.toolbar.dragColumnTitle(label)}
                  className="gsm-gear-in grid size-4 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
                  style={{ '--d': `${index * 28}ms` } as CSSProperties & Record<'--d', string>}
                >
                  <GripVertical className="size-3" />
                  <span className="sr-only">{m.toolbar.dragColumnTitle(label)}</span>
                </button>
              )}
              {id === 'favorite' ? (
                <Heart className="size-3" aria-label={label} />
              ) : id === 'notes' ? (
                <StickyNote className="size-3" aria-label={label} />
              ) : (
                <span data-header-label={id} className="truncate">{label}</span>
              )}
              {layoutEdit.editing && !def.locked && (
                <button
                  type="button"
                  onPointerDown={(e) => onBeginColumnResize(e, id)}
                  onKeyDown={(e) => onResizeHandleKeyDown(e, id)}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onAutoFitColumnWidth(id);
                  }}
                  title={m.toolbar.resizeColumnTitle(label)}
                  aria-label={m.toolbar.resizeColumnTitle(label)}
                  className="gsm-resize-handle"
                  style={{ '--d': `${index * 28}ms` } as CSSProperties & Record<'--d', string>}
                >
                  <span className="sr-only">{m.toolbar.resizeColumnTitle(label)}</span>
                </button>
              )}
            </span>
          );
        })}
        {layoutEdit.trayCaretX != null && (
          <span className="gsm-insert-caret" style={{ left: layoutEdit.trayCaretX }} />
        )}
      </div>
      <LayoutResizeFeedbackOverlay overlay={layoutResizeOverlay} resize={layoutResize ?? null} />
      <LayoutOverflowIndicator overflowPx={layoutEdit.editing ? layoutViewport?.overflowPx ?? 0 : 0} />
      {rows.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          {loading ? m.common.loading : m.manager.emptyState}
        </div>
      ) : (
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((vi) => {
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
                  tags={visibleTagNames(tag)}
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
                  minWidth={tableMinWidth}
                  flashedColumn={layoutEdit.flashedColumn}
                  interactionLocked={interactionLocked}
                  starColumnAlignStart={customColumnLayoutActive}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const LayoutResizeFeedbackOverlay = memo(function LayoutResizeFeedbackOverlay({
  overlay,
  resize,
}: {
  overlay: LayoutResizeOverlayState | null;
  resize: {
    defaultWidth: number;
    liveWidth: number;
    delta: number;
    atDefaultWidth: boolean;
    snappedToDefault: boolean;
    atMinWidth: boolean;
  } | null;
}) {
  const { m } = useI18n();
  if (!overlay || !resize) return null;

  return (
    <div className="pointer-events-none absolute inset-0 gsm-z-overlay" data-layout-resize-overlay>
      <span className="gsm-col-hilite" style={{ top: overlay.top, left: overlay.left, width: overlay.width, height: overlay.height }} />
      <span className="gsm-stable-rail" style={{ top: overlay.top, left: overlay.left, height: overlay.height }} />
      <span className="gsm-guide-v gsm-guide-v-ref" style={{ top: overlay.top, left: overlay.defaultRight, height: overlay.height }}>
        <span className="gsm-guide-tag">{m.toolbar.resizeDefaultGuide(Math.round(resize.defaultWidth))}</span>
      </span>
      <span className="gsm-guide-v" style={{ top: overlay.top, left: overlay.right, height: overlay.height }} />
      <span
        className={cn('gsm-px-badge', {
          snap: resize.snappedToDefault || resize.atDefaultWidth,
          limit: resize.atMinWidth,
        })}
        style={{ left: overlay.right, top: overlay.top - 26 }}
      >
        {Math.round(resize.liveWidth)}px
        {(resize.atDefaultWidth || resize.atMinWidth) && (
          <span className="u"> · {resize.atDefaultWidth ? m.toolbar.resizeBadgeDefault : m.toolbar.resizeBadgeMin}</span>
        )}
      </span>
      <span className="gsm-delta-badge" style={{ left: overlay.right, top: overlay.top + overlay.height - 8 }}>
        {resize.delta >= 0 ? '+' : ''}{Math.round(resize.delta)}px
        <span className="u"> · {m.toolbar.resizeDeltaCurrentOnly}</span>
      </span>
    </div>
  );
});

export function LayoutOverflowIndicator({ overflowPx }: { overflowPx: number }) {
  if (overflowPx <= 0) return null;

  return <span className="gsm-ov-edge" data-layout-overflow-edge aria-hidden="true" />;
}
