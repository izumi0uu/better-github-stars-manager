import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import { useI18n } from '@/i18n';
import {
  COLUMN_DEFS,
  DEFAULT_COLUMN_LAYOUT,
  INITIAL_CUSTOM_COLUMN_LAYOUT,
  beginCustomLayoutEditTransition,
  browseLayoutTransition,
  cloneColumnLayout,
  columnShiftTransforms,
  completeBrowseLayoutTransition,
  dragInsertIndex,
  gridTemplateFor,
  hiddenColumnIdsInCanonicalOrder,
  hideColumn,
  isColumnHideIntent,
  layoutsEqual,
  moveColumn,
  normalizeColumnLayoutMode,
  normalizeColumnLayout,
  normalizeStoredColumnLayoutPreference,
  resetColumnLayout,
  restoreColumn,
  trayInsertIndex,
  visibleColumnIds,
  type ColumnId,
  type ColumnLayout,
  type ColumnLayoutMode,
  type ColumnRect,
} from '@/ui/column-layout';
import {
  COLUMN_GAP_PX,
  COLUMN_MENU_EDGE_GUARD_PX,
  COLUMN_MENU_TRIGGER_GAP_PX,
  COLUMN_MENU_WIDTH_PX,
  RESTORE_FLASH_DURATION_MS,
  TRAY_DRAG_MOVE_THRESHOLD_PX,
  TRAY_RESTORE_HEADER_BUFFER_PX,
} from '@/ui/layout-edit-constants';

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

export function isInsideLayoutColumnMenuPath(path: readonly EventTarget[]) {
  return path.some((node) => (
    node instanceof Element &&
    node.closest('[data-layout-column-menu]') !== null
  ));
}

export function bindLayoutColumnMenuDismissal(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  onDismiss: () => void,
) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onDismiss();
  };
  const onPointerDown = (e: PointerEvent) => {
    if (isInsideLayoutColumnMenuPath(e.composedPath())) return;
    onDismiss();
  };

  target.addEventListener('keydown', onKey);
  target.addEventListener('pointerdown', onPointerDown);

  return () => {
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('pointerdown', onPointerDown);
  };
}

export function useColumnLayoutEditor(rootRef: RefObject<HTMLDivElement | null>) {
  const { m } = useI18n();
  const [layoutMode, setLayoutMode] = useState<ColumnLayoutMode>('default');
  const [savedCustomLayout, setSavedCustomLayout] = useState<ColumnLayout | null>(null);
  const [draftLayout, setDraftLayout] = useState<ColumnLayout>(() => normalizeColumnLayout(INITIAL_CUSTOM_COLUMN_LAYOUT));
  const [editingLayout, setEditingLayout] = useState(false);
  const [previewingCustomLayout, setPreviewingCustomLayout] = useState(false);
  const [layoutDrag, setLayoutDrag] = useState<LayoutDrag | null>(null);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [renderedBrowseLayout, setRenderedBrowseLayout] = useState<ColumnLayout>(() => cloneColumnLayout(DEFAULT_COLUMN_LAYOUT));
  const [layoutFaded, setLayoutFaded] = useState(false);
  const [layoutConfigReady, setLayoutConfigReady] = useState(false);
  const [layoutEditReady, setLayoutEditReady] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [flashedColumn, setFlashedColumn] = useState<ColumnId | null>(null);
  const [columnMenuPosition, setColumnMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBrowseLayout = useRef<ColumnLayout | null>(null);
  const configSynced = useRef(false);
  const configLoaded = useRef(false);
  const preEditMode = useRef<ColumnLayoutMode>('default');
  const headerRef = useRef<HTMLDivElement>(null);
  const editColumnsButtonRef = useRef<HTMLButtonElement>(null);
  const layoutDragRef = useRef<LayoutDrag | null>(null);
  const editingLayoutRef = useRef(false);
  const suppressTrayClick = useRef(false);

  const customLayout = savedCustomLayout ?? DEFAULT_COLUMN_LAYOUT;
  const browseTargetLayout = previewingCustomLayout || layoutMode === 'custom'
    ? customLayout
    : DEFAULT_COLUMN_LAYOUT;
  const activeLayout = editingLayout ? draftLayout : renderedBrowseLayout;
  const visibleColumns = useMemo(() => visibleColumnIds(activeLayout), [activeLayout]);
  const gridTemplateColumns = useMemo(() => gridTemplateFor(activeLayout), [activeLayout]);
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
  const trayOpen = draftLayout.hidden.length > 0 || (layoutDrag?.kind === 'column' && layoutDrag.hideIntent);
  const trayDropReady = layoutDrag?.kind === 'column' && layoutDrag.hideIntent;
  const trayCaretX = layoutDrag?.kind === 'tray' ? layoutDrag.caretX : null;

  useEffect(() => {
    editingLayoutRef.current = editingLayout;
  }, [editingLayout]);

  useEffect(() => {
    let cancelled = false;
    const applyConfig = (
      config: Awaited<ReturnType<typeof authStore.getConfig>>,
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

    void authStore.getConfig().then((config) => applyConfig(config, { hydrate: true })).catch(recoverConfigSync);

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !changes[CONFIG_STORAGE_KEY]?.newValue) return;
      applyConfig(changes[CONFIG_STORAGE_KEY].newValue, { hydrate: false });
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    if (!columnMenuOpen) return;
    return bindLayoutColumnMenuDismissal(window, () => setColumnMenuOpen(false));
  }, [columnMenuOpen]);

  useLayoutEffect(() => {
    if (!columnMenuOpen) {
      setColumnMenuPosition(null);
      return;
    }

    const updatePosition = () => {
      const root = rootRef.current;
      const trigger = editColumnsButtonRef.current;
      if (!root || !trigger) return;
      const rootRect = root.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      setColumnMenuPosition({
        left: Math.max(
          COLUMN_MENU_EDGE_GUARD_PX,
          Math.min(
            triggerRect.left - rootRect.left,
            rootRect.width - COLUMN_MENU_WIDTH_PX - COLUMN_MENU_EDGE_GUARD_PX,
          ),
        ),
        top: triggerRect.bottom - rootRect.top + COLUMN_MENU_TRIGGER_GAP_PX,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [columnMenuOpen, rootRef]);

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

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(query.matches);
    updatePreference();
    query.addEventListener('change', updatePreference);
    return () => query.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (layoutFadeTimer.current) clearTimeout(layoutFadeTimer.current);
    pendingBrowseLayout.current = null;
  }, []);

  const setBrowseLayoutMode = (mode: ColumnLayoutMode) => {
    if (!configSynced.current) return;
    setPreviewingCustomLayout(false);
    setLayoutMode(mode);
    void authStore.update({ columnLayoutMode: mode }).catch((error) => {
      reportLayoutPersistenceFailure('set browse mode', error);
    });
  };

  const previewCustomLayout = (previewing: boolean) => {
    if (!configSynced.current) return;
    if (!editingLayout && layoutMode === 'default') setPreviewingCustomLayout(previewing);
  };

  const beginCustomLayoutEdit = () => {
    if (!configLoaded.current) return;
    const edit = beginCustomLayoutEditTransition(customLayout);
    if (layoutFadeTimer.current) clearTimeout(layoutFadeTimer.current);
    layoutFadeTimer.current = null;
    pendingBrowseLayout.current = null;
    preEditMode.current = layoutMode;
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

  const saveLayoutEdit = async () => {
    const next = normalizeColumnLayout(draftLayout);
    const nextSavedCustomLayout = layoutsEqual(next, DEFAULT_COLUMN_LAYOUT) ? null : next;
    try {
      await authStore.update({
        columnLayoutMode: 'custom',
        customColumnLayout: nextSavedCustomLayout,
      });
    } catch (error) {
      reportLayoutPersistenceFailure('save edit', error);
      return;
    }
    setSavedCustomLayout(nextSavedCustomLayout);
    setDraftLayout(cloneColumnLayout(next));
    setRenderedBrowseLayout(cloneColumnLayout(next));
    setLayoutFaded(false);
    setLayoutMode('custom');
    setEditingLayout(false);
    setLayoutDrag(null);
    setColumnMenuOpen(false);
  };

  const cancelLayoutEdit = () => {
    setDraftLayout(cloneColumnLayout(customLayout));
    setEditingLayout(false);
    setLayoutMode(preEditMode.current);
    setPreviewingCustomLayout(false);
    setLayoutDrag(null);
    setColumnMenuOpen(false);
  };

  const resetLayoutEdit = () => {
    setDraftLayout(resetColumnLayout());
    setColumnMenuOpen(false);
  };

  const setColumnHidden = (id: ColumnId, hidden: boolean) => {
    setDraftLayout((current) => (hidden ? hideColumn(current, id) : restoreColumn(current, id)));
  };

  const flashColumn = (id: ColumnId) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashedColumn(id);
    flashTimer.current = setTimeout(() => setFlashedColumn(null), RESTORE_FLASH_DURATION_MS);
  };

  const restoreHiddenColumn = (id: ColumnId) => {
    if (layoutDragRef.current || suppressTrayClick.current) return;
    setDraftLayout((current) => restoreColumn(current, id));
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

  const caretXForInsert = (rects: ColumnRect[], index: number, headerLeft: number) => {
    if (index <= 0) return Math.max(0, Math.round(rects[0].left - headerLeft - COLUMN_GAP_PX / 2));
    const previous = rects[Math.min(index - 1, rects.length - 1)];
    if (index >= rects.length) return Math.round(previous.left + previous.width - headerLeft + COLUMN_GAP_PX / 2);
    return Math.round(rects[index].left - headerLeft - COLUMN_GAP_PX / 2);
  };

  const beginColumnDrag = (e: ReactPointerEvent<HTMLElement>, id: ColumnId) => {
    if (!editingLayout || COLUMN_DEFS[id].locked || e.button !== 0) return;
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
      insertIndex: null,
      hideIntent: false,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const beginTrayDrag = (e: ReactPointerEvent<HTMLElement>, id: ColumnId) => {
    if (!editingLayout || e.button !== 0) return;
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
        setDraftLayout((current) => restoreColumn(current, drag.id));
        flashColumn(drag.id);
      } else if (drag.insertIndex != null) {
        setDraftLayout((current) => restoreColumn(current, drag.id, drag.insertIndex!));
        flashColumn(drag.id);
      }
    }
    clearLayoutDrag();
  };

  useEffect(() => {
    layoutDragRef.current = layoutDrag;
  }, [layoutDrag]);

  useEffect(() => {
    if (!layoutDrag) return;
    document.body.classList.add('gsm-dragging-any');
    const onMove = (e: PointerEvent) => {
      setLayoutDrag((current) => {
        if (!current) return null;
        if (e.pointerId !== current.pointerId) return current;
        if (current.kind === 'column') {
          const hideIntent = isColumnHideIntent(e.clientY, current.headerTop, current.headerBottom);
          return {
            ...current,
            x: e.clientX,
            y: e.clientY,
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

  return {
    layoutMode,
    editingLayout,
    layoutConfigReady,
    layoutEditReady,
    previewingCustomLayout,
    draftLayout,
    visibleColumns,
    gridTemplateColumns,
    hiddenTrayColumns,
    customLayoutDirty,
    hiddenColumnCount,
    dragGhost,
    layoutDrag,
    columnShifts,
    trayOpen,
    trayDropReady,
    trayCaretX,
    layoutFaded,
    flashedColumn,
    columnMenuOpen,
    columnMenuPosition,
    headerRef,
    editColumnsButtonRef,
    setBrowseLayoutMode,
    previewCustomLayout,
    beginCustomLayoutEdit,
    saveLayoutEdit,
    cancelLayoutEdit,
    resetLayoutEdit,
    setColumnHidden,
    beginColumnDrag,
    beginTrayDrag,
    restoreHiddenColumn,
    toggleColumnMenu: () => setColumnMenuOpen((open) => !open),
  };
}
