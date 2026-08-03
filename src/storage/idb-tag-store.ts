import type { Tag, TagDirtyOutboxRecord } from '@/types';
import type { CountProgressCallback, TagStore } from '@/api/tag-store';
import { gistTagStore } from '@/sync/gist-tag-store';
import { db } from './db';
import {
  addTagNames,
  autoTagNames,
  dismissedAutoTagNames,
  includesTagName,
  manualTagNames,
  sameTagNames,
  visibleTagNames,
  withoutTagName,
} from '@/tags/tag-model';
import {
  normalizeStoredTag,
  type LegacyTagRow,
} from './tag-shape';

/**
 * Local source of truth for the tag/notes layer. Every write updates mtime +
 * marks dirty for syncPush.
 */

const dirty = new Set<string>(); // full_names with unsynced changes
const dirtyVersions = new Map<string, number>();
let dirtyMeta = false;
let dirtyMetaVersion = 0;
let dirtyVersion = 0;
const TAG_DIRTY_META_ID = 'meta:*';

export type DirtySnapshot = {
  names: Array<{ name: string; version: number }>;
  meta: boolean;
  metaVersion: number;
};

function now(): string {
  return new Date().toISOString();
}

function newOutboxVersion(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function queueTagDirtyOutbox(fullName: string, updatedAt: string): Promise<void> {
  await db.tagDirtyOutbox.put({
    id: `tag:${fullName}`,
    kind: 'tag',
    key: fullName,
    version: newOutboxVersion(),
    updatedAt,
  });
}

async function queueTagMetaDirtyOutbox(updatedAt: string): Promise<void> {
  await db.tagDirtyOutbox.put({
    id: TAG_DIRTY_META_ID,
    kind: 'meta',
    key: '*',
    version: newOutboxVersion(),
    updatedAt,
  });
}

export async function snapshotTagDirtyOutbox(): Promise<TagDirtyOutboxRecord[]> {
  return db.tagDirtyOutbox.toArray();
}

export async function clearTagDirtyOutbox(
  snapshot: readonly TagDirtyOutboxRecord[],
): Promise<void> {
  if (snapshot.length === 0) return;
  await db.transaction('rw', db.tagDirtyOutbox, async () => {
    for (const row of snapshot) {
      const current = await db.tagDirtyOutbox.get(row.id);
      if (current?.version === row.version) await db.tagDirtyOutbox.delete(row.id);
    }
  });
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
  const ts = now();
  return {
    full_name,
    manualTags: [],
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: ts,
    autoTagsMtime: ts,
    dismissedAutoTagsMtime: ts,
    notes: '',
    favorite: false,
    mtime: ts,
  };
}

async function getNormalized(full_name: string): Promise<Tag | undefined> {
  const row = await db.tags.get(full_name) as LegacyTagRow | undefined;
  return row ? normalizeStoredTag(row) : undefined;
}

function buildManualTagReplacement(existing: Tag, tags: string[]) {
  const existingManualTags = manualTagNames(existing);
  const manualTags = addTagNames([], tags);
  const removedManualTags = existingManualTags.filter((name) => !includesTagName(manualTags, name));
  const existingDismissedAutoTags = dismissedAutoTagNames(existing);
  const dismissedAutoTags = addTagNames(existingDismissedAutoTags, removedManualTags)
    .filter((name) => !includesTagName(manualTags, name));
  return {
    existingManualTags,
    manualTags,
    dismissedAutoTags,
    dismissedAutoTagsChanged: !sameTagNames(existingDismissedAutoTags, dismissedAutoTags),
  };
}

/**
 * Additive agent write: appends manual tags without clearing exclusion tombstones.
 * Model-facing assignment is not a user-owned re-add of a deleted tag.
 */
export type BgsmAgentManualTagAdditionResult = Readonly<{
  manualTags: string[];
  changed: boolean;
  reason: 'missing' | 'tombstoned' | 'excluded_tag' | null;
}>;

export async function addBgsmAgentManualTags(
  full_name: string,
  tags: readonly string[],
): Promise<BgsmAgentManualTagAdditionResult> {
  const additions = addTagNames([], [...tags]);
  if (additions.length === 0) {
    throw new TypeError('Cubby manual-tag additions must include at least one non-empty tag.');
  }

  const result = await db.transaction(
    'rw',
    db.stars,
    db.tags,
    db.tagMeta,
    db.tagDirtyOutbox,
    async () => {
    const star = await db.stars.get(full_name);
    if (!star) {
      return { manualTags: [], changed: false, reason: 'missing' as const };
    }
    if (star.tombstone) {
      return { manualTags: [], changed: false, reason: 'tombstoned' as const };
    }

    const stored = await db.tags.get(full_name) as LegacyTagRow | undefined;
    const existing = stored ? normalizeStoredTag(stored) : emptyTag(full_name);
    const currentManual = manualTagNames(existing);
    const excludedKeys = new Set(
      (await db.tagMeta.toArray())
        .filter((entry) => entry.excluded)
        .map((entry) => entry.name.trim().normalize('NFKC').toLocaleLowerCase('en-US')),
    );
    if (additions.some((tag) => (
      excludedKeys.has(tag.trim().normalize('NFKC').toLocaleLowerCase('en-US'))
    ))) {
      return { manualTags: currentManual, changed: false, reason: 'excluded_tag' as const };
    }

    const nextManual = addTagNames(currentManual, additions);
    if (sameTagNames(currentManual, nextManual)) {
      return { manualTags: currentManual, changed: false, reason: null };
    }

    const ts = now();
    await db.tags.put(normalizeStoredTag({
      ...existing,
      favorite: existing.favorite ?? false,
      manualTags: nextManual,
      manualTagsMtime: ts,
      mtime: ts,
    }));
    await queueTagDirtyOutbox(full_name, ts);
    return { manualTags: nextManual, changed: true, reason: null };
    },
  );

  if (result.changed) markDirty(full_name);
  return Object.freeze({ ...result, manualTags: [...result.manualTags] });
}

export const idbTagStore: TagStore = {
  async get(full_name) {
    return getNormalized(full_name);
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
      if (set.has(t.full_name)) out.set(t.full_name, normalizeStoredTag(t as LegacyTagRow));
    });
    return out;
  },

  async setTags(full_name, tags) {
    const ts = now();
    let clearedExcluded = false;
    await db.transaction('rw', db.tags, db.tagMeta, db.tagDirtyOutbox, async () => {
      const existing = (await getNormalized(full_name)) ?? emptyTag(full_name);
      const replacement = buildManualTagReplacement(existing, tags);
      await db.tags.put(normalizeStoredTag({
        ...existing,
        favorite: existing.favorite ?? false,
        manualTags: replacement.manualTags,
        dismissedAutoTags: replacement.dismissedAutoTags,
        manualTagsMtime: ts,
        dismissedAutoTagsMtime: replacement.dismissedAutoTagsChanged ? ts : existing.dismissedAutoTagsMtime,
        mtime: ts,
      }));
      await queueTagDirtyOutbox(full_name, ts);
      // (Re)typing a previously-deleted global tag is the user-owned path that
      // clears its tombstone. Model-facing organization never takes this path.
      const newlyAdded = replacement.manualTags
        .filter((t) => !includesTagName(replacement.existingManualTags, t));
      for (const name of newlyAdded) {
        const meta = await db.tagMeta.get(name);
        if (meta?.excluded) {
          await db.tagMeta.put({ ...meta, excluded: false, mtime: ts });
          clearedExcluded = true;
        }
      }
      if (clearedExcluded) await queueTagMetaDirtyOutbox(ts);
    });
    markDirty(full_name);
    if (clearedExcluded) markMetaDirty();
  },

  async setTagsBulk(updates) {
    const touchedNames: string[] = [];
    let clearedExcluded = false;
    const ts = now();

    await db.transaction('rw', db.tags, db.tagMeta, db.tagDirtyOutbox, async () => {
      const tagRecords: Tag[] = [];
      for (const update of updates) {
        const existing = (await getNormalized(update.full_name)) ?? emptyTag(update.full_name);
        const replacement = buildManualTagReplacement(existing, update.tags);
        if (
          sameTagNames(replacement.existingManualTags, replacement.manualTags) &&
          !replacement.dismissedAutoTagsChanged
        ) {
          continue;
        }

        tagRecords.push(normalizeStoredTag({
          ...existing,
          favorite: existing.favorite ?? false,
          manualTags: replacement.manualTags,
          dismissedAutoTags: replacement.dismissedAutoTags,
          manualTagsMtime: ts,
          dismissedAutoTagsMtime: replacement.dismissedAutoTagsChanged ? ts : existing.dismissedAutoTagsMtime,
          mtime: ts,
        }));
        touchedNames.push(update.full_name);
        await queueTagDirtyOutbox(update.full_name, ts);

        const newlyAdded = replacement.manualTags
          .filter((tag) => !includesTagName(replacement.existingManualTags, tag));
        for (const name of newlyAdded) {
          const meta = await db.tagMeta.get(name);
          if (meta?.excluded) {
            await db.tagMeta.put({ ...meta, excluded: false, mtime: ts });
            clearedExcluded = true;
          }
        }
      }
      if (tagRecords.length > 0) await db.tags.bulkPut(tagRecords);
      if (clearedExcluded) await queueTagMetaDirtyOutbox(ts);
    });

    for (const fullName of touchedNames) markDirty(fullName);
    if (clearedExcluded) markMetaDirty();
    return { updated: touchedNames.length };
  },

  async setAutoTagsBulk(updates) {
    const touchedNames: string[] = [];
    const ts = now();

    await db.transaction('rw', db.tags, db.tagDirtyOutbox, async () => {
      const tagRecords: Tag[] = [];
      for (const update of updates) {
        const existing = (await getNormalized(update.full_name)) ?? emptyTag(update.full_name);
        const manualTags = manualTagNames(existing);
        const dismissedAutoTags = dismissedAutoTagNames(existing);
        const autoTags = addTagNames([], update.autoTags)
          .filter((name) => (
            !includesTagName(manualTags, name) && !includesTagName(dismissedAutoTags, name)
          ));
        if (sameTagNames(autoTagNames(existing), autoTags)) continue;
        tagRecords.push(normalizeStoredTag({
          ...existing,
          favorite: existing.favorite ?? false,
          autoTags,
          autoTagsMtime: ts,
        }));
        touchedNames.push(update.full_name);
        await queueTagDirtyOutbox(update.full_name, ts);
      }
      if (tagRecords.length > 0) await db.tags.bulkPut(tagRecords);
    });

    for (const fullName of touchedNames) markDirty(fullName);
    return { updated: touchedNames.length };
  },

  async removeVisibleTag(full_name, name) {
    let removed = false;
    let touched = false;
    const ts = now();

    await db.transaction('rw', db.tags, db.tagDirtyOutbox, async () => {
      const existing = (await getNormalized(full_name)) ?? emptyTag(full_name);
      const hadManual = includesTagName(existing.manualTags, name);
      const hadAuto = includesTagName(existing.autoTags, name);
      if (!hadManual && !hadAuto) return;
      const manualTags = withoutTagName(existing.manualTags, name);
      const autoTags = withoutTagName(existing.autoTags, name);
      const dismissedAutoTags = addTagNames(existing.dismissedAutoTags, [name]);
      await db.tags.put(normalizeStoredTag({
        ...existing,
        favorite: existing.favorite ?? false,
        manualTags,
        autoTags,
        dismissedAutoTags,
        manualTagsMtime: hadManual ? ts : existing.manualTagsMtime,
        autoTagsMtime: hadAuto ? ts : existing.autoTagsMtime,
        dismissedAutoTagsMtime: sameTagNames(existing.dismissedAutoTags, dismissedAutoTags)
          ? existing.dismissedAutoTagsMtime
          : ts,
        mtime: ts,
      }));
      await queueTagDirtyOutbox(full_name, ts);
      removed = true;
      touched = true;
    });

    if (touched) markDirty(full_name);
    return { removed };
  },

  async setNotes(full_name, notes) {
    const ts = now();
    await db.transaction('rw', db.tags, db.tagDirtyOutbox, async () => {
      const existing = (await getNormalized(full_name)) ?? emptyTag(full_name);
      await db.tags.put(normalizeStoredTag({ ...existing, favorite: existing.favorite ?? false, notes, mtime: ts }));
      await queueTagDirtyOutbox(full_name, ts);
    });
    markDirty(full_name);
  },

  async setFavorite(full_name, favorite) {
    const ts = now();
    await db.transaction('rw', db.tags, db.tagDirtyOutbox, async () => {
      const existing = (await getNormalized(full_name)) ?? emptyTag(full_name);
      await db.tags.put(normalizeStoredTag({ ...existing, favorite, mtime: ts }));
      await queueTagDirtyOutbox(full_name, ts);
    });
    markDirty(full_name);
  },

  async upsert(tag) {
    await db.transaction('rw', db.tags, db.tagDirtyOutbox, async () => {
      await db.tags.put({ ...normalizeStoredTag(tag), favorite: tag.favorite ?? false });
      await queueTagDirtyOutbox(tag.full_name, tag.mtime);
    });
    markDirty(tag.full_name);
  },

  async upsertMeta(meta) {
    await db.transaction('rw', db.tagMeta, db.tagDirtyOutbox, async () => {
      await db.tagMeta.put(meta);
      await queueTagMetaDirtyOutbox(meta.mtime);
    });
    markMetaDirty();
  },

  async deleteTag(name) {
    return idbTagStore.deleteTagEverywhere(name);
  },

  async deleteTagEverywhere(name) {
    let removed = 0;
    const touchedNames: string[] = [];
    const ts = now();
    await db.transaction('rw', db.tags, db.tagMeta, db.tagDirtyOutbox, async () => {
      const rows = await db.tags.toArray() as LegacyTagRow[];
      for (const row of rows) {
        const t = normalizeStoredTag(row);
        const hadManual = includesTagName(t.manualTags, name);
        const hadAuto = includesTagName(t.autoTags, name);
        if (!hadManual && !hadAuto) continue;
        await db.tags.put(normalizeStoredTag({
          ...t,
          manualTags: withoutTagName(t.manualTags, name),
          autoTags: withoutTagName(t.autoTags, name),
          dismissedAutoTags: hadAuto ? addTagNames(t.dismissedAutoTags, [name]) : t.dismissedAutoTags,
          favorite: t.favorite ?? false,
          manualTagsMtime: hadManual ? ts : t.manualTagsMtime,
          autoTagsMtime: hadAuto ? ts : t.autoTagsMtime,
          dismissedAutoTagsMtime: hadAuto ? ts : t.dismissedAutoTagsMtime,
          mtime: ts,
        }));
        touchedNames.push(t.full_name);
        await queueTagDirtyOutbox(t.full_name, ts);
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
      await queueTagMetaDirtyOutbox(ts);
    });
    for (const fullName of touchedNames) markDirty(fullName);
    markMetaDirty();
    return { removed };
  },

  async deleteAllTags() {
    const touchedNames: string[] = [];
    const removedNames = new Set<string>();
    let assignmentsRemoved = 0;
    const ts = now();

    await db.transaction('rw', db.tags, db.tagDirtyOutbox, async () => {
      const rows = await db.tags.toArray() as LegacyTagRow[];
      for (const row of rows) {
        const tag = normalizeStoredTag(row);
        const visible = visibleTagNames(tag);
        if (visible.length === 0 && tag.dismissedAutoTags.length === 0) continue;
        assignmentsRemoved += visible.length;
        touchedNames.push(tag.full_name);
        for (const name of visible) removedNames.add(name);
        await db.tags.put(normalizeStoredTag({
          ...tag,
          manualTags: [],
          autoTags: [],
          dismissedAutoTags: [],
          manualTagsMtime: tag.manualTags.length > 0 ? ts : tag.manualTagsMtime,
          autoTagsMtime: tag.autoTags.length > 0 ? ts : tag.autoTagsMtime,
          dismissedAutoTagsMtime: tag.dismissedAutoTags.length > 0 ? ts : tag.dismissedAutoTagsMtime,
          favorite: tag.favorite ?? false,
          mtime: ts,
        }));
        await queueTagDirtyOutbox(tag.full_name, ts);
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
    return gistTagStore.push(dirtySnapshot, onProgress);
  },

  async syncPull(onProgress?: CountProgressCallback) {
    const { merged, total, missing } = await gistTagStore.pull(onProgress);
    return { merged, total, missing };
  },
};

/** Internal hooks for the Gist transport to clear only the dirty versions it pushed. */
export function clearDirty(snapshot: DirtySnapshot): void {
  for (const { name, version } of snapshot.names) {
    if (dirtyVersions.get(name) === version) {
      dirty.delete(name);
      dirtyVersions.delete(name);
    }
  }
  if (snapshot.meta && dirtyMetaVersion === snapshot.metaVersion) dirtyMeta = false;
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

export function markDirtyForLocalWrites(fullNames: Iterable<string>, meta = false): void {
  for (const fullName of fullNames) markDirty(fullName);
  if (meta) markMetaDirty();
}
