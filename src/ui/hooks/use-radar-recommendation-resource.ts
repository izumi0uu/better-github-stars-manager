import { useCallback, useEffect, useRef, useState } from 'react';
import { useManagerRuntime } from '@/ui/manager-runtime-context';
import type { RecommendationQueryResponse } from '@/recommendations/recommendation-model';

export function useRadarRecommendationResource(active: boolean) {
  const runtime = useManagerRuntime();
  const [recommendations, setRecommendations] = useState<RecommendationQueryResponse | null>(null);
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<'query' | 'refresh' | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadedRef = useRef(false);
  const generation = useRef(0);
  const refreshingRef = useRef(false);
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

  const reload = useCallback(async (silent = false) => {
    if (!mountedRef.current || !activeRef.current) return;
    const requestGeneration = ++generation.current;
    if (!silent) {
      setLoading(true);
      setRecommendations(null);
    }
    try {
      const next = await runtime.queryRecommendations();
      if (
        !mountedRef.current
        || !activeRef.current
        || generation.current !== requestGeneration
      ) return;
      setRecommendations(next);
      loadedRef.current = true;
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
    void reload(loadedRef.current);
  }, [active, reload]);

  const invalidateCredentials = useCallback(() => {
    generation.current += 1;
    loadedRef.current = false;
    setRecommendations(null);
    setError(null);
    setLoading(activeRef.current);
  }, []);

  const cooldownUntil = recommendations?.status.snapshotStatus === 'cooldown'
    ? recommendations.status.state?.nextAllowedAt ?? null
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
    if (remaining <= 0 && cooldownProbeRef.current.attempts > 0) return;
    const timer = window.setTimeout(() => {
      cooldownProbeRef.current.attempts += 1;
      setCooldownProbeTick((current) => current + 1);
      void reload(true);
    }, Math.max(0, remaining) + 25);
    return () => window.clearTimeout(timer);
  }, [active, cooldownProbeTick, cooldownUntil, reload, runtime]);

  const refresh = useCallback(async () => {
    if (!mountedRef.current || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const refreshResult = await runtime.refreshRecommendations();
      await reload(true);
      if (mountedRef.current && !refreshResult.published && refreshResult.status.errorCode) {
        setError('refresh');
      }
    } catch {
      await reload(true);
      if (mountedRef.current) setError('refresh');
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, [reload, runtime]);

  return {
    recommendations,
    loading,
    refreshing: refreshing || recommendations?.status.refreshing === true,
    error,
    refresh,
    reload,
    invalidateCredentials,
  };
}
