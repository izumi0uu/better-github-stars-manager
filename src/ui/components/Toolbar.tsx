import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Sun, Moon, Search, RefreshCw, ArrowUpNarrowWide, ArrowDownWideNarrow, X,
  Tags, Upload, Download, AlertTriangle, ExternalLink, Home, EyeOff, Star, RefreshCcw,
  Pencil,
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
import { Tooltip, TooltipTrigger, TooltipContent } from '@/ui/shadcn/tooltip';
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
}) {
  const { m } = useI18n();
  const [account, setAccount] = useState<Account | null>(null);
  const syncing = !!status?.inFlight && status.progress.phase !== 'idle';
  const phase = syncing ? status!.progress : null;
  const actionBusy = busy || syncing || pendingAction !== null;
  const progressValue = phase && phase.total ? Math.max(1, Math.min(100, Math.round((phase.done / phase.total) * 100))) : null;
  const progressCount = phase?.total ? `${phase.done}/${phase.total}` : null;
  const searchInput = useImeBufferedInput(f.query, f.setQuery);
  const layoutControlsDisabled = layoutEditing || !layoutConfigReady;
  const layoutEditDisabled = layoutEditing || !layoutEditReady;
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

  const seenTooltips = status?.seenTooltips ?? 0;

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

        <TButton onClick={() => onSync('syncIncremental', m.toolbar.syncButton)} disabled={actionBusy || layoutEditing} tip={m.toolbar.syncTitle} firstUseTip={m.onboarding.tooltipSyncFirst} bit={1} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch} data-coach-target="sync">
          <ActionIcon phase={successAction === 'syncIncremental' ? 'ok' : pendingAction === 'syncIncremental' ? 'busy' : 'idle'}>
            {successAction === 'syncIncremental' ? (
              <SuccessCheck data-icon="inline-start" />
            ) : pendingAction === 'syncIncremental' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw className="size-4" data-icon="inline-start" />
            )}
          </ActionIcon>
          {m.toolbar.syncButton}
          {pendingAction === 'syncIncremental' && progressCount && (
            <span className="gsm-inline-progress-count">{progressCount}</span>
          )}
        </TButton>

        <TButton onClick={() => onSync('syncFull', m.toolbar.fullSyncButton)} disabled={actionBusy || layoutEditing} tip={m.toolbar.fullSyncTitle} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch} data-coach-target="full-sync">
          <ActionIcon phase={successAction === 'syncFull' ? 'ok' : pendingAction === 'syncFull' ? 'busy' : 'idle'}>
            {successAction === 'syncFull' ? (
              <SuccessCheck data-icon="inline-start" />
            ) : pendingAction === 'syncFull' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCcw className="size-4" data-icon="inline-start" />
            )}
          </ActionIcon>
          {m.toolbar.fullSyncButton}
          {pendingAction === 'syncFull' && progressCount && (
            <span className="gsm-inline-progress-count">{progressCount}</span>
          )}
        </TButton>

        <TButton variant="ghost" size="sm" onClick={() => onAutoAssignTags()} disabled={actionBusy || layoutEditing} tip={m.toolbar.autoAssignTitle} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch} data-coach-target="auto-tags">
          <ActionIcon phase={successAction === 'autoAssignTags' ? 'ok' : pendingAction === 'autoAssignTags' ? 'busy' : 'idle'}>
            {successAction === 'autoAssignTags' ? (
              <SuccessCheck data-icon="inline-start" />
            ) : pendingAction === 'autoAssignTags' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Tags data-icon="inline-start" />
            )}
          </ActionIcon>
          {m.toolbar.autoAssignButton}
        </TButton>
        <TButton variant="ghost" size="sm" onClick={() => onSync('gistPush', m.toolbar.gistPushButton)} disabled={actionBusy || layoutEditing} tip={m.toolbar.gistPushTitle} firstUseTip={m.onboarding.tooltipPushFirst} bit={2} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch}>
          <ActionIcon phase={successAction === 'gistPush' ? 'ok' : pendingAction === 'gistPush' ? 'busy' : 'idle'}>
            {successAction === 'gistPush' ? (
              <SuccessCheck data-icon="inline-start" />
            ) : pendingAction === 'gistPush' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Upload data-icon="inline-start" />
            )}
          </ActionIcon>
          {m.toolbar.gistPushButton}
        </TButton>
        <TButton variant="ghost" size="sm" onClick={() => onSync('gistPull', m.toolbar.gistPullButton)} disabled={actionBusy || layoutEditing} tip={m.toolbar.gistPullTitle} firstUseTip={m.onboarding.tooltipPullFirst} bit={4} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch}>
          <ActionIcon phase={successAction === 'gistPull' ? 'ok' : pendingAction === 'gistPull' ? 'busy' : 'idle'}>
            {successAction === 'gistPull' ? (
              <SuccessCheck data-icon="inline-start" />
            ) : pendingAction === 'gistPull' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Download data-icon="inline-start" />
            )}
          </ActionIcon>
          {m.toolbar.gistPullButton}
        </TButton>

        <span className="flex-1" />

        {account?.username && account?.gistId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={`https://gist.github.com/${account.username}/${account.gistId}`}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  'inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  { 'pointer-events-none opacity-50': layoutEditing },
                )}
                {...getLockedAnchorProps(layoutEditing)}
              >
                <ExternalLink className="size-3.5 shrink-0" />
                <span className="max-w-[140px] truncate">gist/{account.gistId.slice(0, 8)}</span>
              </a>
            </TooltipTrigger>
            <TooltipContent>{m.toolbar.gistLinkTitle}</TooltipContent>
          </Tooltip>
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
          <span
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
          </span>
          {syncing && phase && (
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
          <div className={cn('relative ml-auto inline-flex shrink-0 items-center gap-2', { 'pointer-events-none opacity-[0.35]': layoutControlsDisabled })}>
            <span className="text-[11px]">{m.toolbar.viewLabel}</span>
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5 text-[11px]">
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
              <span className="mx-0.5 h-4 w-px bg-border" />
              <button
                type="button"
                disabled={layoutEditDisabled}
                onClick={onStartLayoutEdit}
                title={m.toolbar.editLayout}
                aria-label={m.toolbar.editLayout}
                className="gsm-touch-target grid h-6 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none"
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
          </div>
        </div>
        {syncing && progressValue != null && (
          <div className="flex items-center gap-2">
            <Progress value={progressValue} className="h-2 flex-1" />
            <span className="gsm-progress-count">{progressCount}</span>
          </div>
        )}
      </div>
      {layoutEditChrome}
    </div>
  );
}
