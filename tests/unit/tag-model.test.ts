import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  canonicalTagMetaWinners,
  canonicalTagKey,
  excludedCanonicalTagKeys,
  includesTagName,
  normalizeTagNames,
  preferredCanonicalTagMeta,
  withoutTagName,
} from '@/tags/tag-model';

describe('tag model canonical identity', () => {
  it('uses trimmed NFKC en-US lowercase keys', () => {
    assert.equal(canonicalTagKey('  ＵＩ  '), 'ui');
    assert.equal(canonicalTagKey('Kelvin'), 'kelvin');
  });

  it('deduplicates canonical equivalents while preserving the first display spelling', () => {
    assert.deepEqual(
      normalizeTagNames(['  ＵＩ  ', 'ui', 'UI', ' Agent ', 'Ａｇｅｎｔ']),
      ['ＵＩ', 'Agent'],
    );
  });

  it('uses the same identity for inclusion and removal', () => {
    const names = ['ＵＩ', 'Agent'];

    assert.equal(includesTagName(names, ' ui '), true);
    assert.equal(includesTagName(names, 'ａｇｅｎｔ'), true);
    assert.deepEqual(withoutTagName(names, ' UI '), ['Agent']);
    assert.deepEqual(withoutTagName(names, 'ＡＧＥＮＴ'), ['ＵＩ']);
  });

  it('selects one deterministic metadata winner per canonical identity', () => {
    const metas = [
      { name: 'UI', dimension: null, color: null, excluded: true, mtime: '2026-01-01T00:00:00Z' },
      { name: 'ui', dimension: null, color: null, excluded: false, mtime: '2026-01-02T00:00:00Z' },
      { name: 'ＡＩ', dimension: null, color: null, excluded: false, mtime: '2026-01-03T00:00:00Z' },
      { name: 'ai', dimension: null, color: null, excluded: true, mtime: '2026-01-03T00:00:00Z' },
    ];

    const winners = canonicalTagMetaWinners(metas);
    assert.equal(winners.get('ui')?.name, 'ui');
    assert.equal(winners.get('ui')?.excluded, false);
    assert.equal(winners.get('ai')?.name, 'ai');
    assert.equal(winners.get('ai')?.excluded, true);
    assert.deepEqual([...excludedCanonicalTagKeys(metas)], ['ai']);
  });

  it('selects a commutative winner for canonically equivalent raw names', () => {
    const ascii = {
      name: 'UI',
      dimension: 'topic',
      color: '#ffffff',
      excluded: false,
      mtime: '2026-01-01T00:00:00Z',
    };
    const fullWidth = {
      name: 'ＵＩ',
      dimension: 'stack',
      color: '#000000',
      excluded: false,
      mtime: '2026-01-01T00:00:00Z',
    };

    assert.deepEqual(preferredCanonicalTagMeta(ascii, fullWidth), ascii);
    assert.deepEqual(preferredCanonicalTagMeta(fullWidth, ascii), ascii);
  });

  it('uses every metadata field to break otherwise equal conflicts', () => {
    const base = {
      name: 'ui',
      dimension: 'topic',
      color: '#ffffff',
      excluded: false as boolean | undefined,
      mtime: '2026-01-01T00:00:00Z',
    };
    const lowerDimension = { ...base, dimension: 'stack' };
    const lowerColor = { ...base, color: '#000000' };
    const omittedExcluded = { ...base, excluded: undefined };

    assert.deepEqual(preferredCanonicalTagMeta(base, lowerDimension), lowerDimension);
    assert.deepEqual(preferredCanonicalTagMeta(lowerDimension, base), lowerDimension);
    assert.deepEqual(preferredCanonicalTagMeta(base, lowerColor), lowerColor);
    assert.deepEqual(preferredCanonicalTagMeta(lowerColor, base), lowerColor);
    assert.deepEqual(preferredCanonicalTagMeta(base, omittedExcluded), base);
    assert.deepEqual(preferredCanonicalTagMeta(omittedExcluded, base), base);
  });

  it('selects the same canonical winner for every input order', () => {
    const metas = [
      { name: 'ＵＩ', dimension: null, color: '#ffffff', excluded: false, mtime: '2026-01-01T00:00:00Z' },
      { name: 'ui', dimension: 'topic', color: '#111111', excluded: false, mtime: '2026-01-01T00:00:00Z' },
      { name: 'UI', dimension: 'stack', color: '#222222', excluded: false, mtime: '2026-01-01T00:00:00Z' },
    ] as const;
    const orders = [
      metas,
      [metas[0], metas[2], metas[1]],
      [metas[1], metas[0], metas[2]],
      [metas[1], metas[2], metas[0]],
      [metas[2], metas[0], metas[1]],
      [...metas].reverse(),
    ];

    for (const order of orders) {
      assert.deepEqual(canonicalTagMetaWinners(order).get('ui'), metas[2]);
    }
  });
});
