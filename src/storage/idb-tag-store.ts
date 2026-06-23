import type { Tag } from '@/types';
import type { CountProgressCallback, TagStore } from '@/api/tag-store';
import { gistTagStore } from '@/sync/gist-tag-store';
import { db } from './db';

/**
 * IDBTagStore — local source of truth for the tag/notes layer (Q3).
 *
 * Every write updates mtime (the LWW arbitration key for Gist sync) and marks the
 * repo dirty so syncPush knows what to send. We track dirtiness with a lightweight
 * in-memory Set (persisted to chrome.storage would be overkill; if the SW dies we
 * just re-push the whole Gist, which is cheap at ~600KB).
 */

const dirty = new Set<string>(); // full_names with unsynced changes
let dirtyMeta = false;

function now(): string {
  return new Date().toISOString();
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
    const existing = (await db.tags.get(full_name)) ?? {
      full_name,
      tags: [],
      notes: '',
      mtime: now(),
    };
    await db.tags.put({ ...existing, tags, mtime: touch(full_name) });
  },

  async setNotes(full_name, notes) {
    const existing = (await db.tags.get(full_name)) ?? {
      full_name,
      tags: [],
      notes: '',
      mtime: now(),
    };
    await db.tags.put({ ...existing, notes, mtime: touch(full_name) });
  },

  async upsert(tag) {
    await db.tags.put(tag);
    dirty.add(tag.full_name);
  },

  async upsertMeta(meta) {
    await db.tagMeta.put(meta);
    dirtyMeta = true;
  },

  async syncPush(onProgress?: CountProgressCallback) {
    return gistTagStore.push(dirty, dirtyMeta, onProgress);
  },

  async syncPull(onProgress?: CountProgressCallback) {
    const { merged, total } = await gistTagStore.pull(onProgress);
    // After a pull, clear local dirtiness for anything we just reconciled.
    // (Conservative: a real CRDT would diff; LWW post-pull we assume remote is merged.)
    return { merged, total };
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
