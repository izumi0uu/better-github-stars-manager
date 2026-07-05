export interface InlineTagFitInput {
  availableWidth: number;
  tagWidths: number[];
  gapWidth: number;
  hiddenCountWidth: (hiddenCount: number) => number;
}

export interface InlineTagFitResult {
  visibleCount: number;
  hiddenCount: number;
}

export function fitInlineTags({
  availableWidth,
  tagWidths,
  gapWidth,
  hiddenCountWidth,
}: InlineTagFitInput): InlineTagFitResult {
  const total = tagWidths.length;
  if (total === 0) return { visibleCount: 0, hiddenCount: 0 };
  if (total === 1) return { visibleCount: 1, hiddenCount: 0 };

  const width = Math.max(0, availableWidth);
  const gap = Math.max(0, gapWidth);
  const widths = tagWidths.map((item) => Math.max(0, item));

  if (tagsWidth(widths, total, gap) <= width) {
    return { visibleCount: total, hiddenCount: 0 };
  }

  for (let visibleCount = total - 1; visibleCount >= 1; visibleCount -= 1) {
    const hiddenCount = total - visibleCount;
    const requiredWidth =
      tagsWidth(widths, visibleCount, gap) +
      gap +
      Math.max(0, hiddenCountWidth(hiddenCount));

    if (requiredWidth <= width) {
      return { visibleCount, hiddenCount };
    }
  }

  return { visibleCount: 0, hiddenCount: total };
}

function tagsWidth(widths: number[], count: number, gapWidth: number): number {
  if (count <= 0) return 0;

  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += widths[index] ?? 0;
  }

  return total + gapWidth * (count - 1);
}
