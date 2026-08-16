import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagerSurfaceBadgeCounts } from '@/runtime/manager-runtime';
import { useManagerRuntime } from '@/ui/manager-runtime-context';

const EMPTY_COUNTS: ManagerSurfaceBadgeCounts = Object.freeze({
  watchUnreadCount: 0,
  radarUnseenCount: 0,
});

function sameCounts(
  previous: ManagerSurfaceBadgeCounts,
  current: ManagerSurfaceBadgeCounts,
): boolean {
  return previous.watchUnreadCount === current.watchUnreadCount
    && previous.radarUnseenCount === current.radarUnseenCount;
}

/** Lightweight badge counts that stay live without mounting either full surface query. */
export function useManagerSurfaceBadges(): ManagerSurfaceBadgeCounts {
  const runtime = useManagerRuntime();
  const [counts, setCounts] = useState<ManagerSurfaceBadgeCounts>(EMPTY_COUNTS);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await runtime.querySurfaceBadges();
      if (!mountedRef.current || request !== requestRef.current) return;
      setCounts((current) => sameCounts(current, next) ? current : next);
    } catch {
      // Preserve the last known badges when the runtime is temporarily unavailable.
    }
  }, [runtime]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const unsubscribe = runtime.subscribe((event) => {
      if (
        event.kind !== 'watch'
        && event.kind !== 'radar'
        && event.kind !== 'data'
        && event.kind !== 'reset'
      ) return;
      if (event.kind === 'reset') {
        requestRef.current += 1;
        setCounts((current) => sameCounts(current, EMPTY_COUNTS) ? current : EMPTY_COUNTS);
      }
      void load();
    });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      unsubscribe();
    };
  }, [load, runtime]);

  return counts;
}
