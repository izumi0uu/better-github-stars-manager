// Pure-logic verification of the two correctness-critical algorithms:
// 1. Per-repo timestamp merge used by Gist sync.
// 2. Star filtering/sorting — query engine core.
//
// Run: node --experimental-strip-types tests/logic.test.ts
// (Node 24 strips types natively.)

import assert from 'node:assert';
import { hidePanel, isPanelEnabled, onPanelToggle, showPanel } from '../src/content/stars-page/panel-toggle.ts';
import { mountState, pageOwner } from '../src/content/stars-page/mount-state.ts';

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
interface S { full_name: string; description: string; language: string | null; topics: string[]; notes?: string; tombstone: boolean; starred_at: string; pushed_at: string; stargazers_count: number; }

function filterStars(stars: S[], opts: { query?: string; languages?: string[]; tags?: string[]; showTombstone?: boolean; onlyFavorite?: boolean; onlyUntagged?: boolean; tagsByRepo?: Map<string, string[]>; favoritesByRepo?: Map<string, boolean> }): S[] {
  const q = (opts.query ?? '').toLowerCase();
  const langSet = opts.languages?.length ? new Set(opts.languages) : null;
  const tagSet = opts.tags?.length ? new Set(opts.tags) : null;
  return stars.filter((s) => {
    if (!opts.showTombstone && s.tombstone) return false;
    if (langSet && (s.language === null || !langSet.has(s.language))) return false;
    const myTags = opts.tagsByRepo?.get(s.full_name) ?? [];
    if (opts.onlyFavorite && !opts.favoritesByRepo?.get(s.full_name)) return false;
    if (opts.onlyUntagged && myTags.length > 0) return false;
    if (tagSet && !myTags.some((t) => tagSet.has(t))) return false;
    if (q) {
      const hay = `${s.full_name} ${s.description} ${s.topics.join(' ')} ${s.notes ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

console.log('\nFilter logic (query engine):');
const sample: S[] = [
  { full_name: 'a/ai-tool', description: 'AI helper', language: 'Python', topics: ['ai', 'agent'], notes: '', tombstone: false, starred_at: '2026-06-20', pushed_at: '2026-06-19', stargazers_count: 100 },
  { full_name: 'b/rust-lib', description: 'A rust lib', language: 'Rust', topics: [], notes: 'review later', tombstone: false, starred_at: '2026-06-21', pushed_at: '2026-06-22', stargazers_count: 50 },
  { full_name: 'c/old', description: 'archived thing', language: 'Python', topics: [], notes: '', tombstone: true, starred_at: '2026-01-01', pushed_at: '2025-01-01', stargazers_count: 5 },
];
const tagsByRepo = new Map([['a/ai-tool', ['ai']], ['b/rust-lib', ['rust']]]);
const favoritesByRepo = new Map([['b/rust-lib', true]]);

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
test('full-text search hits notes', () => {
  const r = filterStars(sample, { query: 'review later' });
  assert.equal(r.length, 1);
  assert.equal(r[0].full_name, 'b/rust-lib');
});
test('filter by tag', () => {
  const r = filterStars(sample, { tags: ['rust'], tagsByRepo });
  assert.equal(r.length, 1);
  assert.equal(r[0].full_name, 'b/rust-lib');
});
test('onlyFavorite keeps favorited repos only', () => {
  const r = filterStars(sample, { onlyFavorite: true, favoritesByRepo, tagsByRepo });
  assert.equal(r.length, 1);
  assert.equal(r[0].full_name, 'b/rust-lib');
});
test('onlyUntagged excludes tagged', () => {
  const r = filterStars(sample, { onlyUntagged: true, tagsByRepo });
  assert.equal(r.length, 0); // both live repos are tagged
});

console.log('\nAuto-suggest:');
function suggestTags(star: S, existing: string[], excluded: Iterable<string> = []): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const skip = new Set([...excluded].map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const t of star.topics) {
    if (have.has(t.toLowerCase()) || skip.has(t.toLowerCase())) continue;
    out.push(t);
  }
  return out.slice(0, 5);
}
test('suggests only topics not already tagged (no language)', () => {
  const s = suggestTags(sample[0], []);
  assert.deepEqual(s, ['ai', 'agent']);
});
test('does not re-suggest already-applied (case-insensitive)', () => {
  const s = suggestTags(sample[0], ['ai', 'agent']);
  assert.deepEqual(s, []);
});
test('excluded tombstones are not re-suggested', () => {
  const s = suggestTags(sample[0], [], ['ai']);
  assert.deepEqual(s, ['agent']);
});

// --- Stars-page panel toggle state (mirrors src/content/stars-page/panel-toggle.ts) ---
// Keeps the session-local enable/disable switch honest without exercising the
// content-script DOM side effects, so this stays fast and isolated.
function resetPanelToggle(): void {
  onPanelToggle(() => {});
  showPanel();
}

console.log('\nStars-page panel toggle state:');
test('panel starts enabled', () => {
  resetPanelToggle();
  assert.equal(isPanelEnabled(), true);
});
test('hidePanel disables the panel', () => {
  resetPanelToggle();
  hidePanel();
  assert.equal(isPanelEnabled(), false);
});
test('hidePanel and showPanel both dispatch the registered callback', () => {
  resetPanelToggle();
  let calls = 0;
  onPanelToggle(() => {
    calls++;
  });
  hidePanel();
  showPanel();
  assert.equal(isPanelEnabled(), true);
  assert.equal(calls, 2);
});
test('latest registered callback wins', () => {
  resetPanelToggle();
  let oldCalls = 0;
  let newCalls = 0;
  onPanelToggle(() => {
    oldCalls++;
  });
  onPanelToggle(() => {
    newCalls++;
  });
  hidePanel();
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
});

// --- Stars-page mount decision (mirrors mount-state.ts) ---
// mountState(isOwnStars, enabled): isOwnStars = tab=stars AND owner==me, so the
// manager never overlays someone else's ?tab=stars page.
console.log('\nStars-page mount state:');
test('on OWN stars page + enabled → panel', () => {
  assert.equal(mountState(true, true), 'panel');
});
test('on OWN stars page + disabled → fab (floating re-mount button)', () => {
  assert.equal(mountState(true, false), 'fab');
});
test('on SOMEONE ELSE\'S stars page (or not a stars page) + enabled → none', () => {
  assert.equal(mountState(false, true), 'none');
});
test('on SOMEONE ELSE\'S stars page (or not a stars page) + disabled → none', () => {
  assert.equal(mountState(false, false), 'none');
});

// --- pageOwner: decode the owner login from a github.com stars URL ---
// `?tab=stars` is the same for everyone; the OWNER distinguishes "my stars" from
// "their stars". The manager must only mount when owner == me.
console.log('\nStars-page owner decode:');
test('profile tab form: /<login> → login', () => {
  assert.equal(pageOwner('/izumi0uu'), 'izumi0uu');
  assert.equal(pageOwner('/Izumi0UU/'), 'izumi0uu'); // trailing slash + case-folded
});
test('canonical users form: /users/<login> → login', () => {
  assert.equal(pageOwner('/users/octocat'), 'octocat');
  assert.equal(pageOwner('/users/Torvalds'), 'torvalds');
});
test('reserved/app routes are not owners → null', () => {
  assert.equal(pageOwner('/stars'), null);       // GitHub's aggregate stars landing
  assert.equal(pageOwner('/orgs/acme'), null);   // org page, not a user
  assert.equal(pageOwner('/settings'), null);
  assert.equal(pageOwner('/search'), null);
});
test('non-owner multi-segment paths → null', () => {
  assert.equal(pageOwner('/octocat/Hello-World'), null); // a repo, not a profile
  assert.equal(pageOwner('/'), null);
  assert.equal(pageOwner(''), null);
});

console.log(process.exitCode ? '\n❌ SOME TESTS FAILED' : '\n✅ All logic tests passed');
