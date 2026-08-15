import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import type { Config } from '../src/types';

const storageBacking: Record<string, unknown> = {};

function installChromeMock() {
  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = ({
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (keys === null) return { ...storageBacking };
          const selectedKeys = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            selectedKeys
              .filter((key) => Object.hasOwn(storageBacking, key))
              .map((key) => [key, storageBacking[key]]),
          );
        },
        async set(items: Record<string, unknown>) {
          Object.assign(storageBacking, items);
        },
      },
      onChanged: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
  } as unknown) as typeof chrome;
}

describe('preferences persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(storageBacking)) delete storageBacking[key];
    installChromeMock();
  });

  it('defaults fresh configuration to Chinese', async () => {
    const { authStore } = await import('../src/auth/auth-store');

    assert.equal(await authStore.getLocale(), 'zh-CN');
    assert.equal((await authStore.getConfig()).locale, 'zh-CN');
  });

  it('normalizes and persists legacy preference fields', async () => {
    const { authStore, CONFIG_STORAGE_KEY } = await import('../src/auth/auth-store');
    const { useFilterStore, libraryViewPrefsFromFilterState } = await import(
      '../src/ui/filter-store'
    );

    storageBacking[CONFIG_STORAGE_KEY] = {
      autoTagLimit: 7,
      libraryView: {
        version: 1,
        filters: {
          languages: ['TypeScript'],
          tags: ['react'],
          tagMode: 'all',
          showTombstone: true,
          onlyFavorite: true,
          onlyUntagged: false,
          onlyArchived: true,
          onlyOwned: false,
        },
        sort: {
          sortKey: 'created_at',
          sortDir: 'asc',
        },
      },
    };

    const legacyConfig = await authStore.getConfig();
    assert.equal(legacyConfig.maxTagsPerRepo, 7);
    assert.equal(legacyConfig.minTopicRepoCount, 3);
    assert.equal(legacyConfig.libraryView.filters.onlyArchived, true);

    useFilterStore.getState().applyLibraryViewPrefs(legacyConfig.libraryView, 'vue');
    const hydratedPrefs = libraryViewPrefsFromFilterState(useFilterStore.getState());
    assert.deepEqual(hydratedPrefs.filters.languages, ['TypeScript']);
    assert.deepEqual(hydratedPrefs.filters.tags, ['vue']);
    assert.equal(hydratedPrefs.filters.tagMode, 'all');
    assert.equal(hydratedPrefs.sort.sortKey, 'created_at');
    assert.equal(hydratedPrefs.sort.sortDir, 'asc');

    await authStore.updateAutoTagPolicy({ maxTagsPerRepo: 4, minTopicRepoCount: 3 });
    await authStore.updateLibraryViewPrefs(hydratedPrefs);

    const storedConfig = storageBacking[CONFIG_STORAGE_KEY] as Config;
    assert.equal(storedConfig.autoTagLimit, 4);
    assert.equal(storedConfig.maxTagsPerRepo, 4);
    assert.equal(storedConfig.minTopicRepoCount, 3);
    assert.deepEqual(storedConfig.libraryView, hydratedPrefs);
  });

  it('normalizes and updates bounded Watch collapse memory', async () => {
    const { authStore, CONFIG_STORAGE_KEY } = await import('../src/auth/auth-store');
    storageBacking[CONFIG_STORAGE_KEY] = {
      watchCollapsedRepositories: {
        ' Owner/Repo ': ' [["1","2026-08-05T00:00:00Z"]] ',
        '': 'ignored',
        'owner/invalid': 42,
      },
    };

    const config = await authStore.getConfig();
    assert.deepEqual(config.watchCollapsedRepositories, {
      'owner/repo': '[["1","2026-08-05T00:00:00Z"]]',
    });

    await authStore.updateWatchRepositoryCollapse(
      'OWNER/NEW',
      '[["2","2026-08-06T00:00:00Z"]]',
    );
    let storedConfig = storageBacking[CONFIG_STORAGE_KEY] as Config;
    assert.equal(
      storedConfig.watchCollapsedRepositories['owner/new'],
      '[["2","2026-08-06T00:00:00Z"]]',
    );

    await authStore.updateWatchRepositoryCollapse('owner/repo', null);
    storedConfig = storageBacking[CONFIG_STORAGE_KEY] as Config;
    assert.equal(storedConfig.watchCollapsedRepositories['owner/repo'], undefined);
  });

  it('merges library view updates with the latest stored config', async () => {
    const { authStore, CONFIG_STORAGE_KEY } = await import('../src/auth/auth-store');

    storageBacking[CONFIG_STORAGE_KEY] = {
      locale: 'en',
      libraryView: {
        version: 1,
        filters: {
          languages: ['TypeScript'],
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
    };

    await authStore.getConfig();
    storageBacking[CONFIG_STORAGE_KEY] = {
      ...(storageBacking[CONFIG_STORAGE_KEY] as Config),
      locale: 'zh-CN',
      theme: 'light',
    };

    await authStore.updateLibraryViewPrefs({
      version: 1,
      filters: {
        languages: ['Rust'],
        tags: ['systems'],
        tagMode: 'all',
        showTombstone: true,
        onlyFavorite: true,
        onlyUntagged: true,
        onlyArchived: true,
        onlyOwned: true,
      },
      sort: {
        sortKey: 'name',
        sortDir: 'asc',
      },
    });

    const storedConfig = storageBacking[CONFIG_STORAGE_KEY] as Config;
    assert.equal(storedConfig.locale, 'zh-CN');
    assert.equal(storedConfig.theme, 'light');
    assert.deepEqual(storedConfig.libraryView.filters.languages, ['Rust']);
    assert.deepEqual(storedConfig.libraryView.filters.tags, ['systems']);
  });

  it('merges auto-tag policy updates with the latest stored config', async () => {
    const { authStore, CONFIG_STORAGE_KEY } = await import('../src/auth/auth-store');

    storageBacking[CONFIG_STORAGE_KEY] = {
      locale: 'en',
      autoTagLimit: 3,
      maxTagsPerRepo: 3,
      minTopicRepoCount: 3,
    };

    await authStore.getConfig();
    storageBacking[CONFIG_STORAGE_KEY] = {
      ...(storageBacking[CONFIG_STORAGE_KEY] as Config),
      locale: 'zh-CN',
      theme: 'light',
    };

    await authStore.updateAutoTagPolicy({ maxTagsPerRepo: 8 });

    const storedConfig = storageBacking[CONFIG_STORAGE_KEY] as Config;
    assert.equal(storedConfig.locale, 'zh-CN');
    assert.equal(storedConfig.theme, 'light');
    assert.equal(storedConfig.autoTagLimit, 8);
    assert.equal(storedConfig.maxTagsPerRepo, 8);
    assert.equal(storedConfig.minTopicRepoCount, 3);
  });

  it('normalizes and serializes store-rating reminder mutations', async () => {
    const { authStore, CONFIG_STORAGE_KEY } = await import('../src/auth/auth-store');
    storageBacking[CONFIG_STORAGE_KEY] = {
      storeRatingPrompt: {
        version: 1,
        status: 'tracking',
        activeLocalDays: ['invalid'],
        meaningfulActionCount: -1,
        exposureCount: 99,
        snoozeUntil: 'invalid',
      },
    };

    assert.deepEqual((await authStore.getConfig()).storeRatingPrompt, {
      version: 1,
      status: 'exhausted',
      activeLocalDays: [],
      meaningfulActionCount: 0,
      exposureCount: 2,
      snoozeUntil: null,
    });

    await authStore.reenableStoreRatingPrompt();
    for (const now of [
      new Date(2026, 7, 13, 12).getTime(),
      new Date(2026, 7, 14, 12).getTime(),
      new Date(2026, 7, 15, 12).getTime(),
    ]) {
      await authStore.recordStoreRatingActiveDay(now);
    }
    await Promise.all([
      authStore.recordStoreRatingMeaningfulAction(),
      authStore.recordStoreRatingMeaningfulAction(),
      authStore.recordStoreRatingMeaningfulAction(),
      authStore.recordStoreRatingMeaningfulAction(),
    ]);

    const now = Date.parse('2026-08-15T12:00:00.000Z');
    const claims = await Promise.all([
      authStore.consumeStoreRatingPromptExposure(now),
      authStore.consumeStoreRatingPromptExposure(now),
    ]);
    assert.equal(claims.filter((claim) => claim.consumed).length, 1);

    const storedConfig = storageBacking[CONFIG_STORAGE_KEY] as Config;
    assert.deepEqual({
      status: storedConfig.storeRatingPrompt.status,
      activeLocalDays: storedConfig.storeRatingPrompt.activeLocalDays,
      meaningfulActionCount: storedConfig.storeRatingPrompt.meaningfulActionCount,
      exposureCount: storedConfig.storeRatingPrompt.exposureCount,
    }, {
      status: 'snoozed',
      activeLocalDays: ['2026-08-13', '2026-08-14', '2026-08-15'],
      meaningfulActionCount: 3,
      exposureCount: 1,
    });
  });
});
