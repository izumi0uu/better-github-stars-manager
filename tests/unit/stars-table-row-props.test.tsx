/**
 * @vitest-environment jsdom
 */
import { act, createRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@/types';
import type { FavoriteOverrideState } from '@/ui/favorite-state';
import type { StarRowProps } from '@/ui/components/StarRow';
import type { ColumnId } from '@/ui/column-layout';
import { StarsTable } from '@/ui/components/StarsTable';
import { fakeStar, fakeTag } from './test-utils';

const capturedRowProps = vi.hoisted(() => [] as unknown[]);

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 64 })),
  }),
}));

vi.mock('@/ui/components/StarRow', () => ({
  StarRow: (props: StarRowProps) => {
    capturedRowProps.push(props);
    return <div data-testid="captured-star-row" />;
  },
}));

const mountedRoots: Root[] = [];
const row = fakeStar();
const otherRow = fakeStar({ full_name: 'other/repo', html_url: 'https://github.com/other/repo' });
const rows = [row, otherRow];
const tag = fakeTag({ notes: '', favorite: false });
const otherTag = fakeTag({ full_name: otherRow.full_name, notes: '', favorite: false });
const tagsByFullName = new Map<string, Tag>([
  [row.full_name, tag],
  [otherRow.full_name, otherTag],
]);
const selectedTags: string[] = [];
const visibleColumns: ColumnId[] = ['repository', 'favorite', 'starAction'];
const emptyFavoriteOverrides: Record<string, FavoriteOverrideState> = {};
const onSelect = vi.fn();
const onToggleTag = vi.fn();
const onToggleFavorite = vi.fn(async () => undefined);
const onConfirmUnstar = vi.fn();
const onOpenUnstarChange = vi.fn();
const onBeginColumnDrag = vi.fn();

function table({
  loading = false,
  selectedFullName = null,
  favoriteOverrides = emptyFavoriteOverrides,
  openUnstarFullName = null,
}: {
  loading?: boolean;
  selectedFullName?: string | null;
  favoriteOverrides?: Record<string, FavoriteOverrideState>;
  openUnstarFullName?: string | null;
} = {}): ReactElement {
  const scrollRef = { current: document.createElement('div') };
  return (
    <StarsTable
      rows={rows}
      searchQuery="repo"
      loading={loading}
      phase="idle"
      tagsByFullName={tagsByFullName}
      favoriteOverrides={favoriteOverrides}
      selectedTags={selectedTags}
      selectedFullName={selectedFullName}
      visibleColumns={visibleColumns}
      gridTemplateColumns="180px 28px 32px"
      interactionLocked={false}
      layoutEdit={{
        editing: false,
        faded: false,
        draggedColumnId: null,
        draggedColumnHideIntent: false,
        columnShifts: {},
        flashedColumn: null,
        trayCaretX: null,
        onBeginColumnDrag,
      }}
      scrollRef={scrollRef}
      headerRef={createRef<HTMLDivElement>()}
      onSelect={onSelect}
      onToggleTag={onToggleTag}
      onToggleFavorite={onToggleFavorite}
      onConfirmUnstar={onConfirmUnstar}
      openUnstarFullName={openUnstarFullName}
      onOpenUnstarChange={onOpenUnstarChange}
    />
  );
}

function latestRowProps(fullName: string): StarRowProps {
  const latest = capturedRowProps.findLast((value) => (
    (value as StarRowProps).star.full_name === fullName
  ));
  if (!latest) throw new Error(`Expected StarsTable to render ${fullName}`);
  return latest as StarRowProps;
}

function changedPropNames(before: StarRowProps, after: StarRowProps): string[] {
  return Object.keys(after)
    .filter((key) => !Object.is(before[key as keyof StarRowProps], after[key as keyof StarRowProps]))
    .sort();
}

function render(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push(root);
  return root;
}

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
    mountedRoots.length = 0;
  });
  capturedRowProps.length = 0;
  document.body.replaceChildren();
});

describe('StarsTable row prop identity', () => {
  it('keeps unrelated row inputs shallow-equal and changes only the affected row state', () => {
    const root = render(table());
    const initial = latestRowProps(row.full_name);
    const initialOther = latestRowProps(otherRow.full_name);

    act(() => root.render(table({ loading: true })));
    const unrelated = latestRowProps(row.full_name);
    const unrelatedOther = latestRowProps(otherRow.full_name);
    expect(changedPropNames(initial, unrelated)).toEqual([]);
    expect(changedPropNames(initialOther, unrelatedOther)).toEqual([]);

    act(() => root.render(table({ loading: true, selectedFullName: row.full_name })));
    const selected = latestRowProps(row.full_name);
    const selectedOther = latestRowProps(otherRow.full_name);
    expect(changedPropNames(unrelated, selected)).toEqual(['selected']);
    expect(changedPropNames(unrelatedOther, selectedOther)).toEqual([]);

    act(() => root.render(table({
      loading: true,
      selectedFullName: row.full_name,
      favoriteOverrides: { [row.full_name]: { value: true, pending: true } },
    })));
    const favorite = latestRowProps(row.full_name);
    const favoriteOther = latestRowProps(otherRow.full_name);
    expect(changedPropNames(selected, favorite)).toEqual(['favorite', 'favoriteBusy']);
    expect(changedPropNames(selectedOther, favoriteOther)).toEqual([]);

    act(() => root.render(table({
      loading: true,
      selectedFullName: row.full_name,
      favoriteOverrides: { [row.full_name]: { value: true, pending: true } },
      openUnstarFullName: row.full_name,
    })));
    const unstarOpen = latestRowProps(row.full_name);
    const unstarOther = latestRowProps(otherRow.full_name);
    expect(changedPropNames(favorite, unstarOpen)).toEqual(['unstarPopoverOpen']);
    expect(changedPropNames(favoriteOther, unstarOther)).toEqual([]);
  });
});
