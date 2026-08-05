import type { Star, Tag, TagMeta } from '@/types';
import { canonicalTagMetaWinners } from '@/tags/tag-model';
import { MAX_SEMANTIC_TAG_NAME_BYTES } from './policy';
import type { SourceFingerprintV1 } from './proposal';
import {
  MAX_FINGERPRINT_DIMENSION_BYTES,
  MAX_FINGERPRINT_TAXONOMY_ENTRIES,
  canonicalTaxonomyEntries,
  sourceFingerprintV1,
  taxonomyFingerprintV1,
  type TaxonomyFingerprintInput,
} from './source-fingerprint';

export const MAX_SEMANTIC_DESCRIPTION_BYTES = 4_096;
export const MAX_SEMANTIC_TOPIC_COUNT = 32;
export const MAX_SEMANTIC_TAGS_PER_LAYER = 64;
export const MAX_SEMANTIC_TAXONOMY_ENTRIES = MAX_FINGERPRINT_TAXONOMY_ENTRIES;
export const MAX_SEMANTIC_DIMENSION_BYTES = MAX_FINGERPRINT_DIMENSION_BYTES;

export type SemanticRepositoryDto = Readonly<{
  frozenIndex: number;
  repositoryId: string;
  sourceFingerprint: SourceFingerprintV1;
  fullName: string;
  description: string;
  language: string | null;
  topics: readonly string[];
  stargazersCount: number;
  pushedAt: string | null;
  createdAt: string | null;
  fork: boolean;
  archived: boolean;
  starredAt: string;
  tags: Readonly<{
    manual: readonly string[];
    automatic: readonly string[];
  }>;
}>;

export type SemanticTaxonomySource = Readonly<{
  meta: TagMeta;
  usageCount: number;
  exists?: boolean;
}>;

export type SemanticTaxonomyEntryDto = Readonly<{
  name: string;
  exists: boolean;
  usageCount: number;
  excluded: boolean;
  dimension: string | null;
  sourceMtime: string;
}>;

export type SemanticTaxonomyDto = Readonly<{
  version: 1;
  entries: readonly SemanticTaxonomyEntryDto[];
}>;

export async function buildSemanticRepositoryDto(input: Readonly<{
  frozenIndex: number;
  star: Star;
  tag: Tag | null;
  excludedTagNames: readonly string[];
}>): Promise<SemanticRepositoryDto> {
  assertNonnegativeSafeInteger(input.frozenIndex, 'Semantic repository frozenIndex');
  assertTrimmedNonempty(input.star.full_name, 'Semantic repository full_name');
  const sourceFingerprint = await sourceFingerprintV1(input.star, input.tag);
  const excludedTagKeys = new Set(input.excludedTagNames.map(normalizedNameKey));
  const tags = Object.freeze({
    manual: Object.freeze(boundedNames(
      input.tag?.manualTags ?? [],
      MAX_SEMANTIC_TAGS_PER_LAYER,
      excludedTagKeys,
    )),
    automatic: Object.freeze(boundedNames(
      input.tag?.autoTags ?? [],
      MAX_SEMANTIC_TAGS_PER_LAYER,
      excludedTagKeys,
    )),
  });
  return Object.freeze({
    frozenIndex: input.frozenIndex,
    repositoryId: input.star.full_name,
    sourceFingerprint,
    fullName: input.star.full_name,
    description: truncateUtf8(input.star.description, MAX_SEMANTIC_DESCRIPTION_BYTES),
    language: input.star.language === null
      ? null
      : truncateUtf8(input.star.language.normalize('NFKC'), MAX_SEMANTIC_TAG_NAME_BYTES),
    topics: Object.freeze(boundedNames(input.star.topics, MAX_SEMANTIC_TOPIC_COUNT)),
    stargazersCount: input.star.stargazers_count,
    pushedAt: input.star.pushed_at,
    createdAt: input.star.created_at,
    fork: input.star.fork,
    archived: input.star.archived,
    starredAt: input.star.starred_at,
    tags,
  });
}

export function buildSemanticTaxonomyDto(
  sources: readonly SemanticTaxonomySource[],
): SemanticTaxonomyDto {
  if (sources.length > MAX_SEMANTIC_TAXONOMY_ENTRIES) {
    throw new RangeError('Semantic taxonomy exceeds the bounded entry limit.');
  }
  const entries = new Map<string, SemanticTaxonomyEntryDto>();
  for (const source of sources) {
    assertNonnegativeSafeInteger(source.usageCount, 'Semantic taxonomy usageCount');
    const name = normalizeBoundedName(source.meta.name, 'Semantic taxonomy name');
    const key = name.toLocaleLowerCase('en-US');
    if (entries.has(key)) throw new TypeError('Semantic taxonomy names must be normalized-unique.');
    const dimension = source.meta.dimension === null
      ? null
      : truncateUtf8(source.meta.dimension.normalize('NFKC'), MAX_SEMANTIC_DIMENSION_BYTES);
    entries.set(key, Object.freeze({
      name,
      exists: source.exists ?? true,
      usageCount: source.usageCount,
      excluded: source.meta.excluded === true,
      dimension,
      sourceMtime: source.meta.mtime,
    }));
  }
  return filterVisibleSemanticTaxonomy(Object.freeze({
    version: 1,
    entries: Object.freeze([...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .map(([, entry]) => entry)),
  }));
}

export function buildSemanticTaxonomyFromStorage(
  tagMeta: readonly TagMeta[],
  tags: readonly Tag[],
): SemanticTaxonomyDto {
  return filterVisibleSemanticTaxonomy(buildSemanticPolicyTaxonomyFromStorage(tagMeta, tags));
}

export function buildSemanticPolicyTaxonomyFromStorage(
  tagMeta: readonly TagMeta[],
  tags: readonly Tag[],
): SemanticTaxonomyDto {
  return Object.freeze({
    version: 1,
    entries: Object.freeze(canonicalTaxonomyEntries(
      [...canonicalTagMetaWinners(tagMeta).values()],
      tags,
    ).map((entry) =>
      Object.freeze({ ...entry }))),
  });
}

export function filterVisibleSemanticTaxonomy(
  taxonomy: SemanticTaxonomyDto,
): SemanticTaxonomyDto {
  return Object.freeze({
    version: 1,
    entries: Object.freeze(taxonomy.entries.filter((entry) => !entry.excluded)),
  });
}

export function findSemanticTaxonomyEntry(
  taxonomy: SemanticTaxonomyDto,
  name: string,
): SemanticTaxonomyEntryDto | undefined {
  const key = name.normalize('NFKC').toLocaleLowerCase('en-US');
  return taxonomy.entries.find((entry) =>
    entry.name.toLocaleLowerCase('en-US') === key);
}

export async function fingerprintSemanticTaxonomy(dto: SemanticTaxonomyDto) {
  return taxonomyFingerprintV1(dto.entries as TaxonomyFingerprintInput);
}

function boundedNames(
  values: readonly string[],
  limit: number,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  const names = new Map<string, string>();
  for (const raw of values) {
    const name = normalizeBoundedName(raw, 'Semantic name');
    const key = name.toLocaleLowerCase('en-US');
    if (excluded.has(key)) continue;
    if (!names.has(key)) names.set(key, name);
  }
  return [...names.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .slice(0, limit)
    .map(([, value]) => value);
}

function normalizedNameKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function normalizeBoundedName(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be nonempty.`);
  const normalized = value.trim().normalize('NFKC');
  if (new TextEncoder().encode(normalized).byteLength > MAX_SEMANTIC_TAG_NAME_BYTES) {
    throw new RangeError(`${field} exceeds ${MAX_SEMANTIC_TAG_NAME_BYTES} UTF-8 bytes.`);
  }
  return normalized;
}

function truncateUtf8(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximum) return value;
  let result = '';
  for (const codePoint of value) {
    if (encoder.encode(result + codePoint).byteLength > maximum) break;
    result += codePoint;
  }
  return result;
}

function assertTrimmedNonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new TypeError(`${field} must be a trimmed nonempty string.`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}
