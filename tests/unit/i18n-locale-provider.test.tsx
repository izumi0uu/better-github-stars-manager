/**
 * @vitest-environment jsdom
 */
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { getMessages, I18nProvider, messageFor, useI18n } from '@/i18n';
import { applyFabLabel } from '@/content/stars-page/fab-label';
import type { Locale } from '@/types';

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

function mountProvider() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider>
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

  it('starts with English, then updates from stored locale on mount', async () => {
    authMock.getLocale.mockResolvedValue('zh-CN');
    const host = mountProvider();

    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'en');
    await flush();
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'zh-CN');
    assert.equal(host.querySelector('[data-testid="title"]')?.textContent, getMessages('zh-CN').popup.title);
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
