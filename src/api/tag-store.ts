import type { Tag, TagMeta } from '@/types';

export type CountProgressCallback = (done: number, total: number | null) => void;

/**
 * TagStore — abstraction over the user's annotation layer (tags + notes + tagMeta).
 *
 * Q2 decision: UI depends only on this interface. The MVP composes two concrete
 * implementations:
 *   - IDBTagStore (src/storage/idb-tag-store.ts): local source of truth (IndexedDB)
 *   - GistTagStore (src/sync/gist-tag-store.ts): cross-device transport, per-repo
 *     field-level LWW merge (Q5 C2).
 *
 * Phase 2 evolution slot: a future implementation may add syncToGitHubLists() here
 * once the GitHub-native Lists reverse-engineering/DOM-automation work is done
 * (blueprint: partial feasibility, ToS medium, deferred). For now this method is
 * intentionally absent from the interface to keep the MVP contract clean.
 */
export interface TagStore {
  // --- reads ---
  get(full_name: string): Promise<Tag | undefined>;
  getMeta(name: string): Promise<TagMeta | undefined>;
  /** All tag names with their dimension + repo counts, for the left sidebar tree. */
  listTagMeta(): Promise<TagMeta[]>;
  /** All tags for a set of repos, batched (avoids N queries when rendering rows). */
  getMany(full_names: string[]): Promise<Map<string, Tag>>;

  // --- writes (local; mark dirty for Gist sync) ---
  setTags(full_name: string, tags: string[]): Promise<void>;
  setNotes(full_name: string, notes: string): Promise<void>;
  /** Upsert a full Tag record (used by Gist merge-in). */
  upsert(tag: Tag): Promise<void>;
  upsertMeta(meta: TagMeta): Promise<void>;

  // --- Gist sync (Q5 C2 per-repo LWW) ---
  /** Push local dirty tags/tagMeta to the Gist. */
  syncPush(onProgress?: CountProgressCallback): Promise<{ pushed: number; snapshot: number }>;
  /** Pull the Gist and merge per-repo by mtime into local IDB. */
  syncPull(onProgress?: CountProgressCallback): Promise<{ merged: number; total: number }>;
}
