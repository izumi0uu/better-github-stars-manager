import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Search, Trash2, X, Check } from 'lucide-react';
import type { FilterState } from '@/ui/filter-store';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Input } from '@/ui/shadcn/input';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/ui/shadcn/tooltip';
import { cn } from '@/lib/utils';
import { bgCall } from '@/utils/messaging';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { useI18n } from '@/i18n';

/**
 * Left filter rail: special toggles up top + collapsible Languages + flat Tags
 * (sorted by use count, hover to delete). tagMode (any/all) sits in Tags header.
 */
export function FilterSidebar({
  f,
  languages,
  tagTree,
  onTagDeleted,
}: {
  f: FilterState;
  languages: [string, number][];
  tagTree: { tags: { name: string; count: number }[]; total: number };
  /** Called after a tag delete attempt. Receives a status message (success/failure)
   *  to surface in the manager info banner, or null to leave it untouched. */
  onTagDeleted?: (message: string | null) => void;
}) {
  const { m } = useI18n();

  return (
    <div data-coach-target="tags" className="flex w-52 shrink-0 flex-col gap-3 overflow-auto border-r border-border bg-card p-2 text-sm">
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

      {/* Tags — flat list sorted by count; a search box filters it.
          tagMode (any/all) sits in the header. */}
      <TagsSection f={f} tagTree={tagTree} onTagDeleted={onTagDeleted} />
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
        <div className="flex flex-col gap-1">
          {languages.length > 6 && (
            <div className="relative mb-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
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
                <label key={lang} className={cn('flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted/40', on ? 'text-foreground' : 'text-muted-foreground')}>
                  <Checkbox checked={on} onCheckedChange={() => f.toggleLanguage(lang)} />
                  <span className="flex-1 truncate">{lang}</span>
                  <span className="tabular-nums text-[10px] text-muted-foreground/70">{count}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// Flat tag list (topic-derived + user-authored), sorted by count; previews top TAG_PREVIEW with a "show all" button, search overrides the preview.
const TAG_PREVIEW = 50;

function TagsSection({
  f,
  tagTree,
  onTagDeleted,
}: {
  f: FilterState;
  tagTree: { tags: { name: string; count: number }[]; total: number };
  onTagDeleted?: (message: string | null) => void;
}) {
  const { m } = useI18n();
  // Tag-name search.
  const queryInput = useImeBufferedInput('');
  const deferredQuery = useDeferredValue(queryInput.value);
  // Two-step delete: a tag pending confirmation (its name). Click trash → confirm.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Reveal the full list past TAG_PREVIEW (search always shows all matches).
  const [showAll, setShowAll] = useState(false);

  // Auto-revert the delete-confirm state if the user doesn't commit within 3s,
  // so a red check button never gets stranded on a tag. Cleared on commit/escape.
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 3000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  const doDelete = async (name: string) => {
    setDeleting(name);
    try {
      const { removed } = await bgCall<{ removed: number }>('deleteTag', { name });
      // If the deleted tag was an active filter, drop it so results stay coherent.
      if (f.tags.includes(name)) f.toggleTag(name);
      onTagDeleted?.(m.filterSidebar.deleteTagDone(removed));
    } catch (e) {
      console.error('[gsm] deleteTag failed', e);
      onTagDeleted?.(m.manager.deleteTagFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setDeleting(null);
      setPendingDelete(null);
    }
  };

  const q = deferredQuery.trim().toLowerCase();
  const list = q ? tagTree.tags.filter(({ name }) => name.toLowerCase().includes(q)) : tagTree.tags;
  const visible = q || showAll ? list : list.slice(0, TAG_PREVIEW);

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
          className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span>{m.filterSidebar.tags(tagTree.total)}</span>
        </button>
        <div className="ml-auto inline-flex items-center gap-0.5">
          {(['any', 'all'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => f.setTagMode(mode)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                f.tagMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/40',
              )}
              title={mode === 'any' ? m.filterSidebar.tagsMatchAny : m.filterSidebar.tagsMatchAll}
            >
              {mode === 'any' ? m.filterSidebar.tagsMatchAny : m.filterSidebar.tagsMatchAll}
            </button>
          ))}
        </div>
      </div>

      {open && (tagTree.tags.length === 0 ? (
        <div className="text-xs leading-relaxed text-muted-foreground">
          {m.filterSidebar.noTagsPrefix} <b className="text-foreground">{m.filterSidebar.noTagsEmphasis}</b> {m.filterSidebar.noTagsSuffix}
        </div>
      ) : (
        <>
          {/* Tag search box */}
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
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
                    'group/tag flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted/40',
                    on ? 'text-foreground' : 'text-muted-foreground',
                    isPending && 'bg-destructive/10 ring-1 ring-inset ring-destructive/30',
                  )}
                >
                  {/* Visual-only checkbox: pointer-events-none so clicks fall through
                      to the row (avoids a double-toggle when clicking the box itself). */}
                  <Checkbox checked={on} className="pointer-events-none" />
                  <span className="flex-1 truncate">{name}</span>
                  <span className="tabular-nums text-[10px] text-muted-foreground/70">{count}</span>
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
                          isPending
                            ? 'text-destructive hover:bg-destructive/15'
                            : 'text-muted-foreground/0 hover:text-destructive hover:bg-destructive/10 group-hover/tag:text-muted-foreground/40',
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
                className="mt-0.5 text-center text-[10px] text-muted-foreground hover:text-foreground"
              >
                {m.filterSidebar.tagsShowAll(list.length)}
              </button>
            )}
            {/* Search produced no matches. */}
            {q && visible.length === 0 && (
              <div className="px-1.5 py-2 text-center text-xs text-muted-foreground">{m.filterSidebar.tagsEmpty}</div>
            )}
          </div>
        </>
      ))}
    </div>
  );
}

/** Collapsible section header with a chevron. */
function SectionTitle({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="mb-1.5 flex w-full items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
    >
      {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      <span>{title}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function FilterToggle({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/40', checked ? 'text-foreground' : 'text-muted-foreground')}>
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <span className="whitespace-nowrap">{label}</span>
      {hint && <span className="ml-auto whitespace-nowrap text-[10px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}
