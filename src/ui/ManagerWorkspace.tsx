import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useI18n, type MessageCatalog } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Star, Tag } from '@/types';
import { COLUMN_DEFS } from '@/ui/column-layout';
import { ActiveFilterChips } from '@/ui/components/ActiveFilterChips';
import { FilterSidebar } from '@/ui/components/FilterSidebar';
import { FloatingLocaleToggle } from '@/ui/components/FloatingLocaleToggle';
import { LayoutColumnMenu, LayoutDragGhost, LayoutEditChrome } from '@/ui/components/LayoutEditChrome';
import { ManagerResourceLink } from '@/ui/components/ManagerResource';
import { Radar } from '@/ui/components/Radar';
import { RadarStatusRibbon } from '@/ui/components/RadarStatusRibbon';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { StarsTable } from '@/ui/components/StarsTable';
import { Toolbar, type ToolbarHostProps } from '@/ui/components/Toolbar';
import { WatchInbox } from '@/ui/components/WatchInbox';
import { WatchStatusRibbon } from '@/ui/components/WatchStatusRibbon';
import { useColumnLayoutEditor } from '@/ui/hooks/use-column-layout-editor';
import { useManagerStarActions, type UnstarFeedback } from '@/ui/hooks/use-manager-star-actions';
import { useManagerSurfaceBadges } from '@/ui/hooks/use-manager-surface-badges';
import { useRadar } from '@/ui/hooks/use-radar';
import { useTheme } from '@/ui/hooks/use-theme';
import { useWatchInbox } from '@/ui/hooks/use-watch-inbox';
import { getLockedRegionProps, shouldIgnorePanelShortcut } from '@/ui/interaction-lock';
import { layoutViewportFromMeasurements, type LayoutViewportState } from '@/ui/layout-resize-surface';
import type { LayoutResizeLiveAdapter } from '@/ui/layout-resize-tool';
import type { ManagerAccount } from '@/runtime/manager-runtime';
import {
  managerSurfaceDirection,
  managerSurfaceFromShortcut,
  type ManagerSurface,
  type ManagerSurfaceDirection,
} from '@/ui/manager-surface';
import { PortalProvider } from '@/ui/shadcn/portal-context';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { useFilterStore } from '@/ui/filter-store';
import { useManagerRuntime } from '@/ui/manager-runtime-context';
import { useStars } from '@/ui/use-stars';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import { Button } from '@/ui/shadcn/button';

export { layoutViewportFromMeasurements };

export type ManagerWorkspaceCommands = Readonly<{
  refreshStars: () => void;
}>;

export type ManagerWorkspaceActivity = Readonly<{
  starsSurface: boolean;
  idle: boolean;
}>;

type StarsSlotContext = Readonly<{ interactionLocked: boolean }>;
type OverlaySlotContext = Readonly<{
  rootRef: RefObject<HTMLDivElement>;
  starsSurface: boolean;
  agentCandidate: BgsmAgentConversationCandidate;
  scopeCount: number;
  refreshStars: () => void;
}>;

export type ManagerWorkspaceExtension = Readonly<{
  toolbar?: ToolbarHostProps;
  renderStarsBanner?: (context: StarsSlotContext) => ReactNode;
  renderStarsContent?: (context: StarsSlotContext) => ReactNode;
  info?: string | null;
  onClearInfo?: () => void;
  onClearLocalData?: () => Promise<void>;
  onOpenOptions?: (section?: 'github' | 'watch') => void;
  renderOverlays?: (context: OverlaySlotContext) => ReactNode;
}>;

type ManagerWorkspaceProps = {
  extension?: ManagerWorkspaceExtension;
  allowHashTagOverride?: boolean;
  onMeaningfulAction?: () => void;
  onCommandsChange?: (commands: ManagerWorkspaceCommands | null) => void;
  onActivityChange?: (activity: ManagerWorkspaceActivity) => void;
};

const REPO_MARKER = '__GSM_REPO__';
const TOKEN_SETTINGS_LABEL = 'github.com/settings/tokens';
const TOKEN_SETTINGS_URL = `https://${TOKEN_SETTINGS_LABEL}`;

function renderTextWithTokenLink(text: string) {
  const linkIndex = text.indexOf(TOKEN_SETTINGS_LABEL);
  if (linkIndex < 0) return text;

  return (
    <>
      {text.slice(0, linkIndex)}
      <ManagerResourceLink
        resource={{
          kind: 'subject',
          label: TOKEN_SETTINGS_LABEL,
          remoteUrl: TOKEN_SETTINGS_URL,
        }}
        className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        onClick={(event) => event.stopPropagation()}
      >
        {TOKEN_SETTINGS_LABEL}
      </ManagerResourceLink>
      {text.slice(linkIndex + TOKEN_SETTINGS_LABEL.length)}
    </>
  );
}

function renderRepoMessage(template: string, fullName: string) {
  const markerIndex = template.indexOf(REPO_MARKER);
  if (markerIndex < 0) return renderTextWithTokenLink(template);
  return (
    <>
      {template.slice(0, markerIndex)}
      <span className="inline-flex items-center rounded-md border border-border bg-foreground px-1.5 py-0.5 font-mono text-[10px] leading-none text-background shadow-sm">
        {fullName}
      </span>
      {renderTextWithTokenLink(template.slice(markerIndex + REPO_MARKER.length))}
    </>
  );
}

function UnstarFeedbackText({ feedback, m }: { feedback: UnstarFeedback; m: MessageCatalog }) {
  const template = feedback.kind === 'done'
    ? m.starRow.unstarDone(REPO_MARKER)
    : m.starRow.unstarFailed(REPO_MARKER, feedback.error);
  return <>{renderRepoMessage(template, feedback.fullName)}</>;
}

function HelperInfoText({
  info,
  unstarFeedback,
  m,
}: {
  info: string | null;
  unstarFeedback: UnstarFeedback | null;
  m: MessageCatalog;
}) {
  if (unstarFeedback) return <UnstarFeedbackText feedback={unstarFeedback} m={m} />;
  return <>{info}</>;
}

function helperInfoKey(info: string | null, unstarFeedback: UnstarFeedback | null): string {
  if (unstarFeedback) {
    return `${unstarFeedback.kind}:${unstarFeedback.fullName}:${unstarFeedback.kind === 'failed' ? unstarFeedback.error : ''}`;
  }
  return info ?? '';
}

export function ManagerWorkspace({
  extension,
  allowHashTagOverride = true,
  onMeaningfulAction,
  onCommandsChange,
  onActivityChange,
}: ManagerWorkspaceProps = {}) {
  const runtime = useManagerRuntime();
  const {
    rows,
    total,
    grandTotal,
    loading,
    phase,
    error: starsError,
    languages,
    tagTree,
    tagsByFullName,
    refresh: refreshStars,
  } = useStars(allowHashTagOverride);
  const [account, setAccount] = useState<ManagerAccount | null>(null);
  const [surface, setSurface] = useState<ManagerSurface>('stars');
  const [surfaceDirection, setSurfaceDirection] = useState<ManagerSurfaceDirection>('forward');
  const [selected, setSelected] = useState<string | null>(null);
  const [watchDetail, setWatchDetail] = useState<{ star: Star | null; tag: Tag | null } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutResizeLiveAdapterRef = useRef<LayoutResizeLiveAdapter | null>(null);
  const watchDetailGeneration = useRef(0);
  const bindListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListElement(node);
  }, []);
  const reportMeaningfulAction = useCallback(() => {
    onMeaningfulAction?.();
  }, [onMeaningfulAction]);
  // Prime Watch and Following on manager entry; switching tabs must not be their first query.
  const watchInbox = useWatchInbox({
    visible: surface === 'watch',
    onMeaningfulAction: reportMeaningfulAction,
  });
  const radar = useRadar({
    onMeaningfulAction: reportMeaningfulAction,
  });
  const surfaceBadges = useManagerSurfaceBadges();
  const f = useFilterStore();
  const { theme, themeClass, toggle: toggleTheme } = useTheme();
  const { m } = useI18n();
  const {
    layoutMode,
    editingLayout,
    layoutConfigReady,
    layoutEditReady,
    previewingCustomLayout,
    draftLayout,
    showRepositoryOwner,
    showRepositoryAvatar,
    visibleColumns,
    gridTemplateColumns,
    tableMinWidth,
    hiddenTrayColumns,
    customLayoutDirty,
    hiddenColumnCount,
    dragGhost,
    layoutDrag,
    layoutResize,
    columnShifts,
    trayOpen,
    trayDropReady,
    trayCaretX,
    layoutFaded,
    layoutModeTransitionPhase,
    flashedColumn,
    columnMenuOpen,
    columnMenuPosition,
    headerRef,
    hideDropZoneRef,
    editColumnsButtonRef,
    setBrowseLayoutMode,
    previewCustomLayout,
    beginCustomLayoutEdit,
    saveLayoutEdit,
    cancelLayoutEdit,
    resetLayoutEdit,
    resetLayoutWidths,
    setColumnHidden,
    setRepositoryOwnerVisible,
    setRepositoryAvatarVisible,
    beginColumnDrag,
    beginColumnResize,
    moveColumnByKeyboard,
    resizeColumnByKeyboard,
    autoFitColumnWidth,
    fitLayoutWidths,
    beginTrayDrag,
    restoreHiddenColumn,
    toggleColumnMenu,
  } = useColumnLayoutEditor(rootRef, listRef, layoutResizeLiveAdapterRef);
  const interactionLocked = editingLayout;
  const [layoutViewport, setLayoutViewport] = useState<LayoutViewportState | null>(null);
  const starsSurface = surface === 'stars';
  const watchSurface = surface === 'watch';
  const radarSurface = surface === 'radar';

  useEffect(() => {
    let cancelled = false;
    const syncAccount = () => {
      void runtime.getAccount().then((next) => {
        if (cancelled) return;
        setAccount(next);
        if (!next.username) useFilterStore.getState().setOnlyOwned(false);
      }).catch(() => {});
    };
    syncAccount();
    const unsubscribe = runtime.subscribe((event) => {
      if (event.kind === 'preferences' || event.kind === 'reset') syncAccount();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runtime]);

  const handleUnstarred = useCallback((fullName: string) => {
    setSelected((current) => (current === fullName ? null : current));
  }, []);
  const displayedInfo = info ?? extension?.info ?? null;
  const {
    favoriteOverrides,
    unstarFeedback,
    openUnstarFullName,
    toggleFavorite: handleToggleFavorite,
    confirmUnstar: handleConfirmUnstar,
    changeUnstarPopover: handleOpenUnstarChange,
    closeUnstarPopover,
    clearUnstarFeedback,
    resetUnstarPresentation,
  } = useManagerStarActions({
    rows,
    tagsByFullName,
    info: displayedInfo,
    interactionLocked,
    setInfo,
    onMeaningfulAction: reportMeaningfulAction,
    onUnstarred: handleUnstarred,
  });

  useEffect(() => () => {
    watchDetailGeneration.current++;
  }, []);

  useLayoutEffect(() => {
    if (!editingLayout) return;
    watchDetailGeneration.current++;
    setSelected(null);
    closeUnstarPopover();
  }, [closeUnstarPopover, editingLayout]);

  const handleSurfaceChange = useCallback((next: ManagerSurface) => {
    if (next === surface || editingLayout) return;
    watchDetailGeneration.current++;
    setSelected(null);
    setWatchDetail(null);
    resetUnstarPresentation();
    if (listRef.current) listRef.current.scrollTop = 0;
    setSurfaceDirection(managerSurfaceDirection(surface, next));
    setSurface(next);
  }, [editingLayout, resetUnstarPresentation, surface]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shouldIgnorePanelShortcut(interactionLocked, event.target)) return;
      const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (unmodified && event.key === '/' && starsSurface) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (unmodified && event.key.toLocaleLowerCase('en-US') === 'v' && radarSurface) {
        event.preventDefault();
        radar.setView(radar.view === 'feed' ? 'projects' : 'feed');
        return;
      }
      const shortcutSurface = managerSurfaceFromShortcut(event.key);
      if (shortcutSurface && !event.altKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        handleSurfaceChange(shortcutSurface);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSurfaceChange, interactionLocked, radar.setView, radar.view, radarSurface, starsSurface]);

  const selectedIdx = useMemo(
    () => (starsSurface && selected ? rows.findIndex((row) => row.full_name === selected) : -1),
    [rows, selected, starsSurface],
  );
  const selectedStar = starsSurface
    ? selectedIdx >= 0 ? rows[selectedIdx] : null
    : selected ? watchDetail?.star ?? null : null;
  const selectedTag = starsSurface
    ? selectedStar ? tagsByFullName.get(selectedStar.full_name) : undefined
    : watchDetail?.tag ?? undefined;

  const handleSelect = useCallback((fullName: string) => {
    setSelected((current) => (current === fullName ? null : fullName));
  }, []);

  const handleWatchRepositorySelect = useCallback(async (fullName: string) => {
    const requestGeneration = ++watchDetailGeneration.current;
    setSelected(fullName);
    setWatchDetail((current) => current?.star?.full_name === fullName ? current : null);
    try {
      const detail = await runtime.getWatchRepositoryDetail(fullName);
      if (watchDetailGeneration.current !== requestGeneration) return;
      if (!detail.star) {
        setSelected(null);
        return;
      }
      setSelected(detail.star.full_name);
      setWatchDetail(detail);
    } catch {
      if (watchDetailGeneration.current !== requestGeneration) return;
      setWatchDetail((current) => current?.star?.full_name === fullName ? current : null);
    }
  }, [runtime]);

  const handleDetailDataChanged = useCallback(() => {
    refreshStars();
    if (watchSurface && selectedStar) {
      void handleWatchRepositorySelect(selectedStar.full_name);
    }
  }, [handleWatchRepositorySelect, refreshStars, selectedStar, watchSurface]);

  useEffect(() => runtime.subscribe((event) => {
    if (watchSurface && selected && (event.kind === 'data' || event.kind === 'watch')) {
      void handleWatchRepositorySelect(selected);
    }
  }), [handleWatchRepositorySelect, runtime, selected, watchSurface]);

  const handleManualTagMutationSuccess = useCallback(() => {
    refreshStars();
    reportMeaningfulAction();
  }, [refreshStars, reportMeaningfulAction]);

  const hasActiveFilter = f.languages.length > 0
    || f.tags.length > 0
    || f.onlyFavorite
    || f.onlyUntagged
    || f.onlyArchived
    || f.onlyOwned;

  const workspaceIdle = !loading && phase === 'idle' && !interactionLocked
    && !columnMenuOpen && !selectedStar && !openUnstarFullName
    && !displayedInfo && !unstarFeedback && !starsError;
  useEffect(() => {
    onActivityChange?.({ starsSurface, idle: workspaceIdle });
  }, [onActivityChange, starsSurface, workspaceIdle]);
  useEffect(() => {
    onCommandsChange?.({ refreshStars });
    return () => onCommandsChange?.(null);
  }, [onCommandsChange, refreshStars]);

  const agentCandidate = useMemo<BgsmAgentConversationCandidate>(() => starsSurface && selected
    ? { kind: 'selected_repository', selectedRepositoryIdHint: selected }
    : {
        kind: 'current_view',
        filter: {
          query: f.query,
          languages: [...f.languages],
          tags: [...f.tags],
          tagMode: f.tagMode,
          showTombstone: f.showTombstone,
          onlyFavorite: f.onlyFavorite,
          onlyUntagged: f.onlyUntagged,
          onlyArchived: f.onlyArchived,
          onlyOwned: f.onlyOwned,
          sortKey: f.sortKey,
          sortDir: f.sortDir,
        },
      }, [
    starsSurface, selected, f.query, f.languages, f.tags, f.tagMode,
    f.showTombstone, f.onlyFavorite, f.onlyUntagged, f.onlyArchived,
    f.onlyOwned, f.sortKey, f.sortDir,
  ]);
  const starsContent = extension?.renderStarsContent?.({ interactionLocked });

  const layoutColumnMenu = (
    <LayoutColumnMenu
      container={rootRef.current}
      editing={editingLayout}
      open={columnMenuOpen}
      position={columnMenuPosition}
      draftLayout={draftLayout}
      onSetColumnHidden={setColumnHidden}
      onSetRepositoryOwnerVisible={setRepositoryOwnerVisible}
      onSetRepositoryAvatarVisible={setRepositoryAvatarVisible}
    />
  );
  const layoutEditChrome = (
    <LayoutEditChrome
      editing={editingLayout}
      draftLayout={draftLayout}
      resizeColumnLabel={layoutResize ? COLUMN_DEFS[layoutResize.id].label(m) : null}
      layoutResize={layoutResize}
      tableWidth={layoutViewport?.tableWidth ?? null}
      panelWidth={layoutViewport?.panelWidth ?? null}
      overflowPx={layoutViewport?.overflowPx ?? 0}
      hiddenTrayColumns={hiddenTrayColumns}
      trayOpen={trayOpen}
      trayDropReady={trayDropReady}
      dropReadyLabel={layoutDrag?.kind === 'column' ? m.toolbar.dragHideHint(layoutDrag.label) : null}
      editColumnsButtonRef={editColumnsButtonRef}
      hideDropZoneRef={hideDropZoneRef}
      onToggleColumnMenu={toggleColumnMenu}
      onFitWidths={fitLayoutWidths}
      onResetWidths={resetLayoutWidths}
      onReset={resetLayoutEdit}
      onSave={saveLayoutEdit}
      onCancel={cancelLayoutEdit}
      onBeginTrayDrag={beginTrayDrag}
      onRestoreHiddenColumn={restoreHiddenColumn}
    />
  );

  const openOptions = extension?.onOpenOptions;
  const optionsUnavailable = useCallback(() => {
    runtime.resources.onBlockedLink({
      kind: 'subject',
      label: 'manager-options',
      remoteUrl: '',
    });
  }, [runtime]);
  const openOptionsSection = useCallback((section?: 'github' | 'watch') => {
    if (openOptions) openOptions(section);
    else optionsUnavailable();
  }, [openOptions, optionsUnavailable]);

  const starsTable = (
    <StarsTable
      scrollElement={listElement}
      rows={rows}
      searchQuery={f.query}
      showRepositoryOwner={showRepositoryOwner}
      showRepositoryAvatar={showRepositoryAvatar}
      loading={loading}
      phase={phase}
      tagsByFullName={tagsByFullName}
      favoriteOverrides={favoriteOverrides}
      selectedTags={f.tags}
      selectedFullName={selected}
      visibleColumns={visibleColumns}
      gridTemplateColumns={gridTemplateColumns}
      tableMinWidth={tableMinWidth}
      interactionLocked={interactionLocked}
      layoutEdit={{
        editing: editingLayout,
        faded: layoutFaded,
        transitionPhase: layoutModeTransitionPhase,
        draggedColumnId: layoutDrag?.kind === 'column' ? layoutDrag.id : null,
        draggedColumnHideIntent: layoutDrag?.kind === 'column' ? layoutDrag.hideIntent : false,
        columnShifts,
        flashedColumn,
        trayCaretX,
        onBeginColumnDrag: beginColumnDrag,
        onMoveColumnByKeyboard: moveColumnByKeyboard,
      }}
      layoutResize={layoutResize}
      scrollRef={listRef}
      rootRef={rootRef}
      headerRef={headerRef}
      layoutResizeLiveAdapterRef={layoutResizeLiveAdapterRef}
      onLayoutViewportChange={setLayoutViewport}
      onSelect={handleSelect}
      onToggleTag={f.toggleTag}
      onToggleFavorite={handleToggleFavorite}
      onConfirmUnstar={handleConfirmUnstar}
      openUnstarFullName={openUnstarFullName}
      onOpenUnstarChange={handleOpenUnstarChange}
      onBeginColumnResize={beginColumnResize}
      onResizeColumnByKeyboard={resizeColumnByKeyboard}
      onAutoFitColumnWidth={autoFitColumnWidth}
    />
  );

  return (
    <PortalProvider containerRef={rootRef}>
      <TooltipProvider delayDuration={300} skipDelayDuration={150}>
        <div ref={rootRef} className={cn('relative flex h-full flex-col bg-background text-foreground font-sans', themeClass)}>
          <Toolbar
            f={f}
            account={extension?.toolbar?.account ?? account}
            loading={loading}
            listPhase={phase}
            total={total}
            grandTotal={grandTotal}
            onToggleTheme={toggleTheme}
            theme={theme}
            searchRef={searchRef}
            layoutMode={layoutMode}
            layoutEditing={editingLayout}
            layoutConfigReady={layoutConfigReady}
            layoutEditReady={layoutEditReady}
            customLayoutDirty={customLayoutDirty}
            customPreviewing={previewingCustomLayout}
            hiddenColumnCount={hiddenColumnCount}
            onLayoutModeChange={setBrowseLayoutMode}
            onStartLayoutEdit={editingLayout ? cancelLayoutEdit : beginCustomLayoutEdit}
            onPreviewCustomChange={previewCustomLayout}
            layoutEditChrome={layoutEditChrome}
            surface={surface}
            onSurfaceChange={handleSurfaceChange}
            watchUnreadCount={watchInbox.result?.unreadCount
              ?? surfaceBadges.watchUnreadCount}
            radarUnseenCount={radar.result?.unseenCount
              ?? surfaceBadges.radarUnseenCount}
            {...extension?.toolbar}
          />
          {watchSurface && (
            <WatchStatusRibbon
              result={watchInbox.result}
              loading={watchInbox.loading}
              refreshing={watchInbox.refreshing}
              error={watchInbox.error}
              onOpenOptions={() => openOptionsSection('watch')}
            />
          )}
          {radarSurface && (
            <RadarStatusRibbon
              result={radar.result}
              loading={radar.loading}
              refreshing={radar.refreshing}
              fullReconciling={radar.fullReconciling}
              error={radar.error}
              onOpenOptions={() => openOptionsSection()}
            />
          )}
          {starsSurface && layoutColumnMenu}
          {starsSurface && extension?.renderStarsBanner?.({ interactionLocked })}
          {starsSurface && starsError && (
            <div role="alert" data-stars-query-error className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 text-xs text-destructive">
              <span>{m.radar.statusLabel('error')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={interactionLocked || loading}
                onClick={refreshStars}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {m.radar.retry}
              </Button>
            </div>
          )}
          {starsSurface && (
            <div
              className={cn('gsm-active-filter-row', { open: hasActiveFilter })}
              aria-hidden={!hasActiveFilter}
              {...getLockedRegionProps(!hasActiveFilter)}
            >
              <div>
                <ActiveFilterChips f={f} count={total} interactionLocked={interactionLocked} />
              </div>
            </div>
          )}
          {starsSurface && (displayedInfo || unstarFeedback) && (
            <div className="gsm-helper-text flex items-center gap-1 border-b border-border bg-card px-3 py-1">
              <span key={helperInfoKey(displayedInfo, unstarFeedback)} className="gsm-helper-text-update inline-block min-w-0 rounded-sm px-1 transition-[background-color,opacity,transform] duration-150">
                <HelperInfoText info={displayedInfo} unstarFeedback={unstarFeedback} m={m} />
              </span>
              <button
                type="button"
                aria-label={m.common.close}
                onClick={() => {
                  setInfo(null);
                  extension?.onClearInfo?.();
                  clearUnstarFeedback();
                }}
                className="ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          )}
          <div
            id={`gsm-${surface}-surface-panel`}
            role="tabpanel"
            data-surface={surface}
            data-surface-direction={surfaceDirection}
            aria-labelledby={`gsm-${surface}-surface-tab`}
            className="gsm-surface-panel relative flex min-h-0 flex-1"
          >
            {starsSurface && (
              <FilterSidebar
                f={f}
                languages={languages}
                tagTree={tagTree}
                accountLogin={account?.username ?? null}
                interactionLocked={interactionLocked}
                onTagMutationMessage={(message) => {
                  if (message) setInfo(message);
                  if (message) clearUnstarFeedback();
                }}
                onTagMutationSuccess={handleManualTagMutationSuccess}
              />
            )}
            <div ref={bindListRef} data-surface={surface} className="no-scrollbar flex-1 overflow-auto">
              {watchSurface ? (
                <WatchInbox
                  result={watchInbox.result}
                  newerThan={watchInbox.newerThan}
                  scrollElement={listElement}
                  loading={watchInbox.loading}
                  refreshing={watchInbox.refreshing}
                  error={watchInbox.error}
                  loadingOlder={watchInbox.loadingOlder}
                  loadOlderError={watchInbox.loadOlderError}
                  unreadOnly={watchInbox.unreadOnly}
                  onUnreadOnlyChange={watchInbox.setUnreadOnly}
                  onRefresh={() => { void watchInbox.refresh(); }}
                  onRetryQuery={() => { void watchInbox.reload(); }}
                  onLoadOlder={() => { void watchInbox.loadOlder(); }}
                  actionPending={watchInbox.actionPending}
                  actionError={watchInbox.actionError}
                  onMarkThreadsRead={(threadIds) => { void watchInbox.markThreadsRead(threadIds); }}
                  onMarkThreadsDone={(threadIds) => { void watchInbox.markThreadsDone(threadIds); }}
                  onOpenOptions={() => openOptionsSection('watch')}
                  onOpenMainTokenOptions={() => openOptionsSection('github')}
                  collapsedRepositories={watchInbox.collapsedRepositories}
                  onRepositoryCollapseChange={watchInbox.updateRepositoryCollapse}
                  onSelectRepository={(fullName) => { void handleWatchRepositorySelect(fullName); }}
                />
              ) : radarSurface ? (
                <Radar
                  result={radar.result}
                  scrollElement={listElement}
                  recommendations={radar.recommendations}
                  discoverView={radar.discoverView}
                  loading={radar.loading}
                  recommendationLoading={radar.recommendationLoading}
                  refreshing={radar.refreshing}
                  fullReconciling={radar.fullReconciling}
                  recommendationRefreshing={radar.recommendationRefreshing}
                  error={radar.error}
                  recommendationError={radar.recommendationError}
                  actionError={radar.actionError}
                  pendingAction={radar.pendingAction}
                  recommendationFavorites={radar.recommendationFavorites}
                  view={radar.view}
                  onViewChange={radar.setView}
                  onDiscoverViewChange={radar.setDiscoverView}
                  onSourceEnabledChange={radar.setSourceEnabled}
                  sources={radar.sources}
                  onRefresh={() => { void radar.refresh(); }}
                  onFullReconcile={() => { void radar.fullReconcile(); }}
                  onRefreshRecommendations={() => { void radar.refreshRecommendations(); }}
                  onRetryQuery={() => { void radar.reload(); }}
                  onRetryRecommendations={() => { void radar.reloadRecommendations(); }}
                  onOpenOptions={() => openOptionsSection()}
                  onStar={radar.star}
                  onUnstar={radar.unstar}
                  onIgnore={radar.ignoreRecommendation}
                  onRestoreIgnored={radar.restoreIgnoredRecommendation}
                  onSetFavorite={radar.setFavorite}
                  onAddTag={radar.addTag}
                  onDismiss={radar.dismiss}
                  onMarkSeen={radar.markSeen}
                />
              ) : starsContent !== undefined ? starsContent : starsTable}
            </div>
            {selectedStar && (
              <button
                type="button"
                className="absolute inset-0 z-20 hidden bg-background/60 backdrop-blur-[1px] max-[899px]:block"
                aria-label={m.common.close}
                onClick={() => {
                  watchDetailGeneration.current++;
                  setSelected(null);
                  setWatchDetail(null);
                }}
              />
            )}
            <div className={cn('drawer-anim z-30 border-l border-border max-[899px]:absolute max-[899px]:inset-y-0 max-[899px]:right-0 max-[899px]:shadow-xl max-[640px]:left-0', {
              'drawer-enter': selectedStar,
              'drawer-exit': !selectedStar,
            })}>
              {selectedStar && (
                <RepoDetailPanel
                  star={selectedStar}
                  tag={selectedTag}
                  selectedTags={f.tags}
                  onToggleTag={f.toggleTag}
                  onDataChanged={handleDetailDataChanged}
                  onMeaningfulAction={reportMeaningfulAction}
                  onClose={() => {
                    watchDetailGeneration.current++;
                    setSelected(null);
                    setWatchDetail(null);
                  }}
                  onPrev={() => starsSurface && selectedIdx > 0 && setSelected(rows[selectedIdx - 1].full_name)}
                  onNext={() => starsSurface && selectedIdx >= 0 && selectedIdx < rows.length - 1 && setSelected(rows[selectedIdx + 1].full_name)}
                  hasPrev={starsSurface && selectedIdx > 0}
                  hasNext={starsSurface && selectedIdx >= 0 && selectedIdx < rows.length - 1}
                  interactionLocked={interactionLocked}
                />
              )}
            </div>
          </div>
          <FloatingLocaleToggle
            drawerOpen={!!selectedStar}
            interactionLocked={interactionLocked}
            onClearLocalData={extension?.onClearLocalData}
          />
          <LayoutDragGhost ghost={dragGhost} />
          {extension?.renderOverlays?.({
            rootRef,
            starsSurface,
            agentCandidate,
            scopeCount: agentCandidate.kind === 'selected_repository' ? 1 : total,
            refreshStars,
          })}
        </div>
      </TooltipProvider>
    </PortalProvider>
  );
}
