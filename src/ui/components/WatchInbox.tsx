import {
  AlertTriangle,
  Bell,
  BookOpen,
  ChevronDown,
  CircleDot,
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
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Streamdown } from 'streamdown';
import { useI18n } from '@/i18n';

import { cn } from '@/lib/utils';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { usePrefersReducedMotion } from '@/ui/hooks/use-prefers-reduced-motion';
import { useDismissableNotice } from '@/ui/hooks/use-dismissable-notice';
import { useWatchSubjectDetails } from '@/ui/hooks/use-watch-subject-details';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { RepositoryOwnerAvatar } from '@/ui/components/RepositoryOwnerAvatar';
import { SurfaceListEndMarker } from '@/ui/components/SurfaceListEndMarker';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Input } from '@/ui/shadcn/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Spinner } from '@/ui/shadcn/spinner';
import {
  countWatchReasons,
  deriveWatchStatusPresentation,
  filterWatchInboxProjection,
  formatWatchRelativeTime,
  hasNewWatchGroupContent,
  watchGroupContentSignature,
  watchReasonPresetValues,
  type WatchReasonCount,
  type WatchReasonPreset,
} from '@/ui/watch-inbox-presentation';
import {
  notificationSubjectTypeLabel,
  projectWatchInbox,
  type GitHubNotificationThread,
  type WatchSubjectDetail,
} from '@/watch/watch-model';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';
import type { WatchCollapsedRepositorySignatures } from '@/types';
const WATCH_MARKDOWN_DISALLOWED_ELEMENTS = [
  'img',
  'iframe',
  'video',
  'audio',
  'object',
  'embed',
  'svg',
  'math',
  'script',
  'style',
  'canvas',
  'source',
  'track',
] as const;

function safeWatchMarkdownUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.port
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function WatchMarkdownLink({
  children,
  node: _node,
  ...props
}: ComponentProps<'a'> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
}

interface WatchInboxProps {
  result: WatchInboxQueryResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: 'query' | 'refresh' | null;
  actionPending: {
    action: 'read' | 'done';
    threadIds: readonly string[];
  } | null;
  actionError: 'read' | 'done' | null;
  unreadOnly: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onRefresh: () => void;
  onRetryQuery: () => void;
  onOpenOptions: () => void;
  onOpenMainTokenOptions: () => void;
  onMarkThreadsRead: (ids: readonly string[]) => void;
  onMarkThreadsDone: (ids: readonly string[]) => void;
  collapsedRepositories?: WatchCollapsedRepositorySignatures;
  onRepositoryCollapseChange?: (repository: string, signature: string | null) => void;
  onSelectRepository?: (fullName: string) => void;
}

interface WatchSurfaceActionsProps {
  unreadOnly: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onRefresh: () => void;
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

/**
 * Revoked authentication and missing permission both mean the selected
 * credential can no longer read GitHub. Only Watch pauses in that case; Stars,
 * tags, Gist, and sync keep working, so these states offer credential recovery
 * instead of a plain retry.
 */
function isWatchCredentialError(code: string | null | undefined): boolean {
  return code === 'authentication_required' || code === 'permission_denied';
}

function handleThreadListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const target = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('button[data-watch-thread]')
    : null;
  if (!target || !event.currentTarget.contains(target)) return;

  // Only expanded groups participate in list-level keyboard navigation.
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[data-watch-thread]:not([data-watch-thread-hidden])',
    ),
  );
  const currentIndex = buttons.indexOf(target);
  if (currentIndex < 0 || buttons.length === 0) return;

  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? buttons.length - 1
      : event.key === 'ArrowUp'
        ? Math.max(0, currentIndex - 1)
        : Math.min(buttons.length - 1, currentIndex + 1);
  event.preventDefault();
  buttons[nextIndex]?.focus();
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

function WatchSurfaceActions({
  unreadOnly,
  refreshing,
  refreshDisabled,
  onUnreadOnlyChange,
  onRefresh,
}: WatchSurfaceActionsProps) {
  const { m } = useI18n();

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <div
        className="inline-flex h-[26px] items-center rounded-md bg-muted p-0.5"
        role="group"
        aria-label={m.watch.filterLabel}
      >
        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={() => onUnreadOnlyChange(true)}
          className={cn('h-[22px] rounded-sm px-2.5 text-[11px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
            'bg-card text-foreground shadow-sm': unreadOnly,
          })}
        >
          {m.watch.unread}
        </button>
        <button
          type="button"
          aria-pressed={!unreadOnly}
          onClick={() => onUnreadOnlyChange(false)}
          className={cn('h-[22px] rounded-sm px-2.5 text-[11px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
            'bg-card text-foreground shadow-sm': !unreadOnly,
          })}
        >
          {m.watch.all}
        </button>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-[30px] gap-1.5 px-2.5 text-xs"
        disabled={refreshDisabled}
        onClick={onRefresh}
        aria-label={refreshing ? m.watch.refreshing : m.watch.refresh}
      >
        {refreshing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        <span className="max-[520px]:hidden">
          {refreshing ? m.watch.refreshing : m.watch.refresh}
        </span>
      </Button>
    </div>
  );
}
export function WatchStatusRibbon({
  result,
  loading,
  refreshing,
  error,
  onOpenOptions,
}: Pick<WatchInboxProps, 'result' | 'loading' | 'refreshing' | 'error'> & {
  onOpenOptions?: () => void;
}) {
  const { m, locale } = useI18n();
  const presentation = deriveWatchStatusPresentation({ result, loading, refreshing, error });
  const dismissable = (presentation.tone === 'warning' || presentation.tone === 'destructive')
    && !loading && !refreshing;
  const { dismissed, dismiss } = useDismissableNotice(
    dismissable,
    `${presentation.kind}:${presentation.code ?? ''}`,
  );
  const status = result?.status;
  const state = status?.state;
  const snapshotAt = formatTime(presentation.snapshotAt, locale);
  const text = (() => {
    switch (presentation.kind) {
      case 'loading':
        return m.common.loading;
      case 'refreshing':
        return presentation.snapshotAt ? m.watch.statusRefreshingSaved : m.watch.refreshing;
      case 'credential_error':
        return m.watch.statusCredential;
      case 'query_error':
        return m.watch.queryFailed;
      case 'refresh_error':
      case 'stale':
        return m.watch.statusRefreshFailedSaved;
      case 'cooldown': {
        const cooldownUntil = formatTime(state?.inbox.nextAllowedAt ?? null, locale);
        return cooldownUntil ? m.watch.statusCooldown(cooldownUntil) : m.watch.statusRefreshFailedSaved;
      }
      case 'scope_error':
        return m.watch.scopeFailed;
      case 'inbox_error':
        return m.watch.inboxFailed;
      case 'truncated':
        return m.watch.statusTruncated(result?.threads.length ?? 0);
      case 'never_loaded':
        return status?.hasMainToken ? m.watch.statusNeverLoaded : m.watch.configureMainToken;
      case 'fresh':
        return m.watch.statusFresh(result?.unreadCount ?? 0, state?.scope.repositoryCount ?? 0);
    }
  })();


  if (dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn('shrink-0 overflow-hidden border-b border-border text-xs', {
        'bg-card': presentation.tone === 'muted',
        'bg-success/[0.07]': presentation.tone === 'success',
        'bg-warning/[0.07]': presentation.tone === 'warning',
        'bg-destructive/[0.07]': presentation.tone === 'destructive',
      })}
      data-watch-status={presentation.kind}
    >
      <SurfaceWorkCanvas variant="watch" className="relative flex h-[30px] items-center gap-2 px-3.5">
        {presentation.kind === 'refreshing' || (refreshing && presentation.kind !== 'loading') ? (
          <Spinner className="size-3 shrink-0" />
        ) : (
          <span
            className={cn('size-[7px] shrink-0 rounded-full', {
              'border border-muted-foreground bg-transparent': presentation.tone === 'muted',
              'bg-success': presentation.tone === 'success',
              'bg-warning': presentation.tone === 'warning',
              'bg-destructive': presentation.tone === 'destructive',
            })}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 truncate text-foreground/90">{text}</span>
        <span className="flex-1" />
        {presentation.kind === 'credential_error' && onOpenOptions && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={onOpenOptions}
          >
            {m.watch.openOptions}
          </Button>
        )}
        {snapshotAt && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground max-[640px]:hidden">
            {snapshotAt}
          </span>
        )}
        {dismissable && (
          <button
            type="button"
            aria-label={m.common.close}
            onClick={dismiss}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
        {refreshing && <span className="gsm-watch-refresh-bar" aria-hidden="true" />}
      </SurfaceWorkCanvas>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  text,
  action,
  tone = 'muted',
}: {
  icon: React.ReactNode;
  title?: string;
  text: string;
  action?: React.ReactNode;
  tone?: 'muted' | 'success' | 'destructive';
}) {
  return (
    <SurfaceWorkCanvas variant="watch">
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-5 py-12 text-center">
        <div className={cn('grid size-8 place-items-center rounded-lg', {
          'bg-muted text-muted-foreground': tone === 'muted',
          'bg-success/10 text-success': tone === 'success',
          'bg-destructive/10 text-destructive': tone === 'destructive',
        })}>
          {icon}
        </div>
        {title && <p className="text-[13.5px] font-semibold text-foreground">{title}</p>}
        <p className="max-w-md text-xs leading-5 text-muted-foreground">{text}</p>
        {action && <div className="mt-2 flex gap-2">{action}</div>}
      </div>
    </SurfaceWorkCanvas>
  );
}

function SubjectDetailContent({
  detail,
  locale,
}: {
  detail: WatchSubjectDetail;
  locale: string;
}) {
  const { m } = useI18n();
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [bodyOverflowing, setBodyOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyId = useId();
  const created = formatTime(detail.createdAt, locale) ?? detail.createdAt;
  const updated = formatTime(detail.updatedAt, locale) ?? detail.updatedAt;
  const bodyMarkdown = detail.bodyMarkdown?.trim() ?? '';

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || bodyExpanded) return;
    const measure = () => setBodyOverflowing(body.scrollHeight > body.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [bodyExpanded, bodyMarkdown]);

  return (
    <div data-watch-subject-detail="success">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold text-foreground">{m.watch.subjectDetails}</span>
        <span
          className={cn('inline-flex min-h-[18px] items-center rounded-full border px-1.5 text-[11px] font-semibold', {
            'border-success/40 text-success': detail.state === 'open',
            'border-border bg-card/65 text-muted-foreground': detail.state === 'closed',
          })}
        >
          {detail.state === 'open' ? m.watch.subjectStateOpen : m.watch.subjectStateClosed}
        </span>
        {detail.stateReason && (
          <span className="text-[11px] text-muted-foreground">
            {m.watch.subjectStateReason(detail.stateReason)}
          </span>
        )}
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>#{detail.number}</span>
        <a className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={detail.author.htmlUrl} target="_blank" rel="noreferrer">
          {m.watch.subjectAuthor(detail.author.login)}
        </a>
        <time dateTime={detail.createdAt}>{m.watch.subjectCreated(created)}</time>
        <time dateTime={detail.updatedAt}>{m.watch.threadUpdated}: {updated}</time>
        <span>{m.watch.subjectComments(detail.commentCount)}</span>
        {detail.milestoneTitle && <span>{m.watch.subjectMilestone(detail.milestoneTitle)}</span>}
        {detail.assignees.length > 0 && (
          <span>{m.watch.subjectAssignees(detail.assignees.map((person) => `@${person.login}`).join(', '))}</span>
        )}
      </div>
      {detail.labels.length > 0 && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1" aria-label={m.watch.subjectLabels}>
          {detail.labels.map((label) => (
            <span
              key={`${label.name}:${label.color}`}
              className="inline-flex min-h-[18px] items-center rounded border border-border bg-card/70 px-1.5 font-mono text-[11px] text-muted-foreground"
              title={`#${label.color}`}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}
      <div className="gsm-watch-subject-body-wrap mt-1.5">
        {bodyMarkdown ? (
          <>
            <div
              ref={bodyRef}
              id={bodyId}
              className={cn('gsm-watch-subject-markdown', {
                'gsm-watch-subject-markdown-preview': !bodyExpanded,
                'gsm-watch-subject-markdown-expanded': bodyExpanded,
                'gsm-watch-subject-markdown-faded': !bodyExpanded && bodyOverflowing,
              })}
              data-watch-subject-body={bodyExpanded ? 'expanded' : 'preview'}
            >
              <Streamdown
                mode="static"
                animated={false}
                controls={false}
                lineNumbers={false}
                skipHtml
                disallowedElements={WATCH_MARKDOWN_DISALLOWED_ELEMENTS}
                linkSafety={{ enabled: false }}
                urlTransform={safeWatchMarkdownUrl}
                components={{ a: WatchMarkdownLink }}
                className="gsm-watch-subject-markdown-content"
              >
                {bodyMarkdown}
              </Streamdown>
            </div>
            {bodyOverflowing || bodyExpanded ? (
              <button
                type="button"
                className="mt-1 rounded-sm text-[11px] font-semibold text-muted-foreground underline decoration-muted-foreground/45 underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={bodyExpanded}
                aria-controls={bodyId}
                onClick={() => setBodyExpanded((current) => !current)}
              >
                {bodyExpanded ? m.watch.subjectCollapseDescription : m.watch.subjectShowDescription}
              </button>
            ) : null}
          </>
        ) : (
          <p className="text-xs leading-[1.5] text-muted-foreground">{m.watch.subjectNoDescription}</p>
        )}
      </div>
    </div>
  );
}

function SubjectDetailSlot({
  thread,
  expanded,
  locale,
  onOpenMainTokenOptions,
}: {
  thread: GitHubNotificationThread;
  expanded: boolean;
  locale: string;
  onOpenMainTokenOptions: () => void;
}) {
  const { m } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const { state, supported, retry } = useWatchSubjectDetails({ thread, expanded });
  const [renderedState, setRenderedState] = useState(state);
  const [swapping, setSwapping] = useState(false);

  useEffect(() => {
    if (state.status === 'loading' || state.status === 'idle' || reducedMotion) {
      setRenderedState(state);
      setSwapping(false);
      return;
    }
    setRenderedState(state);
    setSwapping(true);
    const timer = window.setTimeout(() => setSwapping(false), 70);
    return () => window.clearTimeout(timer);
  }, [reducedMotion, state]);

  if (!expanded || !supported || renderedState.status === 'idle') return null;
  const credentialError = renderedState.status === 'error' && (
    renderedState.code === 'authentication_required' || renderedState.code === 'permission_denied'
  );
  const detailErrorMessage = renderedState.status === 'error'
    ? renderedState.code === 'authentication_required'
      ? m.watch.subjectDetailsAuthentication
      : renderedState.code === 'permission_denied'
        ? m.watch.subjectDetailsPermission
        : renderedState.message || m.watch.subjectDetailsUnavailable
    : null;
  return (
    <section
      className={cn('gsm-watch-subject-detail-slot mt-1 border-t border-border/80 pt-1', {
        'gsm-watch-subject-detail-swapping': swapping,
      })}
      data-state={renderedState.status}
      aria-label={m.watch.subjectDetails}
      aria-live="polite"
      aria-busy={renderedState.status === 'loading'}
    >
      {renderedState.status === 'loading' ? (
        <div data-watch-subject-detail="loading">
          <span className="text-[11.5px] text-muted-foreground">{m.watch.subjectDetailsLoading}</span>
          <span className="gsm-watch-subject-skeleton mt-1.5" aria-hidden="true">
            <span />
            <span />
          </span>
        </div>
      ) : renderedState.status === 'success' ? (
        <SubjectDetailContent detail={renderedState.detail} locale={locale} />
      ) : renderedState.status === 'error' ? (
        <div data-watch-subject-detail="error">
          <p className="text-xs leading-[1.5] text-foreground/80">
            {detailErrorMessage}
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            {credentialError && (
              <Button size="sm" className="h-7 px-2.5 text-xs" onClick={onOpenMainTokenOptions}>
                {m.watch.openOptions}
              </Button>
            )}
            <Button
              variant={credentialError ? "outline" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={retry}
            >
              {m.watch.retry}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ThreadRow({
  thread,
  locale,
  hidden,
  actionPending,
  onOpenMainTokenOptions,
  onMarkThreadsRead,
  onMarkThreadsDone,
}: {
  thread: GitHubNotificationThread;
  locale: string;
  hidden: boolean;
  actionPending: WatchInboxProps['actionPending'];
  onOpenMainTokenOptions: () => void;
  onMarkThreadsRead: (ids: readonly string[]) => void;
  onMarkThreadsDone: (ids: readonly string[]) => void;
}) {
  const { m } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [keyboardTransition, setKeyboardTransition] = useState(false);
  const target = thread.subjectHtmlUrl ?? thread.repositoryHtmlUrl;
  const updated = formatWatchRelativeTime(thread.updatedAt);
  const updatedTitle = formatTime(thread.updatedAt, locale);
  const subjectType = notificationSubjectTypeLabel(thread.subjectType);
  const SubjectIcon = notificationSubjectIcon(thread.subjectType, thread.reason);
  const disclosureId = useId();
  const detailsId = `${disclosureId}-details`;
  const metadataId = `${disclosureId}-metadata`;
  const actionDisabled = actionPending !== null;
  const threadActionPending = actionPending?.threadIds.includes(thread.id) === true;
  const readPending = threadActionPending && actionPending?.action === 'read';
  const donePending = threadActionPending && actionPending?.action === 'done';

  useEffect(() => {
    if (hidden) setExpanded(false);
  }, [hidden]);

  const toggleExpanded = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const keyboard = event.detail === 0;
    setKeyboardTransition(keyboard);
    setExpanded((current) => !current);
    if (keyboard) requestAnimationFrame(() => setKeyboardTransition(false));
  };

  return (
    <article className="min-w-0" data-watch-thread-row={thread.id}>
      <button
        id={disclosureId}
        type="button"
        data-watch-thread
        data-watch-thread-hidden={hidden || undefined}
        tabIndex={hidden ? -1 : undefined}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={`${m.watch.threadDetails}: ${thread.subjectTitle}`}
        aria-describedby={metadataId}
        onClick={toggleExpanded}
        className={cn('group flex h-[37px] w-full min-w-0 items-center gap-[9px] rounded-md pr-2 text-left text-foreground outline-none transition-colors hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', {
          'bg-muted/45': expanded,
        })}
      >
        <span className="relative z-10 flex w-[15px] shrink-0 justify-center bg-background" aria-hidden="true">
          <span
            className={cn('rounded-full bg-background ring-[2.5px] ring-background', {
              'size-[7px] bg-foreground': thread.unread,
              'size-[5px] border border-muted-foreground/40': !thread.unread,
            })}
            title={thread.unread ? m.watch.unreadSnapshot : undefined}
          />
        </span>
        <SubjectIcon
          className={cn('size-[15px] shrink-0', {
            'text-foreground/75': thread.unread,
            'text-muted-foreground': !thread.unread,
          })}
          aria-hidden="true"
        />
        <span
          className={cn('min-w-0 flex-1 truncate text-[13px]', {
            'font-semibold text-foreground': thread.unread,
            'font-normal text-muted-foreground': !thread.unread,
          })}
          title={thread.subjectTitle}
        >
          {thread.subjectTitle}
        </span>
        <span id={metadataId} className="sr-only">
          {subjectType}. {thread.reason}. {thread.unread ? m.watch.unreadStatus : m.watch.readStatus}. {updatedTitle ?? ''}
        </span>
        <code
          className="max-w-44 truncate rounded-sm bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground max-[720px]:hidden"
          title={thread.reason}
        >
          {thread.reason}
        </code>
        {updated && (
          <time
            dateTime={thread.updatedAt}
            title={updatedTitle ?? undefined}
            className="w-11 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground"
          >
            {updated}
          </time>
        )}
        <ChevronDown
          className={cn('gsm-watch-thread-chevron size-3.5 shrink-0 text-muted-foreground', {
            'rotate-180': expanded,
          })}
          aria-hidden="true"
        />
      </button>
      <div
        id={detailsId}
        role="region"
        aria-labelledby={disclosureId}
        aria-hidden={!expanded}
        {...(!expanded
          ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>)
          : {})}
        data-open={expanded}
        data-keyboard={keyboardTransition || undefined}
        className="gsm-watch-thread-disclosure ml-6 min-w-0"
      >
        <div className="min-h-0 overflow-hidden">
          <div className="gsm-watch-thread-inspector mb-2 min-w-0 border-y border-border bg-muted/35 px-3 py-2.5">
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {m.watch.threadDetails}
              </p>
              <h4 className="mt-1 break-words text-[13px] font-semibold leading-5 text-foreground">
                {thread.subjectTitle}
              </h4>
              <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
                <span>{subjectType}</span>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 break-all font-mono text-[11px]">{thread.repositoryFullName}</span>
              </p>
            </div>
            <dl className="mt-2 grid min-w-0 grid-cols-1 gap-x-5 gap-y-1.5 text-[11.5px] min-[520px]:grid-cols-3">
              <div className="flex min-w-0 items-baseline gap-2 min-[520px]:block">
                <dt className="shrink-0 text-muted-foreground">{m.watch.threadReason}</dt>
                <dd className="min-w-0 break-all font-mono text-[11px] text-foreground min-[520px]:mt-0.5">{thread.reason}</dd>
              </div>
              <div className="flex min-w-0 items-baseline gap-2 min-[520px]:block">
                <dt className="shrink-0 text-muted-foreground">{m.watch.threadStatus}</dt>
                <dd className="min-w-0 text-foreground min-[520px]:mt-0.5">{thread.unread ? m.watch.unreadStatus : m.watch.readStatus}</dd>
              </div>
              <div className="flex min-w-0 items-baseline gap-2 min-[520px]:block">
                <dt className="shrink-0 text-muted-foreground">{m.watch.threadUpdated}</dt>
                <dd className="min-w-0 font-mono text-[11px] text-foreground min-[520px]:mt-0.5"><time dateTime={thread.updatedAt}>{updatedTitle ?? thread.updatedAt}</time></dd>
              </div>
            </dl>
            <SubjectDetailSlot
              thread={thread}
              expanded={expanded}
              locale={locale}
              onOpenMainTokenOptions={onOpenMainTokenOptions}
            />
            <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-2 border-t border-border pt-2">
              <Button variant="ghost" size="sm" className="h-7 px-2.5 text-muted-foreground" disabled={actionDisabled} onClick={() => onMarkThreadsDone([thread.id])}>
                {donePending && <Spinner data-icon="inline-start" aria-label={m.watch.markingDone} />}
                {donePending ? m.watch.markingDone : m.watch.markAsDone}
              </Button>
              <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                <Button variant="outline" size="sm" className="h-7 px-2.5" disabled={actionDisabled || !thread.unread} onClick={() => onMarkThreadsRead([thread.id])}>
                  {readPending && <Spinner data-icon="inline-start" aria-label={m.watch.markingRead} />}
                  {readPending ? m.watch.markingRead : m.watch.markAsRead}
                </Button>
                <Button asChild size="sm" className="h-7 min-w-0 max-w-full px-2.5">
                  <a href={target} target="_blank" rel="noreferrer" title={m.watch.openSubjectOnGitHub(subjectType)}>
                    <span className="min-w-0 truncate">{m.watch.openSubjectOnGitHub(subjectType)}</span>
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
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
  sourceGroup,
  locale,
  persistedSignature,
  revealMatches,
  autoExpanded,
  actionPending,
  onCollapseChange,
  onSelectRepository,
  onOpenMainTokenOptions,
  onMarkThreadsRead,
  onMarkThreadsDone,
}: {
  group: WatchInboxQueryResponse['groups'][number];
  sourceGroup: WatchInboxQueryResponse['groups'][number];
  locale: string;
  persistedSignature: string | null;
  revealMatches: boolean;
  autoExpanded: boolean;
  actionPending: WatchInboxProps['actionPending'];
  onCollapseChange?: (repository: string, signature: string | null) => void;
  onSelectRepository?: (fullName: string) => void;
  onOpenMainTokenOptions: () => void;
  onMarkThreadsRead: (ids: readonly string[]) => void;
  onMarkThreadsDone: (ids: readonly string[]) => void;
}) {
  const { m } = useI18n();
  const [manualExpansion, setManualExpansion] = useState<'expanded' | 'collapsed' | null>(null);
  const contentId = useId();
  const contentSignature = watchGroupContentSignature(sourceGroup.threads);
  const hasNewContent = persistedSignature
    ? hasNewWatchGroupContent(persistedSignature, sourceGroup.threads)
    : false;
  const persistentlyCollapsed = persistedSignature !== null && !hasNewContent;
  const expanded = revealMatches || hasNewContent || manualExpansion === 'expanded'
    || (!persistentlyCollapsed && manualExpansion !== 'collapsed');
  const unreadCount = sourceGroup.threads.reduce(
    (count, thread) => count + Number(thread.unread),
    0,
  );
  const latest = formatWatchRelativeTime(sourceGroup.latestUpdatedAt);
  const allThreadIds = sourceGroup.threads.map((thread) => thread.id);
  const unreadThreadIds = sourceGroup.threads
    .filter((thread) => thread.unread)
    .map((thread) => thread.id);
  const actionDisabled = actionPending !== null;
  const pendingTargetsThisRepository = actionPending !== null
    && actionPending.threadIds.length === (
      actionPending.action === 'read' ? unreadThreadIds.length : allThreadIds.length
    )
    && actionPending.threadIds.every((id) => (
      actionPending.action === 'read' ? unreadThreadIds : allThreadIds
    ).includes(id));
  const readPending = pendingTargetsThisRepository && actionPending?.action === 'read';
  const donePending = pendingTargetsThisRepository && actionPending?.action === 'done';

  useEffect(() => {
    if (hasNewContent) setManualExpansion('expanded');
  }, [hasNewContent]);

  const toggleExpanded = () => {
    if (revealMatches) return;
    if (expanded) {
      setManualExpansion('collapsed');
      onCollapseChange?.(group.repositoryFullName, contentSignature);
    } else {
      setManualExpansion('expanded');
      onCollapseChange?.(group.repositoryFullName, null);
    }
  };

  return (
    <section
      className={cn('relative bg-background', { 'gsm-watch-auto-expanded': autoExpanded })}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '26px 320px' }}
      data-watch-repository={group.repositoryFullName}
    >
      <div className="flex min-h-[26px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md">
        <span className="relative z-10 flex w-[15px] shrink-0 justify-center bg-background" aria-hidden="true">
          <span className="size-[9px] rounded-full border-2 border-muted-foreground/50 bg-background ring-[2.5px] ring-background" />
        </span>
        <button
          type="button"
          className="gsm-touch-target grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={expanded
            ? m.watch.collapseRepository(group.repositoryFullName)
            : m.watch.expandRepository(group.repositoryFullName)}
          disabled={revealMatches}
          onClick={toggleExpanded}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', { '-rotate-90': !expanded })}
          />
        </button>
        <BookOpen className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
        <RepositoryOwnerAvatar
          fullName={group.repositoryFullName}
          url={group.repositoryOwnerAvatarUrl}
          className="size-4"
        />
        {onSelectRepository ? (
          <button
            type="button"
            className="min-w-0 truncate rounded-sm text-left text-[13.5px] font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelectRepository(group.repositoryFullName)}
          >
            {group.repositoryFullName}
          </button>
        ) : (
          <a
            href={group.repositoryHtmlUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate rounded-sm text-[13.5px] font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {group.repositoryFullName}
          </a>
        )}
        <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-px font-mono text-[11px] tabular-nums text-muted-foreground">
          {expanded
            ? m.watch.repositoryUnreadCount(unreadCount)
            : `${m.watch.threadCount(sourceGroup.threads.length)} · ${latest ?? '—'} · ${m.watch.repositoryUnreadCount(unreadCount)}`}
        </span>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label={group.repositoryFullName}>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={actionDisabled || unreadThreadIds.length === 0}
            onClick={() => onMarkThreadsRead(unreadThreadIds)}
          >
            {readPending && <Spinner data-icon="inline-start" aria-label={m.watch.markingRead} />}
            <span>{readPending ? m.watch.markingRead : m.watch.markAllRead}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            disabled={actionDisabled || allThreadIds.length === 0}
            onClick={() => onMarkThreadsDone(allThreadIds)}
          >
            {donePending && <Spinner data-icon="inline-start" aria-label={m.watch.markingDone} />}
            <span>{donePending ? m.watch.markingDone : m.watch.markAllDone}</span>
          </Button>
        </div>
      </div>
      <div
        id={contentId}
        className={cn('gsm-watch-group-content', { 'gsm-watch-group-content-open': expanded })}
        aria-hidden={!expanded}
        {...(!expanded
          ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>)
          : {})}
      >
        <div className="min-h-0 overflow-hidden">
          {group.threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              locale={locale}
              hidden={!expanded}
              actionPending={actionPending}
              onOpenMainTokenOptions={onOpenMainTokenOptions}
              onMarkThreadsRead={onMarkThreadsRead}
              onMarkThreadsDone={onMarkThreadsDone}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function WatchInbox({
  result,
  loading,
  refreshing,
  actionPending,
  actionError,
  unreadOnly,
  onUnreadOnlyChange,
  onRefresh,
  onRetryQuery,
  onOpenOptions,
  onOpenMainTokenOptions,
  onMarkThreadsRead,
  onMarkThreadsDone,
  collapsedRepositories = {},
  onRepositoryCollapseChange,
  onSelectRepository,
}: WatchInboxProps) {
  const { m, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const [autoExpandedRepositories, setAutoExpandedRepositories] = useState<Record<string, true>>({});
  const reconciledCollapseSignatures = useRef<Record<string, string>>({});
  const searchInput = useImeBufferedInput(query, setQuery);
  const status = result?.status;
  const state = status?.state;
  const modeProjection = useMemo(
    () => result ? projectWatchInbox(result.threads, { unreadOnly }) : null,
    [result, unreadOnly],
  );
  const reasonCounts = useMemo(
    () => countWatchReasons(modeProjection?.threads ?? []),
    [modeProjection?.threads],
  );
  const visibleProjection = useMemo(
    () => modeProjection
      ? filterWatchInboxProjection(modeProjection, { query, reasons: selectedReasons })
      : null,
    [modeProjection, query, selectedReasons],
  );
  const sourceGroupsByRepository = useMemo(() => new Map(
    (result?.groups ?? []).map((group) => [group.repositoryFullName.toLowerCase(), group]),
  ), [result?.groups]);
  const groups = visibleProjection?.groups ?? [];
  const hasPresentationFilters = query.trim().length > 0 || selectedReasons.length > 0;
  const refreshDisabled = refreshing || actionPending !== null || status?.inboxStatus === 'cooldown';

  useEffect(() => {
    if (!result || !onRepositoryCollapseChange) return;
    const newlyExpanded: Record<string, true> = {};
    for (const group of result.groups) {
      const repository = group.repositoryFullName.toLowerCase();
      const persistedSignature = collapsedRepositories[repository];
      if (!persistedSignature) {
        delete reconciledCollapseSignatures.current[repository];
        continue;
      }
      const currentSignature = watchGroupContentSignature(group.threads);
      const reconciliation = `${persistedSignature}\n${currentSignature}`;
      if (reconciledCollapseSignatures.current[repository] === reconciliation) continue;
      reconciledCollapseSignatures.current[repository] = reconciliation;
      if (hasNewWatchGroupContent(persistedSignature, group.threads)) {
        newlyExpanded[repository] = true;
        onRepositoryCollapseChange(group.repositoryFullName, null);
      } else if (persistedSignature !== currentSignature) {
        onRepositoryCollapseChange(group.repositoryFullName, currentSignature);
      }
    }
    if (Object.keys(newlyExpanded).length > 0) {
      setAutoExpandedRepositories((current) => ({ ...current, ...newlyExpanded }));
    }
  }, [collapsedRepositories, onRepositoryCollapseChange, result]);

  useEffect(() => {
    if (Object.keys(autoExpandedRepositories).length === 0) return;
    const timer = window.setTimeout(() => setAutoExpandedRepositories({}), 1_000);
    return () => window.clearTimeout(timer);
  }, [autoExpandedRepositories]);

  if (loading && !result) {
    return <EmptyState icon={<Spinner className="size-4" />} text={m.common.loading} />;
  }

  if (!result || !status) {
    return (
      <EmptyState
        icon={<AlertTriangle className="size-4" />}
        title={m.watch.title}
        text={m.watch.queryFailed}
        tone="destructive"
        action={<Button onClick={onRetryQuery}>{m.watch.retry}</Button>}
      />
    );
  }

  if (!status.hasMainToken) {
    return (
      <EmptyState
        icon={<Settings2 className="size-4" />}
        title={m.watch.title}
        text={m.watch.configureMainToken}
        action={<Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>}
      />
    );
  }

  const inboxNeverLoaded = !state?.inbox.lastSuccessfulAt;
  const inboxCredentialFailure = isWatchCredentialError(state?.inbox.errorCode);

  let content: React.ReactNode;
  if (!status.hasNotificationsToken) {
    content = (
      <EmptyState
        icon={<Settings2 className="size-4" />}
        title={m.watch.title}
        text={m.watch.configureNotificationsToken}
        action={<Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>}
      />
    );
  } else if (status.inboxStatus === 'error' && inboxNeverLoaded) {
    content = (
      <EmptyState
        icon={<AlertTriangle className="size-4" />}
        title={m.watch.title}
        text={inboxCredentialFailure ? m.watch.inboxPermissionDenied : m.watch.inboxFailed}
        tone="destructive"
        action={inboxCredentialFailure
          ? <Button onClick={onOpenOptions}>{m.watch.openOptions}</Button>
          : <Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.retry}</Button>}
      />
    );
  } else if (inboxNeverLoaded) {
    content = (
      <EmptyState
        icon={<RefreshCw className="size-4" />}
        title={m.watch.title}
        text={m.watch.inboxNeverLoaded}
        action={<Button onClick={onRefresh} disabled={refreshDisabled}>{m.watch.refresh}</Button>}
      />
    );
  } else if (groups.length === 0) {
    content = (
      <EmptyState
        icon={<Inbox className="size-4" />}
        title={hasPresentationFilters ? m.watch.reasonPresetAll : m.watch.watchSurface}
        text={(modeProjection?.threads.length ?? 0) > 0 && hasPresentationFilters
          ? m.watch.noMatchingThreads
          : unreadOnly ? m.watch.noUnreadThreads : m.watch.noThreads}
        tone={hasPresentationFilters ? 'muted' : 'success'}
      />
    );
  } else {
    const listEndTone = state?.inbox.truncated
      ? 'info'
      : status.inboxStatus === 'error'
        || status.inboxStatus === 'stale'
        || status.inboxStatus === 'cooldown'
        ? 'warning'
        : 'muted';
    const visibleThreadCount = visibleProjection?.threads.length ?? 0;
    const listEndText = state?.inbox.truncated
      ? m.watch.listEndWindow
      : listEndTone === 'warning'
        ? m.watch.listEndSaved(visibleThreadCount)
        : hasPresentationFilters
          ? m.watch.listEndMatches(visibleThreadCount)
          : m.watch.listEndSnapshot(visibleThreadCount);
    content = (
      <SurfaceWorkCanvas variant="watch" className="px-4 py-3 max-sm:px-3">
        <div
          className="relative flex flex-col gap-3.5 before:absolute before:bottom-3 before:left-[7px] before:top-3 before:w-px before:bg-muted-foreground/30 before:content-['']"
          data-watch-thread-list
          onKeyDown={handleThreadListKeyDown}
        >
          {groups.map((group) => {
            const repository = group.repositoryFullName.toLowerCase();
            const sourceGroup = sourceGroupsByRepository.get(repository) ?? group;
            return (
              <WatchGroup
                key={group.repositoryFullName}
                group={group}
                sourceGroup={sourceGroup}
                locale={locale}
                persistedSignature={collapsedRepositories[repository] ?? null}
                revealMatches={hasPresentationFilters}
                autoExpanded={autoExpandedRepositories[repository] === true}
                actionPending={actionPending}
                onCollapseChange={onRepositoryCollapseChange}
                onSelectRepository={onSelectRepository}
                onOpenMainTokenOptions={onOpenMainTokenOptions}
                onMarkThreadsRead={onMarkThreadsRead}
                onMarkThreadsDone={onMarkThreadsDone}
              />
            );
          })}
          <SurfaceListEndMarker
            variant="timeline"
            tone={listEndTone}
            text={listEndText}
          />
        </div>
      </SurfaceWorkCanvas>
    );
  }

  return (
    <section className="min-h-full bg-background" aria-label={m.watch.title}>
      <div
        className="gsm-z-sticky sticky top-0 border-b border-border bg-background"
        data-surface-command-bar="watch"
      >
        <SurfaceWorkCanvas
          variant="watch"
          className="flex min-h-10 min-w-0 flex-wrap items-center gap-2 px-4 py-1.5 max-sm:px-3"
        >
          <div className="relative min-w-0 flex-1 basis-72 max-[720px]:basis-full sm:max-w-md">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              {...searchInput.inputProps}
              type="search"
              name="watch-search"
              autoComplete="off"
              aria-label={m.watch.searchPlaceholder}
              placeholder={`${m.watch.searchPlaceholder}…`}
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
          <span className="min-w-0 flex-1 max-[720px]:hidden" />
          <WatchSurfaceActions
            unreadOnly={unreadOnly}
            refreshing={refreshing}
            refreshDisabled={refreshDisabled}
            onUnreadOnlyChange={onUnreadOnlyChange}
            onRefresh={onRefresh}
          />
          <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
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
        </SurfaceWorkCanvas>
      </div>
      <div
        aria-live="polite"
        aria-atomic="true"
        className={cn('border-b border-border bg-destructive/[0.07] text-xs text-destructive', {
          hidden: actionError === null,
        })}
      >
        <SurfaceWorkCanvas variant="watch" className="flex min-h-7 items-center gap-2 px-4 py-1 max-sm:px-3">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {actionError === 'read'
              ? m.watch.actionReadFailed
              : actionError === 'done' ? m.watch.actionDoneFailed : ''}
          </span>
        </SurfaceWorkCanvas>
      </div>
      {content}
    </section>
  );
}
