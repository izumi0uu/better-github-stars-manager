import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { createBackfillConfigStore } from '@/background/backfill-config';
import { db } from '@/storage/db';
import { selectActiveBackfillId } from '@/upgrades/backfill-state';
import { backfillTasks, reconcileBackfillMap } from '@/upgrades/tasks';
import type { BackfillMap, BackfillState, Config, Star } from '@/types';
import { createRng, fuzzCases, fuzzFailure, type SeededRng } from '../../helpers/seeded-fuzz';

const FILE = 'tests/regressions/fuzz/backfill-config-fuzz.test.ts';
const PREFIX = 'BACKFILL_CONFIG_FUZZ';
const SUITE = 'backfill/config fuzz';
const CASES = fuzzCases(PREFIX, '20260705-backfill', 100);
const backfillId = 'repo_data_sync_v1' as const;
const avatarBackfillId = 'repo_owner_avatar_v1' as const;

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(async () => {
  await db.close();
});

describe('backfill/config seeded fuzz', () => {
  for (const caseIndex of CASES.cases) {
    it(`reconciles backfill states for case ${caseIndex}`, async () => {
      const rng = createRng(CASES.seed, caseIndex);
      const existing = makeBackfillMap(rng);
      const liveRowsMissingCreatedAt = rng.bool();
      const liveRowsMissingAvatar = rng.bool();
      await seedStars(rng, liveRowsMissingCreatedAt, liveRowsMissingAvatar);

      const keepRunning = rng.bool();
      const actual = await reconcileBackfillMap(existing, { keepRunning });
      assertReconcileMatches(actual, {
        existing,
        liveRowsMissingCreatedAt,
        liveRowsMissingAvatar,
        keepRunning,
        caseIndex,
      });
      const expectedStatus = expectedStatusFor(
        existing,
        backfillId,
        liveRowsMissingCreatedAt,
        keepRunning,
      );
      const expectedAvatarStatus = expectedStatusFor(
        existing,
        avatarBackfillId,
        liveRowsMissingAvatar,
        keepRunning,
      );
      const expectedActive = isActive(expectedStatus)
        ? backfillId
        : isActive(expectedAvatarStatus)
          ? avatarBackfillId
          : null;
      assert.equal(
        selectActiveBackfillId(actual),
        expectedActive,
        fuzzFailure({
          suite: SUITE,
          prefix: PREFIX,
          seed: CASES.seed,
          caseIndex,
          file: FILE,
          invariant: 'active backfill selection matches model',
          expected: { repo: expectedStatus, avatar: expectedAvatarStatus, active: expectedActive },
          actual: { states: actual, active: selectActiveBackfillId(actual) },
          trace: { existing, liveRowsMissingCreatedAt, liveRowsMissingAvatar, keepRunning },
        }),
      );
    });
  }

  for (const caseIndex of CASES.cases) {
    it(`serializes config mutations after rejections for case ${caseIndex}`, async () => {
      const rng = createRng(CASES.seed, caseIndex + 10_000);
      let current = makeConfig(makeBackfillMap(rng));
      const attempts: string[] = [];
      const rejectFirstUpdate = rng.bool(0.5);
      const store = createBackfillConfigStore({
        async getConfig() {
          attempts.push('get');
          return current;
        },
        async update(patch: Partial<Config>) {
          attempts.push('update');
          if (rejectFirstUpdate && attempts.filter((entry) => entry === 'update').length === 1) {
            throw new Error('seeded storage write rejected');
          }
          current = { ...current, ...patch };
        },
      });

      const first = store.setBackfillState(backfillId, (_state, now) => ({
        status: 'running',
        queuedAt: now,
        lastAttemptAt: now,
        completedAt: null,
        error: null,
      }));
      const second = store.setBackfillState(backfillId, (state, now) => ({
        status: rng.pick(['failed', 'deferred'] as const),
        queuedAt: state?.queuedAt ?? now,
        lastAttemptAt: now,
        completedAt: null,
        error: 'seeded terminal evidence',
      }));

      if (rejectFirstUpdate) {
        await assert.rejects(() => first, /seeded storage write rejected/);
      } else {
        assert.equal((await first).status, 'running');
      }
      const final = await second;

      assert.equal(
        current.backfills[backfillId]?.status,
        final.status,
        fuzzFailure({
          suite: SUITE,
          prefix: PREFIX,
          seed: CASES.seed,
          caseIndex,
          file: FILE,
          invariant: 'queued config mutation recovers after rejected write',
          expected: final,
          actual: current.backfills[backfillId],
          trace: { rejectFirstUpdate, attempts },
        }),
      );
      assert.equal(current.backfills[backfillId]?.error, 'seeded terminal evidence');
    });
  }

  it('serializes rejected reconciliation before a queued mutation', async () => {
    const originalDetectNeed = backfillTasks[backfillId].detectNeed;
    const events: string[] = [];
    let current = makeConfig({});
    backfillTasks[backfillId].detectNeed = async () => {
      events.push('detect rejected');
      throw new Error('seeded detect rejected');
    };
    const store = createBackfillConfigStore({
      async getConfig() {
        events.push('get');
        return current;
      },
      async update(patch: Partial<Config>) {
        events.push('update');
        current = { ...current, ...patch };
      },
    });

    try {
      const rejected = store.reconcileStoredBackfills();
      const recovered = store.setBackfillState(backfillId, (_state, now) => ({
        status: 'failed',
        queuedAt: now,
        lastAttemptAt: now,
        completedAt: null,
        error: 'manual failure after rejected reconcile',
      }));

      await assert.rejects(() => rejected, /seeded detect rejected/);
      const final = await recovered;

      assert.deepEqual(events, ['get', 'detect rejected', 'get', 'update']);
      assert.equal(final.status, 'failed');
      assert.equal(current.backfills[backfillId]?.error, 'manual failure after rejected reconcile');
    } finally {
      backfillTasks[backfillId].detectNeed = originalDetectNeed;
    }
  });
});

function makeBackfillMap(rng: SeededRng): BackfillMap {
  const out: BackfillMap = {};
  for (const id of [backfillId, avatarBackfillId] as const) {
    if (rng.bool(0.25)) continue;
    const status = rng.pick(['pending', 'running', 'done', 'failed', 'deferred'] as const);
    out[id] = {
      status,
      queuedAt: rng.maybe(iso(rng.int(0, 4)), 0.85),
      lastAttemptAt: rng.maybe(iso(rng.int(5, 9)), 0.7),
      completedAt: status === 'done' ? rng.maybe(iso(rng.int(10, 14)), 0.85) : null,
      error: status === 'failed' || status === 'deferred' ? `seeded-${status}` : null,
    };
  }
  return out;
}

function assertReconcileMatches(
  actual: BackfillMap,
  context: {
    existing: BackfillMap;
    liveRowsMissingCreatedAt: boolean;
    liveRowsMissingAvatar: boolean;
    keepRunning: boolean;
    caseIndex: number;
  },
): void {
  assertBackfillStateMatches(actual, backfillId, context.liveRowsMissingCreatedAt, context);
  assertBackfillStateMatches(actual, avatarBackfillId, context.liveRowsMissingAvatar, context);
}

function assertBackfillStateMatches(
  actual: BackfillMap,
  id: typeof backfillId | typeof avatarBackfillId,
  needs: boolean,
  context: {
    existing: BackfillMap;
    liveRowsMissingCreatedAt: boolean;
    liveRowsMissingAvatar: boolean;
    keepRunning: boolean;
    caseIndex: number;
  },
): void {
  const actualState = actual[id];
  const existing = context.existing[id];
  const expectedStatus = expectedStatusFor(context.existing, id, needs, context.keepRunning);
  const failure = (invariant: string, expected?: unknown) => fuzzFailure({
    suite: SUITE,
    prefix: PREFIX,
    seed: CASES.seed,
    caseIndex: context.caseIndex,
    file: FILE,
    invariant,
    expected,
    actual: actualState,
    trace: { id, needs, ...context },
  });

  assert.ok(actualState, failure('reconcileBackfillMap returns known backfill state'));
  assert.equal(actualState.status, expectedStatus, failure('reconciled status matches model', expectedStatus));

  if (expectedStatus === existing?.status
    && (existing.status === 'failed' || existing.status === 'deferred' || existing.status === 'running')) {
    assert.deepEqual(actualState, existing, failure('terminal/deferred/running evidence is preserved', existing));
    return;
  }

  if (expectedStatus === 'done') {
    assert.equal(actualState.error, null);
    assert.equal(actualState.lastAttemptAt, existing?.lastAttemptAt ?? null);
    assert.ok(actualState.queuedAt, 'done state keeps or creates queuedAt');
    assert.ok(actualState.completedAt, 'done state has completedAt');
    if (existing?.completedAt) assert.equal(actualState.completedAt, existing.completedAt);
    return;
  }

  assert.equal(expectedStatus, 'pending');
  assert.equal(actualState.completedAt, null);
  assert.equal(actualState.lastAttemptAt, existing?.lastAttemptAt ?? null);
  assert.equal(actualState.error, existing?.error ?? null);
  assert.ok(actualState.queuedAt, 'pending state keeps or creates queuedAt');
}

function expectedStatusFor(
  input: BackfillMap,
  id: typeof backfillId | typeof avatarBackfillId,
  needs: boolean,
  keepRunning: boolean,
): BackfillState['status'] {
  const existing = input[id];
  if (existing?.status === 'done') return 'done';
  if (!needs) return 'done';
  if (existing?.status === 'failed' || existing?.status === 'deferred') return existing.status;
  if (existing?.status === 'running' && keepRunning) return 'running';
  return 'pending';
}

function isActive(status: BackfillState['status']): boolean {
  return status === 'running' || status === 'failed' || status === 'pending';
}

async function seedStars(
  rng: SeededRng,
  includeMissingCreatedAt: boolean,
  includeMissingAvatar: boolean,
): Promise<void> {
  const stars: Star[] = [];
  const count = rng.int(0, 10);
  for (let index = 0; index < count; index++) {
    stars.push({
      full_name: `owner/repo${index}`,
      html_url: `https://github.com/owner/repo${index}`,
      description: '',
      language: null,
      stargazers_count: 0,
      topics: [],
      pushed_at: iso(index),
      created_at: includeMissingCreatedAt && index === 0 ? null : iso(index + 20),
      owner_avatar_url: includeMissingAvatar && index === 0
        ? undefined
        : `https://avatars.githubusercontent.com/u/${index + 1}?v=4`,
      fork: false,
      archived: false,
      starred_at: iso(index + 40),
      tombstone: rng.bool(0.15),
      synced_at: iso(index + 60),
    });
  }
  if (includeMissingCreatedAt && !stars.some((star) => !star.tombstone && star.created_at == null)) {
    stars.push({
      full_name: 'owner/missing-created',
      html_url: 'https://github.com/owner/missing-created',
      description: '',
      language: null,
      stargazers_count: 0,
      topics: [],
      pushed_at: iso(1),
      created_at: null,
      owner_avatar_url: includeMissingAvatar ? undefined : 'https://avatars.githubusercontent.com/u/999?v=4',
      fork: false,
      archived: false,
      starred_at: iso(2),
      tombstone: false,
      synced_at: iso(3),
    });
  }
  if (includeMissingAvatar && !stars.some((star) => !star.tombstone && star.owner_avatar_url == null)) {
    stars.push({
      full_name: 'owner/missing-avatar',
      html_url: 'https://github.com/owner/missing-avatar',
      description: '',
      language: null,
      stargazers_count: 0,
      topics: [],
      pushed_at: iso(1),
      created_at: iso(20),
      fork: false,
      archived: false,
      starred_at: iso(2),
      tombstone: false,
      synced_at: iso(3),
    });
  }
  await db.stars.bulkPut(stars);
}

function makeConfig(backfills: BackfillMap): Config {
  return { backfills } as Config;
}

function iso(offset: number): string {
  return new Date(Date.UTC(2026, 5, 22, 0, offset)).toISOString();
}
