import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ActiveFilterChips } from '@/ui/components/ActiveFilterChips';
import { FloatingLocaleToggle } from '@/ui/components/FloatingLocaleToggle';
import { LayoutEditChrome } from '@/ui/components/LayoutEditChrome';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { Toolbar } from '@/ui/components/Toolbar';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { DEFAULT_COLUMN_LAYOUT } from '@/ui/column-layout';
import { getLockedAnchorProps, getLockedRegionProps, shouldIgnorePanelShortcut } from '@/ui/interaction-lock';
import type { FilterState } from '@/ui/filter-store';
import type { Star, Tag } from '@/types';

function fakeFilterState(): FilterState {
  return {
    query: 'react',
    languages: ['TypeScript'],
    tags: ['ui'],
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: true,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
    setQuery: vi.fn(),
    toggleLanguage: vi.fn(),
    toggleTag: vi.fn(),
    setTagMode: vi.fn(),
    setShowTombstone: vi.fn(),
    setOnlyFavorite: vi.fn(),
    setOnlyUntagged: vi.fn(),
    setOnlyArchived: vi.fn(),
    setSort: vi.fn(),
    resetFilters: vi.fn(),
  };
}

function fakeStar(): Star {
  return {
    full_name: 'owner/repo',
    html_url: 'https://github.com/owner/repo',
    description: 'A repository',
    language: 'TypeScript',
    stargazers_count: 1200,
    forks_count: 10,
    open_issues_count: 2,
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

describe('layout edit interaction lock render behavior', () => {
  it('renders locked helper attributes and suppresses anchor activation', () => {
    expect(getLockedRegionProps(true)).toEqual({ 'aria-disabled': true, inert: '' });
    expect(getLockedRegionProps(false)).toEqual({});

    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    getLockedAnchorProps(true).onClick?.(event as never);

    expect(getLockedAnchorProps(true)).toMatchObject({ 'aria-disabled': true, tabIndex: -1 });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(getLockedAnchorProps(false)).toEqual({});
  });

  it('guards panel keyboard shortcuts in locked and text-editing states', () => {
    expect(shouldIgnorePanelShortcut(true, { tagName: 'DIV' } as never)).toBe(true);
    expect(shouldIgnorePanelShortcut(false, { tagName: 'INPUT' } as never)).toBe(true);
    expect(shouldIgnorePanelShortcut(false, { tagName: 'TEXTAREA' } as never)).toBe(true);
    expect(shouldIgnorePanelShortcut(false, { tagName: 'DIV' } as never)).toBe(false);
  });

  it('renders locked toolbar controls and inert anchors while layout chrome stays outside the lock', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <Toolbar
          f={fakeFilterState()}
          status={null}
          loading={false}
          listPhase="idle"
          total={1}
          grandTotal={1}
          busy={false}
          pendingAction={null}
          successAction={null}
          onSync={vi.fn()}
          onAutoAssignTags={vi.fn()}
          onToggleTheme={vi.fn()}
          theme="light"
          searchRef={{ current: null }}
          layoutMode="default"
          layoutEditing
          customLayoutDirty={false}
          customPreviewing={false}
          hiddenColumnCount={0}
          onLayoutModeChange={vi.fn()}
          onStartLayoutEdit={vi.fn()}
          onPreviewCustomChange={vi.fn()}
          layoutEditChrome={<span data-layout-edit-live="true">live editor</span>}
        />
      </TooltipProvider>,
    );

    expect(markup).toContain('data-layout-edit-live="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('pointer-events-none opacity-50');
  });

  it('renders sibling regions as inert while layout edit chrome remains enabled', () => {
    const chips = renderToStaticMarkup(
      <ActiveFilterChips f={fakeFilterState()} count={1} interactionLocked />,
    );
    const locale = renderToStaticMarkup(<FloatingLocaleToggle drawerOpen={false} interactionLocked />);
    const chrome = renderToStaticMarkup(
      <LayoutEditChrome
        editing
        draftLayout={{ ...DEFAULT_COLUMN_LAYOUT, hidden: ['language'] }}
        hiddenTrayColumns={['language']}
        trayOpen
        trayDropReady={false}
        dropReadyLabel={null}
        editColumnsButtonRef={createRef<HTMLButtonElement>()}
        onToggleColumnMenu={vi.fn()}
        onReset={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onBeginTrayDrag={vi.fn()}
        onRestoreHiddenColumn={vi.fn()}
      />,
    );

    expect(chips).toContain('inert=""');
    expect(chips).toContain('aria-disabled="true"');
    expect(locale).toContain('inert=""');
    expect(locale).toContain('aria-disabled="true"');
    expect(chrome).not.toContain('aria-disabled="true"');
    expect(chrome).toContain('Columns');
    expect(chrome).toContain('Save');
  });

  it('renders the detail drawer visible but inert and makes its repo link unfocusable', () => {
    const markup = renderToStaticMarkup(
      <RepoDetailPanel
        star={fakeStar()}
        tag={fakeTag()}
        selectedTags={['ui']}
        onToggleTag={vi.fn()}
        onDataChanged={vi.fn()}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        hasPrev
        hasNext
        interactionLocked
      />,
    );

    expect(markup).toContain('owner/repo');
    expect(markup).toContain('inert=""');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('disabled=""');
  });
});
