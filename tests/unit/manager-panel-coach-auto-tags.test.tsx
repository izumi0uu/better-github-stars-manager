/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerPanel } from '@/ui/ManagerPanel';
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
    onlyOwned: false,
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
    setOnlyOwned: vi.fn(),
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

vi.mock('@/ui/hooks/use-manager-surface-badges', () => ({
  useManagerSurfaceBadges: () => ({ watchUnreadCount: 0, radarUnseenCount: 0 }),
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
      setColumnHidden: vi.fn(),
      beginColumnDrag: vi.fn(),
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
  FilterSidebar: () => <div />,
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

function status(stage: SyncStatus['onboardingStage']): SyncStatus {
  return {
    progress: { phase: 'idle', done: 0, total: null, message: '' },
    hasToken: true,
    onboardingStage: stage,
    seenOnboarding: stage === 'done',
    seenTooltips: 0,
    backfills: {},
    activeBackfillId: null,
    inFlight: true,
    organizeJobActive: false,
  };
}

function ok(data?: unknown) {
  return Promise.resolve({ ok: true, data });
}

function mountPanel(initialStage: SyncStatus['onboardingStage']) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  sendMessage.mockImplementation((message: { type: string }) => {
    if (message.type === 'getStatus') return ok(status(initialStage));
    if (message.type === 'query') return ok({ grandTotal: 3 });
    if (message.type === 'getAccount') {
      return ok({ username: 'octocat', avatarUrl: 'avatar.png', displayName: 'Octo Cat', gistId: null });
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

describe('ManagerPanel coach tour', () => {
  it('walks through workspaces, Sync, Auto Tags, Cubby, and panel exit in order', async () => {
    const { container } = mountPanel('coach');
    const steps = [
      { target: 'surface-tabs', title: 'Meet the three workspaces', body: 'Stars organizes your saved repositories' },
      { target: 'sync', title: 'Keep Stars in sync', body: 'Neither action creates or changes tags' },
      { target: 'auto-tags', title: 'Add topic-based tags', body: 'It never runs as part of Sync' },
      { target: 'agent', title: 'Organize with Cubby', body: 'library-wide changes reviewed before Apply' },
      { target: 'hide-panel', title: 'Exit the panel', body: 'reopen the manager at any time' },
    ];

    for (const [index, step] of steps.entries()) {
      await waitFor(() => {
        expect(container.textContent).toContain(`Step ${index + 1} of ${steps.length}`);
        expect(container.textContent).toContain(step.title);
        expect(container.textContent).toContain(step.body);
        expect(container.querySelector(`[data-coach-step-target="${step.target}"]`)).not.toBeNull();
        expect(container.querySelector(`[data-coach-target="${step.target}"]`)).not.toBeNull();
      });

      if (index < steps.length - 1) {
        const nextButton = [...container.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Next');
        expect(nextButton).toBeDefined();
        act(() => { nextButton!.click(); });
      }
    }

    expect(container.querySelector('[data-coach-target="tags"]')).toBeNull();
    expect(container.querySelector('[data-coach-target="repo"]')).toBeNull();
    expect([...container.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === 'Got it')).toBe(true);
  });

  it('does not show the coach overlay for an empty-library onboarding stage', async () => {
    const { container } = mountPanel('empty_library');

    await waitFor(() => {
      expect(container.querySelector('[data-coach-target="auto-tags"]')).not.toBeNull();
      expect(container.textContent).not.toContain('Quick tour');
      expect(container.textContent).not.toContain('Step 1 of 5');
    });
  });
});
