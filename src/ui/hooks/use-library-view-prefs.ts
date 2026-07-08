import { useEffect, useRef } from 'react';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import { browserRuntime, isBrowserStorageAvailable, type BrowserStorageChange } from '@/platform/browser-runtime';
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

  useEffect(() => {
    let cancelled = false;

    authStore.getConfig()
      .then((config) => {
        if (cancelled || hydratedRef.current) return;
        const tagOverride = readHashTagOverride();
        useFilterStore.getState().applyLibraryViewPrefs(config.libraryView, tagOverride);
        const nextPrefs = libraryViewPrefsFromFilterState(useFilterStore.getState());
        lastPersistedKeyRef.current = libraryViewPrefsKey(nextPrefs);
        hydratedRef.current = true;
        if (tagOverride) void authStore.updateLibraryViewPrefs(nextPrefs);
      })
      .catch(() => {
        if (cancelled || hydratedRef.current) return;
        useFilterStore.getState().applyLibraryViewPrefs(DEFAULT_LIBRARY_VIEW_PREFS);
        lastPersistedKeyRef.current = libraryViewPrefsKey(
          libraryViewPrefsFromFilterState(useFilterStore.getState()),
        );
        hydratedRef.current = true;
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
    if (!isBrowserStorageAvailable()) return undefined;
    const listener = (
      changes: Record<string, BrowserStorageChange>,
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

      applyingStoredChangeRef.current = true;
      useFilterStore.getState().applyLibraryViewPrefs(nextPrefs);
      lastPersistedKeyRef.current = nextKey;
      hydratedRef.current = true;
      applyingStoredChangeRef.current = false;
    };

    browserRuntime.storage.onChanged.addListener(listener);
    return () => browserRuntime.storage.onChanged.removeListener(listener);
  }, []);
}
