// Pure-logic verification of the two correctness-critical algorithms:
// 1. Per-repo timestamp merge used by Gist sync.
// 2. Star filtering/sorting — query engine core.
//
// Run: node --experimental-strip-types tests/logic.test.ts
// (Node 24 strips types natively.)

import assert from 'node:assert';

// --- LWW merge logic (mirrors src/sync/gist-tag-store.ts pull()) ---
// Two devices edited DIFFERENT repos; merge must keep both, taking newer mtime per repo.
function lwwMerge(local: Map<string, { tags: string[]; mtime: string }>, remote: Record<string, { tags: string[]; mtime: string }>): { merged: number; result: Map<string, { tags: string[]; mtime: string }> } {
  let merged = 0;
  for (const [name, remoteTag] of Object.entries(remote)) {
    const l = local.get(name);
    if (!l || remoteTag.mtime > l.mtime) {
      local.set(name, remoteTag);
      merged++;
    }
  }
  return { merged, result: local };
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

console.log('Timestamp merge:');
test('device A edits repo1, device B edits repo2 → both kept', () => {
  const local = new Map([
    ['a/repo1', { tags: ['x'], mtime: '2026-06-22T10:00:00Z' }],
    ['a/repo2', { tags: [], mtime: '2026-06-22T09:00:00Z' }],
  ]);
  const remote = {
    'a/repo1': { tags: ['x', 'ai'], mtime: '2026-06-22T11:00:00Z' }, // newer → wins
    'a/repo2': { tags: ['rust'], mtime: '2026-06-22T09:30:00Z' }, // newer than local 09:00 → wins
  };
  const { result } = lwwMerge(local, remote);
  assert.deepEqual(result.get('a/repo1')!.tags, ['x', 'ai']);
  assert.deepEqual(result.get('a/repo2')!.tags, ['rust']);
});

test('local newer than remote → local kept', () => {
  const local = new Map([['a/r', { tags: ['local'], mtime: '2026-06-22T12:00:00Z' }]]);
  const remote = { 'a/r': { tags: ['remote'], mtime: '2026-06-22T10:00:00Z' } };
  lwwMerge(local, remote);
  assert.deepEqual(local.get('a/r')!.tags, ['local']);
});

test('remote-only repo → added to local', () => {
  const local = new Map();
  const remote = { 'a/new': { tags: ['fresh'], mtime: '2026-06-22T10:00:00Z' } };
  const { merged } = lwwMerge(local, remote);
  assert.equal(merged, 1);
  assert.deepEqual(local.get('a/new')!.tags, ['fresh']);
});

// --- Filter logic (mirrors query.ts filter) ---
interface S { full_name: string; description: string; language: string | null; topics: string[]; tombstone: boolean; starred_at: string; pushed_at: string; stargazers_count: number; }

function filterStars(stars: S[], opts: { query?: string; languages?: string[]; tags?: string[]; showTombstone?: boolean; onlyUntagged?: boolean; tagsByRepo?: Map<string, string[]> }): S[] {
  const q = (opts.query ?? '').toLowerCase();
  const langSet = opts.languages?.length ? new Set(opts.languages) : null;
  const tagSet = opts.tags?.length ? new Set(opts.tags) : null;
  return stars.filter((s) => {
    if (!opts.showTombstone && s.tombstone) return false;
    if (langSet && (s.language === null || !langSet.has(s.language))) return false;
    const myTags = opts.tagsByRepo?.get(s.full_name) ?? [];
    if (opts.onlyUntagged && myTags.length > 0) return false;
    if (tagSet && !myTags.some((t) => tagSet.has(t))) return false;
    if (q) {
      const hay = `${s.full_name} ${s.description} ${s.topics.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

console.log('\nFilter logic (query engine):');
const sample: S[] = [
  { full_name: 'a/ai-tool', description: 'AI helper', language: 'Python', topics: ['ai', 'agent'], tombstone: false, starred_at: '2026-06-20', pushed_at: '2026-06-19', stargazers_count: 100 },
  { full_name: 'b/rust-lib', description: 'A rust lib', language: 'Rust', topics: [], tombstone: false, starred_at: '2026-06-21', pushed_at: '2026-06-22', stargazers_count: 50 },
  { full_name: 'c/old', description: 'archived thing', language: 'Python', topics: [], tombstone: true, starred_at: '2026-01-01', pushed_at: '2025-01-01', stargazers_count: 5 },
];
const tagsByRepo = new Map([['a/ai-tool', ['ai']], ['b/rust-lib', ['rust']]]);

test('hide tombstone by default', () => {
  assert.equal(filterStars(sample, {}).length, 2);
});
test('show tombstone when asked', () => {
  assert.equal(filterStars(sample, { showTombstone: true }).length, 3);
});
test('filter by language Python', () => {
  const r = filterStars(sample, { languages: ['Python'] });
  assert.equal(r.length, 1);
  assert.equal(r[0].full_name, 'a/ai-tool');
});
test('full-text search hits topics', () => {
  const r = filterStars(sample, { query: 'agent' });
  assert.equal(r.length, 1);
  assert.equal(r[0].full_name, 'a/ai-tool');
});
test('filter by tag', () => {
  const r = filterStars(sample, { tags: ['rust'], tagsByRepo });
  assert.equal(r.length, 1);
  assert.equal(r[0].full_name, 'b/rust-lib');
});
test('onlyUntagged excludes tagged', () => {
  const r = filterStars(sample, { onlyUntagged: true, tagsByRepo });
  assert.equal(r.length, 0); // both live repos are tagged
});

console.log('\nAuto-suggest:');
function suggestTags(star: S, existing: string[]): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const out: string[] = [];
  if (star.language && !have.has(star.language.toLowerCase())) out.push(star.language);
  for (const t of star.topics) if (!have.has(t.toLowerCase())) out.push(t);
  return out.slice(0, 5);
}
test('suggests language + topics not already tagged', () => {
  const s = suggestTags(sample[0], []);
  assert.deepEqual(s, ['Python', 'ai', 'agent']);
});
test('does not re-suggest already-applied (case-insensitive)', () => {
  const s = suggestTags(sample[0], ['ai', 'python']);
  assert.deepEqual(s, ['agent']);
});

console.log(process.exitCode ? '\n❌ SOME TESTS FAILED' : '\n✅ All logic tests passed');
