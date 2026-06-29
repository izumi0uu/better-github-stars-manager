import assert from 'node:assert';
import { beforeEach, describe, it } from 'vitest';
import {
  hidePanel,
  isPanelEnabled,
  onPanelToggle,
  resetPanelToggle,
  showPanel,
} from '../src/content/stars-page/panel-toggle.ts';
import {
  isOnboardingCardStage,
  normalizeOnboardingStage,
  resolveOnboardingStageAfterSync,
} from '../src/onboarding/state.ts';
import { autoTagPhaseForSync } from '../src/background/sync-flow.ts';
import { mountState, pageOwner } from '../src/content/stars-page/mount-state.ts';
import { pruneFavoriteOverrides, resolveFavoriteState } from '../src/ui/favorite-state.ts';
import { pickInitialSyncAction } from '../src/ui/initial-sync.ts';
import { classifyStarsQueryTrigger } from '../src/ui/stars-refresh.ts';
import { normalizeAutoTagLimit } from '../src/preferences.ts';

function lwwMerge(
  local: Map<string, { tags: string[]; mtime: string }>,
  remote: Record<string, { tags: string[]; mtime: string }>,
): { merged: number; result: Map<string, { tags: string[]; mtime: string }> } {
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

interface S {
  full_name: string;
  description: string;
  language: string | null;
  topics: string[];
  notes?: string;
  archived: boolean;
  tombstone: boolean;
  starred_at: string;
  pushed_at: string;
  stargazers_count: number;
}

function filterStars(
  stars: S[],
  opts: {
    query?: string;
    languages?: string[];
    tags?: string[];
    showTombstone?: boolean;
    onlyFavorite?: boolean;
    onlyUntagged?: boolean;
    onlyArchived?: boolean;
    tagsByRepo?: Map<string, string[]>;
    favoritesByRepo?: Map<string, boolean>;
  },
): S[] {
  const q = (opts.query ?? '').toLowerCase();
  const langSet = opts.languages?.length ? new Set(opts.languages) : null;
  const tagSet = opts.tags?.length ? new Set(opts.tags) : null;
  return stars.filter((s) => {
    if (!opts.showTombstone && s.tombstone) return false;
    if (opts.onlyArchived && !s.archived) return false;
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

const sample: S[] = [
  {
    full_name: 'a/ai-tool',
    description: 'AI helper',
    language: 'Python',
    topics: ['ai', 'agent'],
    notes: '',
    archived: false,
    tombstone: false,
    starred_at: '2026-06-20',
    pushed_at: '2026-06-19',
    stargazers_count: 100,
  },
  {
    full_name: 'b/rust-lib',
    description: 'A rust lib',
    language: 'Rust',
    topics: [],
    notes: 'review later',
    archived: true,
    tombstone: false,
    starred_at: '2026-06-21',
    pushed_at: '2026-06-22',
    stargazers_count: 50,
  },
  {
    full_name: 'c/old',
    description: 'archived thing',
    language: 'Python',
    topics: [],
    notes: '',
    archived: false,
    tombstone: true,
    starred_at: '2026-01-01',
    pushed_at: '2025-01-01',
    stargazers_count: 5,
  },
];
const tagsByRepo = new Map([
  ['a/ai-tool', ['ai']],
  ['b/rust-lib', ['rust']],
]);
const favoritesByRepo = new Map([['b/rust-lib', true]]);

function suggestTags(
  star: S,
  existing: string[],
  excluded: Iterable<string> = [],
  limit = 5,
): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const skip = new Set([...excluded].map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const t of star.topics) {
    if (have.has(t.toLowerCase()) || skip.has(t.toLowerCase())) continue;
    out.push(t);
  }
  return out.slice(0, normalizeAutoTagLimit(limit));
}

function resetPanelState(): void {
  onPanelToggle(() => {});
  resetPanelToggle();
}

describe('Timestamp merge', () => {
  it('device A edits repo1, device B edits repo2 -> both kept', () => {
    const local = new Map([
      ['a/repo1', { tags: ['x'], mtime: '2026-06-22T10:00:00Z' }],
      ['a/repo2', { tags: [], mtime: '2026-06-22T09:00:00Z' }],
    ]);
    const remote = {
      'a/repo1': { tags: ['x', 'ai'], mtime: '2026-06-22T11:00:00Z' },
      'a/repo2': { tags: ['rust'], mtime: '2026-06-22T09:30:00Z' },
    };
    const { result } = lwwMerge(local, remote);
    assert.deepEqual(result.get('a/repo1')!.tags, ['x', 'ai']);
    assert.deepEqual(result.get('a/repo2')!.tags, ['rust']);
  });

  it('local newer than remote -> local kept', () => {
    const local = new Map([['a/r', { tags: ['local'], mtime: '2026-06-22T12:00:00Z' }]]);
    const remote = { 'a/r': { tags: ['remote'], mtime: '2026-06-22T10:00:00Z' } };
    lwwMerge(local, remote);
    assert.deepEqual(local.get('a/r')!.tags, ['local']);
  });

  it('remote-only repo -> added to local', () => {
    const local = new Map();
    const remote = { 'a/new': { tags: ['fresh'], mtime: '2026-06-22T10:00:00Z' } };
    const { merged } = lwwMerge(local, remote);
    assert.equal(merged, 1);
    assert.deepEqual(local.get('a/new')!.tags, ['fresh']);
  });
});

describe('Filter logic', () => {
  it('hide tombstone by default', () => {
    assert.equal(filterStars(sample, {}).length, 2);
  });

  it('show tombstone when asked', () => {
    assert.equal(filterStars(sample, { showTombstone: true }).length, 3);
  });

  it('filter by language Python', () => {
    const r = filterStars(sample, { languages: ['Python'] });
    assert.equal(r.length, 1);
    assert.equal(r[0].full_name, 'a/ai-tool');
  });

  it('full-text search hits topics', () => {
    const r = filterStars(sample, { query: 'agent' });
    assert.equal(r.length, 1);
    assert.equal(r[0].full_name, 'a/ai-tool');
  });

  it('full-text search hits notes', () => {
    const r = filterStars(sample, { query: 'review later' });
    assert.equal(r.length, 1);
    assert.equal(r[0].full_name, 'b/rust-lib');
  });

  it('filter by tag', () => {
    const r = filterStars(sample, { tags: ['rust'], tagsByRepo });
    assert.equal(r.length, 1);
    assert.equal(r[0].full_name, 'b/rust-lib');
  });

  it('onlyFavorite keeps favorited repos only', () => {
    const r = filterStars(sample, { onlyFavorite: true, favoritesByRepo, tagsByRepo });
    assert.equal(r.length, 1);
    assert.equal(r[0].full_name, 'b/rust-lib');
  });

  it('onlyArchived keeps archived repos only', () => {
    const r = filterStars(sample, { onlyArchived: true, favoritesByRepo, tagsByRepo });
    assert.equal(r.length, 1);
    assert.equal(r[0].full_name, 'b/rust-lib');
  });

  it('onlyUntagged excludes tagged', () => {
    const r = filterStars(sample, { onlyUntagged: true, tagsByRepo });
    assert.equal(r.length, 0);
  });
});

describe('Favorite UI state', () => {
  it('row keeps optimistic favorite until committed data catches up', () => {
    const state = resolveFavoriteState(undefined, { value: true, pending: false });
    assert.equal(state.favorite, true);
    assert.equal(state.busy, false);
  });

  it('matching committed favorite clears the parent override', () => {
    const overrides = { 'a/ai-tool': { value: true, pending: false } };
    const tags = new Map([
      ['a/ai-tool', { full_name: 'a/ai-tool', tags: [], notes: '', favorite: true, mtime: '2026-06-26T00:00:00Z' }],
    ]);
    const pruned = pruneFavoriteOverrides(overrides, tags, [{ full_name: 'a/ai-tool' }]);
    assert.deepEqual(pruned, {});
  });

  it('rows filtered out after a favorite change also clear stale overrides', () => {
    const overrides = { 'b/rust-lib': { value: false, pending: false } };
    const tags = new Map([
      ['b/rust-lib', { full_name: 'b/rust-lib', tags: ['rust'], notes: '', favorite: false, mtime: '2026-06-26T00:00:00Z' }],
    ]);
    const pruned = pruneFavoriteOverrides(overrides, tags, [{ full_name: 'a/ai-tool' }]);
    assert.deepEqual(pruned, {});
  });
});

describe('Stars refresh policy', () => {
  it('initial load and dataChanged reloads are silent', () => {
    assert.equal(classifyStarsQueryTrigger(null, 'query-a'), 'initial-load');
    assert.equal(classifyStarsQueryTrigger('query-a', 'query-a'), 'data-change');
  });

  it('filter changes still use the fading transition', () => {
    assert.equal(classifyStarsQueryTrigger('query-a', 'query-b'), 'filter-change');
  });
});

describe('Manager auto-sync gate', () => {
  it('empty library without in-flight job triggers full sync', () => {
    assert.equal(pickInitialSyncAction({ hasToken: true, inFlight: false }, 0), 'syncFull');
  });

  it('existing library without in-flight job triggers incremental sync', () => {
    assert.equal(pickInitialSyncAction({ hasToken: true, inFlight: false }, 12), 'syncIncremental');
  });

  it('existing in-flight job blocks duplicate auto-sync on reopen', () => {
    assert.equal(pickInitialSyncAction({ hasToken: true, inFlight: true }, 12), null);
  });

  it('no token blocks auto-sync', () => {
    assert.equal(pickInitialSyncAction({ hasToken: false, inFlight: false }, 12), null);
  });
});

describe('Onboarding state machine', () => {
  it('no token always normalizes to needs_token', () => {
    assert.equal(normalizeOnboardingStage('coach', false, false), 'needs_token');
  });

  it('legacy config with token normalizes to awaiting_sync', () => {
    assert.equal(normalizeOnboardingStage(undefined, false, true), 'awaiting_sync');
  });

  it('seenOnboarding forces done stage', () => {
    assert.equal(normalizeOnboardingStage('sync_failed', true, true), 'done');
  });

  it('first sync with data advances to coach', () => {
    assert.equal(resolveOnboardingStageAfterSync(true, 12), 'coach');
  });

  it('first sync with empty library advances to empty_library', () => {
    assert.equal(resolveOnboardingStageAfterSync(true, 0), 'empty_library');
  });

  it('only non-coach, non-done stages render the onboarding card', () => {
    assert.equal(isOnboardingCardStage('needs_token'), true);
    assert.equal(isOnboardingCardStage('syncing'), true);
    assert.equal(isOnboardingCardStage('coach'), false);
    assert.equal(isOnboardingCardStage('done'), false);
  });
});

describe('Sync auto-tag policy', () => {
  it('incremental sync auto-tags in incremental phase', () => {
    assert.equal(autoTagPhaseForSync('syncIncremental'), 'incremental');
  });

  it('full sync auto-tags in full phase', () => {
    assert.equal(autoTagPhaseForSync('syncFull'), 'full');
  });

  it('rescan does not auto-tag', () => {
    assert.equal(autoTagPhaseForSync('syncRescan'), null);
  });
});

describe('Auto-suggest', () => {
  it('suggests only topics not already tagged (no language)', () => {
    const s = suggestTags(sample[0], []);
    assert.deepEqual(s, ['ai', 'agent']);
  });

  it('does not re-suggest already-applied (case-insensitive)', () => {
    const s = suggestTags(sample[0], ['ai', 'agent']);
    assert.deepEqual(s, []);
  });

  it('excluded tombstones are not re-suggested', () => {
    const s = suggestTags(sample[0], [], ['ai']);
    assert.deepEqual(s, ['agent']);
  });

  it('custom limit expands auto-suggest batch size', () => {
    const s = suggestTags(
      {
        ...sample[0],
        topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      },
      [],
      [],
      7,
    );
    assert.deepEqual(s, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('auto-suggest limit normalizes invalid values back to default', () => {
    const s = suggestTags(
      {
        ...sample[0],
        topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      },
      [],
      [],
      Number.NaN,
    );
    assert.deepEqual(s, ['a', 'b', 'c', 'd', 'e']);
  });
});

describe('Stars-page panel toggle state', () => {
  beforeEach(() => {
    resetPanelState();
  });

  it('panel starts enabled', () => {
    assert.equal(isPanelEnabled(), true);
  });

  it('hidePanel disables the panel', () => {
    hidePanel();
    assert.equal(isPanelEnabled(), false);
  });

  it('hidePanel and showPanel both dispatch the registered callback', () => {
    let calls = 0;
    onPanelToggle(() => {
      calls++;
    });
    hidePanel();
    showPanel();
    assert.equal(isPanelEnabled(), true);
    assert.equal(calls, 2);
  });

  it('latest registered callback wins', () => {
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

  it('default-enabled false keeps the panel hidden until a session override shows it', () => {
    assert.equal(isPanelEnabled(false), false);
    showPanel();
    assert.equal(isPanelEnabled(false), true);
  });

  it('resetPanelToggle drops the session override and falls back to the configured default', () => {
    hidePanel();
    assert.equal(isPanelEnabled(true), false);
    resetPanelToggle();
    assert.equal(isPanelEnabled(true), true);
    assert.equal(isPanelEnabled(false), false);
  });
});

describe('Stars-page mount state', () => {
  it('on OWN stars page + enabled -> panel', () => {
    assert.equal(mountState(true, true), 'panel');
  });

  it('on OWN stars page + disabled -> fab', () => {
    assert.equal(mountState(true, false), 'fab');
  });

  it("on SOMEONE ELSE'S stars page + enabled -> none", () => {
    assert.equal(mountState(false, true), 'none');
  });

  it("on SOMEONE ELSE'S stars page + disabled -> none", () => {
    assert.equal(mountState(false, false), 'none');
  });
});

describe('Stars-page owner decode', () => {
  it('profile tab form: /<login> -> login', () => {
    assert.equal(pageOwner('/izumi0uu'), 'izumi0uu');
    assert.equal(pageOwner('/Izumi0UU/'), 'izumi0uu');
  });

  it('canonical users form: /users/<login> -> login', () => {
    assert.equal(pageOwner('/users/octocat'), 'octocat');
    assert.equal(pageOwner('/users/Torvalds'), 'torvalds');
  });

  it('reserved/app routes are not owners -> null', () => {
    assert.equal(pageOwner('/stars'), null);
    assert.equal(pageOwner('/orgs/acme'), null);
    assert.equal(pageOwner('/settings'), null);
    assert.equal(pageOwner('/search'), null);
  });

  it('non-owner multi-segment paths -> null', () => {
    assert.equal(pageOwner('/octocat/Hello-World'), null);
    assert.equal(pageOwner('/'), null);
    assert.equal(pageOwner(''), null);
  });
});
