import { useEffect, useState, type ReactNode } from 'react';
import {
  Sun, Moon, Search, RefreshCw, ArrowUpNarrowWide, ArrowDownWideNarrow, X,
  Tags, Upload, Download, AlertTriangle, ExternalLink, Home, EyeOff, RefreshCcw,
  Pencil, ChevronDown, Check, Pause, ClipboardCheck, Loader2,
} from 'lucide-react';
import { REPO_URL } from '@/lib/links';
import brandMarkUrl from '@/assets/bgsm-brand-mark.svg?url';
import type { FilterState } from '@/ui/filter-store';
import type { SyncProgress } from '@/types';
import { presentGistAction, presentSyncProgress } from '@/ui/toolbar-presentation';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Progress } from '@/ui/shadcn/progress';
import { Spinner } from '@/ui/shadcn/spinner';
import { SuccessCheck } from '@/ui/shadcn/success-check';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { ManagerSurfaceTabs } from '@/ui/components/ManagerSurfaceTabs';
import { ManagerResourceLink, useManagerImage } from '@/ui/components/ManagerResource';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/ui/shadcn/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { useDelayedHoverIntent } from '@/ui/hooks/use-delayed-hover-intent';
import { getLockedAnchorProps } from '@/ui/interaction-lock';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { LAYOUT_PREVIEW_HOVER_DELAY_MS } from '@/ui/layout-edit-constants';
import type { ManagerSurface } from '@/ui/manager-surface';
export type ToolbarAgentStatusKind =
  | 'working'
  | 'analyzing'
  | 'applying'
  | 'review'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'blocked'
  | 'interrupted';


export type ToolbarStatus = Readonly<{
  hasToken: boolean;
  progressInFlight: boolean;
  seenTooltips: number;
  progress: SyncProgress;
}>;
const AGENT_STATUS_ICONS: Record<ToolbarAgentStatusKind, typeof Check> = {
  working: Loader2,
  analyzing: Loader2,
  applying: Loader2,
  review: ClipboardCheck,
  paused: Pause,
  completed: Check,
  cancelled: X,
  failed: AlertTriangle,
  blocked: AlertTriangle,
  interrupted: AlertTriangle,
};

function AgentStatusIcon({ kind }: { kind: ToolbarAgentStatusKind }) {
  const Icon = AGENT_STATUS_ICONS[kind];
  const spinning = kind === 'working' || kind === 'analyzing' || kind === 'applying';
  return (
    <Icon
      className={cn('size-3.5 shrink-0 text-muted-foreground', spinning && 'animate-spin')}
      aria-hidden="true"
    />
  );
}

/** Top toolbar for the stars page. */
type Account = {
  username: string | null;
  avatarUrl: string | null;
  displayName: string | null;
  gistId?: string | null;
  gistUrl?: string | null;
};

/**
 * Button+Tooltip wrapper; MUST be module-scope — defining it inside Toolbar
 * re-creates its identity every render, remounting buttons and replaying animations (double-flash).
 */
function TButton({
  tip,
  firstUseTip,
  bit,
  seenTooltips = 0,
  onTooltipSeen,
  children,
  ...btnProps
}: {
  tip: string;
  firstUseTip?: string;
  bit?: number;
  seenTooltips?: number;
  onTooltipSeen?: (bit: number) => void;
} & React.ComponentProps<typeof Button>) {
  const showFirst = firstUseTip !== undefined && bit !== undefined && !(seenTooltips & bit);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && showFirst && bit !== undefined) {
          onTooltipSeen?.(bit);
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
  account = null,
  f,
  status = null,
  loading,
  listPhase,
  total,
  grandTotal,
  busy = false,
  pendingAction = null,
  successAction = null,
  onSync,
  onAutoAssignTags,
  onOpenAgent,
  agentStatus,
  agentStatusKind,
  agentActive,
  agentIcon,
  onTooltipSeen,
  onToggleTheme,
  onTogglePanel,
  showGitHubHome = false,
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
  radarUnseenCount = 0,
}: {
  account?: Account | null;
  f: FilterState;
  status?: ToolbarStatus | null;
  loading: boolean;
  listPhase: 'idle' | 'fading-out' | 'fading-in';
  total: number;
  grandTotal: number;
  busy?: boolean;
  pendingAction?: string | null;
  successAction?: string | null;
  onSync?: (type: string, label: string) => void;
  onAutoAssignTags?: () => void;
  onOpenAgent?: () => void;
  agentStatus?: string | null;
  agentStatusKind?: ToolbarAgentStatusKind | null;
  agentActive?: boolean;
  agentIcon?: ReactNode;
  onTooltipSeen?: (bit: number) => void;
  onToggleTheme: () => void;
  onTogglePanel?: () => void;
  showGitHubHome?: boolean;
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
  surface?: ManagerSurface;
  onSurfaceChange?: (surface: ManagerSurface) => void;
  watchUnreadCount?: number;
  radarUnseenCount?: number;
}) {
  const accountAvatarUrl = useManagerImage({
    kind: 'actor-avatar',
    identity: account?.username ?? '',
    remoteUrl: account?.avatarUrl ?? null,
  });
  const { m } = useI18n();
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [gistMenuOpen, setGistMenuOpen] = useState(false);
  const starsSurface = surface === 'stars';
  const syncPresentation = presentSyncProgress(status?.progress ?? { phase: 'idle', done: 0, total: null, message: '' }, status?.progressInFlight ?? false);
  const syncing = syncPresentation.active;
  const phase = syncing && status ? status.progress : null;
  const actionBusy = busy || syncing || pendingAction !== null;
  const progressValue = syncPresentation.percent;
  const progressCount = syncPresentation.count;
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

  const gistPullPresentation = presentGistAction('pull', pendingAction, successAction);
  const gistPushPresentation = presentGistAction('push', pendingAction, successAction);
  const gistPhaseAction = gistPullPresentation.phase !== 'idle'
    ? gistPullPresentation.action
    : gistPushPresentation.phase !== 'idle'
      ? gistPushPresentation.action
      : null;
  const gistLabel = gistPushPresentation.phase === 'pending'
    ? m.toolbar.gistPushing
    : gistPullPresentation.phase === 'pending'
      ? m.toolbar.gistPulling
      : m.toolbar.gistButton;




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
    onSync?.(type, label);
  };
  const runGist = (type: 'gistPush' | 'gistPull', label: string) => {
    setGistMenuOpen(false);
    onSync?.(type, label);
  };

  return (
    <div className="border-b border-border bg-card" data-toolbar-root>
      <div className="flex min-h-[52px] w-full min-w-0 items-center gap-1 px-2 pl-2.5 min-[1281px]:gap-2 min-[1281px]:px-2.5 min-[1281px]:pl-3.5" data-toolbar-row>
        {/* Let search and sort shrink before the fixed right rail; the spacer absorbs surplus width. */}
        <div className="flex min-w-0 flex-[1_1_auto] items-center gap-1 min-[1281px]:gap-2" data-toolbar-left>
        <Tooltip>
          <TooltipTrigger asChild>
            <ManagerResourceLink
              resource={{ kind: 'subject', label: 'product-repository', remoteUrl: REPO_URL }}
              target="_blank"
              rel="noreferrer"
              aria-label={m.toolbar.starRepoTitle}
              title={m.toolbar.starRepoTitle}
              className={cn('group/product grid size-8 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring min-[1025px]:size-9', {
                'pointer-events-none opacity-50': layoutEditing,
                'max-[900px]:hidden': true,
              })}
              {...getLockedAnchorProps(layoutEditing)}
            >
              <span className="grid size-6 place-items-center transition-transform duration-150 ease-out group-hover/product:scale-105 group-active/product:scale-95 motion-reduce:transform-none motion-reduce:transition-none min-[1025px]:size-7">
                <img
                  src={brandMarkUrl}
                  alt=""
                  aria-hidden="true"
                  width={128}
                  height={128}
                  draggable={false}
                  data-product-brand-mark
                  className="size-full object-contain"
                />
              </span>
            </ManagerResourceLink>
          </TooltipTrigger>
          <TooltipContent>{m.toolbar.starRepoTitle}</TooltipContent>
        </Tooltip>

        {onSurfaceChange && (
          <ManagerSurfaceTabs
            surface={surface}
            watchUnreadCount={watchUnreadCount}
            radarUnseenCount={radarUnseenCount}
            disabled={layoutEditing}
            onSurfaceChange={onSurfaceChange}
          />
        )}

        {starsSurface && (
          <>
        <div className="relative min-w-[72px] max-w-[15rem] flex-[1_1_15rem]" data-toolbar-search>
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
          <SelectTrigger disabled={layoutEditing} className="h-9 w-[clamp(5rem,10vw,8.75rem)] shrink min-[641px]:min-w-[7.5rem]">
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
          className="h-9 w-9 shrink-0 max-[900px]:hidden"
          tip={m.toolbar.toggleSortDir}
          onTooltipSeen={onTooltipSeen}
          disabled={layoutEditing}
          onClick={() => f.setSort(f.sortKey, f.sortDir === 'asc' ? 'desc' : 'asc')}
        >
          <ActionIcon phase={f.sortDir}>
            {f.sortDir === 'asc' ? <ArrowUpNarrowWide className="size-4" /> : <ArrowDownWideNarrow className="size-4" />}
          </ActionIcon>
        </TButton>
        {onSync && <div className="inline-flex h-9 shrink-0 items-stretch overflow-hidden rounded-md max-[480px]:hidden">
          <TButton
            className="h-9 rounded-r-none border border-r-0 border-transparent hover:border-primary"
            onClick={() => runSync('syncIncremental', m.toolbar.syncButton)}
            disabled={actionBusy || layoutEditing}
            tip={m.toolbar.syncTitle}
            firstUseTip={m.onboarding.tooltipSyncFirst}
            bit={1}
            seenTooltips={seenTooltips}
            onTooltipSeen={onTooltipSeen}
            data-coach-target="sync"
          >
            <ActionPhaseIcon
              action="syncIncremental"
              pendingAction={pendingAction}
              successAction={successAction}
              idle={<RefreshCw className="size-4" data-icon="inline-start" />}
            />
            <span className="max-[1280px]:hidden" data-toolbar-action-label="sync">{m.toolbar.syncButton}</span>
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
                className={cn('h-9 w-7 rounded-l-none border border-primary hover:bg-primary hover:text-primary-foreground', { 'bg-muted text-foreground': syncMenuOpen })}
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
                <ActionPhaseIcon action="syncFull" pendingAction={pendingAction} successAction={successAction} idle={<RefreshCcw className="size-3.5 opacity-80" data-icon="inline-start" />} />
                {m.toolbar.fullSyncButton}
              </span>
              <span className="pl-5 text-[11px] font-normal leading-snug text-muted-foreground">{m.toolbar.fullSyncTitle}</span>
            </button>
          </ToolHoverBar>
        </div>}

        {/* Deterministic local Auto Tags — never nested with Agent. */}
        {onAutoAssignTags && <TButton
          variant="ghost"
          size="sm"
          className="h-9 shrink-0 max-[768px]:hidden"
          onClick={onAutoAssignTags}
          tip={m.toolbar.autoAssignTitle}
          seenTooltips={seenTooltips}
          onTooltipSeen={onTooltipSeen}
          data-coach-target="auto-tags"
        >
          <ActionPhaseIcon
            action="autoAssignTags"
            pendingAction={pendingAction}
            successAction={successAction}
            idle={<Tags data-icon="inline-start" />}
          />
          <span className="max-[1280px]:hidden" data-toolbar-action-label="auto-tags">{m.toolbar.autoAssignButton}</span>
        </TButton>}
          </>
        )}
        </div>

        {/* Flexible gutter preserves separation only while real free width exists. */}
        <div className="min-w-0 flex-1" aria-hidden="true" data-toolbar-spacer />

        {/* Right rail stays on the same row and never wraps internally. */}
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap min-[1281px]:gap-2" data-toolbar-right>


        {/* Optional AI workbench entry — post-spacer, independent of Auto Tags. */}
        {starsSurface && onOpenAgent && (
          <TButton
            tip={m.toolbar.agentButton}
            variant="outline"
            size="sm"
            className="h-9 shrink-0 max-[768px]:hidden"
            onClick={() => onOpenAgent()}
            onTooltipSeen={onTooltipSeen}
            aria-label={agentStatus ? `${m.toolbar.agentButton} · ${agentStatus}` : m.toolbar.agentButton}
            data-coach-target="agent"
            aria-busy={agentActive}
          >
            {agentIcon}
            {agentStatusKind ? <AgentStatusIcon kind={agentStatusKind} /> : null}
            <span className="max-w-36 truncate max-[1280px]:hidden" data-toolbar-action-label="agent">{m.toolbar.agentButton}</span>
          </TButton>
        )}

        {/* Gist hover bar: Push / Pull / Open. */}
        {starsSurface && onSync && (
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
              className={cn('h-9 shrink-0 gap-1.5 max-[640px]:hidden', { 'bg-muted/60': gistMenuOpen })}
              aria-expanded={gistMenuOpen}
              aria-label={m.toolbar.gistButton}
              title={m.toolbar.gistTitle}
            >
              {gistPhaseAction ? (
                <ActionPhaseIcon action={gistPhaseAction} pendingAction={pendingAction} successAction={successAction} idle={<Download className="size-4" data-icon="inline-start" />} />
              ) : <Download className="size-4" data-icon="inline-start" />}
              <span className="max-[1280px]:hidden" data-toolbar-action-label="gist">{gistLabel}</span>
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          )}
        >
          <div className="flex items-center gap-0.5">
            <button type="button" disabled={actionBusy || layoutEditing} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" title={m.toolbar.gistPushTitle} onClick={() => runGist('gistPush', m.toolbar.gistPushButton)}>
              <ActionPhaseIcon action="gistPush" pendingAction={pendingAction} successAction={successAction} idle={<Upload className="size-3.5 opacity-80" data-icon="inline-start" />} />
              {m.toolbar.gistPushButton}
            </button>
            <button type="button" disabled={actionBusy || layoutEditing} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" title={m.toolbar.gistPullTitle} onClick={() => runGist('gistPull', m.toolbar.gistPullButton)}>
              <ActionPhaseIcon action="gistPull" pendingAction={pendingAction} successAction={successAction} idle={<Download className="size-3.5 opacity-80" data-icon="inline-start" />} />
              {m.toolbar.gistPullButton}
            </button>
            {account?.gistId && account.gistUrl && <>
              <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
              <ManagerResourceLink resource={{ kind: 'subject', label: 'secret-gist', remoteUrl: account.gistUrl }} className="inline-flex h-8 max-w-[150px] items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" title={m.toolbar.gistLinkTitle} onClick={() => setGistMenuOpen(false)} {...getLockedAnchorProps(layoutEditing)}>
                <ExternalLink className="size-3.5 shrink-0" />
                <span className="truncate">gist/{account.gistId.slice(0, 8)}</span>
              </ManagerResourceLink>
            </>}
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

        {onTogglePanel && <Tooltip>
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
        </Tooltip>}

        {showGitHubHome && <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-9 w-9 max-[1024px]:hidden', { 'pointer-events-none opacity-50': layoutEditing })}
              asChild
            >
              <ManagerResourceLink resource={{ kind: 'subject', label: 'github-home', remoteUrl: 'https://github.com' }} title={m.toolbar.githubHomeTitle} {...getLockedAnchorProps(layoutEditing)}>
                <Home className="size-4" />
              </ManagerResourceLink>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.toolbar.githubHomeTitle}</TooltipContent>
        </Tooltip>}

        {account?.username && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="inline-grid size-8 shrink-0 place-items-center rounded-full border border-border bg-background min-[1025px]:flex min-[1025px]:h-8 min-[1025px]:w-auto min-[1025px]:gap-1.5 min-[1025px]:p-0.5" data-toolbar-account>
                {accountAvatarUrl ? (
                  <img
                    src={accountAvatarUrl}
                    alt=""
                    className="size-6 rounded-full object-cover ring-1 ring-border"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                  />
                ) : (
                  <span className="grid size-6 place-items-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-1 ring-border">
                    {account.username.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <span className="hidden max-w-[100px] truncate pr-2 text-xs font-medium min-[1025px]:inline">@{account.username}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{m.toolbar.accountTitle(account.username)}</TooltipContent>
          </Tooltip>
        )}
        </div>
      </div>

      {starsSurface && (
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
          {status && !status.hasToken && (
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
      )}
      {starsSurface && (
        <>
          {layoutEditChrome}
        </>
      )}
    </div>
  );
}
