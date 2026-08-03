import type { MessageCatalog } from '@/i18n';
import {
  BROWSE_LAYOUT_FADE_DELAY_MS,
  COLUMN_GAP_PX,
  COLUMN_HIDE_INTENT_DISTANCE_PX,
} from '@/ui/layout-edit-constants';

export const COLUMN_IDS = [
  'repository',
  'description',
  'language',
  'stars',
  'updated',
  'created',
  'tags',
  'starAction',
  'favorite',
  'notes',
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

export type ColumnLayout = {
  order: ColumnId[];
  hidden: ColumnId[];
  widths?: Partial<Record<ColumnId, number>>;
};

export type ColumnLayoutMode = 'default' | 'custom';

export type ColumnDefinition = {
  id: ColumnId;
  width: string;
  minWidth: number;
  maxWidth?: number;
  locked?: boolean;
  align?: 'start' | 'end' | 'center';
  label: (m: MessageCatalog) => string;
};

export type ColumnRect = {
  id: ColumnId;
  left: number;
  width: number;
  mid: number;
};

export type BrowseLayoutTransition =
  | { kind: 'idle' }
  | { kind: 'settled' }
  | { kind: 'instant'; renderedLayout: ColumnLayout }
  | { kind: 'fade'; delayMs: number };

export type CustomLayoutEditTransition = {
  layoutMode: 'custom';
  preEditMode: 'custom';
  draftLayout: ColumnLayout;
  renderedLayout: ColumnLayout;
  previewingCustomLayout: false;
  layoutFaded: false;
  editingLayout: true;
};

export const COLUMN_DEFS: Record<ColumnId, ColumnDefinition> = {
  repository: {
    id: 'repository',
    width: 'minmax(180px,1.4fr)',
    minWidth: 180,
    label: (m) => m.toolbar.columnRepository,
  },
  description: {
    id: 'description',
    width: '2fr',
    minWidth: 120,
    label: (m) => m.toolbar.columnDescription,
  },
  language: {
    id: 'language',
    width: '80px',
    minWidth: 64,
    label: (m) => m.toolbar.columnLanguage,
  },
  stars: {
    id: 'stars',
    width: '64px',
    minWidth: 48,
    align: 'start',
    label: (m) => m.toolbar.columnStars,
  },
  updated: {
    id: 'updated',
    width: '84px',
    minWidth: 72,
    label: (m) => m.toolbar.columnUpdated,
  },
  created: {
    id: 'created',
    width: '84px',
    minWidth: 84,
    label: (m) => m.toolbar.columnCreated,
  },
  tags: {
    id: 'tags',
    width: '1.6fr',
    minWidth: 100,
    label: (m) => m.toolbar.columnTags,
  },
  starAction: {
    id: 'starAction',
    width: '32px',
    minWidth: 32,
    locked: true,
    align: 'center',
    label: (m) => m.toolbar.columnStarAction,
  },
  favorite: {
    id: 'favorite',
    width: '28px',
    minWidth: 28,
    locked: true,
    align: 'center',
    label: (m) => m.toolbar.columnFavorite,
  },
  notes: {
    id: 'notes',
    width: '20px',
    minWidth: 20,
    locked: true,
    align: 'center',
    label: (m) => m.toolbar.columnNotes,
  },
};

export const COLUMN_WIDTH_MAX_PX = 720;
export const COLUMN_WIDTH_SNAP_PX = 6;
export const COLUMN_GRID_PADDING_PX = 24;

export const DEFAULT_COLUMN_LAYOUT: ColumnLayout = {
  order: [...COLUMN_IDS],
  hidden: [],
};

export const INITIAL_CUSTOM_COLUMN_LAYOUT: ColumnLayout = {
  order: [...COLUMN_IDS],
  hidden: [],
};

export function visibleColumnIds(layout: ColumnLayout): ColumnId[] {
  const hidden = new Set(layout.hidden);
  return layout.order.filter((id) => !hidden.has(id));
}

export function hiddenColumnIdsInCanonicalOrder(layout: ColumnLayout): ColumnId[] {
  const hidden = new Set(layout.hidden);
  return COLUMN_IDS.filter((id) => hidden.has(id));
}

export function gridTemplateFor(layout: ColumnLayout): string {
  return visibleColumnIds(layout).map((id) => {
    const width = normalizedColumnWidth(id, layout.widths?.[id]);
    return width == null ? COLUMN_DEFS[id].width : `${width}px`;
  }).join(' ');
}

export function normalizeColumnLayout(layout: ColumnLayout): ColumnLayout {
  const seen = new Set<ColumnId>();
  const order = layout.order.filter((id): id is ColumnId => {
    if (!COLUMN_IDS.includes(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  COLUMN_IDS.forEach((id) => {
    if (!seen.has(id)) order.push(id);
  });
  const seenHidden = new Set<ColumnId>();
  const hidden = layout.hidden.filter((id): id is ColumnId => {
    if (!COLUMN_IDS.includes(id) || COLUMN_DEFS[id].locked || seenHidden.has(id)) return false;
    seenHidden.add(id);
    return true;
  });
  const normalized = { order: moveLockedColumnsToEnd(order), hidden };
  const widths = normalizeColumnWidths(layout.widths);
  return Object.keys(widths).length > 0 ? { ...normalized, widths } : normalized;
}

export function normalizeColumnLayoutMode(value: unknown): ColumnLayoutMode {
  return value === 'custom' ? 'custom' : 'default';
}

export function normalizeStoredColumnLayoutPreference(value: unknown): ColumnLayout | null {
  if (!value || typeof value !== 'object') return null;
  const layout = value as { order?: unknown; hidden?: unknown; widths?: unknown };
  if (!Array.isArray(layout.order) || !Array.isArray(layout.hidden)) return null;
  const normalized = normalizeColumnLayout({
    order: layout.order as ColumnId[],
    hidden: layout.hidden as ColumnId[],
    widths: layout.widths as Partial<Record<ColumnId, number>> | undefined,
  });
  return layoutsEqual(normalized, DEFAULT_COLUMN_LAYOUT) ? null : normalized;
}

export function cloneColumnLayout(layout: ColumnLayout): ColumnLayout {
  return {
    order: [...layout.order],
    hidden: [...layout.hidden],
    ...(layout.widths ? { widths: { ...layout.widths } } : {}),
  };
}

export function layoutsEqual(a: ColumnLayout, b: ColumnLayout): boolean {
  return (
    a.order.join('|') === b.order.join('|') &&
    a.hidden.join('|') === b.hidden.join('|') &&
    widthSignature(a.widths) === widthSignature(b.widths)
  );
}

export function moveColumn(layout: ColumnLayout, id: ColumnId, insertIndex: number): ColumnLayout {
  if (COLUMN_DEFS[id].locked) return layout;
  const visible = visibleColumnIds(layout).filter((columnId) => columnId !== id);
  const lockedStart = firstLockedIndex(visible);
  const safeIndex = lockedStart < 0 ? insertIndex : Math.min(insertIndex, lockedStart);
  visible.splice(Math.max(0, Math.min(safeIndex, visible.length)), 0, id);
  return {
    ...layout,
    order: mergeVisibleOrder(layout.order, visible),
  };
}

export function hideColumn(layout: ColumnLayout, id: ColumnId): ColumnLayout {
  if (COLUMN_DEFS[id].locked || layout.hidden.includes(id)) return layout;
  return normalizeColumnLayout({ ...layout, hidden: [...layout.hidden, id] });
}

export function restoreColumn(layout: ColumnLayout, id: ColumnId, insertIndex?: number): ColumnLayout {
  if (!layout.hidden.includes(id)) return layout;
  const hidden = layout.hidden.filter((columnId) => columnId !== id);
  const visible = visibleColumnIds({ ...layout, hidden });
  const withoutId = visible.filter((columnId) => columnId !== id);
  let at = insertIndex;
  if (at == null) {
    at = withoutId.findIndex((columnId) => COLUMN_IDS.indexOf(columnId) > COLUMN_IDS.indexOf(id));
    if (at < 0) at = withoutId.length;
  }
  const lockedStart = firstLockedIndex(withoutId);
  const safeIndex = lockedStart < 0 ? at : Math.min(at, lockedStart);
  withoutId.splice(Math.max(0, Math.min(safeIndex, withoutId.length)), 0, id);
  return normalizeColumnLayout({
    order: mergeVisibleOrder(layout.order, withoutId),
    hidden,
    widths: layout.widths,
  });
}

export function resetColumnLayout(): ColumnLayout {
  return cloneColumnLayout(DEFAULT_COLUMN_LAYOUT);
}

export function clearColumnWidths(layout: ColumnLayout): ColumnLayout {
  const { widths: _widths, ...rest } = layout;
  return cloneColumnLayout(rest);
}

export function tableMinWidthFor(layout: ColumnLayout): number | undefined {
  if (!layout.widths || Object.keys(layout.widths).length === 0) return undefined;
  const visible = visibleColumnIds(layout);
  let total = COLUMN_GRID_PADDING_PX + COLUMN_GAP_PX * Math.max(0, visible.length - 1);
  for (const id of visible) {
    const width = normalizedColumnWidth(id, layout.widths[id]) ?? fixedTrackWidth(id);
    if (width == null) return undefined;
    total += width;
  }
  return Math.round(total);
}

export function widthsFromRects(rects: ColumnRect[]): Partial<Record<ColumnId, number>> {
  return rects.reduce<Partial<Record<ColumnId, number>>>((widths, rect) => {
    if (!COLUMN_DEFS[rect.id].locked) widths[rect.id] = clampColumnWidth(rect.id, rect.width);
    return widths;
  }, {});
}

export function resizeSnapshot(
  frozenWidths: Partial<Record<ColumnId, number>>,
  id: ColumnId,
  deltaPx: number,
  defaultWidth?: number,
): Partial<Record<ColumnId, number>> {
  const start = normalizedColumnWidth(id, frozenWidths[id]) ?? COLUMN_DEFS[id].minWidth;
  let width = clampColumnWidth(id, start + deltaPx);
  if (defaultWidth != null && Math.abs(width - defaultWidth) <= COLUMN_WIDTH_SNAP_PX) {
    width = clampColumnWidth(id, defaultWidth);
  }
  return { ...frozenWidths, [id]: width };
}

export function fitColumnWidthsToContainer(
  layout: ColumnLayout,
  containerWidth: number,
): ColumnLayout {
  const minWidth = tableMinWidthFor(layout);
  if (!layout.widths || minWidth == null || minWidth <= containerWidth) return layout;
  const overflow = minWidth - containerWidth;
  const candidates = visibleColumnIds(layout)
    .filter((id) => !COLUMN_DEFS[id].locked && layout.widths?.[id] != null && fixedTrackWidth(id) == null)
    .map((id) => ({
      id,
      width: normalizedColumnWidth(id, layout.widths?.[id]) ?? COLUMN_DEFS[id].minWidth,
      min: COLUMN_DEFS[id].minWidth,
    }))
    .filter((item) => item.width > item.min);
  const capacity = candidates.reduce((sum, item) => sum + item.width - item.min, 0);
  if (capacity <= 0) return layout;
  const take = Math.min(overflow, capacity);
  const widths = { ...layout.widths };
  candidates.forEach((item) => {
    const share = take * ((item.width - item.min) / capacity);
    widths[item.id] = clampColumnWidth(item.id, item.width - share);
  });
  return normalizeColumnLayout({ ...layout, widths });
}

export function browseLayoutTransition(
  targetLayout: ColumnLayout,
  renderedLayout: ColumnLayout,
  {
    editing,
    prefersReducedMotion,
    fadeDelayMs = BROWSE_LAYOUT_FADE_DELAY_MS,
  }: {
    editing: boolean;
    prefersReducedMotion: boolean;
    fadeDelayMs?: number;
  },
): BrowseLayoutTransition {
  if (editing) return { kind: 'idle' };
  if (layoutsEqual(targetLayout, renderedLayout)) return { kind: 'settled' };
  if (prefersReducedMotion) return { kind: 'instant', renderedLayout: cloneColumnLayout(targetLayout) };
  return { kind: 'fade', delayMs: fadeDelayMs };
}

export function completeBrowseLayoutTransition(targetLayout: ColumnLayout): {
  renderedLayout: ColumnLayout;
  faded: false;
} {
  return { renderedLayout: cloneColumnLayout(targetLayout), faded: false };
}

export function beginCustomLayoutEditTransition(customLayout: ColumnLayout): CustomLayoutEditTransition {
  return {
    layoutMode: 'custom',
    preEditMode: 'custom',
    draftLayout: cloneColumnLayout(customLayout),
    renderedLayout: cloneColumnLayout(customLayout),
    previewingCustomLayout: false,
    layoutFaded: false,
    editingLayout: true,
  };
}

export function isColumnHideIntent(
  clientY: number,
  headerTop: number,
  headerBottom: number,
  hideDistancePx = COLUMN_HIDE_INTENT_DISTANCE_PX,
): boolean {
  return clientY > headerBottom + hideDistancePx || clientY < headerTop - hideDistancePx;
}

export function dragInsertIndex(rects: ColumnRect[], draggedId: ColumnId, clientX: number): number {
  const others = rects.filter((rect) => rect.id !== draggedId);
  let at = others.length;
  for (let i = 0; i < others.length; i += 1) {
    if (clientX < others[i].mid) {
      at = i;
      break;
    }
  }
  const lockedStart = firstLockedIndex(others.map((rect) => rect.id));
  return lockedStart < 0 ? at : Math.min(at, lockedStart);
}

export function trayInsertIndex(rects: ColumnRect[], clientX: number): number {
  let at = rects.length;
  for (let i = 0; i < rects.length; i += 1) {
    if (clientX < rects[i].mid) {
      at = i;
      break;
    }
  }
  const lockedStart = firstLockedIndex(rects.map((rect) => rect.id));
  return lockedStart < 0 ? at : Math.min(at, lockedStart);
}

export function columnShiftTransforms(
  rects: ColumnRect[],
  draggedId: ColumnId,
  insertIndex: number,
  gapPx = COLUMN_GAP_PX,
): Partial<Record<ColumnId, number>> {
  const dragged = rects.find((rect) => rect.id === draggedId);
  if (!dragged) return {};
  const others = rects.filter((rect) => rect.id !== draggedId);
  const nextOrder = [
    ...others.slice(0, insertIndex).map((rect) => rect.id),
    draggedId,
    ...others.slice(insertIndex).map((rect) => rect.id),
  ];
  let x = rects[0]?.left ?? 0;
  const nextLeft: Partial<Record<ColumnId, number>> = {};
  nextOrder.forEach((id) => {
    const rect = rects.find((item) => item.id === id);
    if (!rect) return;
    nextLeft[id] = x;
    x += rect.width + gapPx;
  });
  return others.reduce<Partial<Record<ColumnId, number>>>((shifts, rect) => {
    const left = nextLeft[rect.id];
    if (left == null) return shifts;
    const shift = Math.round(left - rect.left);
    if (shift !== 0) shifts[rect.id] = shift;
    return shifts;
  }, {});
}

function firstLockedIndex(ids: ColumnId[]): number {
  return ids.findIndex((id) => COLUMN_DEFS[id].locked);
}

function moveLockedColumnsToEnd(order: ColumnId[]): ColumnId[] {
  const unlocked = order.filter((id) => !COLUMN_DEFS[id].locked);
  const locked = COLUMN_IDS.filter((id) => COLUMN_DEFS[id].locked);
  return [...unlocked, ...locked];
}

function mergeVisibleOrder(baseOrder: ColumnId[], visibleOrder: ColumnId[]): ColumnId[] {
  const visible = new Set(visibleOrder);
  const hiddenInBaseOrder = baseOrder.filter((id) => !visible.has(id) && !COLUMN_DEFS[id].locked);
  return moveLockedColumnsToEnd([...visibleOrder, ...hiddenInBaseOrder]);
}

function normalizeColumnWidths(value: unknown): Partial<Record<ColumnId, number>> {
  if (!value || typeof value !== 'object') return {};
  const source = value as Partial<Record<ColumnId, unknown>>;
  return COLUMN_IDS.reduce<Partial<Record<ColumnId, number>>>((widths, id) => {
    if (COLUMN_DEFS[id].locked) return widths;
    const width = normalizedColumnWidth(id, source[id]);
    if (width != null) widths[id] = width;
    return widths;
  }, {});
}

export function normalizedColumnWidth(id: ColumnId, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return clampColumnWidth(id, value);
}

export function clampColumnWidth(id: ColumnId, value: number): number {
  const min = COLUMN_DEFS[id].minWidth;
  const max = COLUMN_DEFS[id].maxWidth ?? COLUMN_WIDTH_MAX_PX;
  return Math.round(Math.max(min, Math.min(max, value)));
}

function fixedTrackWidth(id: ColumnId): number | null {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(COLUMN_DEFS[id].width);
  return match ? Math.round(Number(match[1])) : null;
}

function widthSignature(widths: ColumnLayout['widths']): string {
  const normalized = normalizeColumnWidths(widths);
  return COLUMN_IDS
    .map((id) => (normalized[id] == null ? '' : `${id}:${normalized[id]}`))
    .filter(Boolean)
    .join('|');
}
