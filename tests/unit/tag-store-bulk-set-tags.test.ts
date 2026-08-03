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
import { normalizeStoredTag, type LegacyTagRow } from '@/storage/tag-shape';
import type { TagMeta } from '@/types';

async function seedBulkTags() {
  const rows = [
    {
      full_name: 'a/react',
      manualTags: ['react'],
      autoTags: ['hooks'],
      dismissedAutoTags: ['ui'],
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
  ] satisfies LegacyTagRow[];
  await db.table('tags').bulkPut(rows);
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

  it('updates manual rows while preserving annotations and reviving submitted tombstones', async () => {
    const result = await idbTagStore.setTagsBulk([
      { full_name: 'a/react', tags: ['react', 'ui'] },
      { full_name: 'b/infra', tags: ['infra'] },
      { full_name: 'c/new', tags: ['ui'] },
    ]);

    assert.deepEqual(result, { updated: 2 });

    const [react, infraRaw, created] = await Promise.all([
      db.tags.get('a/react'),
      db.table('tags').get('b/infra') as Promise<LegacyTagRow | undefined>,
      db.tags.get('c/new'),
    ]);
    const infra = infraRaw ? normalizeStoredTag(infraRaw) : undefined;
    assert.deepEqual(react?.manualTags, ['react', 'ui']);
    assert.deepEqual(react?.autoTags, ['hooks']);
    assert.deepEqual(react?.dismissedAutoTags, []);
    assert.deepEqual(visibleTagNames(react), ['react', 'ui', 'hooks']);
    assert.equal(react?.notes, 'keep notes');
    assert.equal(react?.favorite, true);
    assert.equal(react?.gh_list_id, 42);
    assert.deepEqual(visibleTagNames(infra), ['infra']);
    assert.equal(infra?.mtime, '2026-07-01T00:00:00Z');
    assert.deepEqual(created?.manualTags, ['ui']);
    assert.deepEqual(created?.autoTags, []);
    assert.deepEqual(created?.dismissedAutoTags, []);
    assert.equal(created?.notes, '');
    assert.equal(created?.favorite, false);

    const [uiMeta, reactMeta] = await Promise.all([
      db.tagMeta.get('ui'),
      db.tagMeta.get('react'),
    ]);
    assert.equal(uiMeta?.excluded, false);
    assert.equal(uiMeta?.dimension, 'topic');
    assert.equal(uiMeta?.color, '#ff00aa');
    assert.equal(reactMeta?.excluded, false);
    assert.equal(reactMeta?.dimension, 'framework');
    assert.equal(reactMeta?.color, '#61dafb');

    assert.deepEqual(snapshotDirty().names.sort(), ['a/react', 'c/new']);
    assert.equal(snapshotDirty().meta, true);
  });

  it('clears and collapses case and NFKC-equivalent tombstones on a manual re-add', async () => {
    await db.tagMeta.bulkPut([
      {
        name: 'UI',
        dimension: null,
        color: '#111111',
        excluded: true,
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

    await idbTagStore.setTagsBulk([
      { full_name: 'c/new', tags: ['ui'] },
    ]);

    const aliases = (await db.tagMeta.toArray())
      .filter((meta) => meta.name.trim().normalize('NFKC').toLocaleLowerCase('en-US') === 'ui');
    assert.deepEqual(aliases.map((meta) => ({
      name: meta.name,
      dimension: meta.dimension,
      color: meta.color,
      excluded: meta.excluded,
    })), [{
      name: 'ui',
      dimension: 'interface',
      color: '#111111',
      excluded: false,
    }]);
    assert.deepEqual((await db.tags.get('c/new'))?.manualTags, ['ui']);
    assert.equal(snapshotDirty().meta, true);
  });

  it('clears a differently-spelled tombstone through the single-repository path', async () => {
    await db.tagMeta.bulkPut([
      {
        name: 'ＵＩ',
        dimension: 'interface',
        color: '#111111',
        excluded: true,
        mtime: '2026-07-02T00:00:00Z',
      },
    ]);

    await idbTagStore.setTags('c/new', ['UI']);

    assert.equal(await db.tagMeta.get('ＵＩ'), undefined);
    const meta = await db.tagMeta.get('UI');
    assert.equal(meta?.name, 'UI');
    assert.equal(meta?.dimension, 'interface');
    assert.equal(meta?.color, '#111111');
    assert.equal(meta?.excluded, false);
  });

  it('revives a manually submitted tag even when a hidden assignment already exists', async () => {
    await db.tags.put({
      full_name: 'hidden/single',
      manualTags: ['ＵＩ'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: '',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    });

    await idbTagStore.setTags('hidden/single', ['ＵＩ']);

    assert.deepEqual(await idbTagStore.listExcluded(), ['react']);
    assert.equal((await db.tagMeta.get('ＵＩ'))?.excluded, false);
    assert.equal(await db.tagMeta.get('ui'), undefined);
    assert.equal(snapshotDirty().meta, true);
  });

  it('revives hidden assignments in bulk without requiring a repository rewrite', async () => {
    await db.tags.put({
      full_name: 'hidden/bulk',
      manualTags: ['ＵＩ'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: '',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    });

    const result = await idbTagStore.setTagsBulk([
      { full_name: 'hidden/bulk', tags: ['ＵＩ'] },
    ]);

    assert.deepEqual(result, { updated: 0 });
    assert.equal((await db.tagMeta.get('ＵＩ'))?.excluded, false);
    assert.equal(await db.tagMeta.get('ui'), undefined);
    assert.equal(snapshotDirty().meta, true);
  });

  it('preserves tag order semantics while dirtying reordered manual updates', async () => {
    await db.tags.put({
      full_name: 'a/react',
      manualTags: ['react', 'ui'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: 'keep notes',
      favorite: true,
      mtime: '2026-07-01T00:00:00Z',
    });

    const result = await idbTagStore.setTagsBulk([
      { full_name: 'a/react', tags: ['ui', 'react'] },
    ]);

    assert.deepEqual(result, { updated: 1 });
    assert.deepEqual((await db.tags.get('a/react'))?.manualTags, ['ui', 'react']);
    assert.deepEqual(snapshotDirty().names.sort(), ['a/react']);
  });

  it('replaces only the auto layer in bulk and preserves manual state', async () => {
    const result = await idbTagStore.setAutoTagsBulk([
      { full_name: 'a/react', autoTags: ['ui', 'react'] },
      { full_name: 'b/infra', autoTags: [] },
    ]);

    assert.deepEqual(result, { updated: 1 });
    const react = await db.tags.get('a/react');
    assert.deepEqual(react?.manualTags, ['react']);
    assert.deepEqual(react?.autoTags, []);
    assert.deepEqual(react?.dismissedAutoTags, ['ui']);
    assert.equal(react?.notes, 'keep notes');
    assert.deepEqual(snapshotDirty().names.sort(), ['a/react']);
  });

  it('records manually removed tags as dismissed so auto bulk cannot restore them', async () => {
    await db.tags.put({
      full_name: 'manual/topic-row',
      manualTags: ['react', 'ui'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: '',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    });

    await idbTagStore.setTags('manual/topic-row', ['react']);
    await idbTagStore.setAutoTagsBulk([{ full_name: 'manual/topic-row', autoTags: ['ui'] }]);

    const row = await idbTagStore.get('manual/topic-row');
    assert.deepEqual(row?.manualTags, ['react']);
    assert.deepEqual(row?.autoTags, []);
    assert.deepEqual(row?.dismissedAutoTags, ['ui']);
    assert.deepEqual(visibleTagNames(row), ['react']);
  });

  it('keeps existing dismissals when replacing only the auto layer', async () => {
    await idbTagStore.setTags('a/react', ['react']);
    await idbTagStore.setAutoTagsBulk([{ full_name: 'a/react', autoTags: ['ui', 'hooks'] }]);

    const react = await idbTagStore.get('a/react');
    assert.deepEqual(react?.manualTags, ['react']);
    assert.deepEqual(react?.autoTags, ['hooks']);
    assert.deepEqual(react?.dismissedAutoTags, ['ui']);
    assert.deepEqual(visibleTagNames(react), ['react', 'hooks']);
  });

  it('does not restore a globally deleted tag through an NFKC-equivalent auto update', async () => {
    await db.tags.put({
      full_name: 'auto/full-width',
      manualTags: [],
      autoTags: ['ＵＩ'],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-07-01T00:00:00Z',
      autoTagsMtime: '2026-07-01T00:00:00Z',
      dismissedAutoTagsMtime: '2026-07-01T00:00:00Z',
      notes: '',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    });
    await idbTagStore.deleteTagsEverywhere(['ui']);

    await idbTagStore.setAutoTagsBulk([
      { full_name: 'auto/full-width', autoTags: ['ui'] },
    ]);

    const row = await db.tags.get('auto/full-width');
    assert.deepEqual(row?.autoTags, []);
    assert.deepEqual(visibleTagNames(row), []);
  });

  it('allows auto tags when a newer canonical metadata alias cleared an old tombstone', async () => {
    await db.tagMeta.bulkPut([
      {
        name: 'ＵＩ',
        dimension: null,
        color: null,
        excluded: true,
        mtime: '2026-07-01T00:00:00Z',
      },
      {
        name: 'ui',
        dimension: null,
        color: null,
        excluded: false,
        mtime: '2026-07-02T00:00:00Z',
      },
    ]);

    await idbTagStore.setAutoTagsBulk([
      { full_name: 'c/new', autoTags: ['UI'] },
    ]);

    assert.deepEqual((await db.tags.get('c/new'))?.autoTags, ['UI']);
    assert.deepEqual(await idbTagStore.listExcluded(), ['react']);
  });

  it('records manually removed legacy tags as dismissed so auto bulk cannot restore them', async () => {
    await db.table('tags').put({
      full_name: 'legacy/topic-row',
      tags: ['topic'],
      notes: '',
      favorite: false,
      mtime: '2026-07-01T00:00:00Z',
    } satisfies LegacyTagRow);

    await idbTagStore.setTags('legacy/topic-row', []);
    await idbTagStore.setAutoTagsBulk([{ full_name: 'legacy/topic-row', autoTags: ['topic'] }]);

    const row = await idbTagStore.get('legacy/topic-row');
    assert.deepEqual(row?.manualTags, []);
    assert.deepEqual(row?.autoTags, []);
    assert.deepEqual(row?.dismissedAutoTags, ['topic']);
    assert.deepEqual(visibleTagNames(row), []);
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

    assert.deepEqual((await db.tags.get('a/react'))?.manualTags, ['react']);
    const infra = await db.table('tags').get('b/infra') as LegacyTagRow | undefined;
    assert.deepEqual(visibleTagNames(infra ? normalizeStoredTag(infra) : undefined), ['infra']);
    assert.equal((await db.tagMeta.get('ui'))?.excluded, true);
    assert.deepEqual(snapshotDirty(), dirtyBefore);
  });
});
