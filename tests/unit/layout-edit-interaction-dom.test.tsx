/**
 * @vitest-environment jsdom
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutEditChrome } from '@/ui/components/LayoutEditChrome';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { DEFAULT_COLUMN_LAYOUT } from '@/ui/column-layout';
import type { Star, Tag } from '@/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function fakeStar(): Star {
  return {
    full_name: 'owner/repo',
    html_url: 'https://github.com/owner/repo',
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

function fakeTag(): Tag {
  return {
    full_name: 'owner/repo',
    tags: ['ui'],
    notes: 'draft',
    mtime: '2024-03-02T00:00:00Z',
  };
}

function mount(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push(root);
  return { container, root };
}

function keydown(target: Window | HTMLElement, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function pendingChromeMessage() {
  return new Promise<never>(() => {});
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`Expected ${label} button to render`);
  return button;
}

function findNotesTextarea(): HTMLTextAreaElement {
  const textarea = document.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Expected notes textarea to render');
  return textarea;
}

describe('layout edit interaction lock mounted DOM behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(pendingChromeMessage),
      },
    });
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots) root.unmount();
      mountedRoots.length = 0;
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('prevents drawer keyboard shortcuts while locked and while typing', () => {
    const onClose = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { root } = mount(
      <RepoDetailPanel
        star={fakeStar()}
        tag={fakeTag()}
        selectedTags={['ui']}
        onToggleTag={vi.fn()}
        onDataChanged={vi.fn()}
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev
        hasNext
        interactionLocked
      />,
    );

    act(() => {
      keydown(window, 'Escape');
      keydown(window, '[');
      keydown(window, ']');
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <RepoDetailPanel
          star={fakeStar()}
          tag={fakeTag()}
          selectedTags={['ui']}
          onToggleTag={vi.fn()}
          onDataChanged={vi.fn()}
          onClose={onClose}
          onPrev={onPrev}
          onNext={onNext}
          hasPrev
          hasNext
          interactionLocked={false}
        />,
      );
    });

    const notes = findNotesTextarea();
    act(() => {
      keydown(notes, 'Escape');
      keydown(window, 'Escape');
      keydown(window, '[');
      keydown(window, ']');
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('keeps layout edit chrome actions live', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const onReset = vi.fn();
    const { container } = mount(
      <LayoutEditChrome
        editing
        draftLayout={{ ...DEFAULT_COLUMN_LAYOUT, hidden: ['language'] }}
        hiddenTrayColumns={['language']}
        trayOpen
        trayDropReady={false}
        dropReadyLabel={null}
        editColumnsButtonRef={createRef<HTMLButtonElement>()}
        onToggleColumnMenu={vi.fn()}
        onReset={onReset}
        onSave={onSave}
        onCancel={onCancel}
        onBeginTrayDrag={vi.fn()}
        onRestoreHiddenColumn={vi.fn()}
      />,
    );

    const save = findButton(container, 'Save');
    const cancel = findButton(container, 'Cancel');
    const reset = findButton(container, 'Reset');

    act(() => {
      reset.click();
      save.click();
      cancel.click();
    });

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
