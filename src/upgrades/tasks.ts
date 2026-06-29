import { db } from '@/storage/db';
import { normalizeBackfillMap } from './backfill-state';
import type { BackfillId, BackfillMap } from '@/types';

export interface BackfillTaskDef {
  id: BackfillId;
  kind: 'local' | 'lazy_remote' | 'full_sync';
  severity: 'silent' | 'notice' | 'blocking';
  detectNeed: () => Promise<boolean>;
}

async function needsReleaseMetadataBackfill(): Promise<boolean> {
  const firstMissing = await db.stars
    .toCollection()
    .filter((star) => !star.tombstone && star.latest_release_synced_at == null)
    .first();
  return !!firstMissing;
}

export const backfillTasks: Record<BackfillId, BackfillTaskDef> = {
  release_metadata_v1: {
    id: 'release_metadata_v1',
    kind: 'lazy_remote',
    severity: 'notice',
    detectNeed: needsReleaseMetadataBackfill,
  },
};

function pendingState(now: string, current?: BackfillMap[BackfillId]) {
  return {
    status: 'pending' as const,
    queuedAt: current?.queuedAt ?? now,
    lastAttemptAt: current?.lastAttemptAt ?? null,
    completedAt: null,
    error: current?.error ?? null,
  };
}

function doneState(now: string, current?: BackfillMap[BackfillId]) {
  return {
    status: 'done' as const,
    queuedAt: current?.queuedAt ?? now,
    lastAttemptAt: current?.lastAttemptAt ?? null,
    completedAt: current?.completedAt ?? now,
    error: null,
  };
}

/**
 * Reconciles one-shot feature backfills against current local data.
 * Once a backfill is marked done, it stays done — later incremental rows can
 * still lazily hydrate missing metadata, but they should not reopen a
 * post-update migration card.
 */
export async function reconcileBackfillMap(
  input: BackfillMap | null | undefined,
  options: { keepRunning?: boolean } = {},
): Promise<BackfillMap> {
  const current = normalizeBackfillMap(input);
  const next = normalizeBackfillMap(input);
  const now = new Date().toISOString();

  for (const [id, task] of Object.entries(backfillTasks) as [BackfillId, BackfillTaskDef][]) {
    const existing = current[id];
    const needs = await task.detectNeed();
    if (existing?.status === 'done') {
      next[id] = doneState(existing.completedAt ?? now, existing);
      continue;
    }
    if (!needs) {
      next[id] = doneState(now, existing);
      continue;
    }
    if (existing?.status === 'running' && options.keepRunning) {
      next[id] = existing;
      continue;
    }
    if (existing?.status === 'failed' || existing?.status === 'deferred') {
      next[id] = existing;
      continue;
    }
    next[id] = pendingState(now, existing);
  }

  return next;
}
