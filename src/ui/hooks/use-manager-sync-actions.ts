import { useEffect, useRef, useState } from 'react';
import { GITHUB_CREDENTIALS_STORAGE_KEY } from '@/auth/auth-store';
import type { BackfillId } from '@/types';
import { useI18n } from '@/i18n';
import { isOnboardingCardStage, shouldTrackOnboardingSync } from '@/onboarding/state';
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
    onlyOwned: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
  };
}

function initialSyncLabel(type: 'syncFull' | 'syncIncremental', m: ReturnType<typeof useI18n>['m']) {
  return type === 'syncIncremental' ? m.popup.syncIncremental : m.popup.syncFull;
}

export function useManagerSyncActions({ refreshStars }: { refreshStars: () => void }) {
  const { m } = useI18n();
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
  const applyStatusPatch = (patch: Partial<SyncStatus>) => {
    setStatus((cur) => mergeStatusPatch(cur, patch));
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
      if (type === 'gistPull' && result?.missing) {
        setInfo(m.background.gistPullMissing);
      } else {
        flashSuccess(type);
      }
    } catch (e) {
      if (tracksOnboarding) await setOnboardingStage('sync_failed');
      setInfo(m.manager.syncFailed(label, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingAction((cur) => (cur === type ? null : cur));
    }
  };

  const autoAssignTags = async (): Promise<{ tagged: number; remainingUntagged: number } | null> => {
    setBusy(true);
    setPendingAction('autoAssignTags');
    setSuccessAction(null);
    setInfo(null);
    try {
      const result = await bgCall<{ tagged: number; remainingUntagged: number }>('autoAssignTags');
      refreshStars();
      await refreshStatus();
      flashSuccess('autoAssignTags');
      return result ?? null;
    } catch (e) {
      setInfo(m.manager.autoAssignFailed(e instanceof Error ? e.message : String(e)));
      return null;
    } finally {
      setBusy(false);
      setPendingAction((cur) => (cur === 'autoAssignTags' ? null : cur));
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
      setInfo(m.manager.syncFailed(m.manager.backfillSyncAction, e instanceof Error ? e.message : String(e)));
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
      const syncLabel = initialSyncLabel(syncType, m);
      const tracksOnboarding = shouldTrackOnboardingSync(st.onboardingStage);
      setPendingAction(syncType);
      if (tracksOnboarding) await setOnboardingStage('syncing');
      bgCall(syncType)
        .then(async () => {
          refreshStars();
          await refreshStatus();
        })
        .catch(async (e) => {
          await refreshStatus();
          if (tracksOnboarding) await setOnboardingStage('sync_failed');
          setInfo(m.manager.syncFailed(syncLabel, e instanceof Error ? e.message : String(e)));
        })
        .finally(() => setPendingAction((cur) => (cur === syncType ? null : cur)));
    })().finally(() => setStatusLoaded(true));
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onChanged = chrome.storage?.onChanged;
    if (!onChanged) return;
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[GITHUB_CREDENTIALS_STORAGE_KEY]) return;
      void refreshStatus();
    };
    onChanged.addListener(listener);
    return () => onChanged.removeListener(listener);
    // Credential changes refresh presentation only; initial-sync selection is
    // intentionally owned by the mount effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);


  return {
    status,
    statusLoaded,
    busy,
    pendingAction,
    successAction,
    info,
    setInfo,
    refreshStatus,
    applyStatusPatch,
    setOnboardingStage,
    doSync,
    autoAssignTags,
    runBackfill,
    deferBackfill,
    isOnboardingCardStage,
  };
}
