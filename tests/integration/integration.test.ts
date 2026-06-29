import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { db } from '../../src/storage/db';
import { queryStars, invalidateCache } from '../../src/background/query';
import type { Star, Tag, TagMeta } from '../../src/types';

const base = {
  html_url: 'https://github.com/x',
  description: '',
  language: null as string | null,
  stargazers_count: 0,
  topics: [] as string[],
  pushed_at: '',
  fork: false,
  archived: false,
  latest_release_at: null as string | null,
  latest_release_synced_at: null as string | null,
  tombstone: false,
  synced_at: '',
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.stars.bulkPut([
    {
      ...base,
      full_name: 'a/ai',
      description: 'AI tool',
      language: 'Python',
      topics: ['ai'],
      starred_at: '2026-06-20',
      stargazers_count: 100,
      pushed_at: '2026-06-19',
      latest_release_at: '2026-05-10',
      latest_release_synced_at: '2026-06-22T00:00:00Z',
    },
    {
      ...base,
      full_name: 'b/rust',
      description: 'Rust lib',
      language: 'Rust',
      topics: [],
      starred_at: '2026-06-21',
      stargazers_count: 50,
      pushed_at: '2026-06-22',
      latest_release_at: '2026-06-18',
      latest_release_synced_at: '2026-06-22T00:00:00Z',
      archived: true,
    },
    {
      ...base,
      full_name: 'c/gone',
      description: 'unstarred',
      language: 'Python',
      topics: [],
      starred_at: '2026-01-01',
      stargazers_count: 5,
      pushed_at: '2025-01-01',
      latest_release_at: null,
      latest_release_synced_at: '2026-06-22T00:00:00Z',
      tombstone: true,
    },
  ] as Star[]);
  await db.tags.bulkPut([
    { full_name: 'a/ai', tags: ['ai'], notes: '', mtime: '2026-06-22T10:00:00Z' },
    { full_name: 'b/rust', tags: ['rust'], notes: 'fast', favorite: true, mtime: '2026-06-22T10:00:00Z' },
  ] as Tag[]);
  await db.tagMeta.bulkPut([
    { name: 'ai', dimension: '领域', color: null, mtime: '2026-06-22T10:00:00Z' },
  ] as TagMeta[]);
  invalidateCache();
});

afterAll(async () => {
  await db.close();
});

function defaultFilter() {
  return {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any' as const,
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at' as const,
    sortDir: 'desc' as const,
  };
}

describe('Integration (real query engine + Dexie)', () => {
  it('returns all live rows by default', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert.equal(r.grandTotal, 3);
    assert.equal(r.total, 2);
  });

  it('language facet computed over all stars', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert.deepEqual(r.languages.find(([l]) => l === 'Python'), ['Python', 2]);
  });

  it('tag tree is a flat list with counts (no dimension)', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    const ai = r.tagTree.find((t) => t.name === 'ai');
    assert.ok(ai);
    assert.equal(ai.count, 1);
    assert.equal('dim' in ai, false);
  });

  it('filter by language', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), languages: ['Rust'] },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
  });

  it('full-text search', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), query: 'AI' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['a/ai']);
  });

  it('full-text search includes notes', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), query: 'fast' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
  });

  it('filter by tag', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), tags: ['rust'] },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
  });

  it('onlyFavorite keeps favorited repos only', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), onlyFavorite: true },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
    assert.equal(r.tagsForRows['b/rust']?.favorite, true);
  });

  it('onlyArchived keeps archived repos only', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), onlyArchived: true },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
    assert.equal(r.rows[0]?.archived, true);
  });

  it('sort by stargazers desc', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), sortKey: 'stargazers_count', sortDir: 'desc' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.stargazers_count), [100, 50]);
  });

  it('sort by latest release date keeps null releases last', async () => {
    await db.stars.put({
      ...base,
      full_name: 'd/no-release',
      description: 'no release yet',
      language: 'Go',
      topics: [],
      starred_at: '2026-06-22',
      stargazers_count: 20,
      pushed_at: '2026-06-22',
      latest_release_at: null,
      latest_release_synced_at: '2026-06-22T00:00:00Z',
    } as Star);
    await db.stars.put({
      ...base,
      full_name: 'e/legacy',
      description: 'legacy missing fields',
      language: 'JavaScript',
      topics: [],
      starred_at: '2026-06-23',
      stargazers_count: 2,
      pushed_at: '2026-06-23',
      latest_release_at: undefined,
      latest_release_synced_at: undefined,
    } as unknown as Star);
    invalidateCache();
    const r = await queryStars({
      filter: { ...defaultFilter(), showTombstone: true, sortKey: 'latest_release_at', sortDir: 'desc' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust', 'a/ai', 'c/gone', 'd/no-release', 'e/legacy']);
  });

  it('offset/limit windowing', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), sortKey: 'stargazers_count', sortDir: 'asc' },
      offset: 0,
      limit: 1,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
    assert.equal(r.total, 2);
  });

  it('showTombstone includes unstarred', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), showTombstone: true },
      offset: 0,
      limit: 100,
    });
    assert.equal(r.total, 3);
  });

  it('cache invalidation picks up new writes', async () => {
    await db.stars.put({
      ...base,
      full_name: 'd/new',
      description: 'fresh',
      language: 'Go',
      topics: [],
      starred_at: '2026-06-23',
      stargazers_count: 1,
      pushed_at: '2026-06-23',
    } as Star);
    invalidateCache();
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert.equal(r.grandTotal, 4);
  });

  it('tagsForRows returned for the window', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), languages: ['Rust'] },
      offset: 0,
      limit: 100,
    });
    assert.equal(r.tagsForRows['b/rust']?.notes, 'fast');
  });
});
