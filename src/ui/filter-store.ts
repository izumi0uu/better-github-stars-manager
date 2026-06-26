import { create } from 'zustand';

export type SortKey = 'starred_at' | 'pushed_at' | 'stargazers_count' | 'name';
export type SortDir = 'asc' | 'desc';

export interface FilterState {
  query: string; // full-text over name/description/topics/notes
  languages: string[]; // empty = all
  tags: string[]; // empty = all
  tagMode: 'any' | 'all'; // any = OR, all = AND
  showTombstone: boolean;
  onlyFavorite: boolean;
  onlyUntagged: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  setQuery: (q: string) => void;
  toggleLanguage: (lang: string) => void;
  toggleTag: (tag: string) => void;
  setTagMode: (m: 'any' | 'all') => void;
  setShowTombstone: (v: boolean) => void;
  setOnlyFavorite: (v: boolean) => void;
  setOnlyUntagged: (v: boolean) => void;
  setSort: (k: SortKey, d?: SortDir) => void;
  resetFilters: () => void;
}

export const useFilterStore = create<FilterState>((set) => ({
  query: '',
  languages: [],
  tags: [],
  tagMode: 'any',
  showTombstone: false,
  onlyFavorite: false,
  onlyUntagged: false,
  sortKey: 'starred_at',
  sortDir: 'desc',
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
  setTagMode: (tagMode) => set({ tagMode }),
  setShowTombstone: (showTombstone) => set({ showTombstone }),
  setOnlyFavorite: (onlyFavorite) => set({ onlyFavorite }),
  setOnlyUntagged: (onlyUntagged) => set({ onlyUntagged }),
  setSort: (sortKey, sortDir) => set((s) => ({ sortKey, sortDir: sortDir ?? s.sortDir })),
  resetFilters: () =>
    set({ query: '', languages: [], tags: [], showTombstone: false, onlyFavorite: false, onlyUntagged: false }),
}));
