import type { SyncProgress } from '@/types';

/**
 * Throttles progress writes: phase, message, and total changes always persist,
 * and in-phase progress persists at most every 4% so a long sync does not turn
 * into a storage write per repository.
 */
export function shouldPersistProgress(
  prev: SyncProgress,
  next: SyncProgress,
): boolean {
  if (prev.phase !== next.phase) return true;
  if (prev.message !== next.message) return true;
  if (prev.total !== next.total) return true;
  if (next.phase === "idle") return true;
  if (next.total == null) return next.done !== prev.done;
  const step = Math.max(1, Math.ceil(next.total / 25));
  return (
    next.done === 0 || next.done === next.total || next.done - prev.done >= step
  );
}
