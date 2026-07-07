import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownAZ, ArrowUpAZ, ChevronRight, ListRestart, Search, Trash2, X, Check } from 'lucide-react';
import type { FilterState } from '@/ui/filter-store';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Input } from '@/ui/shadcn/input';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/ui/shadcn/tooltip';
import { cn } from '@/lib/utils';
import { bgCall } from '@/utils/messaging';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { useI18n } from '@/i18n';
import { getLockedRegionProps } from '@/ui/interaction-lock';

/**
 * Left filter rail: special toggles up top + collapsible Languages + flat Tags.
 * Tags keep their incoming order unless the user sorts by name.
 */
export function FilterSidebar({
  f,
  languages,
  tagTree,
  interactionLocked = false,
  onTagMutationMessage,
  onTagMutationSuccess,
}: {
  f: FilterState;
  languages: [string, number][];
  tagTree: { tags: { name: string; count: number }[]; total: number };
  interactionLocked?: boolean;
  /** Called after a tag mutation to surface a manager info/error banner. */
  onTagMutationMessage?: (message: string | null) => void;
  /** Called only after a tag mutation succeeds, so the owner can refresh data. */
  onTagMutationSuccess?: () => void;
}) {
  const { m } = useI18n();

  return (
    <div
      data-coach-target="tags"
      className={cn('flex w-52 shrink-0 flex-col gap-3 overflow-auto border-r border-border bg-card p-2 text-sm', {
        'opacity-55': interactionLocked,
      })}
      {...getLockedRegionProps(interactionLocked)}
    >
      {/* Special filters */}
      <Section title={m.filterSidebar.specialFilters}>
        <FilterToggle
          checked={f.onlyFavorite}
          onChange={() => f.setOnlyFavorite(!f.onlyFavorite)}
          label={m.filterSidebar.onlyFavoriteLabel}
          hint={m.filterSidebar.onlyFavoriteHint}
        />
        <FilterToggle
          checked={f.onlyUntagged}
          onChange={() => f.setOnlyUntagged(!f.onlyUntagged)}
          label={m.filterSidebar.onlyUntaggedLabel}
          hint={m.filterSidebar.onlyUntaggedHint}
        />
        <FilterToggle
          checked={f.onlyArchived}
          onChange={() => f.setOnlyArchived(!f.onlyArchived)}
          label={m.filterSidebar.onlyArchivedLabel}
          hint={m.filterSidebar.onlyArchivedHint}
        />
        {/* "Show unstarred" (tombstone) — disabled for now; keep commented to re-enable later.
        <FilterToggle
          checked={f.showTombstone}
          onChange={() => f.setShowTombstone(!f.showTombstone)}
          label={m.filterSidebar.showTombstoneLabel}
          hint={m.filterSidebar.showTombstoneHint}
        />
        */}
      </Section>

      {/* Languages — collapsible, collapsed by default */}
      <LanguagesSection f={f} languages={languages} />

      {/* Tags — flat list in incoming order; optional name sort and search live inside.
          tagMode (any/all) sits in the header. */}
      <TagsSection
        f={f}
        tagTree={tagTree}
        onTagMutationMessage={onTagMutationMessage}
        onTagMutationSuccess={onTagMutationSuccess}
      />
    </div>
  );
}

/** Collapsible Languages section (collapsed by default). */
function LanguagesSection({ f, languages }: { f: FilterState; languages: [string, number][] }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const queryInput = useImeBufferedInput('');
  const deferredQuery = useDeferredValue(queryInput.value);

  const list = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return q ? languages.filter(([lang]) => lang.toLowerCase().includes(q)) : languages;
  }, [deferredQuery, languages]);

  return (
    <div>
      <SectionTitle
        title={m.filterSidebar.languages(f.languages.length)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="gsm-sidebar-body-in flex flex-col gap-1">
          {languages.length > 6 && (
            <div className="gsm-sidebar-search relative mb-1">
              <Search className="gsm-sidebar-input-icon pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                {...queryInput.inputProps}
                placeholder={m.filterSidebar.languagesSearch}
                className="h-7 pl-6 pr-6 text-xs"
              />
              {queryInput.value && (
                <button
                  onClick={() => queryInput.commit('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          )}
          {list.length === 0 ? (
            <div className="px-1.5 py-2 text-center text-xs text-muted-foreground">{m.filterSidebar.languagesEmpty}</div>
          ) : (
            list.map(([lang, count]) => {
              const on = f.languages.includes(lang);
              return (
                <label
                  key={lang}
                  className={cn('gsm-sidebar-row flex cursor-pointer items-center gap-1.5 px-1.5 py-0.5 hover:bg-muted/40', {
                    'text-foreground': on,
                    'bg-muted/30': on,
                    'text-muted-foreground': !on,
                  })}
                >
                  <Checkbox checked={on} onCheckedChange={() => f.toggleLanguage(lang)} />
                  <span className="flex-1 truncate">{lang}</span>
                  <span className="gsm-muted-count-soft tabular-nums">{count}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// Flat tag list (topic-derived + user-authored), preserving incoming order unless name-sorted by the user.
const TAG_PREVIEW = 50;
const TAG_NAME_COLLATOR = new Intl.Collator(['zh-CN', 'en'], { numeric: true, sensitivity: 'base' });

function TagsSection({
  f,
  tagTree,
  onTagMutationMessage,
  onTagMutationSuccess,
}: {
  f: FilterState;
  tagTree: { tags: { name: string; count: number }[]; total: number };
  onTagMutationMessage?: (message: string | null) => void;
  onTagMutationSuccess?: () => void;
}) {
  const { m } = useI18n();
  // Tag-name search.
  const queryInput = useImeBufferedInput('');
  const deferredQuery = useDeferredValue(queryInput.value);
  // Two-step delete: a tag pending confirmation (its name). Click trash → confirm.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  // Reveal the full list past TAG_PREVIEW (search always shows all matches).
  const [showAll, setShowAll] = useState(false);
  const [sortDir, setSortDir] = useState<'default' | 'asc' | 'desc'>('default');

  // Auto-revert the delete-confirm state if the user doesn't commit within 3s,
  // so a red check button never gets stranded on a tag. Cleared on commit/escape.
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 3000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  useEffect(() => {
    if (!pendingDeleteAll) return;
    const t = setTimeout(() => setPendingDeleteAll(false), 3000);
    return () => clearTimeout(t);
  }, [pendingDeleteAll]);

  const doDelete = async (name: string) => {
    setDeleting(name);
    try {
      const { removed } = await bgCall<{ removed: number }>('deleteTag', { name });
      // If the deleted tag was an active filter, drop it so results stay coherent.
      if (f.tags.includes(name)) f.toggleTag(name);
      onTagMutationSuccess?.();
      onTagMutationMessage?.(m.filterSidebar.deleteTagDone(removed));
    } catch (e) {
      console.error('[gsm] deleteTag failed', e);
      onTagMutationMessage?.(m.manager.deleteTagFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setDeleting(null);
      setPendingDelete(null);
    }
  };

  const doDeleteAll = async () => {
    setDeletingAll(true);
    try {
      const result = await bgCall<{
        assignmentsRemoved: number;
        distinctTagsRemoved: number;
      }>('deleteAllTags');
      if (f.tags.length > 0) f.clearTags();
      onTagMutationSuccess?.();
      onTagMutationMessage?.(
        m.filterSidebar.deleteAllTagsDone(result.assignmentsRemoved, result.distinctTagsRemoved),
      );
    } catch (e) {
      console.error('[gsm] deleteAllTags failed', e);
      onTagMutationMessage?.(m.manager.deleteAllTagsFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setDeletingAll(false);
      setPendingDeleteAll(false);
    }
  };

  const sortedTags = useMemo(() => {
    if (sortDir === 'default') return tagTree.tags;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...tagTree.tags].sort((a, b) => dir * TAG_NAME_COLLATOR.compare(a.name, b.name));
  }, [sortDir, tagTree.tags]);

  const q = deferredQuery.trim().toLowerCase();
  const list = q ? sortedTags.filter(({ name }) => name.toLowerCase().includes(q)) : sortedTags;
  const visible = q || showAll ? list : list.slice(0, TAG_PREVIEW);
  const nextSortDir = sortDir === 'default' ? 'asc' : sortDir === 'asc' ? 'desc' : 'default';
  const nextSortTitle =
    nextSortDir === 'asc'
      ? m.filterSidebar.tagsSortAscTitle
      : nextSortDir === 'desc'
        ? m.filterSidebar.tagsSortDescTitle
        : m.filterSidebar.tagsSortDefaultTitle;

  // Whole Tags section is collapsible (like the Languages section above): click
  // the header to fold the list away. Defaults open. Search keeps working while
  // open; folding just hides the body.
  const [open, setOpen] = useState(true);

  return (
    <div>
      {/* Header row: collapsible title + any/all segmented toggle */}
      <div className="mb-1.5 flex items-center gap-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="gsm-meta-label flex items-center gap-1 hover:text-foreground"
        >
          <ChevronRight className={cn('size-3 transition-transform duration-150', { 'rotate-90': open })} />
          <span>{m.filterSidebar.tags(tagTree.total)}</span>
        </button>
        {tagTree.total > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSortDir((current) => (current === 'default' ? 'asc' : current === 'asc' ? 'desc' : 'default'));
                }}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors duration-150 hover:bg-muted/50 hover:text-foreground"
                title={nextSortTitle}
                aria-label={nextSortTitle}
                aria-pressed={sortDir !== 'default'}
              >
                {sortDir === 'default'
                  ? <ListRestart className="size-3.5" />
                  : sortDir === 'asc'
                    ? <ArrowDownAZ className="size-3.5" />
                    : <ArrowUpAZ className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{nextSortTitle}</TooltipContent>
          </Tooltip>
        )}
        <div className="ml-auto inline-flex items-center gap-0.5">
          {tagTree.total > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={deletingAll}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (pendingDeleteAll) void doDeleteAll();
                    else setPendingDeleteAll(true);
                  }}
                  className={cn(
                    'inline-flex size-5 shrink-0 items-center justify-center rounded leading-none transition-colors duration-150 disabled:opacity-50',
                    {
                      'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/30 hover:bg-destructive/15': pendingDeleteAll,
                      'text-muted-foreground/55 hover:bg-destructive/10 hover:text-destructive': !pendingDeleteAll,
                    },
                  )}
                  title={pendingDeleteAll ? m.filterSidebar.deleteAllTagsConfirm : m.filterSidebar.deleteAllTagsTitle}
                >
                  <ActionIcon phase={pendingDeleteAll ? 'confirm' : 'idle'}>
                    {pendingDeleteAll ? <Check className="size-3.5" /> : <Trash2 className="size-3.5" />}
                  </ActionIcon>
                </button>
              </TooltipTrigger>
              <TooltipContent>{pendingDeleteAll ? m.filterSidebar.deleteAllTagsConfirm : m.filterSidebar.deleteAllTagsTitle}</TooltipContent>
            </Tooltip>
          )}
          {(['any', 'all'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => f.setTagMode(mode)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                {
                  'bg-primary text-primary-foreground': f.tagMode === mode,
                  'text-muted-foreground hover:bg-muted/40': f.tagMode !== mode,
                },
              )}
              title={mode === 'any' ? m.filterSidebar.tagsMatchAny : m.filterSidebar.tagsMatchAll}
            >
              {mode === 'any' ? m.filterSidebar.tagsMatchAny : m.filterSidebar.tagsMatchAll}
            </button>
          ))}
        </div>
      </div>

      {open && (tagTree.tags.length === 0 ? (
        <div className="gsm-sidebar-body-in text-xs leading-relaxed text-muted-foreground">
          {m.filterSidebar.noTagsPrefix} <b className="text-foreground">{m.filterSidebar.noTagsEmphasis}</b> {m.filterSidebar.noTagsSuffix}
        </div>
      ) : (
        <div className="gsm-sidebar-body-in">
          {/* Tag search box */}
          <div className="gsm-sidebar-search relative mb-1.5">
            <Search className="gsm-sidebar-input-icon pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              {...queryInput.inputProps}
              placeholder={m.filterSidebar.tagsFilter}
              className="h-7 pl-6 pr-6 text-xs"
            />
            {queryInput.value && (
              <button
                onClick={() => queryInput.commit('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <div className="flex flex-col gap-1">
            {visible.map(({ name, count }) => {
              const on = f.tags.includes(name);
              const isPending = pendingDelete === name;
              const isBusy = deleting === name;
              return (
                <div
                  key={name}
                  // Whole row toggles the tag filter (not just the checkbox).
                  // The delete/confirm button stops propagation so it never filters.
                  onClick={() => f.toggleTag(name)}
                  className={cn(
                    'gsm-sidebar-row group/tag flex cursor-pointer items-center gap-1.5 px-1.5 py-0.5 hover:bg-muted/40',
                    {
                      'text-foreground': on,
                      'bg-muted/30': on,
                      'text-muted-foreground': !on,
                      'bg-destructive/10 ring-1 ring-inset ring-destructive/30': isPending,
                    },
                  )}
                >
                  {/* Visual-only checkbox: pointer-events-none so clicks fall through
                      to the row (avoids a double-toggle when clicking the box itself). */}
                  <Checkbox checked={on} className="pointer-events-none" />
                  <span className="flex-1 truncate">{name}</span>
                  <span className="gsm-muted-count-soft tabular-nums">{count}</span>
                  {/* Delete: hover shows trash → click turns red check to confirm →
                      click again submits; 3s auto-revert. Icon via ActionIcon
                      remount + color crossfade. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        disabled={isBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isPending) void doDelete(name);
                          else setPendingDelete(name);
                        }}
                        className={cn(
                          'inline-flex shrink-0 items-center justify-center rounded p-0.5 leading-none transition-colors duration-150 disabled:opacity-50',
                          {
                            'text-destructive hover:bg-destructive/15': isPending,
                            'text-muted-foreground/0 hover:text-destructive hover:bg-destructive/10 group-hover/tag:text-muted-foreground/40': !isPending,
                          },
                        )}
                        title={isPending ? m.filterSidebar.deleteTagConfirm(name, count) : m.filterSidebar.deleteTagTitle}
                      >
                        <ActionIcon phase={isPending ? 'confirm' : 'idle'}>
                          {isPending ? <Check className="size-3.5" /> : <Trash2 className="size-3.5" />}
                        </ActionIcon>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{isPending ? m.filterSidebar.deleteTagConfirm(name, count) : m.filterSidebar.deleteTagTitle}</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
            {/* Reveal the rest of a long list (search already shows all matches). */}
            {!q && !showAll && list.length > TAG_PREVIEW && (
              <button
                onClick={() => setShowAll(true)}
                className="gsm-muted-count mt-0.5 text-center hover:text-foreground"
              >
                {m.filterSidebar.tagsShowAll(list.length)}
              </button>
            )}
            {/* Search produced no matches. */}
            {q && visible.length === 0 && (
              <div className="px-1.5 py-2 text-center text-xs text-muted-foreground">{m.filterSidebar.tagsEmpty}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Collapsible section header with a chevron. */
function SectionTitle({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="gsm-meta-label mb-1.5 flex w-full items-center gap-1 hover:text-foreground"
    >
      <ChevronRight className={cn('size-3 transition-transform duration-150', { 'rotate-90': open })} />
      <span>{title}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="gsm-meta-label mb-1.5">{title}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function FilterToggle({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label
      className={cn('gsm-sidebar-row flex cursor-pointer items-center gap-1.5 px-1 py-0.5 hover:bg-muted/40', {
        'text-foreground': checked,
        'bg-muted/30': checked,
        'text-muted-foreground': !checked,
      })}
    >
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <span className="whitespace-nowrap">{label}</span>
      {hint && <span className="gsm-muted-count-soft ml-auto whitespace-nowrap">{hint}</span>}
    </label>
  );
}
