export function formatRadarAbsoluteTime(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatRadarRelativeTime(
  value: string,
  locale: string,
  nowMillis = Date.now(),
): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return '—';
  const minutes = Math.max(0, Math.round((nowMillis - then) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.round(hours / 24), 'day');
}
