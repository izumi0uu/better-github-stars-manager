import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { toStar } from '../src/api/github-star-source';

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
    fork: false,
    archived: false,
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
    assert.equal(star.tombstone, false);
    assert.equal(typeof star.synced_at, 'string');
    assert.ok(star.synced_at.length > 0);
  });

  it('full_name is a valid IDB key (string, non-empty)', () => {
    const star = toStar(payload as never);
    assert.equal(typeof star.full_name, 'string');
    assert.ok(star.full_name.length > 0);
  });
});
