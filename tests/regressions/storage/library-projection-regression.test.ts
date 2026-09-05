import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import {
  invalidateLibrarySnapshot,
  readLibrarySnapshot,
} from '@/storage/library-projection';
import type { Star, Tag, TagMeta } from '@/types';

const NOW = '2026-08-10T10:00:00.000Z';

function star(fullName: string, overrides: Partial<Star> = {}): Star {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: 'description',
    language: 'TypeScript',
    stargazers_count: 10,
    topics: [],
    pushed_at: NOW,
    created_at: '2020-01-01T00:00:00Z',
    fork: false,
    archived: false,
    starred_at: NOW,
    tombstone: false,
    synced_at: NOW,
    ...overrides,
  } as Star;
}

function tag(fullName: string): Tag {
  return {
    full_name: fullName,
    manualTags: ['manual'],
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: NOW,
    autoTagsMtime: NOW,
    dismissedAutoTagsMtime: NOW,
    notes: '',
    favorite: false,
    mtime: NOW,
  };
}

function tagMeta(name: string): TagMeta {
  return { name, dimension: null, color: null, excluded: false, mtime: NOW };
}

describe('Library projection snapshot', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    invalidateLibrarySnapshot();
  });

  afterAll(() => {
    db.close();
  });

  it('serves repeated reads from one snapshot instance', async () => {
    await db.stars.bulkPut([star('owner/one'), star('owner/two')]);

    const first = await readLibrarySnapshot();
    const second = await readLibrarySnapshot();

    expect(second).toBe(first);
    expect(first.stars.map((row) => row.full_name)).toEqual(['owner/one', 'owner/two']);
  });

  it('shares one read across concurrent callers', async () => {
    await db.stars.put(star('owner/one'));

    const [first, second, third] = await Promise.all([
      readLibrarySnapshot(),
      readLibrarySnapshot(),
      readLibrarySnapshot(),
    ]);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it.each([
    ['stars', async () => { await db.stars.put(star('owner/added')); }],
    ['tags', async () => { await db.tags.put(tag('owner/added')); }],
    ['tagMeta', async () => { await db.tagMeta.put(tagMeta('added')); }],
  ])('drops the snapshot when %s is written', async (_label, write) => {
    await db.stars.put(star('owner/one'));
    const before = await readLibrarySnapshot();

    await write();
    const after = await readLibrarySnapshot();

    expect(after).not.toBe(before);
  });

  it('observes deletes and clears, not only inserts', async () => {
    await db.stars.bulkPut([star('owner/one'), star('owner/two')]);
    expect((await readLibrarySnapshot()).stars).toHaveLength(2);

    await db.stars.delete('owner/two');
    expect((await readLibrarySnapshot()).stars.map((row) => row.full_name)).toEqual(['owner/one']);

    await db.stars.clear();
    expect((await readLibrarySnapshot()).stars).toEqual([]);
  });

  it('keeps a write during an in-flight read out of the cache', async () => {
    await db.stars.put(star('owner/one'));

    const inFlight = readLibrarySnapshot();
    await db.stars.put(star('owner/two'));
    await inFlight;

    // The interleaved write invalidated the pending result, so the next read
    // must go back to IndexedDB rather than serve the stale snapshot.
    const next = await readLibrarySnapshot();
    expect(next.stars.map((row) => row.full_name).sort()).toEqual(['owner/one', 'owner/two']);
  });

  it('does not drop the snapshot when an unrelated table is written', async () => {
    await db.stars.put(star('owner/one'));
    const before = await readLibrarySnapshot();

    await db.radarActivities.put({
      id: 'activity-1',
      accountLogin: 'viewer',
      actorLogin: 'friend',
      actorAvatarUrl: null,
      repositoryKey: 'owner/one',
      repositoryFullName: 'owner/one',
      repositoryDisplayName: 'owner/one',
      repositoryHtmlUrl: 'https://github.com/owner/one',
      repositoryDescription: '',
      repositoryLanguage: null,
      repositoryLanguageColor: null,
      repositoryTopics: [],
      repositoryStargazerCount: 0,
      viewerHadStarred: false,
      starredAt: NOW,
      dismissedAt: null,
      seenAt: null,
    });

    expect(await readLibrarySnapshot()).toBe(before);
  });
});
