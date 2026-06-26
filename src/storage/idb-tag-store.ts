import type { Tag } from '@/types';
import type { CountProgressCallback, TagStore } from '@/api/tag-store';
import { gistTagStore } from '@/sync/gist-tag-store';
import { db } from './db';

/**
 * Local source of truth for the tag/notes layer. Every write updates mtime +
 * marks dirty for syncPush.
 */

const dirty = new Set<string>(); // full_names with unsynced changes
let dirtyMeta = false;

function now(): string {
  return new Date().toISOString();
}

function emptyTag(full_name: string): Tag {
  return {
    full_name,
    tags: [],
    notes: '',
    favorite: false,
    mtime: now(),
  };
}

function touch(full_name: string): string {
  dirty.add(full_name);
  return now();
}

export const idbTagStore: TagStore = {
  async get(full_name) {
    return db.tags.get(full_name);
  },

  async getMeta(name) {
    return db.tagMeta.get(name);
  },

  async listTagMeta() {
    return db.tagMeta.toArray();
  },

  async getMany(full_names) {
    const set = new Set(full_names);
    const out = new Map<string, Tag>();
    // each() is cheaper than N get() calls.
    await db.tags.each((t) => {
      if (set.has(t.full_name)) out.set(t.full_name, t);
    });
    return out;
  },

  async setTags(full_name, tags) {
    const existing = (await db.tags.get(full_name)) ?? emptyTag(full_name);
    await db.tags.put({ ...existing, favorite: existing.favorite ?? false, tags, mtime: touch(full_name) });
    // (Re)typing a previously-deleted (excluded) tag clears its tombstone so auto-assign stops skipping it.
    const newlyAdded = tags.filter((t) => !existing.tags.includes(t));
    for (const name of newlyAdded) {
      const meta = await db.tagMeta.get(name);
      if (meta?.excluded) {
        await db.tagMeta.put({ ...meta, excluded: false, mtime: now() });
      }
    }
  },

  async setNotes(full_name, notes) {
    const existing = (await db.tags.get(full_name)) ?? emptyTag(full_name);
    await db.tags.put({ ...existing, favorite: existing.favorite ?? false, notes, mtime: touch(full_name) });
  },

  async setFavorite(full_name, favorite) {
    const existing = (await db.tags.get(full_name)) ?? emptyTag(full_name);
    await db.tags.put({ ...existing, favorite, mtime: touch(full_name) });
  },

  async upsert(tag) {
    await db.tags.put({ ...tag, favorite: tag.favorite ?? false });
    dirty.add(tag.full_name);
  },

  async upsertMeta(meta) {
    await db.tagMeta.put(meta);
    dirtyMeta = true;
  },

  async deleteTag(name) {
    let removed = 0;
    // Every repo currently carrying this tag — via the *tags multiEntry index.
    const hits = await db.tags.where('tags').equals(name).toArray();
    const ts = now();
    await db.transaction('rw', db.tags, db.tagMeta, async () => {
      for (const t of hits) {
        const next = t.tags.filter((x) => x !== name);
        if (next.length === t.tags.length) continue; // wasn't there (shouldn't happen)
        await db.tags.put({ ...t, tags: next, mtime: touch(t.full_name) });
        removed++;
      }
      // Persist a delete tombstone (not a hard delete) so auto-assign can't resurrect the tag on the next sync; preserve any existing dimension/color.
      const prev = await db.tagMeta.get(name);
      await db.tagMeta.put({
        name,
        dimension: prev?.dimension ?? null,
        color: prev?.color ?? null,
        excluded: true,
        mtime: ts,
      });
    });
    dirtyMeta = true;
    return { removed };
  },

  async listExcluded(): Promise<string[]> {
    const metas = await db.tagMeta.toArray();
    return metas.filter((m) => m.excluded).map((m) => m.name);
  },

  async syncPush(onProgress?: CountProgressCallback) {
    return gistTagStore.push(dirty, dirtyMeta, onProgress);
  },

  async syncPull(onProgress?: CountProgressCallback) {
    const { merged, total, missing } = await gistTagStore.pull(onProgress);
    return { merged, total, missing };
  },
};

/** Internal hooks for the Gist transport to clear the dirty set after a push. */
export function clearDirty(names: Iterable<string>, meta: boolean) {
  for (const n of names) dirty.delete(n);
  if (meta) dirtyMeta = false;
}

export function snapshotDirty(): { names: string[]; meta: boolean } {
  return { names: Array.from(dirty), meta: dirtyMeta };
}
