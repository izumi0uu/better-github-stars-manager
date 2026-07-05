import { useEffect, useRef, useState } from 'react';
import type { BackfillId } from '@/types';
import { isOnboardingCardStage, resolveOnboardingStageAfterSync, shouldTrackOnboardingSync } from '@/onboarding/state';
import { pickInitialSyncAction } from '@/ui/initial-sync';
import { ACTION_SUCCESS_FEEDBACK_MS } from '@/ui/ui-feedback-constants';
import { bgCall, mergeProgressStatus, mergeStatusPatch, mergeStatusSnapshot, onProgress, type SyncStatus } from '@/utils/messaging';

function emptyFilter() {
  return {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
  };
}

export function useManagerSyncActions({ refreshStars }: { refreshStars: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [successAction, setSuccessAction] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = async () => {
    const next = await bgCall<SyncStatus>('getStatus').catch(() => null);
    setStatus((current) => mergeStatusSnapshot(current, next));
    return next;
  };

  const setOnboardingStage = async (stage: SyncStatus['onboardingStage']) => {
    setStatus((cur) => mergeStatusPatch(cur, { onboardingStage: stage }));
    await bgCall('setOnboardingStage', { stage }).catch(() => {});
  };

  const finalizeOnboardingAfterSync = async (hasToken: boolean) => {
    const q = await bgCall<{ grandTotal: number }>('query', {
      params: { filter: emptyFilter(), offset: 0, limit: 1 },
    }).catch(() => null);
    if (!q) return;
    await setOnboardingStage(resolveOnboardingStageAfterSync(hasToken, q.grandTotal));
  };

  const flashSuccess = (type: string) => {
    if (successTimer.current) clearTimeout(successTimer.current);
    setSuccessAction(type);
    successTimer.current = setTimeout(() => setSuccessAction(null), ACTION_SUCCESS_FEEDBACK_MS);
  };

  const doSync = async (type: string, label: string) => {
    setBusy(true);
    setPendingAction(type);
    setSuccessAction(null);
    setInfo(null);
    const tracksOnboarding =
      (type === 'syncIncremental' || type === 'syncFull') &&
      !!status &&
      shouldTrackOnboardingSync(status.onboardingStage);
    try {
      if (tracksOnboarding) await setOnboardingStage('syncing');
      const result = await bgCall<{ missing?: boolean }>(type);
      refreshStars();
      await refreshStatus();
      if (tracksOnboarding) await finalizeOnboardingAfterSync(!!status?.hasToken);
      if (type === 'gistPull' && result?.missing) {
        setInfo('Gist not found yet. Push once from your primary browser first.');
      } else {
        flashSuccess(type);
      }
    } catch (e) {
      if (tracksOnboarding) await setOnboardingStage('sync_failed');
      setInfo(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setPendingAction((cur) => (cur === type ? null : cur));
    }
  };

  const runBackfill = async (id: BackfillId) => {
    setBusy(true);
    setPendingAction(`backfill:${id}`);
    setSuccessAction(null);
    setInfo(null);
    try {
      await bgCall('runBackfill', { id });
      refreshStars();
      await refreshStatus();
      flashSuccess(`backfill:${id}`);
    } catch (e) {
      await refreshStatus();
      setInfo(`Sync repository metadata: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setPendingAction((cur) => (cur === `backfill:${id}` ? null : cur));
    }
  };

  const deferBackfill = async (id: BackfillId) => {
    await bgCall('deferBackfill', { id }).catch(() => {});
    await refreshStatus();
  };

  useEffect(() => {
    let off = () => {};
    (async () => {
      off = onProgress((progress) => setStatus((current) => mergeProgressStatus(current, progress)));
      const st = await refreshStatus();
      setStatusLoaded(true);
      if (!st?.hasToken) return;
      const q = await bgCall<{ grandTotal: number }>('query', {
        params: { filter: emptyFilter(), offset: 0, limit: 1 },
      }).catch(() => null);
      const syncType = pickInitialSyncAction(st, q?.grandTotal ?? 0);
      if (!syncType) return;
      const tracksOnboarding = shouldTrackOnboardingSync(st.onboardingStage);
      setPendingAction(syncType);
      if (tracksOnboarding) await setOnboardingStage('syncing');
      bgCall(syncType)
        .then(async () => {
          refreshStars();
          await refreshStatus();
          if (tracksOnboarding) await finalizeOnboardingAfterSync(true);
        })
        .catch(async (e) => {
          await refreshStatus();
          if (tracksOnboarding) await setOnboardingStage('sync_failed');
          setInfo(`${syncType}: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => setPendingAction((cur) => (cur === syncType ? null : cur)));
    })().finally(() => setStatusLoaded(true));
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);

  const progressActive = !!status?.inFlight && status.progress.phase !== 'idle';
  const syncingNow = !!pendingAction || progressActive;
  useEffect(() => {
    if (!statusLoaded || !status) return;
    if (status.onboardingStage !== 'syncing' || syncingNow) return;
    void finalizeOnboardingAfterSync(status.hasToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusLoaded, status?.onboardingStage, status?.hasToken, syncingNow]);

  return {
    status,
    setStatus,
    statusLoaded,
    busy,
    pendingAction,
    successAction,
    info,
    setInfo,
    refreshStatus,
    setOnboardingStage,
    finalizeOnboardingAfterSync,
    doSync,
    runBackfill,
    deferBackfill,
    flashSuccess,
    isOnboardingCardStage,
  };
}
