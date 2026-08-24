import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFilterStore } from './filter-store';
import { useLibraryViewPrefs } from './hooks/use-library-view-prefs';
import type { Star, Tag } from '@/types';
import type { StarsQueryResult } from '@/stars/stars-query';
import { classifyStarsQueryTrigger } from './stars-refresh';
import { useManagerRuntime } from '@/ui/manager-runtime-context';

// Transition timings for the list fade-out → swap → fade-in (see FADE_PHASE).
const FADE_OUT_MS = 120;
const FADE_IN_MS = 160;

/**
 * Queries stars from the background service worker. On a filter change, fades
 * old rows out, fetches, then fades new rows in — avoiding a swap jolt and
 * keeping the list mounted so scroll position is preserved.
 */
export function useStars(allowHashTagOverride = true) {
  const runtime = useManagerRuntime();
  useLibraryViewPrefs(allowHashTagOverride);
  const f = useFilterStore();
  const [committed, setCommitted] = useState<StarsQueryResult | null>(null);
  // Transition phase drives the list opacity. 'fading-out' keeps the committed
  // (old) rows visible while dimming; 'fading-in' shows the freshly committed
  // rows brightening back up. 'idle' = fully visible.
  const [phase, setPhase] = useState<'idle' | 'fading-out' | 'fading-in'>('idle');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastQueriedFilterKey, setLastQueriedFilterKey] = useState<string | null>(null);
  const ownedPublicLoadRequestedRef = useRef(false);

  const filter = {
    query: f.query,
    languages: f.languages,
    tags: f.tags,
    tagMode: f.tagMode,
    showTombstone: f.showTombstone,
    onlyFavorite: f.onlyFavorite,
    onlyUntagged: f.onlyUntagged,
    onlyArchived: f.onlyArchived,
    onlyOwned: f.onlyOwned,
    sortKey: f.sortKey,
    sortDir: f.sortDir,
  };
  const filterKey = JSON.stringify(filter);

  // A pending refresh (from refresh() or a dataChanged broadcast) bypasses the
  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  // Filter changes still use the fade-out → query → fade-in transition.
  // Same-filter reloads (dataChanged broadcasts or explicit refresh()) update
  // the committed rows in place so the list does not flash.
  useEffect(() => {
    if (!f.libraryViewHydrated) {
      setLoading(true);
      return;
    }
    let cancelled = false;
    let fadeOut: ReturnType<typeof setTimeout> | null = null;
    let fadeIn: ReturnType<typeof setTimeout> | null = null;
    const trigger = classifyStarsQueryTrigger(lastQueriedFilterKey, filterKey);
    const shouldFade = trigger === 'filter-change';
    setLastQueriedFilterKey(filterKey);

    setLoading(true);
    if (shouldFade) setPhase('fading-out');
    let ownedLoadStart: ReturnType<typeof setTimeout> | undefined;
    const requestOwnedPublicRepositories = () => {
      if (ownedPublicLoadRequestedRef.current || ownedLoadStart !== undefined) return;
      ownedLoadStart = setTimeout(() => {
        ownedLoadStart = undefined;
        if (cancelled || ownedPublicLoadRequestedRef.current) return;
        ownedPublicLoadRequestedRef.current = true;
        void runtime.loadOwnedPublicRepositories().catch(() => {
          ownedPublicLoadRequestedRef.current = false;
        });
      }, 0);
    };
    const runQuery = () => {
      runtime.queryStars({ filter, offset: 0, limit: Number.MAX_SAFE_INTEGER })
        .then((result) => {
          if (cancelled) return;
          setCommitted(result);
          if (shouldFade) {
            setPhase('fading-in');
            fadeIn = setTimeout(() => {
              if (!cancelled) setPhase('idle');
            }, FADE_IN_MS);
          } else {
            setPhase('idle');
          }
          setLoading(false);
          requestOwnedPublicRepositories();
        })
        .catch(() => {
          if (!cancelled) {
            setLoading(false);
            if (!shouldFade) setPhase('idle');
          }
        });
    };

    if (shouldFade) {
      fadeOut = setTimeout(() => { void runQuery(); }, FADE_OUT_MS);
    } else {
      runQuery();
    }
    return () => {
      cancelled = true;
      if (fadeOut) clearTimeout(fadeOut);
      if (fadeIn) clearTimeout(fadeIn);
      clearTimeout(ownedLoadStart);
    };
  }, [f.libraryViewHydrated, filterKey, refreshKey, runtime]);

  useEffect(() => runtime.subscribe((event) => {
    if (event.kind === 'reset') ownedPublicLoadRequestedRef.current = false;
    if (event.kind === 'data' || event.kind === 'reset') {
      setRefreshKey((key) => key + 1);
    }
  }), [runtime]);

  const rows: Star[] = committed?.rows ?? [];

  // Built once per query result; rebuilding on every ManagerPanel render is
  // O(total stars) main-thread work that directly adds click latency.
  const tagsByFullName = useMemo(() => {
    const map = new Map<string, Tag>();
    if (committed?.tagsForRows) {
      for (const [name, tag] of Object.entries(committed.tagsForRows)) {
        if (tag) map.set(name, tag);
      }
    }
    return map;
  }, [committed]);

  return {
    rows,
    total: committed?.total ?? 0,
    grandTotal: committed?.grandTotal ?? 0,
    loading,
    phase,
    languages: committed?.languages ?? [],
    tagTree: { tags: committed?.tagTree ?? [], total: committed?.tagTotal ?? 0 },
    tagsByFullName,
    refresh,
  };
}
