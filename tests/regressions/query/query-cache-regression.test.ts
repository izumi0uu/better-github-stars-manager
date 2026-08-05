import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { invalidateCache, queryStars } from '../../../src/background/query';
import { db } from '../../../src/storage/db';
import { visibleTagNames } from '../../../src/tags/tag-model';
import type { Star, Tag, TagMeta } from '../../../src/types';

const baseStar = {
  html_url: 'https://github.com/example/repo',
  description: '',
  language: null as string | null,
  stargazers_count: 0,
  topics: [] as string[],
  pushed_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z' as string | null,
  fork: false,
  archived: false,
  tombstone: false,
  synced_at: '2026-01-01T00:00:00Z',
};

function star(overrides: Partial<Star> & Pick<Star, 'full_name' | 'starred_at'>): Star {
  return {
    ...baseStar,
    ...overrides,
  };
}

function tag(full_name: string, tags: string[], overrides: Partial<Tag> = {}): Tag {
  return {
    full_name,
    manualTags: tags,
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: '2026-01-01T00:00:00Z',
    autoTagsMtime: '2026-01-01T00:00:00Z',
    dismissedAutoTagsMtime: '2026-01-01T00:00:00Z',
    notes: '',
    favorite: false,
    mtime: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function tagMeta(name: string, overrides: Partial<TagMeta> = {}): TagMeta {
  return {
    name,
    dimension: null,
    color: null,
    mtime: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function filter() {
  return {
    query: '',
    languages: [] as string[],
    tags: [] as string[],
    tagMode: 'any' as const,
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'name' as const,
    sortDir: 'asc' as const,
  };
}

async function resetDb() {
  await db.delete();
  await db.open();
  invalidateCache();
}

async function putFixtures({
  stars = [],
  tags = [],
  tagMeta = [],
}: {
  stars?: Star[];
  tags?: Tag[];
  tagMeta?: TagMeta[];
}) {
  if (stars.length) await db.stars.bulkPut(stars);
  if (tags.length) await db.tags.bulkPut(tags);
  if (tagMeta.length) await db.tagMeta.bulkPut(tagMeta);
  invalidateCache();
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await db.close();
});

describe('Query cache and semantics regressions', () => {
  it('keeps direct DB mutations stale until the query cache is invalidated', async () => {
    await putFixtures({
      stars: [
        star({
          full_name: 'a/original',
          starred_at: '2026-01-01T00:00:00Z',
          language: 'TypeScript',
        }),
      ],
    });

    const beforeMutation = await queryStars({ filter: filter(), offset: 0, limit: 20 });
    assert.deepEqual(beforeMutation.rows.map((row) => row.full_name), ['a/original']);
    assert.equal(beforeMutation.grandTotal, 1);

    await db.stars.put(star({
      full_name: 'b/direct-insert',
      starred_at: '2026-01-02T00:00:00Z',
      language: 'Rust',
    }));

    const withoutInvalidation = await queryStars({ filter: filter(), offset: 0, limit: 20 });
    assert.deepEqual(withoutInvalidation.rows.map((row) => row.full_name), ['a/original']);
    assert.equal(withoutInvalidation.grandTotal, 1);

    invalidateCache();
    const afterInvalidation = await queryStars({ filter: filter(), offset: 0, limit: 20 });
    assert.deepEqual(afterInvalidation.rows.map((row) => row.full_name), ['a/original', 'b/direct-insert']);
    assert.equal(afterInvalidation.grandTotal, 2);
  });

  it('hydrates tags only for rows in the returned pagination window', async () => {
    await putFixtures({
      stars: [
        star({ full_name: 'a/alpha', starred_at: '2026-01-01T00:00:00Z' }),
        star({ full_name: 'b/bravo', starred_at: '2026-01-02T00:00:00Z' }),
        star({ full_name: 'c/charlie', starred_at: '2026-01-03T00:00:00Z' }),
      ],
      tags: [
        tag('a/alpha', ['first']),
        tag('b/bravo', ['second'], { notes: 'visible page' }),
        tag('c/charlie', ['third']),
      ],
    });

    const result = await queryStars({
      filter: { ...filter(), sortKey: 'name', sortDir: 'asc' },
      offset: 1,
      limit: 1,
    });

    assert.equal(result.total, 3);
    assert.deepEqual(result.rows.map((row) => row.full_name), ['b/bravo']);
    assert.deepEqual(Object.keys(result.tagsForRows), ['b/bravo']);
    assert.deepEqual(visibleTagNames(result.tagsForRows['b/bravo']), ['second']);
    assert.equal(result.tagsForRows['b/bravo']?.notes, 'visible page');
  });

  it('sorts missing repository creation dates last in both directions and tie-breaks all-null rows by full name', async () => {
    await putFixtures({
      stars: [
        star({ full_name: 'z/null-last', starred_at: '2026-01-01T00:00:00Z', created_at: null }),
        star({ full_name: 'b/older', starred_at: '2026-01-02T00:00:00Z', created_at: '2020-01-01T00:00:00Z' }),
        star({ full_name: 'a/null-first', starred_at: '2026-01-03T00:00:00Z', created_at: null }),
        star({ full_name: 'c/newer', starred_at: '2026-01-04T00:00:00Z', created_at: '2022-01-01T00:00:00Z' }),
      ],
    });

    const asc = await queryStars({
      filter: { ...filter(), sortKey: 'created_at', sortDir: 'asc' },
      offset: 0,
      limit: 20,
    });
    assert.deepEqual(asc.rows.map((row) => row.full_name), ['b/older', 'c/newer', 'a/null-first', 'z/null-last']);

    const desc = await queryStars({
      filter: { ...filter(), sortKey: 'created_at', sortDir: 'desc' },
      offset: 0,
      limit: 20,
    });
    assert.deepEqual(desc.rows.map((row) => row.full_name), ['c/newer', 'b/older', 'a/null-first', 'z/null-last']);
  });

  it('tie-breaks all-null repository creation date sorts by full name in both directions', async () => {
    await putFixtures({
      stars: [
        star({ full_name: 'z/null-third', starred_at: '2026-01-01T00:00:00Z', created_at: null }),
        star({ full_name: 'a/null-first', starred_at: '2026-01-02T00:00:00Z', created_at: null }),
        star({ full_name: 'm/null-second', starred_at: '2026-01-03T00:00:00Z', created_at: null }),
      ],
    });

    const asc = await queryStars({
      filter: { ...filter(), sortKey: 'created_at', sortDir: 'asc' },
      offset: 0,
      limit: 20,
    });
    assert.deepEqual(asc.rows.map((row) => row.full_name), ['a/null-first', 'm/null-second', 'z/null-third']);

    const desc = await queryStars({
      filter: { ...filter(), sortKey: 'created_at', sortDir: 'desc' },
      offset: 0,
      limit: 20,
    });
    assert.deepEqual(desc.rows.map((row) => row.full_name), ['a/null-first', 'm/null-second', 'z/null-third']);
  });

  it('omits excluded tag metadata from tag facets while facet counts remain all-data', async () => {
    await putFixtures({
      stars: [
        star({ full_name: 'a/python-visible', starred_at: '2026-01-01T00:00:00Z', language: 'Python' }),
        star({ full_name: 'b/rust-filtered', starred_at: '2026-01-02T00:00:00Z', language: 'Rust' }),
        star({ full_name: 'c/go-filtered', starred_at: '2026-01-03T00:00:00Z', language: 'Go' }),
      ],
      tags: [
        tag('a/python-visible', ['kept', 'deleted']),
        tag('b/rust-filtered', ['kept']),
        tag('c/go-filtered', ['filtered-only', 'deleted']),
      ],
      tagMeta: [
        tagMeta('deleted', { excluded: true }),
        tagMeta('kept'),
        tagMeta('filtered-only'),
      ],
    });

    const result = await queryStars({
      filter: { ...filter(), languages: ['Python'] },
      offset: 0,
      limit: 20,
    });

    assert.deepEqual(result.rows.map((row) => row.full_name), ['a/python-visible']);
    assert.deepEqual(result.languages, [['Python', 1], ['Rust', 1], ['Go', 1]]);
    assert.deepEqual(result.tagTree, [
      { name: 'kept', count: 2 },
      { name: 'filtered-only', count: 1 },
    ]);
    assert.equal(result.tagTotal, 2);
  });

  it('uses canonical tag identity for excluded facets and tag filters', async () => {
    await putFixtures({
      stars: [
        star({ full_name: 'a/full-width', starred_at: '2026-01-01T00:00:00Z' }),
        star({ full_name: 'b/ascii', starred_at: '2026-01-02T00:00:00Z' }),
      ],
      tags: [
        tag('a/full-width', ['ＵＩ']),
        tag('b/ascii', ['Agent']),
      ],
      tagMeta: [
        tagMeta('ui', { excluded: true }),
        tagMeta('agent'),
      ],
    });

    const result = await queryStars({
      filter: { ...filter(), tags: ['ＡＧＥＮＴ'] },
      offset: 0,
      limit: 20,
    });

    assert.deepEqual(result.rows.map((row) => row.full_name), ['b/ascii']);
    assert.deepEqual(result.tagTree, [{ name: 'Agent', count: 1 }]);
    assert.equal(result.tagTotal, 1);
  });

  it('treats stale excluded assignments as untagged and never matches them as filters', async () => {
    await putFixtures({
      stars: [star({
        full_name: 'a/stale-deleted-tag',
        starred_at: '2026-01-01T00:00:00Z',
      })],
      tags: [tag('a/stale-deleted-tag', ['ui'])],
      tagMeta: [tagMeta('ＵＩ', { excluded: true })],
    });

    const untagged = await queryStars({
      filter: { ...filter(), onlyUntagged: true },
      offset: 0,
      limit: 20,
    });
    const filtered = await queryStars({
      filter: { ...filter(), tags: ['UI'] },
      offset: 0,
      limit: 20,
    });

    assert.deepEqual(untagged.rows.map((row) => row.full_name), ['a/stale-deleted-tag']);
    assert.deepEqual(visibleTagNames(untagged.tagsForRows['a/stale-deleted-tag']), []);
    assert.deepEqual(filtered.rows, []);
  });

  it('uses the newest canonical metadata state when an older alias is excluded', async () => {
    await putFixtures({
      stars: [star({
        full_name: 'a/re-added-tag',
        starred_at: '2026-01-01T00:00:00Z',
      })],
      tags: [tag('a/re-added-tag', ['UI'])],
      tagMeta: [
        tagMeta('ＵＩ', { excluded: true, mtime: '2026-01-01T00:00:00Z' }),
        tagMeta('ui', { excluded: false, mtime: '2026-01-02T00:00:00Z' }),
      ],
    });

    const result = await queryStars({
      filter: { ...filter(), tags: ['ui'] },
      offset: 0,
      limit: 20,
    });

    assert.deepEqual(result.rows.map((row) => row.full_name), ['a/re-added-tag']);
    assert.deepEqual(result.tagTree, [{ name: 'UI', count: 1 }]);
  });
});
