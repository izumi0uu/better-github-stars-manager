import type { Tag } from '@/types';

export type TagLayerLike = Partial<Pick<Tag, 'manualTags' | 'autoTags' | 'dismissedAutoTags'>>;

export function normalizeTagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
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

export function visibleTagNames(tagLike: TagLayerLike | undefined | null): string[] {
  return normalizeTagNames([...manualTagNames(tagLike), ...autoTagNames(tagLike)]);
}

export function sameTagNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function withoutTagName(names: string[], name: string): string[] {
  const key = name.toLowerCase();
  return names.filter((item) => item.toLowerCase() !== key);
}

export function includesTagName(names: string[], name: string): boolean {
  const key = name.toLowerCase();
  return names.some((item) => item.toLowerCase() === key);
}

export function addTagNames(names: string[], additions: string[]): string[] {
  return normalizeTagNames([...names, ...additions]);
}
