import { describe, expect, it } from 'vitest';
import { createRepositorySearchMatcher } from '@/search/repository-search';

const document = (overrides: Partial<{
  fullName: string;
  description: string;
  topics: string[];
  notes: string;
}> = {}) => ({
  fullName: 'owner/better-repo',
  description: '',
  topics: [],
  notes: '',
  ...overrides,
});

describe('repository search matcher', () => {
  it('ranks repository exact, prefix, substring, and fuzzy matches in that order', () => {
    const exact = createRepositorySearchMatcher('repo').matchName('owner/repo');
    const prefix = createRepositorySearchMatcher('repo').matchName('owner/repository');
    const substring = createRepositorySearchMatcher('repo').matchName('owner/my-repo-tool');
    const fuzzy = createRepositorySearchMatcher('rpo').matchName('owner/repository');

    expect(exact.kind).toBe('repository-exact');
    expect(prefix.kind).toBe('repository-prefix');
    expect(substring.kind).toBe('repository-substring');
    expect(fuzzy.kind).toBe('repository-fuzzy');
    expect(exact.relevance).toBeGreaterThan(prefix.relevance);
    expect(prefix.relevance).toBeGreaterThan(substring.relevance);
    expect(substring.relevance).toBeGreaterThan(fuzzy.relevance);
  });

  it('returns ranges in the original full-name string, including non-contiguous fuzzy ranges', () => {
    const exact = createRepositorySearchMatcher('repo').matchName('owner/my-repo-tool');
    expect(exact.nameRanges).toEqual([{ start: 9, end: 13 }]);

    const fuzzy = createRepositorySearchMatcher('rpt').matchName('owner/repository-tool');
    expect(fuzzy.kind).toBe('repository-fuzzy');
    expect(fuzzy.nameRanges).toEqual([
      { start: 6, end: 7 },
      { start: 8, end: 9 },
      { start: 12, end: 13 },
    ]);
  });

  it('ignores common code-name separators during fuzzy matching', () => {
    const result = createRepositorySearchMatcher('better repo')
      .matchName('owner/better-repo');

    expect(result.kind).toBe('repository-fuzzy');
    expect(result.nameRanges).toEqual([
      { start: 6, end: 12 },
      { start: 13, end: 17 },
    ]);
  });

  it('keeps full-name exact and owner matches distinct from repository-name ranking', () => {
    const fullName = createRepositorySearchMatcher('owner/better-repo').matchName('owner/better-repo');
    const owner = createRepositorySearchMatcher('owner').matchName('owner/better-repo');

    expect(fullName.kind).toBe('full-name-exact');
    expect(fullName.nameRanges).toEqual([{ start: 0, end: 17 }]);
    expect(owner.kind).toBe('full-name-prefix');
    expect(owner.nameRanges).toEqual([{ start: 0, end: 5 }]);
  });

  it('keeps an owner-qualified prefix ahead of an unrelated repository fuzzy match', () => {
    const matcher = createRepositorySearchMatcher('foo/bar');
    const qualified = matcher.matchName('foo/bar-utils');
    const unrelated = matcher.matchName('other/foobar-utils');

    expect(qualified.kind).toBe('full-name-prefix');
    expect(unrelated.kind).toBe('full-name-fuzzy');
    expect(qualified.relevance).toBeGreaterThan(unrelated.relevance);
  });

  it('retains continuous metadata matching after repository-name matching fails', () => {
    const matcher = createRepositorySearchMatcher('needle');

    expect(matcher.match(document({ description: 'A needle in the haystack' })).kind)
      .toBe('metadata-substring');
    expect(matcher.match(document({ topics: ['needle'] })).kind)
      .toBe('metadata-substring');
    expect(matcher.match(document({ notes: 'private needle' })).kind)
      .toBe('metadata-substring');
    expect(matcher.match(document({ description: 'unrelated' })).matched).toBe(false);
  });

  it('treats empty input as an unranked match without highlight ranges', () => {
    const result = createRepositorySearchMatcher('   ').match(document());
    expect(result).toEqual({
      matched: true,
      relevance: 0,
      kind: 'empty',
      nameRanges: [],
    });
  });
});
