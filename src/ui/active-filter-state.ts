import type { FilterState } from '@/ui/filter-store';

export function hasVisibleActiveFilters(f: FilterState): boolean {
  return (
    f.languages.length > 0 ||
    f.tags.length > 0 ||
    f.watchReasons.length > 0 ||
    f.onlyFavorite ||
    f.onlyUntagged ||
    f.onlyArchived ||
    f.onlyWatched
  );
}
