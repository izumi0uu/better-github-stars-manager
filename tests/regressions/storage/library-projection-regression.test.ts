import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import {
  invalidateLibrarySnapshot,
  readLibrarySnapshot,
  subscribeLibraryChanges,
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

  it.each([false, true])('never caches rolled-back transaction reads (warm=%s)', async (warm) => {
    await db.stars.put(star('owner/committed'));
    const before = warm ? await readLibrarySnapshot() : null;
    const notify = vi.fn();
    const unsubscribe = subscribeLibraryChanges(notify);
    try {
      await expect(db.transaction('rw', [db.stars, db.tags, db.tagMeta], async () => {
        await db.stars.put(star('owner/speculative'));
        const local = await readLibrarySnapshot();
        expect(local.stars.map((row) => row.full_name)).toEqual([
          'owner/committed', 'owner/speculative',
        ]);
        expect(notify).not.toHaveBeenCalled();
        throw new Error('rollback library write');
      })).rejects.toThrow('rollback library write');

      const after = await readLibrarySnapshot();
      expect(after.stars.map((row) => row.full_name)).toEqual(['owner/committed']);
      if (before) expect(after).toBe(before);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('publishes once after the outer transaction commits and supports unsubscribe', async () => {
    const before = await readLibrarySnapshot();
    const publications: Promise<unknown>[] = [];
    const notify = vi.fn(() => { publications.push(readLibrarySnapshot()); });
    const unsubscribe = subscribeLibraryChanges(notify);
    try {
      await db.transaction('rw', [db.stars, db.tags, db.tagMeta], async () => {
        await db.stars.put(star('owner/committed'));
        await db.transaction('rw', [db.tags, db.tagMeta], async () => {
          await db.tags.put(tag('owner/committed'));
          await db.tagMeta.put(tagMeta('manual'));
        });
        expect(notify).not.toHaveBeenCalled();
      });
      expect(notify).toHaveBeenCalledTimes(1);
      const [published] = await Promise.all(publications);
      expect(published).not.toBe(before);
      expect(published).toMatchObject({
        stars: [star('owner/committed')],
        tags: [tag('owner/committed')],
        tagMeta: [tagMeta('manual')],
      });
      unsubscribe();
      await db.stars.put(star('owner/later'));
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('does not publish a nested write when its parent aborts', async () => {
    const notify = vi.fn();
    const unsubscribe = subscribeLibraryChanges(notify);
    try {
      await expect(db.transaction('rw', [db.stars, db.tags, db.tagMeta], async () => {
        await db.transaction('rw', db.tags, async () => {
          await db.tags.put(tag('owner/speculative'));
        });
        await readLibrarySnapshot();
        throw new Error('parent aborted');
      })).rejects.toThrow('parent aborted');
      expect(notify).not.toHaveBeenCalled();
      expect((await readLibrarySnapshot()).tags).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('ignores reads, explicit resets, empty writes and caught failed writes', async () => {
    await db.stars.put(star('owner/one'));
    const notify = vi.fn();
    const unsubscribe = subscribeLibraryChanges(notify);
    try {
      await readLibrarySnapshot();
      invalidateLibrarySnapshot();
      await readLibrarySnapshot();
      await db.stars.bulkPut([]);
      await db.transaction('rw', db.stars, async () => {
        await expect(db.stars.add(star('owner/one'))).rejects.toMatchObject({
          name: 'ConstraintError',
        });
      });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('publishes successful rows when a caught bulk failure still commits them', async () => {
    await db.stars.put(star('owner/one'));
    await readLibrarySnapshot();
    const notify = vi.fn();
    const unsubscribe = subscribeLibraryChanges(notify);
    try {
      await db.transaction('rw', db.stars, async () => {
        await expect(db.stars.bulkAdd([star('owner/one'), star('owner/two')])).rejects.toMatchObject({
          name: 'BulkError',
        });
      });
      expect(notify).toHaveBeenCalledTimes(1);
      expect((await readLibrarySnapshot()).stars.map((row) => row.full_name)).toEqual([
        'owner/one', 'owner/two',
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps committed changes and other subscribers visible when one delivery fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stopFailing = subscribeLibraryChanges(() => { throw new Error('delivery failed'); });
    const notify = vi.fn();
    const unsubscribe = subscribeLibraryChanges(notify);
    try {
      await db.stars.put(star('owner/committed'));
      expect(notify).toHaveBeenCalledTimes(1);
      expect((await readLibrarySnapshot()).stars.map((row) => row.full_name)).toEqual(['owner/committed']);
    } finally {
      stopFailing();
      unsubscribe();
      warning.mockRestore();
    }
  });

  it('reopens without reusing an old snapshot or publishing a write', async () => {
    await db.stars.put(star('owner/one'));
    const before = await readLibrarySnapshot();
    const notify = vi.fn();
    const unsubscribe = subscribeLibraryChanges(notify);
    try {
      db.close();
      await db.open();
      const reopened = await readLibrarySnapshot();
      expect(reopened).not.toBe(before);
      expect(reopened).toEqual(before);
      await db.delete();
      await db.open();
      expect((await readLibrarySnapshot()).stars).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
