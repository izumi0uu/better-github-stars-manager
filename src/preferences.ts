export const DEFAULT_AUTO_TAG_LIMIT = 5;
export const MIN_AUTO_TAG_LIMIT = 1;
export const MAX_AUTO_TAG_LIMIT = 50;

export function normalizeAutoTagLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_TAG_LIMIT;
  return Math.min(
    MAX_AUTO_TAG_LIMIT,
    Math.max(MIN_AUTO_TAG_LIMIT, Math.trunc(parsed)),
  );
}

export function normalizeStarsPanelDefaultEnabled(value: unknown): boolean {
  return value !== false;
}
