import { useCallback, useEffect, useRef, useState } from 'react';
import {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} from '@/auth/auth-store';
import { bgCall } from '@/utils/messaging';
import type {
  WatchInboxQueryResponse,
  WatchRefreshResult,
  WatchThreadAction,
  WatchThreadMutationResult,
} from '@/watch/watch-contract';
import { normalizeWatchCollapsedRepositories } from '@/preferences';
import type { WatchCollapsedRepositorySignatures } from '@/types';
import type { WatchThreadActionPending } from '@/ui/watch-inbox-types';

export function useWatchInbox({
  active = true,
  onMeaningfulAction,
}: {
  /** Dormant resources preserve cached data and perform no background query work. */
  active?: boolean;
  onMeaningfulAction?: () => void;
} = {}) {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [collapsedRepositories, setCollapsedRepositories] =
    useState<WatchCollapsedRepositorySignatures>({});
  const [result, setResult] = useState<WatchInboxQueryResponse | null>(null);
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<'query' | 'refresh' | null>(null);
  const [actionPending, setActionPending] = useState<WatchThreadActionPending | null>(null);
  const [actionError, setActionError] = useState<WatchThreadAction | null>(null);
  const generation = useRef(0);
  const refreshingRef = useRef(false);
  const actionPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const hasLoadedRef = useRef(false);
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

  const load = useCallback(async (silent = false) => {
    if (!mountedRef.current || !activeRef.current) return;
    const requestGeneration = ++generation.current;
    if (!silent) {
      setLoading(true);
      setResult(null);
    }
    try {
      const next = await bgCall<WatchInboxQueryResponse>('queryWatchInbox', { unreadOnly: false });
      if (
        !mountedRef.current
        || !activeRef.current
        || generation.current !== requestGeneration
      ) return;
      setResult(next);
      hasLoadedRef.current = true;
      setError(null);
    } catch {
      if (
        !mountedRef.current
        || !activeRef.current
        || generation.current !== requestGeneration
      ) return;
      setError('query');
    } finally {
      if (mountedRef.current && activeRef.current && generation.current === requestGeneration) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!active) {
      generation.current += 1;
      setLoading(false);
      return;
    }
    void load(hasLoadedRef.current);
  }, [active, load]);
  useEffect(() => {
    let active = true;
    void authStore.getConfig()
      .then((config) => {
        if (active) setCollapsedRepositories(config.watchCollapsedRepositories);
      })
      .catch(() => {
        if (active) setCollapsedRepositories({});
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onMessage = chrome.runtime?.onMessage;
    if (!onMessage) return;
    const listener = (message: { type?: string }) => {
      if (message.type === 'watchChanged' && activeRef.current) void load(true);
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
      if (areaName !== 'local') return;
      if (changes[CONFIG_STORAGE_KEY]) {
        const nextConfig = changes[CONFIG_STORAGE_KEY].newValue as Record<string, unknown> | undefined;
        setCollapsedRepositories(normalizeWatchCollapsedRepositories(
          nextConfig?.watchCollapsedRepositories,
        ));
      }
      if (changes[GITHUB_CREDENTIALS_STORAGE_KEY]) {
        generation.current += 1;
        hasLoadedRef.current = false;
        setResult(null);
        setError(null);
        setLoading(activeRef.current);
        if (activeRef.current) void load();
      }
    };
    onChanged.addListener(listener);
    return () => onChanged.removeListener(listener);
  }, [load]);

  const cooldownUntil = result?.status.inboxStatus === 'cooldown'
    ? result.status.state?.inbox.nextAllowedAt ?? null
    : null;
  useEffect(() => {
    if (!active || !cooldownUntil) {
      if (!cooldownUntil) cooldownProbeRef.current = { deadline: null, attempts: 0 };
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
  }, [active, cooldownProbeTick, cooldownUntil, load]);

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

  const mutateThreads = useCallback(async (
    action: WatchThreadAction,
    requestedIds: readonly string[],
  ) => {
    if (!mountedRef.current || actionPendingRef.current) return;
    const threadIds = [...new Set(requestedIds)];
    if (threadIds.length === 0) return;
    actionPendingRef.current = true;
    setActionPending({ action, threadIds });
    setActionError(null);
    try {
      await bgCall<WatchThreadMutationResult>(
        action === 'read' ? 'markWatchThreadsRead' : 'markWatchThreadsDone',
        { threadIds },
      );
      onMeaningfulAction?.();
      await load(true);
    } catch {
      await load(true);
      if (mountedRef.current) setActionError(action);
    } finally {
      actionPendingRef.current = false;
      if (mountedRef.current) setActionPending(null);
    }
  }, [load, onMeaningfulAction]);

  const markThreadsRead = useCallback((threadIds: readonly string[]) => (
    mutateThreads('read', threadIds)
  ), [mutateThreads]);

  const markThreadsDone = useCallback((threadIds: readonly string[]) => (
    mutateThreads('done', threadIds)
  ), [mutateThreads]);

  const changeUnreadOnly = useCallback((next: boolean) => {
    setUnreadOnly(next);
  }, []);

  const updateRepositoryCollapse = useCallback((
    repositoryFullName: string,
    contentSignature: string | null,
  ) => {
    const repository = repositoryFullName.trim().toLowerCase();
    setCollapsedRepositories((current) => {
      const next = { ...current };
      delete next[repository];
      if (contentSignature) next[repository] = contentSignature;
      return next;
    });
    void authStore.updateWatchRepositoryCollapse(repository, contentSignature).catch(async () => {
      if (!mountedRef.current) return;
      try {
        const config = await authStore.getConfig();
        if (mountedRef.current) setCollapsedRepositories(config.watchCollapsedRepositories);
      } catch {
        if (mountedRef.current) setCollapsedRepositories({});
      }
    });
  }, []);

  return {
    unreadOnly,
    setUnreadOnly: changeUnreadOnly,
    collapsedRepositories,
    updateRepositoryCollapse,
    result,
    loading,
    refreshing: refreshing || result?.status.refreshing === true,
    error,
    refresh,
    reload: load,
    actionPending,
    actionError,
    markThreadsRead,
    markThreadsDone,
  };
}
