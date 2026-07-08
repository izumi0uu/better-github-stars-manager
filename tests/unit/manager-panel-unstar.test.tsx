/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerPanel } from '@/ui/ManagerPanel';
import type { Star } from '@/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const managerMocks = vi.hoisted(() => ({
  bgCall: vi.fn(),
  setInfo: vi.fn(),
  refreshStars: vi.fn(),
  row: {
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
  } satisfies Star,
}));

vi.mock('@/ui/use-stars', () => ({
  useStars: () => ({
    rows: [managerMocks.row],
    total: 1,
    grandTotal: 1,
    loading: false,
    phase: 'idle',
    languages: [],
    tagTree: { tags: [], total: 0 },
    tagsByFullName: new Map(),
    refresh: managerMocks.refreshStars,
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

vi.mock('@/ui/hooks/use-manager-sync-actions', () => ({
  useManagerSyncActions: () => ({
    status: {
      progress: { phase: 'idle', done: 0, total: null, message: '' },
      hasToken: true,
      onboardingStage: 'done',
      seenOnboarding: true,
      seenTooltips: 0,
      backfills: {},
      activeBackfillId: null,
      inFlight: false,
    },
    statusLoaded: true,
    busy: false,
    pendingAction: null,
    successAction: null,
    info: null,
    setInfo: managerMocks.setInfo,
    applyStatusPatch: vi.fn(),
    setOnboardingStage: vi.fn(),
    doSync: vi.fn(),
    autoAssignTags: vi.fn(),
    runBackfill: vi.fn(),
    deferBackfill: vi.fn(),
    isOnboardingCardStage: () => false,
  }),
}));

vi.mock('@/ui/hooks/use-theme', () => ({
  useTheme: () => ({
    theme: 'light',
    themeClass: '',
    toggle: vi.fn(),
  }),
}));

vi.mock('@/ui/hooks/use-column-layout-editor', () => ({
  useColumnLayoutEditor: () => ({
    layoutMode: 'default',
    editingLayout: false,
    layoutConfigReady: true,
    layoutEditReady: true,
    previewingCustomLayout: false,
    draftLayout: { order: ['starAction'], hidden: [], widths: {} },
    visibleColumns: ['starAction'],
    gridTemplateColumns: '32px',
    tableMinWidth: 32,
    hiddenTrayColumns: [],
    customLayoutDirty: false,
    hiddenColumnCount: 0,
    dragGhost: null,
    layoutDrag: null,
    layoutResize: null,
    columnShifts: {},
    trayOpen: false,
    trayDropReady: false,
    trayCaretX: null,
    layoutFaded: false,
    flashedColumn: null,
    columnMenuOpen: false,
    columnMenuPosition: null,
    headerRef: { current: null },
    hideDropZoneRef: { current: null },
    editColumnsButtonRef: { current: null },
    setBrowseLayoutMode: vi.fn(),
    previewCustomLayout: vi.fn(),
    beginCustomLayoutEdit: vi.fn(),
    saveLayoutEdit: vi.fn(),
    cancelLayoutEdit: vi.fn(),
    resetLayoutEdit: vi.fn(),
    resetLayoutWidths: vi.fn(),
    setColumnHidden: vi.fn(),
    beginColumnDrag: vi.fn(),
    beginColumnResize: vi.fn(),
    moveColumnByKeyboard: vi.fn(),
    resizeColumnByKeyboard: vi.fn(),
    autoFitColumnWidth: vi.fn(),
    fitLayoutWidths: vi.fn(),
    beginTrayDrag: vi.fn(),
    restoreHiddenColumn: vi.fn(),
    toggleColumnMenu: vi.fn(),
  }),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return {
    ...actual,
    bgCall: managerMocks.bgCall,
  };
});

vi.mock('@/content/stars-page/panel-toggle', () => ({
  hidePanel: vi.fn(),
}));

vi.mock('@/ui/components/Toolbar', () => ({
  Toolbar: () => <div data-testid="toolbar" />,
}));

vi.mock('@/ui/components/FilterSidebar', () => ({
  FilterSidebar: () => <div data-testid="filter-sidebar" />,
}));

vi.mock('@/ui/components/ActiveFilterChips', () => ({
  ActiveFilterChips: () => null,
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

vi.mock('@/ui/components/StarsTable', () => ({
  StarsTable: ({ onConfirmUnstar }: { onConfirmUnstar?: (fullName: string) => void }) => (
    <button type="button" data-testid="confirm-unstar" onClick={() => onConfirmUnstar?.('owner/repo')}>
      confirm unstar
    </button>
  ),
}));

const mountedRoots: Root[] = [];

function mountPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<ManagerPanel />);
  });
  mountedRoots.push(root);
  return { container };
}

beforeEach(() => {
  vi.useFakeTimers();
  managerMocks.bgCall.mockReset();
  managerMocks.bgCall.mockReturnValue(new Promise(() => {}));
  managerMocks.setInfo.mockReset();
  managerMocks.refreshStars.mockReset();
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
    mountedRoots.length = 0;
  });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ManagerPanel unstar flow', () => {
  it('dispatches markUnstarred immediately without an optimistic hide timer', () => {
    const { container } = mountPanel();
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="confirm-unstar"]');
    if (!confirm) throw new Error('Expected mocked unstar control');

    act(() => {
      confirm.click();
    });

    expect(managerMocks.bgCall).toHaveBeenCalledWith('markUnstarred', { full_name: 'owner/repo' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders failed unstar repo names as a helper badge without optimistic removal', async () => {
    managerMocks.bgCall.mockRejectedValueOnce(new Error('GitHub rejected the request (403). Token settings: github.com/settings/tokens.'));
    const { container } = mountPanel();
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="confirm-unstar"]');
    if (!confirm) throw new Error('Expected mocked unstar control');

    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });

    const repoBadge = container.querySelector<HTMLSpanElement>('.gsm-helper-text span span');
    expect(repoBadge?.textContent).toBe('owner/repo');
    expect(repoBadge?.className).toContain('bg-foreground');
    expect(repoBadge?.className).toContain('text-background');
    const tokenLink = container.querySelector<HTMLAnchorElement>('a[href="https://github.com/settings/tokens"]');
    expect(tokenLink?.textContent).toBe('github.com/settings/tokens');
    expect(container.querySelector('[data-testid="confirm-unstar"]')).not.toBeNull();
  });
});
