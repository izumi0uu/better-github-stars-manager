import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { db } from '@/storage/db';
import {
  idbTagStore,
  resetDirtyForDev,
  snapshotDirty,
} from '@/storage/idb-tag-store';
import { visibleTagNames } from '@/tags/tag-model';
import type { Tag, TagMeta } from '@/types';

async function seedTags() {
  await db.tags.bulkPut([
    {
      full_name: 'a/react',
      manualTags: ['react', 'ui'],
      autoTags: ['topic'],
      dismissedAutoTags: ['old-auto'],
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
      dismissedAutoTags: ['dismissed-only'],
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
      name: 'manual-excluded',
      dimension: null,
      color: null,
      excluded: true,
      mtime: '2026-07-01T00:00:00Z',
    },
  ] satisfies TagMeta[]);
}

describe('idbTagStore.deleteAllTags', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
    resetDirtyForDev();
    await seedTags();
  });

  afterAll(async () => {
    await db.close();
  });

  it('clears every tag assignment while preserving annotation data and tag metadata', async () => {
    const result = await idbTagStore.deleteAllTags();

    assert.deepEqual(result, {
      assignmentsRemoved: 5,
      distinctTagsRemoved: 4,
    });

    const [react, infra, empty] = await Promise.all([
      db.tags.get('a/react'),
      db.tags.get('b/infra'),
      db.tags.get('c/empty'),
    ]);
    assert.deepEqual(react?.manualTags, []);
    assert.deepEqual(react?.autoTags, []);
    assert.deepEqual(react?.dismissedAutoTags, []);
    assert.equal(react?.notes, 'keep notes');
    assert.equal(react?.favorite, true);
    assert.equal(react?.gh_list_id, 42);
    assert.deepEqual(infra?.manualTags, []);
    assert.deepEqual(infra?.autoTags, []);
    assert.deepEqual(infra?.dismissedAutoTags, []);
    assert.equal(infra?.notes, 'keep infra');
    assert.equal(infra?.favorite, false);
    assert.deepEqual(visibleTagNames(empty), []);
    assert.deepEqual(empty?.dismissedAutoTags, []);
    assert.equal(empty?.notes, 'untouched');
    assert.equal(empty?.favorite, true);

    const metaByName = new Map((await db.tagMeta.toArray()).map((meta) => [meta.name, meta]));
    assert.equal(metaByName.has('react'), false);
    assert.equal(metaByName.has('infra'), false);
    assert.equal(metaByName.get('ui')?.excluded, false);
    assert.equal(metaByName.get('ui')?.dimension, 'topic');
    assert.equal(metaByName.get('ui')?.color, '#ff00aa');
    assert.equal(metaByName.get('manual-excluded')?.excluded, true);

    const dirty = snapshotDirty();
    assert.deepEqual(dirty.names.sort(), ['a/react', 'b/infra', 'c/empty']);
    assert.equal(dirty.meta, false);
    assert.deepEqual(await idbTagStore.listExcluded(), ['manual-excluded']);
  });

  it('lets auto-tag candidates be suggested again after a bulk clear', async () => {
    await idbTagStore.deleteAllTags();

    const excluded = await idbTagStore.listExcluded();
    assert.equal(excluded.includes('react'), false);
    assert.equal(excluded.includes('ui'), false);
    assert.equal(excluded.includes('infra'), false);
  });

  it('does not leak dirty state when the transaction aborts', async () => {
    await idbTagStore.setNotes('z/preexisting', 'already dirty');
    const dirtyBefore = snapshotDirty();
    const put = vi.spyOn(db.tags, 'put').mockRejectedValueOnce(new Error('abort bulk delete'));

    await assert.rejects(() => idbTagStore.deleteAllTags(), /abort bulk delete/);
    put.mockRestore();

    assert.deepEqual(visibleTagNames(await db.tags.get('a/react')), ['react', 'ui', 'topic']);
    assert.deepEqual(visibleTagNames(await db.tags.get('b/infra')), ['infra', 'ui']);
    assert.deepEqual(snapshotDirty(), dirtyBefore);
  });
});
