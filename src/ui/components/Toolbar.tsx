import { useEffect, useRef, useState } from 'react';
import {
  Sun, Moon, Search, RefreshCw, ArrowUpNarrowWide, ArrowDownWideNarrow,
  Tags, Upload, Download, AlertTriangle, ExternalLink,
} from 'lucide-react';
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
import { useI18n } from '@/i18n';

/** Top toolbar for the stars page. */
type Account = { username: string | null; avatarUrl: string | null; displayName: string | null; gistId: string | null };

/**
 * A Button wrapped in a Tooltip. MUST live at module scope — not inside Toolbar.
 *
 * When this component lived inside Toolbar, every Toolbar render created a new
 * component identity, so the action buttons remounted and replayed their intro
 * animation. Keeping it at module scope preserves identity and avoids that
 * double-flash regression.
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
  theme,
  searchRef,
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
  theme: 'dark' | 'light';
  searchRef: React.RefObject<HTMLInputElement>;
}) {
  const { m } = useI18n();
  const [account, setAccount] = useState<Account | null>(null);
  const syncing = status?.progress && status.progress.phase !== 'idle';
  const phase = syncing ? status!.progress : null;
  const actionBusy = busy || syncing || pendingAction !== null;
  const progressValue = phase && phase.total ? Math.max(1, Math.min(100, Math.round((phase.done / phase.total) * 100))) : null;
  const progressCount = phase?.total ? `${phase.done}/${phase.total}` : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const acc = await bgCall<Account>('getAccount').catch(() => null);
      if (cancelled || !acc) return;
      setAccount(acc);
      if (!acc.avatarUrl && acc.username) {
        const backfilled = await bgCall<Account>('fetchAccount').catch(() => null);
        if (!cancelled && backfilled) setAccount(backfilled);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const prevPending = useRef<string | null>(null);
  useEffect(() => {
    if (prevPending.current === 'gistPush' && pendingAction === null) {
      bgCall<Account>('getAccount').then((acc) => setAccount(acc)).catch(() => {});
    }
    prevPending.current = pendingAction;
  }, [pendingAction]);

  const seenTooltips = status?.seenTooltips ?? 0;

  return (
    <div className="border-b border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            placeholder={m.toolbar.searchPlaceholder}
            value={f.query}
            onChange={(e) => f.setQuery(e.target.value)}
            className="h-9 pl-8"
          />
        </div>

        <Select value={f.sortKey} onValueChange={(value) => f.setSort(value as typeof f.sortKey)}>
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder={m.toolbar.sortName} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="starred_at">{m.toolbar.sortStarredAt}</SelectItem>
            <SelectItem value="pushed_at">{m.toolbar.sortPushedAt}</SelectItem>
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
          onClick={() => f.setSort(f.sortKey, f.sortDir === 'asc' ? 'desc' : 'asc')}
        >
          <ActionIcon phase={f.sortDir}>
            {f.sortDir === 'asc' ? <ArrowUpNarrowWide className="size-4" /> : <ArrowDownWideNarrow className="size-4" />}
          </ActionIcon>
        </TButton>

        <TButton onClick={() => onSync('syncIncremental', m.toolbar.syncButton)} disabled={actionBusy} tip={m.toolbar.syncTitle} firstUseTip={m.onboarding.tooltipSyncFirst} bit={1} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch} data-coach-target="sync">
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
            <span className="ml-1 tabular-nums text-[10px] opacity-80">{progressCount}</span>
          )}
        </TButton>

        <TButton variant="ghost" size="sm" onClick={() => onAutoAssignTags()} disabled={actionBusy} tip={m.toolbar.autoAssignTitle} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch}>
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
        <TButton variant="ghost" size="sm" onClick={() => onSync('gistPush', m.toolbar.gistPushButton)} disabled={actionBusy} tip={m.toolbar.gistPushTitle} firstUseTip={m.onboarding.tooltipPushFirst} bit={2} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch}>
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
        <TButton variant="ghost" size="sm" onClick={() => onSync('gistPull', m.toolbar.gistPullButton)} disabled={actionBusy} tip={m.toolbar.gistPullTitle} firstUseTip={m.onboarding.tooltipPullFirst} bit={4} seenTooltips={seenTooltips} onStatusPatch={onStatusPatch}>
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
                className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
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
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={onToggleTheme}>
              <ActionIcon phase={theme}>
                {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </ActionIcon>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.toolbar.themeTitle}</TooltipContent>
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
        <div className="flex items-center gap-4">
          <span
            className="tabular-nums"
            style={{
              opacity: listPhase === 'fading-out' ? 0 : 1,
              transition: `opacity ${listPhase === 'fading-out' ? 120 : 160}ms cubic-bezier(0.4, 0, 0.2, 1)`,
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
        </div>
        {syncing && progressValue != null && (
          <div className="flex items-center gap-2">
            <Progress value={progressValue} className="h-2 flex-1" />
            <span className="min-w-[48px] text-right tabular-nums text-foreground">{progressCount}</span>
          </div>
        )}
      </div>
    </div>
  );
}
