/**
 * @vitest-environment jsdom
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Star, Tag } from '@/types';
import { StarsTable } from '@/ui/components/StarsTable';
import { DEFAULT_COLUMN_LAYOUT, gridTemplateFor } from '@/ui/column-layout';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    m: {
      common: { loading: 'Loading' },
      manager: { emptyState: 'No stars' },
      toolbar: {
        columnRepository: 'Repository',
        columnDescription: 'Description',
        columnLanguage: 'Language',
        columnStars: 'Stars',
        columnUpdated: 'Updated',
        columnCreated: 'Created',
        columnTags: 'Tags',
        columnFavorite: 'Favorite',
        columnNotes: 'Notes',
        dragColumnTitle: (label: string) => `Drag ${label}`,
      },
    },
  }),
}));

type ObserverEntry = Pick<IntersectionObserverEntry, 'isIntersecting'>;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  emit(entry: ObserverEntry) {
    this.callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const mountedRoots: Root[] = [];

function renderTable(rows: Star[] = []) {
  const container = document.createElement('div');
  const scrollContainer = document.createElement('div');
  document.body.append(scrollContainer, container);
  const root = createRoot(container);
  const scrollRef = { current: scrollContainer };
  const headerRef = createRef<HTMLDivElement>();

  act(() => {
    root.render(
      <StarsTable
        rows={rows}
        loading={false}
        phase="idle"
        tagsByFullName={new Map<string, Tag>()}
        favoriteOverrides={{}}
        selectedTags={[]}
        selectedFullName={null}
        visibleColumns={DEFAULT_COLUMN_LAYOUT.order}
        gridTemplateColumns={gridTemplateFor(DEFAULT_COLUMN_LAYOUT)}
        editingLayout={false}
        interactionLocked={false}
        layoutFaded={false}
        draggedColumnId={null}
        draggedColumnHideIntent={false}
        columnShifts={{}}
        flashedColumn={null}
        trayCaretX={null}
        scrollRef={scrollRef}
        headerRef={headerRef}
        onSelect={vi.fn()}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn()}
        onBeginColumnDrag={vi.fn()}
      />,
    );
  });

  mountedRoots.push(root);
  return { container, headerRef };
}

describe('stars table sticky header', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots) root.unmount();
      mountedRoots.length = 0;
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('keeps the real table head sticky without rendering a cloned header', () => {
    const { container } = renderTable();
    const heads = container.querySelectorAll('[data-table-head]');
    const sentinel = container.querySelector('[data-table-head-sentinel]');

    expect(heads).toHaveLength(1);
    expect(sentinel).not.toBeNull();
    expect([...heads[0].classList]).toEqual(expect.arrayContaining(['sticky', 'top-0', 'gsm-z-sticky']));
    expect(heads[0].getAttribute('data-stuck')).toBe('false');
  });

  it('marks the same table head as stuck after its sentinel leaves the scroll root', () => {
    const { container, headerRef } = renderTable();
    const observer = FakeIntersectionObserver.instances[0];

    act(() => {
      observer.emit({ isIntersecting: false });
    });

    const heads = container.querySelectorAll('[data-table-head]');
    expect(heads).toHaveLength(1);
    expect(headerRef.current).toBe(heads[0]);
    expect(heads[0].getAttribute('data-stuck')).toBe('true');
    expect(heads[0].classList.contains('gsm-table-head-stuck')).toBe(true);
  });
});
