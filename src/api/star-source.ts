import type { SyncProgress } from '@/types';

/**
 * Abstraction over where starred repos come from.
 *
 * The UI depends on this interface rather than a concrete backend, so the
 * storage/query surfaces stay unchanged if the source changes later. The current
 * implementation is `GitHubStarSource`, which calls the authenticated
 * `GET /user/starred` endpoint.
 */
export interface StarSource {
  /**
   * First-time (or forced) full pull of all starred repos.
   * ~99 pages for a 9900-star account, batched concurrently within the 5000/h limit.
   * Upserts every repo into the stars store. Does NOT detect unstars (use rescan).
   */
  syncFull(onProgress?: (p: SyncProgress) => void): Promise<{ added: number; updated: number }>;

  /**
   * Incremental sync: pull newest starred repos in `starred_at` descending order
   * and stop at the first repo already covered by `lastSyncStarredAt`.
   * Typically 1–2 requests. Triggered on entering the stars page.
   */
  syncIncremental(): Promise<{ added: number }>;

  /**
   * Full rescan: re-pull everything to detect unstars.
   * Any repo present locally but absent from the API → mark tombstone=true (soft
   * delete; tags/notes preserved for re-star revival). Manual, low-frequency.
   */
  syncRescan(onProgress?: (p: SyncProgress) => void): Promise<{ tombstoned: number; revived: number }>;

  /** GitHub username backing this source (from the token's /user). */
  getUsername(): Promise<string>;
}
