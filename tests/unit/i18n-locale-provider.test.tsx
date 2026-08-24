/**
 * @vitest-environment jsdom
 */
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { getMessages, I18nProvider, messageFor, useI18n } from '@/i18n';
import { DEFAULT_LIBRARY_VIEW_PREFS } from '@/preferences';
import { getAgentDiagnosticsMessages } from '@/dev-agent/messages';
import { applyFabLabel } from '@/content/stars-page/fab-label';
import type { Locale } from '@/types';
import type { ManagerPreferences, ManagerRuntimeListener } from '@/runtime/manager-runtime';

const authMock = vi.hoisted(() => ({
  getLocale: vi.fn<() => Promise<Locale>>(),
  setLocale: vi.fn<(locale: Locale) => Promise<void>>(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  authStore: authMock,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];

function collectShape(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'function') return { [prefix]: `function:${value.length}` };
  if (!value || typeof value !== 'object') return { [prefix]: typeof value };
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => Object.entries(collectShape(child, prefix ? `${prefix}.${key}` : key))),
  );
}

function Consumer() {
  const { locale, setLocale, m } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{m.popup.title}</span>
      <button type="button" onClick={() => void setLocale(locale === 'en' ? 'zh-CN' : 'en')}>
        switch
      </button>
    </div>
  );
}

function localePreferences(locale: Locale): ManagerPreferences {
  return {
    theme: 'dark',
    locale,
    radarWindowDays: 30,
    libraryView: DEFAULT_LIBRARY_VIEW_PREFS,
    watchCollapsedRepositories: {},
    columnLayoutMode: 'default',
    customColumnLayout: null,
  };
}

const localeSource = {
  async readPreferences() {
    return localePreferences(await authMock.getLocale());
  },
  async updatePreferences(patch: Partial<ManagerPreferences>) {
    if (patch.locale) await authMock.setLocale(patch.locale);
    return localePreferences(patch.locale ?? await authMock.getLocale());
  },
  subscribe(listener: ManagerRuntimeListener) {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes.gsm_config) {
        listener({ kind: 'preferences', epoch: 1 });
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  },
};

function mountProvider() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider source={localeSource}>
        <Consumer />
      </I18nProvider>,
    );
  });
  roots.push(root);
  return host;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  storageListeners = [];
  authMock.getLocale.mockReset();
  authMock.setLocale.mockReset();
  authMock.getLocale.mockResolvedValue('en');
  authMock.setLocale.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
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
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('i18n catalog and locale propagation invariants', () => {
  it('keeps catalog key and value-type parity across supported locales', () => {
    assert.deepEqual(collectShape(getMessages('zh-CN')), collectShape(getMessages('en')));
  });

  it('falls back predictably and exposes messageFor as the same lookup function', () => {
    assert.equal(getMessages('en'), messageFor('en'));
    assert.equal(getMessages('missing' as Locale), getMessages('en'));
    assert.equal(messageFor('missing' as Locale), getMessages('en'));
  });

  it('keeps generic Cubby lifecycle statuses separate from tag operations', () => {
    const english = getMessages('en').agentPanel;
    const chinese = getMessages('zh-CN').agentPanel;

    const lifecycle = ['agentStarting', 'agentThinking', 'agentWriting', 'agentCompacting'] as const;
    for (const key of lifecycle) {
      assert.equal(typeof english[key], 'string');
      assert.ok(english[key].length > 0);
      assert.equal(typeof chinese[key], 'string');
      assert.ok(chinese[key].length > 0);
      assert.notEqual(english[key], english.agentApplyingChanges);
      assert.notEqual(chinese[key], chinese.agentApplyingChanges);
    }
  });

  it('interpolates the current Watch repository count in both product locales', () => {
    const english = getMessages('en');
    const chinese = getMessages('zh-CN');

    assert.match(english.watch.statusFresh(804, 4), /804/u);
    assert.match(english.watch.statusFresh(804, 4), /\b4\b/u);
    assert.match(chinese.watch.statusFresh(804, 4), /804/u);
    assert.match(chinese.watch.statusFresh(804, 4), /\b4\b/u);
    assert.notEqual(english.watch.statusFresh(1, 1), english.watch.statusFresh(1, 2));
  });

  it('interpolates Cubby scope summary counts in both product locales', () => {
    const english = getMessages('en').agentPanel;
    const chinese = getMessages('zh-CN').agentPanel;

    assert.match(english.askingAboutCurrentView(2), /2/u);
    assert.match(chinese.askingAboutCurrentView(2), /2/u);
    assert.match(english.askingAboutAllLiveStars(2), /2/u);
    assert.match(chinese.askingAboutAllLiveStars(2), /2/u);
    assert.match(english.workbench.repositoriesFrozen(290), /290/u);
    assert.match(chinese.workbench.repositoriesFrozen(290), /290/u);
    assert.notEqual(english.askingAboutCurrentView(1), english.askingAboutCurrentView(2));
    assert.notEqual(chinese.askingAboutCurrentView(2), english.askingAboutCurrentView(2));
  });

  it('localizes ownership conflicts and session-deletion messages', () => {
    const english = getMessages('en');
    const chinese = getMessages('zh-CN');

    assert.equal(typeof english.agentPanel.workbench.takeControl, 'string');
    assert.ok(english.agentPanel.workbench.takeControl.length > 0);
    assert.equal(typeof chinese.agentPanel.workbench.takeControl, 'string');
    assert.ok(chinese.agentPanel.workbench.takeControl.length > 0);
    assert.match(english.agentPanel.workbench.takeControlFailedOwnerConnected, /read-only/u);
    assert.match(chinese.agentPanel.workbench.takeControlFailedOwnerConnected, /只读/u);
    assert.equal(typeof chinese.agentPanel.workbench.receiptOriginDeleted, 'string');
    assert.ok(chinese.agentPanel.workbench.receiptOriginDeleted.length > 0);
    assert.match(english.agentPanel.sessionDeleteMessage('Draft'), /Draft/u);
    assert.match(chinese.agentPanel.sessionDeleteMessage('草稿'), /草稿/u);
  });

  it('uses the Cubby product name consistently across both product locales', () => {
    const english = getMessages('en');
    const chinese = getMessages('zh-CN');

    assert.equal(english.toolbar.agentButton, 'Cubby');
    assert.equal(chinese.toolbar.agentButton, 'Cubby');
    assert.equal(english.agentPanel.title, 'Cubby');
    assert.equal(chinese.agentPanel.title, 'Cubby');
    assert.match(english.agentPanel.agentSettings, /Cubby/u);
    assert.match(chinese.agentPanel.agentSettings, /Cubby/u);
    assert.match(english.options.agentHeading, /Cubby/u);
    assert.match(chinese.options.agentHeading, /Cubby/u);
  });

  it('keeps Options section numbering continuous in both product locales', () => {
    const english = getMessages('en').options;
    const chinese = getMessages('zh-CN').options;

    const headings: Array<[string, string]> = [
      [english.tokenHeading, chinese.tokenHeading],
      [english.agentHeading, chinese.agentHeading],
      [english.gistHeading, chinese.gistHeading],
      [english.behaviorHeading, chinese.behaviorHeading],
    ];
    headings.forEach(([en, zh], index) => {
      assert.match(en, new RegExp(`^${index + 1}\\.`, 'u'));
      assert.match(zh, new RegExp(`^${index + 1}\\.`, 'u'));
    });
    assert.match(english.tokenHeading, /GitHub Classic PAT/u);
    assert.match(chinese.tokenHeading, /GitHub Classic PAT/u);
  });

  it('names provider-required authentication without weakening credential exclusion', () => {
    const english = getMessages('en').options;
    const chinese = getMessages('zh-CN').options;

    assert.match(english.agentDisclosureNotSentSecrets, /API keys, other credentials/u);
    assert.match(english.agentDisclosureKeyException, /provider-required authentication header/u);
    assert.match(english.agentDisclosureKeyException, /Anthropic's x-api-key/u);
    assert.doesNotMatch(english.agentDisclosureKeyException, /as an Authorization header/u);
    assert.match(chinese.agentDisclosureNotSentSecrets, /API 密钥、其他凭据/u);
    assert.match(chinese.agentDisclosureKeyException, /服务商要求的认证请求头/u);
    assert.match(chinese.agentDisclosureKeyException, /Anthropic 使用 x-api-key/u);
    assert.doesNotMatch(chinese.agentDisclosureLocalHistory, /最多\s*128/u);
    assert.doesNotMatch(english.agentDisclosureLocalHistory, /at most\s*128/u);
  });

  it('localizes Watch background failures in both product locales', () => {
    const english = getMessages('en').background;
    const chinese = getMessages('zh-CN').background;

    for (const key of ['watchDisconnectFailed', 'watchInboxQueryInvalid'] as const) {
      assert.equal(typeof english[key], 'string');
      assert.ok(english[key].length > 0);
      assert.equal(typeof chinese[key], 'string');
      assert.ok(chinese[key].length > 0);
      assert.notEqual(english[key], chinese[key]);
    }
  });

  it('keeps Classic PAT authorization explicit across recovery surfaces', () => {
    const english = getMessages('en');
    const chinese = getMessages('zh-CN');

    assert.match(english.manager.noTokenBanner, /GitHub Classic PAT/u);
    assert.match(chinese.manager.noTokenBanner, /GitHub Classic PAT/u);
    assert.match(english.watch.inboxPermissionDenied, /GitHub Classic PAT/u);
    assert.match(chinese.watch.inboxPermissionDenied, /GitHub Classic PAT/u);
    assert.match(english.radar.permissionBody, /GitHub Classic PAT/u);
    assert.match(chinese.radar.permissionBody, /GitHub Classic PAT/u);
    assert.equal(english.popup.connectionRejected, '401 — Classic PAT rejected or expired');
    assert.equal(chinese.popup.connectionRejected, '401 — Classic PAT 被拒绝或已过期');
    assert.match(english.onboarding.noTokenBody, /GitHub Classic PAT/u);
    assert.match(chinese.onboarding.noTokenBody, /GitHub Classic PAT/u);
  });

  it('localizes the development Cubby diagnostics surface while preserving raw evidence identifiers', () => {
    const english = getAgentDiagnosticsMessages('en');
    const chinese = getAgentDiagnosticsMessages('zh-CN');

    assert.match(english.title, /Cubby/u);
    assert.match(chinese.title, /Cubby/u);
    assert.notEqual(english.title, chinese.title);
    assert.match(chinese.openAgentDiagnostics, /Cubby/u);
    assert.equal(typeof chinese.rawCapture, 'string');
    assert.ok(chinese.rawCapture.length > 0);
    assert.equal(typeof chinese.providerDebug, 'string');
    assert.ok(chinese.providerDebug.length > 0);
    assert.equal(typeof chinese.testSavedProvider, 'string');
    assert.ok(chinese.testSavedProvider.length > 0);
    assert.match(chinese.retainedOperations(2), /2/u);
    assert.match(chinese.evidenceRequestFailed('internal_error'), /internal_error/u);
  });

  it('starts with Chinese, then honors a stored English locale on mount', async () => {
    authMock.getLocale.mockResolvedValue('en');
    const host = mountProvider();

    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'zh-CN');
    await flush();
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'en');
    assert.equal(host.querySelector('[data-testid="title"]')?.textContent, getMessages('en').popup.title);
  });

  it('updates context from local config locale changes and ignores unrelated storage changes', async () => {
    const host = mountProvider();
    await flush();
    assert.equal(storageListeners.length, 1);
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'en');

    authMock.getLocale.mockResolvedValue('zh-CN');
    await act(async () => {
      storageListeners[0]?.({ other: { oldValue: 1, newValue: 2 } }, 'local');
      storageListeners[0]?.({ gsm_config: { oldValue: { locale: 'en' }, newValue: { locale: 'zh-CN' } } }, 'sync');
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'en');

    await act(async () => {
      storageListeners[0]?.({ gsm_config: { oldValue: { locale: 'en' }, newValue: { locale: 'zh-CN' } } }, 'local');
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'zh-CN');
  });

  it('optimistically switches locale before persistence resolves', async () => {
    let resolveWrite: (() => void) | null = null;
    authMock.setLocale.mockImplementation(() => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));
    const host = mountProvider();
    await flush();

    await act(async () => {
      (host.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'zh-CN');
    assert.deepEqual(authMock.setLocale.mock.calls.at(-1), ['zh-CN']);

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });
  });

  it('applies the content-script FAB label through the shared non-React message lookup', () => {
    const host = document.createElement('div');
    host.id = 'gsm-fab';
    const button = document.createElement('button');
    host.appendChild(button);
    document.body.appendChild(host);

    assert.equal(applyFabLabel(button, 'zh-CN'), true);
    assert.equal(button.getAttribute('data-tip'), getMessages('zh-CN').popup.title);
    assert.equal(button.getAttribute('aria-label'), getMessages('zh-CN').popup.title);

    host.remove();
    assert.equal(applyFabLabel(button, 'en'), false);
    assert.equal(button.getAttribute('data-tip'), getMessages('zh-CN').popup.title);
  });
});
