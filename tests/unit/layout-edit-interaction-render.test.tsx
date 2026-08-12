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
import { REPO_URL } from '@/lib/links';
import type { FilterState } from '@/ui/filter-store';
import { fakeStar, fakeTag } from './test-utils';

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
    onlyOwned: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
    libraryViewHydrated: true,
    setQuery: vi.fn(),
    toggleLanguage: vi.fn(),
    toggleTag: vi.fn(),
    clearTags: vi.fn(),
    setTagMode: vi.fn(),
    setShowTombstone: vi.fn(),
    setOnlyFavorite: vi.fn(),
    setOnlyUntagged: vi.fn(),
    setOnlyArchived: vi.fn(),
    setOnlyOwned: vi.fn(),
    setSort: vi.fn(),
    applyLibraryViewPrefs: vi.fn(),
    resetFilters: vi.fn(),
  };
}

function renderToolbarViewTabs({
  layoutMode,
  customPreviewing,
  layoutConfigReady = true,
  layoutEditReady = true,
  agentActive,
  watchUnreadCount = 7,
  radarUnseenCount = 0,
}: {
  layoutMode: 'default' | 'custom';
  customPreviewing: boolean;
  layoutConfigReady?: boolean;
  layoutEditReady?: boolean;
  agentActive?: boolean;
  watchUnreadCount?: number;
  radarUnseenCount?: number;
}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Toolbar
        account={null}
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
        onOpenAgent={agentActive === undefined ? undefined : vi.fn()}
        agentActive={agentActive}
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
        surface="stars"
        onSurfaceChange={vi.fn()}
        watchUnreadCount={watchUnreadCount}
        radarUnseenCount={radarUnseenCount}
      />
    </TooltipProvider>,
  );
}

function findSurfaceTabMarkup(markup: string, id: string): string {
  const tab = markup.match(new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0];
  if (!tab) throw new Error(`Expected surface tab ${id} to render`);
  return tab;
}

describe('layout edit interaction lock render behavior', () => {
  it('renders Stars, Watch, and Following surface tabs with the selected underline', () => {
    const markup = renderToolbarViewTabs({ layoutMode: 'default', customPreviewing: false });

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('id="gsm-stars-surface-tab"');
    expect(markup).toContain('aria-controls="gsm-watch-surface-panel"');
    expect(markup).toContain('aria-controls="gsm-radar-surface-panel"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('>Following</button>');
    expect(markup).toContain('gsm-surface-indicator');
  });

  it('suppresses the Watch unread badge when the count is zero', () => {
    const markup = renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      watchUnreadCount: 0,
    });
    const watchTab = findSurfaceTabMarkup(markup, 'gsm-watch-surface-tab');

    expect(watchTab).toContain('aria-label="Watch"');
    expect(watchTab).not.toContain('aria-hidden="true"');
  });

  it('renders a normal Watch unread count with exact accessible semantics', () => {
    const markup = renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      watchUnreadCount: 6,
    });
    const watchTab = findSurfaceTabMarkup(markup, 'gsm-watch-surface-tab');

    expect(watchTab).toContain('aria-label="Watch, 6 unread threads"');
    expect(watchTab).toContain('aria-hidden="true"');
    expect(watchTab).toContain('>6</span>');
  });

  it('caps only the displayed Watch unread count at 99+', () => {
    const markup = renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      watchUnreadCount: 128,
    });
    const watchTab = findSurfaceTabMarkup(markup, 'gsm-watch-surface-tab');

    expect(watchTab).toContain('aria-label="Watch, 128 unread threads"');
    expect(watchTab).toContain('>99+</span>');
    expect(watchTab).not.toContain('>128</span>');
  });

  it('renders the Radar unseen count with exact accessible semantics and a 99+ visual cap', () => {
    const empty = findSurfaceTabMarkup(renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      radarUnseenCount: 0,
    }), 'gsm-radar-surface-tab');
    expect(empty).toContain('aria-label="Following"');
    expect(empty).not.toContain('data-radar-unseen-badge');

    const normal = findSurfaceTabMarkup(renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      radarUnseenCount: 6,
    }), 'gsm-radar-surface-tab');
    expect(normal).toContain('aria-label="Following, 6 unseen activities"');
    expect(normal).toContain('data-radar-unseen-badge');
    expect(normal).toContain('>6</span>');

    const capped = findSurfaceTabMarkup(renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      radarUnseenCount: 128,
    }), 'gsm-radar-surface-tab');
    expect(capped).toContain('aria-label="Following, 128 unseen activities"');
    expect(capped).toContain('>99+</span>');
    expect(capped).not.toContain('>128</span>');
  });

  it('keeps the project repository link on the product icon', () => {
    const markup = renderToolbarViewTabs({ layoutMode: 'default', customPreviewing: false });
    const projectLinks = [...markup.matchAll(/<a\b[\s\S]*?<\/a>/g)]
      .map((match) => match[0])
      .filter((link) => link.includes(`href="${REPO_URL}"`));

    expect(projectLinks).toHaveLength(1);
    expect(projectLinks[0]).toContain('aria-label="Open the project repository"');
    expect(projectLinks[0]).toContain('group-hover/product:bg-primary-foreground');
    expect(projectLinks[0]).toContain('group-hover/product:text-primary');
    expect(projectLinks[0]).toContain('group-active/product:scale-95');
    expect(projectLinks[0]).toContain('motion-reduce:transition-none');
    expect(markup).not.toContain('Stars Manager');
    expect(projectLinks[0]).not.toContain('>Star</span>');
  });

  it('switches the Agent toolbar icon from the static mascot to the working GIF', () => {
    const idle = renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      agentActive: false,
    });
    const running = renderToolbarViewTabs({
      layoutMode: 'default',
      customPreviewing: false,
      agentActive: true,
    });

    expect(idle).toContain('data-testid="agent-mascot-icon"');
    expect(idle).toContain('data-state="idle"');
    expect(idle).toContain('index-agent-static');
    expect(idle).not.toContain('index-agent-working');
    expect(idle).not.toContain('aria-label="Loading"');
    expect(running).toContain('data-testid="agent-mascot-icon"');
    expect(running).toContain('data-state="working"');
    expect(running).toContain('index-agent-working');
    expect(running).toContain('media="(prefers-reduced-motion: reduce)"');
    expect(running).not.toContain('aria-label="Loading"');
  });

  it('outlines the Sync caret with the primary button color', () => {
    const markup = renderToolbarViewTabs({ layoutMode: 'default', customPreviewing: false });
    const buttons = [...markup.matchAll(/<button[\s\S]*?<\/button>/g)].map((match) => match[0]);
    const syncCaret = buttons.find((button) => button.includes('data-coach-target="full-sync"'));

    expect(syncCaret).toBeDefined();
    expect(syncCaret).toContain('border-primary');
    expect(syncCaret).toContain('hover:bg-primary');
    expect(syncCaret).toContain('hover:text-primary-foreground');
    expect(syncCaret).not.toContain('border-border/70');
  });

  it('reserves a visible border for the Sync primary action on hover', () => {
    const markup = renderToolbarViewTabs({ layoutMode: 'default', customPreviewing: false });
    const buttons = [...markup.matchAll(/<button[\s\S]*?<\/button>/g)].map((match) => match[0]);
    const syncButton = buttons.find((button) => button.includes('data-coach-target="sync"'));

    expect(syncButton).toBeDefined();
    expect(syncButton).toContain('border-transparent');
    expect(syncButton).toContain('border-r-0');
    expect(syncButton).toContain('hover:border-primary');
  });

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
          account={null}
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

    const buttons = [...markup.matchAll(/<button[\s\S]*?<\/button>/g)].map((match) => match[0]);
    const editButton = buttons.find((button) => button.includes('data-layout-edit-trigger=""'));
    expect(editButton).toBeDefined();
    expect(editButton).not.toContain('disabled=""');
    expect(editButton).toContain('aria-pressed="true"');
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
    const editButton = buttons.find((button) => button.includes('data-layout-edit-trigger=""'));

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
        hideDropZoneRef={createRef<HTMLDivElement>()}
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
