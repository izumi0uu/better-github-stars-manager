import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Search, Trash2, X, Check } from 'lucide-react';
import type { FilterState } from '@/ui/filter-store';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Input } from '@/ui/shadcn/input';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/ui/shadcn/tooltip';
import { cn } from '@/lib/utils';
import { bgCall } from '@/utils/messaging';
import { useI18n } from '@/i18n';

/**
 * Left filter sidebar. Special toggles up top; Languages is a collapsible
 * section (collapsed by default); Tags is grouped by dimension with a per-tag
 * hover delete (removes the tag from every repo). tagMode (any/all) sits in the
 * Tags header. A small search box filters the inline tag list.
 */
export function FilterSidebar({
  f,
  languages,
  tagTree,
  onTagDeleted,
}: {
  f: FilterState;
  languages: [string, number][];
  tagTree: { grouped: Map<string | null, { name: string; count: number }[]>; total: number };
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

      {/* Tags — inline, grouped by dimension, collapsible per group; no cap.
          tagMode (any/all) sits in the header; a search box filters the list. */}
      <TagsSection f={f} tagTree={tagTree} onTagDeleted={onTagDeleted} />
    </div>
  );
}

/** Collapsible Languages section (collapsed by default). */
function LanguagesSection({ f, languages }: { f: FilterState; languages: [string, number][] }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? languages.filter(([lang]) => lang.toLowerCase().includes(q)) : languages;
  }, [languages, query]);

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
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={m.filterSidebar.languagesSearch}
                className="h-7 pl-6 pr-6 text-xs"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
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

function TagsSection({
  f,
  tagTree,
  onTagDeleted,
}: {
  f: FilterState;
  tagTree: { grouped: Map<string | null, { name: string; count: number }[]>; total: number };
  onTagDeleted?: (message: string | null) => void;
}) {
  const { m } = useI18n();
  // Render grouped dimensions first (Language / Topic / …), then the headerless
  // "no dimension" bucket last so manual tags don't get sandwiched between groups.
  const entries = useMemo(() => {
    const all = [...tagTree.grouped.entries()];
    const grouped = all.filter(([d]) => d !== null);
    const none = all.filter(([d]) => d === null);
    return [...grouped, ...none];
  }, [tagTree]);
  // Track which dimension groups are collapsed. null = the "no dimension" group.
  const [collapsed, setCollapsed] = useState<Set<string | null>>(new Set());
  // Tag-name search across all dimensions.
  const [query, setQuery] = useState('');
  // Two-step delete: a tag pending confirmation (its name). Click trash → confirm.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const toggle = (dim: string | null) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      next.has(dim) ? next.delete(dim) : next.add(dim);
      return next;
    });

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

  const q = query.trim().toLowerCase();

  return (
    <div>
      {/* Header row: title + any/all segmented toggle */}
      <div className="mb-1.5 flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{m.filterSidebar.tags(tagTree.total)}</span>
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

      {entries.length === 0 ? (
        <div className="text-xs leading-relaxed text-muted-foreground">
          {m.filterSidebar.noTagsPrefix} <b className="text-foreground">{m.filterSidebar.noTagsEmphasis}</b> {m.filterSidebar.noTagsSuffix}
        </div>
      ) : (
        <>
          {/* Tag search box */}
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={m.filterSidebar.tagsFilter}
              className="h-7 pl-6 pr-6 text-xs"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <div className="flex flex-col gap-1">
            {entries.map(([dim, tags]) => {
              const filtered = q ? tags.filter(({ name }) => name.toLowerCase().includes(q)) : tags;
              if (filtered.length === 0) return null;
              const isCollapsed = q ? false : collapsed.has(dim); // search overrides collapse
              return (
                <div key={dim ?? '__none'}>
                  {dim && (
                    <button
                      onClick={() => toggle(dim)}
                      className="mb-0.5 flex w-full items-center gap-1 px-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 hover:text-foreground"
                    >
                      {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                      <span>{m.filterSidebar.dimensionLabel(dim)}</span>
                    </button>
                  )}
                  {!isCollapsed &&
                    filtered.map(({ name, count }) => {
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
                          {/* Delete: hover reveals a trash icon → click morphs to a red CHECK
                              confirm button (the transition state) → click the check to commit.
                              Auto-reverts after 3s (see the pendingDelete effect). One stable
                              button throughout: the icon swaps (Trash2 ↔ Check via ActionIcon,
                              key remount + fade-in) and the color crossfades (muted ↔
                              destructive via transition-colors) so the morph reads as a smooth
                              transition, not a hard swap. */}
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
                </div>
              );
            })}
            {/* Search produced no matches across any dimension. */}
            {q && entries.every(([, tags]) => tags.every(({ name }) => !name.toLowerCase().includes(q))) && (
              <div className="px-1.5 py-2 text-center text-xs text-muted-foreground">{m.filterSidebar.tagsEmpty}</div>
            )}
          </div>
        </>
      )}
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
