import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import type { Star, Tag, TagMeta } from '@/types';
import {
  parseSourceFingerprint,
  parseTaxonomyFingerprint,
  type SourceFingerprint,
  type TaxonomyFingerprint,
} from './proposal';

export type SourceFingerprintInput = Readonly<{
  star: Star;
  tag: Tag | null;
}>;

export type TaxonomyFingerprintInput = readonly Readonly<{
  name: string;
  exists: boolean;
  usageCount: number;
  excluded: boolean;
  dimension: string | null;
  sourceMtime: string;
}>[];

export const MAX_FINGERPRINT_TAXONOMY_ENTRIES = 500;
export const MAX_FINGERPRINT_NAME_BYTES = 256;
export const MAX_FINGERPRINT_DIMENSION_BYTES = 256;

export function sourceFingerprint(input: SourceFingerprintInput): Promise<SourceFingerprint>;
export function sourceFingerprint(star: Star, tag?: Tag | null): Promise<SourceFingerprint>;
export async function sourceFingerprint(
  inputOrStar: SourceFingerprintInput | Star,
  tag?: Tag | null,
): Promise<SourceFingerprint> {
  const input = 'star' in inputOrStar ? inputOrStar : { star: inputOrStar, tag: tag ?? null };
  const tuple = Object.freeze([
    1,
    Object.freeze([
      input.star.full_name,
      input.star.description,
      input.star.language,
      Object.freeze(normalizeSortedNames(input.star.topics)),
      input.star.stargazers_count,
      input.star.pushed_at,
      input.star.created_at,
      input.star.fork,
      input.star.archived,
      input.star.starred_at,
      input.star.tombstone,
    ]),
    Object.freeze([
      Object.freeze(normalizeSortedNames(input.tag?.manualTags ?? [])),
      Object.freeze(normalizeSortedNames(input.tag?.autoTags ?? [])),
      Object.freeze(normalizeSortedNames(input.tag?.dismissedAutoTags ?? [])),
      input.tag?.manualTagsMtime ?? null,
      input.tag?.autoTagsMtime ?? null,
      input.tag?.dismissedAutoTagsMtime ?? null,
    ]),
  ]);
  return parseSourceFingerprint(`sf:v1:${await sha256Base64Url(canonicalJson(tuple))}`);
}

export function taxonomyFingerprint(
  taxonomy: TaxonomyFingerprintInput,
): Promise<TaxonomyFingerprint>;
export function taxonomyFingerprint(
  tagMeta: readonly TagMeta[],
  tags?: readonly Tag[],
): Promise<TaxonomyFingerprint>;
export async function taxonomyFingerprint(
  taxonomyOrMeta: TaxonomyFingerprintInput | readonly TagMeta[],
  tags?: readonly Tag[],
): Promise<TaxonomyFingerprint> {
  const taxonomy = tags === undefined && isTaxonomyFingerprintInput(taxonomyOrMeta)
    ? normalizeTaxonomyFingerprintInput(taxonomyOrMeta)
    : canonicalTaxonomyEntries(taxonomyOrMeta as readonly TagMeta[], tags ?? []);
  const tuple = Object.freeze([
    1,
    Object.freeze(taxonomy.map((entry) => Object.freeze([
      entry.name.normalize('NFKC'),
      entry.exists,
      entry.usageCount,
      entry.excluded,
      entry.dimension?.normalize('NFKC') ?? null,
      entry.sourceMtime,
    ]))),
  ]);
  return parseTaxonomyFingerprint(`tf:v1:${await sha256Base64Url(canonicalJson(tuple))}`);
}

function normalizeTaxonomyFingerprintInput(
  taxonomy: TaxonomyFingerprintInput,
): TaxonomyFingerprintInput {
  if (taxonomy.length > MAX_FINGERPRINT_TAXONOMY_ENTRIES) {
    throw new RangeError('Semantic taxonomy exceeds the bounded entry limit.');
  }
  const entries = new Map<string, TaxonomyFingerprintInput[number]>();
  for (const entry of taxonomy) {
    const name = normalizeBounded(entry.name, MAX_FINGERPRINT_NAME_BYTES, 'Taxonomy name');
    const key = name.toLocaleLowerCase('en-US');
    if (entries.has(key)) throw new TypeError('Taxonomy names must be normalized-unique.');
    if (!Number.isSafeInteger(entry.usageCount) || entry.usageCount < 0) {
      throw new TypeError('Taxonomy usageCount must be a nonnegative safe integer.');
    }
    if (typeof entry.sourceMtime !== 'string') {
      throw new TypeError('Taxonomy sourceMtime must be a string.');
    }
    entries.set(key, Object.freeze({
      name,
      exists: entry.exists,
      usageCount: entry.usageCount,
      excluded: entry.excluded,
      dimension: entry.dimension === null
        ? null
        : truncateUtf8(entry.dimension.normalize('NFKC'), MAX_FINGERPRINT_DIMENSION_BYTES),
      sourceMtime: entry.sourceMtime,
    }));
  }
  return Object.freeze([...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([, entry]) => entry));
}

export function canonicalTaxonomyEntries(
  tagMeta: readonly TagMeta[],
  tags: readonly Tag[] = [],
): TaxonomyFingerprintInput {
  const visible = new Map<string, {
    name: string;
    usageCount: number;
    sourceMtime: string;
  }>();
  for (const tag of tags) {
    const rowNames = new Map<string, { name: string; sourceMtime: string }>();
    collectVisibleLayer(rowNames, tag.manualTags, tag.manualTagsMtime);
    collectVisibleLayer(rowNames, tag.autoTags, tag.autoTagsMtime);
    for (const [key, row] of rowNames) {
      const current = visible.get(key);
      visible.set(key, {
        name: current ? stableDisplayName(current.name, row.name) : row.name,
        usageCount: (current?.usageCount ?? 0) + 1,
        sourceMtime: maxMtime(current?.sourceMtime ?? '', row.sourceMtime),
      });
    }
  }
  const entries = new Map<string, TaxonomyFingerprintInput[number]>();
  for (const meta of tagMeta) {
    const name = normalizeBounded(meta.name, MAX_FINGERPRINT_NAME_BYTES, 'Taxonomy name');
    const key = name.toLocaleLowerCase('en-US');
    if (entries.has(key)) throw new TypeError('Taxonomy names must be normalized-unique.');
    const visibleEntry = visible.get(key);
    entries.set(key, Object.freeze({
      name,
      exists: true,
      usageCount: visibleEntry?.usageCount ?? 0,
      excluded: meta.excluded === true,
      dimension: meta.dimension === null
        ? null
        : truncateUtf8(meta.dimension.normalize('NFKC'), MAX_FINGERPRINT_DIMENSION_BYTES),
      sourceMtime: meta.mtime,
    }));
    visible.delete(key);
  }
  for (const [key, entry] of visible) {
    const name = normalizeBounded(entry.name, MAX_FINGERPRINT_NAME_BYTES, 'Taxonomy name');
    entries.set(key, Object.freeze({
      name,
      exists: true,
      usageCount: entry.usageCount,
      excluded: false,
      dimension: null,
      sourceMtime: entry.sourceMtime,
    }));
  }
  if (entries.size > MAX_FINGERPRINT_TAXONOMY_ENTRIES) {
    throw new RangeError('Semantic taxonomy exceeds the bounded entry limit.');
  }
  return Object.freeze([...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([, entry]) => entry));
}

function collectVisibleLayer(
  target: Map<string, { name: string; sourceMtime: string }>,
  names: readonly string[],
  sourceMtime: string,
): void {
  for (const rawName of names) {
    const name = normalizeBounded(rawName, MAX_FINGERPRINT_NAME_BYTES, 'Taxonomy name');
    const key = name.toLocaleLowerCase('en-US');
    const current = target.get(key);
    target.set(key, {
      name: current ? stableDisplayName(current.name, name) : name,
      sourceMtime: maxMtime(current?.sourceMtime ?? '', sourceMtime),
    });
  }
}

function stableDisplayName(left: string, right: string): string {
  return left.localeCompare(right, 'en-US') <= 0 ? left : right;
}

function maxMtime(left: string, right: string): string {
  return left >= right ? left : right;
}

function normalizeSortedNames(values: readonly string[]): string[] {
  const normalized = new Map<string, string>();
  for (const value of values) {
    const name = value.normalize('NFKC');
    const key = name.toLocaleLowerCase('en-US');
    if (!normalized.has(key)) normalized.set(key, name);
  }
  return [...normalized.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([, value]) => value);
}

function isTaxonomyFingerprintInput(
  value: TaxonomyFingerprintInput | readonly TagMeta[],
): value is TaxonomyFingerprintInput {
  return value.every((entry) => 'exists' in entry && 'usageCount' in entry && 'sourceMtime' in entry);
}

function normalizeBounded(value: string, maximum: number, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be nonempty.`);
  const normalized = value.trim().normalize('NFKC');
  if (new TextEncoder().encode(normalized).byteLength > maximum) {
    throw new RangeError(`${field} exceeds ${maximum} UTF-8 bytes.`);
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
