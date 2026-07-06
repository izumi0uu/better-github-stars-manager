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

async function seedBulkTags() {
  await db.tags.bulkPut([
    {
      full_name: 'a/react',
      tags: ['react'],
      notes: 'keep notes',
      favorite: true,
      gh_list_id: 42,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      full_name: 'b/infra',
      tags: ['infra'],
      notes: 'keep infra',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    },
  ] satisfies Tag[]);
  await db.tagMeta.bulkPut([
    {
      name: 'ui',
      dimension: 'topic',
      color: '#ff00aa',
      excluded: true,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      name: 'infra',
      dimension: 'topic',
      color: '#00ffaa',
      excluded: false,
      mtime: '2026-07-01T00:00:00Z',
    },
    {
      name: 'react',
      dimension: 'framework',
      color: '#61dafb',
      excluded: true,
      mtime: '2026-07-01T00:00:00Z',
    },
  ] satisfies TagMeta[]);
}

describe('idbTagStore.setTagsBulk', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
    resetDirtyForDev();
    await seedBulkTags();
  });

  afterAll(async () => {
    await db.close();
  });

  it('updates mixed rows while preserving annotations and clearing only newly re-added tombstones', async () => {
    const result = await idbTagStore.setTagsBulk([
      { full_name: 'a/react', tags: ['react', 'ui'] },
      { full_name: 'b/infra', tags: ['infra'] },
      { full_name: 'c/new', tags: ['ui'] },
    ]);

    assert.deepEqual(result, { updated: 2 });

    const [react, infra, created] = await Promise.all([
      db.tags.get('a/react'),
      db.tags.get('b/infra'),
      db.tags.get('c/new'),
    ]);
    assert.deepEqual(react?.tags, ['react', 'ui']);
    assert.equal(react?.notes, 'keep notes');
    assert.equal(react?.favorite, true);
    assert.equal(react?.gh_list_id, 42);
    assert.deepEqual(infra?.tags, ['infra']);
    assert.equal(infra?.mtime, '2026-07-01T00:00:00Z');
    assert.deepEqual(created?.tags, ['ui']);
    assert.equal(created?.notes, '');
    assert.equal(created?.favorite, false);

    const [uiMeta, reactMeta] = await Promise.all([
      db.tagMeta.get('ui'),
      db.tagMeta.get('react'),
    ]);
    assert.equal(uiMeta?.excluded, false);
    assert.equal(uiMeta?.dimension, 'topic');
    assert.equal(uiMeta?.color, '#ff00aa');
    assert.equal(reactMeta?.excluded, true);
    assert.equal(reactMeta?.dimension, 'framework');
    assert.equal(reactMeta?.color, '#61dafb');

    assert.deepEqual(snapshotDirty().names.sort(), ['a/react', 'c/new']);
    assert.equal(snapshotDirty().meta, true);
  });

  it('preserves tag order semantics while dirtying reordered updates', async () => {
    await db.tags.put({
      full_name: 'a/react',
      tags: ['react', 'ui'],
      notes: 'keep notes',
      favorite: true,
      mtime: '2026-07-01T00:00:00Z',
    });

    const result = await idbTagStore.setTagsBulk([
      { full_name: 'a/react', tags: ['ui', 'react'] },
    ]);

    assert.deepEqual(result, { updated: 1 });
    assert.deepEqual((await db.tags.get('a/react'))?.tags, ['ui', 'react']);
    assert.deepEqual(snapshotDirty().names.sort(), ['a/react']);
  });

  it('does not leak data or dirty state when the transaction aborts', async () => {
    await idbTagStore.setNotes('z/preexisting', 'already dirty');
    const dirtyBefore = snapshotDirty();
    const bulkPut = vi.spyOn(db.tags, 'bulkPut').mockRejectedValueOnce(new Error('abort bulk set'));

    await assert.rejects(
      () =>
        idbTagStore.setTagsBulk([
          { full_name: 'a/react', tags: ['react', 'ui'] },
          { full_name: 'b/infra', tags: ['infra', 'ui'] },
        ]),
      /abort bulk set/,
    );
    bulkPut.mockRestore();

    assert.deepEqual((await db.tags.get('a/react'))?.tags, ['react']);
    assert.deepEqual((await db.tags.get('b/infra'))?.tags, ['infra']);
    assert.equal((await db.tagMeta.get('ui'))?.excluded, true);
    assert.deepEqual(snapshotDirty(), dirtyBefore);
  });
});
