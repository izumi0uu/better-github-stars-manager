import { useCallback, useEffect, useRef, useState } from 'react';
import { GITHUB_CREDENTIALS_STORAGE_KEY } from '@/auth/auth-store';
import { bgCall, type ManagerSurfaceBadgeCounts } from '@/utils/messaging';

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
  const [counts, setCounts] = useState<ManagerSurfaceBadgeCounts>(EMPTY_COUNTS);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await bgCall<ManagerSurfaceBadgeCounts>('queryManagerSurfaceBadges');
      if (!mountedRef.current || request !== requestRef.current) return;
      setCounts((current) => sameCounts(current, next) ? current : next);
    } catch {
      // Preserve the last known badges when the background is temporarily unavailable.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();

    const onMessage = (message: { type?: string }) => {
      if (
        message.type === 'watchChanged'
        || message.type === 'radarChanged'
        || message.type === 'dataChanged'
      ) {
        void load();
      }
    };
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[GITHUB_CREDENTIALS_STORAGE_KEY]) return;
      requestRef.current += 1;
      setCounts((current) => sameCounts(current, EMPTY_COUNTS) ? current : EMPTY_COUNTS);
      void load();
    };

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, [load]);

  return counts;
}
