/**
 * @vitest-environment jsdom
 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterSidebar } from '@/ui/components/FilterSidebar';
import type { FilterState } from '@/ui/filter-store';
import {
  cleanupMountedRootsAndBody,
  click,
  mountWithTooltipProvider,
  setInputValue,
  type MountedRoot,
} from './test-utils';

const messagingMocks = vi.hoisted(() => ({
  bgCall: vi.fn(),
}));

vi.mock('@/utils/messaging', () => ({
  bgCall: messagingMocks.bgCall,
}));

const mountedRoots: MountedRoot[] = [];

function mount(element: ReactElement): HTMLDivElement {
  return mountWithTooltipProvider(element, mountedRoots);
}

function makeFilterState(order: string[], tags = ['react', 'ui']): FilterState {
  return {
    query: '',
    languages: [],
    tags,
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
    setQuery: vi.fn(),
    toggleLanguage: vi.fn(),
    toggleTag: vi.fn(),
    clearTags: vi.fn(() => order.push('clearTags')),
    setTagMode: vi.fn(),
    setShowTombstone: vi.fn(),
    setOnlyFavorite: vi.fn(),
    setOnlyUntagged: vi.fn(),
    setOnlyArchived: vi.fn(),
    setSort: vi.fn(),
    resetFilters: vi.fn(),
  };
}

function getButtons(container: HTMLDivElement) {
  return [...container.querySelectorAll('button')];
}

function getTagNames(container: HTMLDivElement) {
  return [...container.querySelectorAll('span.flex-1.truncate')].map((node) => node.textContent ?? '');
}

function getTagRows(container: HTMLDivElement) {
  return [...container.querySelectorAll('div.group\\/tag')];
}

function getNaturalTagOrder(tags: { name: string; count: number }[], direction: 'asc' | 'desc') {
  const collator = new Intl.Collator(['zh-CN', 'en'], { numeric: true, sensitivity: 'base' });
  const sorted = [...tags].sort((a, b) => collator.compare(a.name, b.name));
  return (direction === 'asc' ? sorted : sorted.reverse()).map(({ name }) => name);
}

describe('FilterSidebar delete-all-tags control', () => {
  beforeEach(() => {
    messagingMocks.bgCall.mockReset();
  });

  afterEach(() => {
    cleanupMountedRootsAndBody(mountedRoots);
  });

  it('renders the sort control beside the Tags header and natural-sorts tags across search toggles', async () => {
    const tags = [
      { name: 'tag10', count: 1 },
      { name: '中文10', count: 1 },
      { name: 'Beta', count: 1 },
      { name: 'tag2', count: 1 },
      { name: '中文2', count: 1 },
      { name: 'alpha', count: 1 },
    ];
    const container = mount(
      <FilterSidebar
        f={makeFilterState([])}
        languages={[]}
        tagTree={{ total: tags.length, tags }}
      />,
    );

    const buttons = getButtons(container);
    const tagsHeader = buttons.find((button) => button.textContent?.includes('Tags (6)')) as HTMLButtonElement | undefined;
    const sortButton = buttons.find((button) => button.title === 'Sort tags A to Z') as HTMLButtonElement | undefined;
    const deleteAll = buttons.find((button) => button.title === 'Delete all tags') as HTMLButtonElement | undefined;
    expect(tagsHeader).toBeTruthy();
    expect(sortButton).toBeTruthy();
    expect(deleteAll).toBeTruthy();
    expect(buttons.indexOf(sortButton!)).toBeGreaterThan(buttons.indexOf(tagsHeader!));
    expect(buttons.indexOf(sortButton!)).toBeLessThan(buttons.indexOf(deleteAll!));
    expect(sortButton!.getAttribute('aria-label')).toBe('Sort tags A to Z');
    expect(sortButton!.getAttribute('aria-pressed')).toBe('false');

    expect(getTagNames(container)).toEqual(tags.map(({ name }) => name));

    await click(sortButton!);

    const ascNames = getTagNames(container);
    expect(ascNames).toEqual(getNaturalTagOrder(tags, 'asc'));
    expect(ascNames.indexOf('tag2')).toBeLessThan(ascNames.indexOf('tag10'));
    expect(ascNames.indexOf('alpha')).toBeLessThan(ascNames.indexOf('Beta'));
    expect(ascNames.indexOf('中文2')).toBeLessThan(ascNames.indexOf('中文10'));
    expect(sortButton!.title).toBe('Sort tags Z to A');
    expect(sortButton!.getAttribute('aria-label')).toBe('Sort tags Z to A');
    expect(sortButton!.getAttribute('aria-pressed')).toBe('true');

    const searchInput = container.querySelector('input[placeholder="Search tags…"]') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();
    await setInputValue(searchInput!, 'tag');
    expect(getTagNames(container)).toEqual(['tag2', 'tag10']);

    await click(sortButton!);
    expect(getTagNames(container)).toEqual(['tag10', 'tag2']);
    expect(sortButton!.title).toBe('Sort tags A to Z');
    expect(sortButton!.getAttribute('aria-label')).toBe('Sort tags A to Z');
    expect(sortButton!.getAttribute('aria-pressed')).toBe('true');

    await setInputValue(searchInput!, '');
    expect(getTagNames(container)).toEqual(getNaturalTagOrder(tags, 'desc'));
  });

  it('keeps Any and All tag mode actions stable after sorting', async () => {
    const tags = [
      { name: 'tag10', count: 1 },
      { name: 'Beta', count: 1 },
      { name: 'tag2', count: 1 },
      { name: 'alpha', count: 1 },
    ];
    const f = makeFilterState([]);
    const container = mount(
      <FilterSidebar
        f={f}
        languages={[]}
        tagTree={{ total: tags.length, tags }}
      />,
    );

    const sortButton = getButtons(container).find((button) => button.title === 'Sort tags A to Z') as HTMLButtonElement | undefined;
    const headerButton = getButtons(container).find((button) => button.textContent?.includes('Tags (4)')) as HTMLButtonElement | undefined;
    const anyButton = getButtons(container).find((button) => button.textContent === 'Any') as HTMLButtonElement | undefined;
    const allButton = getButtons(container).find((button) => button.textContent === 'All') as HTMLButtonElement | undefined;
    expect(sortButton).toBeTruthy();
    expect(headerButton).toBeTruthy();
    expect(anyButton).toBeTruthy();
    expect(allButton).toBeTruthy();

    await click(sortButton!);

    const sortedNames = getNaturalTagOrder(tags, 'asc');
    expect(getTagNames(container)).toEqual(sortedNames);
    expect(getTagRows(container)).toHaveLength(tags.length);

    await click(anyButton!);
    expect(f.setTagMode).toHaveBeenLastCalledWith('any');
    expect(getTagNames(container)).toEqual(sortedNames);
    expect(getTagRows(container)).toHaveLength(tags.length);

    await click(allButton!);
    expect(f.setTagMode).toHaveBeenLastCalledWith('all');
    expect(getTagNames(container)).toEqual(sortedNames);
    expect(getTagRows(container)).toHaveLength(tags.length);
    expect(headerButton!.textContent).toContain('Tags (4)');
  });

  it('keeps sorted tag rows hidden while collapsed and restores them in sorted order when expanded', async () => {
    const tags = [
      { name: 'tag10', count: 1 },
      { name: 'Beta', count: 1 },
      { name: 'tag2', count: 1 },
      { name: 'alpha', count: 1 },
    ];
    const container = mount(
      <FilterSidebar
        f={makeFilterState([])}
        languages={[]}
        tagTree={{ total: tags.length, tags }}
      />,
    );

    const sortButton = getButtons(container).find((button) => button.title === 'Sort tags A to Z') as HTMLButtonElement | undefined;
    const headerButton = getButtons(container).find((button) => button.textContent?.includes('Tags (4)')) as HTMLButtonElement | undefined;
    expect(sortButton).toBeTruthy();
    expect(headerButton).toBeTruthy();

    await click(sortButton!);
    expect(getTagNames(container)).toEqual(getNaturalTagOrder(tags, 'asc'));

    await click(headerButton!);
    expect(getTagRows(container)).toHaveLength(0);
    expect(container.querySelector('input[placeholder="Search tags…"]')).toBeNull();

    await click(headerButton!);
    expect(getTagNames(container)).toEqual(getNaturalTagOrder(tags, 'asc'));
    expect(getTagRows(container)).toHaveLength(tags.length);
  });

  it('keeps preview and show-all behavior after sorting', async () => {
    const tags = Array.from({ length: 52 }, (_, index) => ({
      name: 'tag' + (52 - index),
      count: index + 1,
    }));
    const container = mount(
      <FilterSidebar
        f={makeFilterState([])}
        languages={[]}
        tagTree={{ total: tags.length, tags }}
      />,
    );

    expect(getTagNames(container)).toHaveLength(50);
    const showAllBeforeSort = getButtons(container).find((button) => button.textContent === 'Show all 52') as HTMLButtonElement | undefined;
    expect(showAllBeforeSort).toBeTruthy();

    const sortButton = getButtons(container).find((button) => button.title === 'Sort tags A to Z') as HTMLButtonElement | undefined;
    expect(sortButton).toBeTruthy();

    await click(sortButton!);

    const sortedPreview = getTagNames(container);
    expect(sortedPreview).toHaveLength(50);
    expect(sortedPreview.slice(0, 3)).toEqual(['tag1', 'tag2', 'tag3']);

    const showAllAfterSort = getButtons(container).find((button) => button.textContent === 'Show all 52') as HTMLButtonElement | undefined;
    expect(showAllAfterSort).toBeTruthy();

    await click(showAllAfterSort!);

    expect(getTagNames(container)).toHaveLength(52);
    expect(getTagNames(container).at(-1)).toBe('tag52');
  });

  it('places the delete-all control before tag mode and requires a second click', async () => {
    const order: string[] = [];
    messagingMocks.bgCall.mockImplementation(async (type: string) => {
      order.push('bgCall:' + type);
      return { assignmentsRemoved: 3, distinctTagsRemoved: 2 };
    });
    const f = makeFilterState(order);
    const onTagMutationMessage = vi.fn();
    const onTagMutationSuccess = vi.fn(() => order.push('success'));
    const container = mount(
      <FilterSidebar
        f={f}
        languages={[]}
        tagTree={{ total: 2, tags: [{ name: 'react', count: 2 }, { name: 'ui', count: 1 }] }}
        onTagMutationMessage={onTagMutationMessage}
        onTagMutationSuccess={onTagMutationSuccess}
      />,
    );

    const buttons = getButtons(container);
    const deleteAll = buttons.find((button) => button.title === 'Delete all tags') as HTMLButtonElement | undefined;
    const any = buttons.find((button) => button.textContent === 'Any') as HTMLButtonElement | undefined;
    expect(deleteAll).toBeTruthy();
    expect(any).toBeTruthy();
    expect(buttons.indexOf(deleteAll!)).toBeLessThan(buttons.indexOf(any!));

    await click(deleteAll!);
    expect(messagingMocks.bgCall).not.toHaveBeenCalled();
    expect(deleteAll!.title).toBe('Delete all tags from every repo? This cannot be undone.');
    expect(f.setTagMode).not.toHaveBeenCalled();

    await click(deleteAll!);

    expect(order).toEqual(['bgCall:deleteAllTags', 'clearTags', 'success']);
    expect(f.toggleTag).not.toHaveBeenCalled();
    expect(onTagMutationMessage).toHaveBeenCalledWith('Cleared 2 tags from 3 repo assignments');
  });

  it('refreshes after successful delete-all even when no active tag filter changes', async () => {
    const order: string[] = [];
    messagingMocks.bgCall.mockImplementation(async (type: string) => {
      order.push('bgCall:' + type);
      return { assignmentsRemoved: 3, distinctTagsRemoved: 2 };
    });
    const f = makeFilterState(order, []);
    const onTagMutationSuccess = vi.fn(() => order.push('success'));
    const container = mount(
      <FilterSidebar
        f={f}
        languages={[]}
        tagTree={{ total: 2, tags: [{ name: 'react', count: 2 }, { name: 'ui', count: 1 }] }}
        onTagMutationSuccess={onTagMutationSuccess}
      />,
    );

    const deleteAll = getButtons(container).find((button) => button.title === 'Delete all tags') as HTMLButtonElement | undefined;
    expect(deleteAll).toBeTruthy();

    await click(deleteAll!);
    await click(deleteAll!);

    expect(order).toEqual(['bgCall:deleteAllTags', 'success']);
    expect(f.clearTags).not.toHaveBeenCalled();
    expect(onTagMutationSuccess).toHaveBeenCalledTimes(1);
  });

  it('keeps active tag filters and does not refresh when delete-all fails', async () => {
    const order: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    messagingMocks.bgCall.mockImplementation(async (type: string) => {
      order.push('bgCall:' + type);
      throw new Error('delete failed');
    });
    const f = makeFilterState(order);
    const onTagMutationMessage = vi.fn();
    const onTagMutationSuccess = vi.fn();
    const container = mount(
      <FilterSidebar
        f={f}
        languages={[]}
        tagTree={{ total: 2, tags: [{ name: 'react', count: 2 }, { name: 'ui', count: 1 }] }}
        onTagMutationMessage={onTagMutationMessage}
        onTagMutationSuccess={onTagMutationSuccess}
      />,
    );

    const deleteAll = getButtons(container).find((button) => button.title === 'Delete all tags') as HTMLButtonElement | undefined;
    expect(deleteAll).toBeTruthy();

    await click(deleteAll!);
    await click(deleteAll!);

    expect(order).toEqual(['bgCall:deleteAllTags']);
    expect(f.clearTags).not.toHaveBeenCalled();
    expect(onTagMutationSuccess).not.toHaveBeenCalled();
    expect(onTagMutationMessage).toHaveBeenCalledWith('delete all tags: delete failed');
    expect(consoleError).toHaveBeenCalledWith('[gsm] deleteAllTags failed', expect.any(Error));
    consoleError.mockRestore();
  });

  it('does not render the destructive control when there are no tags', () => {
    const container = mount(
      <FilterSidebar
        f={makeFilterState([])}
        languages={[]}
        tagTree={{ total: 0, tags: [] }}
      />,
    );

    expect(getButtons(container).some((button) => button.title === 'Delete all tags')).toBe(false);
  });

  it('keeps per-tag delete routed through success and message callbacks', async () => {
    messagingMocks.bgCall.mockResolvedValue({ removed: 2 });
    const order: string[] = [];
    const f = makeFilterState(order, ['react']);
    const onTagMutationMessage = vi.fn();
    const onTagMutationSuccess = vi.fn();
    const container = mount(
      <FilterSidebar
        f={f}
        languages={[]}
        tagTree={{ total: 1, tags: [{ name: 'react', count: 2 }] }}
        onTagMutationMessage={onTagMutationMessage}
        onTagMutationSuccess={onTagMutationSuccess}
      />,
    );

    const deleteReact = getButtons(container).find((button) => button.title === 'Delete tag everywhere') as HTMLButtonElement | undefined;
    expect(deleteReact).toBeTruthy();

    await click(deleteReact!);
    expect(messagingMocks.bgCall).not.toHaveBeenCalled();

    await click(deleteReact!);

    expect(messagingMocks.bgCall).toHaveBeenCalledWith('deleteTag', { name: 'react' });
    expect(f.toggleTag).toHaveBeenCalledWith('react');
    expect(onTagMutationSuccess).toHaveBeenCalledTimes(1);
    expect(onTagMutationMessage).toHaveBeenCalledWith('Deleted tag from 2 repos');
  });
});
