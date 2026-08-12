import { create } from 'zustand';
import {
  DEFAULT_LIBRARY_VIEW_PREFS,
  normalizeLibraryViewPrefs,
} from '@/preferences';
import type { LibraryViewPrefs } from '@/types';

export type SortKey = 'starred_at' | 'pushed_at' | 'created_at' | 'stargazers_count' | 'name';
export type SortDir = 'asc' | 'desc';

export interface FilterState {
  query: string; // full-text over name/description/topics/notes
  languages: string[]; // empty = all
  tags: string[]; // empty = all
  tagMode: 'any' | 'all'; // any = OR, all = AND
  showTombstone: boolean;
  onlyFavorite: boolean;
  onlyUntagged: boolean;
  onlyArchived: boolean;
  onlyOwned: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  libraryViewHydrated: boolean;
  setQuery: (q: string) => void;
  toggleLanguage: (lang: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setTagMode: (m: 'any' | 'all') => void;
  setShowTombstone: (v: boolean) => void;
  setOnlyFavorite: (v: boolean) => void;
  setOnlyUntagged: (v: boolean) => void;
  setOnlyArchived: (v: boolean) => void;
  setOnlyOwned: (v: boolean) => void;
  setSort: (k: SortKey, d?: SortDir) => void;
  applyLibraryViewPrefs: (prefs: LibraryViewPrefs, tagOverride?: string | null) => void;
  resetFilters: () => void;
}

export function libraryViewPrefsFromFilterState(state: Pick<
  FilterState,
  | 'languages'
  | 'tags'
  | 'tagMode'
  | 'showTombstone'
  | 'onlyFavorite'
  | 'onlyUntagged'
  | 'onlyArchived'
  | 'onlyOwned'
  | 'sortKey'
  | 'sortDir'
>): LibraryViewPrefs {
  return normalizeLibraryViewPrefs({
    version: 1,
    filters: {
      languages: state.languages,
      tags: state.tags,
      tagMode: state.tagMode,
      showTombstone: state.showTombstone,
      onlyFavorite: state.onlyFavorite,
      onlyUntagged: state.onlyUntagged,
      onlyArchived: state.onlyArchived,
      onlyOwned: state.onlyOwned,
    },
    sort: {
      sortKey: state.sortKey,
      sortDir: state.sortDir,
    },
  });
}

export function libraryViewPrefsKey(prefs: LibraryViewPrefs): string {
  return JSON.stringify(normalizeLibraryViewPrefs(prefs));
}

export const useFilterStore = create<FilterState>((set) => ({
  query: '',
  languages: [],
  tags: [],
  tagMode: 'any',
  showTombstone: false,
  onlyFavorite: false,
  onlyUntagged: false,
  onlyArchived: false,
  onlyOwned: false,
  sortKey: 'starred_at',
  sortDir: 'desc',
  libraryViewHydrated: false,
  setQuery: (query) => set({ query }),
  toggleLanguage: (lang) =>
    set((s) => ({
      languages: s.languages.includes(lang)
        ? s.languages.filter((l) => l !== lang)
        : [...s.languages, lang],
    })),
  toggleTag: (tag) =>
    set((s) => ({
      tags: s.tags.includes(tag) ? s.tags.filter((t) => t !== tag) : [...s.tags, tag],
    })),
  clearTags: () => set((s) => (s.tags.length === 0 ? s : { tags: [] })),
  setTagMode: (tagMode) => set({ tagMode }),
  setShowTombstone: (showTombstone) => set({ showTombstone }),
  setOnlyFavorite: (onlyFavorite) => set({ onlyFavorite }),
  setOnlyUntagged: (onlyUntagged) => set({ onlyUntagged }),
  setOnlyArchived: (onlyArchived) => set({ onlyArchived }),
  setOnlyOwned: (onlyOwned) => set({ onlyOwned }),
  setSort: (sortKey, sortDir) => set((s) => ({ sortKey, sortDir: sortDir ?? s.sortDir })),
  applyLibraryViewPrefs: (prefs, tagOverride) => {
    const normalized = normalizeLibraryViewPrefs(prefs ?? DEFAULT_LIBRARY_VIEW_PREFS);
    set({
      languages: normalized.filters.languages,
      tags: tagOverride ? [tagOverride] : normalized.filters.tags,
      tagMode: normalized.filters.tagMode,
      showTombstone: normalized.filters.showTombstone,
      onlyFavorite: normalized.filters.onlyFavorite,
      onlyUntagged: normalized.filters.onlyUntagged,
      onlyArchived: normalized.filters.onlyArchived,
      onlyOwned: normalized.filters.onlyOwned,
      sortKey: normalized.sort.sortKey,
      sortDir: normalized.sort.sortDir,
      libraryViewHydrated: true,
    });
  },
  resetFilters: () =>
    set({
      query: '',
      languages: [],
      tags: [],
      showTombstone: false,
      onlyFavorite: false,
      onlyUntagged: false,
      onlyArchived: false,
      onlyOwned: false,
    }),
}));
