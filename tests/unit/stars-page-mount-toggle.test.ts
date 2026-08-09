/**
 * @vitest-environment jsdom
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { mountState, pageOwner } from '@/content/stars-page/mount-state';

const CONFIG_STORAGE_KEY = 'github-stars-manager-config';

type Config = { starsPanelDefaultEnabled: boolean };
type StorageListener = (changes: Record<string, { oldValue?: Config; newValue?: Config }>, areaName: string) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.equal(predicate(), true);
}

function setStarsUrl(): void {
  window.history.replaceState(null, '', '/idah?tab=stars');
}

function clearInjectedChrome(): void {
  document.querySelectorAll('#gsm-manager-host, #gsm-fab').forEach((el) => el.remove());
  document.body.replaceChildren();
}

function installChromeMock() {
  let listener: StorageListener | null = null;
  const addListener = vi.fn((fn: StorageListener) => {
    listener = fn;
  });
  vi.stubGlobal('chrome', {
    storage: {
      onChanged: { addListener },
    },
  });
  return {
    emitConfigChange(oldValue: Config, newValue: Config) {
      assert.ok(listener);
      listener({ [CONFIG_STORAGE_KEY]: { oldValue, newValue } }, 'local');
    },
  };
}

async function loadContentScript({
  config,
  getConfig,
  getLocale,
  initialBodyOverflow = '',
  initialHtmlOverflow = '',
}: {
  config?: Config;
  getConfig?: () => Promise<Config>;
  getLocale?: () => Promise<string>;
  initialBodyOverflow?: string;
  initialHtmlOverflow?: string;
} = {}) {
  vi.resetModules();
  clearInjectedChrome();
  document.documentElement.style.overflow = initialHtmlOverflow;
  document.body.style.overflow = initialBodyOverflow;
  setStarsUrl();

  const chromeMock = installChromeMock();
  const documentListeners = new Map<string, EventListener[]>();
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener) => {
    const listeners = documentListeners.get(type) ?? [];
    listeners.push(listener as EventListener);
    documentListeners.set(type, listeners);
  });
  let currentConfig = config ?? { starsPanelDefaultEnabled: true };
  const getConfigFn = vi.fn(getConfig ?? (() => Promise.resolve(currentConfig)));
  const getUsernameMock = vi.fn(() => Promise.resolve('idah'));
  const getLocaleMock = vi.fn(getLocale ?? (() => Promise.resolve('en')));

  vi.doMock('@/auth/auth-store', () => ({
    CONFIG_STORAGE_KEY,
    authStore: {
      getConfig: getConfigFn,
      getLocale: getLocaleMock,
      getUsername: getUsernameMock,
    },
  }));
  vi.doMock('react-dom/client', () => ({
    createRoot: vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() })),
  }));
  vi.doMock('@/ui/ManagerPanel', () => ({
    ManagerPanel: () => null,
  }));
  vi.doMock('@/i18n', () => ({
    I18nProvider: ({ children }: { children: unknown }) => children,
    messageFor: () => ({ popup: { title: 'GitHub Stars Manager' } }),
  }));
  vi.doMock('@/ui/styles/index.css?inline', () => ({
    default: ':host { all: initial; }',
  }));

  const contentScript = await import('@/content/stars-page/index');
  contentScript.onExecute();
  const panelToggle = await import('@/content/stars-page/panel-toggle');
  await flush();

  return {
    chromeMock,
    setConfig(next: Config) {
      currentConfig = next;
    },
    fireDocumentEvent(type: string) {
      for (const listener of documentListeners.get(type) ?? []) listener(new Event(type));
    },
    ...contentScript,
    ...panelToggle,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('@/auth/auth-store');
  vi.doUnmock('react-dom/client');
  vi.doUnmock('@/ui/ManagerPanel');
  vi.doUnmock('@/i18n');
  vi.doUnmock('@/ui/styles/index.css?inline');
  clearInjectedChrome();
  vi.restoreAllMocks();
});

describe('stars-page mount and toggle invariants', () => {
  beforeEach(() => {
    setStarsUrl();
  });

  it('derives owner only from supported stars profile paths', () => {
    assert.equal(pageOwner('/idah'), 'idah');
    assert.equal(pageOwner('/users/Idah'), 'idah');
    assert.equal(pageOwner('/stars'), null);
    assert.equal(pageOwner('/orgs/github'), null);
    assert.equal(pageOwner('/idah/repo'), null);
  });

  it('maps ownership and effective enabled state to panel, fab, or none', () => {
    assert.equal(mountState(false, true), 'none');
    assert.equal(mountState(false, false), 'none');
    assert.equal(mountState(true, true), 'panel');
    assert.equal(mountState(true, false), 'fab');
  });

  it('keeps hide/show session-local and resettable over persisted defaults', async () => {
    const { hidePanel, isPanelEnabled, onPanelToggle, resetPanelToggle, showPanel } = await import('@/content/stars-page/panel-toggle');
    resetPanelToggle();

    let dispatches = 0;
    onPanelToggle(() => {
      dispatches += 1;
    });

    assert.equal(isPanelEnabled(true), true);
    hidePanel();
    assert.equal(isPanelEnabled(true), false);
    assert.equal(isPanelEnabled(false), false);
    showPanel();
    assert.equal(isPanelEnabled(false), true);
    resetPanelToggle();
    assert.equal(isPanelEnabled(false), false);
    assert.equal(dispatches, 2);
  });

  it('mounts and toggles two independent page runtimes without sharing DOM state', async () => {
    const loaded = await loadContentScript();
    const firstFrame = document.createElement('iframe');
    const secondFrame = document.createElement('iframe');
    // jsdom gives unsourced iframes an about:blank URL that cannot be rewritten with history.replaceState.
    firstFrame.src = 'javascript:void 0';
    secondFrame.src = 'javascript:void 0';
    document.body.append(firstFrame, secondFrame);
    const firstWindow = firstFrame.contentWindow;
    const secondWindow = secondFrame.contentWindow;
    assert.ok(firstWindow);
    assert.ok(secondWindow);

    for (const target of [firstWindow, secondWindow]) {
      target.history.replaceState(null, '', '/idah?tab=stars');
      target.document.body.innerHTML = '<main data-pjax-container><h1>Stars</h1></main>';
      loaded.installStarsPageRuntime(target);
    }

    await waitFor(() => [firstWindow, secondWindow].every((target) => (
      target.document.getElementById('gsm-manager-host') !== null
    )));
    assert.equal(firstWindow.document.getElementById('gsm-fab'), null);
    assert.equal(secondWindow.document.getElementById('gsm-fab'), null);

    loaded.hidePanel(firstWindow);
    await waitFor(() => firstWindow.document.getElementById('gsm-fab') !== null);
    assert.equal(firstWindow.document.getElementById('gsm-manager-host'), null);
    assert.notEqual(secondWindow.document.getElementById('gsm-manager-host'), null);
    assert.equal(secondWindow.document.getElementById('gsm-fab'), null);

    loaded.showPanel(firstWindow);
    await waitFor(() => firstWindow.document.getElementById('gsm-manager-host') !== null);
    assert.equal(firstWindow.document.getElementById('gsm-fab'), null);
    assert.notEqual(secondWindow.document.getElementById('gsm-manager-host'), null);
  });

  it('ignores stale async sync results before they can mutate panel/fab DOM', async () => {
    const firstConfig = deferred<Config>();
    const secondConfig = deferred<Config>();
    const configs = [firstConfig.promise, secondConfig.promise];
    const loaded = await loadContentScript({
      getConfig: () => configs.shift() ?? Promise.resolve({ starsPanelDefaultEnabled: true }),
    });
    await waitFor(() => configs.length === 1);

    loaded.fireDocumentEvent('turbo:load');
    await waitFor(() => configs.length === 0);

    secondConfig.resolve({ starsPanelDefaultEnabled: true });
    await waitFor(() => document.getElementById('gsm-manager-host') !== null);

    firstConfig.resolve({ starsPanelDefaultEnabled: false });
    await flush();

    assert.equal(document.querySelectorAll('#gsm-manager-host').length, 1);
    assert.equal(document.getElementById('gsm-fab'), null);
  });

  it('resets the session override before syncing a changed persisted default', async () => {
    const loaded = await loadContentScript({ config: { starsPanelDefaultEnabled: false } });
    await waitFor(() => document.getElementById('gsm-fab') !== null);

    loaded.showPanel();
    await waitFor(() => document.getElementById('gsm-manager-host') !== null);

    loaded.hidePanel();
    await waitFor(() => document.getElementById('gsm-fab') !== null);

    loaded.setConfig({ starsPanelDefaultEnabled: true });
    loaded.chromeMock.emitConfigChange(
      { starsPanelDefaultEnabled: false },
      { starsPanelDefaultEnabled: true },
    );
    await waitFor(() => document.getElementById('gsm-manager-host') !== null);

    assert.equal(document.getElementById('gsm-fab'), null);
  });

  it('keeps panel and fab injection idempotent and restores captured scroll values', async () => {
    const loaded = await loadContentScript({
      config: { starsPanelDefaultEnabled: true },
      initialBodyOverflow: 'auto',
      initialHtmlOverflow: 'scroll',
    });
    await waitFor(() => document.getElementById('gsm-manager-host') !== null);

    loaded.fireDocumentEvent('turbo:render');
    await flush();

    assert.equal(document.querySelectorAll('#gsm-manager-host').length, 1);
    assert.equal(document.documentElement.style.overflow, 'hidden');
    assert.equal(document.body.style.overflow, 'hidden');

    loaded.hidePanel();
    await waitFor(() => document.getElementById('gsm-fab') !== null);

    assert.equal(document.getElementById('gsm-manager-host'), null);
    assert.equal(document.documentElement.style.overflow, 'scroll');
    assert.equal(document.body.style.overflow, 'auto');

    loaded.showPanel();
    await waitFor(() => document.getElementById('gsm-manager-host') !== null);
    loaded.hidePanel();
    await flush();

    assert.equal(document.querySelectorAll('#gsm-fab').length, 1);
    assert.equal(document.documentElement.style.overflow, 'scroll');
    assert.equal(document.body.style.overflow, 'auto');
  });

  it('keeps a fallback FAB label when locale loading fails', async () => {
    await loadContentScript({
      config: { starsPanelDefaultEnabled: false },
      getLocale: () => Promise.reject(new Error('storage down')),
    });
    await waitFor(() => document.getElementById('gsm-fab') !== null);

    const button = document.getElementById('gsm-fab')?.shadowRoot?.querySelector('button');
    assert.ok(button);
    assert.equal(button.getAttribute('aria-label'), 'Better GitHub Stars Manager');
    assert.equal(button.getAttribute('data-tip'), 'Better GitHub Stars Manager');
  });
});
