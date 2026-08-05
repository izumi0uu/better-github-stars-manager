import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { db } from '@/storage/db';
import {
  idbTagStore,
  resetDirtyForDev,
  snapshotDirty,
  snapshotTagDirtyOutbox,
} from '@/storage/idb-tag-store';
import { visibleTagNames } from '@/tags/tag-model';
import type { Tag, TagMeta } from '@/types';

async function seedDeleteTagRows() {
  await db.tags.bulkPut([
    {
      full_name: 'a/react',
      manualTags: ['react', 'ui'],
      autoTags: ['topic'],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: 'keep notes',
      favorite: true,
      gh_list_id: 42,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      full_name: 'b/infra',
      manualTags: ['infra'],
      autoTags: ['ui'],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: 'keep infra',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      full_name: 'c/empty',
      manualTags: [],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: 'untouched',
      favorite: true,
      mtime: '2026-07-01T00:00:00Z',
    },
  ] satisfies Tag[]);
  await db.tagMeta.bulkPut([
    {
      name: 'ui',
      dimension: 'topic',
      color: '#ff00aa',
      excluded: false,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      name: 'infra',
      dimension: 'stack',
      color: '#00ffaa',
      excluded: false,
      mtime: '2026-07-01T00:00:00Z',
    },
  ] satisfies TagMeta[]);
}

describe('idbTagStore.deleteTag', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
    resetDirtyForDev();
    await seedDeleteTagRows();
  });

  afterAll(async () => {
    await db.close();
  });

  it('removes one tag from matching repositories and preserves every other annotation field', async () => {
    const result = await idbTagStore.deleteTag('ui');

    assert.deepEqual(result, { removed: 2 });

    const [react, infra, empty] = await Promise.all([
      db.tags.get('a/react'),
      db.tags.get('b/infra'),
      db.tags.get('c/empty'),
    ]);
    assert.deepEqual(react?.manualTags, ['react']);
    assert.deepEqual(react?.autoTags, ['topic']);
    assert.equal(react?.notes, 'keep notes');
    assert.equal(react?.favorite, true);
    assert.equal(react?.gh_list_id, 42);
    assert.deepEqual(infra?.manualTags, ['infra']);
    assert.deepEqual(infra?.autoTags, []);
    assert.deepEqual(infra?.dismissedAutoTags, ['ui']);
    assert.equal(infra?.notes, 'keep infra');
    assert.equal(infra?.favorite, false);
    assert.deepEqual(visibleTagNames(empty), []);
    assert.equal(empty?.notes, 'untouched');
    assert.equal(empty?.favorite, true);

    const uiMeta = await db.tagMeta.get('ui');
    assert.equal(uiMeta?.excluded, true);
    assert.equal(uiMeta?.dimension, 'topic');
    assert.equal(uiMeta?.color, '#ff00aa');
    assert.equal((await db.tagMeta.get('infra'))?.excluded, false);

    const dirty = snapshotDirty();
    assert.deepEqual(dirty.names.sort(), ['a/react', 'b/infra']);
    assert.equal(dirty.meta, true);
  });

  it('creates a tombstone without dirtying repositories when the tag is not assigned', async () => {
    const result = await idbTagStore.deleteTag('missing-tag');

    assert.deepEqual(result, { removed: 0 });
    assert.deepEqual(visibleTagNames(await db.tags.get('a/react')), ['react', 'ui', 'topic']);
    assert.deepEqual(visibleTagNames(await db.tags.get('b/infra')), ['infra', 'ui']);

    const missingMeta = await db.tagMeta.get('missing-tag');
    assert.equal(missingMeta?.excluded, true);
    assert.equal(missingMeta?.dimension, null);
    assert.equal(missingMeta?.color, null);
    assert.deepEqual(snapshotDirty(), { names: [], meta: true });
  });

  it('deletes multiple global tags in one operation with canonical request counts', async () => {
    const result = await idbTagStore.deleteTagsEverywhere([
      'UI',
      'topic',
      'missing-tag',
      ' ui ',
    ]);

    assert.deepEqual(result, {
      requestedTags: 3,
      assignmentsRemoved: 3,
      repositoriesChanged: 2,
    });

    const [react, infra] = await Promise.all([
      db.tags.get('a/react'),
      db.tags.get('b/infra'),
    ]);
    assert.deepEqual(react?.manualTags, ['react']);
    assert.deepEqual(react?.autoTags, []);
    assert.deepEqual(react?.dismissedAutoTags, ['topic']);
    assert.equal(react?.notes, 'keep notes');
    assert.equal(react?.favorite, true);
    assert.equal(react?.gh_list_id, 42);
    assert.deepEqual(infra?.manualTags, ['infra']);
    assert.deepEqual(infra?.autoTags, []);
    assert.deepEqual(infra?.dismissedAutoTags, ['ui']);

    const [uiMeta, topicMeta, missingMeta, duplicateUiMeta] = await Promise.all([
      db.tagMeta.get('ui'),
      db.tagMeta.get('topic'),
      db.tagMeta.get('missing-tag'),
      db.tagMeta.get('UI'),
    ]);
    assert.equal(uiMeta?.excluded, true);
    assert.equal(uiMeta?.dimension, 'topic');
    assert.equal(uiMeta?.color, '#ff00aa');
    assert.equal(topicMeta?.excluded, true);
    assert.equal(missingMeta?.excluded, true);
    assert.equal(duplicateUiMeta, undefined);
    assert.deepEqual(snapshotDirty().names.sort(), ['a/react', 'b/infra']);
    assert.equal(snapshotDirty().meta, true);
  });

  it('deduplicates unassigned global tags and writes one tombstone', async () => {
    const result = await idbTagStore.deleteTagsEverywhere([
      'missing-tag',
      'MISSING-TAG',
      ' ',
    ]);

    assert.deepEqual(result, {
      requestedTags: 1,
      assignmentsRemoved: 0,
      repositoriesChanged: 0,
    });
    assert.equal((await db.tagMeta.get('missing-tag'))?.excluded, true);
    assert.equal(await db.tagMeta.get('MISSING-TAG'), undefined);
    assert.deepEqual(snapshotDirty(), { names: [], meta: true });
  });

  it('collapses canonical metadata aliases into one global tombstone', async () => {
    await db.tagMeta.bulkPut([
      {
        name: 'UI',
        dimension: null,
        color: null,
        excluded: false,
        mtime: '2026-07-03T00:00:00Z',
      },
      {
        name: 'ＵＩ',
        dimension: 'interface',
        color: null,
        excluded: true,
        mtime: '2026-07-02T00:00:00Z',
      },
    ]);

    await idbTagStore.deleteTagsEverywhere([' ui ']);

    const aliases = (await db.tagMeta.toArray())
      .filter((meta) => meta.name.trim().normalize('NFKC').toLocaleLowerCase('en-US') === 'ui');
    assert.equal(aliases.length, 1);
    assert.equal(aliases[0]?.name, 'UI');
    assert.equal(aliases[0]?.dimension, 'interface');
    assert.equal(aliases[0]?.color, '#ff00aa');
    assert.equal(aliases[0]?.excluded, true);
  });

  it('rolls back repository, tombstone, outbox, and dirty state when global deletion aborts', async () => {
    await idbTagStore.setNotes('z/preexisting', 'already dirty');
    const rowsBefore = await db.tags.toArray();
    const metaBefore = await db.tagMeta.toArray();
    const outboxBefore = await snapshotTagDirtyOutbox();
    const dirtyBefore = snapshotDirty();
    const bulkPut = vi.spyOn(db.tagMeta, 'bulkPut').mockRejectedValueOnce(new Error('abort global delete'));

    await assert.rejects(
      () => idbTagStore.deleteTagsEverywhere(['ui', 'topic']),
      /abort global delete/,
    );
    bulkPut.mockRestore();

    assert.deepEqual(await db.tags.toArray(), rowsBefore);
    assert.deepEqual(await db.tagMeta.toArray(), metaBefore);
    assert.deepEqual(await snapshotTagDirtyOutbox(), outboxBefore);
    assert.deepEqual(snapshotDirty(), dirtyBefore);
  });

  it('removes one visible tag and records row-level auto dismissal', async () => {
    const result = await idbTagStore.removeVisibleTag('b/infra', 'ui');

    assert.deepEqual(result, { removed: true });
    const infra = await db.tags.get('b/infra');
    assert.deepEqual(infra?.manualTags, ['infra']);
    assert.deepEqual(infra?.autoTags, []);
    assert.deepEqual(infra?.dismissedAutoTags, ['ui']);
    assert.deepEqual(snapshotDirty().names, ['b/infra']);
  });

  it('records row-level dismissal when removing a manual-only visible tag', async () => {
    const result = await idbTagStore.removeVisibleTag('a/react', 'ui');

    assert.deepEqual(result, { removed: true });
    const react = await db.tags.get('a/react');
    assert.deepEqual(react?.manualTags, ['react']);
    assert.deepEqual(react?.autoTags, ['topic']);
    assert.deepEqual(react?.dismissedAutoTags, ['ui']);
    assert.deepEqual(snapshotDirty().names, ['a/react']);
  });
});
