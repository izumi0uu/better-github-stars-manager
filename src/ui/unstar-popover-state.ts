export function nextOpenUnstarFullName(
  current: string | null,
  next: string | null,
  sourceFullName: string,
): string | null {
  if (next) return next;
  return current === sourceFullName ? null : current;
}
