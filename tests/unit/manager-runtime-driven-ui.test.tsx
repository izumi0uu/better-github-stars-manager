/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { DEFAULT_LIBRARY_VIEW_PREFS } from '@/preferences';
import type { ManagerPreferences, ManagerRuntime, ManagerRuntimeListener } from '@/runtime/manager-runtime';
import type { Star } from '@/types';
import { RepositoryNotesEditorSection } from '@/ui/components/RepositoryNotesEditorSection';
import { ManagerResourceLink, useManagerImage } from '@/ui/components/ManagerResource';
import { useTheme } from '@/ui/hooks/use-theme';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const roots: MountedRoot[] = [];
const unused = async (): Promise<never> => {
  throw new Error('Unused runtime operation');
};

const defaultPreferences: ManagerPreferences = {
  theme: 'dark',
  locale: 'en',
  libraryView: DEFAULT_LIBRARY_VIEW_PREFS,
  watchCollapsedRepositories: {},
  columnLayoutMode: 'default',
  customColumnLayout: null,
};

function createRuntime(resources: ManagerRuntime['resources'] = {
  resolveImage: ({ remoteUrl }) => remoteUrl,
  resolveLink: ({ remoteUrl }) => remoteUrl,
  onBlockedLink: vi.fn(),
}) {
  let preferences = defaultPreferences;
  const listeners = new Set<ManagerRuntimeListener>();
  const setNotes = vi.fn(async () => {});
  const updatePreferences = vi.fn(async (patch: Partial<ManagerPreferences>) => {
    preferences = { ...preferences, ...patch };
    return preferences;
  });
  const runtime: ManagerRuntime = {
    resources,
    now: () => Date.parse('2026-08-16T12:00:00Z'),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAccount: async () => ({ username: 'demo', avatarUrl: null, displayName: 'Demo' }),
    readPreferences: async () => preferences,
    updatePreferences,
    queryStars: unused,
    querySurfaceBadges: unused,
    listExcludedTags: async () => [],
    setTags: async () => {},
    setNotes,
    setFavorite: async () => {},
    markUnstarred: async () => {},
    removeVisibleTag: unused,
    deleteTag: unused,
    deleteAllTags: unused,
    queryWatchInbox: unused,
    getWatchRepositoryDetail: unused,
    getWatchSubjectDetail: unused,
    refreshWatch: unused,
    markWatchThreadsRead: unused,
    markWatchThreadsDone: unused,
    updateWatchCollapse: async () => {},
    queryRadar: unused,
    refreshRadar: unused,
    markRadarActivitiesSeen: unused,
    dismissRadarActivities: unused,
    queryRecommendations: unused,
    refreshRecommendations: unused,
    ignoreRecommendation: async () => {},
    restoreIgnoredRecommendation: async () => {},
    starRepository: unused,
    addRepositoryTag: async () => {},
    reset: async () => 0,
  };
  return {
    runtime,
    setNotes,
    updatePreferences,
    emit(kind: Parameters<ManagerRuntimeListener>[0]['kind']) {
      for (const listener of [...listeners]) listener({ kind, epoch: 1 });
    },
    listenerCount: () => listeners.size,
  };
}

function ThemeHarness() {
  const { theme, toggle } = useTheme();
  return <button type="button" data-testid="theme" data-theme={theme} onClick={toggle}>theme</button>;
}

function ResourceHarness() {
  const avatarUrl = useManagerImage({
    kind: 'actor-avatar',
    identity: 'synthetic-user',
    remoteUrl: 'https://remote.invalid/avatar.png',
  });
  return (
    <div data-testid="resolved-avatar" data-url={avatarUrl ?? 'blocked'}>
      <ManagerResourceLink
        resource={{
          kind: 'repository',
          fullName: 'synthetic/repository',
          remoteUrl: 'https://remote.invalid/synthetic/repository',
        }}
      >
        Open repository
      </ManagerResourceLink>
    </div>
  );
}

const star = {
  full_name: 'synthetic/repository',
  html_url: 'https://example.invalid/synthetic/repository',
  description: 'Synthetic repository',
  language: 'TypeScript',
  stargazers_count: 42,
  topics: [],
  archived: false,
  fork: false,
  created_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-08-01T00:00:00Z',
  starred_at: '2026-08-02T00:00:00Z',
  tombstone: false,
  synced_at: '2026-08-02T00:00:00Z',
} satisfies Star;

afterEach(() => {
  cleanupMountedRootsAndBody(roots);
});

describe('runtime-driven manager UI', () => {
  it('hydrates, updates, and unsubscribes theme through the runtime preference port', async () => {
    const manager = createRuntime();
    const container = mountReact(
      <ManagerRuntimeProvider runtime={manager.runtime}>
        <ThemeHarness />
      </ManagerRuntimeProvider>,
      roots,
    );
    await act(async () => Promise.resolve());
    const button = container.querySelector<HTMLButtonElement>('[data-testid="theme"]');
    if (!button) throw new Error('Expected theme toggle');
    expect(button?.dataset.theme).toBe('dark');

    await click(button);
    expect(manager.updatePreferences).toHaveBeenCalledWith({ theme: 'light' });
    expect(button?.dataset.theme).toBe('light');
    expect(manager.listenerCount()).toBe(1);

    cleanupMountedRootsAndBody(roots);
    expect(manager.listenerCount()).toBe(0);
  });

  it('saves repository notes through the named runtime method and preserves editor callbacks', async () => {
    const manager = createRuntime();
    const onDataChanged = vi.fn();
    const onMeaningfulAction = vi.fn();
    const container = mountReact(
      <ManagerRuntimeProvider runtime={manager.runtime}>
        <I18nProvider>
          <RepositoryNotesEditorSection
            star={star}
            tag={undefined}
            onDataChanged={onDataChanged}
            onMeaningfulAction={onMeaningfulAction}
          />
        </I18nProvider>
      </ManagerRuntimeProvider>,
      roots,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Expected notes editor');
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, 'Runtime-owned note');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Save');
    if (!save) throw new Error('Expected notes save action');
    await click(save);

    expect(manager.setNotes).toHaveBeenCalledWith('synthetic/repository', 'Runtime-owned note');
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(onMeaningfulAction).toHaveBeenCalledTimes(1);
  });

  it('resolves images and blocks navigation through the runtime resource policy', async () => {
    const onBlockedLink = vi.fn();
    const manager = createRuntime({
      resolveImage: () => '/demo/avatar.svg',
      resolveLink: () => null,
      onBlockedLink,
    });
    const container = mountReact(
      <ManagerRuntimeProvider runtime={manager.runtime}>
        <ResourceHarness />
      </ManagerRuntimeProvider>,
      roots,
    );

    expect(container.querySelector('[data-testid="resolved-avatar"]')?.getAttribute('data-url'))
      .toBe('/demo/avatar.svg');
    const link = container.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe('#');
    expect(link?.hasAttribute('target')).toBe(false);
    act(() => link?.click());
    expect(onBlockedLink).toHaveBeenCalledWith({
      kind: 'repository',
      fullName: 'synthetic/repository',
      remoteUrl: 'https://remote.invalid/synthetic/repository',
    });
  });
});
