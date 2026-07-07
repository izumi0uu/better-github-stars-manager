import type { MessageCatalog } from '@/i18n';
import {
  COLUMN_DEFS,
  COLUMN_GRID_PADDING_PX,
  normalizedColumnWidth,
  type ColumnId,
} from '@/ui/column-layout';
import { COLUMN_GAP_PX } from '@/ui/layout-edit-constants';
import type { LayoutResizeLiveState } from '@/ui/layout-resize-tool';

export type LayoutViewportState = {
  panelWidth: number;
  tableWidth: number;
  overflowPx: number;
};

export type LayoutResizeOverlayState = {
  top: number;
  left: number;
  width: number;
  right: number;
  defaultRight: number;
  height: number;
};

type GridMetrics = LayoutViewportState & {
  gridTemplateColumns: string;
  minWidth: number | undefined;
};

type LayoutResizeSurfaceContext = {
  visibleColumns: ColumnId[];
  tableShell: HTMLElement | null;
  readoutRoot: HTMLElement | null;
  header: HTMLElement | null;
  stage: HTMLElement | null;
  m: MessageCatalog;
};

type LiveNodes = {
  colHilite: HTMLElement | null;
  stableRail: HTMLElement | null;
  refGuide: HTMLElement | null;
  liveGuide: HTMLElement | null;
  pxBadge: HTMLElement | null;
  deltaBadge: HTMLElement | null;
  staticOverflowEdge: HTMLElement | null;
  liveOverflowEdge: HTMLElement | null;
  widthReadout: HTMLElement | null;
};

type SurfaceCache = {
  id: ColumnId;
  visibleColumns: ColumnId[];
  tableShell: HTMLElement;
  header: HTMLElement;
  rows: HTMLElement[];
  panelWidth: number;
  activeLeft: number;
  overlayTop: number;
  overlayHeight: number;
  defaultRight: number;
  initialMetrics: Pick<GridMetrics, 'gridTemplateColumns' | 'minWidth'>;
  nodes: LiveNodes;
  lastMetrics: Pick<GridMetrics, 'gridTemplateColumns' | 'minWidth'> | null;
};

type MeasuredResizeGeometry = {
  context: LayoutResizeSurfaceContext & {
    tableShell: HTMLElement;
    header: HTMLElement;
    stage: HTMLElement;
  };
  activeLeft: number;
  overlay: LayoutResizeOverlayState | null;
};

export function layoutResizeOverlayFromRects({
  shellRect,
  stageRect,
  activeRect,
  defaultWidth,
}: {
  shellRect: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>;
  stageRect: Pick<DOMRect, 'top' | 'bottom'>;
  activeRect: Pick<DOMRect, 'left' | 'width'>;
  defaultWidth: number;
}): LayoutResizeOverlayState | null {
  const visibleTop = Math.max(shellRect.top, stageRect.top);
  const visibleBottom = Math.min(shellRect.bottom, stageRect.bottom);
  if (shellRect.width <= 0 || visibleBottom <= visibleTop) return null;
  const left = Math.round(activeRect.left - shellRect.left);
  const width = Math.round(activeRect.width);
  return {
    top: Math.round(visibleTop - shellRect.top),
    left,
    width,
    right: left + width,
    defaultRight: left + defaultWidth,
    height: Math.round(visibleBottom - visibleTop),
  };
}

export function layoutViewportFromMeasurements({
  panelWidth,
  headerScrollWidth,
  headerRectWidth,
  tableMinWidth,
}: {
  panelWidth: number;
  headerScrollWidth: number;
  headerRectWidth: number;
  tableMinWidth: number | undefined;
}): LayoutViewportState {
  const measuredTableWidth = Math.round(headerScrollWidth || headerRectWidth);
  const tableWidth = tableMinWidth == null
    ? measuredTableWidth
    : Math.max(tableMinWidth, measuredTableWidth);
  return {
    panelWidth,
    tableWidth,
    overflowPx: Math.max(0, Math.round(tableWidth - panelWidth)),
  };
}

export function layoutResizeLiveMetrics({
  visibleColumns,
  liveWidths,
  panelWidth,
}: {
  visibleColumns: ColumnId[];
  liveWidths: Partial<Record<ColumnId, number>>;
  panelWidth: number;
}): GridMetrics {
  let total = COLUMN_GRID_PADDING_PX + COLUMN_GAP_PX * Math.max(0, visibleColumns.length - 1);
  let hasNumericWidthForEveryTrack = true;
  const tracks = visibleColumns.map((id) => {
    const liveWidth = normalizedColumnWidth(id, liveWidths[id]);
    if (liveWidth != null) {
      total += liveWidth;
      return `${liveWidth}px`;
    }

    const fixedWidth = fixedPxFromTrack(COLUMN_DEFS[id].width);
    if (fixedWidth != null) total += fixedWidth;
    else hasNumericWidthForEveryTrack = false;
    return COLUMN_DEFS[id].width;
  });
  const minWidth = hasNumericWidthForEveryTrack ? Math.round(total) : undefined;
  const tableWidth = minWidth ?? 0;

  return {
    gridTemplateColumns: tracks.join(' '),
    minWidth,
    panelWidth,
    tableWidth,
    overflowPx: minWidth == null ? 0 : Math.max(0, Math.round(minWidth - panelWidth)),
  };
}

function fixedPxFromTrack(track: string): number | null {
  const match = track.match(/^(\d+(?:\.\d+)?)px$/);
  return match ? Number(match[1]) : null;
}

export class LayoutResizeSurface {
  private context: LayoutResizeSurfaceContext | null = null;
  private cache: SurfaceCache | null = null;

  configure(context: LayoutResizeSurfaceContext): void {
    this.context = context;
  }

  measureStart(resize: LayoutResizeLiveState): LayoutResizeOverlayState | null {
    const measured = this.measureGeometry(resize);
    if (!measured) return null;
    const { context, activeLeft, overlay } = measured;
    this.cache = {
      id: resize.id,
      visibleColumns: [...context.visibleColumns],
      tableShell: context.tableShell,
      header: context.header,
      rows: [...context.tableShell.querySelectorAll<HTMLElement>('[data-layout-row-grid]')],
      panelWidth: context.stage.clientWidth,
      activeLeft,
      overlayTop: overlay?.top ?? 0,
      overlayHeight: overlay?.height ?? 0,
      defaultRight: overlay?.defaultRight ?? activeLeft + resize.defaultWidth,
      initialMetrics: {
        gridTemplateColumns: context.header.style.gridTemplateColumns,
        minWidth: pxNumberFromStyle(context.header.style.minWidth),
      },
      nodes: this.readLiveNodes(context.tableShell, context.readoutRoot),
      lastMetrics: null,
    };
    return overlay;
  }

  refreshLiveNodes(): void {
    if (!this.cache || !this.context) return;
    this.cache.nodes = this.readLiveNodes(this.cache.tableShell, this.context.readoutRoot);
  }

  refreshVisibleRows(): void {
    const cache = this.cache;
    if (!cache) return;
    cache.rows = [...cache.tableShell.querySelectorAll<HTMLElement>('[data-layout-row-grid]')];
    const lastMetrics = cache.lastMetrics;
    if (!lastMetrics) return;
    cache.rows.forEach((row) => applyGridMetrics(row, lastMetrics));
  }

  refreshGeometry(resize: LayoutResizeLiveState): LayoutResizeOverlayState | null {
    const cache = this.cache;
    if (!cache) return this.measureStart(resize);

    const measured = this.measureGeometry(resize);
    if (!measured) return null;
    const { context, activeLeft, overlay } = measured;

    cache.activeLeft = activeLeft;
    cache.overlayTop = overlay?.top ?? 0;
    cache.overlayHeight = overlay?.height ?? 0;
    cache.defaultRight = overlay?.defaultRight ?? activeLeft + resize.defaultWidth;
    cache.panelWidth = context.stage.clientWidth;
    return overlay;
  }

  private measureGeometry(resize: LayoutResizeLiveState): MeasuredResizeGeometry | null {
    const context = this.context;
    if (!context?.tableShell || !context.header || !context.stage) return null;
    const measuredContext: MeasuredResizeGeometry['context'] = {
      ...context,
      tableShell: context.tableShell,
      header: context.header,
      stage: context.stage,
    };
    const activeCell = context.header.querySelector<HTMLElement>(`[data-header-col="${resize.id}"]`);
    if (!activeCell) return null;

    const shellRect = context.tableShell.getBoundingClientRect();
    const stageRect = context.stage.getBoundingClientRect();
    const activeRect = activeCell.getBoundingClientRect();
    const overlay = layoutResizeOverlayFromRects({ shellRect, stageRect, activeRect, defaultWidth: resize.defaultWidth });
    const activeLeft = overlay?.left ?? Math.round(activeRect.left - shellRect.left);
    return {
      context: measuredContext,
      activeLeft,
      overlay,
    };
  }

  paint(resize: LayoutResizeLiveState): void {
    if (!this.cache || this.cache.id !== resize.id) this.measureStart(resize);
    const cache = this.cache;
    const context = this.context;
    if (!cache || !context) return;

    const metrics = layoutResizeLiveMetrics({
      visibleColumns: cache.visibleColumns,
      liveWidths: resize.liveWidths,
      panelWidth: cache.panelWidth,
    });
    cache.lastMetrics = metrics;
    applyGridMetrics(cache.header, metrics);
    cache.rows.forEach((row) => applyGridMetrics(row, metrics));
    this.paintOverlay(cache, resize, context.m);
    this.paintOverflow(cache, metrics.overflowPx);
    this.paintReadout(cache, resize, metrics, context.m);
  }

  cleanup(outcome: 'commit' | 'cancel'): void {
    const cache = this.cache;
    if (!cache) return;
    if (outcome === 'cancel') {
      applyGridMetrics(cache.header, cache.initialMetrics);
      cache.rows.forEach((row) => applyGridMetrics(row, cache.initialMetrics));
    }
    resetLiveOverflowElements(cache.tableShell);
    this.cache = null;
  }

  private readLiveNodes(tableShell: HTMLElement, readoutRoot: HTMLElement | null): LiveNodes {
    const liveGuide = [...tableShell.querySelectorAll<HTMLElement>('.gsm-guide-v')]
      .find((element) => !element.classList.contains('gsm-guide-v-ref')) ?? null;
    return {
      colHilite: tableShell.querySelector<HTMLElement>('.gsm-col-hilite'),
      stableRail: tableShell.querySelector<HTMLElement>('.gsm-stable-rail'),
      refGuide: tableShell.querySelector<HTMLElement>('.gsm-guide-v-ref'),
      liveGuide,
      pxBadge: tableShell.querySelector<HTMLElement>('.gsm-px-badge'),
      deltaBadge: tableShell.querySelector<HTMLElement>('.gsm-delta-badge'),
      staticOverflowEdge: tableShell.querySelector<HTMLElement>('[data-layout-overflow-edge]'),
      liveOverflowEdge: tableShell.querySelector<HTMLElement>('[data-layout-live-overflow-edge]'),
      widthReadout: readoutRoot?.querySelector<HTMLElement>('[data-layout-width-readout]')
        ?? tableShell.querySelector<HTMLElement>('[data-layout-width-readout]'),
    };
  }

  private paintOverlay(cache: SurfaceCache, resize: LayoutResizeLiveState, m: MessageCatalog): void {
    const overlay = {
      top: cache.overlayTop,
      left: cache.activeLeft,
      width: Math.round(resize.liveWidth),
      right: cache.activeLeft + Math.round(resize.liveWidth),
      defaultRight: cache.defaultRight,
      height: cache.overlayHeight,
    };
    const { nodes } = cache;
    if (nodes.colHilite) Object.assign(nodes.colHilite.style, { top: `${overlay.top}px`, left: `${overlay.left}px`, width: `${overlay.width}px`, height: `${overlay.height}px` });
    if (nodes.stableRail) Object.assign(nodes.stableRail.style, { top: `${overlay.top}px`, left: `${overlay.left}px`, height: `${overlay.height}px` });
    if (nodes.refGuide) Object.assign(nodes.refGuide.style, { top: `${overlay.top}px`, left: `${overlay.defaultRight}px`, height: `${overlay.height}px` });
    if (nodes.liveGuide) Object.assign(nodes.liveGuide.style, { top: `${overlay.top}px`, left: `${overlay.right}px`, height: `${overlay.height}px` });
    if (nodes.pxBadge) {
      nodes.pxBadge.style.left = `${overlay.right}px`;
      nodes.pxBadge.style.top = `${overlay.top - 26}px`;
      nodes.pxBadge.classList.toggle('snap', resize.snappedToDefault || resize.atDefaultWidth);
      nodes.pxBadge.classList.toggle('limit', resize.atMinWidth);
      let suffix: string | null = null;
      if (resize.atDefaultWidth) {
        suffix = m.toolbar.resizeBadgeDefault;
      } else if (resize.atMinWidth) {
        suffix = m.toolbar.resizeBadgeMin;
      }
      replaceBadgeText(nodes.pxBadge, `${Math.round(resize.liveWidth)}px`, suffix);
    }
    if (nodes.deltaBadge) {
      nodes.deltaBadge.style.left = `${overlay.right}px`;
      nodes.deltaBadge.style.top = `${overlay.top + overlay.height - 8}px`;
      replaceBadgeText(nodes.deltaBadge, `${resize.delta >= 0 ? '+' : ''}${Math.round(resize.delta)}px`, m.toolbar.resizeDeltaCurrentOnly);
    }
  }

  private paintOverflow(cache: SurfaceCache, overflowPx: number): void {
    let { liveOverflowEdge, staticOverflowEdge } = cache.nodes;
    if (overflowPx <= 0) {
      hideOrRemoveLiveOverflowElement(liveOverflowEdge ?? staticOverflowEdge);
      cache.nodes.liveOverflowEdge = null;
      return;
    }
    if (!liveOverflowEdge && !staticOverflowEdge) {
      liveOverflowEdge = document.createElement('span');
      liveOverflowEdge.className = 'gsm-ov-edge';
      liveOverflowEdge.setAttribute('aria-hidden', 'true');
      liveOverflowEdge.dataset.layoutLiveOverflowEdge = '';
      cache.tableShell.appendChild(liveOverflowEdge);
      cache.nodes.liveOverflowEdge = liveOverflowEdge;
    }
    const edge = liveOverflowEdge ?? staticOverflowEdge;
    if (edge) edge.hidden = false;
  }

  private paintReadout(cache: SurfaceCache, resize: LayoutResizeLiveState, metrics: GridMetrics, m: MessageCatalog): void {
    const { widthReadout } = cache.nodes;
    if (!widthReadout) return;
    const label = COLUMN_DEFS[resize.id].label(m);
    widthReadout.textContent = m.toolbar.resizeLiveWidthReadout(
      label,
      Math.round(resize.liveWidth),
      Math.round(resize.delta),
      metrics.tableWidth,
      metrics.panelWidth,
      metrics.overflowPx,
    );
  }
}

export function paintLayoutResizeLive({ resize, visibleColumns, tableShell, readoutRoot, header, stage, m }: LayoutResizeSurfaceContext & { resize: LayoutResizeLiveState }): void {
  const surface = new LayoutResizeSurface();
  surface.configure({ visibleColumns, tableShell, readoutRoot, header, stage, m });
  surface.measureStart(resize);
  surface.refreshLiveNodes();
  surface.paint(resize);
}

function applyGridMetrics(element: HTMLElement, metrics: Pick<GridMetrics, 'gridTemplateColumns' | 'minWidth'>): void {
  element.style.gridTemplateColumns = metrics.gridTemplateColumns;
  element.style.minWidth = metrics.minWidth == null ? '' : `${metrics.minWidth}px`;
}

function replaceBadgeText(element: HTMLElement, value: string, suffix: string | null): void {
  element.replaceChildren(document.createTextNode(value));
  if (!suffix) return;
  const muted = document.createElement('span');
  muted.className = 'u';
  muted.textContent = ` · ${suffix}`;
  element.appendChild(muted);
}

function hideOrRemoveLiveOverflowElement(element: HTMLElement | null): void {
  if (!element) return;
  if (element.dataset.layoutLiveOverflowEdge != null) {
    element.remove();
    return;
  }
  element.hidden = true;
}

export function resetLiveOverflowElements(tableShell: HTMLElement | null): void {
  if (!tableShell) return;
  tableShell
    .querySelectorAll<HTMLElement>('[data-layout-live-overflow-edge]')
    .forEach((element) => element.remove());
  tableShell
    .querySelectorAll<HTMLElement>('[data-layout-overflow-edge]')
    .forEach((element) => {
      element.hidden = false;
    });
}

function pxNumberFromStyle(value: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)px$/);
  return match ? Number(match[1]) : undefined;
}
