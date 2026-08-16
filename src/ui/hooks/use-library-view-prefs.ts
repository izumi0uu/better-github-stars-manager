import { useEffect, useRef } from 'react';
import {
  DEFAULT_LIBRARY_VIEW_PREFS,
} from '@/preferences';
import {
  libraryViewPrefsFromFilterState,
  libraryViewPrefsKey,
  useFilterStore,
} from '@/ui/filter-store';
import { useManagerRuntime } from '@/ui/manager-runtime-context';

function readHashTagOverride(): string | null {
  const match = location.hash.match(/gsm-tag=([^&]+)/);
  if (!match) return null;
  let tag = '';
  try {
    tag = decodeURIComponent(match[1]).trim();
  } catch {
    tag = '';
  }
  history.replaceState(null, '', location.pathname + location.search);
  return tag || null;
}

export function useLibraryViewPrefs(allowHashTagOverride = true) {
  const runtime = useManagerRuntime();
  const hydratedRef = useRef(false);
  const lastPersistedKeyRef = useRef<string | null>(null);
  const applyingStoredChangeRef = useRef(false);
  const hashTagOverrideRef = useRef<{ initialized: boolean; value: string | null }>({
    initialized: false,
    value: null,
  });
  if (!hashTagOverrideRef.current.initialized) {
    hashTagOverrideRef.current = {
      initialized: true,
      value: allowHashTagOverride ? readHashTagOverride() : null,
    };
  }

  const takeHashTagOverride = () => {
    const value = hashTagOverrideRef.current.value;
    hashTagOverrideRef.current.value = null;
    return value;
  };

  useEffect(() => {
    let cancelled = false;
    const apply = (libraryView: typeof DEFAULT_LIBRARY_VIEW_PREFS) => {
      if (cancelled) return;
      const tagOverride = takeHashTagOverride();
      useFilterStore.getState().applyLibraryViewPrefs(libraryView, tagOverride);
      const nextPrefs = libraryViewPrefsFromFilterState(useFilterStore.getState());
      lastPersistedKeyRef.current = libraryViewPrefsKey(nextPrefs);
      hydratedRef.current = true;
      if (tagOverride) void runtime.updatePreferences({ libraryView: nextPrefs });
    };

    runtime.readPreferences()
      .then((preferences) => {
        if (!hydratedRef.current) apply(preferences.libraryView);
      })
      .catch(() => {
        if (!hydratedRef.current) apply(DEFAULT_LIBRARY_VIEW_PREFS);
      });

    return () => {
      cancelled = true;
    };
  }, [runtime]);

  useEffect(() => useFilterStore.subscribe((state) => {
    if (!hydratedRef.current || !state.libraryViewHydrated) return;
    if (applyingStoredChangeRef.current) return;
    const nextPrefs = libraryViewPrefsFromFilterState(state);
    const nextKey = libraryViewPrefsKey(nextPrefs);
    if (nextKey === lastPersistedKeyRef.current) return;
    lastPersistedKeyRef.current = nextKey;
    void runtime.updatePreferences({ libraryView: nextPrefs });
  }), [runtime]);

  useEffect(() => runtime.subscribe((event) => {
    if (event.kind !== 'preferences' && event.kind !== 'reset') return;
    void runtime.readPreferences().then((preferences) => {
      const nextPrefs = preferences.libraryView;
      const nextKey = libraryViewPrefsKey(nextPrefs);
      if (event.kind !== 'reset' && nextKey === lastPersistedKeyRef.current) return;
      const tagOverride = takeHashTagOverride();
      applyingStoredChangeRef.current = true;
      try {
        if (event.kind === 'reset') useFilterStore.getState().resetFilters();
        useFilterStore.getState().applyLibraryViewPrefs(nextPrefs, tagOverride);
        const appliedPrefs = libraryViewPrefsFromFilterState(useFilterStore.getState());
        lastPersistedKeyRef.current = libraryViewPrefsKey(appliedPrefs);
        hydratedRef.current = true;
        if (tagOverride) void runtime.updatePreferences({ libraryView: appliedPrefs });
      } finally {
        applyingStoredChangeRef.current = false;
      }
    }).catch(() => {});
  }), [runtime]);
}
