import type { BackfillId, BackfillMap, BackfillState, BackfillStatus } from '@/types';

export const BACKFILL_IDS: BackfillId[] = ['repo_data_sync', 'repo_owner_avatar'];

const BACKFILL_STATUSES: readonly BackfillStatus[] = ['pending', 'running', 'done', 'failed', 'deferred'];

const LEGACY_BACKFILL_IDS = {
  repo_data_sync: 'repo_data_sync_v1',
  repo_owner_avatar: 'repo_owner_avatar_v1',
} as const satisfies Record<BackfillId, string>;

export function normalizeBackfillState(input: BackfillState | null | undefined): BackfillState {
  return {
    status: typeof input?.status === 'string' && BACKFILL_STATUSES.includes(input.status as BackfillStatus)
      ? input.status as BackfillStatus
      : 'pending',
    queuedAt: input?.queuedAt ?? null,
    lastAttemptAt: input?.lastAttemptAt ?? null,
    completedAt: input?.completedAt ?? null,
    error: input?.error ?? null,
  };
}

export function normalizeBackfillMap(input: BackfillMap | null | undefined): BackfillMap {
  const out: BackfillMap = {};
  for (const id of BACKFILL_IDS) {
    const next = input?.[id] ?? (input as Record<string, BackfillState | undefined> | null | undefined)?.[
      LEGACY_BACKFILL_IDS[id]
    ];
    if (!next) continue;
    out[id] = normalizeBackfillState(next);
  }
  return out;
}

export function selectActiveBackfillId(backfills: BackfillMap | null | undefined): BackfillId | null {
  const normalized = normalizeBackfillMap(backfills);
  for (const id of BACKFILL_IDS) {
    const status = normalized[id]?.status;
    if (status === 'running' || status === 'failed' || status === 'pending') return id;
  }
  return null;
}
