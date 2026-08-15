import { BookOpen, ChevronDown } from 'lucide-react';
import { useI18n } from '@/i18n';

import { cn } from '@/lib/utils';
import { RepositoryOwnerAvatar } from '@/ui/components/RepositoryOwnerAvatar';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import { formatWatchRelativeTime } from '@/ui/watch-inbox-presentation';
import type { WatchThreadActionPending } from '@/ui/watch-inbox-types';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';

export function WatchRepositoryHeader({
  group,
  sourceGroup,
  expanded,
  revealMatches,
  autoExpanded,
  actionPending,
  onToggleExpanded,
  onSelectRepository,
  onMarkThreadsRead,
  onMarkThreadsDone,
}: {
  group: WatchInboxQueryResponse['groups'][number];
  sourceGroup: WatchInboxQueryResponse['groups'][number];
  expanded: boolean;
  revealMatches: boolean;
  autoExpanded: boolean;
  actionPending: WatchThreadActionPending | null;
  onToggleExpanded: () => void;
  onSelectRepository?: (fullName: string) => void;
  onMarkThreadsRead: (ids: readonly string[]) => void;
  onMarkThreadsDone: (ids: readonly string[]) => void;
}) {
  const { m } = useI18n();
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

  return (
    <section
      className={cn('relative bg-background', { 'gsm-watch-auto-expanded': autoExpanded })}
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
          aria-label={expanded
            ? m.watch.collapseRepository(group.repositoryFullName)
            : m.watch.expandRepository(group.repositoryFullName)}
          disabled={revealMatches}
          onClick={onToggleExpanded}
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
    </section>
  );
}
