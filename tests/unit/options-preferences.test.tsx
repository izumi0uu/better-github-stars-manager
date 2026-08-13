/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_WATCHING_FORBIDDEN } from '@/api/errors';
import { Options } from '@/options/Options';
import { getMessages } from '@/i18n';
import type { Config } from '@/types';
import { OPTIONS_INTENT_STORAGE_KEY } from '@/utils/options-intent';
import {
  click,
  cleanupMountedRootsAndBody,
  mountReact,
  setInputValue,
  type MountedRoot,
} from './test-utils';

const authMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  hasToken: vi.fn(),
  hasWatchNotificationsToken: vi.fn(),
  enableWatchWithMainToken: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  setWatchNotificationsToken: vi.fn(),
  updateAgentProviderConfig: vi.fn(),
  acceptAgentDataDisclosure: vi.fn(),
  clearAgentProviderApiKey: vi.fn(),
  setTheme: vi.fn(),
  update: vi.fn(),
  updateAutoTagPolicy: vi.fn(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials_v1',
  authStore: authMocks,
}));

const mountedRoots: MountedRoot[] = [];
const storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
const sessionStorageValues: Record<string, unknown> = {};
const runtimeListeners: Array<(message: { type?: string }) => void> = [];
const permissionAddedListeners: Array<(permissions: chrome.permissions.Permissions) => void> = [];
const permissionRemovedListeners: Array<(permissions: chrome.permissions.Permissions) => void> = [];
const MiB = 1_024 * 1_024;
const watchCopy = getMessages('en').options;

function agentStorageUsage(cacheBytes = 2 * MiB) {
  return {
    canonicalBytes: 1 * MiB,
    cacheBytes,
    totalBytes: 1 * MiB + cacheBytes,
    warningBytes: 256 * MiB,
    hardLimitBytes: 512 * MiB,
    isWarning: false,
    isAtHardLimit: false,
    sessionCount: 1,
    messageCount: 4,
    artifactCount: cacheBytes > 0 ? 2 : 0,
    canonicalArtifactCount: 0,
    cacheArtifactCount: cacheBytes > 0 ? 2 : 0,
    browser: {
      usageBytes: 5 * MiB,
      quotaBytes: 2 * 1_024 * MiB,
    },
  };
}

function agentStorageResponse(cacheBytes = 2 * MiB) {
  return Promise.resolve({ ok: true, data: agentStorageUsage(cacheBytes) });
}

function config(overrides: Partial<Config> = {}): Config {
  const defaultAgentProvider = {
    provider: 'openai',
    protocol: null,
    baseUrl: null,
    model: 'gpt-5.4',
    declaredContextWindow: null,
    workingContextWindow: null,
    apiKeyEncrypted: null,
    apiKeyCryptoMeta: null,
    credentialScope: null,
    credentialRevision: null,
    capability: null,
  } as const;
  return {
    ...overrides,
    tokenEncrypted: overrides.tokenEncrypted ?? 'cipher',
    tokenCryptoMeta: overrides.tokenCryptoMeta ?? { iv: 'iv', salt: 'salt' },
    githubCredentialStatus: overrides.githubCredentialStatus ?? 'ready',
    watchNotificationsEnabled: overrides.watchNotificationsEnabled ?? false,
    watchCollapsedRepositories: overrides.watchCollapsedRepositories ?? {},
    agentProvider: overrides.agentProvider
      ? {
          declaredContextWindow: overrides.agentProvider.provider === 'custom-openai-compatible'
            || (overrides.agentProvider.provider === 'openrouter'
              && overrides.agentProvider.model === 'openrouter/auto')
            ? 32_768
            : null,
          workingContextWindow: null,
          ...overrides.agentProvider,
        }
      : defaultAgentProvider,
    agentDataDisclosureAcceptance: Object.hasOwn(overrides, 'agentDataDisclosureAcceptance')
      ? overrides.agentDataDisclosureAcceptance ?? null
      : {
          version: 2,
          provider: 'openai',
          origin: 'https://api.openai.com',
          acceptedAt: 1,
        },
    theme: overrides.theme ?? 'dark',
    locale: overrides.locale ?? 'en',
    defaultView: overrides.defaultView ?? 'table',
    lastSyncStarredAt: overrides.lastSyncStarredAt ?? null,
    gistId: overrides.gistId ?? null,
    gistSyncCursor: overrides.gistSyncCursor ?? null,
    username: overrides.username ?? 'octocat',
    avatarUrl: overrides.avatarUrl ?? null,
    displayName: overrides.displayName ?? null,
    onboardingStage: overrides.onboardingStage ?? 'done',
    seenOnboarding: overrides.seenOnboarding ?? true,
    seenTooltips: overrides.seenTooltips ?? 0,
    autoTagAgentPromptSeen: overrides.autoTagAgentPromptSeen ?? false,
    autoTagLimit: overrides.autoTagLimit ?? 5,
    maxTagsPerRepo: overrides.maxTagsPerRepo ?? 5,
    minTopicRepoCount: overrides.minTopicRepoCount ?? 3,
    libraryView: overrides.libraryView ?? {
      version: 1,
      filters: {
        languages: [],
        tags: [],
        tagMode: 'any',
        showTombstone: false,
        onlyFavorite: false,
        onlyUntagged: false,
        onlyArchived: false,
        onlyOwned: false,
      },
      sort: {
        sortKey: 'starred_at',
        sortDir: 'desc',
      },
    },
    starsPanelDefaultEnabled: overrides.starsPanelDefaultEnabled ?? true,
    columnLayoutMode: overrides.columnLayoutMode ?? 'default',
    customColumnLayout: overrides.customColumnLayout ?? null,
    langTagMigrationDone: overrides.langTagMigrationDone ?? true,
    lastSyncProgress:
      overrides.lastSyncProgress ?? {
        phase: 'idle',
        done: 0,
        total: null,
        message: '',
      },
    backfills: overrides.backfills ?? {},
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

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('Options preferences', () => {
  beforeEach(() => {
    authMocks.getConfig.mockReset();
    authMocks.hasToken.mockReset();
    authMocks.hasWatchNotificationsToken.mockReset();
    authMocks.hasWatchNotificationsToken.mockResolvedValue(false);
    authMocks.enableWatchWithMainToken.mockReset();
    authMocks.setToken.mockReset();
    authMocks.clearToken.mockReset();
    authMocks.setWatchNotificationsToken.mockReset();
    authMocks.updateAgentProviderConfig.mockReset();
    authMocks.acceptAgentDataDisclosure.mockReset();
    authMocks.clearAgentProviderApiKey.mockReset();
    authMocks.setTheme.mockReset();
    authMocks.update.mockReset();
    authMocks.updateAutoTagPolicy.mockReset();
    storageListeners.length = 0;
    for (const key of Object.keys(sessionStorageValues)) delete sessionStorageValues[key];
    runtimeListeners.length = 0;
    permissionAddedListeners.length = 0;
    permissionRemovedListeners.length = 0;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((message: unknown) => {
          const request = (message ?? {}) as { type?: string; model?: string };
          if (request.type === 'getAgentStorageUsage') return agentStorageResponse();
          if (request.type === 'clearAgentToolCache') {
            return Promise.resolve({
              ok: true,
              data: {
                deletedArtifacts: 2,
                freedBytes: 2 * MiB,
                protectedArtifacts: 0,
                usage: agentStorageUsage(0),
              },
            });
          }
          if (request.type === 'testAgentProviderConnection') {
            return Promise.resolve({
              ok: true,
              data: {
                providerLabel: 'OpenAI',
                model: request.model ?? 'gpt-5.4',
                latencyMs: 123,
                preview: 'OK',
              },
            });
          }
          return Promise.resolve({
            ok: true,
            data: {
              progress: { phase: 'idle', done: 0, total: null, message: '' },
              hasToken: true,
              onboardingStage: 'done',
              seenOnboarding: true,
              seenTooltips: 0,
              backfills: {},
              activeBackfillId: null,
              inFlight: false,
            },
          });
        }),
        onMessage: {
          addListener: vi.fn((listener) => runtimeListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = runtimeListeners.indexOf(listener);
            if (index >= 0) runtimeListeners.splice(index, 1);
          }),
        },
      },
      storage: {
        session: {
          get: vi.fn(async (key: string) => (
            Object.hasOwn(sessionStorageValues, key)
              ? { [key]: sessionStorageValues[key] }
              : {}
          )),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(sessionStorageValues, items);
          }),
          remove: vi.fn(async (key: string) => {
            delete sessionStorageValues[key];
          }),
        },
        onChanged: {
          addListener: vi.fn((listener) => storageListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = storageListeners.indexOf(listener);
            if (index >= 0) storageListeners.splice(index, 1);
          }),
        },
      },
      permissions: {
        contains: vi.fn(() => Promise.resolve(false)),
        request: vi.fn(() => Promise.resolve(true)),
        onAdded: {
          addListener: vi.fn((listener) => permissionAddedListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = permissionAddedListeners.indexOf(listener);
            if (index >= 0) permissionAddedListeners.splice(index, 1);
          }),
        },
        onRemoved: {
          addListener: vi.fn((listener) => permissionRemovedListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = permissionRemovedListeners.indexOf(listener);
            if (index >= 0) permissionRemovedListeners.splice(index, 1);
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

    const link = document.querySelector<HTMLAnchorElement>('a[href="https://github.com/octocat?tab=stars"]');
    expect(link).not.toBeNull();
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noreferrer');
    expect(link?.textContent).toContain('Open my stars');
  });

  it('hides the stars link when only cached username remains', async () => {
    authMocks.getConfig.mockResolvedValue(config({ tokenEncrypted: null, tokenCryptoMeta: null }));
    authMocks.hasToken.mockResolvedValue(false);

    await renderOptions();

    expect(document.querySelector('a[href="https://github.com/octocat?tab=stars"]')).toBeNull();
    expect(document.body.textContent).toContain(watchCopy.cachedAccountWarning('octocat'));
  });

  it('loads Agent storage independently and clears only the re-fetchable tool cache', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);

    await renderOptions();

    const panel = document.querySelector('[data-testid="agent-storage-panel"]');
    expect(panel?.textContent).toContain('Conversation, recovery & saved artifacts');
    expect(panel?.textContent).toContain('Conversation, recovery & artifact ledger total');
    expect(panel?.textContent).toContain('1 MiB');
    expect(panel?.textContent).toContain('Re-fetchable tool cache');
    expect(panel?.textContent).toContain('2 MiB');
    expect(panel?.textContent).toContain('None is counted in this ledger');
    expect(panel?.textContent).toContain('Whole-extension browser storage estimate');
    const clearCache = [...panel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Clear tool cache'));
    expect(clearCache).toBeDefined();
    expect(clearCache?.getAttribute('aria-describedby')).toBe('agent-storage-clear-hint');

    await click(clearCache!);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'clearAgentToolCache',
    });
    expect(panel?.textContent).toContain('0 B');
    expect(panel?.textContent).toContain('Cleared 2 cached tool artifacts and freed 2 MiB.');
    expect(clearCache?.disabled).toBe(true);
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

  it('reverts split auto-tag policy inputs when persistence fails', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAutoTagPolicy
      .mockRejectedValueOnce(new Error('storage down'))
      .mockRejectedValueOnce(new Error('storage down'));

    await renderOptions();

    const maxTags = document.querySelector<HTMLInputElement>('#max-tags-per-repo');
    const minCoverage = document.querySelector<HTMLInputElement>('#min-topic-repo-count');
    expect(maxTags).not.toBeNull();
    expect(minCoverage).not.toBeNull();

    await setInputValue(maxTags!, '12');
    await blur(maxTags!);
    await setInputValue(minCoverage!, '6');
    await blur(minCoverage!);

    expect(maxTags?.value).toBe('5');
    expect(minCoverage?.value).toBe('3');
    expect(document.body.textContent).toContain('storage down');
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

    expect(document.querySelector('a[href="https://github.com/octocat?tab=stars"]')).toBeNull();
  });

  it('shows a saved token warning when optional Notifications access is unavailable', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.setToken.mockResolvedValue({
      username: 'octocat',
      notifications: { available: false, errorCode: TOKEN_WATCHING_FORBIDDEN },
    });
    await renderOptions();
    const input = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="github_pat_..."]');
    await setTextareaValue(input!, 'github_pat_without_notifications');
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Save & verify');
    await click(save!);
    expect(authMocks.setToken).toHaveBeenCalledWith('github_pat_without_notifications');
    expect(document.querySelector('[data-testid="main-token-status"]')?.textContent)
      .toContain(watchCopy.tokenVerifiedWatchForbidden('octocat'));
  });
  it('consumes an initial Watch intent, renders the setup block, and focuses its heading', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);
    sessionStorageValues[OPTIONS_INTENT_STORAGE_KEY] = {
      section: 'watch',
      requestedAt: 1,
    };

    await renderOptions();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const watchSettings = document.querySelector<HTMLElement>(
      '[data-testid="watch-inbox-settings"]',
    );
    const heading = watchSettings?.querySelector<HTMLElement>(
      'h2[tabindex="-1"], h3[tabindex="-1"]',
    );
    expect(watchSettings).not.toBeNull();
    expect(heading?.textContent?.trim()).not.toBe('');
    expect(document.activeElement).toBe(heading);
    expect(document.querySelector('[data-testid="watch-dedicated-form"]')).toBeNull();
    expect(chrome.storage.session.remove).toHaveBeenCalledWith(OPTIONS_INTENT_STORAGE_KEY);
  });

  it('consumes a new Watch intent in an already-open Options page and moves focus to setup', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);

    await renderOptions();

    const watchSettings = document.querySelector<HTMLElement>(
      '[data-testid="watch-inbox-settings"]',
    );
    const heading = watchSettings?.querySelector<HTMLElement>(
      'h2[tabindex="-1"], h3[tabindex="-1"]',
    );
    expect(watchSettings).not.toBeNull();
    expect(document.activeElement).not.toBe(heading);

    const intent = { section: 'watch', requestedAt: 2 };
    sessionStorageValues[OPTIONS_INTENT_STORAGE_KEY] = intent;
    await act(async () => {
      for (const listener of storageListeners) {
        listener({
          [OPTIONS_INTENT_STORAGE_KEY]: { newValue: intent },
        }, 'session');
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(heading);
    expect(document.querySelector('[data-testid="watch-dedicated-form"]')).toBeNull();
    expect(chrome.storage.session.remove).toHaveBeenCalledWith(OPTIONS_INTENT_STORAGE_KEY);
  });

  it('saves and automatically tests Cubby settings with the saved key', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAgentProviderConfig.mockResolvedValue(undefined);

    await renderOptions();

    const modelInput = document.querySelector<HTMLInputElement>('#agent-model');
    const keyInput = document.querySelector<HTMLInputElement>('#agent-api-key');
    const saveButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save & test');

    expect(modelInput).not.toBeNull();
    expect(keyInput).not.toBeNull();
    expect(saveButton).toBeInstanceOf(HTMLButtonElement);

    await setInputValue(modelInput!, 'gpt-5');
    await setInputValue(keyInput!, 'sk-test');
    await click(saveButton as HTMLButtonElement);

    expect(authMocks.updateAgentProviderConfig).toHaveBeenCalledWith({
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5',
      declaredContextWindow: null,
      workingContextWindow: null,
      apiKey: 'sk-test',
    });
    expect(keyInput?.value).toBe('');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'testAgentProviderConnection',
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5',
      declaredContextWindow: null,
      workingContextWindow: null,
      apiKey: undefined,
    });
    const status = document.querySelector('[data-testid="agent-connection-status"]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toContain('Saved · Connected to OpenAI · gpt-5 (123 ms)');
  });

  it('keeps saved settings and shows an inline error when automatic testing fails', async () => {
    authMocks.getConfig.mockResolvedValue(config());
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAgentProviderConfig.mockResolvedValue(undefined);
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: unknown) => {
      const request = (message ?? {}) as { type?: string };
      if (request.type === 'getAgentStorageUsage') return agentStorageResponse();
      if (request.type === 'testAgentProviderConnection') {
        return Promise.resolve({
          ok: false,
          error: 'Something went wrong: AI provider rejected the request (401).',
        });
      }
      return Promise.resolve({
        ok: true,
        data: {
          progress: { phase: 'idle', done: 0, total: null, message: '' },
          hasToken: true,
          onboardingStage: 'done',
          seenOnboarding: true,
          seenTooltips: 0,
          backfills: {},
          activeBackfillId: null,
          inFlight: false,
        },
      });
    }) as typeof chrome.runtime.sendMessage);

    await renderOptions();
    const keyInput = document.querySelector<HTMLInputElement>('#agent-api-key');
    const saveButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save & test');
    await setInputValue(keyInput!, 'sk-timeout');
    await click(saveButton as HTMLButtonElement);

    expect(authMocks.updateAgentProviderConfig).toHaveBeenCalledOnce();
    expect(keyInput?.value).toBe('');
    const status = document.querySelector('[data-testid="agent-connection-status"]');
    expect(status?.getAttribute('role')).toBe('alert');
    expect(status?.textContent).toContain('Settings saved, but the connection test failed:');
    expect(status?.textContent).toContain('Something went wrong: AI provider rejected the request (401).');
    expect(status?.textContent).not.toContain('Something went wrong: Something went wrong:');
  });

  it.each([
    ['openai', 'gpt-5.4', 'https://api.openai.com'],
    ['openrouter', 'openrouter/auto', 'https://openrouter.ai'],
    ['anthropic', 'claude-sonnet-4-5', 'https://api.anthropic.com'],
  ] as const)(
    'keeps protocol and Base URL out of the ordinary %s service form',
    async (provider, model, origin) => {
      authMocks.getConfig.mockResolvedValue(config({
        agentProvider: {
          provider,
          protocol: null,
          baseUrl: null,
          model,
          apiKeyEncrypted: null,
          apiKeyCryptoMeta: null,
          credentialScope: null,
          credentialRevision: null,
          capability: null,
        },
        agentDataDisclosureAcceptance: {
          version: 2,
          provider,
          origin,
          acceptedAt: 1,
        },
      }));
      authMocks.hasToken.mockResolvedValue(true);

      await renderOptions();

      expect(document.querySelector('#agent-provider')).not.toBeNull();
      expect(document.querySelector('#agent-model')).not.toBeNull();
      expect(document.querySelector('#agent-api-key')).not.toBeNull();
      const advanced = document.querySelector<HTMLDetailsElement>(
        '[data-testid="agent-advanced-settings"]',
      );
      expect(advanced).not.toBeNull();
      expect(advanced?.open).toBe(false);
      expect(advanced?.querySelector('#agent-working-context-window')).not.toBeNull();
      expect(advanced?.querySelector('#agent-provider-context-window') !== null)
        .toBe(provider === 'openrouter');
      expect(document.querySelector('#agent-base-url')).toBeNull();
      expect(document.body.textContent).not.toContain('API protocol');
    },
  );

  it('saves a custom AI service without requesting host access', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'custom-openai-compatible',
        protocol: 'chat-completions',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        apiKeyEncrypted: null,
        apiKeyCryptoMeta: null,
        credentialScope: null,
        credentialRevision: null,
        capability: null,
      },
    }));
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAgentProviderConfig.mockResolvedValue(undefined);

    await renderOptions();

    const baseUrlInput = document.querySelector<HTMLInputElement>('#agent-base-url');
    const keyInput = document.querySelector<HTMLInputElement>('#agent-api-key');
    const saveButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save & test');

    expect(baseUrlInput).not.toBeNull();
    expect(keyInput).not.toBeNull();
    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    const advanced = document.querySelector<HTMLDetailsElement>(
      '[data-testid="agent-advanced-settings"]',
    );
    expect(advanced).not.toBeNull();
    expect(advanced?.open).toBe(false);

    await setInputValue(baseUrlInput!, 'https://proxy.example.dev/v1');
    await setInputValue(keyInput!, 'sk-custom');
    await click(saveButton as HTMLButtonElement);

    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(authMocks.updateAgentProviderConfig).toHaveBeenCalledWith({
      provider: 'custom-openai-compatible',
      protocol: 'chat-completions',
      baseUrl: 'https://proxy.example.dev/v1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      workingContextWindow: null,
      apiKey: 'sk-custom',
    });
    expect(document.querySelector('[data-testid="agent-connection-status"]')?.textContent)
      .toContain('Settings saved. Allow Chrome access, then test the connection.');
  });

  it('uses an exact Custom model preset without requiring capacity and allows an override', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'custom-openai-compatible',
        protocol: 'responses',
        baseUrl: 'https://relay.example.com/v1',
        model: 'gpt-5.4',
        declaredContextWindow: null,
        workingContextWindow: null,
        apiKeyEncrypted: null,
        apiKeyCryptoMeta: null,
        credentialScope: null,
        credentialRevision: null,
        capability: null,
      },
    }));
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAgentProviderConfig.mockResolvedValue(undefined);
    vi.mocked(chrome.permissions.contains).mockImplementation(
      () => Promise.resolve(true) as never,
    );

    await renderOptions();
    const providerWindow = document.querySelector<HTMLInputElement>(
      '#agent-provider-context-window',
    );
    const workingWindow = document.querySelector<HTMLInputElement>(
      '#agent-working-context-window',
    );
    const keyInput = document.querySelector<HTMLInputElement>('#agent-api-key');
    const saveButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save & test') as HTMLButtonElement;

    expect(providerWindow?.required).toBe(false);
    expect(providerWindow?.placeholder).toBe('1050000');
    expect(document.body.textContent).toContain('Known model IDs use an exact built-in preset.');
    await setInputValue(keyInput!, 'sk-preset');
    expect(saveButton.disabled).toBe(false);

    await setInputValue(workingWindow!, '2000000');
    expect(saveButton.disabled).toBe(true);
    await setInputValue(providerWindow!, '2000000');
    expect(saveButton.disabled).toBe(false);
    await setInputValue(providerWindow!, '');
    expect(saveButton.disabled).toBe(true);

    await setInputValue(providerWindow!, '65536');
    await setInputValue(workingWindow!, '64000');
    await click(saveButton);
    expect(authMocks.updateAgentProviderConfig).toHaveBeenCalledWith({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example.com/v1',
      model: 'gpt-5.4',
      declaredContextWindow: 65_536,
      workingContextWindow: 64_000,
      apiKey: 'sk-preset',
    });
  });

  it('requires unknown service capacity, validates both window ranges, and sends normalized values', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'custom-openai-compatible',
        protocol: 'chat-completions',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        declaredContextWindow: null,
        workingContextWindow: null,
        apiKeyEncrypted: null,
        apiKeyCryptoMeta: null,
        credentialScope: null,
        credentialRevision: null,
        capability: null,
      },
    }));
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAgentProviderConfig.mockResolvedValue(undefined);
    vi.mocked(chrome.permissions.contains).mockImplementation(
      () => Promise.resolve(true) as never,
    );

    await renderOptions();
    const advanced = document.querySelector<HTMLDetailsElement>(
      '[data-testid="agent-advanced-settings"]',
    );
    const providerWindow = document.querySelector<HTMLInputElement>(
      '#agent-provider-context-window',
    );
    const workingWindow = document.querySelector<HTMLInputElement>(
      '#agent-working-context-window',
    );
    const keyInput = document.querySelector<HTMLInputElement>('#agent-api-key');
    const saveButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save & test') as HTMLButtonElement;

    expect(advanced?.open).toBe(false);
    expect(providerWindow?.required).toBe(true);
    expect(providerWindow?.min).toBe('4096');
    expect(providerWindow?.max).toBe('2000000');
    expect(workingWindow?.required).toBe(false);
    expect(saveButton.disabled).toBe(true);

    await setInputValue(providerWindow!, '4095');
    expect(providerWindow?.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain('Enter a whole number from 4,096 to 2,000,000.');
    expect(saveButton.disabled).toBe(true);

    await setInputValue(providerWindow!, '128000');
    await setInputValue(workingWindow!, '2000001');
    expect(workingWindow?.getAttribute('aria-invalid')).toBe('true');
    expect(saveButton.disabled).toBe(true);

    await setInputValue(workingWindow!, '256000');
    expect(workingWindow?.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain('The working window cannot exceed the service window.');
    expect(saveButton.disabled).toBe(true);

    await setInputValue(workingWindow!, '64000');
    await setInputValue(keyInput!, 'sk-context');
    expect(saveButton.disabled).toBe(false);
    await click(saveButton);

    expect(authMocks.updateAgentProviderConfig).toHaveBeenCalledWith({
      provider: 'custom-openai-compatible',
      protocol: 'chat-completions',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 128_000,
      workingContextWindow: 64_000,
      apiKey: 'sk-context',
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'testAgentProviderConnection',
      provider: 'custom-openai-compatible',
      protocol: 'chat-completions',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 128_000,
      workingContextWindow: 64_000,
      apiKey: undefined,
    });
  });

  it('keeps same-origin setup state across protocol changes and sends Responses in save and test payloads', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'custom-openai-compatible',
        protocol: 'responses',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        apiKeyEncrypted: 'saved-cipher',
        apiKeyCryptoMeta: { iv: 'saved-iv', salt: 'saved-salt' },
        credentialScope: {
          provider: 'custom-openai-compatible',
          origin: 'https://relay.example.com',
        },
        credentialRevision: 'cr:v1:saved',
        capability: null,
      },
      agentDataDisclosureAcceptance: null,
    }));
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAgentProviderConfig.mockResolvedValue(undefined);
    vi.mocked(chrome.permissions.contains).mockImplementation(
      () => Promise.resolve(true) as never,
    );

    await renderOptions();

    const chatProtocol = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Chat Completions');
    const responsesProtocol = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Responses API');
    const saveButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save & test');
    const testButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Test connection')) as HTMLButtonElement;

    expect(chatProtocol).toBeInstanceOf(HTMLButtonElement);
    expect(responsesProtocol).toBeInstanceOf(HTMLButtonElement);
    expect(responsesProtocol?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('A saved key is already on this device.');
    expect(document.body.textContent).not.toContain('Accept disclosure');
    expect(document.body.textContent).toContain('Access allowed');
    expect(testButton.disabled).toBe(false);

    await click(chatProtocol as HTMLButtonElement);

    expect(chatProtocol?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('A saved key is already on this device.');
    expect(document.body.textContent).not.toContain('Accept disclosure');
    expect(document.body.textContent).toContain('Access allowed');
    expect(testButton.disabled).toBe(false);
    expect(chrome.permissions.request).not.toHaveBeenCalled();

    await click(responsesProtocol as HTMLButtonElement);
    await click(saveButton as HTMLButtonElement);
    expect(authMocks.updateAgentProviderConfig).toHaveBeenCalledWith({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      workingContextWindow: null,
      apiKey: '',
    });
    expect(chrome.permissions.request).not.toHaveBeenCalled();

    await click(testButton);
    const providerMessages = vi.mocked(chrome.runtime.sendMessage).mock.calls
      .map(([message]) => message as unknown as Record<string, unknown>)
      .filter((message) => message.type === 'testAgentProviderConnection');
    expect(providerMessages).toContainEqual({
      type: 'testAgentProviderConnection',
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      workingContextWindow: null,
      apiKey: undefined,
    });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('defines matching English and Chinese Custom advanced-setting copy', () => {
    const english = getMessages('en').options;
    const chinese = getMessages('zh-CN').options;

    expect([
      english.agentAdvancedSettings,
      english.agentProtocolLabel,
      english.agentProtocolChat,
      english.agentProtocolResponses,
    ]).toEqual(['Advanced settings', 'API protocol', 'Chat Completions', 'Responses API']);
    expect([
      chinese.agentAdvancedSettings,
      chinese.agentProtocolLabel,
      chinese.agentProtocolChat,
      chinese.agentProtocolResponses,
    ]).toEqual(['高级设置', 'API 协议', 'Chat Completions', 'Responses API']);
    expect([
      english.agentProviderContextWindowLabel,
      english.agentWorkingContextWindowLabel,
      chinese.agentProviderContextWindowLabel,
      chinese.agentWorkingContextWindowLabel,
    ]).toEqual([
      'Service context window',
      'Working context window',
      '服务上下文窗口',
      '工作上下文窗口',
    ]);
    expect(english.agentWorkingContextWindowHint).toContain('only reduce');
    expect(chinese.agentWorkingContextWindowHint).toContain('只能降低');
  });

  it('preserves custom settings but makes no test request when host permission is denied', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'custom-openai-compatible',
        protocol: 'chat-completions',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        apiKeyEncrypted: null,
        apiKeyCryptoMeta: null,
        credentialScope: null,
        credentialRevision: null,
        capability: null,
      },
    }));
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.updateAgentProviderConfig.mockResolvedValue(undefined);
    vi.mocked(chrome.permissions.request).mockImplementation(
      () => Promise.resolve(false) as never,
    );

    await renderOptions();
    const keyInput = document.querySelector<HTMLInputElement>('#agent-api-key');
    const saveButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save & test');
    const testButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Test connection'));
    await setInputValue(keyInput!, 'transient-secret');
    await click(saveButton as HTMLButtonElement);
    const grantButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Allow access'));
    expect(grantButton).toBeInstanceOf(HTMLButtonElement);
    await click(grantButton as HTMLButtonElement);
    await click(testButton as HTMLButtonElement);

    expect(authMocks.updateAgentProviderConfig).toHaveBeenCalledOnce();
    expect(authMocks.acceptAgentDataDisclosure).not.toHaveBeenCalled();
    const providerMessages = vi.mocked(chrome.runtime.sendMessage).mock.calls
      .map(([message]) => message as { type?: string })
      .filter((message) => message.type === 'testAgentProviderConnection');
    expect(providerMessages).toHaveLength(0);
  });

  it('disables Test and restores Allow access when custom host permission is revoked', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'custom-openai-compatible',
        protocol: 'chat-completions',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        apiKeyEncrypted: 'saved-cipher',
        apiKeyCryptoMeta: { iv: 'saved-iv', salt: 'saved-salt' },
        credentialScope: {
          provider: 'custom-openai-compatible',
          origin: 'https://relay.example.com',
        },
        credentialRevision: 'cr:v1:saved',
        capability: null,
      },
      agentDataDisclosureAcceptance: {
        version: 2,
        provider: 'custom-openai-compatible',
        origin: 'https://relay.example.com',
        acceptedAt: 1,
      },
    }));
    authMocks.hasToken.mockResolvedValue(true);
    vi.mocked(chrome.permissions.contains).mockImplementation(
      () => Promise.resolve(true) as never,
    );

    await renderOptions();
    const testButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Test connection')) as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);
    expect([...document.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('Allow access'))).toBe(false);

    vi.mocked(chrome.permissions.contains).mockImplementation(
      () => Promise.resolve(false) as never,
    );
    await act(async () => {
      permissionRemovedListeners[0]?.({ origins: ['https://relay.example.com/*'] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testButton.disabled).toBe(true);
    expect([...document.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('Allow access'))).toBe(true);
  });

  it('refreshes custom host access after a failed connection test', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'custom-openai-compatible',
        protocol: 'chat-completions',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        apiKeyEncrypted: 'saved-cipher',
        apiKeyCryptoMeta: { iv: 'saved-iv', salt: 'saved-salt' },
        credentialScope: {
          provider: 'custom-openai-compatible',
          origin: 'https://relay.example.com',
        },
        credentialRevision: 'cr:v1:saved',
        capability: null,
      },
      agentDataDisclosureAcceptance: {
        version: 2,
        provider: 'custom-openai-compatible',
        origin: 'https://relay.example.com',
        acceptedAt: 1,
      },
    }));
    authMocks.hasToken.mockResolvedValue(true);
    vi.mocked(chrome.permissions.contains)
      .mockImplementationOnce(() => Promise.resolve(true) as never)
      .mockImplementation(() => Promise.resolve(false) as never);
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: unknown) => {
      const typedMessage = (message ?? {}) as { type?: string };
      if (typedMessage.type === 'getAgentStorageUsage') return agentStorageResponse();
      if (typedMessage.type === 'testAgentProviderConnection') {
        return Promise.reject(new Error('AGENT_HOST_PERMISSION_DENIED'));
      }
      return Promise.resolve({ ok: true, data: null });
    }) as typeof chrome.runtime.sendMessage);

    await renderOptions();
    const testButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Test connection')) as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);
    await click(testButton);

    expect(testButton.disabled).toBe(true);
    expect([...document.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('Allow access'))).toBe(true);
  });

  it('tests Cubby connection with the current form values', async () => {
    authMocks.getConfig.mockResolvedValue(config({ agentDataDisclosureAcceptance: null }));
    authMocks.hasToken.mockResolvedValue(true);
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: unknown) => {
      const typedMessage = (message ?? {}) as {
        type?: string;
        [key: string]: unknown;
      };
      if (typedMessage.type === 'getAgentStorageUsage') return agentStorageResponse();
      if (typedMessage.type === 'testAgentProviderConnection') {
        return Promise.resolve({
          ok: true,
          data: {
            providerLabel: 'OpenAI',
            model: 'gpt-5.4',
            latencyMs: 321,
            preview: 'OK',
          },
        });
      }
      return Promise.resolve({
        ok: true,
        data: {
          progress: { phase: 'idle', done: 0, total: null, message: '' },
          hasToken: true,
          onboardingStage: 'done',
          seenOnboarding: true,
          seenTooltips: 0,
          backfills: {},
          activeBackfillId: null,
          inFlight: false,
        },
      });
    }) as typeof chrome.runtime.sendMessage);

    await renderOptions();

    const keyInput = document.querySelector<HTMLInputElement>('#agent-api-key');
    const testButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Test connection'));

    expect(keyInput).not.toBeNull();
    expect(testButton).toBeInstanceOf(HTMLButtonElement);

    await setInputValue(keyInput!, 'sk-live');
    await click(testButton as HTMLButtonElement);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'testAgentProviderConnection',
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5.4',
      declaredContextWindow: null,
      workingContextWindow: null,
      apiKey: 'sk-live',
    });
    expect(document.body.textContent).toContain(
      'Connected to OpenAI · gpt-5.4 (321 ms)',
    );
  });

  it('ignores legacy disclosure acceptance changes without resetting provider drafts', async () => {
    const initial = config({ agentDataDisclosureAcceptance: null });
    const accepted = config({
      agentDataDisclosureAcceptance: {
        version: 2,
        provider: 'openai',
        origin: 'https://api.openai.com',
        acceptedAt: 2,
      },
    });
    authMocks.getConfig.mockResolvedValueOnce(initial).mockResolvedValue(accepted);
    authMocks.hasToken.mockResolvedValue(true);

    await renderOptions();
    const modelInput = document.querySelector<HTMLInputElement>('#agent-model');
    await setInputValue(modelInput!, 'draft-model-not-yet-saved');
    await act(async () => {
      storageListeners[0]?.({
        gsm_config: { oldValue: initial, newValue: accepted },
      }, 'local');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(modelInput?.value).toBe('draft-model-not-yet-saved');
    expect(document.body.textContent).not.toContain('Accept disclosure');
  });

  it('lets the user remove a saved AI service key', async () => {
    authMocks.getConfig.mockResolvedValue(config({
      agentProvider: {
        provider: 'openai',
        protocol: null,
        baseUrl: null,
        model: 'gpt-5-mini',
        apiKeyEncrypted: 'saved-cipher',
        apiKeyCryptoMeta: { iv: 'saved-iv', salt: 'saved-salt' },
        credentialScope: {
          provider: 'openai',
          origin: 'https://api.openai.com',
        },
        credentialRevision: 'cr:v1:saved',
        capability: null,
      },
    }));
    authMocks.hasToken.mockResolvedValue(true);
    authMocks.clearAgentProviderApiKey.mockResolvedValue(undefined);

    await renderOptions();

    expect(document.body.textContent).toContain(
      'A saved key is already on this device.',
    );

    const clearButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Remove saved key'));
    expect(clearButton).toBeInstanceOf(HTMLButtonElement);

    await click(clearButton as HTMLButtonElement);

    expect(authMocks.clearAgentProviderApiKey).toHaveBeenCalledTimes(1);
  });
});
