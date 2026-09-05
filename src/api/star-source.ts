import type { Star, SyncProgress } from '@/types';
import type { GitHubCredentialSnapshot } from '@/auth/auth-store';

export type StarSyncOptions = Readonly<{ credential?: GitHubCredentialSnapshot }>;

/**
 * Abstraction over where starred repos come from, so storage/query surfaces
 * stay unchanged if the source changes. Current impl is `GitHubStarSource`
 * (authenticated `GET /user/starred`).
 */
export interface StarSource {
  /** Full pull: sync starred repos; owned-public rows are included by default unless excluded via includeOwnedPublic: false. */
  syncFull(
    onProgress?: (p: SyncProgress) => void,
    options?: StarSyncOptions & Readonly<{ includeOwnedPublic?: boolean }>,
  ): Promise<{ added: number; updated: number }>;

  /** Fetch and persist owned public repositories for background Stars hydration. */
  syncOwnedPublicRepositories(options?: StarSyncOptions): Promise<{ added: number; updated: number }>;

  /** Incremental: pull newest starred repositories to the cursor. */
  syncIncremental(options?: StarSyncOptions): Promise<{ added: number }>;

  /** Rescan: re-pull everything; tombstone local repos absent from the API (soft delete, tags/notes preserved). */
  syncRescan(onProgress?: (p: SyncProgress) => void, options?: StarSyncOptions): Promise<{ tombstoned: number; revived: number }>;

  /** Remote unstar: DELETE the GitHub star, then callers may tombstone local annotations-preserving rows. */
  unstar(fullName: string): Promise<void>;
  /** Remote star followed by a canonical local metadata row for annotations. */
  star(fullName: string): Promise<Star>;

  /** GitHub username backing this source (from the token's /user). */
  getUsername(): Promise<string>;
}
