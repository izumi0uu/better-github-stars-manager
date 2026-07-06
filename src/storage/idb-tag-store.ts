import type { Tag } from '@/types';
import type { CountProgressCallback, TagStore } from '@/api/tag-store';
import { gistTagStore } from '@/sync/gist-tag-store';
import { db } from './db';

/**
 * Local source of truth for the tag/notes layer. Every write updates mtime +
 * marks dirty for syncPush.
 */

const dirty = new Set<string>(); // full_names with unsynced changes
const dirtyVersions = new Map<string, number>();
let dirtyMeta = false;
let dirtyMetaVersion = 0;
let dirtyVersion = 0;

export type DirtySnapshot = {
  names: Array<{ name: string; version: number }>;
  meta: boolean;
  metaVersion: number;
};

function now(): string {
  return new Date().toISOString();
}

function markDirty(full_name: string): void {
  dirty.add(full_name);
  dirtyVersions.set(full_name, ++dirtyVersion);
}

function markMetaDirty(): void {
  dirtyMeta = true;
  dirtyMetaVersion++;
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
  markDirty(full_name);
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
        markMetaDirty();
      }
    }
  },

  async setTagsBulk(updates) {
    const touchedNames: string[] = [];
    let clearedExcluded = false;
    const ts = now();

    await db.transaction('rw', db.tags, db.tagMeta, async () => {
      for (const update of updates) {
        const existing = (await db.tags.get(update.full_name)) ?? emptyTag(update.full_name);
        const existingTags = existing.tags ?? [];
        if (existingTags.length === update.tags.length && existingTags.every((tag, i) => tag === update.tags[i])) {
          continue;
        }

        await db.tags.put({
          ...existing,
          favorite: existing.favorite ?? false,
          tags: update.tags,
          mtime: ts,
        });
        touchedNames.push(update.full_name);

        const newlyAdded = update.tags.filter((tag) => !existingTags.includes(tag));
        for (const name of newlyAdded) {
          const meta = await db.tagMeta.get(name);
          if (meta?.excluded) {
            await db.tagMeta.put({ ...meta, excluded: false, mtime: ts });
            clearedExcluded = true;
          }
        }
      }
    });

    for (const fullName of touchedNames) markDirty(fullName);
    if (clearedExcluded) markMetaDirty();
    return { updated: touchedNames.length };
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
    markDirty(tag.full_name);
  },

  async upsertMeta(meta) {
    await db.tagMeta.put(meta);
    markMetaDirty();
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
    markMetaDirty();
    return { removed };
  },

  async deleteAllTags() {
    const touchedNames: string[] = [];
    const removedNames = new Set<string>();
    let assignmentsRemoved = 0;
    const ts = now();

    await db.transaction('rw', db.tags, async () => {
      const rows = await db.tags.toArray();
      for (const tag of rows) {
        if (tag.tags.length === 0) continue;
        assignmentsRemoved += tag.tags.length;
        touchedNames.push(tag.full_name);
        for (const name of tag.tags) removedNames.add(name);
        await db.tags.put({ ...tag, tags: [], favorite: tag.favorite ?? false, mtime: ts });
      }
    });

    for (const fullName of touchedNames) markDirty(fullName);
    return {
      assignmentsRemoved,
      distinctTagsRemoved: removedNames.size,
    };
  },

  async listExcluded(): Promise<string[]> {
    const metas = await db.tagMeta.toArray();
    return metas.filter((m) => m.excluded).map((m) => m.name);
  },

  async syncPush(onProgress?: CountProgressCallback) {
    const dirtySnapshot = snapshotDirtyForPush();
    return gistTagStore.push(new Set(), false, onProgress, dirtySnapshot);
  },

  async syncPull(onProgress?: CountProgressCallback) {
    const { merged, total, missing } = await gistTagStore.pull(onProgress);
    return { merged, total, missing };
  },
};

/** Internal hooks for the Gist transport to clear only the dirty versions it pushed. */
export function clearDirty(snapshot: DirtySnapshot): void;
export function clearDirty(names: Iterable<string>, meta: boolean): void;
export function clearDirty(namesOrSnapshot: DirtySnapshot | Iterable<string>, meta = false) {
  if (typeof namesOrSnapshot === 'object' && 'names' in namesOrSnapshot) {
    for (const { name, version } of namesOrSnapshot.names) {
      if (dirtyVersions.get(name) === version) {
        dirty.delete(name);
        dirtyVersions.delete(name);
      }
    }
    if (namesOrSnapshot.meta && dirtyMetaVersion === namesOrSnapshot.metaVersion) dirtyMeta = false;
    return;
  }

  for (const name of namesOrSnapshot) {
    dirty.delete(name);
    dirtyVersions.delete(name);
  }
  if (meta) dirtyMeta = false;
}

export function snapshotDirty(): { names: string[]; meta: boolean } {
  return { names: Array.from(dirty), meta: dirtyMeta };
}

export function snapshotDirtyForPush(): DirtySnapshot {
  return {
    names: Array.from(dirty, (name) => ({ name, version: dirtyVersions.get(name) ?? 0 })),
    meta: dirtyMeta,
    metaVersion: dirtyMetaVersion,
  };
}

export function resetDirtyForDev() {
  dirty.clear();
  dirtyVersions.clear();
  dirtyMeta = false;
  dirtyMetaVersion = 0;
  dirtyVersion = 0;
}
