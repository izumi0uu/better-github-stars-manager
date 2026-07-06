import assert from 'node:assert/strict';

const storageBacking: Record<string, unknown> = {};

(globalThis as any).chrome = {
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
    },
  },
};

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

const storedConfig = storageBacking[CONFIG_STORAGE_KEY] as {
  autoTagLimit: number;
  maxTagsPerRepo: number;
  minTopicRepoCount: number;
  libraryView: unknown;
};
assert.equal(storedConfig.autoTagLimit, 4);
assert.equal(storedConfig.maxTagsPerRepo, 4);
assert.equal(storedConfig.minTopicRepoCount, 3);
assert.deepEqual(storedConfig.libraryView, hydratedPrefs);

console.log('preferences persistence smoke passed');
