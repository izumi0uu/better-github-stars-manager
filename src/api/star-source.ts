import type { SyncProgress } from '@/types';

/**
 * Abstraction over where starred repos come from, so storage/query surfaces
 * stay unchanged if the source changes. Current impl is `GitHubStarSource`
 * (authenticated `GET /user/starred`).
 */
export interface StarSource {
  /** Full pull: upsert every repo. Does NOT detect unstars (use rescan). */
  syncFull(onProgress?: (p: SyncProgress) => void): Promise<{ added: number; updated: number }>;

  /** Incremental: pull newest in starred_at-desc order until the lastSyncStarredAt cursor is reached. */
  syncIncremental(): Promise<{ added: number }>;

  /** Rescan: re-pull everything; tombstone local repos absent from the API (soft delete, tags/notes preserved). */
  syncRescan(onProgress?: (p: SyncProgress) => void): Promise<{ tombstoned: number; revived: number }>;

  /** GitHub username backing this source (from the token's /user). */
  getUsername(): Promise<string>;
}
