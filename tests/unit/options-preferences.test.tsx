/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Options } from '@/options/Options';
import type { Config } from '@/types';
import {
  cleanupMountedRootsAndBody,
  mountReact,
  setInputValue,
  type MountedRoot,
} from './test-utils';

const authMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  hasToken: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  setTheme: vi.fn(),
  update: vi.fn(),
  updateAutoTagPolicy: vi.fn(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  authStore: authMocks,
}));

const mountedRoots: MountedRoot[] = [];
const storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
const runtimeListeners: Array<(message: { type?: string }) => void> = [];

function config(overrides: Partial<Config> = {}): Config {
  return {
    tokenEncrypted: 'cipher',
    tokenCryptoMeta: { iv: 'iv', salt: 'salt' },
    theme: 'dark',
    locale: 'en',
    defaultView: 'table',
    lastSyncStarredAt: null,
    gistId: null,
    gistSyncCursor: null,
    username: 'idah',
    avatarUrl: null,
    displayName: null,
    onboardingStage: 'done',
    seenOnboarding: true,
    seenTooltips: 0,
    autoTagLimit: 5,
    maxTagsPerRepo: 5,
    minTopicRepoCount: 3,
    libraryView: {
      version: 1,
      filters: {
        languages: [],
        tags: [],
        tagMode: 'any',
        showTombstone: false,
        onlyFavorite: false,
        onlyUntagged: false,
        onlyArchived: false,
      },
      sort: {
        sortKey: 'starred_at',
        sortDir: 'desc',
      },
    },
    starsPanelDefaultEnabled: true,
    releaseNotesDismissedId: null,
    columnLayoutMode: 'default',
    customColumnLayout: null,
    langTagMigrationDone: true,
    lastSyncProgress: { phase: 'idle', done: 0, total: null, message: '' },
    backfills: {},
    ...overrides,
  };
}

async function renderOptions() {
  mountReact(<Options />, mountedRoots);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('Options preferences', () => {
  beforeEach(() => {
    authMocks.getConfig.mockReset();
    authMocks.hasToken.mockReset();
    authMocks.setToken.mockReset();
    authMocks.clearToken.mockReset();
    authMocks.setTheme.mockReset();
    authMocks.update.mockReset();
    authMocks.updateAutoTagPolicy.mockReset();
    storageListeners.length = 0;
    runtimeListeners.length = 0;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(() => Promise.resolve({
          ok: true,
          data: {
            progress: { phase: 'idle', done: 0, total: null, message: '' },
            hasToken: true,
            onboardingStage: 'done',
            seenOnboarding: true,
            seenTooltips: 0,
            backfills: {},
            activeBackfillId: null,
            releaseNotesDismissedId: null,
            inFlight: false,
          },
        })),
        onMessage: {
          addListener: vi.fn((listener) => runtimeListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = runtimeListeners.indexOf(listener);
            if (index >= 0) runtimeListeners.splice(index, 1);
          }),
        },
      },
      storage: {
        onChanged: {
          addListener: vi.fn((listener) => storageListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = storageListeners.indexOf(listener);
            if (index >= 0) storageListeners.splice(index, 1);
          }),
        },
      },
    });
  });

  afterEach(() => {
    cleanupMountedRootsAndBody(mountedRoots);
    vi.unstubAllGlobals();
  });

  it('renders a verified stars link only for a usable token and trusted username', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);

    await renderOptions();

    const link = document.querySelector<HTMLAnchorElement>('a[href="https://github.com/idah?tab=stars"]');
    expect(link).not.toBeNull();
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noreferrer');
    expect(link?.textContent).toContain('Open my stars');
  });

  it('hides the stars link when only cached username remains', async () => {
    authMocks.getConfig.mockResolvedValue(config({ tokenEncrypted: null, tokenCryptoMeta: null }));
    authMocks.hasToken.mockResolvedValue(false);

    await renderOptions();

    expect(document.querySelector('a[href="https://github.com/idah?tab=stars"]')).toBeNull();
    expect(document.body.textContent).toContain('Cached account @idah');
  });

  it('normalizes and persists split auto-tag policy inputs independently', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);

    await renderOptions();

    const maxTags = document.querySelector<HTMLInputElement>('#max-tags-per-repo');
    const minCoverage = document.querySelector<HTMLInputElement>('#min-topic-repo-count');
    expect(maxTags).not.toBeNull();
    expect(minCoverage).not.toBeNull();

    await setInputValue(maxTags!, '99');
    await blur(maxTags!);
    await setInputValue(minCoverage!, '0');
    await blur(minCoverage!);

    expect(authMocks.updateAutoTagPolicy).toHaveBeenCalledWith({ maxTagsPerRepo: 50 });
    expect(authMocks.updateAutoTagPolicy).toHaveBeenCalledWith({ minTopicRepoCount: 1 });
    expect(maxTags?.value).toBe('50');
    expect(minCoverage?.value).toBe('1');
  });

  it('hides the stars link after clearing the token', async () => {
    let currentConfig = config();
    let currentHasToken = true;
    authMocks.getConfig.mockImplementation(() => Promise.resolve(currentConfig));
    authMocks.hasToken.mockImplementation(() => Promise.resolve(currentHasToken));
    authMocks.clearToken.mockImplementation(() => {
      currentConfig = config({ tokenEncrypted: null, tokenCryptoMeta: null });
      currentHasToken = false;
      return Promise.resolve();
    });

    await renderOptions();

    const remove = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Remove token'));
    expect(remove).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (remove as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('a[href="https://github.com/idah?tab=stars"]')).toBeNull();
  });
});
