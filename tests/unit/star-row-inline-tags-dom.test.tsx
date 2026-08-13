/**
 * @vitest-environment jsdom
 */
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Star } from '@/types';
import type { ColumnId } from '@/ui/column-layout';
import { StarRow } from '@/ui/components/StarRow';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

class ImmediateResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  unobserve() {}

  disconnect() {}
}

function fakeStar(fullName = 'owner/repo'): Star {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: 'A repository',
    language: 'TypeScript',
    stargazers_count: 1200,
    topics: ['react'],
    archived: false,
    fork: false,
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2024-02-01T00:00:00Z',
    starred_at: '2024-03-01T00:00:00Z',
    tombstone: false,
    synced_at: '2024-03-02T00:00:00Z',
  };
}

function mount(element: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push(root);
  return { container, root };
}

function rowWithColumns(
  columns: ColumnId[],
  callbacks: {
    onSelect?: (fullName: string) => void;
    onToggleTag?: (tag: string) => void;
  } = {},
): ReactElement {
  return (
    <StarRow
      star={fakeStar()}
      tags={['ui', 'react', 'agent', 'tooling', 'automation']}
      hasNotes={false}
      favorite={false}
      favoriteBusy={false}
      selectedTags={[]}
      onToggleTag={callbacks.onToggleTag ?? vi.fn()}
      onToggleFavorite={vi.fn(async () => undefined)}
      selected={false}
      onSelect={callbacks.onSelect ?? vi.fn()}
      columns={columns}
      gridTemplateColumns={columns.map(() => '220px').join(' ')}
      flashedColumn={null}
    />
  );
}

function ControlledUnstarRow({
  onSelect,
  onConfirmUnstar,
}: {
  onSelect: (fullName: string) => void;
  onConfirmUnstar: (fullName: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <StarRow
      star={fakeStar()}
      tags={[]}
      hasNotes={false}
      favorite={false}
      favoriteBusy={false}
      selectedTags={[]}
      onToggleTag={vi.fn()}
      onToggleFavorite={vi.fn(async () => undefined)}
      selected={false}
      onSelect={onSelect}
      columns={['starAction']}
      gridTemplateColumns="32px"
      flashedColumn={null}
      onConfirmUnstar={onConfirmUnstar}
      unstarPopoverOpen={open}
      onUnstarPopoverOpenChange={setOpen}
    />
  );
}

describe('star row inline tag fitting', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function getClientWidth(this: HTMLElement) {
      return this.getAttribute('data-row-col') === 'tags' ? 118 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function getOffsetWidth(this: HTMLElement) {
      if (this.dataset.inlineTagMeasure === 'tag') return 24;
      if (this.dataset.inlineTagMeasure === 'count') return 18;
      return 0;
    });
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots) root.unmount();
      mountedRoots.length = 0;
    });
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reveals the repository initial when an avatar image fails', () => {
    const star = {
      ...fakeStar('owner/network-fallback'),
      owner_avatar_url: 'https://avatars.githubusercontent.com/u/broken?v=4',
    };
    const { container } = mount(
      <StarRow
        star={star}
        showRepositoryAvatar
        tags={[]}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn(async () => undefined)}
        selected={false}
        onSelect={vi.fn()}
        columns={['repository']}
        gridTemplateColumns="220px"
        flashedColumn={null}
      />,
    );
    const image = container.querySelector<HTMLImageElement>('[data-repository-avatar]');
    const fallback = container.querySelector('[data-repository-avatar-fallback]');

    expect(fallback?.textContent).toBe('N');
    expect(image?.hidden).toBe(false);
    act(() => image?.dispatchEvent(new Event('error')));
    expect(image?.hidden).toBe(true);
    expect(fallback?.textContent).toBe('N');
  });

  it('expands beyond the initial two tags when the measured column width allows it', () => {
    const { container } = mount(rowWithColumns(['tags']));

    const visibleButtons = container.querySelectorAll('[data-row-col="tags"] > div:not([aria-hidden]) button');

    expect(visibleButtons).toHaveLength(3);
    expect(container.textContent).toContain('+2');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('initializes measurement when the tags column appears after the row mounted', () => {
    const { container, root } = mount(rowWithColumns(['repository']));

    expect(container.querySelector('[data-row-col="tags"]')).toBeNull();

    act(() => {
      root.render(rowWithColumns(['tags']));
    });

    const visibleButtons = container.querySelectorAll('[data-row-col="tags"] > div:not([aria-hidden]) button');

    expect(visibleButtons).toHaveLength(3);
    expect(container.textContent).toContain('+2');
  });

  it('lets blank space in the tags column open the row drawer', () => {
    const onSelect = vi.fn();
    const onToggleTag = vi.fn();
    const { container } = mount(rowWithColumns(['tags'], { onSelect, onToggleTag }));
    const tagCell = container.querySelector<HTMLElement>('[data-row-col="tags"]');

    act(() => {
      tagCell?.click();
    });

    expect(onSelect).toHaveBeenCalledWith('owner/repo');
    expect(onToggleTag).not.toHaveBeenCalled();
  });

  it('keeps tag chip clicks scoped to tag filtering', () => {
    const onSelect = vi.fn();
    const onToggleTag = vi.fn();
    const { container } = mount(rowWithColumns(['tags'], { onSelect, onToggleTag }));
    const firstTagButton = container.querySelector<HTMLButtonElement>('[data-row-col="tags"] button');

    act(() => {
      firstTagButton?.click();
    });

    expect(onToggleTag).toHaveBeenCalledWith('ui');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('confirms unstar from the row star action without selecting the row', async () => {
    const onSelect = vi.fn();
    const onConfirmUnstar = vi.fn();
    mount(
      <StarRow
        star={fakeStar()}
        tags={[]}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn(async () => undefined)}
        selected={false}
        onSelect={onSelect}
        columns={['starAction']}
        gridTemplateColumns="32px"
        flashedColumn={null}
        onConfirmUnstar={onConfirmUnstar}
      />,
    );

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Unstar owner/repo"]');
    if (!trigger) throw new Error('Expected row star action button');

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Confirm'));
    if (!confirm) throw new Error('Expected unstar confirmation button');

    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onConfirmUnstar).toHaveBeenCalledWith('owner/repo');
  });

  it('lets a controlled unstar popover close from a trigger re-click without selecting the row', async () => {
    const onSelect = vi.fn();
    const onConfirmUnstar = vi.fn();
    mount(<ControlledUnstarRow onSelect={onSelect} onConfirmUnstar={onConfirmUnstar} />);

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Unstar owner/repo"]');
    if (!trigger) throw new Error('Expected row star action button');

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.includes('Confirm'))).toBe(true);

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.includes('Confirm'))).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onConfirmUnstar).not.toHaveBeenCalled();
  });

});
