import { useCallback, useEffect, useRef, useState } from 'react';
import { GITHUB_CREDENTIALS_STORAGE_KEY } from '@/auth/auth-store';
import { bgCall } from '@/utils/messaging';
import type {
  WatchInboxQueryResponse,
  WatchRefreshResult,
} from '@/watch/watch-contract';

export function useWatchInbox() {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [result, setResult] = useState<WatchInboxQueryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<'query' | 'refresh' | null>(null);
  const generation = useRef(0);
  const unreadOnlyRef = useRef(unreadOnly);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);
  const cooldownProbeRef = useRef<{ deadline: string | null; attempts: number }>({
    deadline: null,
    attempts: 0,
  });
  const [cooldownProbeTick, setCooldownProbeTick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generation.current++;
    };
  }, []);

  const load = useCallback(async (silent = false, mode = unreadOnlyRef.current) => {
    if (!mountedRef.current) return;
    const requestGeneration = ++generation.current;
    if (!silent) {
      setLoading(true);
      setResult(null);
    }
    try {
      const next = await bgCall<WatchInboxQueryResponse>('queryWatchInbox', { unreadOnly: mode });
      if (!mountedRef.current || generation.current !== requestGeneration) return;
      setResult(next);
      setError(null);
    } catch {
      if (!mountedRef.current || generation.current !== requestGeneration) return;
      setError('query');
    } finally {
      if (mountedRef.current && generation.current === requestGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    unreadOnlyRef.current = unreadOnly;
    void load(false, unreadOnly);
  }, [load, unreadOnly]);

  useEffect(() => {
    const onMessage = chrome.runtime?.onMessage;
    if (!onMessage) return;
    const listener = (message: { type?: string }) => {
      if (message.type === 'watchChanged') void load(true);
    };
    onMessage.addListener(listener);
    return () => onMessage.removeListener(listener);
  }, [load]);

  useEffect(() => {
    const onChanged = chrome.storage?.onChanged;
    if (!onChanged) return;
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[GITHUB_CREDENTIALS_STORAGE_KEY]) return;
      void load(true);
    };
    onChanged.addListener(listener);
    return () => onChanged.removeListener(listener);
  }, [load]);

  const cooldownUntil = result?.status.inboxStatus === 'cooldown'
    ? result.status.state?.inbox.nextAllowedAt ?? null
    : null;
  useEffect(() => {
    if (!cooldownUntil) {
      cooldownProbeRef.current = { deadline: null, attempts: 0 };
      return;
    }
    const allowedAt = Date.parse(cooldownUntil);
    if (!Number.isFinite(allowedAt)) return;
    if (cooldownProbeRef.current.deadline !== cooldownUntil) {
      cooldownProbeRef.current = { deadline: cooldownUntil, attempts: 0 };
    }
    const remaining = allowedAt - Date.now();
    // A timer can fire a little early. Retry once against the remaining
    // deadline, but never turn an unchanged cooldown into a tight local loop.
    if (remaining <= 0 && cooldownProbeRef.current.attempts > 0) return;
    // This only re-derives status from local state; network refresh remains user initiated.
    const timer = setTimeout(() => {
      cooldownProbeRef.current.attempts += 1;
      setCooldownProbeTick((current) => current + 1);
      void load(true);
    }, Math.max(0, remaining) + 25);
    return () => clearTimeout(timer);
  }, [cooldownProbeTick, cooldownUntil, load]);

  const refresh = useCallback(async () => {
    if (!mountedRef.current || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      await bgCall<WatchRefreshResult>('refreshWatchInbox');
      await load(true);
    } catch {
      await load(true);
      if (mountedRef.current) setError('refresh');
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, [load]);

  const changeUnreadOnly = useCallback((next: boolean) => {
    unreadOnlyRef.current = next;
    setUnreadOnly(next);
  }, []);

  return {
    unreadOnly,
    setUnreadOnly: changeUnreadOnly,
    result,
    loading,
    refreshing: refreshing || result?.status.refreshing === true,
    error,
    refresh,
    reload: load,
  };
}
