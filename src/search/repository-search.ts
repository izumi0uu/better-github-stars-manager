export type SearchTextRange = Readonly<{
  start: number;
  end: number;
}>;

export type RepositorySearchMatchKind =
  | 'empty'
  | 'full-name-exact'
  | 'repository-exact'
  | 'repository-prefix'
  | 'repository-substring'
  | 'repository-fuzzy'
  | 'full-name-prefix'
  | 'full-name-substring'
  | 'full-name-fuzzy'
  | 'metadata-substring'
  | 'none';

export type RepositorySearchMatch = Readonly<{
  matched: boolean;
  relevance: number;
  kind: RepositorySearchMatchKind;
  nameRanges: readonly SearchTextRange[];
}>;

export type RepositorySearchDocument = Readonly<{
  fullName: string;
  description: string;
  topics: readonly string[];
  notes: string;
}>;

type NormalizedText = Readonly<{
  text: string;
  sourceStarts: readonly number[];
  sourceEnds: readonly number[];
}>;

const RELEVANCE = {
  fullNameExact: 900,
  repositoryExact: 800,
  repositoryPrefix: 700,
  repositorySubstring: 600,
  repositoryFuzzy: 500,
  fullNamePrefix: 400,
  fullNameSubstring: 300,
  fullNameFuzzy: 200,
  metadataSubstring: 100,
} as const;

const EMPTY_MATCH: RepositorySearchMatch = {
  matched: true,
  relevance: 0,
  kind: 'empty',
  nameRanges: [],
};

const NO_MATCH: RepositorySearchMatch = {
  matched: false,
  relevance: 0,
  kind: 'none',
  nameRanges: [],
};

/** Compiles one query so background filtering does not renormalize it per repository. */
export function createRepositorySearchMatcher(rawQuery: string) {
  const query = normalizeSearchText(rawQuery.trim());
  const fuzzyQuery = compactFuzzySearchText(query);
  const qualifiedQuery = query.includes('/');

  const matchName = (fullName: string): RepositorySearchMatch => {
    if (!query) return EMPTY_MATCH;

    const fullNameText = normalizeSearchTextWithMap(fullName);
    const repositoryOffset = Math.max(0, fullName.lastIndexOf('/') + 1);
    const repositoryText = normalizeSearchTextWithMap(fullName.slice(repositoryOffset));

    if (fullNameText.text === query) {
      return contiguousMatch(
        'full-name-exact',
        RELEVANCE.fullNameExact,
        fullNameText,
        0,
        query.length,
      );
    }
    if (!qualifiedQuery) {
      if (repositoryText.text === query) {
        return contiguousMatch(
          'repository-exact',
          RELEVANCE.repositoryExact,
          repositoryText,
          0,
          query.length,
          repositoryOffset,
        );
      }
      if (repositoryText.text.startsWith(query)) {
        return contiguousMatch(
          'repository-prefix',
          RELEVANCE.repositoryPrefix,
          repositoryText,
          0,
          query.length,
          repositoryOffset,
        );
      }

      const repositorySubstringIndex = repositoryText.text.indexOf(query);
      if (repositorySubstringIndex >= 0) {
        return contiguousMatch(
          'repository-substring',
          RELEVANCE.repositorySubstring,
          repositoryText,
          repositorySubstringIndex,
          query.length,
          repositoryOffset,
        );
      }

      const repositoryFuzzyIndexes = fuzzyMatchIndexes(repositoryText.text, fuzzyQuery);
      if (repositoryFuzzyIndexes) {
        return fuzzyMatch(
          'repository-fuzzy',
          RELEVANCE.repositoryFuzzy,
          repositoryText,
          repositoryFuzzyIndexes,
          repositoryOffset,
        );
      }
    }

    if (fullNameText.text.startsWith(query)) {
      return contiguousMatch(
        'full-name-prefix',
        RELEVANCE.fullNamePrefix,
        fullNameText,
        0,
        query.length,
      );
    }

    const fullNameSubstringIndex = fullNameText.text.indexOf(query);
    if (fullNameSubstringIndex >= 0) {
      return contiguousMatch(
        'full-name-substring',
        RELEVANCE.fullNameSubstring,
        fullNameText,
        fullNameSubstringIndex,
        query.length,
      );
    }

    const fullNameFuzzyIndexes = fuzzyMatchIndexes(fullNameText.text, fuzzyQuery);
    if (fullNameFuzzyIndexes) {
      return fuzzyMatch(
        'full-name-fuzzy',
        RELEVANCE.fullNameFuzzy,
        fullNameText,
        fullNameFuzzyIndexes,
      );
    }

    return NO_MATCH;
  };

  return {
    empty: query.length === 0,
    normalizedQuery: query,
    matchName,
    match(document: RepositorySearchDocument): RepositorySearchMatch {
      const nameMatch = matchName(document.fullName);
      if (nameMatch.matched) return nameMatch;

      const metadata = normalizeSearchText(
        `${document.description} ${document.topics.join(' ')} ${document.notes}`,
      );
      if (metadata.includes(query)) {
        return {
          matched: true,
          relevance: RELEVANCE.metadataSubstring,
          kind: 'metadata-substring',
          nameRanges: [],
        };
      }
      return NO_MATCH;
    },
  };
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function compactFuzzySearchText(value: string): string {
  return value.replace(/[-_./\s]+/gu, '');
}

function normalizeSearchTextWithMap(value: string): NormalizedText {
  let text = '';
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];

  for (let sourceStart = 0; sourceStart < value.length;) {
    const codePoint = value.codePointAt(sourceStart);
    if (codePoint === undefined) break;
    const sourceEnd = sourceStart + (codePoint > 0xffff ? 2 : 1);
    const normalized = normalizeSearchText(value.slice(sourceStart, sourceEnd));
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      sourceStarts.push(sourceStart);
      sourceEnds.push(sourceEnd);
    }
    sourceStart = sourceEnd;
  }

  return { text, sourceStarts, sourceEnds };
}

function fuzzyMatchIndexes(candidate: string, query: string): number[] | null {
  if (!query || query.length > candidate.length) return null;
  const indexes: number[] = [];
  let candidateIndex = 0;
  for (let queryIndex = 0; queryIndex < query.length; queryIndex += 1) {
    const matchIndex = candidate.indexOf(query[queryIndex], candidateIndex);
    if (matchIndex < 0) return null;
    indexes.push(matchIndex);
    candidateIndex = matchIndex + 1;
  }
  return indexes;
}

function contiguousMatch(
  kind: RepositorySearchMatchKind,
  relevance: number,
  source: NormalizedText,
  normalizedStart: number,
  normalizedLength: number,
  sourceOffset = 0,
): RepositorySearchMatch {
  const normalizedEnd = normalizedStart + normalizedLength - 1;
  return {
    matched: true,
    relevance,
    kind,
    nameRanges: [{
      start: sourceOffset + (source.sourceStarts[normalizedStart] ?? 0),
      end: sourceOffset + (source.sourceEnds[normalizedEnd] ?? 0),
    }],
  };
}

function fuzzyMatch(
  kind: RepositorySearchMatchKind,
  relevance: number,
  source: NormalizedText,
  normalizedIndexes: readonly number[],
  sourceOffset = 0,
): RepositorySearchMatch {
  const ranges: SearchTextRange[] = [];
  for (const normalizedIndex of normalizedIndexes) {
    const start = sourceOffset + (source.sourceStarts[normalizedIndex] ?? 0);
    const end = sourceOffset + (source.sourceEnds[normalizedIndex] ?? start);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      ranges[ranges.length - 1] = { start: previous.start, end: Math.max(previous.end, end) };
    } else {
      ranges.push({ start, end });
    }
  }
  return { matched: true, relevance, kind, nameRanges: ranges };
}
