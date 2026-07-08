import type { FilterState } from '@/ui/filter-store';
import { X } from 'lucide-react';
import { Badge } from '@/ui/shadcn/badge';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { getLockedRegionProps } from '@/ui/interaction-lock';

export function ActiveFilterChips({
  f,
  count,
  interactionLocked = false,
}: {
  f: FilterState;
  count: number;
  interactionLocked?: boolean;
}) {
  const { m } = useI18n();
  const active: { label: string; clear: () => void; kind: 'lang' | 'tag' | 'special' }[] = [];
  for (const lang of f.languages) {
    active.push({ label: lang, clear: () => f.toggleLanguage(lang), kind: 'lang' });
  }
  for (const tag of f.tags) {
    active.push({ label: tag, clear: () => f.toggleTag(tag), kind: 'tag' });
  }
  if (f.onlyFavorite) active.push({ label: m.activeFilters.onlyFavorite, clear: () => f.setOnlyFavorite(false), kind: 'special' });
  if (f.onlyUntagged) active.push({ label: m.activeFilters.onlyUntagged, clear: () => f.setOnlyUntagged(false), kind: 'special' });
  if (f.onlyArchived) active.push({ label: m.activeFilters.onlyArchived, clear: () => f.setOnlyArchived(false), kind: 'special' });
  if (f.onlyWatched) active.push({ label: m.activeFilters.onlyWatched, clear: () => f.setOnlyWatched(false), kind: 'special' });
  for (const reason of f.watchReasons) {
    active.push({
      label: m.activeFilters.watchReason(m.watchReasonLabels[reason]),
      clear: () => f.toggleWatchReason(reason),
      kind: 'special',
    });
  }

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1 bg-muted/30 px-3 py-1', {
        'opacity-55': interactionLocked,
      })}
      {...getLockedRegionProps(interactionLocked)}
    >
      <span className="gsm-muted-count mr-1">{m.activeFilters.summary(count)}</span>
      {active.map((a, i) => (
        <button key={`${a.label}-${i}`} disabled={interactionLocked} onClick={a.clear} title={m.activeFilters.clearOne}>
          <Badge
            variant={a.kind === 'tag' ? 'default' : 'secondary'}
            className={cn(
              'cursor-pointer gap-1 hover:opacity-80',
              { 'border-warning/40 bg-warning/10 text-warning': a.kind === 'special' },
            )}
          >
            {a.label}
            <X className="size-3 opacity-60" />
          </Badge>
        </button>
      ))}
      <button
        disabled={interactionLocked}
        onClick={() => f.resetFilters()}
        className="gsm-helper-text ml-1 underline hover:text-foreground disabled:no-underline disabled:opacity-70"
        title={m.activeFilters.clearAll}
      >
        {m.activeFilters.clearAll}
      </button>
    </div>
  );
}
