/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popup } from '@/popup/Popup';
import { cleanupMountedRootsAndBody, click, mountReact, type MountedRoot } from './test-utils';

const messagingMocks = vi.hoisted(() => ({
  bgCall: vi.fn(),
  onProgress: vi.fn(() => vi.fn()),
  mergeProgressStatus: vi.fn((_current, progress) => ({
    progress,
    hasToken: true,
    onboardingStage: 'done',
    seenOnboarding: true,
    seenTooltips: 0,
    backfills: {},
    activeBackfillId: null,
    inFlight: progress.phase !== 'idle',
  })),
  mergeStatusSnapshot: vi.fn((_current, next) => next),
}));

vi.mock('@/utils/messaging', () => messagingMocks);

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    m: {
      common: {
        loading: 'Loading',
        phase: (phase: string) => phase,
      },
      popup: {
        title: 'GitHub Stars Manager',
        failed: (label: string, error: string) => `${label}: ${error}`,
        testing: 'Testing',
        rate: (remaining: string | null, limit: string | null) => `Rate ${remaining}/${limit}`,
        scopes: (scopes: string | null) => `Scopes ${scopes}`,
        itemsOnPage: (count: number) => `Items ${count}`,
        sample: (sample: string | null) => `Sample ${sample}`,
        connectionOk: 'Connection OK',
        connectionNoContent: 'Connection no content',
        connectionRejected: 'Connection rejected',
        connectionForbidden: 'Connection forbidden',
        noToken: 'No token',
        addPat: 'Add PAT',
        idle: 'Idle',
        syncIncremental: 'Sync',
        syncFull: 'Full Sync',
        reconcile: 'Reconcile',
        gistPull: 'Pull',
        gistPush: 'Push',
        testConnection: 'Test Connection',
        debugState: 'Debug State',
        openStars: 'Open Stars',
        options: 'Options',
        starRepoTitle: 'Star repo',
      },
    },
  }),
}));

const mountedRoots: MountedRoot[] = [];
const tabsCreate = vi.fn();
const openOptionsPage = vi.fn();

function baseStatus() {
  return {
    progress: { phase: 'idle', done: 0, total: null, message: '' },
    hasToken: true,
    onboardingStage: 'done',
    seenOnboarding: true,
    seenTooltips: 0,
    backfills: {},
    activeBackfillId: null,
    inFlight: false,
  };
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

beforeEach(() => {
  messagingMocks.bgCall.mockReset();
  messagingMocks.onProgress.mockClear();
  messagingMocks.mergeProgressStatus.mockClear();
  messagingMocks.mergeStatusSnapshot.mockClear();
  tabsCreate.mockReset();
  openOptionsPage.mockReset();

  vi.stubGlobal('chrome', {
    runtime: {
      openOptionsPage: openOptionsPage.mockImplementation((callback?: () => void) => {
        callback?.();
      }),
    },
    tabs: {
      create: tabsCreate.mockImplementation((_properties: chrome.tabs.CreateProperties, callback?: (tab: chrome.tabs.Tab) => void) => {
        callback?.({ id: 1 } as chrome.tabs.Tab);
      }),
    },
  });

  messagingMocks.bgCall.mockImplementation((type: string) => {
    if (type === 'getStatus') return Promise.resolve(baseStatus());
    if (type === 'getUsername') return Promise.resolve({ username: 'idah' });
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
});

describe('Popup navigation actions', () => {
  it('opens the signed-in stars page through the runtime adapter tabs API', async () => {
    mountReact(<Popup />, mountedRoots);

    await click(button('Open Stars'));

    expect(tabsCreate).toHaveBeenCalledWith(
      { url: 'https://github.com/idah?tab=stars' },
      expect.any(Function),
    );
  });

  it('opens extension options through the runtime adapter options API', async () => {
    mountReact(<Popup />, mountedRoots);

    await click(button('Options'));

    expect(openOptionsPage).toHaveBeenCalledWith(expect.any(Function));
  });
});
