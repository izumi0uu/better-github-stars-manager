import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';
import { useStars } from '@/ui/use-stars';
import { useFilterStore } from '@/ui/filter-store';
import { Toolbar } from '@/ui/components/Toolbar';
import { FilterSidebar } from '@/ui/components/FilterSidebar';
import { ActiveFilterChips } from '@/ui/components/ActiveFilterChips';
import { FloatingLocaleToggle } from '@/ui/components/FloatingLocaleToggle';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { StarsTable } from '@/ui/components/StarsTable';
import { LayoutColumnMenu, LayoutDragGhost, LayoutEditChrome } from '@/ui/components/LayoutEditChrome';
import { useColumnLayoutEditor } from '@/ui/hooks/use-column-layout-editor';
import { pruneFavoriteOverrides, type FavoriteOverrideState } from '@/ui/favorite-state';
import { pickInitialSyncAction } from '@/ui/initial-sync';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import { PortalProvider } from '@/ui/shadcn/portal-context';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { useTheme } from '@/ui/hooks/use-theme';
import { getLockedAnchorProps, getLockedRegionProps, shouldIgnorePanelShortcut } from '@/ui/interaction-lock';
import { bgCall, mergeProgressStatus, mergeStatusPatch, mergeStatusSnapshot, onProgress, type SyncStatus } from '@/utils/messaging';
import { hidePanel } from '@/content/stars-page/panel-toggle';
import { isOnboardingCardStage, resolveOnboardingStageAfterSync, shouldTrackOnboardingSync } from '@/onboarding/state';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import type { BackfillId, BackfillState } from '@/types';
import { COLUMN_DEFS } from '@/ui/column-layout';
import { layoutViewportFromMeasurements, type LayoutViewportState } from '@/ui/layout-resize-surface';
import type { LayoutResizeLiveAdapter } from '@/ui/layout-resize-tool';

export { layoutViewportFromMeasurements };
export { LayoutOverflowIndicator, LayoutResizeFeedbackOverlay } from '@/ui/components/StarsTable';

export function ManagerPanel() {
  const { rows, total, grandTotal, loading, phase, languages, tagTree, tagsByFullName, refresh: refreshStars } = useStars();
  const f = useFilterStore();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [successAction, setSuccessAction] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [coachStep, setCoachStep] = useState<number | null>(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, FavoriteOverrideState>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutResizeLiveAdapterRef = useRef<LayoutResizeLiveAdapter | null>(null);
  const { theme, themeClass, toggle: toggleTheme } = useTheme();
  const { m } = useI18n();
  const {
    layoutMode,
    editingLayout,
    layoutConfigReady,
    layoutEditReady,
    previewingCustomLayout,
    draftLayout,
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
    flashedColumn,
    columnMenuOpen,
    columnMenuPosition,
    headerRef,
    editColumnsButtonRef,
    setBrowseLayoutMode,
    previewCustomLayout,
    beginCustomLayoutEdit,
    saveLayoutEdit,
    cancelLayoutEdit,
    resetLayoutEdit,
    resetLayoutWidths,
    setColumnHidden,
    beginColumnDrag,
    beginColumnResize,
    autoFitColumnWidth,
    fitLayoutWidths,
    beginTrayDrag,
    restoreHiddenColumn,
    toggleColumnMenu,
  } = useColumnLayoutEditor(rootRef, listRef, layoutResizeLiveAdapterRef);
  const interactionLocked = editingLayout;
  const customColumnLayoutActive = editingLayout || layoutMode === 'custom' || previewingCustomLayout;
  const [layoutViewport, setLayoutViewport] = useState<LayoutViewportState | null>(null);

  const refreshStatus = async () => {
    const next = await bgCall<SyncStatus>('getStatus').catch(() => null);
    setStatus((current) => mergeStatusSnapshot(current, next));
    return next;
  };

  const setOnboardingStage = async (stage: SyncStatus['onboardingStage']) => {
    setStatus((cur) => mergeStatusPatch(cur, { onboardingStage: stage }));
    await bgCall('setOnboardingStage', { stage }).catch(() => {});
  };

  const finalizeOnboardingAfterSync = async (hasToken: boolean) => {
    const q = await bgCall<{ grandTotal: number }>('query', {
      params: { filter: emptyFilter(), offset: 0, limit: 1 },
    }).catch(() => null);
    if (!q) return;
    await setOnboardingStage(resolveOnboardingStageAfterSync(hasToken, q.grandTotal));
  };

  useEffect(() => {
    let off = () => {};
    (async () => {
      off = onProgress((progress) => setStatus((current) => mergeProgressStatus(current, progress)));
      const st = await refreshStatus();
      setStatusLoaded(true);
      if (st?.hasToken) {
        const q = await bgCall<{ grandTotal: number }>('query', {
          params: { filter: emptyFilter(), offset: 0, limit: 1 },
        }).catch(() => null);
        const syncType = pickInitialSyncAction(st, q?.grandTotal ?? 0);
        if (!syncType) return;
        const syncLabel = syncType === 'syncIncremental' ? m.popup.syncIncremental : m.popup.syncFull;
        const tracksOnboarding = shouldTrackOnboardingSync(st.onboardingStage);
        setPendingAction(syncType);
        if (tracksOnboarding) await setOnboardingStage('syncing');
        bgCall(syncType)
          .then(async () => {
            refreshStars();
            await refreshStatus();
            if (tracksOnboarding) await finalizeOnboardingAfterSync(true);
          })
          .catch(async (e) => {
            await refreshStatus();
            if (tracksOnboarding) await setOnboardingStage('sync_failed');
            setInfo(m.manager.syncFailed(syncLabel, e instanceof Error ? e.message : String(e)));
          })
          .finally(() => setPendingAction((cur) => (cur === syncType ? null : cur)));
      }
    })().finally(() => setStatusLoaded(true));
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnorePanelShortcut(interactionLocked, e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactionLocked]);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSuccess = (type: string) => {
    if (successTimer.current) clearTimeout(successTimer.current);
    setSuccessAction(type);
    successTimer.current = setTimeout(() => setSuccessAction(null), 1300);
  };
  useEffect(() => () => { if (successTimer.current) clearTimeout(successTimer.current); }, []);

  const doSync = async (type: string, label: string) => {
    setBusy(true);
    setPendingAction(type);
    setSuccessAction(null);
    setInfo(null);
    const tracksOnboarding =
      (type === 'syncIncremental' || type === 'syncFull') &&
      !!status &&
      shouldTrackOnboardingSync(status.onboardingStage);
    try {
      if (tracksOnboarding) await setOnboardingStage('syncing');
      const result = await bgCall<{ missing?: boolean }>(type);
      refreshStars();
      await refreshStatus();
      if (tracksOnboarding) await finalizeOnboardingAfterSync(!!status?.hasToken);
      if (type === 'gistPull' && result?.missing) {
        setInfo(m.background.gistPullMissing);
      } else {
        flashSuccess(type);
      }
    } catch (e) {
      if (tracksOnboarding) await setOnboardingStage('sync_failed');
      setInfo(m.manager.syncFailed(label, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingAction((cur) => (cur === type ? null : cur));
    }
  };

  const autoAssignTags = async () => {
    setBusy(true);
    setPendingAction('autoAssignTags');
    setSuccessAction(null);
    setInfo(null);
    try {
      await bgCall('autoAssignTags');
      refreshStars();
      await refreshStatus();
      flashSuccess('autoAssignTags');
    } catch (e) {
      setInfo(m.manager.autoAssignFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingAction((cur) => (cur === 'autoAssignTags' ? null : cur));
    }
  };

  const dismissOnboarding = async () => {
    setCoachStep(null);
    await setOnboardingStage('done');
  };

  const progressActive = !!status?.inFlight && status.progress.phase !== 'idle';
  const syncingNow = !!pendingAction || progressActive;
  useEffect(() => {
    if (!statusLoaded || !status) return;
    if (status.onboardingStage === 'coach') {
      if (coachStep === null) setCoachStep(0);
      return;
    }
    if (coachStep !== null) setCoachStep(null);
  }, [coachStep, status, statusLoaded]);

  useEffect(() => {
    if (!statusLoaded || !status) return;
    if (status.onboardingStage !== 'syncing' || syncingNow) return;
    void finalizeOnboardingAfterSync(status.hasToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusLoaded, status?.onboardingStage, status?.hasToken, syncingNow]);

  const finishCoach = async () => {
    setCoachStep(null);
    await dismissOnboarding();
  };
  const skipCoach = async () => {
    setCoachStep(null);
    await dismissOnboarding();
  };

  const selectedIdx = useMemo(
    () => (selected ? rows.findIndex((r) => r.full_name === selected) : -1),
    [selected, rows],
  );
  const selectedStar = selectedIdx >= 0 ? rows[selectedIdx] : null;
  const selectedTag = selectedStar ? tagsByFullName.get(selectedStar.full_name) : undefined;
  useEffect(() => {
    setFavoriteOverrides((current) => pruneFavoriteOverrides(current, tagsByFullName, rows));
  }, [rows, tagsByFullName]);

  const handleSelect = (full_name: string) => {
    setSelected((cur) => (cur === full_name ? null : full_name));
  };

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
      setInfo(null);
    } catch (e) {
      setFavoriteOverrides((current) => {
        if (!(full_name in current)) return current;
        const next = { ...current };
        delete next[full_name];
        return next;
      });
      setInfo(m.manager.syncFailed(m.toolbar.columnFavorite, e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const hasActiveFilter =
    f.languages.length > 0 || f.tags.length > 0 || f.onlyFavorite || f.onlyUntagged || f.onlyArchived;
  const activeBackfillId = status?.activeBackfillId ?? null;
  const activeBackfillState = activeBackfillId ? status?.backfills[activeBackfillId] ?? null : null;

  const runBackfill = async (id: BackfillId) => {
    setBusy(true);
    setPendingAction(`backfill:${id}`);
    setSuccessAction(null);
    setInfo(null);
    try {
      await bgCall('runBackfill', { id });
      refreshStars();
      await refreshStatus();
      flashSuccess(`backfill:${id}`);
    } catch (e) {
      await refreshStatus();
      setInfo(m.manager.syncFailed(m.manager.backfillSyncAction, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingAction((cur) => (cur === `backfill:${id}` ? null : cur));
    }
  };

  const deferBackfill = async (id: BackfillId) => {
    await bgCall('deferBackfill', { id }).catch(() => {});
    await refreshStatus();
  };

  const layoutColumnMenu = (
    <LayoutColumnMenu
      container={rootRef.current}
      editing={editingLayout}
      open={columnMenuOpen}
      position={columnMenuPosition}
      draftLayout={draftLayout}
      onSetColumnHidden={setColumnHidden}
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
          status={status}
          loading={loading}
          listPhase={phase}
          total={total}
          grandTotal={grandTotal}
          busy={busy}
          pendingAction={pendingAction}
          successAction={successAction}
          onSync={doSync}
          onAutoAssignTags={autoAssignTags}
          onStatusPatch={(patch) => setStatus((cur) => mergeStatusPatch(cur, patch))}
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
          onStartLayoutEdit={beginCustomLayoutEdit}
          onPreviewCustomChange={previewCustomLayout}
          layoutEditChrome={layoutEditChrome}
        />
        {layoutColumnMenu}

        {statusLoaded && status && !status.hasToken && status.onboardingStage === 'done' && (
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

        <div className={cn('filter-row-anim border-b border-border', { collapsed: !hasActiveFilter })}>
          <ActiveFilterChips f={f} count={total} interactionLocked={interactionLocked} />
        </div>

        {info && (
          <div className="gsm-helper-text border-b border-border bg-card px-3 py-1">{info}</div>
        )}

        <div className="flex min-h-0 flex-1">
          <FilterSidebar
            f={f}
            languages={languages}
            tagTree={tagTree}
            interactionLocked={interactionLocked}
            onTagMutationMessage={(message) => {
              if (message) setInfo(message);
            }}
            onTagMutationSuccess={refreshStars}
          />

          <div ref={listRef} data-coach-target="repo" className="no-scrollbar flex-1 overflow-auto">
            {!statusLoaded || !status ? (
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
                rows={rows}
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
                  draggedColumnId: layoutDrag?.kind === 'column' ? layoutDrag.id : null,
                  draggedColumnHideIntent: layoutDrag?.kind === 'column' ? layoutDrag.hideIntent : false,
                  columnShifts,
                  flashedColumn,
                  trayCaretX,
                  onBeginColumnDrag: beginColumnDrag,
                }}
                layoutResize={layoutResize}
                customColumnLayoutActive={customColumnLayoutActive}
                scrollRef={listRef}
                rootRef={rootRef}
                headerRef={headerRef}
                layoutResizeLiveAdapterRef={layoutResizeLiveAdapterRef}
                onLayoutViewportChange={setLayoutViewport}
                onSelect={handleSelect}
                onToggleTag={f.toggleTag}
                onToggleFavorite={handleToggleFavorite}
                onBeginColumnResize={beginColumnResize}
                onAutoFitColumnWidth={autoFitColumnWidth}
              />
            )}
          </div>

          <div className={cn('drawer-anim border-l border-border', {
            'drawer-enter': selectedStar,
            'drawer-exit': !selectedStar,
          })}>
            {selectedStar && (
              <RepoDetailPanel
                star={selectedStar}
                tag={selectedTag}
                selectedTags={f.tags}
                onToggleTag={f.toggleTag}
                onDataChanged={refreshStars}
                onClose={() => setSelected(null)}
                onPrev={() => selectedIdx > 0 && setSelected(rows[selectedIdx - 1].full_name)}
                onNext={() => selectedIdx >= 0 && selectedIdx < rows.length - 1 && setSelected(rows[selectedIdx + 1].full_name)}
                hasPrev={selectedIdx > 0}
                hasNext={selectedIdx >= 0 && selectedIdx < rows.length - 1}
                interactionLocked={interactionLocked}
              />
            )}
          </div>
        </div>

        <FloatingLocaleToggle drawerOpen={!!selectedStar} interactionLocked={interactionLocked} />

        <LayoutDragGhost ghost={dragGhost} />

        {statusLoaded && status?.onboardingStage === 'coach' && coachStep !== null && (
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

function emptyFilter() {
  return {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any' as const,
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at' as const,
    sortDir: 'desc' as const,
  };
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
                  href="https://github.com/settings/personal-access-tokens/new"
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

const COACH_TARGETS = ['sync', 'auto-tags', 'tags', 'repo', 'hide-panel'] as const;
const COACH_SPOT_PADDING: Record<(typeof COACH_TARGETS)[number], number> = {
  sync: 4,
  'auto-tags': 4,
  tags: 10,
  repo: 10,
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
    setSpot({ left: r.left - rr.left, top: r.top - rr.top, w: r.width, h: r.height });
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
    // (toolbar buttons can't be clicked OR hovered). Several highlights are destructive
    // if clicked — step 1 would start a real sync, step 4 would unmount the panel and
    // kill the tour. The card below opts back into pointer-events-auto.
    <div className="gsm-z-overlay pointer-events-auto absolute inset-0">
      {spot && (
        <div
          className="gsm-coach-spotlight absolute"
          style={{
            left: spot.left - padding,
            top: spot.top - padding,
            width: spot.w + padding * 2,
            height: spot.h + padding * 2,
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
