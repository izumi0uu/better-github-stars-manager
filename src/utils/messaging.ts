/**
 * Typed message bridge between UI surfaces (popup/options/content) and the
 * background service worker, which owns sync orchestration AND the IDB.
 *
 * bgCall sends an arbitrary message object (must include a `type` field the
 * background switches on) and unwraps the { ok, data | error } envelope.
 */
export interface SyncStatus {
  progress: {
    phase: 'idle' | 'full' | 'incremental' | 'rescan' | 'gist';
    done: number;
    total: number | null;
    message: string;
  };
  hasToken: boolean;
  /** Whether the first-run onboarding card has been dismissed. */
  seenOnboarding: boolean;
  /** Bitmask of one-time action-button coachmarks shown (bit0=Sync, 1=Push, 2=Pull). */
  seenTooltips: number;
}

export function mergeProgressStatus(
  current: SyncStatus | null,
  progress: SyncStatus['progress'],
  fallbackHasToken = true,
): SyncStatus {
  return {
    progress,
    hasToken: current?.hasToken ?? fallbackHasToken,
    seenOnboarding: current?.seenOnboarding ?? false,
    seenTooltips: current?.seenTooltips ?? 0,
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
    seenOnboarding: false,
    seenTooltips: 0,
  };
  return {
    ...base,
    ...patch,
    progress: patch.progress ?? base.progress,
  };
}

export function mergeStatusSnapshot(current: SyncStatus | null, snapshot: SyncStatus | null): SyncStatus | null {
  if (!snapshot) return current;
  const activeProgress = current?.progress;
  // Preserve the live progress (and seenOnboarding/seenTooltips) from `current`
  // when the snapshot is idle — a fresh getStatus shouldn't clobber an in-flight phase.
  const merged: SyncStatus = {
    ...snapshot,
    progress: activeProgress && activeProgress.phase !== 'idle' && snapshot.progress.phase === 'idle' ? activeProgress : snapshot.progress,
    seenOnboarding: snapshot.seenOnboarding ?? current?.seenOnboarding ?? false,
    seenTooltips: snapshot.seenTooltips ?? current?.seenTooltips ?? 0,
  };
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
