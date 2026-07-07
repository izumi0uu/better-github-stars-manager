import { useEffect, useRef } from 'react';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import {
  DEFAULT_LIBRARY_VIEW_PREFS,
  normalizeLibraryViewPrefs,
} from '@/preferences';
import {
  libraryViewPrefsFromFilterState,
  libraryViewPrefsKey,
  useFilterStore,
} from '@/ui/filter-store';

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

export function useLibraryViewPrefs() {
  const hydratedRef = useRef(false);
  const lastPersistedKeyRef = useRef<string | null>(null);
  const applyingStoredChangeRef = useRef(false);
  const hashTagOverrideRef = useRef<{ initialized: boolean; value: string | null }>({
    initialized: false,
    value: null,
  });
  if (!hashTagOverrideRef.current.initialized) {
    hashTagOverrideRef.current = { initialized: true, value: readHashTagOverride() };
  }

  const takeHashTagOverride = () => {
    const value = hashTagOverrideRef.current.value;
    hashTagOverrideRef.current.value = null;
    return value;
  };

  useEffect(() => {
    let cancelled = false;

    authStore.getConfig()
      .then((config) => {
        if (cancelled || hydratedRef.current) return;
        const tagOverride = takeHashTagOverride();
        useFilterStore.getState().applyLibraryViewPrefs(config.libraryView, tagOverride);
        const nextPrefs = libraryViewPrefsFromFilterState(useFilterStore.getState());
        lastPersistedKeyRef.current = libraryViewPrefsKey(nextPrefs);
        hydratedRef.current = true;
        if (tagOverride) void authStore.updateLibraryViewPrefs(nextPrefs);
      })
      .catch(() => {
        if (cancelled || hydratedRef.current) return;
        const tagOverride = takeHashTagOverride();
        useFilterStore.getState().applyLibraryViewPrefs(DEFAULT_LIBRARY_VIEW_PREFS, tagOverride);
        const nextPrefs = libraryViewPrefsFromFilterState(useFilterStore.getState());
        lastPersistedKeyRef.current = libraryViewPrefsKey(
          nextPrefs,
        );
        hydratedRef.current = true;
        if (tagOverride) void authStore.updateLibraryViewPrefs(nextPrefs);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = useFilterStore.subscribe((state) => {
      if (!hydratedRef.current || !state.libraryViewHydrated) return;
      if (applyingStoredChangeRef.current) return;
      const nextPrefs = libraryViewPrefsFromFilterState(state);
      const nextKey = libraryViewPrefsKey(nextPrefs);
      if (nextKey === lastPersistedKeyRef.current) return;
      lastPersistedKeyRef.current = nextKey;
      void authStore.updateLibraryViewPrefs(nextPrefs);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[CONFIG_STORAGE_KEY];
      if (!change?.newValue) return;
      const nextConfig = change.newValue as { libraryView?: unknown };
      if (!Object.prototype.hasOwnProperty.call(nextConfig, 'libraryView')) return;
      const nextPrefs = normalizeLibraryViewPrefs(nextConfig.libraryView);
      const nextKey = libraryViewPrefsKey(nextPrefs);
      if (nextKey === lastPersistedKeyRef.current) return;
      const tagOverride = takeHashTagOverride();

      applyingStoredChangeRef.current = true;
      try {
        useFilterStore.getState().applyLibraryViewPrefs(nextPrefs, tagOverride);
        const appliedPrefs = libraryViewPrefsFromFilterState(useFilterStore.getState());
        lastPersistedKeyRef.current = libraryViewPrefsKey(appliedPrefs);
        hydratedRef.current = true;
        if (tagOverride) void authStore.updateLibraryViewPrefs(appliedPrefs);
      } finally {
        applyingStoredChangeRef.current = false;
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
}
