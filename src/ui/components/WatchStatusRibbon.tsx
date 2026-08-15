import { X } from 'lucide-react';
import { useI18n } from '@/i18n';

import { cn } from '@/lib/utils';
import { useDismissableNotice } from '@/ui/hooks/use-dismissable-notice';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import {
  deriveWatchStatusPresentation,
  formatWatchAbsoluteTime,
} from '@/ui/watch-inbox-presentation';
import type { WatchInboxProps } from '@/ui/watch-inbox-types';

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
  const snapshotAt = formatWatchAbsoluteTime(presentation.snapshotAt, locale);
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
        const cooldownUntil = formatWatchAbsoluteTime(state?.inbox.nextAllowedAt ?? null, locale);
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
