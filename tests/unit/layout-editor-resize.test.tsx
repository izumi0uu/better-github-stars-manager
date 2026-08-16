/**
 * @vitest-environment jsdom
 */
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@/types';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { COLUMN_DEFS, DEFAULT_COLUMN_LAYOUT, type ColumnId } from '@/ui/column-layout';
import { useColumnLayoutEditor, type LayoutResizeLiveAdapter, type LayoutResizeLiveState } from '@/ui/hooks/use-column-layout-editor';

const authMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials',
  authStore: authMocks,
}));
const runtime = new ExtensionManagerRuntime();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type LayoutEditorState = ReturnType<typeof useColumnLayoutEditor>;

const mountedRoots: Root[] = [];
const rectWidths: Record<ColumnId, number> = {
  repository: 240,
  description: 280,
  language: 80,
  stars: 64,
  updated: 84,
  created: 84,
  tags: 180,
  starAction: 32,
  favorite: 28,
  notes: 20,
};

let storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];

function baseConfig(): Config {
  return {
    columnLayoutMode: 'default',
    customColumnLayout: null,
  } as Config;
}

function eventWithPointer(
  type: string,
  init: { pointerId: number; clientX: number; clientY?: number; button?: number; isPrimary?: boolean },
) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    pointerId: number;
    clientX: number;
    clientY: number;
    button: number;
    isPrimary?: boolean;
  };
  event.pointerId = init.pointerId;
  event.clientX = init.clientX;
  event.clientY = init.clientY ?? 10;
  event.button = init.button ?? 0;
  event.isPrimary = init.isPrimary ?? true;
  return event;
}

function defineRect(element: HTMLElement, id: ColumnId, left: number) {
  const width = rectWidths[id];
  element.getBoundingClientRect = vi.fn(() => ({
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: 32,
    width,
    height: 32,
    toJSON: () => ({}),
  }));
}

function mountResizeHarness(
  config: Config = baseConfig(),
  liveAdapter?: ((resize: LayoutResizeLiveState) => void) | LayoutResizeLiveAdapter,
) {
  let latest: LayoutEditorState | null = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  authMocks.getConfig.mockResolvedValueOnce(config);

  function Harness() {
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const liveAdapterRef = useRef<LayoutResizeLiveAdapter | null>(null);
    liveAdapterRef.current = typeof liveAdapter === 'function'
      ? { paint: liveAdapter }
      : liveAdapter ?? null;
    const editor = useColumnLayoutEditor(rootRef, stageRef, liveAdapterRef);
    latest = editor;

    return (
      <div ref={rootRef}>
        <div ref={stageRef} data-testid="layout-stage" />
        <div ref={editor.hideDropZoneRef} data-testid="hide-drop-zone" />
        <div
          ref={editor.headerRef}
          data-testid="header"
          style={{ gridTemplateColumns: editor.gridTemplateColumns, minWidth: editor.tableMinWidth }}
        >
          {editor.visibleColumns.map((id) => (
            <span key={id} data-header-col={id}>
              <span data-header-label={id}>{COLUMN_DEFS[id].label({ toolbar: {} } as never)}</span>
              {!COLUMN_DEFS[id].locked && (
                <>
                  <button
                    type="button"
                    aria-label={`resize-${id}`}
                    onPointerDown={(e) => editor.beginColumnResize(e, id)}
                  />
                  <button
                    type="button"
                    aria-label={`drag-${id}`}
                    onPointerDown={(e) => editor.beginColumnDrag(e, id)}
                  />
                </>
              )}
            </span>
          ))}
        </div>
        <div
          data-testid="row"
          style={{ gridTemplateColumns: editor.gridTemplateColumns, minWidth: editor.tableMinWidth }}
        >
          {editor.visibleColumns.map((id) => (
            <span key={id} data-row-col={id}>cell {id}</span>
          ))}
        </div>
      </div>
    );
  }

  act(() => {
    root.render(<ManagerRuntimeProvider runtime={runtime}><Harness /></ManagerRuntimeProvider>);
  });
  mountedRoots.push(root);

  const measure = () => {
    const header = container.querySelector<HTMLElement>('[data-testid="header"]');
    if (!header) throw new Error('Expected header');
    const stage = container.querySelector<HTMLElement>('[data-testid="layout-stage"]');
    if (!stage) throw new Error('Expected layout stage');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 900 });
    header.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 32,
      width: 1200,
      height: 32,
      toJSON: () => ({}),
    }));
    const tray = container.querySelector<HTMLElement>('[data-testid="hide-drop-zone"]');
    if (!tray) throw new Error('Expected hide drop zone');
    tray.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: -48,
      left: 0,
      top: -48,
      right: 600,
      bottom: -8,
      width: 600,
      height: 40,
      toJSON: () => ({}),
    }));
    let left = 0;
    for (const id of DEFAULT_COLUMN_LAYOUT.order) {
      const cell = container.querySelector<HTMLElement>(`[data-header-col="${id}"]`);
      if (!cell) continue;
      defineRect(cell, id, left);
      left += rectWidths[id] + 8;
    }
  };

  return {
    container,
    measure,
    get current() {
      if (!latest) throw new Error('Layout editor did not render');
      return latest;
    },
  };
}

async function hydrateAndEdit(harness: ReturnType<typeof mountResizeHarness>) {
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    harness.current.beginCustomLayoutEdit();
  });
  harness.measure();
}

describe('layout editor column resize', () => {
  beforeEach(() => {
    storageListeners = [];
    authMocks.getConfig.mockReset();
    authMocks.update.mockReset();
    authMocks.getConfig.mockResolvedValue(baseConfig());
    authMocks.update.mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        onChanged: {
          addListener: vi.fn((listener) => storageListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            storageListeners = storageListeners.filter((item) => item !== listener);
          }),
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots) root.unmount();
      mountedRoots.length = 0;
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('commits a full visible px snapshot without jumping after pointerup', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const handle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-repository"]');
    if (!handle) throw new Error('Expected repository resize handle');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 7, clientX: 100 }));
    });
    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 8, clientX: 999 }));
    });
    expect(harness.current.gridTemplateColumns).toContain('240px 280px');

    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 7, clientX: 130 }));
    });
    const liveTemplate = harness.current.gridTemplateColumns;
    expect(liveTemplate).toContain('270px 280px');
    expect(harness.current.tableMinWidth).toBeGreaterThan(0);

    act(() => {
      window.dispatchEvent(eventWithPointer('pointerup', { pointerId: 7, clientX: 130 }));
    });

    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(harness.current.layoutResize).toBeNull();
    expect(harness.current.gridTemplateColumns).toBe(liveTemplate);
    expect(harness.current.draftLayout.widths).toMatchObject({
      repository: 270,
      description: 280,
      language: 80,
      stars: 64,
      updated: 84,
      created: 84,
      tags: 180,
    });

    const header = harness.container.querySelector<HTMLElement>('[data-testid="header"]');
    const row = harness.container.querySelector<HTMLElement>('[data-testid="row"]');
    expect(header?.style.gridTemplateColumns).toBe(row?.style.gridTemplateColumns);
    expect(header?.style.minWidth).toBe(row?.style.minWidth);
  });

  it('ignores secondary pointerdown for resize and does not capture it', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const handle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-repository"]');
    if (!handle) throw new Error('Expected repository resize handle');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => false);
    handle.releasePointerCapture = vi.fn();

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 12, clientX: 100, isPrimary: false }));
    });

    expect(handle.setPointerCapture).not.toHaveBeenCalled();
    expect(harness.current.layoutResize).toBeNull();
    expect(harness.current.draftLayout.widths).toBeUndefined();
  });

  it('auto fits against header and rendered row cells, then commits a full px snapshot', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);

    const headerLabel = harness.container.querySelector<HTMLElement>('[data-header-label="description"]');
    const rowCell = harness.container.querySelector<HTMLElement>('[data-row-col="description"]');
    if (!headerLabel || !rowCell) throw new Error('Expected description cells');
    Object.defineProperty(headerLabel, 'scrollWidth', { configurable: true, value: 150 });
    Object.defineProperty(rowCell, 'scrollWidth', { configurable: true, value: 410 });

    act(() => {
      harness.current.autoFitColumnWidth('description');
    });

    expect(harness.current.gridTemplateColumns).toBe('240px 438px 80px 64px 84px 84px 180px 32px 28px 20px');
    expect(harness.current.draftLayout.widths).toMatchObject({
      repository: 240,
      description: 438,
      language: 80,
      stars: 64,
      updated: 84,
      created: 84,
      tags: 180,
    });
  });

  it('refuses layout-mutating actions while a resize is active', async () => {
    const harness = mountResizeHarness({
      ...baseConfig(),
      columnLayoutMode: 'custom',
      customColumnLayout: {
        ...DEFAULT_COLUMN_LAYOUT,
        hidden: ['tags'],
      },
    } as Config);
    await hydrateAndEdit(harness);

    const handle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-description"]');
    if (!handle) throw new Error('Expected description resize handle');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 30, clientX: 200 }));
    });
    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 30, clientX: 260 }));
    });

    const liveTemplate = harness.current.gridTemplateColumns;
    expect(harness.current.layoutResize?.id).toBe('description');
    expect(harness.current.draftLayout.hidden).toEqual(['tags']);

    await act(async () => {
      harness.current.setColumnHidden('language', true);
      harness.current.restoreHiddenColumn('tags');
      harness.current.resetLayoutEdit();
      harness.current.resetLayoutWidths();
      harness.current.fitLayoutWidths();
      harness.current.autoFitColumnWidth('description');
      harness.current.toggleColumnMenu();
      await harness.current.saveLayoutEdit();
      harness.current.cancelLayoutEdit();
    });

    expect(harness.current.layoutResize?.id).toBe('description');
    expect(harness.current.gridTemplateColumns).toBe(liveTemplate);
    expect(harness.current.draftLayout.hidden).toEqual(['tags']);
    expect(harness.current.columnMenuOpen).toBe(false);
    expect(authMocks.update).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(eventWithPointer('pointerup', { pointerId: 30, clientX: 260 }));
    });

    expect(harness.current.layoutResize).toBeNull();
    expect(harness.current.draftLayout.hidden).toEqual(['tags']);
    expect(harness.current.draftLayout.widths?.description).toBe(340);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(30);
  });

  it('uses the live resize adapter for pointermove without re-rendering resize state', async () => {
    const liveAdapterPaint = vi.fn();
    const harness = mountResizeHarness(baseConfig(), liveAdapterPaint);
    await hydrateAndEdit(harness);
    const handle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-description"]');
    if (!handle) throw new Error('Expected description resize handle');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 61, clientX: 200 }));
    });

    expect(harness.current.layoutResize?.liveWidth).toBe(280);

    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 61, clientX: 260 }));
    });

    expect(liveAdapterPaint).toHaveBeenCalledTimes(1);
    expect(liveAdapterPaint.mock.calls[0]?.[0]).toMatchObject({
      id: 'description',
      liveWidth: 340,
      delta: 60,
    });
    expect(harness.current.layoutResize?.liveWidth).toBe(280);

    act(() => {
      window.dispatchEvent(eventWithPointer('pointerup', { pointerId: 61, clientX: 260 }));
    });

    expect(harness.current.layoutResize).toBeNull();
    expect(harness.current.draftLayout.widths?.description).toBe(340);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(61);
  });

  it('cancels the active resize gesture when the editor unmounts', async () => {
    const cleanup = vi.fn<NonNullable<LayoutResizeLiveAdapter['cleanup']>>();
    const harness = mountResizeHarness(baseConfig(), { paint: vi.fn(), cleanup });
    await hydrateAndEdit(harness);
    const handle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-description"]');
    if (!handle) throw new Error('Expected description resize handle');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 62, clientX: 200 }));
    });

    expect(harness.current.layoutResize?.id).toBe('description');
    expect(document.body.classList.contains('gsm-resizing-column')).toBe(true);

    act(() => {
      for (const root of mountedRoots) root.unmount();
      mountedRoots.length = 0;
    });

    expect(handle.releasePointerCapture).toHaveBeenCalledWith(62);
    expect(cleanup).toHaveBeenCalledWith('cancel');
    expect(document.body.classList.contains('gsm-resizing-column')).toBe(false);
  });

  it('fits widths against the visible layout stage width instead of the header shell width', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);

    act(() => {
      harness.current.fitLayoutWidths();
    });

    expect(harness.current.tableMinWidth).toBeGreaterThan(0);
    expect(harness.current.tableMinWidth).toBeLessThanOrEqual(900);
    expect(harness.current.draftLayout.widths?.description).toBeLessThan(280);
  });

  it('supports keyboard column reorder without crossing locked columns', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);

    act(() => {
      harness.current.moveColumnByKeyboard('description', 1);
    });
    expect(harness.current.visibleColumns.slice(0, 4)).toEqual(['repository', 'language', 'description', 'stars']);

    act(() => {
      harness.current.moveColumnByKeyboard('tags', 1);
    });
    expect(harness.current.visibleColumns.slice(-4)).toEqual(['tags', 'starAction', 'favorite', 'notes']);

    act(() => {
      harness.current.moveColumnByKeyboard('description', -1);
    });
    expect(harness.current.visibleColumns.slice(0, 3)).toEqual(['repository', 'description', 'language']);
  });

  it('supports keyboard column resize through the normalized width snapshot', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);

    act(() => {
      harness.current.resizeColumnByKeyboard('description', 1);
    });
    expect(harness.current.draftLayout.widths).toMatchObject({
      repository: 240,
      description: 288,
      language: 80,
      stars: 64,
      updated: 84,
      created: 84,
      tags: 180,
    });

    act(() => {
      harness.current.resizeColumnByKeyboard('description', -1, true);
    });
    expect(harness.current.draftLayout.widths?.description).toBe(264);
  });

  it('does not start column reorder while a resize is active', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const resizeHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-description"]');
    const dragHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="drag-repository"]');
    if (!resizeHandle || !dragHandle) throw new Error('Expected resize and drag handles');
    resizeHandle.setPointerCapture = vi.fn();
    resizeHandle.hasPointerCapture = vi.fn(() => true);
    resizeHandle.releasePointerCapture = vi.fn();
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.hasPointerCapture = vi.fn(() => false);
    dragHandle.releasePointerCapture = vi.fn();

    act(() => {
      resizeHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 21, clientX: 200 }));
    });
    act(() => {
      dragHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 22, clientX: 120 }));
    });

    expect(harness.current.layoutResize?.id).toBe('description');
    expect(harness.current.layoutDrag).toBeNull();
    expect(dragHandle.setPointerCapture).not.toHaveBeenCalled();
  });

  it('keeps a dragged header visible when the opened tray overlaps its original header bounds', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const dragHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="drag-repository"]');
    const tray = harness.container.querySelector<HTMLElement>('[data-testid="hide-drop-zone"]');
    if (!dragHandle || !tray) throw new Error('Expected repository drag handle and hide drop zone');
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.hasPointerCapture = vi.fn(() => true);
    dragHandle.releasePointerCapture = vi.fn();

    act(() => {
      dragHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 33, clientX: 120, clientY: 16 }));
    });
    tray.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 600,
      bottom: 32,
      width: 600,
      height: 32,
      toJSON: () => ({}),
    }));

    expect(harness.current.trayOpen).toBe(false);
    expect(harness.current.trayDropReady).toBe(false);

    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 33, clientX: 120, clientY: 16 }));
    });

    expect(harness.current.trayDropReady).toBe(false);
    expect(harness.current.layoutDrag?.kind).toBe('column');
    if (harness.current.layoutDrag?.kind !== 'column') throw new Error('Expected column drag');
    expect(harness.current.layoutDrag.hideIntent).toBe(false);

    act(() => {
      window.dispatchEvent(eventWithPointer('pointerup', { pointerId: 33, clientX: 120, clientY: 16 }));
    });

    expect(harness.current.layoutDrag).toBeNull();
    expect(harness.current.draftLayout.hidden).not.toContain('repository');
    expect(dragHandle.releasePointerCapture).toHaveBeenCalledWith(33);
  });

  it('opens the hidden-column tray and marks drop ready when a dragged header enters the shared edit chrome drop zone', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const dragHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="drag-repository"]');
    if (!dragHandle) throw new Error('Expected repository drag handle');
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.hasPointerCapture = vi.fn(() => true);
    dragHandle.releasePointerCapture = vi.fn();

    act(() => {
      dragHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 31, clientX: 120, clientY: 16 }));
    });

    expect(harness.current.trayOpen).toBe(false);
    expect(harness.current.trayDropReady).toBe(false);

    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 31, clientX: 120, clientY: -20 }));
    });

    expect(harness.current.trayOpen).toBe(true);
    expect(harness.current.trayDropReady).toBe(true);
    expect(harness.current.layoutDrag?.kind).toBe('column');
    if (harness.current.layoutDrag?.kind !== 'column') throw new Error('Expected column drag');
    expect(harness.current.layoutDrag.hideIntent).toBe(true);
  });

  it('uses the edit chrome wrapper as a hide drop zone before any columns are hidden', async () => {
    const harness = mountResizeHarness({
      ...baseConfig(),
      customColumnLayout: {
        ...DEFAULT_COLUMN_LAYOUT,
        hidden: [],
      },
    } as Config);
    await hydrateAndEdit(harness);
    expect(harness.current.hiddenColumnCount).toBe(0);
    expect(harness.current.trayOpen).toBe(false);
    const dragHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="drag-repository"]');
    if (!dragHandle) throw new Error('Expected repository drag handle');
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.hasPointerCapture = vi.fn(() => true);
    dragHandle.releasePointerCapture = vi.fn();

    act(() => {
      dragHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 34, clientX: 120, clientY: 16 }));
    });
    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 34, clientX: 120, clientY: -20 }));
    });

    expect(harness.current.trayOpen).toBe(true);
    expect(harness.current.trayDropReady).toBe(true);
    expect(harness.current.layoutDrag?.kind).toBe('column');
    if (harness.current.layoutDrag?.kind !== 'column') throw new Error('Expected column drag');
    expect(harness.current.layoutDrag.hideIntent).toBe(true);
  });

  it('does not mark drop ready when a dragged header is outside the hidden-column tray', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const dragHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="drag-repository"]');
    if (!dragHandle) throw new Error('Expected repository drag handle');
    dragHandle.setPointerCapture = vi.fn();
    dragHandle.hasPointerCapture = vi.fn(() => true);
    dragHandle.releasePointerCapture = vi.fn();

    act(() => {
      dragHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 32, clientX: 120, clientY: 16 }));
    });
    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 32, clientX: 120, clientY: 120 }));
    });

    expect(harness.current.trayOpen).toBe(true);
    expect(harness.current.trayDropReady).toBe(false);
  });

  it('does not let a second resize preempt the active resize gesture', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const descriptionHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-description"]');
    const repositoryHandle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-repository"]');
    if (!descriptionHandle || !repositoryHandle) throw new Error('Expected resize handles');
    descriptionHandle.setPointerCapture = vi.fn();
    descriptionHandle.hasPointerCapture = vi.fn(() => true);
    descriptionHandle.releasePointerCapture = vi.fn();
    repositoryHandle.setPointerCapture = vi.fn();
    repositoryHandle.hasPointerCapture = vi.fn(() => false);
    repositoryHandle.releasePointerCapture = vi.fn();

    act(() => {
      descriptionHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 41, clientX: 200 }));
    });
    act(() => {
      repositoryHandle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 42, clientX: 100 }));
    });

    expect(harness.current.layoutResize?.id).toBe('description');
    expect(repositoryHandle.setPointerCapture).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 41, clientX: 260 }));
    });
    act(() => {
      window.dispatchEvent(eventWithPointer('pointerup', { pointerId: 41, clientX: 260 }));
    });

    expect(harness.current.layoutResize).toBeNull();
    expect(harness.current.draftLayout.widths?.description).toBe(340);
    expect(harness.current.draftLayout.widths?.repository).toBe(240);
  });

  it('rolls back live widths on pointercancel and Escape', async () => {
    const harness = mountResizeHarness();
    await hydrateAndEdit(harness);
    const handle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-description"]');
    if (!handle) throw new Error('Expected description resize handle');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 3, clientX: 200 }));
    });
    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 3, clientX: 250 }));
    });
    expect(harness.current.gridTemplateColumns).toContain('240px 330px');

    act(() => {
      window.dispatchEvent(eventWithPointer('pointercancel', { pointerId: 3, clientX: 250 }));
    });
    expect(harness.current.draftLayout.widths).toBeUndefined();
    expect(harness.current.gridTemplateColumns).toContain('minmax(180px,1.4fr) 2fr');

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 4, clientX: 200 }));
    });
    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 4, clientX: 250 }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(harness.current.draftLayout.widths).toBeUndefined();
    expect(harness.current.layoutResize).toBeNull();
  });

  it('passes the draft default width into snapshot resize so live drag can snap back to baseline', async () => {
    const harness = mountResizeHarness({
      ...baseConfig(),
      columnLayoutMode: 'custom',
      customColumnLayout: {
        ...DEFAULT_COLUMN_LAYOUT,
        widths: { description: 320 },
      },
    } as Config);
    await hydrateAndEdit(harness);
    const handle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="resize-description"]');
    if (!handle) throw new Error('Expected description resize handle');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    act(() => {
      handle.dispatchEvent(eventWithPointer('pointerdown', { pointerId: 9, clientX: 200 }));
    });

    expect(harness.current.layoutResize?.defaultWidth).toBe(320);
    expect(harness.current.layoutResize?.startWidth).toBe(280);

    act(() => {
      window.dispatchEvent(eventWithPointer('pointermove', { pointerId: 9, clientX: 238 }));
    });

    expect(harness.current.layoutResize?.liveWidth).toBe(320);
    expect(harness.current.layoutResize?.atDefaultWidth).toBe(true);
    expect(harness.current.layoutResize?.snappedToDefault).toBe(true);
    expect(harness.current.gridTemplateColumns).toContain('320px');
  });

  it('restores a hidden column into an explicit px snapshot instead of mixing px and fr tracks', async () => {
    const harness = mountResizeHarness({
      ...baseConfig(),
      columnLayoutMode: 'custom',
      customColumnLayout: {
        ...DEFAULT_COLUMN_LAYOUT,
        hidden: ['description'],
        widths: {
          repository: 240,
          language: 80,
          stars: 64,
          updated: 84,
          created: 84,
          tags: 180,
        },
      },
    } as Config);
    await hydrateAndEdit(harness);

    act(() => {
      harness.current.restoreHiddenColumn('description');
    });

    expect(harness.current.draftLayout.widths?.description).toBe(COLUMN_DEFS.description.minWidth);
    expect(harness.current.gridTemplateColumns).not.toContain('fr');
    expect(harness.current.gridTemplateColumns).toContain(`${COLUMN_DEFS.description.minWidth}px`);
  });
});
