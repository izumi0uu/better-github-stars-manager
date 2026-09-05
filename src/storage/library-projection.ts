import { db } from '@/storage/db';
import type { Star, Tag, TagMeta } from '@/types';

/**
 * The Stars library, tags, and tag metadata read once and shared by every
 * surface that joins against them.
 *
 * Stars, Following, Watch, and For You each read all three tables
 * independently, so opening a surface deserialized the whole library several
 * times over. One snapshot now serves all of them.
 *
 * Invalidation is automatic: a Dexie middleware drops the snapshot when any of
 * the three tables is written. Surfaces other than the Stars query never had a
 * cache and always observed the latest rows, so tracking writes preserves their
 * existing semantics. The Stars query keeps its own explicitly invalidated entry
 * on top of this one, because its staleness boundary is a tested contract.
 */
export type LibrarySnapshot = Readonly<{
  stars: readonly Star[];
  tags: readonly Tag[];
  tagMeta: readonly TagMeta[];
}>;

const LIBRARY_TABLES: Record<string, true> = {
  stars: true,
  tags: true,
  tagMeta: true,
};

let snapshot: LibrarySnapshot | null = null;
let pending: Promise<LibrarySnapshot> | null = null;

/** Drop the cached snapshot. Writes do this automatically; callers rarely need it. */
export function invalidateLibrarySnapshot(): void {
  snapshot = null;
  pending = null;
}

db.use({
  stack: 'dbcore',
  name: 'bgsm-library-snapshot-invalidation',
  create: (downlevel) => {
    // `create` runs on every connection, so a deleted-and-reopened database
    // cannot serve a snapshot captured from the previous one.
    invalidateLibrarySnapshot();
    return {
      ...downlevel,
      table: (tableName) => {
        const table = downlevel.table(tableName);
        if (!(tableName in LIBRARY_TABLES)) return table;
        return {
          ...table,
          mutate: (request) => {
            invalidateLibrarySnapshot();
            return table.mutate(request);
          },
        };
      },
    };
  },
});

/**
 * Concurrent surfaces opening at once share one read instead of racing three
 * table scans each.
 */
export function readLibrarySnapshot(): Promise<LibrarySnapshot> {
  if (snapshot) return Promise.resolve(snapshot);
  if (pending) return pending;
  const request = (async (): Promise<LibrarySnapshot> => {
    const [stars, tags, tagMeta] = await Promise.all([
      db.stars.toArray(),
      db.tags.toArray(),
      db.tagMeta.toArray(),
    ]);
    return { stars, tags, tagMeta };
  })();
  pending = request;
  return request.then(
    (result) => {
      // A write during the read clears `pending`; that result must not be cached.
      if (pending === request) {
        snapshot = result;
        pending = null;
      }
      return result;
    },
    (error) => {
      if (pending === request) pending = null;
      throw error;
    },
  );
}
