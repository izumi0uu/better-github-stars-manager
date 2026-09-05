import { useCallback, useEffect, useRef, useState } from 'react';
import { useManagerRuntime } from '@/ui/manager-runtime-context';
import type { RadarStatus } from '@/radar/radar-contract';
import type { RadarActivitySource } from '@/radar/radar-model';
import type {
  RadarActionError,
  RadarDiscoverView,
  RadarPendingAction,
  RadarSourceFilters,
  RadarView,
} from '@/ui/radar-types';
import { useRadarActivityResource } from '@/ui/hooks/use-radar-activity-resource';
import { useRadarRecommendationResource } from '@/ui/hooks/use-radar-recommendation-resource';

export function useRadar({
  active = true,
  onMeaningfulAction,
}: {
  /** Dormant resources preserve cached data and perform no background query work. */
  active?: boolean;
  onMeaningfulAction?: () => void;
} = {}) {
  const runtime = useManagerRuntime();
  const activity = useRadarActivityResource(active);
  const recommendation = useRadarRecommendationResource(active);
  const [discoverView, setDiscoverView] = useState<RadarDiscoverView>('following');
  const [view, setView] = useState<RadarView>('feed');
  const [sources, setSources] = useState<RadarSourceFilters>({
    following: true,
    self: false,
  });
  const [pendingAction, setPendingAction] = useState<RadarPendingAction | null>(null);
  const [actionError, setActionError] = useState<RadarActionError | null>(null);
  const [recommendationFavorites, setRecommendationFavorites] = useState<Record<string, boolean>>({});
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mutatingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => runtime.subscribe((event) => {
    if (event.kind === 'reset') setRecommendationFavorites({});
    if (!activeRef.current) {
      if (event.kind === 'reset') {
        activity.invalidateCredentials();
        recommendation.invalidateCredentials();
      }
      return;
    }
    if (event.kind === 'reset') {
      activity.invalidateCredentials();
      recommendation.invalidateCredentials();
      void activity.reload(false);
      void recommendation.reload(false);
      return;
    }
    if (event.kind === 'radar' || event.kind === 'data' || event.kind === 'preferences') {
      void activity.reload(true);
    }
    if (event.kind === 'recommendations' || event.kind === 'data') {
      void recommendation.reload(true);
    }
  }), [
    activity.invalidateCredentials,
    activity.reload,
    recommendation.invalidateCredentials,
    recommendation.reload,
    runtime,
  ]);

  const mutate = useCallback(async <T,>(
    action: RadarPendingAction,
    operation: () => Promise<T>,
    meaningful = false,
  ): Promise<T | null> => {
    if (!mountedRef.current || mutatingRef.current) return null;
    mutatingRef.current = true;
    setPendingAction(action);
    setActionError(null);
    try {
      const value = await operation();
      if (meaningful) onMeaningfulAction?.();
      await activity.reload(true);
      return value;
    } catch (mutationError) {
      if (mountedRef.current) {
        setActionError({
          repositoryKey: action.repositoryKey,
          message: mutationError instanceof Error ? mutationError.message : String(mutationError),
        });
      }
      await activity.reload(true);
      return null;
    } finally {
      mutatingRef.current = false;
      if (mountedRef.current) setPendingAction(null);
    }
  }, [activity.reload, onMeaningfulAction]);

  const star = useCallback((repositoryKey: string, fullName: string) => mutate(
    { kind: 'star', repositoryKey },
    () => runtime.starRepository(fullName).then(async (value) => {
      await recommendation.reload(true);
      return value;
    }),
    true,
  ), [mutate, recommendation.reload, runtime]);

  const unstar = useCallback((repositoryKey: string, fullName: string) => mutate(
    { kind: 'star', repositoryKey },
    () => runtime.markUnstarred(fullName).then(async (value) => {
      await recommendation.reload(true);
      return value;
    }),
    true,
  ), [mutate, recommendation.reload, runtime]);

  const setFavorite = useCallback(async (
    repositoryKey: string,
    fullName: string,
    favorite: boolean,
  ) => {
    if (!mountedRef.current || mutatingRef.current) return null;
    setRecommendationFavorites((current) => ({ ...current, [repositoryKey]: favorite }));
    const result = await mutate(
      { kind: 'favorite', repositoryKey },
      async () => {
        try {
          return await runtime.setFavorite(fullName, favorite);
        } finally {
          await recommendation.reload(true);
        }
      },
      true,
    );
    if (mountedRef.current) {
      setRecommendationFavorites((current) => {
        const next = { ...current };
        delete next[repositoryKey];
        return next;
      });
    }
    return result;
  }, [mutate, recommendation.reload, runtime]);

  const addTag = useCallback((repositoryKey: string, fullName: string, tag: string) => mutate(
    { kind: 'tag', repositoryKey },
    () => runtime.addRepositoryTag(fullName, tag),
    true,
  ), [mutate, runtime]);

  const dismiss = useCallback((repositoryKey: string, activityIds: readonly string[]) => mutate<RadarStatus>(
    { kind: 'dismiss', repositoryKey },
    () => runtime.dismissRadarActivities(activityIds),
  ), [mutate, runtime]);

  const ignoreRecommendation = useCallback((
    repositoryKey: string,
    repositoryFullName: string,
  ) => mutate(
    { kind: 'ignore', repositoryKey },
    () => runtime.ignoreRecommendation(repositoryKey, repositoryFullName)
      .then(async (value) => {
        await recommendation.reload(true);
        return value;
      }),
  ), [mutate, recommendation.reload, runtime]);

  const restoreIgnoredRecommendation = useCallback(async (repositoryKey: string) => {
    try {
      await runtime.restoreIgnoredRecommendation(repositoryKey);
      await recommendation.reload(true);
    } catch (restoreError) {
      if (mountedRef.current) {
        setActionError({
          repositoryKey,
          message: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      }
    }
  }, [recommendation.reload, runtime]);

  const setSourceEnabled = useCallback((source: RadarActivitySource, enabled: boolean) => {
    setSources((current) => (current[source] === enabled
      ? current
      : { ...current, [source]: enabled }));
  }, []);

  return {
    result: activity.result,
    recommendations: recommendation.recommendations,
    recommendationFavorites,
    discoverView,
    setDiscoverView,
    view,
    setView,
    sources,
    setSourceEnabled,
    loading: activity.loading,
    recommendationLoading: recommendation.loading,
    refreshing: activity.refreshing,
    refresh: activity.refresh,
    fullReconcile: activity.fullReconcile,
    recommendationRefreshing: recommendation.refreshing,
    fullReconciling: activity.fullReconciling,
    reload: activity.reload,
    error: activity.error,
    recommendationError: recommendation.error,
    actionError,
    pendingAction,
    reloadRecommendations: recommendation.reload,
    refreshRecommendations: recommendation.refresh,
    star,
    unstar,
    setFavorite,
    addTag,
    dismiss,
    ignoreRecommendation,
    restoreIgnoredRecommendation,
    markSeen: activity.markSeen,
  };
}
