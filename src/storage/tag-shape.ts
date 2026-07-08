import { WATCH_REASONS, type Tag, type WatchIntent, type WatchReason } from '@/types';
import { includesTagName, normalizeTagNames } from '@/tags/tag-model';

export type LegacyTagRow = Partial<Omit<Tag, 'manualTags' | 'autoTags' | 'dismissedAutoTags'>> & {
  full_name: string;
  tags?: unknown;
  manualTags?: unknown;
  autoTags?: unknown;
  dismissedAutoTags?: unknown;
};


function normalizeWatchIntent(value: unknown): WatchIntent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<WatchIntent>;
  if (typeof candidate.enabled !== 'boolean') return undefined;
  const selected = new Set(Array.isArray(candidate.reasons) ? candidate.reasons : []);
  const reasons = WATCH_REASONS.filter((reason): reason is WatchReason => selected.has(reason));
  return { enabled: candidate.enabled, reasons };
}

function legacyManualTagNames(tagLike: Partial<LegacyTagRow> | undefined | null): string[] {
  if (!tagLike) return [];
  if (Array.isArray(tagLike.manualTags)) return normalizeTagNames(tagLike.manualTags);
  return normalizeTagNames(tagLike.tags);
}

export function normalizeStoredTag(row: LegacyTagRow): Tag {
  const manualTags = legacyManualTagNames(row);
  const dismissedAutoTags = normalizeTagNames(row.dismissedAutoTags).filter((name) => !includesTagName(manualTags, name));
  const autoTags = normalizeTagNames(row.autoTags).filter((name) => (
    !includesTagName(manualTags, name) && !includesTagName(dismissedAutoTags, name)
  ));
  const mtime = typeof row.mtime === 'string' ? row.mtime : new Date().toISOString();
  return {
    full_name: row.full_name,
    manualTags,
    autoTags,
    dismissedAutoTags,
    manualTagsMtime: typeof row.manualTagsMtime === 'string' ? row.manualTagsMtime : mtime,
    autoTagsMtime: typeof row.autoTagsMtime === 'string' ? row.autoTagsMtime : mtime,
    dismissedAutoTagsMtime: typeof row.dismissedAutoTagsMtime === 'string' ? row.dismissedAutoTagsMtime : mtime,
    notes: typeof row.notes === 'string' ? row.notes : '',
    favorite: row.favorite ?? false,
    watch: normalizeWatchIntent(row.watch),
    mtime,
    gh_list_id: row.gh_list_id ?? null,
  };
}
