import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Sun, Moon, Search, RefreshCw, ArrowUpNarrowWide, ArrowDownWideNarrow, X,
  Tags, Upload, Download, AlertTriangle, ExternalLink, Home, EyeOff, Star, RefreshCcw,
  Pencil, ChevronDown,
} from 'lucide-react';
import { CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import { REPO_URL } from '@/lib/links';
import type { FilterState } from '@/ui/filter-store';
import type { SyncStatus } from '@/utils/messaging';
import { bgCall } from '@/utils/messaging';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Progress } from '@/ui/shadcn/progress';
import { Spinner } from '@/ui/shadcn/spinner';
import { SuccessCheck } from '@/ui/shadcn/success-check';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { AgentMascotIcon } from '@/ui/components/AgentMascot';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/ui/shadcn/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { useDelayedHoverIntent } from '@/ui/hooks/use-delayed-hover-intent';
import { getLockedAnchorProps } from '@/ui/interaction-lock';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { LAYOUT_PREVIEW_HOVER_DELAY_MS } from '@/ui/layout-edit-constants';

/** Top toolbar for the stars page. */
type Account = { username: string | null; avatarUrl: string | null; displayName: string | null; gistId: string | null };

/**
 * Button+Tooltip wrapper; MUST be module-scope — defining it inside Toolbar
 * re-creates its identity every render, remounting buttons and replaying animations (double-flash).
 */
function TButton({
  tip,
  firstUseTip,
  bit,
  seenTooltips,
  onStatusPatch,
  children,
  ...btnProps
}: {
  tip: string;
  firstUseTip?: string;
  bit?: number;
  seenTooltips: number;
  onStatusPatch?: (patch: Partial<SyncStatus>) => void;
} & React.ComponentProps<typeof Button>) {
  const showFirst = firstUseTip !== undefined && bit !== undefined && !(seenTooltips & bit);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && showFirst && bit !== undefined) {
          onStatusPatch?.({ seenTooltips: seenTooltips | bit });
          bgCall<{ seenTooltips: number }>('markTooltipSeen', { bit })
            .then((data) => onStatusPatch?.({ seenTooltips: data.seenTooltips }))
            .catch(() => {});
        }
      }}
    >
      <TooltipTrigger asChild>
        <Button {...btnProps}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{showFirst ? firstUseTip : tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Compact hover/click toolstrip popover for low-frequency toolbar actions.
 * Module-scope so open state does not remount sibling toolbar controls.
 *
 * Hover bridge: openDelay + closeDelay + invisible top pad on content so the
 * pointer can cross the Radix portal gap without the menu snapping shut.
 */
function ToolHoverBar({
  open,
  onOpenChange,
  disabled,
  align = 'end',
  trigger,
  children,
  contentClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  trigger: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) {
  const hoverIntent = useDelayedHoverIntent({
    enabled: !disabled,
    delayMs: 80,
    closeDelayMs: 180,
    onOpen: () => onOpenChange(true),
    onClose: () => onOpenChange(false),
  });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <span
          className={cn('inline-flex', { 'pointer-events-none opacity-50': disabled })}
          onMouseEnter={hoverIntent.onMouseEnter}
          onMouseLeave={hoverIntent.onMouseLeave}
          onFocus={hoverIntent.onFocus}
          onBlur={hoverIntent.onBlur}
        >
          {trigger}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          // Invisible bridge above content closes the classic hover gap.
          'relative w-auto min-w-0 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md',
          'before:absolute before:-top-2 before:right-0 before:left-0 before:h-2 before:content-[\'\']',
          contentClassName,
        )}
        onMouseEnter={hoverIntent.onMouseEnter}
        onMouseLeave={hoverIntent.onMouseLeave}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function ActionPhaseIcon({
  action,
  pendingAction,
  successAction,
  idle,
}: {
  action: string;
  pendingAction: string | null;
  successAction: string | null;
  idle: ReactNode;
}) {
  const phase = successAction === action ? 'ok' : pendingAction === action ? 'busy' : 'idle';
  return (
    <ActionIcon phase={phase}>
      {phase === 'ok' ? (
        <SuccessCheck data-icon="inline-start" />
      ) : phase === 'busy' ? (
        <Spinner data-icon="inline-start" />
      ) : (
        idle
      )}
    </ActionIcon>
  );
}

export function Toolbar({
  f,
  status,
  loading,
  listPhase,
  total,
  grandTotal,
  busy,
  pendingAction,
  successAction,
  onSync,
  onAutoAssignTags,
  onOpenAgent,
  agentStatus,
  agentActive,
  onStatusPatch,
  onToggleTheme,
  onTogglePanel,
  theme,
  searchRef,
  layoutMode,
  layoutEditing,
  layoutConfigReady,
  layoutEditReady,
  customLayoutDirty,
  customPreviewing,
  hiddenColumnCount,
  onLayoutModeChange,
  onStartLayoutEdit,
  onPreviewCustomChange,
  layoutEditChrome,
  surface = 'stars',
  onSurfaceChange,
  watchUnreadCount = 0,
}: {
  f: FilterState;
  status: SyncStatus | null;
  loading: boolean;
  listPhase: 'idle' | 'fading-out' | 'fading-in';
  total: number;
  grandTotal: number;
  busy: boolean;
  pendingAction: string | null;
  successAction: string | null;
  onSync: (type: string, label: string) => void;
  onAutoAssignTags: () => void;
  onOpenAgent?: () => void;
  agentStatus?: string | null;
  agentActive?: boolean;
  onStatusPatch?: (patch: Partial<SyncStatus>) => void;
  onToggleTheme: () => void;
  /** Retract the panel overlay → native stars list (+ floating re-mount button). */
  onTogglePanel?: () => void;
  theme: 'dark' | 'light';
  searchRef: React.MutableRefObject<HTMLInputElement | null>;
  layoutMode: 'default' | 'custom';
  layoutEditing: boolean;
  layoutConfigReady: boolean;
  layoutEditReady: boolean;
  customLayoutDirty: boolean;
  customPreviewing: boolean;
  hiddenColumnCount: number;
  onLayoutModeChange: (mode: 'default' | 'custom') => void;
  onStartLayoutEdit: () => void;
  onPreviewCustomChange: (previewing: boolean) => void;
  layoutEditChrome?: ReactNode;
  surface?: 'stars' | 'watch';
  onSurfaceChange?: (surface: 'stars' | 'watch') => void;
  watchUnreadCount?: number;
}) {
  const { m } = useI18n();
  const [account, setAccount] = useState<Account | null>(null);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [gistMenuOpen, setGistMenuOpen] = useState(false);
  const starsSurface = surface === 'stars';
  const syncing = !!status?.inFlight && status.progress.phase !== 'idle';
  const phase = syncing ? status!.progress : null;
  const actionBusy = busy || syncing || pendingAction !== null;
  const progressValue = phase && phase.total ? Math.max(1, Math.min(100, Math.round((phase.done / phase.total) * 100))) : null;
  const progressCount = phase?.total ? `${phase.done}/${phase.total}` : null;
  const searchInput = useImeBufferedInput(f.query, f.setQuery);
  const layoutControlsDisabled = layoutEditing || !layoutConfigReady;
  const layoutEditDisabled = !layoutEditReady;
  const customPreviewIntent = useDelayedHoverIntent({
    enabled: layoutMode === 'default' && !layoutControlsDisabled && customLayoutDirty,
    delayMs: LAYOUT_PREVIEW_HOVER_DELAY_MS,
    onOpen: () => onPreviewCustomChange(true),
    onClose: () => onPreviewCustomChange(false),
  });
  const segmentItemClass = (active: boolean) => cn(
    'gsm-touch-target relative inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground transition-[background-color,color,box-shadow] duration-150 hover:text-foreground',
    { 'bg-background text-foreground shadow-sm': active },
  );

  const gistBusy = pendingAction === 'gistPush' || pendingAction === 'gistPull'
    || successAction === 'gistPush' || successAction === 'gistPull';
  const gistPhaseAction = pendingAction === 'gistPull' || successAction === 'gistPull'
    ? 'gistPull'
    : pendingAction === 'gistPush' || successAction === 'gistPush'
      ? 'gistPush'
      : null;
  const gistLabel = pendingAction === 'gistPush'
    ? m.toolbar.gistPushing
    : pendingAction === 'gistPull'
      ? m.toolbar.gistPulling
      : m.toolbar.gistButton;

  useEffect(() => {
    let cancelled = false;
    const refreshAccount = async () => {
      const acc = await bgCall<Account>('getAccount').catch(() => null);
      if (cancelled || !acc) return null;
      setAccount(acc);
      return acc;
    };

    (async () => {
      const acc = await refreshAccount();
      if (acc && !acc.avatarUrl && acc.username) {
        const backfilled = await bgCall<Account>('fetchAccount').catch(() => null);
        if (!cancelled && backfilled) setAccount(backfilled);
      }
    })();

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !changes[CONFIG_STORAGE_KEY]) return;
      const oldCfg = changes[CONFIG_STORAGE_KEY].oldValue as Account | undefined;
      const newCfg = changes[CONFIG_STORAGE_KEY].newValue as Account | undefined;
      if (
        oldCfg?.username === newCfg?.username &&
        oldCfg?.avatarUrl === newCfg?.avatarUrl &&
        oldCfg?.displayName === newCfg?.displayName &&
        oldCfg?.gistId === newCfg?.gistId
      ) return;
      void refreshAccount();
    };

    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const prevPending = useRef<string | null>(null);
  useEffect(() => {
    if ((prevPending.current === 'gistPush' || prevPending.current === 'gistPull') && pendingAction === null) {
      bgCall<Account>('getAccount').then((acc) => setAccount(acc)).catch(() => {});
    }
    prevPending.current = pendingAction;
  }, [pendingAction]);

  useEffect(() => {
    if (layoutEditing) {
      setSyncMenuOpen(false);
      setGistMenuOpen(false);
    }
  }, [layoutEditing]);

  useEffect(() => {
    if (starsSurface) return;
    setSyncMenuOpen(false);
    setGistMenuOpen(false);
    customPreviewIntent.clear();
  }, [customPreviewIntent.clear, starsSurface]);

  const seenTooltips = status?.seenTooltips ?? 0;

  const runSync = (type: string, label: string) => {
    setSyncMenuOpen(false);
    onSync(type, label);
  };
  const runGist = (type: 'gistPush' | 'gistPull', label: string) => {
    setGistMenuOpen(false);
    onSync(type, label);
  };

  return (
    <div className="border-b border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {/* Star the project — links to the repo (leftmost, top-left of the
            panel). Opens in a new tab so the manager panel stays mounted. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-9 gap-1 px-2', { 'pointer-events-none opacity-50': layoutEditing })}
              asChild
            >
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                title={m.toolbar.starRepoTitle}
                {...getLockedAnchorProps(layoutEditing)}
              >
                <Star className="size-4" data-icon="inline-start" />
                <span className="text-xs">Star</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.toolbar.starRepoTitle}</TooltipContent>
        </Tooltip>

        {onSurfaceChange && <div
          className="inline-flex h-8 items-center rounded-md border border-border bg-muted p-0.5 text-xs"
          role="group"
          aria-label={m.watch.title}
        >
          <button
            type="button"
            aria-pressed={starsSurface}
            disabled={layoutEditing}
            onClick={() => onSurfaceChange('stars')}
            className={cn('h-7 rounded px-2.5 font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
              'bg-background text-foreground shadow-sm': starsSurface,
            })}
          >
            {m.watch.starsSurface}
          </button>
          <button
            type="button"
            aria-pressed={!starsSurface}
            aria-label={watchUnreadCount > 0
              ? m.watch.watchSurfaceUnread(watchUnreadCount)
              : m.watch.watchSurface}
            disabled={layoutEditing}
            onClick={() => onSurfaceChange('watch')}
            className={cn('inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
              'bg-background text-foreground shadow-sm': !starsSurface,
            })}
          >
            {m.watch.watchSurface}
            {watchUnreadCount > 0 && (
              <span className="min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground tabular-nums">
                {watchUnreadCount > 99 ? '99+' : watchUnreadCount}
              </span>
            )}
          </button>
        </div>}

        {starsSurface && (
          <>
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            {...searchInput.inputProps}
            placeholder={m.toolbar.searchPlaceholder}
            disabled={layoutEditing}
            className="h-9 pl-8 pr-8"
          />
          {searchInput.value && (
            <button
              type="button"
              disabled={layoutEditing}
              title={m.toolbar.searchClearTitle}
              aria-label={m.toolbar.searchClearTitle}
              onClick={() => {
                if (layoutEditing) return;
                searchInput.commit('');
                searchRef.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <Select value={f.sortKey} disabled={layoutEditing} onValueChange={(value) => {
          if (layoutEditing) return;
          f.setSort(value as typeof f.sortKey);
        }}>
          <SelectTrigger disabled={layoutEditing} className="h-9 w-[170px]">
            <SelectValue placeholder={m.toolbar.sortName} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="starred_at">{m.toolbar.sortStarredAt}</SelectItem>
            <SelectItem value="pushed_at">{m.toolbar.sortPushedAt}</SelectItem>
            <SelectItem value="created_at">{m.toolbar.sortCreatedAt}</SelectItem>
            <SelectItem value="stargazers_count">{m.toolbar.sortStars}</SelectItem>
            <SelectItem value="name">{m.toolbar.sortName}</SelectItem>
          </SelectContent>
        </Select>
        <TButton
          variant="outline"
          size="icon"
          className="h-9 w-9"
          tip={m.toolbar.toggleSortDir}
          seenTooltips={seenTooltips}
          onStatusPatch={onStatusPatch}
          disabled={layoutEditing}
          onClick={() => f.setSort(f.sortKey, f.sortDir === 'asc' ? 'desc' : 'asc')}
        >
          <ActionIcon phase={f.sortDir}>
            {f.sortDir === 'asc' ? <ArrowUpNarrowWide className="size-4" /> : <ArrowDownWideNarrow className="size-4" />}
          </ActionIcon>
        </TButton>

        {/* Sync primary (default style) + Full Sync under caret; menu right-aligns to the split. */}
        <div className="inline-flex h-9 items-stretch overflow-hidden rounded-md">
          <TButton
            className="h-9 rounded-r-none border border-r-0 border-transparent hover:border-primary"
            onClick={() => runSync('syncIncremental', m.toolbar.syncButton)}
            disabled={actionBusy || layoutEditing}
            tip={m.toolbar.syncTitle}
            firstUseTip={m.onboarding.tooltipSyncFirst}
            bit={1}
            seenTooltips={seenTooltips}
            onStatusPatch={onStatusPatch}
            data-coach-target="sync"
          >
            <ActionPhaseIcon
              action="syncIncremental"
              pendingAction={pendingAction}
              successAction={successAction}
              idle={<RefreshCw className="size-4" data-icon="inline-start" />}
            />
            {m.toolbar.syncButton}
            {pendingAction === 'syncIncremental' && progressCount && (
              <span className="gsm-inline-progress-count">{progressCount}</span>
            )}
          </TButton>
          <ToolHoverBar
            open={syncMenuOpen}
            onOpenChange={setSyncMenuOpen}
            disabled={actionBusy || layoutEditing}
            align="end"
            contentClassName="w-[196px]"
            trigger={(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'h-9 w-7 rounded-l-none border border-primary hover:bg-primary hover:text-primary-foreground',
                  { 'bg-muted text-foreground': syncMenuOpen },
                )}
                disabled={actionBusy || layoutEditing}
                aria-label={m.toolbar.fullSyncButton}
                aria-expanded={syncMenuOpen}
                title={m.toolbar.fullSyncTitle}
                data-coach-target="full-sync"
              >
                <ActionPhaseIcon
                  action="syncFull"
                  pendingAction={pendingAction}
                  successAction={successAction}
                  idle={<ChevronDown className="size-3.5 opacity-70" />}
                />
              </Button>
            )}
          >
            <button
              type="button"
              disabled={actionBusy || layoutEditing}
              className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              onClick={() => runSync('syncFull', m.toolbar.fullSyncButton)}
            >
              <span className="inline-flex items-center gap-1.5 text-[13px] font-medium leading-none text-foreground">
                <ActionPhaseIcon
                  action="syncFull"
                  pendingAction={pendingAction}
                  successAction={successAction}
                  idle={<RefreshCcw className="size-3.5 opacity-80" data-icon="inline-start" />}
                />
                {m.toolbar.fullSyncButton}
              </span>
              <span className="pl-5 text-[11px] font-normal leading-snug text-muted-foreground">
                {m.toolbar.fullSyncTitle}
              </span>
            </button>
          </ToolHoverBar>
        </div>

        {/* Deterministic local Auto Tags — never nested with Agent. */}
        <TButton
          variant="ghost"
          size="sm"
          className="h-9"
          onClick={() => onAutoAssignTags()}
          disabled={actionBusy || layoutEditing}
          tip={m.toolbar.autoAssignTitle}
          seenTooltips={seenTooltips}
          onStatusPatch={onStatusPatch}
          data-coach-target="auto-tags"
        >
          <ActionPhaseIcon
            action="autoAssignTags"
            pendingAction={pendingAction}
            successAction={successAction}
            idle={<Tags data-icon="inline-start" />}
          />
          {m.toolbar.autoAssignButton}
        </TButton>
          </>
        )}

        <span className="flex-1" />

        {/* Optional AI workbench entry — post-spacer, independent of Auto Tags. */}
        {starsSurface && onOpenAgent && (
          <TButton
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onOpenAgent()}
            disabled={layoutEditing}
            tip={m.toolbar.agentTitle}
            seenTooltips={seenTooltips}
            onStatusPatch={onStatusPatch}
            data-coach-target="agent"
            aria-label={m.toolbar.agentButton}
            aria-busy={agentActive}
          >
            <AgentMascotIcon running={agentActive} />
            <span className="max-w-36 truncate">
              {agentStatus ? `${m.toolbar.agentButton} · ${agentStatus}` : m.toolbar.agentButton}
            </span>
          </TButton>
        )}

        {/* Gist hover bar: Push / Pull / Open. */}
        {starsSurface && (
        <ToolHoverBar
          open={gistMenuOpen}
          onOpenChange={setGistMenuOpen}
          disabled={actionBusy || layoutEditing}
          align="end"
          trigger={(
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn('h-9 gap-1.5', { 'bg-muted/60': gistMenuOpen })}
              disabled={actionBusy || layoutEditing}
              aria-expanded={gistMenuOpen}
              aria-label={m.toolbar.gistButton}
              title={m.toolbar.gistTitle}
            >
              {gistPhaseAction ? (
                <ActionPhaseIcon
                  action={gistPhaseAction}
                  pendingAction={pendingAction}
                  successAction={successAction}
                  idle={<Download className="size-4" data-icon="inline-start" />}
                />
              ) : (
                <Download className="size-4" data-icon="inline-start" />
              )}
              <span className={cn({ 'max-sm:hidden': !gistBusy })}>{gistLabel}</span>
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          )}
        >
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={actionBusy || layoutEditing}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              title={m.toolbar.gistPushTitle}
              onClick={() => runGist('gistPush', m.toolbar.gistPushButton)}
            >
              <ActionPhaseIcon
                action="gistPush"
                pendingAction={pendingAction}
                successAction={successAction}
                idle={<Upload className="size-3.5 opacity-80" data-icon="inline-start" />}
              />
              {m.toolbar.gistPushButton}
            </button>
            <button
              type="button"
              disabled={actionBusy || layoutEditing}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              title={m.toolbar.gistPullTitle}
              onClick={() => runGist('gistPull', m.toolbar.gistPullButton)}
            >
              <ActionPhaseIcon
                action="gistPull"
                pendingAction={pendingAction}
                successAction={successAction}
                idle={<Download className="size-3.5 opacity-80" data-icon="inline-start" />}
              />
              {m.toolbar.gistPullButton}
            </button>
            {account?.username && account?.gistId && (
              <>
                <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
                <a
                  href={`https://gist.github.com/${account.username}/${account.gistId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 max-w-[150px] items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={m.toolbar.gistLinkTitle}
                  onClick={() => setGistMenuOpen(false)}
                  {...getLockedAnchorProps(layoutEditing)}
                >
                  <ExternalLink className="size-3.5 shrink-0" />
                  <span className="truncate">gist/{account.gistId.slice(0, 8)}</span>
                </a>
              </>
            )}
          </div>
        </ToolHoverBar>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9" disabled={layoutEditing} onClick={onToggleTheme}>
              <ActionIcon phase={theme}>
                {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </ActionIcon>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.toolbar.themeTitle}</TooltipContent>
        </Tooltip>

        {/* Retract the panel overlay → native stars list (the floating
            "show panel" button then appears so it can be re-mounted). */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              disabled={layoutEditing}
              onClick={() => onTogglePanel?.()}
              data-coach-target="hide-panel"
            >
              <EyeOff className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.toolbar.hidePanelTitle}</TooltipContent>
        </Tooltip>

        {/* GitHub home — same-tab jump back to github.com from the stars page. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-9 w-9', { 'pointer-events-none opacity-50': layoutEditing })}
              asChild
            >
              <a href="https://github.com" title={m.toolbar.githubHomeTitle} {...getLockedAnchorProps(layoutEditing)}>
                <Home className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.toolbar.githubHomeTitle}</TooltipContent>
        </Tooltip>

        {account?.username && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background py-0.5 pl-0.5 pr-2.5">
                {account.avatarUrl ? (
                  <img
                    src={account.avatarUrl}
                    alt=""
                    className="size-6 rounded-full object-cover ring-1 ring-border"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                  />
                ) : (
                  <span className="grid size-6 place-items-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-1 ring-border">
                    {account.username.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <span className="max-w-[100px] truncate text-xs font-medium">@{account.username}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{m.toolbar.accountTitle(account.username)}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-border/50 px-3 py-1 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-4">
          {starsSurface && <span
            className="tabular-nums"
            style={{
              opacity: listPhase === 'fading-out' ? 0 : 1,
              transition: `opacity ${listPhase === 'fading-out' ? 'var(--gsm-duration-fast)' : 'var(--gsm-duration-table)'} var(--gsm-ease-standard)`,
            }}
          >
            {loading && grandTotal === 0 ? (
              <span className="inline-flex items-center gap-2">
                <Spinner className="size-3" />
                {m.common.loading}
              </span>
            ) : (
              m.toolbar.shownTotal(total, grandTotal)
            )}
          </span>}
          {starsSurface && syncing && phase && (
            <span className="inline-flex items-center gap-2 text-primary">
              <Spinner className="size-3" />
              {m.common.phase(phase.phase)}: {phase.message}
              {phase.total != null && phase.total > 0 && ` (${phase.done}/${phase.total})`}
            </span>
          )}
          {!status?.hasToken && (
            <span className="inline-flex items-center gap-1 text-warning">
              <AlertTriangle className="size-3.5" />
              {m.toolbar.noToken}
            </span>
          )}
          <span className="flex-1" />
          {starsSurface && <div className="relative ml-auto inline-flex shrink-0 items-center gap-2">
            <span className="text-[11px]">{m.toolbar.viewLabel}</span>
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5 text-[11px]">
              <div className={cn('inline-flex items-center gap-0.5', { 'pointer-events-none opacity-[0.35]': layoutControlsDisabled })}>
                <button
                  type="button"
                  disabled={layoutControlsDisabled}
                  aria-pressed={layoutMode === 'default' && !customPreviewing}
                  onClick={() => onLayoutModeChange('default')}
                  className={segmentItemClass(layoutMode === 'default' && !customPreviewing)}
                >
                  {layoutMode === 'default' && !customPreviewing && (
                    <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
                  )}
                  {m.toolbar.defaultLayout}
                </button>
                <button
                  type="button"
                  disabled={layoutControlsDisabled}
                  aria-pressed={layoutMode === 'custom' || customPreviewing}
                  title={customLayoutDirty ? m.toolbar.customLayoutChanged : undefined}
                  onMouseEnter={customPreviewIntent.onMouseEnter}
                  onMouseLeave={customPreviewIntent.onMouseLeave}
                  onFocus={customPreviewIntent.onFocus}
                  onBlur={customPreviewIntent.onBlur}
                  onClick={() => {
                    customPreviewIntent.clear();
                    onLayoutModeChange('custom');
                  }}
                  className={cn(
                    segmentItemClass(layoutMode === 'custom' || customPreviewing),
                    { 'gsm-seg-previewing': customPreviewing },
                  )}
                >
                  {(layoutMode === 'custom' || customPreviewing) && (
                    <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
                  )}
                  {m.toolbar.customLayout}
                </button>
              </div>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <button
                type="button"
                data-layout-edit-trigger=""
                disabled={layoutEditDisabled}
                onClick={onStartLayoutEdit}
                title={layoutEditing ? m.common.cancel : m.toolbar.editLayout}
                aria-label={layoutEditing ? m.common.cancel : m.toolbar.editLayout}
                aria-pressed={layoutEditing}
                className={cn(
                  'gsm-touch-target grid h-6 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none',
                  { 'bg-background text-foreground shadow-sm': layoutEditing },
                )}
              >
                <Pencil className="size-3.5" />
              </button>
            </div>
            {hiddenColumnCount > 0 && (
              <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {hiddenColumnCount}
              </span>
            )}
            {customPreviewing && (
              <span className="gsm-z-preview absolute right-0 top-8 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md">
                {m.toolbar.previewCustomLayout}
              </span>
            )}
          </div>}
        </div>
        {starsSurface && syncing && progressValue != null && (
          <div className="flex items-center gap-2">
            <Progress value={progressValue} className="h-2 flex-1" />
            <span className="gsm-progress-count">{progressCount}</span>
          </div>
        )}
      </div>
      {starsSurface && (
        <>
          {layoutEditChrome}
        </>
      )}
    </div>
  );
}
