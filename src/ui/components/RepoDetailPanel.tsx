import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X, Archive, Star as StarIcon, Check } from 'lucide-react';
import type { Star, Tag } from '@/types';
import { suggestTags } from '@/ui/suggest';
import { bgCall } from '@/utils/messaging';
import { TagEditor } from './TagEditor';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { Textarea } from '@/ui/shadcn/textarea';
import { Separator } from '@/ui/shadcn/separator';
import { Spinner } from '@/ui/shadcn/spinner';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

/**
 * Right-side detail drawer for a single repo. Deep editing (tags + notes +
 * suggestions) lives here so list rows stay compact. Aside in the flex layout —
 * no portal, no reflow of the virtual list. Prev/next + Esc/[/] navigation.
 */
export function RepoDetailPanel({
  star,
  tag,
  selectedTags,
  onToggleTag,
  onDataChanged,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: {
  star: Star;
  tag: Tag | undefined;
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onDataChanged?: () => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}) {
  const myTags = tag?.tags ?? [];
  const notes = tag?.notes ?? '';
  const { m } = useI18n();

  // Deleted tags (tombstones) — fetched once per opened repo so suggestions don't
  // re-offer a tag the user removed. suggestTags skips these (resurrection guard).
  const [excluded, setExcluded] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    bgCall<string[]>('listExcluded')
      .then((names) => { if (!cancelled) setExcluded(names ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const suggestions = suggestTags(star, myTags, excluded);

  const [draft, setDraft] = useState(notes);
  const [saved, setSaved] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [accepting, setAccepting] = useState(false);
  useEffect(() => {
    setDraft(notes);
    setSaved(false);
  }, [star.full_name, notes]);

  const saveNotes = async () => {
    if (draft !== notes) {
      setSavingNotes(true);
      try {
        await bgCall('setNotes', { full_name: star.full_name, notes: draft });
        onDataChanged?.();
        setSaved(true);
      } finally {
        setSavingNotes(false);
      }
    }
  };

  const acceptSuggestions = async () => {
    if (suggestions.length === 0) return;
    setAccepting(true);
    try {
      await bgCall('acceptSuggestions', { full_name: star.full_name, toAdd: suggestions });
      onDataChanged?.();
    } finally {
      setAccepting(false);
    }
  };

  // Keyboard nav (Esc close, [ / ] prev/next) — ignored while typing in fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') onClose();
      else if (e.key === '[' && hasPrev) onPrev();
      else if (e.key === ']' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  const selectedSet = new Set(selectedTags);

  return (
    // Width/opacity animation is handled by the parent container in ManagerPanel
    // (drawer-anim); this is just the inner content, full-height.
    <div className="flex h-full w-[340px] flex-col overflow-auto border-l border-border bg-card">
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <Button variant="ghost" size="icon" onClick={onPrev} disabled={!hasPrev} title={m.repoDetail.previousTitle} className={cn(!hasPrev && 'opacity-30')}><ChevronLeft className="size-4" /></Button>
        <Button variant="ghost" size="icon" onClick={onNext} disabled={!hasNext} title={m.repoDetail.nextTitle} className={cn(!hasNext && 'opacity-30')}><ChevronRight className="size-4" /></Button>
        <span className="flex-1" />
        <Button variant="ghost" size="icon" onClick={onClose} title={m.repoDetail.closeTitle}><X className="size-4" /></Button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        {/* Title + link */}
        <div>
          <a href={star.html_url} target="_blank" rel="noreferrer" className="break-all text-[13px] font-semibold text-primary no-underline hover:underline">
            {star.full_name}
          </a>
          <div className="mt-0.5 flex gap-2">
            {star.archived && (
              <span className="inline-flex items-center gap-1 text-xs text-warning" title={m.starRow.archived}>
                <Archive className="size-3" />
                {m.starRow.archived}
              </span>
            )}
          </div>
        </div>

        {/* Meta grid */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <Meta label={m.repoDetail.language} value={star.language ?? m.common.none} />
          <Meta
            label={m.repoDetail.stars}
            value={
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <StarIcon className="size-3 fill-current" />
                {fmt(star.stargazers_count)}
              </span>
            }
          />
          <Meta label={m.repoDetail.updated} value={star.pushed_at.slice(0, 10)} />
          <Meta label={m.repoDetail.starred} value={star.starred_at.slice(0, 10)} />
        </div>

        {star.description && (
          <>
            <Separator />
            <Section title={m.repoDetail.description}>
              <p className="m-0 text-xs leading-relaxed text-foreground">{star.description}</p>
            </Section>
          </>
        )}

        {star.topics.length > 0 && (
          <>
            <Separator />
            <Section title={m.repoDetail.topics(star.topics.length)}>
              <div className="flex flex-wrap gap-1">
                {star.topics.map((t) => (
                  <button key={t} onClick={() => onToggleTag(t)} title={m.repoDetail.filterTopic}>
                    <Badge variant={selectedSet.has(t) ? 'tagActive' : 'tag'} className="cursor-pointer hover:opacity-80">{t}</Badge>
                  </button>
                ))}
              </div>
            </Section>
          </>
        )}

        {suggestions.length > 0 && (
          <>
            <Separator />
            <Section title={m.repoDetail.suggestedTags}>
              <div className="flex flex-wrap items-center gap-1">
                {suggestions.map((t) => (
                  <Badge key={t} variant="outline" className="opacity-70 [border-style:dashed]">{t}</Badge>
                ))}
                <Button variant="outline" size="sm" onClick={() => void acceptSuggestions()} title={m.repoDetail.acceptAllTitle} disabled={accepting}>
                  {accepting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      {m.repoDetail.acceptAll}
                    </>
                  ) : (
                    m.repoDetail.acceptAll
                  )}
                </Button>
              </div>
            </Section>
          </>
        )}

        <Separator />
        <Section title={m.repoDetail.tags(myTags.length)}>
          <TagEditor full_name={star.full_name} tags={myTags} selectedTags={selectedTags} onToggleTag={onToggleTag} onDataChanged={onDataChanged} />
        </Section>

        <Separator />
        <Section title={m.repoDetail.notes}>
          <Textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
            onBlur={saveNotes}
            placeholder={m.repoDetail.notesPlaceholder}
            rows={4}
            disabled={savingNotes}
          />
          <div className="mt-0.5 h-3 text-[10px] text-muted-foreground">
            {savingNotes ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Spinner className="size-3" />
                {m.common.loading}
              </span>
            ) : saved ? (
              <span className="inline-flex items-center gap-1 text-success">
                <Check className="size-3" />
                {m.repoDetail.notesSaved}
              </span>
            ) : draft !== notes ? m.repoDetail.notesUnsaved : ''}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground/70">{label}</div>
      <div className="text-foreground">{value}</div>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
