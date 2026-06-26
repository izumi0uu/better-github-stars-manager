import { useEffect, useState } from 'react';
import { useFilterStore } from './filter-store';
import type { Star, Tag } from '@/types';
import type { QueryResult } from '@/background/query';

// Transition timings for the list fade-out → swap → fade-in (see FADE_PHASE).
const FADE_OUT_MS = 120;
const FADE_IN_MS = 160;

/**
 * Queries stars from the background service worker. On a filter change, fades
 * old rows out, fetches, then fades new rows in — avoiding a swap jolt and
 * keeping the list mounted so scroll position is preserved.
 */
export function useStars() {
  const f = useFilterStore();
  const [committed, setCommitted] = useState<QueryResult | null>(null);
  // Transition phase drives the list opacity. 'fading-out' keeps the committed
  // (old) rows visible while dimming; 'fading-in' shows the freshly committed
  // rows brightening back up. 'idle' = fully visible.
  const [phase, setPhase] = useState<'idle' | 'fading-out' | 'fading-in'>('idle');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const filter = {
    query: f.query,
    languages: f.languages,
    tags: f.tags,
    tagMode: f.tagMode,
    showTombstone: f.showTombstone,
    onlyFavorite: f.onlyFavorite,
    onlyUntagged: f.onlyUntagged,
    sortKey: f.sortKey,
    sortDir: f.sortDir,
  };
  const filterKey = JSON.stringify(filter);

  // A pending refresh (from refresh() or a dataChanged broadcast) bypasses the
  // fade-out — it's a same-filter reload, so there's nothing to transition
  // away from; we just refetch and fade the new rows in.
  const refresh = () => {
    setRefreshKey((key) => key + 1);
  };

  // Fade out → query → fade in, driven by the filter signature changing.
  // The query is deliberately delayed until the fade-out completes so the old
  // rows remain on screen (dimming) instead of vanishing mid-fade.
  useEffect(() => {
    let cancelled = false;
    let fadeOut: ReturnType<typeof setTimeout> | null = null;
    let fadeIn: ReturnType<typeof setTimeout> | null = null;

    setLoading(true);
    setPhase('fading-out');

    fadeOut = setTimeout(() => {
      if (cancelled) return;
      chrome.runtime
        .sendMessage({ type: 'query', params: { filter, offset: 0, limit: Number.MAX_SAFE_INTEGER } })
        .then((res: { ok: boolean; data?: QueryResult; error?: string }) => {
          if (cancelled) return;
          if (res?.ok && res.data) {
            setCommitted(res.data); // swap to new rows under the dimmed list
            setPhase('fading-in');
            fadeIn = setTimeout(() => {
              if (!cancelled) setPhase('idle');
            }, FADE_IN_MS);
          }
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) {
            setLoading(false);
            setPhase('idle');
          }
        });
    }, FADE_OUT_MS);

    return () => {
      cancelled = true;
      if (fadeOut) clearTimeout(fadeOut);
      if (fadeIn) clearTimeout(fadeIn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refreshKey]);

  // Live refresh when background signals data changed (sync/write).
  useEffect(() => {
    const listener = (msg: { type?: string }) => {
      if (msg.type === 'dataChanged') {
        setRefreshKey((key) => key + 1);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const rows: Star[] = committed?.rows ?? [];
  const tagsByFullName = new Map<string, Tag>();
  if (committed?.tagsForRows) {
    for (const [name, tag] of Object.entries(committed.tagsForRows)) {
      if (tag) tagsByFullName.set(name, tag);
    }
  }

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
