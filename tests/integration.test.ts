// Integration test: runs the real query engine + Dexie against fake-indexeddb
// (exercises src code paths, not a mirror copy).
//
// Run: pnpm exec tsx tests/integration.test.ts
import 'fake-indexeddb/auto';
import { db } from '../src/storage/db';
import { queryStars, invalidateCache } from '../src/background/query';
import type { Star, Tag, TagMeta } from '../src/types';

const pass: string[] = [];
const fail: string[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve(fn())
    .then(() => { pass.push(name); console.log(`  ✓ ${name}`); })
    .catch((e) => { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`); });
}
function assert(c: unknown, msg: string) { if (!c) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const base = {
  html_url: 'https://github.com/x', description: '', language: null as string | null,
  stargazers_count: 0, topics: [] as string[], pushed_at: '', fork: false, archived: false,
  tombstone: false, synced_at: '',
};

await db.stars.bulkPut([
  { ...base, full_name: 'a/ai', description: 'AI tool', language: 'Python', topics: ['ai'], starred_at: '2026-06-20', stargazers_count: 100, pushed_at: '2026-06-19' },
  { ...base, full_name: 'b/rust', description: 'Rust lib', language: 'Rust', topics: [], starred_at: '2026-06-21', stargazers_count: 50, pushed_at: '2026-06-22' },
  { ...base, full_name: 'c/gone', description: 'unstarred', language: 'Python', topics: [], starred_at: '2026-01-01', stargazers_count: 5, pushed_at: '2025-01-01', tombstone: true },
] as Star[]);
await db.tags.bulkPut([
  { full_name: 'a/ai', tags: ['ai'], notes: '', mtime: '2026-06-22T10:00:00Z' },
  { full_name: 'b/rust', tags: ['rust'], notes: 'fast', favorite: true, mtime: '2026-06-22T10:00:00Z' },
] as Tag[]);
await db.tagMeta.bulkPut([
  { name: 'ai', dimension: '领域', color: null, mtime: '2026-06-22T10:00:00Z' },
] as TagMeta[]);

console.log('Integration (real query engine + Dexie):');

await new Promise<void>((resolve) => {
  test('returns all live rows by default', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert(r.grandTotal === 3, `grandTotal ${r.grandTotal}`);
    assert(r.total === 2, `total (excl tombstone) ${r.total}`); // tombstone hidden
  });

  test('language facet computed over all stars', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    eq(r.languages.find(([l]) => l === 'Python'), ['Python', 2], 'python count'); // 2 (incl tombstone)
  });

  test('tag tree is a flat list with counts (no dimension)', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    const ai = r.tagTree.find((t) => t.name === 'ai');
    assert(ai && ai.count === 1, `ai count: ${JSON.stringify(ai)}`);
    assert(!('dim' in ai), `tag tree must not carry dim: ${JSON.stringify(ai)}`);
  });

  test('filter by language', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), languages: ['Rust'] }, offset: 0, limit: 100 });
    eq(r.rows.map((s) => s.full_name), ['b/rust'], 'rust only');
  });

  test('full-text search', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), query: 'AI' }, offset: 0, limit: 100 });
    eq(r.rows.map((s) => s.full_name), ['a/ai'], 'search AI');
  });

  test('full-text search includes notes', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), query: 'fast' }, offset: 0, limit: 100 });
    eq(r.rows.map((s) => s.full_name), ['b/rust'], 'search notes');
  });

  test('filter by tag', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), tags: ['rust'] }, offset: 0, limit: 100 });
    eq(r.rows.map((s) => s.full_name), ['b/rust'], 'tag rust');
  });

  test('onlyFavorite keeps favorited repos only', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), onlyFavorite: true }, offset: 0, limit: 100 });
    eq(r.rows.map((s) => s.full_name), ['b/rust'], 'favorite only');
    assert(r.tagsForRows['b/rust']?.favorite === true, 'favorite carried through');
  });

  test('sort by stargazers desc', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), sortKey: 'stargazers_count', sortDir: 'desc' }, offset: 0, limit: 100 });
    eq(r.rows.map((s) => s.stargazers_count), [100, 50], 'desc stars');
  });

  test('offset/limit windowing', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), sortKey: 'stargazers_count', sortDir: 'asc' }, offset: 0, limit: 1 });
    eq(r.rows.map((s) => s.full_name), ['b/rust'], 'first window');
    eq(r.total, 2, 'total still full');
  });

  test('showTombstone includes unstarred', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), showTombstone: true }, offset: 0, limit: 100 });
    eq(r.total, 3, 'includes tombstone');
  });

  test('cache invalidation picks up new writes', async () => {
    await db.stars.put({ ...base, full_name: 'd/new', description: 'fresh', language: 'Go', topics: [], starred_at: '2026-06-23', stargazers_count: 1, pushed_at: '2026-06-23' } as Star);
    invalidateCache();
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert(r.grandTotal === 4, `grandTotal after add ${r.grandTotal}`);
  });

  test('tagsForRows returned for the window', async () => {
    const r = await queryStars({ filter: { ...defaultFilter(), languages: ['Rust'] }, offset: 0, limit: 100 });
    assert(r.tagsForRows['b/rust']?.notes === 'fast', 'notes carried through');
  });

  // resolve after microtasks flush
  setTimeout(resolve, 100);
});

await new Promise((r) => setTimeout(r, 200));
console.log(fail.length ? `\n❌ ${fail.length} FAILED` : '\n✅ All integration tests passed');
process.exit(fail.length ? 1 : 0);

function defaultFilter() {
  return { query: '', languages: [], tags: [], tagMode: 'any' as const, showTombstone: false, onlyFavorite: false, onlyUntagged: false, sortKey: 'starred_at' as const, sortDir: 'desc' as const };
}
