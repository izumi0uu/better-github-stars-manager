import type { SyncProgress } from '@/types';

/** Runtime-neutral sync values shared by the extension toolbar and Demo previews. */
export type SyncProgressPresentation = Readonly<{
  active: boolean;
  percent: number | null;
  count: string | null;
}>;

export function presentSyncProgress(progress: SyncProgress, inFlight: boolean): SyncProgressPresentation {
  const active = inFlight && progress.phase !== 'idle';
  return {
    active,
    percent: active && progress.total
      ? Math.max(1, Math.min(100, Math.round((progress.done / progress.total) * 100)))
      : null,
    count: active && progress.total ? `${progress.done}/${progress.total}` : null,
  };
}

export type GistAction = 'gistPush' | 'gistPull';
export type GistActionDirection = 'push' | 'pull';
export type GistActionPhase = 'idle' | 'pending' | 'success';

/**
 * Presentation-only status for the two toolbar Gist actions. It intentionally
 * carries no Gist identity, transport, credential, or remote result.
 */
export type GistActionPresentation = Readonly<{
  action: GistAction;
  direction: GistActionDirection;
  phase: GistActionPhase;
}>;

export function presentGistAction(
  direction: GistActionDirection,
  pendingAction: string | null,
  successAction: string | null,
): GistActionPresentation {
  const action: GistAction = direction === 'push' ? 'gistPush' : 'gistPull';
  return {
    action,
    direction,
    phase: pendingAction === action ? 'pending' : successAction === action ? 'success' : 'idle',
  };
}
