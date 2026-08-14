import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Sparkles, X } from 'lucide-react';
import { useStars } from '@/ui/use-stars';
import { useFilterStore } from '@/ui/filter-store';
import { Toolbar } from '@/ui/components/Toolbar';
import { AutoTagAgentPrompt } from '@/ui/components/AutoTagAgentPrompt';
import { FilterSidebar } from '@/ui/components/FilterSidebar';
import { ActiveFilterChips } from '@/ui/components/ActiveFilterChips';
import { FloatingLocaleToggle } from '@/ui/components/FloatingLocaleToggle';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { StarsTable } from '@/ui/components/StarsTable';
import {
  WatchInbox,
  WatchStatusRibbon,
} from '@/ui/components/WatchInbox';
import {
  RadarStatusRibbon,
  RadarSurface,
} from '@/ui/components/RadarSurface';
import { LayoutColumnMenu, LayoutDragGhost, LayoutEditChrome } from '@/ui/components/LayoutEditChrome';
import { useColumnLayoutEditor } from '@/ui/hooks/use-column-layout-editor';
import { useManagerSyncActions } from '@/ui/hooks/use-manager-sync-actions';
import { useAutoTagAgentPrompt } from '@/ui/hooks/use-auto-tag-agent-prompt';
import { useWatchInbox } from '@/ui/hooks/use-watch-inbox';
import { useRadar } from '@/ui/hooks/use-radar';
import { pruneFavoriteOverrides, type FavoriteOverrideState } from '@/ui/favorite-state';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import { PortalProvider } from '@/ui/shadcn/portal-context';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { useTheme } from '@/ui/hooks/use-theme';
import { getLockedAnchorProps, getLockedRegionProps, shouldIgnorePanelShortcut } from '@/ui/interaction-lock';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import { bgCall, type SyncStatus } from '@/utils/messaging';
import { hidePanel } from '@/content/stars-page/panel-toggle';
import { cn } from '@/lib/utils';
import { useI18n, type MessageCatalog } from '@/i18n';
import type { BackfillState, Star, Tag } from '@/types';
import { COLUMN_DEFS } from '@/ui/column-layout';
import { layoutViewportFromMeasurements, type LayoutViewportState } from '@/ui/layout-resize-surface';
import type { LayoutResizeLiveAdapter } from '@/ui/layout-resize-tool';
import { nextOpenUnstarFullName } from '@/ui/unstar-popover-state';
import type { AgentHostPresentation } from '@/ui/components/AgentHost';
import {
  managerSurfaceDirection,
  managerSurfaceFromShortcut,
  type ManagerSurface,
  type ManagerSurfaceDirection,
} from '@/ui/manager-surface';

const LazyAgentHost = lazy(() => import('@/ui/components/AgentHost').then(({ AgentHost }) => ({
  default: AgentHost,
})));

export { layoutViewportFromMeasurements };


type UnstarFeedback =
  | { kind: 'done'; fullName: string }
  | { kind: 'failed'; fullName: string; error: string };

type WatchRepositoryDetail = { star: Star | null; tag: Tag | null };
type Account = {
  username: string | null;
  avatarUrl: string | null;
  displayName: string | null;
  gistId: string | null;
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
      <a
        href={TOKEN_SETTINGS_URL}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        onClick={(event) => event.stopPropagation()}
      >
        {TOKEN_SETTINGS_LABEL}
      </a>
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

function HelperInfoText({ info, unstarFeedback, m }: { info: string | null; unstarFeedback: UnstarFeedback | null; m: MessageCatalog }) {
  if (unstarFeedback) return <UnstarFeedbackText feedback={unstarFeedback} m={m} />;
  return <>{info}</>;
}

function helperInfoKey(info: string | null, unstarFeedback: UnstarFeedback | null): string {
  if (unstarFeedback) return `${unstarFeedback.kind}:${unstarFeedback.fullName}:${unstarFeedback.kind === 'failed' ? unstarFeedback.error : ''}`;
  return info ?? '';
}

export function ManagerPanel() {
  const { rows, total, grandTotal, loading, phase, languages, tagTree, tagsByFullName, refresh: refreshStars } = useStars();
  const watchInbox = useWatchInbox();
  const radar = useRadar();
  const f = useFilterStore();
  const {
    status,
    statusLoaded,
    busy,
    pendingAction,
    successAction,
    info,
    setInfo,
    applyStatusPatch,
    setOnboardingStage,
    doSync,
    autoAssignTags,
    runBackfill,
    deferBackfill,
    isOnboardingCardStage,
  } = useManagerSyncActions({ refreshStars });
  const [surface, setSurface] = useState<ManagerSurface>('stars');
  const [account, setAccount] = useState<Account | null>(null);
  const [surfaceDirection, setSurfaceDirection] = useState<ManagerSurfaceDirection>('forward');
  const [selected, setSelected] = useState<string | null>(null);
  const [watchDetail, setWatchDetail] = useState<WatchRepositoryDetail | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [agentHostMounted, setAgentHostMounted] = useState(false);
  const [agentPresentation, setAgentPresentation] = useState<AgentHostPresentation>({
    status: null,
    statusKind: null,
    active: false,
  });
  const [coachStep, setCoachStep] = useState<number | null>(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, FavoriteOverrideState>>({});
  const [unstarFeedback, setUnstarFeedback] = useState<UnstarFeedback | null>(null);
  const [openUnstarFullName, setOpenUnstarFullName] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const bindListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListElement(node);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutResizeLiveAdapterRef = useRef<LayoutResizeLiveAdapter | null>(null);
  const watchDetailGeneration = useRef(0);
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
  const visibleRows = rows;
  const visibleTotal = total;
  const visibleGrandTotal = grandTotal;
  const starsSurface = surface === 'stars';
  const watchSurface = surface === 'watch';
  const radarSurface = surface === 'radar';

  useEffect(() => {
    let cancelled = false;
    const refreshAccount = async () => {
      const next = typeof authStore.getAccount === 'function'
        ? await authStore.getAccount().catch(() => null)
        : null;
      if (cancelled || !next) return null;
      setAccount(next);
      if (!next.username) useFilterStore.getState().setOnlyOwned(false);
      return next;
    };
    void refreshAccount().then((current) => {
      if (!current?.username || current.avatarUrl) return;
      void bgCall<Account>('fetchAccount')
        .then((next) => {
          if (!cancelled) setAccount(next);
        })
        .catch(() => {});
    });
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
      return () => {
        cancelled = true;
      };
    }

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      const configChange = changes[CONFIG_STORAGE_KEY];
      if (areaName !== 'local' || !configChange) return;
      const nextUsername = (configChange.newValue as { username?: unknown } | undefined)?.username;
      if (typeof nextUsername !== 'string' || !nextUsername.trim()) {
        useFilterStore.getState().setOnlyOwned(false);
      }
      void refreshAccount();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);
  useEffect(() => () => {
    watchDetailGeneration.current++;
  }, []);

  useEffect(() => {
    if (info) setUnstarFeedback(null);
  }, [info]);
  useLayoutEffect(() => {
    if (!editingLayout) return;
    setSelected(null);
    setOpenUnstarFullName(null);
  }, [editingLayout]);

  useEffect(() => {
    const currentNames = new Set(rows.map((row) => row.full_name));
    setOpenUnstarFullName((current) => (current && !currentNames.has(current) ? null : current));
  }, [rows]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnorePanelShortcut(interactionLocked, e.target)) return;
      const unmodified = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (unmodified && e.key === '/' && starsSurface) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (unmodified && e.key.toLocaleLowerCase('en-US') === 'v' && radarSurface) {
        e.preventDefault();
        radar.setView(radar.view === 'feed' ? 'projects' : 'feed');
        return;
      }
      const shortcutSurface = managerSurfaceFromShortcut(e.key);
      if (shortcutSurface && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        handleSurfaceChange(shortcutSurface);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactionLocked, radar, radarSurface, starsSurface]);

  const dismissOnboarding = async () => {
    setCoachStep(null);
    await setOnboardingStage('done');
  };

  useEffect(() => {
    if (!statusLoaded || !status) return;
    if (status.onboardingStage === 'coach') {
      if (coachStep === null) setCoachStep(0);
      return;
    }
    if (coachStep !== null) setCoachStep(null);
  }, [coachStep, status, statusLoaded]);

  const finishCoach = async () => {
    setCoachStep(null);
    await dismissOnboarding();
  };
  const skipCoach = async () => {
    setCoachStep(null);
    await dismissOnboarding();
  };

  const selectedIdx = useMemo(
    () => (starsSurface && selected ? visibleRows.findIndex((r) => r.full_name === selected) : -1),
    [selected, starsSurface, visibleRows],
  );
  const selectedStar = starsSurface
    ? selectedIdx >= 0 ? visibleRows[selectedIdx] : null
    : selected ? watchDetail?.star ?? null : null;
  const selectedTag = starsSurface
    ? selectedStar ? tagsByFullName.get(selectedStar.full_name) : undefined
    : watchDetail?.tag ?? undefined;
  useEffect(() => {
    setFavoriteOverrides((current) => pruneFavoriteOverrides(current, tagsByFullName, visibleRows));
  }, [visibleRows, tagsByFullName]);

  const handleSelect = (full_name: string) => {
    setSelected((cur) => (cur === full_name ? null : full_name));
  };

  const handleWatchRepositorySelect = async (fullName: string) => {
    const requestGeneration = ++watchDetailGeneration.current;
    setSelected(fullName);
    setWatchDetail(null);
    try {
      const detail = await bgCall<WatchRepositoryDetail>('getWatchRepositoryDetail', { fullName });
      if (watchDetailGeneration.current !== requestGeneration) return;
      if (!detail.star) {
        setSelected(null);
        return;
      }
      setSelected(detail.star.full_name);
      setWatchDetail(detail);
    } catch {
      if (watchDetailGeneration.current === requestGeneration) setSelected(null);
    }
  };

  const handleDetailDataChanged = () => {
    refreshStars();
    if (watchSurface && selectedStar) {
      void handleWatchRepositorySelect(selectedStar.full_name);
    }
  };

  const openAgentPanel = () => {
    setAgentHostMounted(true);
    setAgentPanelOpen(true);
  };

  const handleAutoAssignTags = async () => {
    await autoAssignTags();
  };

  const autoTagAgentPrompt = useAutoTagAgentPrompt({
    onOpenAgent: openAgentPanel,
    onRunAutoTags: () => { void handleAutoAssignTags(); },
  });

  const handleSurfaceChange = (next: ManagerSurface) => {
    if (next === surface || editingLayout) return;
    watchDetailGeneration.current++;
    setSelected(null);
    setWatchDetail(null);
    setOpenUnstarFullName(null);
    setUnstarFeedback(null);
    setAgentPanelOpen(false);
    autoTagAgentPrompt.dismiss();
    setSurfaceDirection(managerSurfaceDirection(surface, next));
    setSurface(next);
  };

  const agentCandidate = useMemo(() => starsSurface && selected
    ? {
        kind: 'selected_repository' as const,
        selectedRepositoryIdHint: selected,
      }
    : {
        kind: 'current_view' as const,
        filter: {
          query: f.query,
          languages: [...new Set(f.languages)],
          tags: [...new Set(f.tags)],
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
    f.languages,
    f.onlyArchived,
    f.onlyOwned,
    f.onlyFavorite,
    f.onlyUntagged,
    f.query,
    f.showTombstone,
    f.sortDir,
    f.sortKey,
    f.tagMode,
    f.tags,
    selected,
    starsSurface,
  ]);

  const handleToggleFavorite = async (full_name: string, favorite: boolean) => {
    setFavoriteOverrides((current) => ({
      ...current,
      [full_name]: { value: favorite, pending: true },
    }));
    try {
      await bgCall('setFavorite', { full_name, favorite });
      setFavoriteOverrides((current) => ({
        ...current,
        [full_name]: { value: favorite, pending: false },
      }));
      setUnstarFeedback(null);
      setInfo(null);
    } catch (e) {
      setFavoriteOverrides((current) => {
        if (!(full_name in current)) return current;
        const next = { ...current };
        delete next[full_name];
        return next;
      });
      setUnstarFeedback(null);
      setInfo(m.manager.syncFailed(m.toolbar.columnFavorite, e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const handleConfirmUnstar = (fullName: string) => {
    if (interactionLocked) return;

    setOpenUnstarFullName(null);
    setUnstarFeedback(null);
    setInfo(null);

    bgCall('markUnstarred', { full_name: fullName })
      .then(() => {
        setSelected((current) => (current === fullName ? null : current));
        setUnstarFeedback({ kind: 'done', fullName });
      })
      .catch((error) => {
        setUnstarFeedback({
          kind: 'failed',
          fullName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const handleOpenUnstarChange = (fullName: string | null, sourceFullName: string) => {
    setOpenUnstarFullName((current) => nextOpenUnstarFullName(current, fullName, sourceFullName));
  };

  const hasActiveFilter =
    f.languages.length > 0 || f.tags.length > 0 || f.onlyFavorite || f.onlyUntagged
    || f.onlyArchived || f.onlyOwned;
  const activeBackfillId = status?.activeBackfillId ?? null;
  const activeBackfillState = activeBackfillId ? status?.backfills[activeBackfillId] ?? null : null;

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

  return (
    <PortalProvider containerRef={rootRef}>
      <TooltipProvider delayDuration={300} skipDelayDuration={150}>
      <div
        ref={rootRef}
        className={cn('relative flex h-full flex-col bg-background text-foreground font-sans', themeClass)}
      >
        <Toolbar
          f={f}
          account={account}
          status={status}
          loading={loading}
          listPhase={phase}
          total={visibleTotal}
          grandTotal={visibleGrandTotal}
          busy={busy}
          pendingAction={pendingAction}
          successAction={successAction}
          onSync={doSync}
          onAutoAssignTags={() => { void autoTagAgentPrompt.requestAutoTags(); }}
          onOpenAgent={openAgentPanel}
          agentStatus={agentPresentation.status}
          agentStatusKind={agentPresentation.statusKind}
          onStatusPatch={applyStatusPatch}
          onToggleTheme={toggleTheme}
          onTogglePanel={hidePanel}
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
          watchUnreadCount={watchInbox.result?.unreadCount ?? 0}
          radarUnseenCount={radar.result?.unseenCount ?? 0}
        />
        {watchSurface && (
          <WatchStatusRibbon
            result={watchInbox.result}
            loading={watchInbox.loading}
            refreshing={watchInbox.refreshing}
            error={watchInbox.error}
            onOpenOptions={() => bgCall('openOptions', { section: 'watch' }).catch(() => {})}
          />
        )}
        {radarSurface && (
          <RadarStatusRibbon
            result={radar.result}
            loading={radar.loading}
            refreshing={radar.refreshing}
            error={radar.error}
            onOpenOptions={() => bgCall('openOptions').catch(() => {})}
          />
        )}
        {starsSurface && layoutColumnMenu}

        {starsSurface && statusLoaded && status && !status.hasToken && status.onboardingStage === 'done' && (
          <div className="flex items-center gap-2 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{m.manager.noTokenBanner}</span>
            <Button
              size="sm"
              disabled={interactionLocked}
              onClick={() => bgCall('openOptions').catch(() => {})}
            >
              {m.manager.addPat}
            </Button>
          </div>
        )}

        {starsSurface && <div
          className={cn('gsm-active-filter-row', { open: hasActiveFilter })}
          aria-hidden={!hasActiveFilter}
          {...getLockedRegionProps(!hasActiveFilter)}
        >
          <div>
            <ActiveFilterChips f={f} count={visibleTotal} interactionLocked={interactionLocked} />
          </div>
        </div>}

        {starsSurface && (info || unstarFeedback) && (
          <div className="gsm-helper-text flex items-center gap-1 border-b border-border bg-card px-3 py-1">
            <span
              key={helperInfoKey(info, unstarFeedback)}
              className="gsm-helper-text-update inline-block min-w-0 rounded-sm px-1 transition-[background-color,opacity,transform] duration-150"
            >
              <HelperInfoText info={info} unstarFeedback={unstarFeedback} m={m} />
            </span>
            <button
              type="button"
              aria-label={m.common.close}
              onClick={() => { setInfo(null); setUnstarFeedback(null); }}
              className="ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        )}

        <div
          key={surface}
          id={`gsm-${surface}-surface-panel`}
          role="tabpanel"
          data-surface={surface}
          data-surface-direction={surfaceDirection}
          aria-labelledby={`gsm-${surface}-surface-tab`}
          className="gsm-surface-panel relative flex min-h-0 flex-1"
        >
          {starsSurface && <FilterSidebar
            f={f}
            languages={languages}
            tagTree={tagTree}
            accountLogin={account?.username ?? null}
            interactionLocked={interactionLocked}
            onTagMutationMessage={(message) => {
              if (message) setInfo(message);
              if (message) setUnstarFeedback(null);
            }}
            onTagMutationSuccess={refreshStars}
          />}

          <div
            ref={bindListRef}
            data-surface={surface}
            className="no-scrollbar flex-1 overflow-auto"
          >
            {watchSurface ? (
              <WatchInbox
                result={watchInbox.result}
                loading={watchInbox.loading}
                refreshing={watchInbox.refreshing}
                error={watchInbox.error}
                unreadOnly={watchInbox.unreadOnly}
                onUnreadOnlyChange={watchInbox.setUnreadOnly}
                onRefresh={() => { void watchInbox.refresh(); }}
                onRetryQuery={() => { void watchInbox.reload(); }}
                actionPending={watchInbox.actionPending}
                actionError={watchInbox.actionError}
                onMarkThreadsRead={(threadIds) => { void watchInbox.markThreadsRead(threadIds); }}
                onMarkThreadsDone={(threadIds) => { void watchInbox.markThreadsDone(threadIds); }}
                onOpenOptions={() => bgCall('openOptions', { section: 'watch' }).catch(() => {})}
                onOpenMainTokenOptions={() => bgCall('openOptions', { section: 'github' }).catch(() => {})}
                collapsedRepositories={watchInbox.collapsedRepositories}
                onRepositoryCollapseChange={watchInbox.updateRepositoryCollapse}
                onSelectRepository={(fullName) => { void handleWatchRepositorySelect(fullName); }}
              />
            ) : radarSurface ? (
              <RadarSurface
                result={radar.result}
                recommendations={radar.recommendations}
                discoverView={radar.discoverView}
                loading={radar.loading}
                recommendationLoading={radar.recommendationLoading}
                refreshing={radar.refreshing}
                recommendationRefreshing={radar.recommendationRefreshing}
                error={radar.error}
                recommendationError={radar.recommendationError}
                actionError={radar.actionError}
                pendingAction={radar.pendingAction}
                view={radar.view}
                onDiscoverViewChange={radar.setDiscoverView}
                onViewChange={radar.setView}
                onSourceEnabledChange={radar.setSourceEnabled}
                sources={radar.sources}
                onRefresh={() => { void radar.refresh(); }}
                onRefreshRecommendations={() => { void radar.refreshRecommendations(); }}
                onRetryQuery={() => { void radar.reload(); }}
                onRetryRecommendations={() => { void radar.reloadRecommendations(); }}
                onOpenOptions={() => bgCall('openOptions').catch(() => {})}
                onStar={radar.star}
                onUnstar={radar.unstar}
                onIgnore={radar.ignoreRecommendation}
                onRestoreIgnored={radar.restoreIgnoredRecommendation}
                onSetFavorite={radar.setFavorite}
                onAddTag={radar.addTag}
                onDismiss={radar.dismiss}
                onMarkSeen={radar.markSeen}
              />
            ) : !statusLoaded || !status ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                {m.common.loading}
              </div>
            ) : isOnboardingCardStage(status.onboardingStage) && coachStep === null ? (
              <OnboardingCard
                stage={status.onboardingStage}
                failedInfo={info}
                interactionLocked={interactionLocked}
                onOpenOptions={() => bgCall('openOptions').catch(() => {})}
                onRetry={() => void doSync('syncFull', m.popup.syncFull)}
              />
            ) : status.hasToken && activeBackfillId && activeBackfillState && coachStep === null ? (
              <BackfillCard
                state={activeBackfillState}
                progress={status.progress}
                actionBusy={busy || !!pendingAction}
                interactionLocked={interactionLocked}
                onRun={() => void runBackfill(activeBackfillId)}
                onDefer={() => void deferBackfill(activeBackfillId)}
              />
            ) : (
              <StarsTable
                scrollElement={listElement}
                rows={visibleRows}
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
            )}
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
                onClose={() => {
                  watchDetailGeneration.current++;
                  setSelected(null);
                  setWatchDetail(null);
                }}
                onPrev={() => starsSurface && selectedIdx > 0 && setSelected(visibleRows[selectedIdx - 1].full_name)}
                onNext={() => starsSurface && selectedIdx >= 0 && selectedIdx < visibleRows.length - 1 && setSelected(visibleRows[selectedIdx + 1].full_name)}
                hasPrev={starsSurface && selectedIdx > 0}
                hasNext={starsSurface && selectedIdx >= 0 && selectedIdx < visibleRows.length - 1}
                interactionLocked={interactionLocked}
              />
            )}
          </div>
        </div>

        <FloatingLocaleToggle drawerOpen={!!selectedStar} interactionLocked={interactionLocked} />

        <LayoutDragGhost ghost={dragGhost} />

        {starsSurface && agentHostMounted && (
          <Suspense fallback={null}>
            <LazyAgentHost
              open={agentPanelOpen}
              onHide={() => setAgentPanelOpen(false)}
              onOpenOptions={() => bgCall('openOptions').catch(() => {})}
              onDataChanged={refreshStars}
              onPresentationChange={setAgentPresentation}
              defaultCandidate={agentCandidate}
              chatCandidate={agentCandidate}
              scopeCount={agentCandidate.kind === 'selected_repository' ? 1 : visibleTotal}
            />
          </Suspense>
        )}

        {starsSurface && <AutoTagAgentPrompt
          open={autoTagAgentPrompt.open}
          onChooseAgent={autoTagAgentPrompt.chooseAgent}
          onChooseAutoTags={autoTagAgentPrompt.chooseAutoTags}
          onDismiss={autoTagAgentPrompt.dismiss}
        />}

        {starsSurface && statusLoaded && status?.onboardingStage === 'coach' && coachStep !== null && (
          <CoachOverlay
            step={coachStep}
            total={COACH_TARGETS.length}
            rootRef={rootRef}
            onNext={() => setCoachStep((s) => (s === null ? s : Math.min(s + 1, COACH_TARGETS.length - 1)))}
            onBack={() => setCoachStep((s) => (s === null ? s : Math.max(s - 1, 0)))}
            onFinish={() => void finishCoach()}
            onSkip={() => void skipCoach()}
          />
        )}
      </div>
      </TooltipProvider>
    </PortalProvider>
  );
}

function OnboardingCard({
  stage,
  failedInfo,
  interactionLocked,
  onOpenOptions,
  onRetry,
}: {
  stage: SyncStatus['onboardingStage'];
  failedInfo: string | null;
  interactionLocked: boolean;
  onOpenOptions: () => void;
  onRetry: () => void;
}) {
  const { m } = useI18n();

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-sm">
        <div className="mb-3 flex items-center gap-2 text-foreground">
          <Sparkles className="size-5 text-primary" />
          <h2 className="text-base font-semibold">{m.onboarding.title}</h2>
        </div>

        {stage === 'needs_token' ? (
          <div
            className={cn('space-y-3 text-muted-foreground', { 'opacity-55': interactionLocked })}
            {...getLockedRegionProps(interactionLocked)}
          >
            <p>{m.onboarding.noTokenBody}</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                <a
                  className="text-primary hover:underline"
                  href="https://github.com/settings/tokens/new?scopes=repo,gist,notifications,read:user&description=Better%20GitHub%20Stars%20Manager"
                  target="_blank"
                  rel="noreferrer"
                  {...getLockedAnchorProps(interactionLocked)}
                >
                  {m.onboarding.createPatLabel}
                </a>
              </li>
              <li>{m.options.tokenPublicRepos}</li>
              <li>{m.options.tokenGists}</li>
            </ol>
            <Button onClick={onOpenOptions} className="w-full" disabled={interactionLocked}>
              {m.onboarding.openOptions}
            </Button>
          </div>
        ) : stage === 'sync_failed' ? (
          <div
            className={cn('space-y-3 text-muted-foreground', { 'opacity-55': interactionLocked })}
            {...getLockedRegionProps(interactionLocked)}
          >
            <p>
              {m.onboarding.syncFailedBody} <span className="text-destructive">{failedInfo}</span>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onRetry} disabled={interactionLocked}>
                <RefreshCw className="size-4" data-icon="inline-start" />
                {m.onboarding.retry}
              </Button>
            </div>
          </div>
        ) : stage === 'syncing' || stage === 'awaiting_sync' ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-4" />
            <span>{m.onboarding.syncingBody}</span>
          </div>
        ) : (
          <p className="text-muted-foreground">{m.manager.emptyState}</p>
        )}
      </div>
    </div>
  );
}

function BackfillCard({
  state,
  progress,
  actionBusy,
  interactionLocked,
  onRun,
  onDefer,
}: {
  state: BackfillState;
  progress: SyncStatus['progress'];
  actionBusy: boolean;
  interactionLocked: boolean;
  onRun: () => void;
  onDefer: () => void;
}) {
  const { m } = useI18n();
  const busy = state.status === 'running' || (actionBusy && progress.phase === 'full');

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-sm">
        <div className="mb-3 flex items-center gap-2 text-foreground">
          <Sparkles className="size-5 text-primary" />
          <h2 className="text-base font-semibold">{m.manager.backfillSyncTitle}</h2>
        </div>

        {busy ? (
          <div className="space-y-3 text-muted-foreground">
            <div className="flex items-center gap-2">
              <Spinner className="size-4" />
              <span>{progress.message || m.manager.backfillSyncRunning}</span>
            </div>
            <p>{m.manager.backfillSyncBody}</p>
          </div>
        ) : (
          <div className="space-y-3 text-muted-foreground">
            <p>{m.manager.backfillSyncBody}</p>
            {state.status === 'failed' && state.error && (
              <p className="text-destructive">{m.manager.backfillSyncFailed(state.error)}</p>
            )}
            <div className="flex gap-2">
              <Button onClick={onRun} disabled={actionBusy || interactionLocked}>
                {state.status === 'failed' ? (
                  <>
                    <RefreshCw className="size-4" data-icon="inline-start" />
                    {m.manager.backfillSyncRetry}
                  </>
                ) : (
                  m.manager.backfillSyncAction
                )}
              </Button>
              <Button variant="ghost" onClick={onDefer} disabled={actionBusy || interactionLocked}>
                {m.manager.backfillSyncLater}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const COACH_TARGETS = ['surface-tabs', 'sync', 'auto-tags', 'agent', 'hide-panel'] as const;
const COACH_SPOT_PADDING: Record<(typeof COACH_TARGETS)[number], number> = {
  'surface-tabs': 6,
  sync: 4,
  'auto-tags': 4,
  agent: 4,
  'hide-panel': 4,
};

function CoachOverlay({
  step,
  total,
  rootRef,
  onNext,
  onBack,
  onFinish,
  onSkip,
}: {
  step: number;
  total: number;
  rootRef: React.RefObject<HTMLDivElement>;
  onNext: () => void;
  onBack: () => void;
  onFinish: () => void;
  onSkip: () => void;
}) {
  const { m } = useI18n();
  const target = COACH_TARGETS[step];
  const targetSel = `[data-coach-target="${target}"]`;
  const padding = COACH_SPOT_PADDING[target];

  const [spot, setSpot] = useState<{ left: number; top: number; w: number; h: number } | null>(null);
  const measure = () => {
    const root = rootRef.current;
    const el = root?.querySelector<HTMLElement>(targetSel);
    if (!root || !el) return;
    const r = el.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const left = Math.max(0, r.left - rr.left - padding);
    const top = Math.max(0, r.top - rr.top - padding);
    const right = Math.min(rr.width, r.right - rr.left + padding);
    const bottom = Math.min(rr.height, r.bottom - rr.top + padding);
    setSpot({ left, top, w: right - left, h: bottom - top });
  };

  useEffect(() => {
    const root = rootRef.current;
    const el = root?.querySelector<HTMLElement>(targetSel);
    if (!root || !el) return;
    // 'instant' so the element is in place before we measure; a smooth scroll is
    // async and would leave the spotlight at a mid-scroll rect.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    measure();
    // Re-measure on the next frame and on any in-panel scroll until it settles.
    const raf = requestAnimationFrame(measure);
    let settles = 0;
    const onScroll = () => {
      measure();
      if (settles++ > 12) window.removeEventListener('scroll', onScroll, true);
    };
    window.addEventListener('scroll', onScroll, true);
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, targetSel, rootRef]);

  const steps = [
    { title: m.onboarding.coachStep1Title, body: m.onboarding.coachStep1Body },
    { title: m.onboarding.coachStep2Title, body: m.onboarding.coachStep2Body },
    { title: m.onboarding.coachStep3Title, body: m.onboarding.coachStep3Body },
    { title: m.onboarding.coachStep4Title, body: m.onboarding.coachStep4Body },
    { title: m.onboarding.coachStep5Title, body: m.onboarding.coachStep5Body },
  ];
  const isLast = step === total - 1;

  return (
    // Full-screen click shield: blocks pointer events from reaching the page beneath
    // (toolbar buttons cannot be clicked or hovered). Sync would start network work,
    // while Hide panel would unmount the manager and end the tour. The card below
    // opts back into pointer events.
    <div
      className="gsm-z-overlay pointer-events-auto absolute inset-0"
      data-coach-step-target={target}
    >
      {spot && (
        <div
          className="gsm-coach-spotlight absolute"
          style={{
            left: spot.left,
            top: spot.top,
            width: spot.w,
            height: spot.h,
            borderRadius: 10,
            border: '2px solid hsl(var(--primary))',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
          }}
        />
      )}

      <div className="pointer-events-auto absolute bottom-6 left-1/2 w-[min(440px,90vw)] -translate-x-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl">
        <div className="gsm-meta-label mb-1 flex items-center justify-between">
          <span>{m.onboarding.coachTitle}</span>
          <span>{m.onboarding.coachOf(step + 1, total)}</span>
        </div>
        <h3 className="text-sm font-semibold">{steps[step]?.title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{steps[step]?.body}</p>
        {step === 0 && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/80">{m.onboarding.coachIntro}</p>}
        <div className="mt-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onSkip}>{m.onboarding.coachSkip}</Button>
          <span className="flex-1" />
          {step > 0 && (
            <Button variant="outline" size="sm" onClick={onBack}>{m.onboarding.coachBack}</Button>
          )}
          <Button size="sm" onClick={isLast ? onFinish : onNext}>
            {isLast ? m.onboarding.gotIt : m.onboarding.coachNext}
          </Button>
        </div>
      </div>
    </div>
  );
}
