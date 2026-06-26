import { useCallback, useEffect, useState } from 'react';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';

/**
 * Returns a className fragment ('dark' | ''), not a documentElement toggle: the
 * stars-page root lives in a shadow DOM, so toggling <html> would flip
 * github.com's own dark mode.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const syncTheme = () => {
      authStore.getTheme().then((t) => setThemeState(t)).catch(() => {});
    };
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === 'local' && changes[CONFIG_STORAGE_KEY]) syncTheme();
    };

    syncTheme();
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((cur) => {
      const next = cur === 'dark' ? 'light' : 'dark';
      authStore.setTheme(next); // fire-and-forget persist
      return next;
    });
  }, []);

  /** Attach this to the themed root element's className. */
  const themeClass = theme === 'dark' ? 'dark' : '';

  return { theme, themeClass, toggle };
}
