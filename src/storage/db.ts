import Dexie, { type Table } from 'dexie';
import type { Star, Tag, TagMeta } from '@/types';

/**
 * IndexedDB schema (via Dexie). IDB is the source of truth for stars/tags/tagMeta;
 * chrome.storage.local holds only lightweight config (encrypted token, theme,
 * locale). Indexes back the UI filter/sort paths.
 */
export class StarsDB extends Dexie {
  stars!: Table<Star, string>;
  tags!: Table<Tag, string>;
  tagMeta!: Table<TagMeta, string>;

  constructor() {
    super('better-github-stars-manager');
    this.version(1).stores({
      stars: 'full_name, language, starred_at, pushed_at, tombstone',
      tags: 'full_name, *tags, mtime',
      tagMeta: 'name, dimension, mtime',
    });
    // v2: tagMeta gained an `excluded` (delete-tombstone) field. No index added —
    // excluded names are read via get(name)/toArray(), not queried — so the store
    // declaration is unchanged. Bumping the version ensures the new field is
    // recognized on existing DBs; existing rows simply lack it (read as undefined).
    this.version(2).stores({
      stars: 'full_name, language, starred_at, pushed_at, tombstone',
      tags: 'full_name, *tags, mtime',
      tagMeta: 'name, dimension, mtime',
    });
  }
}

export const db = new StarsDB();

/**
 * Count of live (non-tombstone) stars — used by the UI header.
 * IndexedDB/Dexie index booleans unreliably, so filter in JS (cheap over ~10k rows).
 */
export async function liveStarCount(): Promise<number> {
  let n = 0;
  await db.stars.each((s) => {
    if (!s.tombstone) n++;
  });
  return n;
}
