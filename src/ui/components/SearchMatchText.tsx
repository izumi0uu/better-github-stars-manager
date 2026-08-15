import type { ReactNode } from 'react';
import type { SearchTextRange } from '@/search/repository-search';

interface SearchMatchTextProps {
  text: string;
  ranges: readonly SearchTextRange[];
  sourceOffset?: number;
}

/** Renders source-coordinate search ranges with the shared semantic match tokens. */
export function SearchMatchText({
  text,
  ranges,
  sourceOffset = 0,
}: SearchMatchTextProps) {
  if (ranges.length === 0) return text;

  const content: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(text.length, range.start - sourceOffset));
    const end = Math.max(start, Math.min(text.length, range.end - sourceOffset));
    if (start > cursor) content.push(text.slice(cursor, start));
    if (end > start) {
      content.push(
        <mark
          key={`${start}:${end}`}
          data-search-match=""
          className="rounded-[2px] bg-search-match/70 text-search-match-foreground"
        >
          {text.slice(start, end)}
        </mark>,
      );
    }
    cursor = end;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return <>{content}</>;
}
