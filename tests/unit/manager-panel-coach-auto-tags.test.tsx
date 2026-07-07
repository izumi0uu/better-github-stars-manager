/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerPanel } from '@/ui/ManagerPanel';
import { RELEASE_NOTES_ID } from '@/ui/components/ReleaseNotesCard';
import type { SyncStatus } from '@/utils/messaging';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/ui/use-stars', () => ({
  useStars: () => ({
    rows: [],
    total: 0,
    grandTotal: 3,
    loading: false,
    phase: 'idle',
    languages: [],
    tagTree: { tags: [], total: 0 },
    tagsByFullName: new Map(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/ui/filter-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/filter-store')>();
  const filterState = {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any' as const,
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at' as const,
    sortDir: 'desc' as const,
    libraryViewHydrated: true,
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
    applyLibraryViewPrefs: vi.fn(),
    resetFilters: vi.fn(),
  };
  const useFilterStore = Object.assign(() => filterState, {
    getState: () => filterState,
    subscribe: vi.fn(() => () => {}),
  });
  return {
    ...actual,
    useFilterStore,
  };
});

vi.mock('@/ui/hooks/use-theme', () => ({
  useTheme: () => ({
    theme: 'light',
    themeClass: '',
    toggle: vi.fn(),
  }),
}));

vi.mock('@/ui/hooks/use-column-layout-editor', () => ({
  useColumnLayoutEditor: () => {
    const order = ['favorite', 'repo', 'description', 'language', 'stars', 'updated', 'created', 'tags', 'notes'];
    return {
      layoutMode: 'default',
      editingLayout: false,
      layoutConfigReady: true,
      layoutEditReady: true,
      previewingCustomLayout: false,
      draftLayout: { order, hidden: [], widths: {} },
      visibleColumns: order,
      gridTemplateColumns: '32px minmax(220px,1fr)',
      hiddenTrayColumns: [],
      customLayoutDirty: false,
      hiddenColumnCount: 0,
      dragGhost: null,
      layoutDrag: null,
      columnShifts: {},
      trayOpen: false,
      trayDropReady: false,
      trayCaretX: null,
      layoutFaded: false,
      flashedColumn: null,
      columnMenuOpen: false,
      columnMenuPosition: null,
      headerRef: { current: null },
      editColumnsButtonRef: { current: null },
      setBrowseLayoutMode: vi.fn(),
      previewCustomLayout: vi.fn(),
      beginCustomLayoutEdit: vi.fn(),
      saveLayoutEdit: vi.fn(),
      cancelLayoutEdit: vi.fn(),
      resetLayoutEdit: vi.fn(),
      resetLayoutWidths: vi.fn(),
      fitLayoutWidths: vi.fn(),
      setColumnHidden: vi.fn(),
      beginColumnDrag: vi.fn(),
      beginColumnResize: vi.fn(),
      moveColumnByKeyboard: vi.fn(),
      resizeColumnByKeyboard: vi.fn(),
      autoFitColumnWidth: vi.fn(),
      beginTrayDrag: vi.fn(),
      restoreHiddenColumn: vi.fn(),
      toggleColumnMenu: vi.fn(),
    };
  },
}));

vi.mock('@/ui/components/ActiveFilterChips', () => ({
  ActiveFilterChips: () => null,
}));

vi.mock('@/ui/components/FilterSidebar', () => ({
  FilterSidebar: () => <div data-coach-target="tags" />,
}));

vi.mock('@/ui/components/FloatingLocaleToggle', () => ({
  FloatingLocaleToggle: () => null,
}));

vi.mock('@/ui/components/RepoDetailPanel', () => ({
  RepoDetailPanel: () => null,
}));

vi.mock('@/ui/components/StarsTable', () => ({
  StarsTable: () => <div data-testid="stars-table" />,
}));

vi.mock('@/ui/components/LayoutEditChrome', () => ({
  LayoutColumnMenu: () => null,
  LayoutDragGhost: () => null,
  LayoutEditChrome: () => null,
}));

const mountedRoots: Root[] = [];
const sendMessage = vi.fn();
let messageListeners: Array<(message: { type?: string }) => void> = [];
let dismissReleaseNotesFails = false;

function status(stage: SyncStatus['onboardingStage'], patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    progress: { phase: 'idle', done: 0, total: null, message: '' },
    hasToken: true,
    onboardingStage: stage,
    seenOnboarding: stage === 'done',
    seenTooltips: 0,
    backfills: {},
    activeBackfillId: null,
    inFlight: true,
    releaseNotesDismissedId: null,
    ...patch,
  };
}

function ok(data?: unknown) {
  return Promise.resolve({ ok: true, data });
}

function mountPanel(initialStage: SyncStatus['onboardingStage'], patch: Partial<SyncStatus> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  sendMessage.mockImplementation((message: { type: string }) => {
    if (message.type === 'getStatus') return ok(status(initialStage, patch));
    if (message.type === 'query') return ok({ grandTotal: 3 });
    if (message.type === 'getAccount') {
      return ok({ username: 'idah', avatarUrl: 'avatar.png', displayName: 'Idah', gistId: null });
    }
    if (message.type === 'dismissReleaseNotes') {
      if (dismissReleaseNotesFails) return Promise.resolve({ ok: false, error: 'storage down' });
      return ok({ releaseNotesDismissedId: RELEASE_NOTES_ID });
    }
    throw new Error(`Unexpected message: ${message.type}`);
  });

  act(() => {
    root.render(<ManagerPanel />);
  });
  mountedRoots.push(root);
  return { container };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 25; i += 1) {
    await flushEffects();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

beforeEach(() => {
  messageListeners = [];
  dismissReleaseNotesFails = false;
  sendMessage.mockReset();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener) => {
          messageListeners.push(listener);
        }),
        removeListener: vi.fn((listener) => {
          messageListeners = messageListeners.filter((item) => item !== listener);
        }),
      },
    },
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('ManagerPanel Auto Tags coach step', () => {
  it('renders Auto Tags as the second post-sync coach step', async () => {
    const { container } = mountPanel('coach');

    await waitFor(() => {
      expect(container.querySelector('[data-coach-target="auto-tags"]')).not.toBeNull();
      expect(container.textContent).toContain('Step 1 of 5');
      expect(container.textContent).toContain('Sync your stars');
    });

    const nextButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Next');
    expect(nextButton).toBeDefined();

    act(() => {
      nextButton!.click();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Step 2 of 5');
      expect(container.textContent).toContain('Generate tags when you choose');
      expect(container.textContent).toContain('sync and full sync leave tags untouched');
    });
  });

  it('does not show the coach overlay for an empty-library onboarding stage', async () => {
    const { container } = mountPanel('empty_library');

    await waitFor(() => {
      expect(container.querySelector('[data-coach-target="auto-tags"]')).not.toBeNull();
      expect(container.textContent).not.toContain('Quick tour');
      expect(container.textContent).not.toContain('Step 1 of 5');
      expect(container.textContent).not.toContain("What's new in this update");
    });
  });

  it('keeps release notes hidden while the post-sync coach is active', async () => {
    const { container } = mountPanel('coach');

    await waitFor(() => {
      expect(container.textContent).toContain('Quick tour');
      expect(container.textContent).not.toContain("What's new in this update");
    });
  });

  it('shows and dismisses release notes only after onboarding is done', async () => {
    const { container } = mountPanel('done');

    await waitFor(() => {
      expect(container.textContent).toContain("What's new in this update");
      expect(container.textContent).toContain('Custom Table Layout');
    });

    const dismissButton = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss release notes"]');
    expect(dismissButton).not.toBeNull();

    act(() => {
      dismissButton!.click();
    });

    await waitFor(() => {
      expect(container.textContent).not.toContain("What's new in this update");
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'dismissReleaseNotes', id: RELEASE_NOTES_ID });
  });

  it('keeps release notes hidden after their bundle was dismissed', async () => {
    const { container } = mountPanel('done', { releaseNotesDismissedId: RELEASE_NOTES_ID });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="stars-table"]')).not.toBeNull();
      expect(container.textContent).not.toContain("What's new in this update");
    });
  });

  it('restores release notes when dismiss persistence fails', async () => {
    dismissReleaseNotesFails = true;
    const { container } = mountPanel('done');

    await waitFor(() => {
      expect(container.textContent).toContain("What's new in this update");
    });

    const dismissButton = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss release notes"]');
    act(() => {
      dismissButton!.click();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("What's new in this update");
      expect(container.textContent).toContain('Dismiss release notes: storage down');
    });
  });
});
