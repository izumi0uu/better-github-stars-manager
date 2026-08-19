import { ListFilter, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '@/i18n';

import { cn } from '@/lib/utils';
import { SurfaceWorkCanvas } from '@/ui/components/SurfaceWorkCanvas';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Input } from '@/ui/shadcn/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Spinner } from '@/ui/shadcn/spinner';
import { ManagerResourceLink } from '@/ui/components/ManagerResource';
import {
  watchReasonPresetValues,
  type WatchInboxViewMode,
  type WatchReasonCount,
  type WatchReasonPreset,
} from '@/ui/watch-inbox-presentation';
import type { WatchInboxSearchInput } from '@/ui/watch-inbox-types';
interface WatchSurfaceActionsProps {
  viewMode: WatchInboxViewMode;
  onViewModeChange: (viewMode: WatchInboxViewMode) => void;
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

function WatchSurfaceActions({
  viewMode,
  onViewModeChange,
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
        aria-label={m.watch.viewLabel}
      >
        {(['timeline', 'repository'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={viewMode === candidate}
            onClick={() => onViewModeChange(candidate)}
            className={cn('h-[22px] rounded-sm px-2.5 text-[11px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', {
              'bg-card text-foreground shadow-sm': viewMode === candidate,
            })}
          >
            {candidate === 'timeline' ? m.watch.timelineView : m.watch.repositoryView}
          </button>
        ))}
      </div>
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

interface WatchInboxCommandBarProps {
  searchInput: WatchInboxSearchInput;
  reasonCounts: readonly WatchReasonCount[];
  selectedReasons: readonly string[];
  onSelectedReasonsChange: (reasons: string[]) => void;
  viewMode: WatchInboxViewMode;
  onViewModeChange: (viewMode: WatchInboxViewMode) => void;
  unreadOnly: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onRefresh: () => void;
}

export function WatchInboxCommandBar({
  searchInput,
  reasonCounts,
  selectedReasons,
  onSelectedReasonsChange,
  viewMode,
  onViewModeChange,
  unreadOnly,
  refreshing,
  refreshDisabled,
  onUnreadOnlyChange,
  onRefresh,
}: WatchInboxCommandBarProps) {
  const { m } = useI18n();

  return (
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
          onSelectedReasonsChange={onSelectedReasonsChange}
        />
        <span className="min-w-0 flex-1 max-[720px]:hidden" />
        <WatchSurfaceActions
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          unreadOnly={unreadOnly}
          refreshing={refreshing}
          refreshDisabled={refreshDisabled}
          onUnreadOnlyChange={onUnreadOnlyChange}
          onRefresh={onRefresh}
        />
        <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
          <ManagerResourceLink
            resource={{ kind: 'subject', label: 'watch-settings', remoteUrl: 'https://github.com/watching' }}
            aria-label={m.watch.manageOnGitHub}
            title={m.watch.manageOnGitHub}
          >
            <Settings2 className="size-4" aria-hidden="true" />
          </ManagerResourceLink>
        </Button>
      </SurfaceWorkCanvas>
    </div>
  );
}
