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
  'favorite',
  'notes',
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

export type ColumnLayout = {
  order: ColumnId[];
  hidden: ColumnId[];
};

export type ColumnLayoutMode = 'default' | 'custom';

export type ColumnDefinition = {
  id: ColumnId;
  width: string;
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

export const COLUMN_DEFS: Record<ColumnId, ColumnDefinition> = {
  repository: {
    id: 'repository',
    width: 'minmax(180px,1.4fr)',
    label: (m) => m.toolbar.columnRepository,
  },
  description: {
    id: 'description',
    width: '2fr',
    label: (m) => m.toolbar.columnDescription,
  },
  language: {
    id: 'language',
    width: '80px',
    label: (m) => m.toolbar.columnLanguage,
  },
  stars: {
    id: 'stars',
    width: '64px',
    align: 'end',
    label: (m) => m.toolbar.columnStars,
  },
  updated: {
    id: 'updated',
    width: '84px',
    label: (m) => m.toolbar.columnUpdated,
  },
  created: {
    id: 'created',
    width: '84px',
    label: (m) => m.toolbar.columnCreated,
  },
  tags: {
    id: 'tags',
    width: '1.6fr',
    label: (m) => m.toolbar.columnTags,
  },
  favorite: {
    id: 'favorite',
    width: '28px',
    locked: true,
    align: 'center',
    label: (m) => m.toolbar.columnFavorite,
  },
  notes: {
    id: 'notes',
    width: '20px',
    locked: true,
    align: 'center',
    label: (m) => m.toolbar.columnNotes,
  },
};

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
  return visibleColumnIds(layout).map((id) => COLUMN_DEFS[id].width).join(' ');
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
  return { order: moveLockedColumnsToEnd(order), hidden };
}

export function normalizeColumnLayoutMode(value: unknown): ColumnLayoutMode {
  return value === 'custom' ? 'custom' : 'default';
}

export function normalizeStoredColumnLayoutPreference(value: unknown): ColumnLayout | null {
  if (!value || typeof value !== 'object') return null;
  const layout = value as { order?: unknown; hidden?: unknown };
  if (!Array.isArray(layout.order) || !Array.isArray(layout.hidden)) return null;
  const normalized = normalizeColumnLayout({
    order: layout.order as ColumnId[],
    hidden: layout.hidden as ColumnId[],
  });
  return layoutsEqual(normalized, DEFAULT_COLUMN_LAYOUT) ? null : normalized;
}

export function cloneColumnLayout(layout: ColumnLayout): ColumnLayout {
  return { order: [...layout.order], hidden: [...layout.hidden] };
}

export function layoutsEqual(a: ColumnLayout, b: ColumnLayout): boolean {
  return (
    a.order.join('|') === b.order.join('|') &&
    a.hidden.join('|') === b.hidden.join('|')
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
  });
}

export function resetColumnLayout(): ColumnLayout {
  return cloneColumnLayout(DEFAULT_COLUMN_LAYOUT);
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
