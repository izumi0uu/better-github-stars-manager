import { useCallback, useEffect, useRef, useState } from 'react';
import { useManagerRuntime } from '@/ui/manager-runtime-context';
import {
  WATCH_MAX_THREAD_ACTIONS,
  type WatchInboxQueryResponse,
  type WatchThreadAction,
} from '@/watch/watch-contract';
import type { WatchCollapsedRepositorySignatures } from '@/types';
import type { WatchThreadActionPending } from '@/ui/watch-inbox-types';

const WATCH_EAGER_HISTORY_MAX_PAGE = 20;

export function useWatchInbox({
  active = true,
  visible = false,
  onMeaningfulAction,
}: {
  /** Dormant resources preserve cached data and perform no background query work. */
  active?: boolean;
  /** Marks a user-visible Watch visit without disabling background prefetch. */
  visible?: boolean;
  onMeaningfulAction?: () => void;
} = {}) {
  const runtime = useManagerRuntime();
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [collapsedRepositories, setCollapsedRepositories] =
    useState<WatchCollapsedRepositorySignatures>({});
  const [result, setResult] = useState<WatchInboxQueryResponse | null>(null);
  const [newerThan, setNewerThan] = useState<string | null>(null);
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<'query' | 'refresh' | null>(null);
  const [actionPending, setActionPending] = useState<WatchThreadActionPending | null>(null);
  const [actionError, setActionError] = useState<WatchThreadAction | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadOlderError, setLoadOlderError] = useState(false);
  const generation = useRef(0);
  const refreshingRef = useRef(false);
  const actionPendingRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const hasLoadedRef = useRef(false);
  const acknowledgedLoadRef = useRef<string | null>(null);
  const lastAcknowledgedLoadRef = useRef<{ accountLogin: string; loadedAt: string } | null>(null);
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
      const next = await runtime.queryWatchInbox({ unreadOnly: false });
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
  }, [runtime]);

  useEffect(() => {
    if (!active) {
      generation.current += 1;
      setLoading(false);
      return;
    }
    void load(hasLoadedRef.current);
  }, [active, load]);
  useEffect(() => {
    let mounted = true;
    const syncPreferences = () => {
      void runtime.readPreferences()
        .then((preferences) => {
          if (mounted) setCollapsedRepositories(preferences.watchCollapsedRepositories);
        })
        .catch(() => {
          if (mounted) setCollapsedRepositories({});
        });
    };
    syncPreferences();
    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind === 'preferences' || event.kind === 'reset') syncPreferences();
      if (event.kind === 'reset') {
        generation.current += 1;
        hasLoadedRef.current = false;
        acknowledgedLoadRef.current = null;
        lastAcknowledgedLoadRef.current = null;
        setNewerThan(null);
        setResult(null);
        setError(null);
        setLoading(activeRef.current);
        if (activeRef.current) void load(false);
        return;
      }
      if (activeRef.current && (event.kind === 'watch' || event.kind === 'data')) {
        void load(true);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [load, runtime]);

  useEffect(() => {
    if (!visible) {
      acknowledgedLoadRef.current = null;
      setNewerThan(null);
      return;
    }
    const accountLogin = result?.status.accountLogin ?? null;
    const inbox = result?.status.state?.inbox ?? null;
    if (!accountLogin || !inbox || acknowledgedLoadRef.current === accountLogin) return;
    acknowledgedLoadRef.current = accountLogin;
    const localBoundary = lastAcknowledgedLoadRef.current?.accountLogin === accountLogin
      ? lastAcknowledgedLoadRef.current.loadedAt
      : null;
    const persistedBoundaryMs = Date.parse(inbox.newerThan ?? '');
    const localBoundaryMs = Date.parse(localBoundary ?? '');
    setNewerThan(Number.isFinite(localBoundaryMs) && (
      !Number.isFinite(persistedBoundaryMs) || localBoundaryMs > persistedBoundaryMs
    )
      ? localBoundary
      : inbox.newerThan);

    const optimisticLoadedAt = new Date(runtime.now()).toISOString();
    lastAcknowledgedLoadRef.current = { accountLogin, loadedAt: optimisticLoadedAt };
    void runtime.markWatchLoaded().then((loadedAt) => {
      if (loadedAt && lastAcknowledgedLoadRef.current?.accountLogin === accountLogin) {
        lastAcknowledgedLoadRef.current = { accountLogin, loadedAt };
      }
    }).catch(() => {
      if (lastAcknowledgedLoadRef.current?.loadedAt === optimisticLoadedAt) {
        lastAcknowledgedLoadRef.current = null;
      }
    });
  }, [result, runtime, visible]);

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
    const remaining = allowedAt - runtime.now();
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
  }, [active, cooldownProbeTick, cooldownUntil, load, runtime]);

  const refresh = useCallback(async () => {
    if (!mountedRef.current || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    setLoadOlderError(false);
    try {
      await runtime.refreshWatch();
      await load(true);
    } catch {
      await load(true);
      if (mountedRef.current) setError('refresh');
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, [load, runtime]);
  const loadOlder = useCallback(async () => {
    if (!mountedRef.current || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setLoadOlderError(false);
    try {
      await runtime.loadOlderWatch();
      await load(true);
    } catch {
      await load(true);
      if (mountedRef.current) setLoadOlderError(true);
    } finally {
      loadingOlderRef.current = false;
      if (mountedRef.current) setLoadingOlder(false);
    }
  }, [load, runtime]);

  const historyInbox = result?.status.state?.inbox ?? null;
  const historyNextPage = historyInbox?.historyNextPage ?? null;
  const shouldEagerlyLoadOlder = active
    && visible
    && historyNextPage != null
    && historyNextPage <= WATCH_EAGER_HISTORY_MAX_PAGE
    && historyInbox?.historyExhausted !== true
    && historyInbox?.historyErrorCode == null
    && error === null
    && !refreshing
    && result?.status.refreshing !== true
    && !loadingOlder
    && !loadOlderError;
  useEffect(() => {
    if (!shouldEagerlyLoadOlder) return;
    // Pages 1-20 cover about 1,000 GitHub notification candidates. Fill that
    // range on a visible visit; only larger histories need manual pagination.
    void loadOlder();
  }, [historyNextPage, loadOlder, shouldEagerlyLoadOlder]);

  const actionAccountLogin = result?.status.accountLogin ?? null;

  const mutateThreads = useCallback(async (
    action: WatchThreadAction,
    requestedIds: readonly string[],
  ) => {
    if (!mountedRef.current || actionPendingRef.current || !actionAccountLogin) return;
    const threadIds = [...new Set(requestedIds)];
    if (threadIds.length === 0) return;
    actionPendingRef.current = true;
    setActionPending({ action, threadIds });
    setActionError(null);
    try {
      for (let offset = 0; offset < threadIds.length; offset += WATCH_MAX_THREAD_ACTIONS) {
        const input = {
          accountLogin: actionAccountLogin,
          threadIds: threadIds.slice(offset, offset + WATCH_MAX_THREAD_ACTIONS),
        };
        await (action === 'read'
          ? runtime.markWatchThreadsRead(input)
          : runtime.markWatchThreadsDone(input));
      }
      onMeaningfulAction?.();
      await load(true);
    } catch {
      await load(true);
      if (mountedRef.current) setActionError(action);
    } finally {
      actionPendingRef.current = false;
      if (mountedRef.current) setActionPending(null);
    }
  }, [actionAccountLogin, load, onMeaningfulAction, runtime]);

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
    void runtime.updateWatchCollapse(repository, contentSignature).catch(async () => {
      if (!mountedRef.current) return;
      try {
        const preferences = await runtime.readPreferences();
        if (mountedRef.current) {
          setCollapsedRepositories(preferences.watchCollapsedRepositories);
        }
      } catch {
        if (mountedRef.current) setCollapsedRepositories({});
      }
    });
  }, [runtime]);

  const visibleLoadOlderError = !loadingOlder && (
    loadOlderError || result?.status.state?.inbox.historyErrorCode != null
  );

  return {
    unreadOnly,
    setUnreadOnly: changeUnreadOnly,
    collapsedRepositories,
    updateRepositoryCollapse,
    result,
    newerThan,
    loading,
    refreshing: refreshing || result?.status.refreshing === true,
    error,
    refresh,
    loadingOlder,
    loadOlderError: visibleLoadOlderError,
    loadOlder,
    reload: load,
    actionPending,
    actionError,
    markThreadsRead,
    markThreadsDone,
  };
}
