import type { Tag, TagMeta } from '@/types';

export type CountProgressCallback = (done: number, total: number | null) => void;

/**
 * Abstraction over the user's annotation layer (tags + notes + favorites + tag metadata).
 *
 * The UI depends on this interface rather than a specific backend. The current
 * implementation composes:
 *   - `IDBTagStore`: local source of truth in IndexedDB
 *   - `GistTagStore`: cross-device transport with timestamp-based conflict resolution
 *
 * The interface intentionally omits any GitHub-native Lists sync so the current
 * contract stays focused on local storage plus Gist transport.
 */
export interface TagStore {
  // --- reads ---
  get(full_name: string): Promise<Tag | undefined>;
  getMeta(name: string): Promise<TagMeta | undefined>;
  /** All tag names with their dimension + repo counts, for the left sidebar tree. */
  listTagMeta(): Promise<TagMeta[]>;
  /** All tags for a set of repos, batched (avoids N queries when rendering rows). */
  getMany(full_names: string[]): Promise<Map<string, Tag>>;
  /** Tag names currently tombstoned by delete (excluded). Auto-assign skips these. */
  listExcluded(): Promise<string[]>;

  // --- writes (local; mark dirty for Gist sync) ---
  setTags(full_name: string, tags: string[]): Promise<void>;
  setNotes(full_name: string, notes: string): Promise<void>;
  setFavorite(full_name: string, favorite: boolean): Promise<void>;
  /** Upsert a full Tag record (used by Gist merge-in). */
  upsert(tag: Tag): Promise<void>;
  upsertMeta(meta: TagMeta): Promise<void>;
  /**
   * Remove a tag name from every repo that has it. Returns how many repos
   * were touched (all marked dirty for Gist sync). Leaves a tombstone
   * (tagMeta.excluded) so auto-assign can't resurrect the tag; only a manual
   * re-add (setTags) clears it. Used by the sidebar's per-tag delete button.
   */
  deleteTag(name: string): Promise<{ removed: number }>;

  // --- Gist sync (per-repo mtime LWW merge) ---
  /** Push local dirty tags/tagMeta to the Gist. */
  syncPush(onProgress?: CountProgressCallback): Promise<{ pushed: number; snapshot: number; recreated: boolean }>;
  /** Pull the Gist and merge per-repo by mtime into local IDB. */
  syncPull(onProgress?: CountProgressCallback): Promise<{ merged: number; total: number; missing: boolean }>;
}
