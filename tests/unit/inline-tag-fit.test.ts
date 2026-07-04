import { describe, expect, it } from 'vitest';
import { fitInlineTags } from '@/ui/inline-tag-fit';

describe('inline tag fitting', () => {
  const gapWidth = 4;
  const hiddenCountWidth = (count: number) => (count >= 10 ? 24 : 18);

  it('shows all tags when their chips fit without a hidden count', () => {
    expect(fitInlineTags({
      availableWidth: 120,
      tagWidths: [24, 32, 28],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 3, hiddenCount: 0 });
  });

  it('shows more than two tags when the width allows it', () => {
    expect(fitInlineTags({
      availableWidth: 118,
      tagWidths: [24, 24, 24, 24, 24],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 3, hiddenCount: 2 });
  });

  it('reserves room for the candidate hidden-count element', () => {
    expect(fitInlineTags({
      availableWidth: 74,
      tagWidths: [24, 24, 24, 24],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 2, hiddenCount: 2 });
  });

  it('shows the first tag plus hidden count only when both fit', () => {
    expect(fitInlineTags({
      availableWidth: 46,
      tagWidths: [24, 28, 28],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 1, hiddenCount: 2 });
  });

  it('falls back to the hidden-count element alone when the first tag cannot fit with it', () => {
    expect(fitInlineTags({
      availableWidth: 45,
      tagWidths: [24, 28, 28],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 0, hiddenCount: 3 });
  });

  it('uses candidate-specific hidden-count widths across digit boundaries', () => {
    expect(fitInlineTags({
      availableWidth: 73,
      tagWidths: Array.from({ length: 13 }, () => 10),
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 3, hiddenCount: 10 });

    expect(fitInlineTags({
      availableWidth: 74,
      tagWidths: Array.from({ length: 13 }, () => 10),
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 4, hiddenCount: 9 });
  });

  it('handles zero tags and one tag', () => {
    expect(fitInlineTags({
      availableWidth: 20,
      tagWidths: [],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 0, hiddenCount: 0 });

    expect(fitInlineTags({
      availableWidth: 1,
      tagWidths: [80],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 1, hiddenCount: 0 });
  });

  it('handles a long first tag without producing a negative hidden count', () => {
    expect(fitInlineTags({
      availableWidth: 52,
      tagWidths: [100, 20, 20],
      hiddenCountWidth,
      gapWidth,
    })).toEqual({ visibleCount: 0, hiddenCount: 3 });
  });
});
