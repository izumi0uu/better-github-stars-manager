import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import { I18nProvider, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  createExtensionManagerRuntime,
} from '@/runtime/extension-manager-runtime';
import { AgentMascotIcon } from '@/ui/components/AgentMascot';
import { hidePanel } from '@/content/stars-page/panel-toggle';
import { AutoTagAgentPrompt } from '@/ui/components/AutoTagAgentPrompt';
import type { AgentHostPresentation } from '@/ui/components/AgentHost';
import { StoreRatingPrompt } from '@/ui/components/StoreRatingPrompt';
import { useAutoTagAgentPrompt } from '@/ui/hooks/use-auto-tag-agent-prompt';
import { useManagerSyncActions } from '@/ui/hooks/use-manager-sync-actions';
import { useStoreRatingPrompt } from '@/ui/hooks/use-store-rating-prompt';
import {
  ManagerWorkspace,
  type ManagerWorkspaceExtension,
  type ManagerWorkspaceSnapshot,
} from '@/ui/ManagerWorkspace';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { getLockedAnchorProps, getLockedRegionProps } from '@/ui/interaction-lock';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import type { BackfillState } from '@/types';
import { bgCall, type SyncStatus } from '@/utils/messaging';

const LazyAgentHost = lazy(() => import('@/ui/components/AgentHost').then(({ AgentHost }) => ({
  default: AgentHost,
})));

type ExtensionAccount = {
  username: string | null;
  avatarUrl: string | null;
  displayName: string | null;
  gistId: string | null;
};

export function ManagerPanel() {
  const runtime = useMemo(() => createExtensionManagerRuntime(), []);
  return (
    <ManagerRuntimeProvider runtime={runtime}>
      <I18nProvider source={runtime}>
        <ExtensionManagerPanel />
      </I18nProvider>
    </ManagerRuntimeProvider>
  );
}

function ExtensionManagerPanel() {
  const { m } = useI18n();
  const refreshStarsRef = useRef<() => void>(() => {});
  const [snapshot, setSnapshot] = useState<ManagerWorkspaceSnapshot | null>(null);
  const handleSnapshotChange = useCallback((next: ManagerWorkspaceSnapshot) => {
    refreshStarsRef.current = next.refreshStars;
    setSnapshot(next);
  }, []);
  const refreshStars = useCallback(() => refreshStarsRef.current(), []);
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
  const [account, setAccount] = useState<ExtensionAccount | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [agentHostMounted, setAgentHostMounted] = useState(false);
  const [agentPresentation, setAgentPresentation] = useState<AgentHostPresentation>({
    status: null,
    statusKind: null,
    active: false,
  });
  const [coachStep, setCoachStep] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refreshAccount = async () => {
      const next = typeof authStore.getAccount === 'function'
        ? await authStore.getAccount().catch(() => null)
        : null;
      if (!cancelled && next) setAccount(next);
      return next;
    };
    void refreshAccount().then((current) => {
      if (!current?.username || current.avatarUrl) return;
      void bgCall<ExtensionAccount>('fetchAccount')
        .then((next) => {
          if (!cancelled) setAccount(next);
        })
        .catch(() => {});
    });
    const onChanged = globalThis.chrome?.storage?.onChanged;
    if (!onChanged) return () => {
      cancelled = true;
    };
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes[CONFIG_STORAGE_KEY]) void refreshAccount();
    };
    onChanged.addListener(listener);
    return () => {
      cancelled = true;
      onChanged.removeListener(listener);
    };
  }, []);

  const dismissOnboarding = useCallback(async () => {
    setCoachStep(null);
    await setOnboardingStage('done');
  }, [setOnboardingStage]);

  useEffect(() => {
    if (!statusLoaded || !status) return;
    if (status.onboardingStage === 'coach') {
      if (coachStep === null) setCoachStep(0);
      return;
    }
    if (coachStep !== null) setCoachStep(null);
  }, [coachStep, status, statusLoaded]);

  const openAgentPanel = useCallback(() => {
    setAgentHostMounted(true);
    setAgentPanelOpen(true);
  }, []);
  const autoTagAgentPrompt = useAutoTagAgentPrompt({
    onOpenAgent: openAgentPanel,
    onRunAutoTags: () => { void autoAssignTags(); },
  });

  useEffect(() => {
    if (snapshot?.starsSurface !== false) return;
    setAgentPanelOpen(false);
    autoTagAgentPrompt.dismiss();
  }, [autoTagAgentPrompt.dismiss, snapshot?.starsSurface]);

  const managerIdleForStoreRating = !!snapshot
    && !!statusLoaded
    && !!status
    && status.hasToken
    && status.onboardingStage === 'done'
    && !snapshot.loading
    && snapshot.phase === 'idle'
    && !busy
    && !pendingAction
    && coachStep === null
    && !snapshot.interactionLocked
    && !snapshot.columnMenuOpen
    && !snapshot.selectedDetailOpen
    && !snapshot.unstarPopoverOpen
    && !autoTagAgentPrompt.open
    && !agentPanelOpen
    && !agentPresentation.active
    && !info
    && !snapshot.infoOpen;
  const storeRatingPrompt = useStoreRatingPrompt({
    onboardingComplete: statusLoaded && status?.onboardingStage === 'done',
    onMainManager: snapshot?.starsSurface === true,
    managerIdle: managerIdleForStoreRating,
  });
  const recordMeaningfulAction = useCallback(() => {
    void storeRatingPrompt.recordMeaningfulAction();
  }, [storeRatingPrompt.recordMeaningfulAction]);

  useEffect(() => {
    if (successAction === 'syncFull' || successAction === 'syncIncremental') {
      recordMeaningfulAction();
    }
  }, [recordMeaningfulAction, successAction]);

  const agentCandidate = useMemo(() => snapshot?.starsSurface && snapshot.selectedFullName
    ? {
        kind: 'selected_repository' as const,
        selectedRepositoryIdHint: snapshot.selectedFullName,
      }
    : {
        kind: 'current_view' as const,
        filter: snapshot ? {
          ...snapshot.filter,
          languages: [...snapshot.filter.languages],
          tags: [...snapshot.filter.tags],
        } : {
          query: '',
          languages: [],
          tags: [],
          tagMode: 'any' as const,
          showTombstone: false,
          onlyFavorite: false,
          onlyUntagged: false,
          onlyArchived: false,
          onlyOwned: false,
          sortKey: 'starred_at' as const,
          sortDir: 'desc' as const,
        },
      }, [snapshot]);

  const activeBackfillId = status?.activeBackfillId ?? null;
  const activeBackfillState = activeBackfillId ? status?.backfills[activeBackfillId] ?? null : null;
  let starsContentOverride: ReactNode | undefined;
  if (!statusLoaded || !status) {
    starsContentOverride = (
      <div className="p-10 text-center text-sm text-muted-foreground">{m.common.loading}</div>
    );
  } else if (isOnboardingCardStage(status.onboardingStage) && coachStep === null) {
    starsContentOverride = (
      <OnboardingCard
        stage={status.onboardingStage}
        failedInfo={info}
        interactionLocked={snapshot?.interactionLocked ?? false}
        onOpenOptions={() => { void bgCall('openOptions').catch(() => {}); }}
        onRetry={() => { void doSync('syncFull', m.popup.syncFull); }}
      />
    );
  } else if (status.hasToken && activeBackfillId && activeBackfillState && coachStep === null) {
    starsContentOverride = (
      <BackfillCard
        state={activeBackfillState}
        progress={status.progress}
        actionBusy={busy || !!pendingAction}
        interactionLocked={snapshot?.interactionLocked ?? false}
        onRun={() => { void runBackfill(activeBackfillId); }}
        onDefer={() => { void deferBackfill(activeBackfillId); }}
      />
    );
  }

  const starsBanner = statusLoaded
    && status
    && !status.hasToken
    && status.onboardingStage === 'done' ? (
      <div className="flex items-center gap-2 bg-warning/10 px-3 py-2 text-xs text-warning">
        <AlertTriangle className="size-4 shrink-0" />
        <span>{m.manager.noTokenBanner}</span>
        <Button
          size="sm"
          disabled={snapshot?.interactionLocked}
          onClick={() => { void bgCall('openOptions').catch(() => {}); }}
        >
          {m.manager.addPat}
        </Button>
      </div>
    ) : undefined;

  const extension = useMemo<ManagerWorkspaceExtension>(() => ({
    toolbar: {
      account: account ? {
        ...account,
        gistUrl: account.username && account.gistId
          ? `https://gist.github.com/${account.username}/${account.gistId}`
          : null,
      } : account,
      status,
      busy,
      pendingAction,
      successAction,
      onSync: doSync,
      onAutoAssignTags: () => { void autoTagAgentPrompt.requestAutoTags(); },
      onOpenAgent: openAgentPanel,
      agentStatus: agentPresentation.status,
      agentIcon: <AgentMascotIcon running={agentPresentation.active} />,
      agentStatusKind: agentPresentation.statusKind,
      agentActive: agentPresentation.active,
      onTooltipSeen: (bit) => {
        applyStatusPatch({ seenTooltips: (status?.seenTooltips ?? 0) | bit });
        void bgCall<{ seenTooltips: number }>('markTooltipSeen', { bit })
          .then((data) => applyStatusPatch({ seenTooltips: data.seenTooltips }))
          .catch(() => {});
      },
      onTogglePanel: hidePanel,
      showGitHubHome: true,
    },
    info,
    onClearInfo: () => setInfo(null),
    starsBanner,
    starsContentOverride,
    onOpenOptions: (section) => {
      void bgCall('openOptions', section ? { section } : undefined).catch(() => {});
    },
    onClearLocalData: async () => {
      await bgCall('devClearLocalData');
    },
    renderOverlays: (rootRef) => (
      <>
        {snapshot?.starsSurface && agentHostMounted && (
          <Suspense fallback={null}>
            <LazyAgentHost
              open={agentPanelOpen}
              onHide={() => setAgentPanelOpen(false)}
              onOpenOptions={() => { void bgCall('openOptions').catch(() => {}); }}
              onDataChanged={refreshStars}
              onPresentationChange={setAgentPresentation}
              defaultCandidate={agentCandidate}
              chatCandidate={agentCandidate}
              scopeCount={agentCandidate.kind === 'selected_repository' ? 1 : snapshot.visibleTotal}
            />
          </Suspense>
        )}
        {snapshot?.starsSurface && (
          <AutoTagAgentPrompt
            open={autoTagAgentPrompt.open}
            onChooseAgent={autoTagAgentPrompt.chooseAgent}
            onChooseAutoTags={autoTagAgentPrompt.chooseAutoTags}
            onDismiss={autoTagAgentPrompt.dismiss}
          />
        )}
        {snapshot?.starsSurface && statusLoaded && status?.onboardingStage === 'coach' && coachStep !== null && (
          <CoachOverlay
            step={coachStep}
            total={COACH_TARGETS.length}
            rootRef={rootRef}
            onNext={() => setCoachStep((current) => current === null
              ? current
              : Math.min(current + 1, COACH_TARGETS.length - 1))}
            onBack={() => setCoachStep((current) => current === null ? current : Math.max(current - 1, 0))}
            onFinish={() => { void dismissOnboarding(); }}
            onSkip={() => { void dismissOnboarding(); }}
          />
        )}
        {storeRatingPrompt.listing && (
          <StoreRatingPrompt
            open={storeRatingPrompt.open}
            storeLabel={storeRatingPrompt.listing.label}
            ratingUrl={storeRatingPrompt.listing.ratingUrl}
            onRate={storeRatingPrompt.rate}
            onLater={storeRatingPrompt.later}
            onNever={storeRatingPrompt.never}
          />
        )}
      </>
    ),
  }), [
    account,
    activeBackfillId,
    agentCandidate,
    agentHostMounted,
    agentPanelOpen,
    agentPresentation.active,
    agentPresentation.status,
    agentPresentation.statusKind,
    applyStatusPatch,
    autoTagAgentPrompt.chooseAgent,
    autoTagAgentPrompt.chooseAutoTags,
    autoTagAgentPrompt.dismiss,
    autoTagAgentPrompt.open,
    autoTagAgentPrompt.requestAutoTags,
    busy,
    coachStep,
    dismissOnboarding,
    doSync,
    info,
    openAgentPanel,
    pendingAction,
    refreshStars,
    snapshot,
    setInfo,
    starsBanner,
    starsContentOverride,
    status,
    statusLoaded,
    storeRatingPrompt,
    successAction,
  ]);

  return (
    <ManagerWorkspace
      extension={extension}
      onMeaningfulAction={recordMeaningfulAction}
      onSnapshotChange={handleSnapshotChange}
    />
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
          <div className={cn('space-y-3 text-muted-foreground', { 'opacity-55': interactionLocked })} {...getLockedRegionProps(interactionLocked)}>
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
          <div className={cn('space-y-3 text-muted-foreground', { 'opacity-55': interactionLocked })} {...getLockedRegionProps(interactionLocked)}>
            <p>{m.onboarding.syncFailedBody} <span className="text-destructive">{failedInfo}</span></p>
            <Button variant="outline" onClick={onRetry} disabled={interactionLocked}>
              <RefreshCw className="size-4" data-icon="inline-start" />
              {m.onboarding.retry}
            </Button>
          </div>
        ) : stage === 'syncing' || stage === 'awaiting_sync' ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-4" />
            <span>{m.onboarding.syncingBody}</span>
          </div>
        ) : <p className="text-muted-foreground">{m.manager.emptyState}</p>}
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
  const running = state.status === 'running' || (actionBusy && progress.phase === 'full');
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-sm">
        <div className="mb-3 flex items-center gap-2 text-foreground">
          <Sparkles className="size-5 text-primary" />
          <h2 className="text-base font-semibold">{m.manager.backfillSyncTitle}</h2>
        </div>
        {running ? (
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
            {state.status === 'failed' && state.error && <p className="text-destructive">{m.manager.backfillSyncFailed(state.error)}</p>}
            <div className="flex gap-2">
              <Button onClick={onRun} disabled={actionBusy || interactionLocked}>
                {state.status === 'failed' ? <><RefreshCw className="size-4" data-icon="inline-start" />{m.manager.backfillSyncRetry}</> : m.manager.backfillSyncAction}
              </Button>
              <Button variant="ghost" onClick={onDefer} disabled={actionBusy || interactionLocked}>{m.manager.backfillSyncLater}</Button>
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
  rootRef: RefObject<HTMLDivElement>;
  onNext: () => void;
  onBack: () => void;
  onFinish: () => void;
  onSkip: () => void;
}) {
  const { m } = useI18n();
  const target = COACH_TARGETS[step];
  const targetSelector = `[data-coach-target="${target}"]`;
  const padding = COACH_SPOT_PADDING[target];
  const [spot, setSpot] = useState<{ left: number; top: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const element = root?.querySelector<HTMLElement>(targetSelector);
    if (!root || !element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const left = Math.max(0, rect.left - rootRect.left - padding);
      const top = Math.max(0, rect.top - rootRect.top - padding);
      const right = Math.min(rootRect.width, rect.right - rootRect.left + padding);
      const bottom = Math.min(rootRect.height, rect.bottom - rootRect.top + padding);
      setSpot({ left, top, w: right - left, h: bottom - top });
    };
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    measure();
    const frame = requestAnimationFrame(measure);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [padding, rootRef, targetSelector]);

  const steps = [
    { title: m.onboarding.coachStep1Title, body: m.onboarding.coachStep1Body },
    { title: m.onboarding.coachStep2Title, body: m.onboarding.coachStep2Body },
    { title: m.onboarding.coachStep3Title, body: m.onboarding.coachStep3Body },
    { title: m.onboarding.coachStep4Title, body: m.onboarding.coachStep4Body },
    { title: m.onboarding.coachStep5Title, body: m.onboarding.coachStep5Body },
  ];
  const last = step === total - 1;
  return (
    <div className="gsm-z-overlay pointer-events-auto absolute inset-0" data-coach-step-target={target}>
      {spot && (
        <div className="gsm-coach-spotlight absolute" style={{ left: spot.left, top: spot.top, width: spot.w, height: spot.h, borderRadius: 10, border: '2px solid hsl(var(--primary))', boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)' }} />
      )}
      <div className="pointer-events-auto absolute bottom-6 left-1/2 w-[min(440px,90vw)] -translate-x-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl">
        <div className="gsm-meta-label mb-1 flex items-center justify-between"><span>{m.onboarding.coachTitle}</span><span>{m.onboarding.coachOf(step + 1, total)}</span></div>
        <h3 className="text-sm font-semibold">{steps[step]?.title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{steps[step]?.body}</p>
        {step === 0 && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/80">{m.onboarding.coachIntro}</p>}
        <div className="mt-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onSkip}>{m.onboarding.coachSkip}</Button>
          <span className="flex-1" />
          {step > 0 && <Button variant="outline" size="sm" onClick={onBack}>{m.onboarding.coachBack}</Button>}
          <Button size="sm" onClick={last ? onFinish : onNext}>{last ? m.onboarding.gotIt : m.onboarding.coachNext}</Button>
        </div>
      </div>
    </div>
  );
}
