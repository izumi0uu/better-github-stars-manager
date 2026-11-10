import type { Tag, TagMeta } from '@/types';

export type TagLayerLike = Partial<Pick<Tag, 'manualTags' | 'autoTags' | 'dismissedAutoTags'>>;

export function canonicalTagKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function preferredCanonicalTagMeta(left: TagMeta, right: TagMeta): TagMeta {
  if (left.mtime !== right.mtime) return left.mtime > right.mtime ? left : right;
  const leftExcluded = left.excluded === true;
  const rightExcluded = right.excluded === true;
  if (leftExcluded !== rightExcluded) return leftExcluded ? left : right;

  const nameOrder = stableStringOrder(left.name, right.name);
  if (nameOrder !== 0) return nameOrder < 0 ? left : right;

  const dimensionOrder = stableNullableStringOrder(left.dimension, right.dimension);
  if (dimensionOrder !== 0) return dimensionOrder < 0 ? left : right;

  const colorOrder = stableNullableStringOrder(left.color, right.color);
  if (colorOrder !== 0) return colorOrder < 0 ? left : right;

  if (left.excluded !== right.excluded) return left.excluded === false ? left : right;
  return left;
}

function stableStringOrder(left: string, right: string): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function stableNullableStringOrder(left: string | null, right: string | null): -1 | 0 | 1 {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return stableStringOrder(left, right);
}

export function canonicalTagMetaWinners(
  metas: readonly TagMeta[],
): Map<string, TagMeta> {
  const winners = new Map<string, TagMeta>();
  for (const meta of metas) {
    const key = canonicalTagKey(meta.name);
    if (!key) continue;
    const current = winners.get(key);
    winners.set(key, current ? preferredCanonicalTagMeta(current, meta) : meta);
  }
  return winners;
}

export function excludedCanonicalTagKeys(
  metas: readonly TagMeta[],
): Set<string> {
  return new Set(
    [...canonicalTagMetaWinners(metas)]
      .filter(([, meta]) => meta.excluded)
      .map(([key]) => key),
  );
}

export function normalizeTagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;
    const key = canonicalTagKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function manualTagNames(tagLike: TagLayerLike | undefined | null): string[] {
  return normalizeTagNames(tagLike?.manualTags);
}

export function autoTagNames(tagLike: TagLayerLike | undefined | null): string[] {
  return normalizeTagNames(tagLike?.autoTags);
}

export function dismissedAutoTagNames(tagLike: TagLayerLike | undefined | null): string[] {
  return normalizeTagNames(tagLike?.dismissedAutoTags);
}

/** Apply global tombstones with the same canonical identity as explicit re-adds. */
export function withoutExcludedTagNames(
  names: readonly string[],
  excludedKeys: ReadonlySet<string>,
): string[] {
  return names.filter((name) => !excludedKeys.has(canonicalTagKey(name)));
}

export function visibleTagNames(
  tagLike: TagLayerLike | undefined | null,
  excludedKeys?: ReadonlySet<string>,
): string[] {
  const names = normalizeTagNames([...manualTagNames(tagLike), ...autoTagNames(tagLike)]);
  return excludedKeys ? withoutExcludedTagNames(names, excludedKeys) : names;
}

export function sameTagNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function withoutTagName(names: string[], name: string): string[] {
  const key = canonicalTagKey(name);
  return names.filter((item) => canonicalTagKey(item) !== key);
}

export function includesTagName(names: string[], name: string): boolean {
  const key = canonicalTagKey(name);
  return names.some((item) => canonicalTagKey(item) === key);
}

export function addTagNames(names: string[], additions: string[]): string[] {
  return normalizeTagNames([...names, ...additions]);
}
