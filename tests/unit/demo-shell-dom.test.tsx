/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { act, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoShell } from '@/demo/DemoShell';
import { I18nProvider } from '@/i18n';
import type {
  ManagerPreferences,
  ManagerPreferencesPatch,
  ManagerRuntimeListener,
} from '@/runtime/manager-runtime';
import type { Locale } from '@/types';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];

function createLocaleSource(locale: Locale) {
  let preferences: ManagerPreferences = {
    theme: 'light',
    locale,
    radarWindowDays: 30,
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
        onlyOwned: false,
      },
      sort: { sortKey: 'starred_at', sortDir: 'desc' },
    },
    watchCollapsedRepositories: {},
    columnLayoutMode: 'default',
    customColumnLayout: null,
  };

  return {
    readPreferences: async () => preferences,
    updatePreferences: async (patch: ManagerPreferencesPatch) => {
      preferences = { ...preferences, ...patch };
      return preferences;
    },
    subscribe: (_listener: ManagerRuntimeListener) => () => {},
  };
}

async function mountLocalized(element: ReactElement, locale: Locale = 'en') {
  const container = mountReact(
    <I18nProvider source={createLocaleSource(locale)}>{element}</I18nProvider>,
    mountedRoots,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Expected ${selector} to render`);
  return element;
}

function ResetHarness({ onReset }: { onReset: () => void | Promise<void> }) {
  const [resetEpoch, setResetEpoch] = useState(0);

  return (
    <DemoShell
      interactiveDemo={<div data-testid="interactive-sentinel">Interactive workspace</div>}
      resetEpoch={resetEpoch}
      onReset={async () => {
        await onReset();
        setResetEpoch((current) => current + 1);
      }}
    />
  );
}

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('public Demo shell DOM behavior', () => {
  it('keeps the interactive workspace mounted and restores it after confirmed reset', async () => {
    const onReset = vi.fn();
    const container = await mountLocalized(<ResetHarness onReset={onReset} />);
    const interactivePanel = requiredElement<HTMLElement>(container, '#demo-interactive-panel');
    const sentinel = requiredElement<HTMLElement>(container, '[data-testid="interactive-sentinel"]');

    expect(interactivePanel.hidden).toBe(false);
    expect(container.querySelector('[data-demo-view="previews"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-preview-gallery"]')).toBeNull();

    await click(requiredElement<HTMLButtonElement>(container, '[data-testid="demo-reset"]'));
    expect(onReset).not.toHaveBeenCalled();
    expect(requiredElement(container, '[data-testid="demo-reset-confirmation"]')).toBeTruthy();

    await click(requiredElement<HTMLButtonElement>(container, '[data-testid="demo-reset-confirm"]'));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="interactive-sentinel"]')).toBe(sentinel);
    expect(container.querySelector('[data-testid="demo-reset-confirmation"]')).toBeNull();
  });

  it('exposes a real pending state and recovers from reset errors without losing the confirmation', async () => {
    let resolveReset: (() => void) | undefined;
    const pendingReset = new Promise<void>((resolve) => {
      resolveReset = resolve;
    });
    const container = await mountLocalized(
      <DemoShell
        interactiveDemo={<div>Workspace</div>}
        resetEpoch={0}
        onReset={() => pendingReset}
      />,
    );

    await click(requiredElement<HTMLButtonElement>(container, '[data-testid="demo-reset"]'));
    await click(requiredElement<HTMLButtonElement>(container, '[data-testid="demo-reset-confirm"]'));

    const confirmation = requiredElement<HTMLElement>(container, '[data-testid="demo-reset-confirmation"]');
    expect(confirmation.getAttribute('aria-busy')).toBe('true');
    expect(requiredElement<HTMLButtonElement>(container, '[data-testid="demo-reset-confirm"]').disabled).toBe(true);
    expect(requiredElement<HTMLButtonElement>(container, '[data-testid="demo-reset-cancel"]').disabled).toBe(true);

    await act(async () => {
      resolveReset?.();
      await pendingReset;
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="demo-reset-confirmation"]')).toBeNull();

    const rejectedContainer = await mountLocalized(
      <DemoShell
        interactiveDemo={<div>Workspace</div>}
        resetEpoch={0}
        onReset={async () => { throw new Error('fixture reset failed'); }}
      />,
    );
    await click(requiredElement<HTMLButtonElement>(rejectedContainer, '[data-testid="demo-reset"]'));
    await click(requiredElement<HTMLButtonElement>(rejectedContainer, '[data-testid="demo-reset-confirm"]'));

    const error = requiredElement<HTMLElement>(rejectedContainer, '[role="alert"]');
    expect(error.textContent).toContain('could not be reset');
    expect(requiredElement<HTMLButtonElement>(rejectedContainer, '[data-testid="demo-reset-confirm"]').disabled).toBe(false);
  });

  it('localizes the persistent safety notice and shell controls in Chinese', async () => {
    const container = await mountLocalized(
      <DemoShell interactiveDemo={<div>交互工作区</div>} resetEpoch={0} onReset={vi.fn()} />,
      'zh-CN',
    );
    const shell = requiredElement<HTMLElement>(container, '[data-testid="demo-shell"]');
    const notice = requiredElement<HTMLElement>(container, '[data-testid="demo-notice"]');

    expect(shell.lang).toBe('zh-CN');
    expect(shell.getAttribute('data-demo-locale')).toBe('zh-CN');
    expect(notice.getAttribute('role')).toBe('note');
    expect(notice.textContent).toContain('合成数据');
    expect(notice.textContent).toContain('未连接 GitHub');
    expect(requiredElement(container, '[data-testid="demo-reset"]').textContent).toContain('重置演示');
    expect(container.querySelector('[data-demo-view="previews"]')).toBeNull();
  });


  it('keeps a stable interactive host and exactly four separated allowlisted links', async () => {
    const container = await mountLocalized(
      <DemoShell interactiveDemo={<div>Workspace</div>} resetEpoch={0} onReset={vi.fn()} />,
    );
    const shell = requiredElement<HTMLElement>(container, '[data-testid="demo-shell"]');
    const host = requiredElement<HTMLElement>(container, '[data-testid="demo-interactive-host"]');
    const resourceLinks = [...container.querySelectorAll<HTMLAnchorElement>('[data-demo-external-link]')];

    expect(shell.classList.contains('demo-shell-root')).toBe(true);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-preview-gallery"]')).toBeNull();
    expect(host.classList.contains('demo-interactive-host')).toBe(true);
    expect(host.classList.contains('min-w-0')).toBe(true);
    expect(host.classList.contains('overflow-hidden')).toBe(true);

    expect(resourceLinks.map((link) => link.dataset.demoExternalLink)).toEqual([
      'install',
      'source',
      'privacy',
      'documentation',
    ]);
    expect(resourceLinks.map((link) => link.href)).toEqual([
      'https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa',
      'https://github.com/izumi0uu/better-github-stars-manager',
      'https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/en/privacy-policy.md',
      'https://github.com/izumi0uu/better-github-stars-manager/tree/master/docs/en',
    ]);
    for (const link of resourceLinks) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toContain('noreferrer');
    }
  });

  it('keeps the standalone HTML entry free of inline scripts and remote media', () => {
    const html = readFileSync('demo/index.html', 'utf8');

    expect(html).toContain('<script type="module" src="/src/demo/main.tsx"></script>');
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/u);
    expect(html).not.toContain('style=');
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//u);
    expect(html).toContain('href="/src/assets/bgsm-brand-mark.svg"');
  });
});
