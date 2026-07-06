import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { db } from '@/storage/db';
import {
  idbTagStore,
  resetDirtyForDev,
  snapshotDirty,
} from '@/storage/idb-tag-store';
import type { Tag, TagMeta } from '@/types';

async function seedDeleteTagRows() {
  await db.tags.bulkPut([
    {
      full_name: 'a/react',
      tags: ['react', 'ui'],
      notes: 'keep notes',
      favorite: true,
      gh_list_id: 42,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      full_name: 'b/infra',
      tags: ['ui', 'infra'],
      notes: 'keep infra',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      full_name: 'c/empty',
      tags: [],
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
    assert.deepEqual(react?.tags, ['react']);
    assert.equal(react?.notes, 'keep notes');
    assert.equal(react?.favorite, true);
    assert.equal(react?.gh_list_id, 42);
    assert.deepEqual(infra?.tags, ['infra']);
    assert.equal(infra?.notes, 'keep infra');
    assert.equal(infra?.favorite, false);
    assert.deepEqual(empty?.tags, []);
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
    assert.deepEqual((await db.tags.get('a/react'))?.tags, ['react', 'ui']);
    assert.deepEqual((await db.tags.get('b/infra'))?.tags, ['ui', 'infra']);

    const missingMeta = await db.tagMeta.get('missing-tag');
    assert.equal(missingMeta?.excluded, true);
    assert.equal(missingMeta?.dimension, null);
    assert.equal(missingMeta?.color, null);
    assert.deepEqual(snapshotDirty(), { names: [], meta: true });
  });
});
