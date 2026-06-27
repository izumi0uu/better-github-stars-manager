import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueryMetaResult, QueryPageResult, StarFilter } from '@/background/query';
import type { Star, Tag } from '@/types';
import { useFilterStore } from './filter-store';
import { classifyStarsQueryTrigger } from './stars-refresh';

const FADE_OUT_MS = 120;
const FADE_IN_MS = 160;
const PAGE_SIZE = 120;
const PREFETCH_PADDING = 30;

type FadePhase = 'idle' | 'fading-out' | 'fading-in';

interface PageCache {
  rowsByIndex: Map<number, Star>;
  tagsByFullName: Map<string, Tag>;
  loadedPages: Set<number>;
}

function createEmptyPageCache(): PageCache {
  return {
    rowsByIndex: new Map<number, Star>(),
    tagsByFullName: new Map<string, Tag>(),
    loadedPages: new Set<number>(),
  };
}

function buildFilter(f: ReturnType<typeof useFilterStore.getState>): StarFilter {
  return {
    query: f.query,
    languages: f.languages,
    tags: f.tags,
    tagMode: f.tagMode,
    showTombstone: f.showTombstone,
    onlyFavorite: f.onlyFavorite,
    onlyUntagged: f.onlyUntagged,
    onlyArchived: f.onlyArchived,
    sortKey: f.sortKey,
    sortDir: f.sortDir,
  };
}

function nextCacheWithPage(current: PageCache, page: QueryPageResult): PageCache {
  const nextRowsByIndex = new Map(current.rowsByIndex);
  const nextTagsByFullName = new Map(current.tagsByFullName);
  const nextLoadedPages = new Set(current.loadedPages);

  for (let index = page.offset; index < page.offset + page.limit; index++) {
    const stale = nextRowsByIndex.get(index);
    if (stale) nextTagsByFullName.delete(stale.full_name);
    nextRowsByIndex.delete(index);
  }

  page.rows.forEach((row, index) => {
    nextRowsByIndex.set(page.offset + index, row);
    const tag = page.tagsForRows[row.full_name];
    if (tag) nextTagsByFullName.set(row.full_name, tag);
    else nextTagsByFullName.delete(row.full_name);
  });
  nextLoadedPages.add(Math.floor(page.offset / Math.max(1, page.limit || PAGE_SIZE)));

  return {
    rowsByIndex: nextRowsByIndex,
    tagsByFullName: nextTagsByFullName,
    loadedPages: nextLoadedPages,
  };
}

export function useStars() {
  const f = useFilterStore();
  const filter = buildFilter(f);
  const filterKey = JSON.stringify(filter);

  const [meta, setMeta] = useState<QueryMetaResult | null>(null);
  const [pageCache, setPageCache] = useState<PageCache>(() => createEmptyPageCache());
  const [phase, setPhase] = useState<FadePhase>('idle');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastQueriedFilterKey, setLastQueriedFilterKey] = useState<string | null>(null);

  const inFlightPagesRef = useRef(new Set<number>());
  const activeFilterKeyRef = useRef(filterKey);
  const pageCacheRef = useRef(pageCache);

  useEffect(() => {
    pageCacheRef.current = pageCache;
  }, [pageCache]);

  const refresh = () => {
    setRefreshKey((key) => key + 1);
  };

  const fetchPage = useCallback(async (
    targetFilter: StarFilter,
    targetFilterKey: string,
    pageIndex: number,
    options?: { force?: boolean },
  ) => {
    if (pageIndex < 0) return;
    if (inFlightPagesRef.current.has(pageIndex)) return;
    if (!options?.force && pageCacheRef.current.loadedPages.has(pageIndex)) return;
    inFlightPagesRef.current.add(pageIndex);
    if (pageIndex > 0) setLoadingMore(true);
    try {
      const page = await chrome.runtime.sendMessage({
        type: 'queryPage',
        params: { filter: targetFilter, offset: pageIndex * PAGE_SIZE, limit: PAGE_SIZE },
      }) as { ok: boolean; data?: QueryPageResult };
      if (!page?.ok || !page.data) return;
      if (activeFilterKeyRef.current !== targetFilterKey) return;
      setPageCache((current) => nextCacheWithPage(current, page.data!));
    } finally {
      inFlightPagesRef.current.delete(pageIndex);
      setLoadingMore(inFlightPagesRef.current.size > 0);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let fadeOut: ReturnType<typeof setTimeout> | null = null;
    let fadeIn: ReturnType<typeof setTimeout> | null = null;
    const trigger = classifyStarsQueryTrigger(lastQueriedFilterKey, filterKey);
    const shouldFade = trigger === 'filter-change';
    setLastQueriedFilterKey(filterKey);
    activeFilterKeyRef.current = filterKey;
    inFlightPagesRef.current.clear();
    setLoading(true);
    setLoadingMore(false);
    if (shouldFade) setPhase('fading-out');

    const runQuery = async () => {
      if (cancelled) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'queryMeta', filter }) as {
          ok: boolean;
          data?: QueryMetaResult;
          error?: string;
        };
        if (cancelled || !res?.ok || !res.data) {
          if (!cancelled) {
            setLoading(false);
            if (!shouldFade) setPhase('idle');
          }
          return;
        }
        if (cancelled || activeFilterKeyRef.current !== filterKey) return;

        setMeta(res.data);
        const reuseLoadedPages = !shouldFade && trigger === 'data-change' && pageCacheRef.current.loadedPages.size > 0;

        if (res.data.total === 0) {
          setPageCache(createEmptyPageCache());
        } else if (reuseLoadedPages) {
          const pages = [...pageCacheRef.current.loadedPages].sort((a, b) => a - b);
          await Promise.all(pages.map((pageIndex) => fetchPage(filter, filterKey, pageIndex, { force: true })));
        } else {
          setPageCache(createEmptyPageCache());
          await fetchPage(filter, filterKey, 0, { force: true });
        }

        if (cancelled || activeFilterKeyRef.current !== filterKey) return;
        if (shouldFade) {
          setPhase('fading-in');
          fadeIn = setTimeout(() => {
            if (!cancelled) setPhase('idle');
          }, FADE_IN_MS);
        } else {
          setPhase('idle');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (shouldFade) {
      fadeOut = setTimeout(() => {
        void runQuery();
      }, FADE_OUT_MS);
    } else {
      void runQuery();
    }

    return () => {
      cancelled = true;
      if (fadeOut) clearTimeout(fadeOut);
      if (fadeIn) clearTimeout(fadeIn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refreshKey]);

  useEffect(() => {
    const listener = (msg: { type?: string }) => {
      if (msg.type === 'dataChanged') {
        setRefreshKey((key) => key + 1);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const rows = useMemo(() => {
    const loaded = [...pageCache.rowsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
    return loaded;
  }, [pageCache]);

  const loadedIndexByFullName = useMemo(() => {
    const map = new Map<string, number>();
    for (const [index, row] of pageCache.rowsByIndex.entries()) {
      map.set(row.full_name, index);
    }
    return map;
  }, [pageCache.rowsByIndex]);

  const ensureRange = useCallback((start: number, end: number) => {
    const totalCount = meta?.total ?? 0;
    if (totalCount === 0) return;
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(totalCount - 1, Math.max(safeStart, end));
    const startPage = Math.floor(safeStart / PAGE_SIZE);
    const endPage = Math.floor(safeEnd / PAGE_SIZE);
    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
      if (pageCache.loadedPages.has(pageIndex) || inFlightPagesRef.current.has(pageIndex)) continue;
      void fetchPage(filter, filterKey, pageIndex);
    }
  }, [fetchPage, filter, filterKey, meta?.total, pageCache.loadedPages]);

  const ensureIndex = useCallback((index: number) => {
    if (index < 0 || index >= (meta?.total ?? 0)) return;
    ensureRange(index, index);
  }, [ensureRange, meta?.total]);

  const getRow = useCallback((index: number): Star | null => pageCache.rowsByIndex.get(index) ?? null, [pageCache.rowsByIndex]);

  const getTagForRow = useCallback((fullName: string): Tag | undefined => pageCache.tagsByFullName.get(fullName), [pageCache.tagsByFullName]);

  const updateCachedRowTag = useCallback((fullName: string, patch: Partial<Tag> | null) => {
    setPageCache((current) => {
      const nextTagsByFullName = new Map(current.tagsByFullName);
      const existing = nextTagsByFullName.get(fullName);
      if (patch === null) {
        nextTagsByFullName.delete(fullName);
      } else if (existing) {
        nextTagsByFullName.set(fullName, { ...existing, ...patch });
      } else {
        nextTagsByFullName.set(fullName, {
          full_name: fullName,
          tags: patch.tags ?? [],
          notes: patch.notes ?? '',
          favorite: patch.favorite,
          mtime: patch.mtime ?? new Date().toISOString(),
        });
      }
      return { ...current, tagsByFullName: nextTagsByFullName };
    });
  }, []);

  useEffect(() => {
    const total = meta?.total ?? 0;
    if (total === 0) return;
    const maxLoadedIndex = Math.max(-1, ...pageCache.rowsByIndex.keys());
    if (maxLoadedIndex < 0) {
      ensureRange(0, Math.min(PAGE_SIZE - 1, total - 1));
      return;
    }
    if (total - 1 - maxLoadedIndex <= PREFETCH_PADDING) {
      ensureRange(maxLoadedIndex + 1, Math.min(maxLoadedIndex + PAGE_SIZE, total - 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.total, pageCache.loadedPages.size]);

  return {
    rows,
    total: meta?.total ?? 0,
    grandTotal: meta?.grandTotal ?? 0,
    loading,
    loadingMore,
    phase,
    languages: meta?.languages ?? [],
    tagTree: { tags: meta?.tagTree ?? [], total: meta?.tagTotal ?? 0 },
    tagsByFullName: pageCache.tagsByFullName,
    refresh,
    getRow,
    getTagForRow,
    ensureRange,
    ensureIndex,
    updateCachedRowTag,
    pageSize: PAGE_SIZE,
    loadedIndexByFullName,
  };
}
