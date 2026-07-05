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

function renderToolbarViewTabs({
  layoutMode,
  customPreviewing,
  layoutConfigReady = true,
  layoutEditReady = true,
}: {
  layoutMode: 'default' | 'custom';
  customPreviewing: boolean;
  layoutConfigReady?: boolean;
  layoutEditReady?: boolean;
}) {
  return renderToStaticMarkup(
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
        layoutMode={layoutMode}
        layoutEditing={false}
        layoutConfigReady={layoutConfigReady}
        layoutEditReady={layoutEditReady}
        customLayoutDirty
        customPreviewing={customPreviewing}
        hiddenColumnCount={0}
        onLayoutModeChange={vi.fn()}
        onStartLayoutEdit={vi.fn()}
        onPreviewCustomChange={vi.fn()}
      />
    </TooltipProvider>,
  );
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
          layoutConfigReady
          layoutEditReady
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

  it('renders the view tab active dot for default, custom, and custom preview states', () => {
    const activeDot = 'size-1.5 rounded-full bg-primary';
    const defaultMarkup = renderToolbarViewTabs({ layoutMode: 'default', customPreviewing: false });
    const customMarkup = renderToolbarViewTabs({ layoutMode: 'custom', customPreviewing: false });
    const previewMarkup = renderToolbarViewTabs({ layoutMode: 'default', customPreviewing: true });

    expect(defaultMarkup.match(new RegExp(activeDot, 'g'))?.length).toBe(1);
    expect(defaultMarkup).toContain('aria-pressed="true"');
    expect(defaultMarkup.indexOf(activeDot)).toBeLessThan(defaultMarkup.indexOf('Default'));
    expect(customMarkup.match(new RegExp(activeDot, 'g'))?.length).toBe(1);
    expect(customMarkup).toContain('aria-pressed="true"');
    expect(customMarkup.indexOf(activeDot)).toBeGreaterThan(customMarkup.indexOf('Default'));
    expect(previewMarkup.match(new RegExp(activeDot, 'g'))?.length).toBe(1);
    expect(previewMarkup).toContain('aria-pressed="true"');
    expect(previewMarkup).toContain('gsm-seg-previewing');
    expect(previewMarkup.indexOf(activeDot)).toBeGreaterThan(previewMarkup.indexOf('Default'));
  });

  it('keeps browse tabs enabled while the pencil remains disabled in recovered config-only state', () => {
    const markup = renderToolbarViewTabs({
      layoutMode: 'custom',
      customPreviewing: false,
      layoutConfigReady: true,
      layoutEditReady: false,
    });

    const buttons = [...markup.matchAll(/<button[\s\S]*?<\/button>/g)].map((match) => match[0]);
    const defaultTab = buttons.find((button) => button.includes('Default'));
    const customTab = buttons.find((button) => button.includes('Custom'));
    const editButton = buttons.find((button) => button.includes('w-7'));

    expect(defaultTab).toBeDefined();
    expect(customTab).toBeDefined();
    expect(editButton).toBeDefined();
    expect(defaultTab).not.toContain('disabled');
    expect(customTab).not.toContain('disabled');
    expect(editButton).toContain('disabled=""');
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
        resizeColumnLabel="Repository"
        layoutResize={null}
        tableWidth={864}
        panelWidth={720}
        overflowPx={144}
        hiddenTrayColumns={['language']}
        trayOpen
        trayDropReady={false}
        dropReadyLabel={null}
        editColumnsButtonRef={createRef<HTMLButtonElement>()}
        onToggleColumnMenu={vi.fn()}
        onFitWidths={vi.fn()}
        onResetWidths={vi.fn()}
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
    expect(chrome).toContain('Live drag: frozen peers');
    expect(chrome).toContain('Table 864px / Panel 720px / Overflow +144px');
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
