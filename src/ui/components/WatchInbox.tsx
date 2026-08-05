import {
  AlertTriangle,
  Bell,
  BookOpen,
  ChevronDown,
  CircleDot,
  Clock3,
  Eye,
  GitCommitHorizontal,
  GitPullRequest,
  Inbox,
  ListFilter,
  MessageCircle,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Tag,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Input } from '@/ui/shadcn/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Spinner } from '@/ui/shadcn/spinner';
import {
  countWatchReasons,
  filterWatchInboxProjection,
  formatWatchRelativeTime,
  watchReasonPresetValues,
  type WatchReasonCount,
  type WatchReasonPreset,
} from '@/ui/watch-inbox-presentation';
import {
  notificationSubjectTypeLabel,
  type GitHubNotificationThread,
} from '@/watch/watch-model';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';

interface WatchInboxProps {
  result: WatchInboxQueryResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: 'query' | 'refresh' | null;
  unreadOnly: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onRefresh: () => void;
  onRetryQuery: () => void;
  onOpenOptions: () => void;
  onSelectRepository?: (fullName: string) => void;
}

const REASON_PRESETS: readonly WatchReasonPreset[] = [
  'direct',
  'security',
  'participation',
  'watching',
  'other',
];

function normalizedReason(reason: string): string {
  return reason.trim().toLowerCase();
}

function sameReasonSelection(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right.map(normalizedReason));
  return left.every((reason) => rightSet.has(normalizedReason(reason)));
}

function handleThreadListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const target = event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>('a[data-watch-thread]')
    : null;
  if (!target || !event.currentTarget.contains(target)) return;

  // Collapsed groups do not render anchors, so this list is also the visible
  // navigation order and remains scoped to this Watch surface.
  const links = Array.from(
    event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-watch-thread]'),
  );
  const currentIndex = links.indexOf(target);
  if (currentIndex < 0 || links.length === 0) return;

  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? links.length - 1
      : event.key === 'ArrowUp'
        ? Math.max(0, currentIndex - 1)
        : Math.min(links.length - 1, currentIndex + 1);
  event.preventDefault();
  links[nextIndex]?.focus();
}

function ReasonFilterPopover({
  reasonCounts,
  selectedReasons,
  onSelectedReasonsChange,
}: {
  reasonCounts: readonly WatchReasonCount[];
  selectedReasons: readonly string[];
  onSelectedReasonsChange: (reasons: string[]) => void;
}) {
  const { m } = useI18n();
  const selectedKeys = useMemo(
    () => new Set(selectedReasons.map(normalizedReason)),
    [selectedReasons],
  );
  const reasonRows = useMemo(() => {
    const rows = new Map(
      reasonCounts.map((item) => [normalizedReason(item.reason), item] as const),
    );
    for (const reason of selectedReasons) {
      const key = normalizedReason(reason);
      if (key && !rows.has(key)) rows.set(key, { reason, count: 0 });
    }
    return Array.from(rows.values()).sort((left, right) => (
      left.reason.localeCompare(right.reason)
    ));
  }, [reasonCounts, selectedReasons]);
  const availableReasons = reasonCounts.map((item) => item.reason);
  const presetLabels: Record<WatchReasonPreset, string> = {
    direct: m.watch.reasonPresetDirect,
    security: m.watch.reasonPresetSecurity,
    participation: m.watch.reasonPresetParticipation,
    watching: m.watch.reasonPresetWatching,
    other: m.watch.reasonPresetOther,
  };
  const triggerLabel = selectedReasons.length > 0
    ? m.watch.reasonFilterSelected(selectedReasons.length)
    : m.watch.reasonFilter;

  const toggleReason = (reason: string) => {
    const key = normalizedReason(reason);
    onSelectedReasonsChange(
      selectedKeys.has(key)
        ? selectedReasons.filter((item) => normalizedReason(item) !== key)
        : [...selectedReasons, reason],
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('h-8 shrink-0 px-2 text-muted-foreground', {
            'border-foreground/30 bg-muted text-foreground': selectedReasons.length > 0,
          })}
          aria-label={triggerLabel}
          title={triggerLabel}
          disabled={reasonRows.length === 0}
        >
          <ListFilter className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">{m.watch.reasonFilter}</span>
          {selectedReasons.length > 0 && (
            <span className="min-w-4 rounded-sm bg-primary px-1 font-mono text-[10px] leading-4 text-primary-foreground">
              {selectedReasons.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-72 p-2"
        role="dialog"
        aria-label={m.watch.reasonFilter}
      >
        <div className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          {m.watch.reasonPresets}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label={m.watch.reasonPresets}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn('h-7 px-2 text-[11px]', {
              'bg-muted text-foreground': selectedReasons.length === 0,
            })}
            aria-pressed={selectedReasons.length === 0}
            onClick={() => onSelectedReasonsChange([])}
          >
            {m.watch.reasonPresetAll}
          </Button>
          {REASON_PRESETS.map((preset) => {
            const values = watchReasonPresetValues(preset, availableReasons);
            const active = values.length > 0 && sameReasonSelection(selectedReasons, values);
            return (
              <Button
                key={preset}
                type="button"
                variant="ghost"
                size="sm"
                className={cn('h-7 px-2 text-[11px]', {
                  'bg-muted text-foreground': active,
                })}
                disabled={values.length === 0}
                aria-pressed={active}
                onClick={() => onSelectedReasonsChange(values)}
              >
                {presetLabels[preset]}
              </Button>
            );
          })}
        </div>
        <div className="my-2 h-px bg-border" />
        <div className="max-h-64 overflow-y-auto pr-1">
          {reasonRows.map(({ reason, count }) => {
            const checked = selectedKeys.has(normalizedReason(reason));
            return (
              <label
                key={normalizedReason(reason)}
                className={cn('flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs hover:bg-muted/50', {
                  'bg-muted/35 text-foreground': checked,
                  'text-muted-foreground': !checked,
                })}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleReason(reason)}
                />
                <code className="min-w-0 flex-1 truncate text-[11px]" title={reason}>
                  {reason}
                </code>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {m.watch.reasonThreadCount(count)}
                </span>
              </label>
            );
          })}
        </div>
        {selectedReasons.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-7 w-full justify-start px-1.5 text-[11px] text-muted-foreground"
            onClick={() => onSelectedReasonsChange([])}
          >
            <X className="size-3.5" aria-hidden="true" />
            {m.watch.reasonFilterClear}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function formatTime(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function EmptyState({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-64 place-items-center px-6 py-12 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{text}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

function ThreadRow({
  thread,
  locale,
}: {
  thread: GitHubNotificationThread;
  locale: string;
}) {
  const { m } = useI18n();
  const target = thread.subjectHtmlUrl ?? thread.repositoryHtmlUrl;
  const updated = formatWatchRelativeTime(thread.updatedAt);
  const updatedTitle = formatTime(thread.updatedAt, locale);
  const subjectType = notificationSubjectTypeLabel(thread.subjectType);
  const SubjectIcon = notificationSubjectIcon(thread.subjectType, thread.reason);
  const metadataId = useId();
  return (
    <a
      href={target}
      target="_blank"
      rel="noreferrer"
      data-watch-thread
      aria-label={`${m.watch.openOnGitHub}: ${thread.subjectTitle}`}
      aria-describedby={metadataId}
      className="group relative grid min-h-10 grid-cols-[18px_16px_minmax(0,1fr)_auto] items-center gap-x-2 px-4 py-1.5 text-foreground outline-none transition-colors hover:bg-muted/35 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[18px_16px_minmax(0,1fr)_minmax(0,auto)_auto]"
    >
      <span className="relative z-10 grid size-[18px] place-items-center bg-background" aria-hidden="true">
        <span
          className={cn('size-2 rounded-full', {
            'bg-foreground': thread.unread,
            'border border-muted-foreground/45 bg-background': !thread.unread,
          })}
          title={thread.unread ? m.watch.unreadSnapshot : undefined}
        />
      </span>
      <SubjectIcon
        className={cn('size-4 shrink-0', {
          'text-foreground': thread.unread,
          'text-muted-foreground': !thread.unread,
        })}
        aria-hidden="true"
      />
      <span
        className={cn('min-w-0 truncate text-[13px] leading-5 group-hover:underline', {
          'font-semibold text-foreground': thread.unread,
          'font-medium text-foreground/80': !thread.unread,
        })}
        title={thread.subjectTitle}
      >
        {thread.subjectTitle}
      </span>
      <span id={metadataId} className="sr-only">
        {thread.unread ? `${m.watch.unreadSnapshot}. ` : ''}
        {subjectType}. {thread.reason}. {updatedTitle ?? ''}
      </span>
      <code
        className="hidden max-w-44 truncate rounded-sm bg-muted px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground sm:block"
        title={thread.reason}
      >
        {thread.reason}
      </code>
      {updated && (
        <time
          dateTime={thread.updatedAt}
          title={updatedTitle ?? undefined}
          className="min-w-[4ch] text-right font-mono text-[10px] tabular-nums text-muted-foreground"
        >
          {updated}
        </time>
      )}
    </a>
  );
}

/** GitHub subject types are open-ended; Bell keeps future values renderable. */
function notificationSubjectIcon(type: string, reason: string): LucideIcon {
  if (reason.trim().toLowerCase() === 'security_alert') return ShieldAlert;
  switch (type.trim().toLowerCase().replace(/[\s_-]+/gu, '')) {
    case 'issue':
      return CircleDot;
    case 'pullrequest':
      return GitPullRequest;
    case 'discussion':
      return MessageCircle;
    case 'commit':
      return GitCommitHorizontal;
    case 'release':
      return Tag;
    default:
      return Bell;
  }
}

function WatchGroup({
  group,
  locale,
  defaultOpen,
  revealMatches,
  onSelectRepository,
}: {
  group: WatchInboxQueryResponse['groups'][number];
  locale: string;
  defaultOpen: boolean;
  revealMatches: boolean;
  onSelectRepository?: (fullName: string) => void;
}) {
  const { m } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const expanded = revealMatches || open;
  const unreadCount = group.threads.reduce(
    (count, thread) => count + Number(thread.unread),
    0,
  );
  return (
    <section
      className="relative bg-background"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '44px 320px' }}
    >
      {expanded && group.threads.length > 0 && (
        <span
          className="pointer-events-none absolute bottom-5 left-6 top-5 w-px bg-border"
          aria-hidden="true"
        />
      )}
      <div className="relative grid min-h-11 grid-cols-[18px_16px_minmax(0,1fr)_auto] items-center gap-x-2 px-4 py-1.5 hover:bg-muted/25">
        <button
          type="button"
          className="relative z-10 grid size-[18px] place-items-center rounded-sm bg-background text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-background"
          aria-expanded={expanded}
          aria-label={expanded
            ? m.watch.collapseRepository(group.repositoryFullName)
            : m.watch.expandRepository(group.repositoryFullName)}
          disabled={revealMatches}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', { '-rotate-90': !expanded })}
          />
        </button>
        <BookOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-2">
          {onSelectRepository ? (
            <button
              type="button"
              className="min-w-0 truncate rounded-sm text-left text-[13px] font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelectRepository(group.repositoryFullName)}
            >
              {group.repositoryFullName}
            </button>
          ) : (
            <a
              href={group.repositoryHtmlUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate rounded-sm text-[13px] font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {group.repositoryFullName}
            </a>
          )}
          <span className="hidden shrink-0 items-center gap-1 text-[10px] text-muted-foreground md:inline-flex">
            <Eye className="size-3" aria-hidden="true" />
            {m.watch.watchedOnGitHub}
          </span>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
          {m.watch.repositoryUnreadCount(unreadCount)}
        </span>
      </div>
      {expanded && (
        <div>
          {group.threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} locale={locale} />
          ))}
        </div>
      )}
    </section>
  );
}

export function WatchInbox({
  result,
  loading,
  refreshing,
  error,
  unreadOnly,
  onUnreadOnlyChange,
  onRefresh,
  onRetryQuery,
  onOpenOptions,
  onSelectRepository,
}: WatchInboxProps) {
  const { m, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const searchInput = useImeBufferedInput(query, setQuery);
  const status = result?.status;
  const state = status?.state;
  const cooldownUntil = formatTime(state?.inbox.nextAllowedAt ?? null, locale);
  const checkedAt = formatTime(state?.inbox.lastSuccessfulAt ?? null, locale);
  const reasonCounts = useMemo(
    () => countWatchReasons(result?.threads ?? []),
    [result?.threads],
  );
  const visibleProjection = useMemo(
    () => result
      ? filterWatchInboxProjection(result, { query, reasons: selectedReasons })
      : null,
    [query, result, selectedReasons],
  );
  const groups = visibleProjection?.groups ?? [];
  const hasPresentationFilters = query.trim().length > 0 || selectedReasons.length > 0;
  const refreshDisabled = refreshing || status?.inboxStatus === 'cooldown';

  if (loading) {
    return <EmptyState icon={<Spinner className="size-5" />} text={m.common.loading} />;
  }

  if (!result || !status) {
    return (
      <EmptyState
        icon={<AlertTriangle className="size-5" />}
        text={m.watch.queryFailed}
        action={<Button onClick={onRetryQuery}>{m.watch.retry}</Button>}
      />
    );
  }

  if (!status.hasMainToken) {
    return (
      <EmptyState
        icon={<Settings2 className="size-5" />}
        text={m.watch.configureMainToken}
        action={<Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>}
      />
    );
  }

  const scopeNeverLoaded = !state?.scope.lastSuccessfulAt;
  const inboxNeverLoaded = !state?.inbox.lastSuccessfulAt;

  return (
    <section className="min-h-full bg-background" aria-label={m.watch.title}>
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-5 text-foreground sm:truncate">
              {m.watch.title}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{m.watch.watchedRepositoryCount(state?.scope.repositoryCount ?? 0)}</span>
              <span>{m.watch.threadCount(visibleProjection?.totalCount ?? 0)}</span>
              {checkedAt && <span>{m.watch.snapshotAt(checkedAt)}</span>}
            </div>
          </div>
          <div
            className="inline-flex h-8 items-center rounded-md border border-border bg-muted p-0.5 text-xs"
            role="group"
            aria-label={m.watch.filterLabel}
          >
            <button
              type="button"
              aria-pressed={unreadOnly}
              onClick={() => onUnreadOnlyChange(true)}
              className={cn('h-7 rounded px-2.5 font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
                'bg-background text-foreground shadow-sm': unreadOnly,
              })}
            >
              {m.watch.unread}
            </button>
            <button
              type="button"
              aria-pressed={!unreadOnly}
              onClick={() => onUnreadOnlyChange(false)}
              className={cn('h-7 rounded px-2.5 font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
                'bg-background text-foreground shadow-sm': !unreadOnly,
              })}
            >
              {m.watch.all}
            </button>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={refreshDisabled}
            onClick={onRefresh}
            aria-label={refreshing ? m.watch.refreshing : m.watch.refresh}
            title={refreshing ? m.watch.refreshing : m.watch.refresh}
          >
            {refreshing ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
          </Button>
          <Button asChild variant="ghost" size="icon" className="size-8">
            <a
              href="https://github.com/watching"
              target="_blank"
              rel="noreferrer"
              aria-label={m.watch.manageOnGitHub}
              title={m.watch.manageOnGitHub}
            >
              <Settings2 className="size-4" />
            </a>
          </Button>
        </div>
        <div className="mt-3 flex min-w-0 items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              {...searchInput.inputProps}
              type="search"
              aria-label={m.watch.searchPlaceholder}
              placeholder={m.watch.searchPlaceholder}
              className="h-8 pl-8 pr-8 text-xs"
            />
            {searchInput.value.length > 0 && (
              <button
                type="button"
                aria-label={m.watch.clearSearch}
                title={m.watch.clearSearch}
                onClick={() => searchInput.commit('')}
                className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          <ReasonFilterPopover
            reasonCounts={reasonCounts}
            selectedReasons={selectedReasons}
            onSelectedReasonsChange={setSelectedReasons}
          />
        </div>
      </header>

      {(error === 'refresh' || status.scopeStatus === 'stale' || status.inboxStatus === 'stale') && (
        <div role="status" className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">
            {status.scopeStatus === 'stale' || status.inboxStatus === 'stale'
              ? m.watch.staleSnapshot
              : m.watch.refreshFailed}
          </span>
        </div>
      )}
      {error === 'query' && (
        <div role="status" className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{m.watch.queryFailed}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onRetryQuery}>
            {m.watch.retry}
          </Button>
        </div>
      )}
      {status.scopeStatus === 'error' && (
        <div role="alert" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{m.watch.scopeFailed}</span>
        </div>
      )}
      {status.inboxStatus === 'error' && (
        <div role="alert" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{m.watch.inboxFailed}</span>
        </div>
      )}
      {state?.inbox.truncated && (
        <div role="status" className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <Inbox className="size-4 shrink-0" />
          <span>{m.watch.truncated}</span>
        </div>
      )}
      {status.inboxStatus === 'cooldown' && cooldownUntil && (
        <div role="status" className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <Clock3 className="size-4 shrink-0" />
          <span>{m.watch.cooldownUntil(cooldownUntil)}</span>
        </div>
      )}

      {status.scopeStatus === 'error' ? (
        <EmptyState
          icon={<AlertTriangle className="size-5" />}
          text={state?.scope.errorCode === 'permission_denied'
            ? m.watch.scopePermissionDenied
            : m.watch.scopeFailed}
          action={state?.scope.errorCode === 'permission_denied'
            ? <Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>
            : <Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.retry}</Button>}
        />
      ) : scopeNeverLoaded ? (
        <EmptyState
          icon={<RefreshCw className="size-5" />}
          text={m.watch.scopeNeverLoaded}
          action={<Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.refresh}</Button>}
        />
      ) : state.scope.repositoryCount === 0 ? (
        <EmptyState icon={<Inbox className="size-5" />} text={m.watch.noWatchedRepositories} />
      ) : !status.hasNotificationsToken ? (
        <EmptyState
          icon={<Settings2 className="size-5" />}
          text={m.watch.configureNotificationsToken}
          action={<Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>}
        />
      ) : status.inboxStatus === 'scope_unavailable' ? (
        <EmptyState
          icon={<AlertTriangle className="size-5" />}
          text={m.watch.scopeUnavailable}
          action={<Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.retry}</Button>}
        />
      ) : status.inboxStatus === 'error' ? (
        <EmptyState
          icon={<AlertTriangle className="size-5" />}
          text={state.inbox.errorCode === 'permission_denied'
            ? m.watch.inboxPermissionDenied
            : m.watch.inboxFailed}
          action={state.inbox.errorCode === 'permission_denied'
            ? <Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>
            : <Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.retry}</Button>}
        />
      ) : inboxNeverLoaded ? (
        <EmptyState
          icon={<RefreshCw className="size-5" />}
          text={m.watch.inboxNeverLoaded}
          action={<Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.refresh}</Button>}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-5" />}
          text={result.threads.length > 0 && hasPresentationFilters
            ? m.watch.noMatchingThreads
            : unreadOnly ? m.watch.noUnreadThreads : m.watch.noThreads}
        />
      ) : (
        <div
          className="divide-y divide-border/60"
          data-watch-thread-list
          onKeyDown={handleThreadListKeyDown}
        >
          {groups.map((group, index) => (
            <WatchGroup
              key={group.repositoryFullName}
              group={group}
              locale={locale}
              defaultOpen={index < 8}
              revealMatches={hasPresentationFilters}
              onSelectRepository={onSelectRepository}
            />
          ))}
        </div>
      )}
    </section>
  );
}
