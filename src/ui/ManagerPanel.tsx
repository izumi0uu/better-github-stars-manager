import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, Heart, RefreshCw, Sparkles } from 'lucide-react';
import { useStars } from '@/ui/use-stars';
import { useFilterStore } from '@/ui/filter-store';
import { StarRow } from '@/ui/components/StarRow';
import { Toolbar } from '@/ui/components/Toolbar';
import { FilterSidebar } from '@/ui/components/FilterSidebar';
import { ActiveFilterChips } from '@/ui/components/ActiveFilterChips';
import { FloatingLocaleToggle } from '@/ui/components/FloatingLocaleToggle';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { pruneFavoriteOverrides, resolveFavoriteState, type FavoriteOverrideState } from '@/ui/favorite-state';
import { pickInitialSyncAction } from '@/ui/initial-sync';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import { PortalProvider } from '@/ui/shadcn/portal-context';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { useTheme } from '@/ui/hooks/use-theme';
import { bgCall, mergeProgressStatus, mergeStatusPatch, mergeStatusSnapshot, onProgress, type SyncStatus } from '@/utils/messaging';
import { hidePanel } from '@/content/stars-page/panel-toggle';
import { isOnboardingCardStage, resolveOnboardingStageAfterSync, shouldTrackOnboardingSync } from '@/onboarding/state';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

const ROW_HEIGHT = 64;
const GRID_COLS = 'grid-cols-[minmax(180px,1.4fr)_2fr_80px_64px_84px_1.6fr_28px_20px]';

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
  const { theme, themeClass, toggle: toggleTheme } = useTheme();
  const { m } = useI18n();

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
    const m = location.hash.match(/gsm-tag=([^&]+)/);
    if (m) {
      f.toggleTag(decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let off = () => {};
    (async () => {
      off = onProgress((progress) => setStatus((current) => mergeProgressStatus(current, progress)));
      const st = await bgCall<SyncStatus>('getStatus').catch(() => null);
      setStatus((current) => mergeStatusSnapshot(current, st));
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
            if (tracksOnboarding) await finalizeOnboardingAfterSync(true);
          })
          .catch(async (e) => {
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
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

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
    f.languages.length > 0 || f.tags.length > 0 || f.onlyFavorite || f.onlyUntagged;

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
        />

        {statusLoaded && status && !status.hasToken && status.onboardingStage === 'done' && (
          <div className="flex items-center gap-2 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{m.manager.noTokenBanner}</span>
            <Button
              size="sm"
              onClick={() => bgCall('openOptions').catch(() => {})}
            >
              {m.manager.addPat}
            </Button>
          </div>
        )}

        <div className={cn('filter-row-anim border-b border-border', !hasActiveFilter && 'collapsed')}>
          <ActiveFilterChips f={f} count={total} />
        </div>

        {info && (
          <div className="border-b border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">{info}</div>
        )}

        <div className="flex min-h-0 flex-1">
          <FilterSidebar
            f={f}
            languages={languages}
            tagTree={tagTree}
            onTagDeleted={(message) => {
              refreshStars();
              if (message) setInfo(message);
            }}
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
                onOpenOptions={() => bgCall('openOptions').catch(() => {})}
                onRetry={() => void doSync('syncFull', m.popup.syncFull)}
              />
            ) : (
              <>
            <div
              style={{
                opacity: phase === 'fading-out' ? 0 : 1,
                transition: `opacity ${phase === 'fading-out' ? 120 : 160}ms cubic-bezier(0.4, 0, 0.2, 1)`,
              }}
            >
            <div
              className={cn(
                'sticky top-0 z-10 grid gap-2 border-b border-border bg-background px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground',
                GRID_COLS,
              )}
            >
              <span>{m.toolbar.columnRepository}</span>
              <span>{m.toolbar.columnDescription}</span>
              <span>{m.toolbar.columnLanguage}</span>
              <span className="text-right">{m.toolbar.columnStars}</span>
              <span>{m.toolbar.columnUpdated}</span>
              <span>{m.toolbar.columnTags}</span>
              <span className="flex justify-center" title={m.toolbar.columnFavorite}>
                <Heart className="size-3" aria-label={m.toolbar.columnFavorite} />
              </span>
              <span />
            </div>
            {rows.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                {loading ? m.common.loading : m.manager.emptyState}
              </div>
            ) : (
              <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const star = rows[vi.index];
                  const tag = tagsByFullName.get(star.full_name);
                  const { favorite, busy: favoriteBusy } = resolveFavoriteState(
                    tag,
                    favoriteOverrides[star.full_name],
                  );
                  return (
                    <div
                      key={star.full_name}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                    >
                      <StarRow
                        star={star}
                        tags={tag?.tags ?? []}
                        hasNotes={!!(tag?.notes && tag.notes.trim())}
                        favorite={favorite}
                        favoriteBusy={favoriteBusy}
                        selectedTags={f.tags}
                        onToggleTag={f.toggleTag}
                        onToggleFavorite={handleToggleFavorite}
                        selected={selected === star.full_name}
                        onSelect={handleSelect}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            </div>
              </>
            )}
          </div>

          <div className={cn('drawer-anim border-l border-border', selectedStar ? 'drawer-enter' : 'drawer-exit')}>
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
              />
            )}
          </div>
        </div>

        <FloatingLocaleToggle drawerOpen={!!selectedStar} />

        {statusLoaded && status?.onboardingStage === 'coach' && coachStep !== null && (
          <CoachOverlay
            step={coachStep}
            total={4}
            rootRef={rootRef}
            onNext={() => setCoachStep((s) => (s === null ? s : Math.min(s + 1, 3)))}
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
    sortKey: 'starred_at' as const,
    sortDir: 'desc' as const,
  };
}

function OnboardingCard({
  stage,
  failedInfo,
  onOpenOptions,
  onRetry,
}: {
  stage: SyncStatus['onboardingStage'];
  failedInfo: string | null;
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
          <div className="space-y-3 text-muted-foreground">
            <p>{m.onboarding.noTokenBody}</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                <a
                  className="text-primary hover:underline"
                  href="https://github.com/settings/personal-access-tokens/new"
                  target="_blank"
                  rel="noreferrer"
                >
                  {m.onboarding.createPatLabel}
                </a>
              </li>
              <li>{m.options.tokenPublicRepos}</li>
              <li>{m.options.tokenGists}</li>
            </ol>
            <Button onClick={onOpenOptions} className="w-full">
              {m.onboarding.openOptions}
            </Button>
          </div>
        ) : stage === 'sync_failed' ? (
          <div className="space-y-3 text-muted-foreground">
            <p>
              {m.onboarding.syncFailedBody} <span className="text-destructive">{failedInfo}</span>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onRetry}>
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

const COACH_TARGETS = ['sync', 'tags', 'repo', 'hide-panel'] as const;
const COACH_SPOT_PADDING: Record<(typeof COACH_TARGETS)[number], number> = {
  sync: 4,
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

  const titles = [m.onboarding.coachStep1Title, m.onboarding.coachStep2Title, m.onboarding.coachStep3Title, m.onboarding.coachStep4Title];
  const bodies = [m.onboarding.coachStep1Body, m.onboarding.coachStep2Body, m.onboarding.coachStep3Body, m.onboarding.coachStep4Body];
  const isLast = step === total - 1;

  return (
    // Full-screen click shield: blocks pointer events from reaching the page beneath
    // (toolbar buttons can't be clicked OR hovered). Several highlights are destructive
    // if clicked — step 1 would start a real sync, step 4 would unmount the panel and
    // kill the tour. The card below opts back into pointer-events-auto.
    <div className="pointer-events-auto absolute inset-0 z-50">
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
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>{m.onboarding.coachTitle}</span>
          <span>{m.onboarding.coachOf(step + 1, total)}</span>
        </div>
        <h3 className="text-sm font-semibold">{titles[step]}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{bodies[step]}</p>
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
