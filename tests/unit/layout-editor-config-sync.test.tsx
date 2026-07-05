/**
 * @vitest-environment jsdom
 */
import { act, createRef, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@/types';
import type { FilterState } from '@/ui/filter-store';
import { getMessages } from '@/i18n';
import { ManagerPanel } from '@/ui/ManagerPanel';
import { Toolbar } from '@/ui/components/Toolbar';
import { COLUMN_DEFS, DEFAULT_COLUMN_LAYOUT, hideColumn } from '@/ui/column-layout';
import { BROWSE_LAYOUT_FADE_DELAY_MS } from '@/ui/layout-edit-constants';
import { useColumnLayoutEditor } from '@/ui/hooks/use-column-layout-editor';
import { TooltipProvider } from '@/ui/shadcn/tooltip';

const authMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  update: vi.fn(),
}));

const managerPanelMocks = vi.hoisted(() => ({
  refreshStars: vi.fn(),
  toggleLanguage: vi.fn(),
  toggleTag: vi.fn(),
  setQuery: vi.fn(),
  setTagMode: vi.fn(),
  setShowTombstone: vi.fn(),
  setOnlyFavorite: vi.fn(),
  setOnlyUntagged: vi.fn(),
  setOnlyArchived: vi.fn(),
  setSort: vi.fn(),
  resetFilters: vi.fn(),
  bgCall: vi.fn(async (method: string) => {
    if (method === 'getStatus') {
      return {
        hasToken: false,
        onboardingStage: null,
        progress: null,
      };
    }
    if (method === 'query') {
      return { grandTotal: 1 };
    }
    return null;
  }),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  authStore: authMocks,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 64,
    getVirtualItems: () => [{ index: 0, start: 0, size: 64, key: 'row-0' }],
  }),
}));

vi.mock('@/ui/use-stars', () => ({
  useStars: () => ({
    rows: [{
      full_name: 'owner/repo',
      html_url: 'https://github.com/owner/repo',
      description: 'A repository',
      language: 'TypeScript',
      stargazers_count: 1200,
      topics: ['react'],
      archived: false,
      fork: false,
      created_at: '2024-01-01T00:00:00Z',
      pushed_at: '2024-02-01T00:00:00Z',
      starred_at: '2024-03-01T00:00:00Z',
      tombstone: false,
      synced_at: '2024-03-02T00:00:00Z',
    }],
    total: 1,
    grandTotal: 1,
    loading: false,
    phase: 'idle',
    languages: [],
    tagTree: [],
    tagsByFullName: new Map(),
    refresh: managerPanelMocks.refreshStars,
  }),
}));

vi.mock('@/ui/filter-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/filter-store')>();
  return {
    ...actual,
    useFilterStore: () => ({
      query: '',
      languages: [],
      tags: [],
      tagMode: 'any',
      showTombstone: false,
      onlyFavorite: false,
      onlyUntagged: false,
      onlyArchived: false,
      sortKey: 'starred_at',
      sortDir: 'desc',
      setQuery: managerPanelMocks.setQuery,
      toggleLanguage: managerPanelMocks.toggleLanguage,
      toggleTag: managerPanelMocks.toggleTag,
      setTagMode: managerPanelMocks.setTagMode,
      setShowTombstone: managerPanelMocks.setShowTombstone,
      setOnlyFavorite: managerPanelMocks.setOnlyFavorite,
      setOnlyUntagged: managerPanelMocks.setOnlyUntagged,
      setOnlyArchived: managerPanelMocks.setOnlyArchived,
      setSort: managerPanelMocks.setSort,
      resetFilters: managerPanelMocks.resetFilters,
    }),
  };
});

vi.mock('@/ui/hooks/use-theme', () => ({
  useTheme: () => ({
    theme: 'light',
    themeClass: '',
    toggle: vi.fn(),
  }),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return {
    ...actual,
    bgCall: managerPanelMocks.bgCall,
    onProgress: () => () => {},
    mergeProgressStatus: (_current: unknown, progress: unknown) => progress,
    mergeStatusPatch: (current: Record<string, unknown> | null, patch: Record<string, unknown>) => ({ ...current, ...patch }),
    mergeStatusSnapshot: (_current: unknown, next: unknown) => next,
  };
});

vi.mock('@/ui/initial-sync', () => ({
  pickInitialSyncAction: () => null,
}));

vi.mock('@/onboarding/state', () => ({
  isOnboardingCardStage: () => false,
  resolveOnboardingStageAfterSync: () => null,
  shouldTrackOnboardingSync: () => false,
}));

vi.mock('@/content/stars-page/panel-toggle', () => ({
  hidePanel: vi.fn(),
}));

vi.mock('@/ui/components/FilterSidebar', () => ({
  FilterSidebar: () => <div data-testid="filter-sidebar" />,
}));

vi.mock('@/ui/components/ActiveFilterChips', () => ({
  ActiveFilterChips: () => <div data-testid="active-filter-chips" />,
}));

vi.mock('@/ui/components/FloatingLocaleToggle', () => ({
  FloatingLocaleToggle: () => null,
}));

vi.mock('@/ui/components/RepoDetailPanel', () => ({
  RepoDetailPanel: () => null,
}));

vi.mock('@/ui/components/LayoutEditChrome', () => ({
  LayoutColumnMenu: () => null,
  LayoutDragGhost: () => null,
  LayoutEditChrome: () => null,
}));

vi.mock('@/ui/components/FavoriteButton', () => ({
  FavoriteButton: () => <button type="button">favorite</button>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG_STORAGE_KEY = 'gsm_config';
const customLayout = hideColumn(DEFAULT_COLUMN_LAYOUT, 'language');
const editLayoutLabel = getMessages('en').toolbar.editLayout;
const mountedRoots: Root[] = [];
let storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];

type LayoutEditorState = ReturnType<typeof useColumnLayoutEditor>;

function fakeFilterState(): FilterState {
  return {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
    setQuery: vi.fn(),
    toggleLanguage: vi.fn(),
    toggleTag: vi.fn(),
    clearTags: vi.fn(),
    setTagMode: vi.fn(),
    setShowTombstone: vi.fn(),
    setOnlyFavorite: vi.fn(),
    setOnlyUntagged: vi.fn(),
    setOnlyArchived: vi.fn(),
    setSort: vi.fn(),
    resetFilters: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function configFor(columnLayoutMode: Config['columnLayoutMode']): Config {
  return {
    columnLayoutMode,
    customColumnLayout: customLayout,
  } as Config;
}

function defaultConfig(): Config {
  return {
    columnLayoutMode: 'default',
    customColumnLayout: null,
  } as Config;
}

function emitConfig(config: Config) {
  const change = { oldValue: null, newValue: config };
  for (const listener of [...storageListeners]) {
    listener({ [CONFIG_STORAGE_KEY]: change }, 'local');
  }
}

function mountLayoutEditor() {
  let latest: LayoutEditorState | null = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Probe() {
    latest = useColumnLayoutEditor(createRef<HTMLDivElement>());
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });
  mountedRoots.push(root);

  return {
    get current() {
      if (!latest) throw new Error('Layout editor did not render');
      return latest;
    },
  };
}

function LayoutToolbarHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editor = useColumnLayoutEditor(rootRef);

  return (
    <div ref={rootRef}>
      <TooltipProvider>
        <Toolbar
          f={fakeFilterState()}
          status={null}
          loading={false}
          listPhase="idle"
          total={1}
          grandTotal={1}
          busy={false}
          pendingAction={null}
          successAction={null}
          onSync={vi.fn()}
          onAutoAssignTags={vi.fn()}
          onToggleTheme={vi.fn()}
          theme="light"
          searchRef={searchRef}
          layoutMode={editor.layoutMode}
          layoutEditing={editor.editingLayout}
          layoutConfigReady={editor.layoutConfigReady}
          layoutEditReady={editor.layoutEditReady}
          customLayoutDirty={editor.customLayoutDirty}
          customPreviewing={editor.previewingCustomLayout}
          hiddenColumnCount={editor.hiddenColumnCount}
          onLayoutModeChange={editor.setBrowseLayoutMode}
          onStartLayoutEdit={editor.beginCustomLayoutEdit}
          onPreviewCustomChange={editor.previewCustomLayout}
        />
      </TooltipProvider>
    </div>
  );
}

function mountLayoutToolbar() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<LayoutToolbarHarness />);
  });
  mountedRoots.push(root);

  return { container };
}

function findEditLayoutButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${editLayoutLabel}"]`);
  if (!button) throw new Error('Expected edit layout button to render');
  return button;
}

function pointerEvent(type: string, init: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, {
      configurable: true,
      value,
    });
  }
  return event;
}

function setRect(node: Element, left: number, width: number, top = 100, height = 32) {
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

function installPointerCapture(node: HTMLElement) {
  let activePointerId: number | null = null;
  Object.assign(node, {
    setPointerCapture(pointerId: number) {
      activePointerId = pointerId;
    },
    releasePointerCapture(pointerId: number) {
      if (activePointerId === pointerId) activePointerId = null;
    },
    hasPointerCapture(pointerId: number) {
      return activePointerId === pointerId;
    },
  });
  return () => activePointerId;
}

function applyHeaderRects(container: HTMLElement) {
  const widths: Record<string, number> = {
    repository: 180,
    description: 220,
    language: 80,
    stars: 64,
    updated: 84,
    created: 84,
    tags: 160,
    favorite: 28,
    notes: 20,
  };
  const header = container.querySelector<HTMLElement>('[data-table-head]');
  if (!header) throw new Error('Expected table head to render');
  let left = 0;
  for (const id of Object.keys(widths)) {
    const cell = header.querySelector<HTMLElement>(`[data-header-col="${id}"]`);
    if (!cell) continue;
    setRect(cell, left, widths[id]);
    left += widths[id] + 8;
  }
  setRect(header, 0, left - 8, 100, 32);
}

function applyManagerPanelHeaderRects(container: HTMLElement) {
  const widths: Record<string, number> = {
    repository: 240,
    description: 280,
    language: 80,
    stars: 64,
    updated: 84,
    created: 84,
    tags: 180,
    favorite: 28,
    notes: 20,
  };
  const header = container.querySelector<HTMLElement>('[data-table-head]');
  if (!header) throw new Error('Expected manager panel head to render');
  let left = 0;
  for (const id of DEFAULT_COLUMN_LAYOUT.order) {
    const cell = header.querySelector<HTMLElement>(`[data-header-col="${id}"]`);
    if (!cell) continue;
    setRect(cell, left, widths[id], 100, 32);
    left += widths[id] + 8;
  }
  setRect(header, 0, left - 8, 100, 32);
}

function readLayoutState(container: HTMLElement) {
  const state = container.querySelector('[data-layout-state]')?.textContent;
  if (!state) throw new Error('Expected layout state output');
  return JSON.parse(state) as {
    gridTemplateColumns: string;
    tableMinWidth: number | null;
    widths: Record<string, number> | null;
    resizing: boolean;
  };
}

function LayoutResizeHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  const editor = useColumnLayoutEditor(rootRef);

  return (
    <div ref={rootRef}>
      <button type="button" data-open-edit onClick={editor.beginCustomLayoutEdit}>edit</button>
      <button type="button" data-save-edit onClick={() => { void editor.saveLayoutEdit(); }}>save</button>
      <div ref={editor.headerRef} data-table-head style={{ gridTemplateColumns: editor.gridTemplateColumns, minWidth: editor.tableMinWidth }}>
        {editor.visibleColumns.map((id) => (
          <div key={id} data-header-col={id}>
            <span data-header-label={id}>{COLUMN_DEFS[id].label(getMessages('en'))}</span>
            {!COLUMN_DEFS[id].locked && (
              <>
                <button type="button" data-resize-col={id} onPointerDown={(e) => editor.beginColumnResize(e, id)}>
                  resize {id}
                </button>
                <button type="button" data-drag-col={id} onPointerDown={(e) => editor.beginColumnDrag(e, id)}>
                  drag {id}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div data-row style={{ gridTemplateColumns: editor.gridTemplateColumns, minWidth: editor.tableMinWidth }}>
        {editor.visibleColumns.map((id) => (
          <div key={id} data-row-col={id}>{id.repeat(4)}</div>
        ))}
      </div>
      <output data-layout-state>
        {JSON.stringify({
          gridTemplateColumns: editor.gridTemplateColumns,
          tableMinWidth: editor.tableMinWidth ?? null,
          widths: editor.draftLayout.widths ?? null,
          resizing: editor.layoutResize != null,
        })}
      </output>
    </div>
  );
}

function mountLayoutResizeHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<LayoutResizeHarness />);
  });
  mountedRoots.push(root);

  return { container };
}

describe('layout editor config sync', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    storageListeners = [];
    authMocks.getConfig.mockReset();
    authMocks.update.mockReset();
    authMocks.update.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true, data: null }),
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
    vi.useRealTimers();
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('lets a storage echo start the browse fade and prevents late hydration from resetting it', async () => {
    const initialConfig = deferred<Config>();
    authMocks.getConfig.mockReturnValue(initialConfig.promise);
    const editor = mountLayoutEditor();

    await act(async () => {
      emitConfig(configFor('custom'));
    });

    expect(editor.current.layoutMode).toBe('custom');
    expect(editor.current.layoutConfigReady).toBe(true);
    expect(editor.current.layoutFaded).toBe(true);
    expect(editor.current.visibleColumns).toContain('language');

    await act(async () => {
      initialConfig.resolve(configFor('default'));
      await initialConfig.promise;
    });

    expect(editor.current.layoutMode).toBe('custom');
    expect(editor.current.layoutFaded).toBe(true);
    expect(editor.current.visibleColumns).toContain('language');

    await act(async () => {
      vi.advanceTimersByTime(BROWSE_LAYOUT_FADE_DELAY_MS);
    });

    expect(editor.current.layoutFaded).toBe(false);
    expect(editor.current.visibleColumns).not.toContain('language');
  });

  it('does not open a stale default edit before the first config sync', async () => {
    const initialConfig = deferred<Config>();
    authMocks.getConfig.mockReturnValue(initialConfig.promise);
    const editor = mountLayoutEditor();

    act(() => {
      editor.current.beginCustomLayoutEdit();
    });

    expect(editor.current.editingLayout).toBe(false);
    expect(authMocks.update).not.toHaveBeenCalled();

    await act(async () => {
      initialConfig.resolve(configFor('custom'));
      await initialConfig.promise;
    });

    act(() => {
      editor.current.beginCustomLayoutEdit();
    });

    expect(editor.current.editingLayout).toBe(true);
    expect(editor.current.visibleColumns).not.toContain('language');
    expect(authMocks.update).not.toHaveBeenCalled();
  });

  it('recovers browse controls after initial config read failure without enabling writable layout edit', async () => {
    authMocks.getConfig.mockRejectedValue(new Error('storage unavailable'));
    const editor = mountLayoutEditor();

    await act(async () => {
      await Promise.resolve();
    });

    expect(editor.current.layoutConfigReady).toBe(true);
    expect(editor.current.layoutEditReady).toBe(false);
    expect(editor.current.layoutMode).toBe('default');

    act(() => {
      editor.current.setBrowseLayoutMode('custom');
      editor.current.beginCustomLayoutEdit();
    });

    expect(editor.current.layoutMode).toBe('custom');
    expect(editor.current.editingLayout).toBe(false);
    expect(authMocks.update).toHaveBeenCalledWith({ columnLayoutMode: 'custom' });
  });

  it('keeps cancel scoped to draft edits after the pencil switches browsing to custom', async () => {
    authMocks.getConfig.mockResolvedValue(configFor('default'));
    const editor = mountLayoutEditor();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      editor.current.beginCustomLayoutEdit();
    });

    expect(editor.current.editingLayout).toBe(true);
    expect(authMocks.update).not.toHaveBeenCalled();

    act(() => {
      editor.current.cancelLayoutEdit();
    });

    expect(editor.current.editingLayout).toBe(false);
    expect(editor.current.layoutMode).toBe('default');
  });

  it('refreshes cancel target when config changes while layout edit is open', async () => {
    authMocks.getConfig.mockResolvedValue(configFor('default'));
    const editor = mountLayoutEditor();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      editor.current.beginCustomLayoutEdit();
    });
    expect(editor.current.editingLayout).toBe(true);

    act(() => {
      emitConfig({
        ...configFor('default'),
        customColumnLayout: null,
      });
      editor.current.cancelLayoutEdit();
    });

    expect(editor.current.editingLayout).toBe(false);
    expect(editor.current.layoutMode).toBe('default');
  });

  it('logs layout preference persistence failures without blocking local state', async () => {
    authMocks.getConfig.mockResolvedValue(configFor('default'));
    authMocks.update.mockRejectedValueOnce(new Error('storage write failed'));
    const editor = mountLayoutEditor();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      editor.current.setBrowseLayoutMode('custom');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(editor.current.layoutMode).toBe('custom');
    expect(warnSpy).toHaveBeenCalledWith(
      '[GSM] failed to persist layout preference:',
      'set browse mode',
      'storage write failed',
    );
  });

  it('renders Toolbar from the real hook and enables the pencil after successful hydration', async () => {
    const initialConfig = deferred<Config>();
    authMocks.getConfig.mockReturnValue(initialConfig.promise);
    const { container } = mountLayoutToolbar();

    expect(findEditLayoutButton(container).disabled).toBe(true);

    await act(async () => {
      initialConfig.resolve(configFor('default'));
      await initialConfig.promise;
    });

    const editButton = findEditLayoutButton(container);
    expect(editButton.disabled).toBe(false);

    act(() => {
      editButton.click();
    });

    expect(authMocks.update).not.toHaveBeenCalled();
  });

  it('commits a full width snapshot on pointerup without jumping and saves shared min width state', async () => {
    authMocks.getConfig.mockResolvedValue(defaultConfig());
    const { container } = mountLayoutResizeHarness();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      const button = container.querySelector('[data-open-edit]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected edit button');
      button.click();
    });
    applyHeaderRects(container);

    const handle = container.querySelector('[data-resize-col="description"]');
    if (!(handle instanceof HTMLButtonElement)) throw new Error('Expected description resize handle');
    const activePointerId = installPointerCapture(handle);
    const before = readLayoutState(container);

    act(() => {
      handle.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 220, pointerId: 7 }));
    });
    const frozen = readLayoutState(container);

    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 320, pointerId: 99 }));
    });
    expect(frozen.gridTemplateColumns).not.toBe(before.gridTemplateColumns);
    expect(readLayoutState(container).gridTemplateColumns).toBe(frozen.gridTemplateColumns);

    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 320, pointerId: 7 }));
    });

    const live = readLayoutState(container);
    const header = container.querySelector('[data-table-head]');
    const row = container.querySelector('[data-row]');
    if (!(header instanceof HTMLElement) || !(row instanceof HTMLElement)) throw new Error('Expected header and row');
    expect(live.resizing).toBe(true);
    expect(live.gridTemplateColumns).toContain('320px');
    expect(header.style.gridTemplateColumns).toBe(row.style.gridTemplateColumns);
    expect(header.style.minWidth).toBe(row.style.minWidth);
    expect(live.tableMinWidth).toBeGreaterThan(0);

    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 320, pointerId: 7 }));
    });

    const committed = readLayoutState(container);
    expect(committed.resizing).toBe(false);
    expect(committed.gridTemplateColumns).toBe(live.gridTemplateColumns);
    expect(committed.widths).toMatchObject({
      repository: 180,
      description: 320,
      language: 80,
      stars: 64,
      updated: 84,
      created: 84,
      tags: 160,
    });
    expect(activePointerId()).toBe(null);

    await act(async () => {
      const button = container.querySelector('[data-save-edit]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected save button');
      button.click();
      await Promise.resolve();
    });

    expect(authMocks.update).toHaveBeenCalledWith(expect.objectContaining({
      customColumnLayout: expect.objectContaining({
        widths: expect.objectContaining({
          repository: 180,
          description: 320,
          language: 80,
          stars: 64,
          updated: 84,
          created: 84,
          tags: 160,
        }),
      }),
    }));
  });

  it('rehydrates saved px widths without jumping back to fr tracks when reopening edit', async () => {
    authMocks.getConfig.mockResolvedValue(defaultConfig());
    const { container } = mountLayoutResizeHarness();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      const button = container.querySelector('[data-open-edit]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected edit button');
      button.click();
    });
    applyHeaderRects(container);

    const handle = container.querySelector('[data-resize-col="description"]');
    if (!(handle instanceof HTMLButtonElement)) throw new Error('Expected description resize handle');
    installPointerCapture(handle);

    act(() => {
      handle.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 220, pointerId: 15 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 320, pointerId: 15 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 320, pointerId: 15 }));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const committedState = readLayoutState(container);
    const savedBeforePersist = committedState.gridTemplateColumns;
    const savedWidths = {
      repository: 180,
      description: 320,
      language: 80,
      stars: 64,
      updated: 84,
      created: 84,
      tags: 160,
    };
    expect(savedBeforePersist).toContain('180px 320px 80px 64px 84px 84px 160px');

    await act(async () => {
      const button = container.querySelector('[data-save-edit]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected save button');
      button.click();
      await Promise.resolve();
    });

    expect(authMocks.update).toHaveBeenCalledWith(expect.objectContaining({
      columnLayoutMode: 'custom',
      customColumnLayout: expect.objectContaining({
        widths: expect.objectContaining(savedWidths),
      }),
    }));

    act(() => {
      emitConfig({
        ...defaultConfig(),
        columnLayoutMode: 'custom',
        customColumnLayout: {
          ...DEFAULT_COLUMN_LAYOUT,
          widths: savedWidths,
        },
      });
    });

    expect(readLayoutState(container).gridTemplateColumns).toBe(savedBeforePersist);
    expect(readLayoutState(container).gridTemplateColumns).not.toContain('fr');

    act(() => {
      const button = container.querySelector('[data-open-edit]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected edit button');
      button.click();
    });

    expect(readLayoutState(container).gridTemplateColumns).toBe(savedBeforePersist);
    expect(readLayoutState(container).gridTemplateColumns).not.toContain('fr');
  });

  it('rolls back live width changes on pointercancel', async () => {
    authMocks.getConfig.mockResolvedValue(defaultConfig());
    const { container } = mountLayoutResizeHarness();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      const button = container.querySelector('[data-open-edit]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected edit button');
      button.click();
    });
    applyHeaderRects(container);

    const handle = container.querySelector('[data-resize-col="description"]');
    if (!(handle instanceof HTMLButtonElement)) throw new Error('Expected description resize handle');
    const activePointerId = installPointerCapture(handle);
    const before = readLayoutState(container);

    act(() => {
      handle.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 220, pointerId: 11 }));
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 290, pointerId: 11 }));
    });
    expect(readLayoutState(container).resizing).toBe(true);

    act(() => {
      window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 11 }));
    });

    const cancelled = readLayoutState(container);
    expect(cancelled.resizing).toBe(false);
    expect(cancelled.widths).toBeNull();
    expect(cancelled.gridTemplateColumns).toBe(before.gridTemplateColumns);
    expect(cancelled.tableMinWidth).toBeNull();
    expect(activePointerId()).toBe(null);
  });

  it('routes a real dblclick through ManagerPanel resize handle and auto-fits from measured DOM widths', async () => {
    authMocks.getConfig.mockResolvedValue(defaultConfig());
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    act(() => {
      root.render(<ManagerPanel />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const editButton = findEditLayoutButton(container);
    act(() => {
      editButton.click();
    });

    applyManagerPanelHeaderRects(container);

    const messages = getMessages('en');
    const headerLabel = container.querySelector<HTMLElement>('[data-header-label="description"]');
    const rowCell = container.querySelector<HTMLElement>('[data-row-col="description"]');
    const handle = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${messages.toolbar.resizeColumnTitle(messages.toolbar.columnDescription)}"]`,
    );
    if (!headerLabel || !rowCell || !handle) throw new Error('Expected description resize DOM to render');

    Object.defineProperty(headerLabel, 'scrollWidth', { configurable: true, value: 150 });
    Object.defineProperty(rowCell, 'scrollWidth', { configurable: true, value: 410 });

    const bubbleSpy = vi.fn();
    document.body.addEventListener('dblclick', bubbleSpy);
    const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true });

    act(() => {
      handle.dispatchEvent(event);
    });

    document.body.removeEventListener('dblclick', bubbleSpy);

    expect(event.defaultPrevented).toBe(true);
    expect(bubbleSpy).not.toHaveBeenCalled();

    const header = container.querySelector<HTMLElement>('[data-table-head]');
    const row = rowCell.closest<HTMLElement>('.gsm-layout-grid');
    if (!header || !row) throw new Error('Expected header and row grids');

    expect(header.style.gridTemplateColumns).toBe('240px 438px 80px 64px 84px 84px 180px 28px 20px');
    expect(row.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns);
    expect(header.style.minWidth).toBe(row.style.minWidth);
  });
});
