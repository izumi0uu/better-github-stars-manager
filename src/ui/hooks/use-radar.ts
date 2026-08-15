import { useCallback, useEffect, useRef, useState } from 'react';
import { GITHUB_CREDENTIALS_STORAGE_KEY } from '@/auth/auth-store';
import { bgCall } from '@/utils/messaging';
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

  useEffect(() => {
    if (typeof chrome === 'undefined') return;
    const onMessage = chrome.runtime?.onMessage;
    if (!onMessage) return;
    const listener = (message: { type?: string }) => {
      if (!activeRef.current) return;
      if (message.type === 'radarChanged' || message.type === 'dataChanged') {
        void activity.reload(true);
      }
      if (message.type === 'recommendationsChanged' || message.type === 'dataChanged') {
        void recommendation.reload(true);
      }
    };
    onMessage.addListener(listener);
    return () => onMessage.removeListener(listener);
  }, [activity.reload, recommendation.reload]);

  useEffect(() => {
    if (typeof chrome === 'undefined') return;
    const onChanged = chrome.storage?.onChanged;
    if (!onChanged) return;
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[GITHUB_CREDENTIALS_STORAGE_KEY]) return;
      activity.invalidateCredentials();
      recommendation.invalidateCredentials();
      if (!activeRef.current) return;
      void activity.reload();
      void recommendation.reload();
    };
    onChanged.addListener(listener);
    return () => onChanged.removeListener(listener);
  }, [
    activity.invalidateCredentials,
    activity.reload,
    recommendation.invalidateCredentials,
    recommendation.reload,
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
    () => bgCall('radarStarRepository', { fullName }).then(async (value) => {
      await recommendation.reload(true);
      return value;
    }),
    true,
  ), [mutate, recommendation.reload]);

  const unstar = useCallback((repositoryKey: string, fullName: string) => mutate(
    { kind: 'star', repositoryKey },
    () => bgCall('markUnstarred', { full_name: fullName }).then(async (value) => {
      await recommendation.reload(true);
      return value;
    }),
    true,
  ), [mutate, recommendation.reload]);

  const setFavorite = useCallback((
    repositoryKey: string,
    fullName: string,
    favorite: boolean,
  ) => mutate(
    { kind: 'favorite', repositoryKey },
    () => bgCall('setFavorite', { full_name: fullName, favorite }),
    true,
  ), [mutate]);

  const addTag = useCallback((repositoryKey: string, fullName: string, tag: string) => mutate(
    { kind: 'tag', repositoryKey },
    () => bgCall('radarAddTag', { fullName, tag }),
    true,
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
        await recommendation.reload(true);
        return value;
      }),
  ), [mutate, recommendation.reload]);

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

  const setSourceEnabled = useCallback((source: RadarActivitySource, enabled: boolean) => {
    setSources((current) => (current[source] === enabled
      ? current
      : { ...current, [source]: enabled }));
  }, []);

  return {
    result: activity.result,
    recommendations: recommendation.recommendations,
    discoverView,
    setDiscoverView,
    view,
    setView,
    sources,
    setSourceEnabled,
    loading: activity.loading,
    recommendationLoading: recommendation.loading,
    refreshing: activity.refreshing,
    recommendationRefreshing: recommendation.refreshing,
    error: activity.error,
    recommendationError: recommendation.error,
    actionError,
    pendingAction,
    refresh: activity.refresh,
    refreshRecommendations: recommendation.refresh,
    reload: activity.reload,
    reloadRecommendations: recommendation.reload,
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
