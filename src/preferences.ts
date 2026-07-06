import type {
  LibraryViewPrefs,
  LibraryViewSortDir,
  LibraryViewSortKey,
} from '@/types';

export const DEFAULT_AUTO_TAG_LIMIT = 5;
export const MIN_AUTO_TAG_LIMIT = 1;
export const MAX_AUTO_TAG_LIMIT = 50;
export const DEFAULT_MIN_TOPIC_REPO_COUNT = 3;

const SORT_KEYS: readonly LibraryViewSortKey[] = [
  'starred_at',
  'pushed_at',
  'created_at',
  'stargazers_count',
  'name',
];
const SORT_DIRS: readonly LibraryViewSortDir[] = ['asc', 'desc'];

export const DEFAULT_LIBRARY_VIEW_PREFS: LibraryViewPrefs = {
  version: 1,
  filters: {
    languages: [],
    tags: [],
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
  },
  sort: {
    sortKey: 'starred_at',
    sortDir: 'desc',
  },
};

export function normalizeAutoTagLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_TAG_LIMIT;
  return Math.min(
    MAX_AUTO_TAG_LIMIT,
    Math.max(MIN_AUTO_TAG_LIMIT, Math.trunc(parsed)),
  );
}

export function normalizeMaxTagsPerRepo(value: unknown, legacyValue?: unknown): number {
  if (value === undefined || value === null) {
    return normalizeAutoTagLimit(legacyValue);
  }
  return normalizeAutoTagLimit(value);
}

export function normalizeMinTopicRepoCount(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MIN_TOPIC_REPO_COUNT;
  }
  return normalizeAutoTagLimit(value);
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeSortKey(value: unknown): LibraryViewSortKey {
  return typeof value === 'string' && SORT_KEYS.includes(value as LibraryViewSortKey)
    ? value as LibraryViewSortKey
    : DEFAULT_LIBRARY_VIEW_PREFS.sort.sortKey;
}

function normalizeSortDir(value: unknown): LibraryViewSortDir {
  return typeof value === 'string' && SORT_DIRS.includes(value as LibraryViewSortDir)
    ? value as LibraryViewSortDir
    : DEFAULT_LIBRARY_VIEW_PREFS.sort.sortDir;
}

export function normalizeLibraryViewPrefs(value: unknown): LibraryViewPrefs {
  const prefs = value && typeof value === 'object'
    ? value as {
      version?: unknown;
      filters?: Record<string, unknown>;
      sort?: Record<string, unknown>;
    }
    : null;
  const filters = prefs?.filters ?? {};
  const sort = prefs?.sort ?? {};
  return {
    version: 1,
    filters: {
      languages: uniqueStrings(filters.languages),
      tags: uniqueStrings(filters.tags),
      tagMode: filters.tagMode === 'all' ? 'all' : 'any',
      showTombstone: filters.showTombstone === true,
      onlyFavorite: filters.onlyFavorite === true,
      onlyUntagged: filters.onlyUntagged === true,
      onlyArchived: filters.onlyArchived === true,
    },
    sort: {
      sortKey: normalizeSortKey(sort.sortKey),
      sortDir: normalizeSortDir(sort.sortDir),
    },
  };
}

export function normalizeStarsPanelDefaultEnabled(value: unknown): boolean {
  return value !== false;
}
