/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerPanel } from '@/ui/ManagerPanel';
import type { SyncStatus } from '@/utils/messaging';
import type * as FilterStore from '@/ui/filter-store';
import { click } from './test-utils';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedAgentHostProps = {
  open: boolean;
  defaultCandidate: { kind: string; selectedRepositoryIdHint?: string };
  chatCandidate: { kind: string; selectedRepositoryIdHint?: string };
  scopeCount: number;
};

const agentHostMocks = vi.hoisted(() => ({
  props: [] as CapturedAgentHostProps[],
}));

const starsMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  tagTree: { tags: [] as { name: string; count: number }[], total: 0 },
}));

vi.mock('@/ui/components/AgentHost', () => ({
  AgentHost: (props: CapturedAgentHostProps) => {
    agentHostMocks.props.push(props);
    return null;
  },
}));

vi.mock('@/ui/use-stars', () => ({
  useStars: () => ({
    rows: [],
    total: 0,
    grandTotal: 3,
    loading: false,
    phase: 'idle',
    languages: [],
    tagTree: starsMocks.tagTree,
    tagsByFullName: new Map(),
    refresh: starsMocks.refresh,
  }),
}));

vi.mock('@/ui/filter-store', async (importOriginal) => {
  const actual = await importOriginal<typeof FilterStore>();
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
  StarsTable: ({
    onSelect,
    selectedFullName,
  }: {
    onSelect?: (fullName: string) => void;
    selectedFullName?: string | null;
  }) => (
    <div data-testid="stars-table">
      <button type="button" data-testid="select-repo" onClick={() => onSelect?.('owner/repo')}>
        Select owner/repo
      </button>
      <span data-testid="selected-full-name">{selectedFullName ?? ''}</span>
    </div>
  ),
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
    progressInFlight: false,
    starsSyncInFlight: true,
    organizeJobActive: false,
  };
}

function ok(data?: unknown) {
  return Promise.resolve({ ok: true, data });
}

function mountPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  sendMessage.mockImplementation((message: { type: string }) => {
    if (message.type === 'getStatus') return ok(status('done'));
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
  agentHostMocks.props.length = 0;
  starsMocks.refresh.mockReset();
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
      local: {
        get: vi.fn().mockResolvedValue({
          gsm_config: {
            locale: 'en',
            username: 'octocat',
            avatarUrl: 'avatar.png',
            displayName: 'Octo Cat',
          },
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
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

describe('ManagerPanel Agent entry wiring', () => {
  it('mounts the lazy Agent entry only on open and carries the selected repository as chat context', async () => {
    const { container } = mountPanel();
    await waitFor(() => {
      expect(container.querySelector('[data-coach-target="agent"]')).not.toBeNull();
    });
    expect(agentHostMocks.props).toHaveLength(0);

    await click(container.querySelector('[data-coach-target="agent"]') as HTMLButtonElement);
    await waitFor(() => {
      expect(agentHostMocks.props.length).toBeGreaterThan(0);
    });
    let captured = agentHostMocks.props.at(-1);
    expect(captured?.open).toBe(true);
    expect(captured?.defaultCandidate.kind).toBe('current_view');
    expect(captured?.chatCandidate.kind).toBe('current_view');

    await click(container.querySelector('[data-testid="select-repo"]') as HTMLButtonElement);
    await waitFor(() => {
      captured = agentHostMocks.props.at(-1);
      expect(captured?.chatCandidate.kind).toBe('selected_repository');
    });
    expect(captured?.chatCandidate.selectedRepositoryIdHint).toBe('owner/repo');
    expect(captured?.defaultCandidate.selectedRepositoryIdHint).toBe('owner/repo');
    expect(captured?.scopeCount).toBe(1);
    // Opening the Agent entry does not clear the repository selection.
    expect(container.querySelector('[data-testid="selected-full-name"]')?.textContent).toBe('owner/repo');
  });

  it('keeps the deterministic Auto Tags prompt separate from the Agent entry', async () => {
    const { container } = mountPanel();
    await waitFor(() => {
      expect(container.querySelector('[data-coach-target="auto-tags"]')).not.toBeNull();
      expect(container.querySelector('[data-coach-target="agent"]')).not.toBeNull();
    });
    const autoTags = container.querySelector('[data-coach-target="auto-tags"]') as HTMLButtonElement;
    const agent = container.querySelector('[data-coach-target="agent"]') as HTMLButtonElement;
    expect(autoTags).not.toBe(agent);
    expect(autoTags.contains(agent) || agent.contains(autoTags)).toBe(false);

    await click(autoTags);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="auto-tag-agent-prompt"]')).not.toBeNull();
    });
    expect(agentHostMocks.props).toHaveLength(0);

    await click(agent);
    await waitFor(() => {
      expect(agentHostMocks.props.length).toBeGreaterThan(0);
    });
    expect(container.querySelector('[data-testid="auto-tag-agent-prompt"]')).not.toBeNull();
    expect(agentHostMocks.props.at(-1)?.open).toBe(true);
  });
});
