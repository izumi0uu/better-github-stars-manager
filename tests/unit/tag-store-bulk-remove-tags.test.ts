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
import type { Tag } from '@/types';

async function seedRows() {
  await db.tags.bulkPut([
    {
      full_name: 'a/react',
      manualTags: ['react', 'ui'],
      autoTags: ['hooks', 'topic'],
      dismissedAutoTags: ['legacy'],
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
  ] satisfies Tag[]);
}

describe('idbTagStore.removeVisibleTagsBulk', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
    resetDirtyForDev();
    await seedRows();
  });

  afterAll(async () => {
    await db.close();
  });

  it('atomically removes unique visible repo-tag requests and preserves other annotations', async () => {
    const result = await idbTagStore.removeVisibleTagsBulk([
      { full_name: 'a/react', tags: ['UI', 'hooks', 'missing'] },
      { full_name: 'a/react', tags: ['react', 'ui'] },
      { full_name: 'b/infra', tags: ['ui'] },
      { full_name: 'missing/repo', tags: ['react'] },
    ]);

    assert.deepEqual(result, {
      requested: 6,
      changed: 4,
      skipped: 2,
      repositoriesChanged: 2,
    });

    const [react, infra] = await Promise.all([
      db.tags.get('a/react'),
      db.tags.get('b/infra'),
    ]);
    assert.deepEqual(react?.manualTags, []);
    assert.deepEqual(react?.autoTags, ['topic']);
    assert.deepEqual(react?.dismissedAutoTags, ['legacy', 'UI', 'hooks', 'react']);
    assert.deepEqual(visibleTagNames(react), ['topic']);
    assert.equal(react?.notes, 'keep notes');
    assert.equal(react?.favorite, true);
    assert.equal(react?.gh_list_id, 42);

    assert.deepEqual(infra?.manualTags, ['infra']);
    assert.deepEqual(infra?.autoTags, []);
    assert.deepEqual(infra?.dismissedAutoTags, ['ui']);
    assert.equal(infra?.notes, 'keep infra');

    assert.deepEqual(snapshotDirty().names.sort(), ['a/react', 'b/infra']);
    assert.deepEqual(
      (await snapshotTagDirtyOutbox()).map((row) => row.key).sort(),
      ['a/react', 'b/infra'],
    );
  });

  it('uses the same dismissal behavior for manual-only and auto-only removals', async () => {
    const result = await idbTagStore.removeVisibleTagsBulk([
      { full_name: 'a/react', tags: ['react'] },
      { full_name: 'b/infra', tags: ['ui'] },
    ]);

    assert.deepEqual(result, {
      requested: 2,
      changed: 2,
      skipped: 0,
      repositoriesChanged: 2,
    });
    assert.deepEqual((await db.tags.get('a/react'))?.dismissedAutoTags, ['legacy', 'react']);
    assert.deepEqual((await db.tags.get('b/infra'))?.dismissedAutoTags, ['ui']);
  });

  it('removes a stored full-width tag through its canonical spelling', async () => {
    await db.tags.put({
      ...(await db.tags.get('a/react'))!,
      manualTags: ['Ｌｅｇａｃｙ', 'keep'],
      autoTags: [],
      dismissedAutoTags: [],
    });

    const result = await idbTagStore.removeVisibleTagsBulk([
      { full_name: 'a/react', tags: ['Legacy'] },
    ]);

    assert.deepEqual(result, {
      requested: 1,
      changed: 1,
      skipped: 0,
      repositoriesChanged: 1,
    });
    const row = await db.tags.get('a/react');
    assert.deepEqual(row?.manualTags, ['keep']);
    assert.deepEqual(row?.dismissedAutoTags, ['Legacy']);
  });

  it('does not write rows or outbox entries when no requested tag is visible', async () => {
    const rowsBefore = await db.tags.toArray();
    const result = await idbTagStore.removeVisibleTagsBulk([
      { full_name: 'a/react', tags: ['missing', 'MISSING', ''] },
      { full_name: 'missing/repo', tags: ['react'] },
      { full_name: 'b/infra', tags: [] },
    ]);

    assert.deepEqual(result, {
      requested: 2,
      changed: 0,
      skipped: 2,
      repositoriesChanged: 0,
    });
    assert.deepEqual(await db.tags.toArray(), rowsBefore);
    assert.deepEqual(await snapshotTagDirtyOutbox(), []);
    assert.deepEqual(snapshotDirty(), { names: [], meta: false });
  });

  it('does not leak tag, outbox, or dirty state when the transaction aborts', async () => {
    await idbTagStore.setNotes('z/preexisting', 'already dirty');
    const rowsBefore = await db.tags.toArray();
    const outboxBefore = await snapshotTagDirtyOutbox();
    const dirtyBefore = snapshotDirty();
    const bulkPut = vi.spyOn(db.tags, 'bulkPut').mockRejectedValueOnce(new Error('abort bulk removal'));

    await assert.rejects(
      () => idbTagStore.removeVisibleTagsBulk([
        { full_name: 'a/react', tags: ['react', 'hooks'] },
        { full_name: 'b/infra', tags: ['ui'] },
      ]),
      /abort bulk removal/,
    );
    bulkPut.mockRestore();

    assert.deepEqual(await db.tags.toArray(), rowsBefore);
    assert.deepEqual(await snapshotTagDirtyOutbox(), outboxBefore);
    assert.deepEqual(snapshotDirty(), dirtyBefore);
  });
});
