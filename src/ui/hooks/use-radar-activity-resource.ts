import { useCallback, useEffect, useRef, useState } from 'react';
import { useManagerRuntime } from '@/ui/manager-runtime-context';
import type { RadarQueryResponse } from '@/radar/radar-contract';

export function useRadarActivityResource(active: boolean) {
  const runtime = useManagerRuntime();
  const [result, setResult] = useState<RadarQueryResponse | null>(null);
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [fullReconciling, setFullReconciling] = useState(false);
  const [error, setError] = useState<'query' | 'refresh' | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadedRef = useRef(false);
  const generation = useRef(0);
  const refreshingRef = useRef(false);
  const refreshEpoch = useRef(0);
  const entryRefreshEvaluatedRef = useRef(false);
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
      refreshEpoch.current += 1;
    };
  }, []);

  const reload = useCallback(async (silent = false) => {
    if (!mountedRef.current || !activeRef.current) return;
    const requestGeneration = ++generation.current;
    if (!silent) {
      setLoading(true);
      setResult(null);
    }
    try {
      const next = await runtime.queryRadar();
      if (
        !mountedRef.current
        || !activeRef.current
        || generation.current !== requestGeneration
      ) return;
      setResult(next);
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
      refreshEpoch.current += 1;
      refreshingRef.current = false;
      setLoading(false);
      setRefreshing(false);
      setFullReconciling(false);
      return;
    }
    void reload(loadedRef.current);
  }, [active, reload]);

  const invalidateCredentials = useCallback(() => {
    generation.current += 1;
    refreshEpoch.current += 1;
    refreshingRef.current = false;
    loadedRef.current = false;
    entryRefreshEvaluatedRef.current = false;
    setResult(null);
    setError(null);
    setLoading(activeRef.current);
    setRefreshing(false);
    setFullReconciling(false);
  }, []);

  const cooldownUntil = result?.status.snapshotStatus === 'cooldown'
    ? result.status.state?.nextAllowedAt ?? null
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

  const runRefresh = useCallback(async (mode: 'incremental' | 'full') => {
    if (!mountedRef.current || refreshingRef.current) return;
    const requestEpoch = refreshEpoch.current;
    const isCurrent = () => mountedRef.current && activeRef.current
      && refreshEpoch.current === requestEpoch;
    refreshingRef.current = true;
    entryRefreshEvaluatedRef.current = true;
    setRefreshing(true);
    setFullReconciling(mode === 'full');
    setError(null);
    try {
      const refreshResult = mode === 'full'
        ? await runtime.fullReconcileRadar()
        : await runtime.refreshRadar();
      if (!isCurrent()) return;
      await reload(true);
      if (!isCurrent()) return;
      if (!refreshResult.published && refreshResult.status.errorCode) setError('refresh');
    } catch {
      if (!isCurrent()) return;
      await reload(true);
      if (isCurrent()) setError('refresh');
    } finally {
      if (isCurrent()) {
        refreshingRef.current = false;
        setRefreshing(false);
        setFullReconciling(false);
      }
    }
  }, [reload, runtime]);

  // The background coordinator already resumes a saved checkpoint before its
  // normal plan, so ordinary refresh stays incremental and Resume full sync
  // remains the only explicit full-scan entry point.
  const refresh = useCallback(() => runRefresh('incremental'), [runRefresh]);

  const fullReconcile = useCallback(() => runRefresh('full'), [runRefresh]);

  useEffect(() => {
    const status = result?.status;
    if (!active || !status || entryRefreshEvaluatedRef.current) return;
    entryRefreshEvaluatedRef.current = true;
    if (
      status.refreshing
      || !status.hasMainToken
      || (
        status.snapshotStatus !== 'never_loaded'
        && status.snapshotStatus !== 'stale'
        && status.snapshotStatus !== 'error'
      )
    ) return;
    void refresh();
  }, [active, refresh, result]);

  const markSeen = useCallback((activityIds: readonly string[]) => {
    const ids = [...new Set(activityIds)];
    if (!mountedRef.current || ids.length === 0) return;
    const idSet = new Set(ids);
    const seenAt = new Date(runtime.now()).toISOString();
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
    void runtime.markRadarActivitiesSeen(ids)
      .then(() => reload(true), () => reload(true));
  }, [reload, runtime]);

  // A step this page did not start still belongs to a full epoch: a checkpoint
  // exists only while one is unfinished, and the coordinator resumes it before
  // any incremental plan. Deriving busy state here keeps the ribbon and the
  // command bar attributing background work to Full sync.
  const backgroundEpochRunning = result?.status.refreshing === true
    && result.status.reconciliation != null;
  return {
    result,
    loading,
    refreshing: refreshing || result?.status.refreshing === true,
    fullReconciling: fullReconciling || backgroundEpochRunning,
    error,
    refresh,
    fullReconcile,
    reload,
    invalidateCredentials,
    markSeen,
  };
}
