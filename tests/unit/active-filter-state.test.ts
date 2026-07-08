import { describe, expect, it, vi } from 'vitest';
import { hasVisibleActiveFilters } from '@/ui/active-filter-state';
import type { FilterState } from '@/ui/filter-store';

function fakeFilterState(patch: Partial<FilterState> = {}): FilterState {
  return {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    onlyWatched: false,
    watchReasons: [],
    sortKey: 'starred_at',
    sortDir: 'desc',
    libraryViewHydrated: true,
    setQuery: vi.fn(),
    toggleLanguage: vi.fn(),
    toggleTag: vi.fn(),
    clearTags: vi.fn(),
    setTagMode: vi.fn(),
    setShowTombstone: vi.fn(),
    setOnlyFavorite: vi.fn(),
    setOnlyUntagged: vi.fn(),
    setOnlyArchived: vi.fn(),
    setOnlyWatched: vi.fn(),
    toggleWatchReason: vi.fn(),
    setSort: vi.fn(),
    applyLibraryViewPrefs: vi.fn(),
    resetFilters: vi.fn(),
    ...patch,
  };
}

describe('active filter state', () => {
  it('keeps the chip row expanded for watched-only filters', () => {
    expect(hasVisibleActiveFilters(fakeFilterState({ onlyWatched: true }))).toBe(true);
    expect(hasVisibleActiveFilters(fakeFilterState({ watchReasons: ['security'] }))).toBe(true);
  });

  it('stays collapsed when no visible filter is active', () => {
    expect(hasVisibleActiveFilters(fakeFilterState())).toBe(false);
  });
});
