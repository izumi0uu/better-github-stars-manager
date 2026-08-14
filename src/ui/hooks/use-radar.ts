import { useCallback, useEffect, useRef, useState } from 'react';
import { bgCall } from '@/utils/messaging';
import type {
  RadarQueryResponse,
  RadarRefreshResult,
  RadarStatus,
} from '@/radar/radar-contract';
import type { RadarActivitySource } from '@/radar/radar-model';
import type {
  RecommendationQueryResponse,
  RecommendationRefreshResult,
} from '@/recommendations/recommendation-model';

export type RadarView = 'feed' | 'projects';
export type RadarDiscoverView = 'following' | 'for-you';
export type RadarActionKind = 'star' | 'favorite' | 'tag' | 'dismiss' | 'ignore';
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
  const [recommendations, setRecommendations] = useState<RecommendationQueryResponse | null>(null);
  const [discoverView, setDiscoverView] = useState<RadarDiscoverView>('following');
  const [view, setView] = useState<RadarView>('feed');
  const [sources, setSources] = useState<RadarSourceFilters>({
    following: true,
    self: false,
  });
  const [loading, setLoading] = useState(true);
  const [recommendationLoading, setRecommendationLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recommendationRefreshing, setRecommendationRefreshing] = useState(false);
  const [error, setError] = useState<'query' | 'refresh' | null>(null);
  const [recommendationError, setRecommendationError] = useState<'query' | 'refresh' | null>(null);
  const [pendingAction, setPendingAction] = useState<RadarPendingAction | null>(null);
  const [actionError, setActionError] = useState<RadarActionError | null>(null);
  const mountedRef = useRef(true);
  const generation = useRef(0);
  const recommendationGeneration = useRef(0);
  const refreshingRef = useRef(false);
  const recommendationRefreshingRef = useRef(false);
  const mutatingRef = useRef(false);
  const cooldownProbeRef = useRef<{ deadline: string | null; attempts: number }>({
    deadline: null,
    attempts: 0,
  });
  const recommendationCooldownProbeRef = useRef<{ deadline: string | null; attempts: number }>({
    deadline: null,
    attempts: 0,
  });
  const [cooldownProbeTick, setCooldownProbeTick] = useState(0);
  const [recommendationCooldownProbeTick, setRecommendationCooldownProbeTick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generation.current += 1;
      recommendationGeneration.current += 1;
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

  const loadRecommendations = useCallback(async (silent = false) => {
    if (!mountedRef.current) return;
    const requestGeneration = ++recommendationGeneration.current;
    if (!silent) {
      setRecommendationLoading(true);
      setRecommendations(null);
    }
    try {
      const next = await bgCall<RecommendationQueryResponse>('queryRecommendations');
      if (!mountedRef.current || recommendationGeneration.current !== requestGeneration) return;
      setRecommendations(next);
      setRecommendationError(null);
    } catch {
      if (!mountedRef.current || recommendationGeneration.current !== requestGeneration) return;
      setRecommendationError('query');
    } finally {
      if (mountedRef.current && recommendationGeneration.current === requestGeneration) {
        setRecommendationLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
    void loadRecommendations(false);
  }, [load, loadRecommendations]);

  useEffect(() => {
    if (typeof chrome === 'undefined') return;
    const onMessage = chrome.runtime?.onMessage;
    if (!onMessage) return;
    const listener = (message: { type?: string }) => {
      if (message.type === 'radarChanged' || message.type === 'dataChanged') void load(true);
      if (message.type === 'recommendationsChanged' || message.type === 'dataChanged') {
        void loadRecommendations(true);
      }
    };
    onMessage.addListener(listener);
    return () => onMessage.removeListener(listener);
  }, [load, loadRecommendations]);

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

  const recommendationCooldownUntil = recommendations?.status.snapshotStatus === 'cooldown'
    ? recommendations.status.state?.nextAllowedAt ?? null
    : null;
  useEffect(() => {
    if (!recommendationCooldownUntil) {
      recommendationCooldownProbeRef.current = { deadline: null, attempts: 0 };
      return;
    }
    const allowedAt = Date.parse(recommendationCooldownUntil);
    if (!Number.isFinite(allowedAt)) return;
    if (recommendationCooldownProbeRef.current.deadline !== recommendationCooldownUntil) {
      recommendationCooldownProbeRef.current = { deadline: recommendationCooldownUntil, attempts: 0 };
    }
    const remaining = allowedAt - Date.now();
    if (remaining <= 0 && recommendationCooldownProbeRef.current.attempts > 0) return;
    const timer = window.setTimeout(() => {
      recommendationCooldownProbeRef.current.attempts += 1;
      setRecommendationCooldownProbeTick((current) => current + 1);
      void loadRecommendations(true);
    }, Math.max(0, remaining) + 25);
    return () => window.clearTimeout(timer);
  }, [
    loadRecommendations,
    recommendationCooldownProbeTick,
    recommendationCooldownUntil,
  ]);

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

  const refreshRecommendations = useCallback(async () => {
    if (!mountedRef.current || recommendationRefreshingRef.current) return;
    recommendationRefreshingRef.current = true;
    setRecommendationRefreshing(true);
    setRecommendationError(null);
    try {
      const refreshResult = await bgCall<RecommendationRefreshResult>('refreshRecommendations');
      await loadRecommendations(true);
      if (mountedRef.current && !refreshResult.published && refreshResult.status.errorCode) {
        setRecommendationError('refresh');
      }
    } catch {
      await loadRecommendations(true);
      if (mountedRef.current) setRecommendationError('refresh');
    } finally {
      recommendationRefreshingRef.current = false;
      if (mountedRef.current) setRecommendationRefreshing(false);
    }
  }, [loadRecommendations]);

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
    () => bgCall('radarStarRepository', { fullName }).then(async (value) => {
      await loadRecommendations(true);
      return value;
    }),
  ), [loadRecommendations, mutate]);

  const unstar = useCallback((repositoryKey: string, fullName: string) => mutate(
    { kind: 'star', repositoryKey },
    () => bgCall('markUnstarred', { full_name: fullName }).then(async (value) => {
      await loadRecommendations(true);
      return value;
    }),
  ), [loadRecommendations, mutate]);

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

  const ignoreRecommendation = useCallback((
    repositoryKey: string,
    repositoryFullName: string,
  ) => mutate(
    { kind: 'ignore', repositoryKey },
    () => bgCall('ignoreRecommendation', { repositoryKey, repositoryFullName })
      .then(async (value) => {
        await loadRecommendations(true);
        return value;
      }),
  ), [loadRecommendations, mutate]);

  const restoreIgnoredRecommendation = useCallback(async (repositoryKey: string) => {
    try {
      await bgCall('restoreIgnoredRecommendation', { repositoryKey });
    } catch (restoreError) {
      if (mountedRef.current) {
        setActionError({
          repositoryKey,
          message: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      }
    }
  }, []);
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
    recommendations,
    discoverView,
    setDiscoverView,
    view,
    setView,
    sources,
    setSourceEnabled,
    loading,
    recommendationLoading,
    refreshing: refreshing || result?.status.refreshing === true,
    recommendationRefreshing: recommendationRefreshing
      || recommendations?.status.refreshing === true,
    error,
    recommendationError,
    actionError,
    pendingAction,
    refresh,
    refreshRecommendations,
    reload: load,
    reloadRecommendations: loadRecommendations,
    star,
    unstar,
    setFavorite,
    addTag,
    dismiss,
    ignoreRecommendation,
    restoreIgnoredRecommendation,
    markSeen,
  };
}
