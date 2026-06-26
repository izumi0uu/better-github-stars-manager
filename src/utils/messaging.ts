/** Typed message bridge between UI surfaces and the background SW; bgCall
 * unwraps the { ok, data | error } envelope. */
import {
  normalizeOnboardingStage,
  stageMarksOnboardingSeen,
} from '@/onboarding/state';
import type { OnboardingStage } from '@/types';

export interface SyncStatus {
  progress: {
    phase: 'idle' | 'full' | 'incremental' | 'rescan' | 'gist';
    done: number;
    total: number | null;
    message: string;
  };
  hasToken: boolean;
  onboardingStage: OnboardingStage;
  /** Whether the first-run onboarding card has been dismissed. */
  seenOnboarding: boolean;
  /** Bitmask of one-time action-button coachmarks shown (bit0=Sync, 1=Push, 2=Pull). */
  seenTooltips: number;
  /** True while the background is still holding an active serialized job. */
  inFlight: boolean;
}

export function mergeProgressStatus(
  current: SyncStatus | null,
  progress: SyncStatus['progress'],
  fallbackHasToken = true,
): SyncStatus {
  const hasToken = current?.hasToken ?? fallbackHasToken;
  const onboardingStage = normalizeOnboardingStage(
    current?.onboardingStage,
    current?.seenOnboarding,
    hasToken,
  );
  return {
    progress,
    hasToken,
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
    seenTooltips: current?.seenTooltips ?? 0,
    inFlight: progress.phase !== 'idle',
  };
}

export function mergeStatusPatch(
  current: SyncStatus | null,
  patch: Partial<SyncStatus>,
  fallbackHasToken = false,
): SyncStatus {
  const base: SyncStatus = current ?? {
    progress: { phase: 'idle', done: 0, total: null, message: '' },
    hasToken: fallbackHasToken,
    onboardingStage: fallbackHasToken ? 'awaiting_sync' : 'needs_token',
    seenOnboarding: false,
    seenTooltips: 0,
    inFlight: false,
  };
  const hasToken = patch.hasToken ?? base.hasToken;
  const onboardingStage = normalizeOnboardingStage(
    patch.onboardingStage ?? base.onboardingStage,
    patch.seenOnboarding ?? base.seenOnboarding,
    hasToken,
  );
  return {
    ...base,
    ...patch,
    hasToken,
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
    progress: patch.progress ?? base.progress,
  };
}

export function mergeStatusSnapshot(current: SyncStatus | null, snapshot: SyncStatus | null): SyncStatus | null {
  if (!snapshot) return current;
  const activeProgress = current?.progress;
  const keepLiveProgress =
    !!activeProgress &&
    !!current?.inFlight &&
    activeProgress.phase !== 'idle' &&
    snapshot.progress.phase === 'idle';
  // Preserve the live progress (and seenOnboarding/seenTooltips) from `current`
  // when the snapshot is idle — a fresh getStatus shouldn't clobber an in-flight phase.
  const merged: SyncStatus = {
    ...snapshot,
    progress: keepLiveProgress ? activeProgress : snapshot.progress,
    onboardingStage: normalizeOnboardingStage(
      snapshot.onboardingStage ?? current?.onboardingStage,
      snapshot.seenOnboarding ?? current?.seenOnboarding,
      snapshot.hasToken ?? current?.hasToken ?? false,
    ),
    seenOnboarding: false,
    seenTooltips: snapshot.seenTooltips ?? current?.seenTooltips ?? 0,
    inFlight: keepLiveProgress ? true : snapshot.inFlight ?? current?.inFlight ?? snapshot.progress.phase !== 'idle',
  };
  merged.seenOnboarding = stageMarksOnboardingSeen(merged.onboardingStage);
  return merged;
}

export async function bgCall<T = unknown>(type: string, extra?: Record<string, unknown>): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ type, ...extra })) as
    | { ok: true; data?: T }
    | { ok: false; error: string };
  if (!res.ok) throw new Error(res.error);
  return (res.data ?? (undefined as unknown)) as T;
}

export function onProgress(cb: (p: SyncStatus['progress']) => void): () => void {
  const listener = (msg: { type?: string; progress?: SyncStatus['progress'] }) => {
    if (msg.type === 'progress' && msg.progress) cb(msg.progress);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
