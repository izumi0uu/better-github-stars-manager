import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useManagerRuntime } from '@/ui/manager-runtime-context';
import type { ManagerPreferences } from '@/runtime/manager-runtime';
import { useI18n } from '@/i18n';
import {
  COLUMN_DEFS,
  DEFAULT_COLUMN_LAYOUT,
  INITIAL_CUSTOM_COLUMN_LAYOUT,
  beginCustomLayoutEditTransition,
  browseLayoutTransition,
  clampColumnWidth,
  clearColumnWidths,
  cloneColumnLayout,
  columnShiftTransforms,
  completeBrowseLayoutTransition,
  dragInsertIndex,
  fitColumnWidthsToContainer,
  gridTemplateFor,
  hiddenColumnIdsInCanonicalOrder,
  hideColumn,
  layoutsEqual,
  moveColumn,
  normalizedColumnWidth,
  normalizeColumnLayoutMode,
  normalizeColumnLayout,
  normalizeStoredColumnLayoutPreference,
  resetColumnLayout,
  restoreColumn,
  resizeSnapshot,
  tableMinWidthFor,
  trayInsertIndex,
  visibleColumnIds,
  widthsFromRects,
  type ColumnId,
  type ColumnLayout,
  type ColumnLayoutMode,
  type ColumnRect,
} from '@/ui/column-layout';
import {
  COLUMN_GAP_PX,
  COLUMN_KEYBOARD_RESIZE_LARGE_STEP_PX,
  COLUMN_KEYBOARD_RESIZE_STEP_PX,
  LAYOUT_MODE_TABLE_PREPARE_MS,
  LAYOUT_MODE_TABLE_TRANSITION_MS,
  RESTORE_FLASH_DURATION_MS,
  TRAY_DRAG_MOVE_THRESHOLD_PX,
  TRAY_RESTORE_HEADER_BUFFER_PX,
  type LayoutModeTableTransitionPhase,
} from '@/ui/layout-edit-constants';
import {
  LayoutResizeTool,
  type LayoutResizeLiveAdapter,
  type LayoutResizeSession,
} from '@/ui/layout-resize-tool';
import {
  bindLayoutColumnMenuDismissal,
  isInsideLayoutColumnMenuPath,
  useLayoutColumnMenuPosition,
} from '@/ui/hooks/use-layout-column-menu';
export type { LayoutResizeLiveAdapter, LayoutResizeLiveState } from '@/ui/layout-resize-tool';
export { bindLayoutColumnMenuDismissal, isInsideLayoutColumnMenuPath };

function reportLayoutPersistenceFailure(action: string, error: unknown) {
  console.warn('[GSM] failed to persist layout preference:', action, error instanceof Error ? error.message : String(error));
}

type LayoutDrag =
  | {
      kind: 'column';
      id: ColumnId;
      label: string;
      pointerId: number;
      captureTarget: HTMLElement;
      rects: ColumnRect[];
      headerTop: number;
      headerBottom: number;
      insertIndex: number | null;
      headerLeft: number;
      headerRight: number;
      startY: number;
      trayIntent: boolean;
      hideIntent: boolean;
      x: number;
      y: number;
    }
  | {
      kind: 'tray';
      id: ColumnId;
      label: string;
      pointerId: number;
      captureTarget: HTMLElement;
      rects: ColumnRect[];
      headerTop: number;
      headerBottom: number;
      headerLeft: number;
      headerRight: number;
      insertIndex: number | null;
      caretX: number | null;
      moved: boolean;
      startX: number;
      startY: number;
      x: number;
      y: number;
    };

type LayoutResize = LayoutResizeSession;

export function useColumnLayoutEditor(
  rootRef: RefObject<HTMLDivElement | null>,
  layoutStageRef?: RefObject<HTMLElement | null>,
  layoutResizeLiveAdapterRef?: RefObject<LayoutResizeLiveAdapter | null>,
) {
  const runtime = useManagerRuntime();
  const { m } = useI18n();
  const [layoutMode, setLayoutMode] = useState<ColumnLayoutMode>('default');
  const [savedCustomLayout, setSavedCustomLayout] = useState<ColumnLayout | null>(null);
  const [draftLayout, setDraftLayout] = useState<ColumnLayout>(() => normalizeColumnLayout(INITIAL_CUSTOM_COLUMN_LAYOUT));
  const [editingLayout, setEditingLayout] = useState(false);
  const [previewingCustomLayout, setPreviewingCustomLayout] = useState(false);
  const [layoutDrag, setLayoutDrag] = useState<LayoutDrag | null>(null);
  const [layoutResize, setLayoutResize] = useState<LayoutResize | null>(null);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [renderedBrowseLayout, setRenderedBrowseLayout] = useState<ColumnLayout>(() => cloneColumnLayout(DEFAULT_COLUMN_LAYOUT));
  const [layoutFaded, setLayoutFaded] = useState(false);
  const [layoutModeTransitionPhase, setLayoutModeTransitionPhase] = useState<LayoutModeTableTransitionPhase>('idle');
  const [layoutConfigReady, setLayoutConfigReady] = useState(false);
  const [layoutEditReady, setLayoutEditReady] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [flashedColumn, setFlashedColumn] = useState<ColumnId | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutModePrepareTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutModeTransitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBrowseLayout = useRef<ColumnLayout | null>(null);
  const configSynced = useRef(false);
  const configLoaded = useRef(false);
  const preEditMode = useRef<ColumnLayoutMode>('default');
  const headerRef = useRef<HTMLDivElement>(null);
  const editColumnsButtonRef = useRef<HTMLButtonElement>(null);
  const hideDropZoneRef = useRef<HTMLDivElement>(null);
  const layoutDragRef = useRef<LayoutDrag | null>(null);
  const layoutResizeRef = useRef<LayoutResize | null>(null);
  const layoutResizeToolRef = useRef<LayoutResizeTool | null>(null);
  const editingLayoutRef = useRef(false);
  const suppressTrayClick = useRef(false);

  const customLayout = savedCustomLayout ?? DEFAULT_COLUMN_LAYOUT;
  const browseTargetLayout = previewingCustomLayout || layoutMode === 'custom'
    ? customLayout
    : DEFAULT_COLUMN_LAYOUT;
  const activeLayout = editingLayout ? draftLayout : renderedBrowseLayout;
  const showRepositoryOwner = activeLayout.showRepositoryOwner !== false;
  const showRepositoryAvatar = activeLayout.showRepositoryAvatar !== false;
  const displayLayout = layoutResize
    ? normalizeColumnLayout({ ...draftLayout, widths: { ...draftLayout.widths, ...layoutResize.liveWidths } })
    : activeLayout;
  const visibleColumns = useMemo(() => visibleColumnIds(activeLayout), [activeLayout]);
  const gridTemplateColumns = useMemo(() => gridTemplateFor(displayLayout), [displayLayout]);
  const tableMinWidth = useMemo(() => tableMinWidthFor(displayLayout), [displayLayout]);
  const hiddenTrayColumns = useMemo(() => hiddenColumnIdsInCanonicalOrder(draftLayout), [draftLayout]);
  const customLayoutDirty = savedCustomLayout != null && !layoutsEqual(savedCustomLayout, DEFAULT_COLUMN_LAYOUT);
  const hiddenColumnCount = (editingLayout ? draftLayout : customLayout).hidden.length;
  const dragGhost = layoutDrag
    ? {
        label: layoutDrag.label,
        hint: layoutDrag.kind === 'column'
          ? layoutDrag.hideIntent
            ? m.toolbar.dragHideHint(layoutDrag.label)
            : m.toolbar.dragColumnHint
          : layoutDrag.insertIndex == null
            ? m.toolbar.dragTrayHint
            : m.toolbar.dragInsertHint,
        x: layoutDrag.x,
        y: layoutDrag.y,
        hideIntent: layoutDrag.kind === 'column' && layoutDrag.hideIntent,
      }
    : null;
  const columnShifts = useMemo(
    () => layoutDrag?.kind === 'column' && !layoutDrag.hideIntent && layoutDrag.insertIndex != null
      ? columnShiftTransforms(layoutDrag.rects, layoutDrag.id, layoutDrag.insertIndex, COLUMN_GAP_PX)
      : {},
    [layoutDrag],
  );
  const trayOpen = draftLayout.hidden.length > 0 || (layoutDrag?.kind === 'column' && layoutDrag.trayIntent);
  const trayDropReady = layoutDrag?.kind === 'column' && layoutDrag.hideIntent;
  const trayCaretX = layoutDrag?.kind === 'tray' ? layoutDrag.caretX : null;

  useEffect(() => {
    editingLayoutRef.current = editingLayout;
  }, [editingLayout]);

  useEffect(() => {
    let cancelled = false;
    const applyConfig = (
      config: ManagerPreferences,
      options: { hydrate: boolean },
    ) => {
      if (cancelled) return;
      const isFirstConfigSync = !configSynced.current;
      if (options.hydrate && !isFirstConfigSync) return;
      const nextMode = normalizeColumnLayoutMode(config.columnLayoutMode);
      const nextCustomLayout = normalizeStoredColumnLayoutPreference(config.customColumnLayout);
      const nextBrowseLayout = nextMode === 'custom'
        ? nextCustomLayout ?? DEFAULT_COLUMN_LAYOUT
        : DEFAULT_COLUMN_LAYOUT;
      const shouldHydrateBrowseLayout = options.hydrate && isFirstConfigSync && !editingLayoutRef.current;
      configSynced.current = true;
      configLoaded.current = true;
      setLayoutConfigReady(true);
      setLayoutEditReady(true);

      setSavedCustomLayout(nextCustomLayout);
      setLayoutMode(nextMode);
      if (editingLayoutRef.current) return;
      setPreviewingCustomLayout(false);
      setDraftLayout(cloneColumnLayout(nextCustomLayout ?? DEFAULT_COLUMN_LAYOUT));
      if (shouldHydrateBrowseLayout) {
        setRenderedBrowseLayout(cloneColumnLayout(nextBrowseLayout));
        setLayoutFaded(false);
      }
    };
    const recoverConfigSync = () => {
      if (cancelled || configSynced.current) return;
      configSynced.current = true;
      setLayoutConfigReady(true);
    };

    void runtime.readPreferences()
      .then((config) => applyConfig(config, { hydrate: true }))
      .catch(recoverConfigSync);

    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind !== 'preferences' && event.kind !== 'reset') return;
      void runtime.readPreferences()
        .then((config) => applyConfig(config, { hydrate: false }))
        .catch(recoverConfigSync);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runtime]);

  const dismissColumnMenu = useCallback(() => setColumnMenuOpen(false), []);
  const columnMenuPosition = useLayoutColumnMenuPosition({
    open: columnMenuOpen,
    rootRef,
    triggerRef: editColumnsButtonRef,
    onDismiss: dismissColumnMenu,
  });

  useEffect(() => {
    if (layoutFadeTimer.current) clearTimeout(layoutFadeTimer.current);
    layoutFadeTimer.current = null;
    pendingBrowseLayout.current = null;
    const transition = browseLayoutTransition(browseTargetLayout, renderedBrowseLayout, {
      editing: editingLayout,
      prefersReducedMotion,
    });
    if (transition.kind === 'idle') return;
    if (transition.kind === 'settled') {
      setLayoutFaded(false);
      return;
    }
    if (transition.kind === 'instant') {
      setRenderedBrowseLayout(transition.renderedLayout);
      setLayoutFaded(false);
      return;
    }
    setLayoutFaded(true);
    pendingBrowseLayout.current = cloneColumnLayout(browseTargetLayout);
    layoutFadeTimer.current = setTimeout(() => {
      const target = pendingBrowseLayout.current;
      if (!target) return;
      const next = completeBrowseLayoutTransition(target);
      setRenderedBrowseLayout(next.renderedLayout);
      setLayoutFaded(next.faded);
      layoutFadeTimer.current = null;
      pendingBrowseLayout.current = null;
    }, transition.delayMs);
    return () => {
      if (layoutFadeTimer.current) clearTimeout(layoutFadeTimer.current);
      layoutFadeTimer.current = null;
      pendingBrowseLayout.current = null;
    };
  }, [browseTargetLayout, editingLayout, prefersReducedMotion, renderedBrowseLayout]);

  const clearLayoutModeTableTransition = () => {
    if (layoutModePrepareTimer.current) clearTimeout(layoutModePrepareTimer.current);
    if (layoutModeTransitionTimer.current) clearTimeout(layoutModeTransitionTimer.current);
    layoutModePrepareTimer.current = null;
    layoutModeTransitionTimer.current = null;
  };

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => {
      setPrefersReducedMotion(query.matches);
      if (!query.matches) return;
      clearLayoutModeTableTransition();
      setLayoutModeTransitionPhase('idle');
    };
    updatePreference();
    query.addEventListener('change', updatePreference);
    return () => query.removeEventListener('change', updatePreference);
  }, []);

  const startLayoutModeTableTransition = () => {
    clearLayoutModeTableTransition();
    if (prefersReducedMotion) {
      setLayoutModeTransitionPhase('idle');
      return;
    }

    setLayoutModeTransitionPhase('pre-enter');
    layoutModePrepareTimer.current = setTimeout(() => {
      layoutModePrepareTimer.current = null;
      setLayoutModeTransitionPhase('entering');
      layoutModeTransitionTimer.current = setTimeout(() => {
        layoutModeTransitionTimer.current = null;
        setLayoutModeTransitionPhase('idle');
      }, LAYOUT_MODE_TABLE_TRANSITION_MS);
    }, LAYOUT_MODE_TABLE_PREPARE_MS);
  };

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (layoutFadeTimer.current) clearTimeout(layoutFadeTimer.current);
    clearLayoutModeTableTransition();
    pendingBrowseLayout.current = null;
  }, []);

  const setBrowseLayoutMode = (mode: ColumnLayoutMode) => {
    if (!configSynced.current) return;
    if (layoutResizeRef.current) return;
    setPreviewingCustomLayout(false);
    setLayoutMode(mode);
    void runtime.updatePreferences({ columnLayoutMode: mode }).catch((error) => {
      reportLayoutPersistenceFailure('set browse mode', error);
    });
  };

  const previewCustomLayout = (previewing: boolean) => {
    if (!configSynced.current) return;
    if (!editingLayout && layoutMode === 'default') setPreviewingCustomLayout(previewing);
  };

  const beginCustomLayoutEdit = () => {
    if (!configLoaded.current) return;
    if (layoutResizeRef.current) return;
    const edit = beginCustomLayoutEditTransition(customLayout);
    if (layoutFadeTimer.current) clearTimeout(layoutFadeTimer.current);
    layoutFadeTimer.current = null;
    pendingBrowseLayout.current = null;
    preEditMode.current = layoutMode;
    startLayoutModeTableTransition();
    setPreviewingCustomLayout(edit.previewingCustomLayout);
    setLayoutMode(edit.layoutMode);
    setDraftLayout(edit.draftLayout);
    setRenderedBrowseLayout(edit.renderedLayout);
    setLayoutFaded(edit.layoutFaded);
    setEditingLayout(edit.editingLayout);
    setColumnMenuOpen(false);
  };

  useEffect(() => {
    if (!editingLayout) return;
    const frame = requestAnimationFrame(() => editColumnsButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editingLayout]);

  const blockLayoutMutationDuringResize = () => {
    if (!layoutResizeRef.current) return false;
    setColumnMenuOpen(false);
    return true;
  };

  const saveLayoutEdit = async () => {
    if (blockLayoutMutationDuringResize()) return;
    const next = normalizeColumnLayout(draftLayout);
    const nextSavedCustomLayout = layoutsEqual(next, DEFAULT_COLUMN_LAYOUT) ? null : next;
    try {
      await runtime.updatePreferences({
        columnLayoutMode: 'custom',
        customColumnLayout: nextSavedCustomLayout,
      });
    } catch (error) {
      reportLayoutPersistenceFailure('save edit', error);
      return;
    }
    startLayoutModeTableTransition();
    setSavedCustomLayout(nextSavedCustomLayout);
    setDraftLayout(cloneColumnLayout(next));
    setRenderedBrowseLayout(cloneColumnLayout(next));
    setLayoutFaded(false);
    setLayoutMode('custom');
    setEditingLayout(false);
    setLayoutDrag(null);
    setLayoutResize(null);
    setColumnMenuOpen(false);
  };

  const cancelLayoutEdit = () => {
    if (blockLayoutMutationDuringResize()) return;
    const nextBrowseLayout = preEditMode.current === 'custom' ? customLayout : DEFAULT_COLUMN_LAYOUT;
    startLayoutModeTableTransition();
    setDraftLayout(cloneColumnLayout(customLayout));
    setRenderedBrowseLayout(cloneColumnLayout(nextBrowseLayout));
    setLayoutFaded(false);
    setEditingLayout(false);
    setLayoutMode(preEditMode.current);
    setPreviewingCustomLayout(false);
    setLayoutDrag(null);
    setLayoutResize(null);
    setColumnMenuOpen(false);
  };

  const resetLayoutEdit = () => {
    if (blockLayoutMutationDuringResize()) return;
    setDraftLayout(resetColumnLayout());
    setColumnMenuOpen(false);
  };

  const resetLayoutWidths = () => {
    if (blockLayoutMutationDuringResize()) return;
    setDraftLayout((current) => clearColumnWidths(current));
    setColumnMenuOpen(false);
  };

  const setColumnHidden = (id: ColumnId, hidden: boolean) => {
    if (blockLayoutMutationDuringResize()) return;
    setDraftLayout((current) => (hidden ? hideColumn(current, id) : restoreColumnWithMeasuredWidth(current, id)));
  };

  const setRepositoryOwnerVisible = (visible: boolean) => {
    if (blockLayoutMutationDuringResize()) return;
    setDraftLayout((current) => normalizeColumnLayout({
      ...current,
      showRepositoryOwner: visible ? undefined : false,
    }));
  };

  const setRepositoryAvatarVisible = (visible: boolean) => {
    if (blockLayoutMutationDuringResize()) return;
    setDraftLayout((current) => normalizeColumnLayout({
      ...current,
      showRepositoryAvatar: visible ? undefined : false,
    }));
  };

  const flashColumn = (id: ColumnId) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashedColumn(id);
    flashTimer.current = setTimeout(() => setFlashedColumn(null), RESTORE_FLASH_DURATION_MS);
  };

  const restoreHiddenColumn = (id: ColumnId) => {
    if (blockLayoutMutationDuringResize()) return;
    if (layoutDragRef.current || suppressTrayClick.current) return;
    setDraftLayout((current) => restoreColumnWithMeasuredWidth(current, id));
    flashColumn(id);
  };

  const measureHeader = () => {
    const header = headerRef.current;
    if (!header) return null;
    const headerRect = header.getBoundingClientRect();
    const rects = visibleColumnIds(draftLayout)
      .map((id) => {
        const cell = header.querySelector<HTMLElement>(`[data-header-col="${id}"]`);
        if (!cell) return null;
        const rect = cell.getBoundingClientRect();
        return { id, left: rect.left, width: rect.width, mid: rect.left + rect.width / 2 };
      })
      .filter((rect): rect is ColumnRect => rect !== null);
    if (rects.length === 0) return null;
    return {
      rects,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
    };
  };

  const isColumnHideIntent = (drag: Extract<LayoutDrag, { kind: 'column' }>, clientX: number, clientY: number) => {
    if (Math.abs(clientY - drag.startY) <= TRAY_RESTORE_HEADER_BUFFER_PX) return false;
    if (
      clientY >= drag.headerTop &&
      clientY <= drag.headerBottom &&
      clientX >= drag.headerLeft &&
      clientX <= drag.headerRight
    ) {
      return false;
    }
    const dropZone = hideDropZoneRef.current;
    if (!dropZone) return false;
    const rect = dropZone.getBoundingClientRect();
    return rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
  };

  const measureResizeSnapshot = () => {
    const measured = measureHeader();
    return measured ? widthsFromRects(measured.rects) : null;
  };

  const restoreColumnWithMeasuredWidth = (layout: ColumnLayout, id: ColumnId, insertIndex?: number) => {
    const restored = restoreColumn(layout, id, insertIndex);
    if (COLUMN_DEFS[id].locked || normalizedColumnWidth(id, restored.widths?.[id]) != null) return restored;
    if (!layout.widths || Object.keys(layout.widths).length === 0) return restored;

    const measuredSnapshot = measureResizeSnapshot() ?? {};
    const widths = visibleColumnIds(restored).reduce<Partial<Record<ColumnId, number>>>((next, columnId) => {
      if (COLUMN_DEFS[columnId].locked) return next;
      const width = normalizedColumnWidth(columnId, measuredSnapshot[columnId] ?? layout.widths?.[columnId])
        ?? (columnId === id ? COLUMN_DEFS[columnId].minWidth : null);
      if (width != null) next[columnId] = width;
      return next;
    }, {});

    return normalizeColumnLayout({
      ...restored,
      widths: { ...layout.widths, ...widths },
    });
  };

  const getResizeContainerWidth = () => {
    const stage = layoutStageRef?.current;
    if (stage?.clientWidth) return stage.clientWidth;
    const header = headerRef.current;
    if (!header) return 0;
    return header.parentElement?.clientWidth || Math.round(header.getBoundingClientRect().width);
  };

  const caretXForInsert = (rects: ColumnRect[], index: number, headerLeft: number) => {
    if (index <= 0) return Math.max(0, Math.round(rects[0].left - headerLeft - COLUMN_GAP_PX / 2));
    const previous = rects[Math.min(index - 1, rects.length - 1)];
    if (index >= rects.length) return Math.round(previous.left + previous.width - headerLeft + COLUMN_GAP_PX / 2);
    return Math.round(rects[index].left - headerLeft - COLUMN_GAP_PX / 2);
  };

  const beginColumnDrag = (e: ReactPointerEvent<HTMLElement>, id: ColumnId) => {
    if (!editingLayout || layoutResizeRef.current || COLUMN_DEFS[id].locked || e.button !== 0 || e.isPrimary === false) return;
    const measured = measureHeader();
    if (!measured) return;
    e.preventDefault();
    e.stopPropagation();
    const captureTarget = e.currentTarget;
    captureTarget.setPointerCapture?.(e.pointerId);
    setColumnMenuOpen(false);
    setLayoutDrag({
      kind: 'column',
      id,
      label: COLUMN_DEFS[id].label(m),
      pointerId: e.pointerId,
      captureTarget,
      rects: measured.rects,
      headerTop: measured.headerTop,
      headerBottom: measured.headerBottom,
      headerLeft: measured.headerLeft,
      headerRight: measured.headerRight,
      startY: e.clientY,
      trayIntent: false,
      insertIndex: null,
      hideIntent: false,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const beginTrayDrag = (e: ReactPointerEvent<HTMLElement>, id: ColumnId) => {
    if (!editingLayout || layoutResizeRef.current || e.button !== 0 || e.isPrimary === false) return;
    const measured = measureHeader();
    if (!measured) return;
    e.preventDefault();
    e.stopPropagation();
    const captureTarget = e.currentTarget;
    captureTarget.setPointerCapture?.(e.pointerId);
    setColumnMenuOpen(false);
    setLayoutDrag({
      kind: 'tray',
      id,
      label: COLUMN_DEFS[id].label(m),
      pointerId: e.pointerId,
      captureTarget,
      rects: measured.rects,
      headerTop: measured.headerTop,
      headerBottom: measured.headerBottom,
      headerLeft: measured.headerLeft,
      headerRight: measured.headerRight,
      insertIndex: null,
      caretX: null,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const clearLayoutDrag = () => {
    const drag = layoutDragRef.current;
    if (drag?.captureTarget.hasPointerCapture?.(drag.pointerId)) {
      drag.captureTarget.releasePointerCapture?.(drag.pointerId);
    }
    setLayoutDrag(null);
  };

  const getLayoutResizeTool = () => {
    if (!layoutResizeToolRef.current) {
      layoutResizeToolRef.current = new LayoutResizeTool({
        getSession: () => layoutResizeRef.current,
        setSession: (session, options) => {
          layoutResizeRef.current = session;
          if (options.render) setLayoutResize(session);
        },
        getAdapter: () => layoutResizeLiveAdapterRef?.current ?? null,
        onCommit: (liveWidths) => {
          setDraftLayout((current) => normalizeColumnLayout({
            ...current,
            widths: { ...current.widths, ...liveWidths },
          }));
        },
        onStart: () => setColumnMenuOpen(false),
      });
    }
    return layoutResizeToolRef.current;
  };

  const beginColumnResize = (e: ReactPointerEvent<HTMLElement>, id: ColumnId) => {
    if (!editingLayout || layoutResizeRef.current || layoutDragRef.current || COLUMN_DEFS[id].locked || e.button !== 0 || e.isPrimary === false) return;
    const frozenWidths = measureResizeSnapshot();
    if (!frozenWidths?.[id]) return;
    getLayoutResizeTool().onPointerDown({
      event: e,
      id,
      frozenWidths,
      defaultWidth: normalizedColumnWidth(id, draftLayout.widths?.[id]) ?? frozenWidths[id],
    });
  };

  const moveColumnByKeyboard = (id: ColumnId, direction: -1 | 1) => {
    if (!editingLayout || layoutResizeRef.current || layoutDragRef.current || COLUMN_DEFS[id].locked) return;
    setDraftLayout((current) => {
      const visible = visibleColumnIds(current);
      const index = visible.indexOf(id);
      if (index < 0) return current;
      const targetIndex = index + direction;
      const lockedStart = visible.findIndex((columnId) => COLUMN_DEFS[columnId].locked);
      if (targetIndex < 0 || (lockedStart >= 0 && targetIndex >= lockedStart)) return current;
      return moveColumn(current, id, direction < 0 ? index - 1 : index + 1);
    });
    setColumnMenuOpen(false);
  };

  const resizeColumnByKeyboard = (id: ColumnId, direction: -1 | 1, largeStep = false) => {
    if (!editingLayout || layoutResizeRef.current || layoutDragRef.current || COLUMN_DEFS[id].locked) return;
    const snapshot = measureResizeSnapshot();
    const startWidth = normalizedColumnWidth(id, draftLayout.widths?.[id]) ?? snapshot?.[id];
    if (!snapshot || startWidth == null) return;
    const delta = direction * (largeStep ? COLUMN_KEYBOARD_RESIZE_LARGE_STEP_PX : COLUMN_KEYBOARD_RESIZE_STEP_PX);
    setDraftLayout((current) => normalizeColumnLayout({
      ...current,
      widths: {
        ...current.widths,
        ...resizeSnapshot({ ...snapshot, [id]: startWidth }, id, delta, startWidth),
      },
    }));
    setColumnMenuOpen(false);
  };

  const fitLayoutWidths = () => {
    if (blockLayoutMutationDuringResize()) return;
    const snapshot = measureResizeSnapshot();
    const containerWidth = getResizeContainerWidth();
    if (!snapshot || containerWidth <= 0) return;
    setDraftLayout((current) => fitColumnWidthsToContainer(
      normalizeColumnLayout({ ...current, widths: { ...current.widths, ...snapshot } }),
      containerWidth,
    ));
    setColumnMenuOpen(false);
  };

  const autoFitColumnWidth = (id: ColumnId) => {
    if (blockLayoutMutationDuringResize()) return;
    if (!editingLayout || COLUMN_DEFS[id].locked) return;
    const snapshot = measureResizeSnapshot();
    if (!snapshot?.[id]) return;
    const header = headerRef.current;
    let measuredWidth = 0;
    const headerLabel = header?.querySelector<HTMLElement>(`[data-header-label="${id}"]`);
    if (headerLabel) measuredWidth = Math.max(measuredWidth, headerLabel.scrollWidth);
    rootRef.current
      ?.querySelectorAll<HTMLElement>(`[data-row-col="${id}"]`)
      .forEach((cell) => {
        measuredWidth = Math.max(measuredWidth, cell.scrollWidth);
      });
    const targetWidth = clampColumnWidth(id, measuredWidth + 28);
    setDraftLayout((current) => normalizeColumnLayout({
      ...current,
      widths: { ...current.widths, ...snapshot, [id]: targetWidth },
    }));
  };

  const finishLayoutDrag = (commit: boolean) => {
    const drag = layoutDragRef.current;
    if (!drag) return;
    if (drag.kind === 'tray') {
      suppressTrayClick.current = true;
      window.setTimeout(() => {
        suppressTrayClick.current = false;
      }, 0);
    }
    if (commit) {
      if (drag.kind === 'column') {
        if (drag.hideIntent) {
          setDraftLayout((current) => hideColumn(current, drag.id));
        } else if (drag.insertIndex != null) {
          setDraftLayout((current) => moveColumn(current, drag.id, drag.insertIndex!));
        }
      } else if (!drag.moved) {
        setDraftLayout((current) => restoreColumnWithMeasuredWidth(current, drag.id));
        flashColumn(drag.id);
      } else if (drag.insertIndex != null) {
        setDraftLayout((current) => restoreColumnWithMeasuredWidth(current, drag.id, drag.insertIndex!));
        flashColumn(drag.id);
      }
    }
    clearLayoutDrag();
  };

  useEffect(() => {
    layoutDragRef.current = layoutDrag;
  }, [layoutDrag]);

  useEffect(() => {
    layoutResizeRef.current = layoutResize;
  }, [layoutResize]);

  useEffect(() => {
    if (!layoutDrag) return;
    document.body.classList.add('gsm-dragging-any');
    const onMove = (e: PointerEvent) => {
      setLayoutDrag((current) => {
        if (!current) return null;
        if (e.pointerId !== current.pointerId) return current;
        if (current.kind === 'column') {
          const trayIntent = Math.abs(e.clientY - current.startY) > TRAY_RESTORE_HEADER_BUFFER_PX;
          const hideIntent = trayIntent && isColumnHideIntent(current, e.clientX, e.clientY);
          return {
            ...current,
            x: e.clientX,
            y: e.clientY,
            trayIntent,
            hideIntent,
            insertIndex: hideIntent ? null : dragInsertIndex(current.rects, current.id, e.clientX),
          };
        }

        const moved = current.moved ||
          Math.hypot(e.clientX - current.startX, e.clientY - current.startY) > TRAY_DRAG_MOVE_THRESHOLD_PX;
        const inHeader =
          e.clientY >= current.headerTop - TRAY_RESTORE_HEADER_BUFFER_PX &&
          e.clientY <= current.headerBottom + TRAY_RESTORE_HEADER_BUFFER_PX &&
          e.clientX >= current.headerLeft &&
          e.clientX <= current.headerRight;
        const insertIndex = moved && inHeader ? trayInsertIndex(current.rects, e.clientX) : null;
        const headerLeft = headerRef.current?.getBoundingClientRect().left ?? 0;
        return {
          ...current,
          x: e.clientX,
          y: e.clientY,
          moved,
          insertIndex,
          caretX: insertIndex == null ? null : caretXForInsert(current.rects, insertIndex, headerLeft),
        };
      });
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== layoutDragRef.current?.pointerId) return;
      finishLayoutDrag(true);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== layoutDragRef.current?.pointerId) return;
      finishLayoutDrag(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      finishLayoutDrag(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      const drag = layoutDragRef.current;
      if (drag?.captureTarget.hasPointerCapture?.(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture?.(drag.pointerId);
      }
      document.body.classList.remove('gsm-dragging-any');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutDrag !== null]);

  useEffect(() => {
    if (!layoutResize) return;
    const tool = getLayoutResizeTool();
    document.body.classList.add('gsm-resizing-column');
    const onMove = (e: PointerEvent) => tool.onPointerMove(e);
    const onUp = (e: PointerEvent) => tool.onPointerUp(e);
    const onCancel = (e: PointerEvent) => tool.onPointerCancel(e);
    const onKey = (e: KeyboardEvent) => tool.onKeyDown(e);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      tool.disposeActiveGesture();
      document.body.classList.remove('gsm-resizing-column');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutResize !== null]);

  return {
    layoutMode,
    editingLayout,
    layoutConfigReady,
    layoutEditReady,
    previewingCustomLayout,
    draftLayout,
    showRepositoryOwner,
    showRepositoryAvatar,
    visibleColumns,
    gridTemplateColumns,
    tableMinWidth,
    hiddenTrayColumns,
    customLayoutDirty,
    hiddenColumnCount,
    dragGhost,
    layoutDrag,
    layoutResize,
    columnShifts,
    trayOpen,
    trayDropReady,
    trayCaretX,
    layoutFaded,
    layoutModeTransitionPhase,
    flashedColumn,
    columnMenuOpen,
    columnMenuPosition,
    headerRef,
    hideDropZoneRef,
    editColumnsButtonRef,
    setBrowseLayoutMode,
    previewCustomLayout,
    beginCustomLayoutEdit,
    saveLayoutEdit,
    cancelLayoutEdit,
    resetLayoutEdit,
    resetLayoutWidths,
    setColumnHidden,
    setRepositoryOwnerVisible,
    setRepositoryAvatarVisible,
    beginColumnDrag,
    beginColumnResize,
    moveColumnByKeyboard,
    resizeColumnByKeyboard,
    autoFitColumnWidth,
    fitLayoutWidths,
    beginTrayDrag,
    restoreHiddenColumn,
    toggleColumnMenu: () => {
      if (blockLayoutMutationDuringResize()) return;
      setColumnMenuOpen((open) => !open);
    },
  };
}
