import { useCallback, useEffect, useState } from 'react';
import { useManagerRuntime } from '@/ui/manager-runtime-context';

/**
 * Returns a className fragment ('dark' | ''), not a documentElement toggle: the
 * stars-page root lives in a shadow DOM, so toggling <html> would flip
 * github.com's own dark mode.
 */
export function useTheme() {
  const runtime = useManagerRuntime();
  const [theme, setThemeState] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    let cancelled = false;
    const syncTheme = () => {
      void runtime.readPreferences()
        .then((preferences) => {
          if (!cancelled) setThemeState(preferences.theme);
        })
        .catch(() => {});
    };
    syncTheme();
    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind === 'preferences' || event.kind === 'reset') syncTheme();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runtime]);

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      void runtime.updatePreferences({ theme: next });
      return next;
    });
  }, [runtime]);

  const themeClass = theme === 'dark' ? 'dark' : '';
  return { theme, themeClass, toggle };
}
