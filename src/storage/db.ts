import Dexie, { type Table } from 'dexie';
import type { Star, Tag, TagMeta } from '@/types';

/**
 * IndexedDB schema (via Dexie).
 *
 * IndexedDB is the source of truth for the heavier GitHub metadata (`stars`) and
 * the user's annotation layer (`tags` / `tagMeta`). `chrome.storage.local` holds
 * only lighter config such as the encrypted token and sync cursors.
 *
 * Index choices follow the UI's filter and sort paths:
 *  - `language`: filter by language
 *  - `starred_at`: incremental cursor + "recently starred" sort
 *  - `pushed_at`: "recently updated" sort
 *  - `tombstone`: hide/gray unstarred rows
 *  - `*tags`: multi-entry index for "show all repos with tag X"
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
