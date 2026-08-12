import type { Tag, TagDirtyOutboxRecord, TagMeta } from '@/types';
import type { CountProgressCallback, TagStore } from '@/api/tag-store';
import { gistTagStore } from '@/sync/gist-tag-store';
import { db } from './db';
import {
  addTagNames,
  autoTagNames,
  canonicalTagMetaWinners,
  canonicalTagKey,
  dismissedAutoTagNames,
  excludedCanonicalTagKeys,
  includesTagName,
  manualTagNames,
  sameTagNames,
  visibleTagNames,
  withoutTagName,
  preferredCanonicalTagMeta,
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

function groupTagMetaByCanonicalKey(
  metas: readonly TagMeta[],
): Map<string, TagMeta[]> {
  const groups = new Map<string, TagMeta[]>();
  for (const meta of metas) {
    const key = canonicalTagKey(meta.name);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(meta);
    groups.set(key, group);
  }
  return groups;
}

function orderTagMetaAliases(aliases: readonly TagMeta[]): TagMeta[] {
  return [...aliases].sort((left, right) => {
    const forward = preferredCanonicalTagMeta(left, right);
    const reverse = preferredCanonicalTagMeta(right, left);
    if (forward === left && reverse === left) return -1;
    if (forward === right && reverse === right) return 1;
    return 0;
  });
}

function mergedTagMetaFields(aliases: readonly TagMeta[]): Readonly<{
  primary: TagMeta | undefined;
  dimension: string | null;
  color: string | null;
}> {
  const ordered = orderTagMetaAliases(aliases);
  return {
    primary: ordered.length > 0
      ? ordered.slice(1).reduce(preferredCanonicalTagMeta, ordered[0]!)
      : undefined,
    dimension: ordered.find((meta) => meta.dimension !== null)?.dimension ?? null,
    color: ordered.find((meta) => meta.color !== null)?.color ?? null,
  };
}

async function clearExcludedTagMetaAliases(
  submittedTags: readonly string[],
  ts: string,
): Promise<boolean> {
  const additionsByKey = new Map<string, string>();
  for (const name of submittedTags) {
    const key = canonicalTagKey(name);
    if (key && !additionsByKey.has(key)) additionsByKey.set(key, name.trim());
  }
  if (additionsByKey.size === 0) return false;

  const groups = groupTagMetaByCanonicalKey(await db.tagMeta.toArray());
  const aliasesToDelete = new Set<string>();
  const replacements: TagMeta[] = [];
  for (const [key, displayName] of additionsByKey) {
    const aliases = groups.get(key) ?? [];
    if (!aliases.some((meta) => meta.excluded)) continue;
    const merged = mergedTagMetaFields(aliases);
    for (const alias of aliases) aliasesToDelete.add(alias.name);
    replacements.push({
      name: displayName,
      dimension: merged.dimension,
      color: merged.color,
      excluded: false,
      mtime: ts,
    });
  }
  if (replacements.length === 0) return false;

  if (aliasesToDelete.size > 0) {
    await db.tagMeta.bulkDelete([...aliasesToDelete]);
  }
  await db.tagMeta.bulkPut(replacements);
  return true;
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

export type VisibleTagBulkRemoval = Readonly<{
  full_name: string;
  tags: readonly string[];
}>;

export type VisibleTagBulkRemovalResult = Readonly<{
  /** Unique repository/tag pairs after canonical tag normalization. */
  requested: number;
  /** Requested pairs that were visible and removed. */
  changed: number;
  skipped: number;
  repositoriesChanged: number;
}>;

export type GlobalTagBulkDeletionResult = Readonly<{
  requestedTags: number;
  assignmentsRemoved: number;
  repositoriesChanged: number;
}>;

export type IdbTagStore = TagStore & Readonly<{
  removeVisibleTagsBulk(
    updates: readonly VisibleTagBulkRemoval[],
  ): Promise<VisibleTagBulkRemovalResult>;
  deleteTagsEverywhere(tags: readonly string[]): Promise<GlobalTagBulkDeletionResult>;
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
    if (star.tombstone || star.viewer_has_starred === false) {
      return { manualTags: [], changed: false, reason: 'tombstoned' as const };
    }

    const stored = await db.tags.get(full_name) as LegacyTagRow | undefined;
    const existing = stored ? normalizeStoredTag(stored) : emptyTag(full_name);
    const currentManual = manualTagNames(existing);
    const excludedKeys = excludedCanonicalTagKeys(await db.tagMeta.toArray());
    if (additions.some((tag) => (
      excludedKeys.has(canonicalTagKey(tag))
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

export const idbTagStore: IdbTagStore = {
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
      // A manual submission is the user-owned path that revives a globally
      // deleted tag, including rows where a hidden legacy assignment remains.
      clearedExcluded = await clearExcludedTagMetaAliases(replacement.manualTags, ts);
      if (clearedExcluded) await queueTagMetaDirtyOutbox(ts);
    });
    markDirty(full_name);
    if (clearedExcluded) markMetaDirty();
  },

  async setTagsBulk(updates) {
    const touchedNames: string[] = [];
    const submittedManualTags: string[] = [];
    let clearedExcluded = false;
    const ts = now();

    await db.transaction('rw', db.tags, db.tagMeta, db.tagDirtyOutbox, async () => {
      const tagRecords: Tag[] = [];
      for (const update of updates) {
        const existing = (await getNormalized(update.full_name)) ?? emptyTag(update.full_name);
        const replacement = buildManualTagReplacement(existing, update.tags);
        submittedManualTags.push(...replacement.manualTags);
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
      }
      if (tagRecords.length > 0) await db.tags.bulkPut(tagRecords);
      clearedExcluded = await clearExcludedTagMetaAliases(submittedManualTags, ts);
      if (clearedExcluded) await queueTagMetaDirtyOutbox(ts);
    });

    for (const fullName of touchedNames) markDirty(fullName);
    if (clearedExcluded) markMetaDirty();
    return { updated: touchedNames.length };
  },

  async setAutoTagsBulk(updates) {
    const touchedNames: string[] = [];
    const ts = now();

    await db.transaction('rw', db.tags, db.tagMeta, db.tagDirtyOutbox, async () => {
      const tagRecords: Tag[] = [];
      const excludedKeys = excludedCanonicalTagKeys(await db.tagMeta.toArray());
      for (const update of updates) {
        const existing = (await getNormalized(update.full_name)) ?? emptyTag(update.full_name);
        const manualTags = manualTagNames(existing);
        const dismissedAutoTags = dismissedAutoTagNames(existing);
        const autoTags = addTagNames([], update.autoTags)
          .filter((name) => (
            !includesTagName(manualTags, name)
            && !includesTagName(dismissedAutoTags, name)
            && !excludedKeys.has(canonicalTagKey(name))
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

  async removeVisibleTagsBulk(updates) {
    const requestsByRepository = new Map<string, string[]>();
    for (const update of updates) {
      requestsByRepository.set(
        update.full_name,
        addTagNames(requestsByRepository.get(update.full_name) ?? [], [...update.tags]),
      );
    }

    const requested = Array.from(requestsByRepository.values())
      .reduce((total, tags) => total + tags.length, 0);
    let changed = 0;
    const touchedNames: string[] = [];
    const ts = now();

    await db.transaction('rw', db.tags, db.tagDirtyOutbox, async () => {
      const tagRecords: Tag[] = [];
      for (const [fullName, names] of requestsByRepository) {
        const existing = await getNormalized(fullName);
        if (!existing) continue;

        let manualTags = manualTagNames(existing);
        let autoTags = autoTagNames(existing);
        const removedNames: string[] = [];
        let manualChanged = false;
        let autoChanged = false;
        for (const name of names) {
          const hadManual = includesTagName(manualTags, name);
          const hadAuto = includesTagName(autoTags, name);
          if (!hadManual && !hadAuto) continue;
          if (hadManual) {
            manualTags = withoutTagName(manualTags, name);
            manualChanged = true;
          }
          if (hadAuto) {
            autoTags = withoutTagName(autoTags, name);
            autoChanged = true;
          }
          removedNames.push(name);
          changed++;
        }
        if (removedNames.length === 0) continue;

        const dismissedAutoTags = addTagNames(
          dismissedAutoTagNames(existing),
          removedNames,
        );
        const dismissalsChanged = !sameTagNames(
          dismissedAutoTagNames(existing),
          dismissedAutoTags,
        );
        tagRecords.push(normalizeStoredTag({
          ...existing,
          favorite: existing.favorite ?? false,
          manualTags,
          autoTags,
          dismissedAutoTags,
          manualTagsMtime: manualChanged ? ts : existing.manualTagsMtime,
          autoTagsMtime: autoChanged ? ts : existing.autoTagsMtime,
          dismissedAutoTagsMtime: dismissalsChanged ? ts : existing.dismissedAutoTagsMtime,
          mtime: ts,
        }));
        touchedNames.push(fullName);
        await queueTagDirtyOutbox(fullName, ts);
      }
      if (tagRecords.length > 0) await db.tags.bulkPut(tagRecords);
    });

    for (const fullName of touchedNames) markDirty(fullName);
    return {
      requested,
      changed,
      skipped: requested - changed,
      repositoriesChanged: touchedNames.length,
    };
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
    const result = await idbTagStore.deleteTagsEverywhere([name]);
    return { removed: result.repositoriesChanged };
  },

  async deleteTagsEverywhere(tags) {
    const requestedByCanonicalName = new Map<string, string>();
    for (const rawName of tags) {
      const displayName = rawName.trim();
      if (!displayName) continue;
      const canonicalName = canonicalTagKey(displayName);
      if (!requestedByCanonicalName.has(canonicalName)) {
        requestedByCanonicalName.set(canonicalName, displayName);
      }
    }

    const requestedTags = requestedByCanonicalName.size;
    if (requestedTags === 0) {
      return { requestedTags: 0, assignmentsRemoved: 0, repositoriesChanged: 0 };
    }

    let assignmentsRemoved = 0;
    const touchedNames: string[] = [];
    const ts = now();
    await db.transaction('rw', db.tags, db.tagMeta, db.tagDirtyOutbox, async () => {
      const rows = await db.tags.toArray() as LegacyTagRow[];
      const existingMeta = await db.tagMeta.toArray();
      const metaByCanonicalName = groupTagMetaByCanonicalKey(existingMeta);
      const visibleDisplayByCanonicalName = new Map<string, string>();
      for (const row of rows) {
        for (const name of visibleTagNames(normalizeStoredTag(row))) {
          const canonicalName = canonicalTagKey(name);
          if (!visibleDisplayByCanonicalName.has(canonicalName)) {
            visibleDisplayByCanonicalName.set(canonicalName, name);
          }
        }
      }
      const requestedTagsWithDisplay = Array.from(
        requestedByCanonicalName,
        ([canonicalName, requestedDisplayName]) => {
          const aliases = metaByCanonicalName.get(canonicalName) ?? [];
          const merged = mergedTagMetaFields(aliases);
          return {
            canonicalName,
            aliases,
            displayName: merged.primary?.name
              ?? visibleDisplayByCanonicalName.get(canonicalName)
              ?? requestedDisplayName,
            dimension: merged.dimension,
            color: merged.color,
          };
        },
      );
      const tagRecords: Tag[] = [];
      for (const row of rows) {
        const t = normalizeStoredTag(row);
        let manualTags = manualTagNames(t);
        let autoTags = autoTagNames(t);
        let dismissedAutoTags = dismissedAutoTagNames(t);
        let manualChanged = false;
        let autoChanged = false;
        let dismissalsChanged = false;
        for (const requestedTag of requestedTagsWithDisplay) {
          const hadManual = manualTags.some((name) => (
            canonicalTagKey(name) === requestedTag.canonicalName
          ));
          const hadAuto = autoTags.some((name) => (
            canonicalTagKey(name) === requestedTag.canonicalName
          ));
          if (!hadManual && !hadAuto) continue;
          if (hadManual) {
            manualTags = manualTags.filter((name) => (
              canonicalTagKey(name) !== requestedTag.canonicalName
            ));
            manualChanged = true;
          }
          if (hadAuto) {
            autoTags = autoTags.filter((name) => (
              canonicalTagKey(name) !== requestedTag.canonicalName
            ));
            const nextDismissedAutoTags = addTagNames(
              dismissedAutoTags,
              [requestedTag.displayName],
            );
            dismissalsChanged ||= !sameTagNames(dismissedAutoTags, nextDismissedAutoTags);
            dismissedAutoTags = nextDismissedAutoTags;
            autoChanged = true;
          }
          assignmentsRemoved++;
        }
        if (!manualChanged && !autoChanged) continue;
        tagRecords.push(normalizeStoredTag({
          ...t,
          manualTags,
          autoTags,
          dismissedAutoTags,
          favorite: t.favorite ?? false,
          manualTagsMtime: manualChanged ? ts : t.manualTagsMtime,
          autoTagsMtime: autoChanged ? ts : t.autoTagsMtime,
          dismissedAutoTagsMtime: dismissalsChanged ? ts : t.dismissedAutoTagsMtime,
          mtime: ts,
        }));
        touchedNames.push(t.full_name);
        await queueTagDirtyOutbox(t.full_name, ts);
      }
      if (tagRecords.length > 0) await db.tags.bulkPut(tagRecords);

      const aliasesToDelete = new Set(
        requestedTagsWithDisplay.flatMap((requestedTag) => (
          requestedTag.aliases.map((meta) => meta.name)
        )),
      );
      if (aliasesToDelete.size > 0) {
        await db.tagMeta.bulkDelete([...aliasesToDelete]);
      }
      const tombstones: TagMeta[] = requestedTagsWithDisplay.map((requestedTag) => (
        {
          name: requestedTag.displayName,
          dimension: requestedTag.dimension,
          color: requestedTag.color,
          excluded: true,
          mtime: ts,
        }
      ));
      await db.tagMeta.bulkPut(tombstones);
      await queueTagMetaDirtyOutbox(ts);
    });
    for (const fullName of touchedNames) markDirty(fullName);
    markMetaDirty();
    return {
      requestedTags,
      assignmentsRemoved,
      repositoriesChanged: touchedNames.length,
    };
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
    return [...canonicalTagMetaWinners(metas).values()]
      .filter((meta) => meta.excluded)
      .map((meta) => meta.name);
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
