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
}

export function mergeProgressStatus(
  current: SyncStatus | null,
  progress: SyncStatus['progress'],
  fallbackHasToken = true,
): SyncStatus {
  return {
    progress,
    hasToken: current?.hasToken ?? fallbackHasToken,
  };
}

export function mergeStatusSnapshot(current: SyncStatus | null, snapshot: SyncStatus | null): SyncStatus | null {
  if (!snapshot) return current;
  const activeProgress = current?.progress;
  if (activeProgress && activeProgress.phase !== 'idle' && snapshot.progress.phase === 'idle') {
    return { ...snapshot, progress: activeProgress };
  }
  return snapshot;
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
