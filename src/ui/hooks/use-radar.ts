import { useCallback, useEffect, useRef, useState } from 'react';
import { bgCall } from '@/utils/messaging';
import type {
  RadarQueryResponse,
  RadarRefreshResult,
  RadarStatus,
} from '@/radar/radar-contract';
import type { RadarActivitySource } from '@/radar/radar-model';

export type RadarView = 'feed' | 'projects';
export type RadarActionKind = 'star' | 'favorite' | 'tag' | 'dismiss';
export type RadarSourceFilters = Readonly<Record<RadarActivitySource, boolean>>;

export type RadarPendingAction = Readonly<{
  kind: RadarActionKind;
  repositoryKey: string;
}>;
export type RadarActionError = Readonly<{
  repositoryKey: string;
  message: string;
}>;

export function useRadar() {
  const [result, setResult] = useState<RadarQueryResponse | null>(null);
  const [view, setView] = useState<RadarView>('feed');
  const [sources, setSources] = useState<RadarSourceFilters>({
    following: true,
    self: false,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<'query' | 'refresh' | null>(null);
  const [pendingAction, setPendingAction] = useState<RadarPendingAction | null>(null);
  const [actionError, setActionError] = useState<RadarActionError | null>(null);
  const mountedRef = useRef(true);
  const generation = useRef(0);
  const refreshingRef = useRef(false);
  const mutatingRef = useRef(false);
  const cooldownProbeRef = useRef<{ deadline: string | null; attempts: number }>({
    deadline: null,
    attempts: 0,
  });
  const [cooldownProbeTick, setCooldownProbeTick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generation.current += 1;
    };
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!mountedRef.current) return;
    const requestGeneration = ++generation.current;
    if (!silent) {
      setLoading(true);
      setResult(null);
    }
    try {
      const next = await bgCall<RadarQueryResponse>('queryRadar');
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
    void load(false);
  }, [load]);

  useEffect(() => {
    if (typeof chrome === 'undefined') return;
    const onMessage = chrome.runtime?.onMessage;
    if (!onMessage) return;
    const listener = (message: { type?: string }) => {
      if (message.type === 'radarChanged' || message.type === 'dataChanged') void load(true);
    };
    onMessage.addListener(listener);
    return () => onMessage.removeListener(listener);
  }, [load]);

  const cooldownUntil = result?.status.snapshotStatus === 'cooldown'
    ? result.status.state?.nextAllowedAt ?? null
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
    if (remaining <= 0 && cooldownProbeRef.current.attempts > 0) return;
    const timer = window.setTimeout(() => {
      cooldownProbeRef.current.attempts += 1;
      setCooldownProbeTick((current) => current + 1);
      void load(true);
    }, Math.max(0, remaining) + 25);
    return () => window.clearTimeout(timer);
  }, [cooldownProbeTick, cooldownUntil, load]);

  const refresh = useCallback(async () => {
    if (!mountedRef.current || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const refreshResult = await bgCall<RadarRefreshResult>('refreshRadar');
      await load(true);
      if (mountedRef.current && !refreshResult.published && refreshResult.status.errorCode) {
        setError('refresh');
      }
    } catch {
      await load(true);
      if (mountedRef.current) setError('refresh');
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, [load]);

  const mutate = useCallback(async <T,>(
    action: RadarPendingAction,
    operation: () => Promise<T>,
  ): Promise<T | null> => {
    if (!mountedRef.current || mutatingRef.current) return null;
    mutatingRef.current = true;
    setPendingAction(action);
    setActionError(null);
    try {
      const value = await operation();
      await load(true);
      return value;
    } catch (mutationError) {
      if (mountedRef.current) {
        setActionError({
          repositoryKey: action.repositoryKey,
          message: mutationError instanceof Error ? mutationError.message : String(mutationError),
        });
      }
      await load(true);
      return null;
    } finally {
      mutatingRef.current = false;
      if (mountedRef.current) setPendingAction(null);
    }
  }, [load]);

  const star = useCallback((repositoryKey: string, fullName: string) => mutate(
    { kind: 'star', repositoryKey },
    () => bgCall('radarStarRepository', { fullName }),
  ), [mutate]);

  const setFavorite = useCallback((
    repositoryKey: string,
    fullName: string,
    favorite: boolean,
  ) => mutate(
    { kind: 'favorite', repositoryKey },
    () => bgCall('setFavorite', { full_name: fullName, favorite }),
  ), [mutate]);

  const addTag = useCallback((repositoryKey: string, fullName: string, tag: string) => mutate(
    { kind: 'tag', repositoryKey },
    () => bgCall('radarAddTag', { fullName, tag }),
  ), [mutate]);

  const dismiss = useCallback((repositoryKey: string, activityIds: readonly string[]) => mutate<RadarStatus>(
    { kind: 'dismiss', repositoryKey },
    () => bgCall<RadarStatus>('dismissRadarActivities', { activityIds }),
  ), [mutate]);
  const markSeen = useCallback((activityIds: readonly string[]) => {
    const ids = [...new Set(activityIds)];
    if (!mountedRef.current || ids.length === 0) return;
    const idSet = new Set(ids);
    const seenAt = new Date().toISOString();
    setResult((current) => {
      if (!current) return current;
      let newlySeen = 0;
      const activities = current.activities.map((activity) => {
        if (activity.source !== 'following' || activity.seen || !idSet.has(activity.id)) {
          return activity;
        }
        newlySeen += 1;
        return { ...activity, seen: true, seenAt };
      });
      if (newlySeen === 0) return current;
      return {
        ...current,
        activities,
        unseenCount: Math.max(0, current.unseenCount - newlySeen),
      };
    });
    void bgCall<RadarStatus>('markRadarActivitiesSeen', { activityIds: ids })
      .then(() => load(true), () => load(true));
  }, [load]);

  const setSourceEnabled = useCallback((source: RadarActivitySource, enabled: boolean) => {
    setSources((current) => (current[source] === enabled
      ? current
      : { ...current, [source]: enabled }));
  }, []);

  return {
    result,
    view,
    setView,
    sources,
    setSourceEnabled,
    loading,
    refreshing: refreshing || result?.status.refreshing === true,
    error,
    actionError,
    pendingAction,
    refresh,
    reload: load,
    star,
    setFavorite,
    addTag,
    dismiss,
    markSeen,
  };
}
