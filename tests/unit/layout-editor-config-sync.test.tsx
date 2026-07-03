/**
 * @vitest-environment jsdom
 */
import { act, createRef, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@/types';
import type { FilterState } from '@/ui/filter-store';
import { getMessages } from '@/i18n';
import { Toolbar } from '@/ui/components/Toolbar';
import { DEFAULT_COLUMN_LAYOUT, hideColumn } from '@/ui/column-layout';
import { BROWSE_LAYOUT_FADE_DELAY_MS } from '@/ui/layout-edit-constants';
import { useColumnLayoutEditor } from '@/ui/hooks/use-column-layout-editor';
import { TooltipProvider } from '@/ui/shadcn/tooltip';

const authMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  authStore: authMocks,
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

describe('layout editor config sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storageListeners = [];
    authMocks.getConfig.mockReset();
    authMocks.update.mockReset();
    authMocks.update.mockResolvedValue(undefined);
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
    expect(authMocks.update).toHaveBeenCalledWith({ columnLayoutMode: 'custom' });
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
    expect(authMocks.update).toHaveBeenCalledWith({ columnLayoutMode: 'custom' });

    act(() => {
      editor.current.cancelLayoutEdit();
    });

    expect(editor.current.editingLayout).toBe(false);
    expect(editor.current.layoutMode).toBe('custom');
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

    expect(authMocks.update).toHaveBeenCalledWith({ columnLayoutMode: 'custom' });
  });
});
