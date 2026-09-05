import Dexie, { type DBCoreTransaction } from 'dexie';
import { db } from '@/storage/db';
import type { Star, Tag, TagMeta } from '@/types';

/** One committed library snapshot shared by every surface. */
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
const listeners = new Set<() => void>();
const observedTransactions = new WeakMap<DBCoreTransaction, { changed: boolean }>();

/** Explicit resets do not publish a change; only committed writes do. */
export function invalidateLibrarySnapshot(): void {
  snapshot = null;
  pending = null;
}

export function subscribeLibraryChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

db.use({
  stack: 'dbcore',
  name: 'bgsm-library-snapshot-invalidation',
  create: (downlevel) => {
    // A reopened connection cannot reuse rows from the previous database.
    invalidateLibrarySnapshot();
    return {
      ...downlevel,
      transaction: (stores, mode, options) => {
        const transaction = downlevel.transaction(stores, mode, options);
        if (mode === 'readwrite' && stores.some((name) => name in LIBRARY_TABLES)) {
          const state = { changed: false };
          observedTransactions.set(transaction, state);
          // Register before Dexie installs its completion handler, so awaiting a
          // commit cannot resume before invalidation. Nested scopes share this
          // native transaction and cannot publish before their parent commits.
          (transaction as IDBTransaction).addEventListener('complete', () => {
            if (!state.changed) return;
            invalidateLibrarySnapshot();
            for (const listener of listeners) {
              try {
                listener();
              } catch (error) {
                // Delivery cannot change the outcome of a committed write.
                console.warn('Library change listener failed', error);
              }
            }
          }, { once: true });
        }
        return transaction;
      },
      table: (tableName) => {
        const table = downlevel.table(tableName);
        if (!(tableName in LIBRARY_TABLES)) return table;
        return {
          ...table,
          mutate: (request) => {
            const state = observedTransactions.get(request.trans);
            return table.mutate(request).then((result) => {
              const operationCount = request.type === 'deleteRange'
                ? 1
                : request.type === 'delete' ? request.keys.length : request.values.length;
              if (state && result.numFailures < operationCount) state.changed = true;
              return result;
            });
          },
        };
      },
    };
  },
});

async function readTables(): Promise<LibrarySnapshot> {
  const [stars, tags, tagMeta] = await Promise.all([
    db.stars.toArray(),
    db.tags.toArray(),
    db.tagMeta.toArray(),
  ]);
  return { stars, tags, tagMeta };
}

/** Concurrent committed readers share one consistent cross-table read. */
export function readLibrarySnapshot(): Promise<LibrarySnapshot> {
  // A transaction sees its own version, including speculative writes. Neither
  // consuming nor populating the shared cache is safe in that context.
  if (Dexie.currentTransaction) return readTables();
  if (!db.isOpen()) invalidateLibrarySnapshot();
  if (snapshot) return Promise.resolve(snapshot);
  if (pending) return pending;
  const request = db.transaction('r', [db.stars, db.tags, db.tagMeta], readTables);
  pending = request;
  return request.then(
    (result) => {
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
