import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { toStar } from '../../src/api/github-star-source';

const payload = {
  starred_at: '2026-06-22T03:21:01Z',
  repo: {
    full_name: 'alchaincyf/loop-engineering-orange-book',
    html_url: 'https://github.com/alchaincyf/loop-engineering-orange-book',
    description: 'A book',
    language: 'TypeScript',
    stargazers_count: 42,
    topics: ['ai', 'loop'],
    pushed_at: '2026-06-20T00:00:00Z',
    created_at: '2020-01-02T00:00:00Z',
    fork: false,
    archived: false,
    owner: { avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4' },
  },
};

describe('Payload shape regression', () => {
  it('toStar extracts full_name from nested repo (not undefined)', () => {
    const star = toStar(payload as never);
    assert.equal(star.full_name, 'alchaincyf/loop-engineering-orange-book');
  });

  it('toStar extracts starred_at from the top level', () => {
    const star = toStar(payload as never);
    assert.equal(star.starred_at, '2026-06-22T03:21:01Z');
  });

  it('toStar maps all repo fields + sets tombstone=false', () => {
    const star = toStar(payload as never);
    assert.equal(star.language, 'TypeScript');
    assert.equal(star.stargazers_count, 42);
    assert.equal(star.topics.length, 2);
    assert.equal(star.created_at, '2020-01-02T00:00:00Z');
    assert.equal(star.tombstone, false);
    assert.equal(star.owner_avatar_url, 'https://avatars.githubusercontent.com/u/123?v=4');
    assert.equal(typeof star.synced_at, 'string');
    assert.ok(star.synced_at.length > 0);
  });

  it('toStar preserves null pushed_at for never-pushed repositories', () => {
    const star = toStar({
      ...payload,
      repo: {
        ...payload.repo,
        pushed_at: null,
      },
    } as never);

    assert.equal(star.pushed_at, null);
  });

  it('omits unavailable or malformed owner avatar metadata', () => {
    const missing = toStar({
      ...payload,
      repo: { ...payload.repo, owner: undefined },
    } as never);
    const malformed = toStar({
      ...payload,
      repo: { ...payload.repo, owner: { avatar_url: 'https://attacker.example/avatar.png' } },
    } as never);

    assert.equal(missing.owner_avatar_url, undefined);
    assert.equal(malformed.owner_avatar_url, undefined);
  });

  it('full_name is a valid IDB key (string, non-empty)', () => {
    const star = toStar(payload as never);
    assert.equal(typeof star.full_name, 'string');
    assert.ok(star.full_name.length > 0);
  });
});
