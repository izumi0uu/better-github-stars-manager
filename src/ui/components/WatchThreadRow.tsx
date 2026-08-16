import {
  Bell,
  ChevronDown,
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  MessageCircle,
  ShieldAlert,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Streamdown } from 'streamdown';
import { useI18n } from '@/i18n';

import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/ui/hooks/use-prefers-reduced-motion';
import { useWatchSubjectDetails } from '@/ui/hooks/use-watch-subject-details';
import { ManagerResourceLink } from '@/ui/components/ManagerResource';
import { useManagerNow } from '@/ui/manager-runtime-context';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import {
  formatWatchAbsoluteTime,
  formatWatchRelativeTime,
} from '@/ui/watch-inbox-presentation';
import type { WatchThreadActionPending } from '@/ui/watch-inbox-types';
import {
  notificationSubjectTypeLabel,
  type GitHubNotificationThread,
  type WatchSubjectDetail,
} from '@/watch/watch-model';

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
  href = '#',
  ...props
}: ComponentProps<'a'> & { node?: unknown }) {
  return (
    <ManagerResourceLink
      {...props}
      resource={{ kind: 'subject', label: 'watch-markdown-link', remoteUrl: href }}
    >
      {children}
    </ManagerResourceLink>
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
  const created = formatWatchAbsoluteTime(detail.createdAt, locale) ?? detail.createdAt;
  const updated = formatWatchAbsoluteTime(detail.updatedAt, locale) ?? detail.updatedAt;
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
        <ManagerResourceLink
          className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          resource={{ kind: 'actor', login: detail.author.login, remoteUrl: detail.author.htmlUrl }}
        >
          {m.watch.subjectAuthor(detail.author.login)}
        </ManagerResourceLink>
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
export function WatchThreadRow({
  thread,
  locale,
  expanded,
  focusRequested,
  actionPending,
  onExpandedChange,
  onFocusRequestHandled,
  onOpenMainTokenOptions,
  onMarkThreadsRead,
  onMarkThreadsDone,
}: {
  thread: GitHubNotificationThread;
  locale: string;
  expanded: boolean;
  focusRequested: boolean;
  actionPending: WatchThreadActionPending | null;
  onExpandedChange: (expanded: boolean) => void;
  onFocusRequestHandled: (threadId: string) => void;
  onOpenMainTokenOptions: () => void;
  onMarkThreadsRead: (ids: readonly string[]) => void;
  onMarkThreadsDone: (ids: readonly string[]) => void;
}) {
  const { m } = useI18n();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const now = useManagerNow();
  const [keyboardTransition, setKeyboardTransition] = useState(false);
  const target = thread.subjectHtmlUrl ?? thread.repositoryHtmlUrl;
  const updated = formatWatchRelativeTime(thread.updatedAt, now);
  const updatedTitle = formatWatchAbsoluteTime(thread.updatedAt, locale);
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
    if (!focusRequested) return;
    buttonRef.current?.focus();
    onFocusRequestHandled(thread.id);
  }, [focusRequested, onFocusRequestHandled, thread.id]);

  const toggleExpanded = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const keyboard = event.detail === 0;
    setKeyboardTransition(keyboard);
    onExpandedChange(!expanded);
    if (keyboard) requestAnimationFrame(() => setKeyboardTransition(false));
  };

  return (
    <article className="min-w-0" data-watch-thread-row={thread.id}>
      <button
        ref={buttonRef}
        id={disclosureId}
        type="button"
        data-watch-thread={thread.id}
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
                  <ManagerResourceLink
                    resource={{ kind: 'subject', label: subjectType, remoteUrl: target }}
                    title={m.watch.openSubjectOnGitHub(subjectType)}
                  >
                    <span className="min-w-0 truncate">{m.watch.openSubjectOnGitHub(subjectType)}</span>
                  </ManagerResourceLink>
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
