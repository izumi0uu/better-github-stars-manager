import type { Tag } from '@/types';

export interface FavoriteOverrideState {
  value: boolean;
  pending: boolean;
}

export function resolveFavoriteState(
  tag: Tag | undefined,
  override?: FavoriteOverrideState,
): { favorite: boolean; busy: boolean } {
  const persisted = !!tag?.favorite;
  return {
    favorite: override?.value ?? persisted,
    busy: override?.pending ?? false,
  };
}

export function pruneFavoriteOverrides<T extends { full_name: string }>(
  overrides: Record<string, FavoriteOverrideState>,
  tagsByFullName: Map<string, Tag>,
  rows?: T[],
): Record<string, FavoriteOverrideState> {
  const names = Object.keys(overrides);
  if (names.length === 0) return overrides;

  const rowSet = rows ? new Set(rows.map((row) => row.full_name)) : null;
  let next: Record<string, FavoriteOverrideState> | null = null;

  for (const name of names) {
    const state = overrides[name];
    const persisted = !!tagsByFullName.get(name)?.favorite;
    const shouldDrop = !state.pending && (persisted === state.value || (rowSet ? !rowSet.has(name) : false));
    if (!shouldDrop) continue;
    if (!next) next = { ...overrides };
    delete next[name];
  }

  return next ?? overrides;
}
