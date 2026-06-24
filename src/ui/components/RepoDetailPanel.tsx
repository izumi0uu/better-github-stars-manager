import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X, Archive, Star as StarIcon, Check } from 'lucide-react';
import type { Star, Tag } from '@/types';
import { suggestTags } from '@/ui/suggest';
import { bgCall } from '@/utils/messaging';
import { TagEditor } from './TagEditor';
import { SaveActionButton, type SaveActionPhase } from './save-action-button';
import { mergeTagNames, sameTagNames } from './tag-draft';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { Textarea } from '@/ui/shadcn/textarea';
import { Separator } from '@/ui/shadcn/separator';
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

  const [excluded, setExcluded] = useState<string[]>([]);
  const [draftTags, setDraftTags] = useState(myTags);
  const [draftNotes, setDraftNotes] = useState(notes);
  const [tagsSavePhase, setTagsSavePhase] = useState<SaveActionPhase>('idle');
  const [notesSavePhase, setNotesSavePhase] = useState<SaveActionPhase>('idle');
  const draftTagsRef = useRef(myTags);
  const draftNotesRef = useRef(notes);
  const tagsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    bgCall<string[]>('listExcluded')
      .then((names) => {
        if (!cancelled) setExcluded(names ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    draftTagsRef.current = myTags;
    draftNotesRef.current = notes;
    setDraftTags(myTags);
    setDraftNotes(notes);
    resetSavePhase(setTagsSavePhase, tagsTimerRef);
    resetSavePhase(setNotesSavePhase, notesTimerRef);
  }, [star.full_name, myTags, notes]);

  useEffect(() => () => {
    if (tagsTimerRef.current) clearTimeout(tagsTimerRef.current);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
  }, []);

  const suggestions = suggestTags(star, draftTags, excluded);
  const tagsDirty = !sameTagNames(draftTags, myTags);
  const notesDirty = draftNotes !== notes;

  const updateDraftTags = (nextTags: string[]) => {
    draftTagsRef.current = nextTags;
    resetSavePhase(setTagsSavePhase, tagsTimerRef);
    setDraftTags(nextTags);
  };

  const updateDraftNotes = (nextNotes: string) => {
    draftNotesRef.current = nextNotes;
    resetSavePhase(setNotesSavePhase, notesTimerRef);
    setDraftNotes(nextNotes);
  };

  const saveTags = async () => {
    const nextTags = draftTagsRef.current;
    if (sameTagNames(nextTags, myTags)) return;

    let ok = false;
    setTagsSavePhase('busy');
    try {
      await bgCall('setTags', { full_name: star.full_name, tags: nextTags });
      onDataChanged?.();
      ok = true;
      flashSaved(setTagsSavePhase, tagsTimerRef);
    } finally {
      if (!ok) setTagsSavePhase('idle');
    }
  };

  const saveNotes = async () => {
    const nextNotes = draftNotesRef.current;
    if (nextNotes === notes) return;

    let ok = false;
    setNotesSavePhase('busy');
    try {
      await bgCall('setNotes', { full_name: star.full_name, notes: nextNotes });
      onDataChanged?.();
      ok = true;
      flashSaved(setNotesSavePhase, notesTimerRef);
    } finally {
      if (!ok) setNotesSavePhase('idle');
    }
  };

  const acceptSuggestions = () => {
    if (suggestions.length === 0) return;
    updateDraftTags(mergeTagNames(draftTagsRef.current, suggestions));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tagName = (e.target as HTMLElement)?.tagName;
      if (tagName === 'INPUT' || tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') onClose();
      else if (e.key === '[' && hasPrev) onPrev();
      else if (e.key === ']' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  const selectedSet = new Set(selectedTags);

  return (
    <div className="flex h-full w-[340px] flex-col overflow-auto border-l border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <Button variant="ghost" size="icon" onClick={onPrev} disabled={!hasPrev} title={m.repoDetail.previousTitle} className={cn(!hasPrev && 'opacity-30')}><ChevronLeft className="size-4" /></Button>
        <Button variant="ghost" size="icon" onClick={onNext} disabled={!hasNext} title={m.repoDetail.nextTitle} className={cn(!hasNext && 'opacity-30')}><ChevronRight className="size-4" /></Button>
        <span className="flex-1" />
        <Button variant="ghost" size="icon" onClick={onClose} title={m.repoDetail.closeTitle}><X className="size-4" /></Button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        <div>
          <a href={star.html_url} target="_blank" rel="noreferrer" className="break-all text-[13px] font-semibold text-primary underline underline-offset-2 hover:underline">
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
                {star.topics.map((topic) => (
                  <button key={topic} onClick={() => onToggleTag(topic)} title={m.repoDetail.filterTopic}>
                    <Badge variant={selectedSet.has(topic) ? 'tagActive' : 'tag'} className="cursor-pointer hover:opacity-80">{topic}</Badge>
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
                {suggestions.map((name) => (
                  <Badge key={name} variant="outline" className="opacity-70 [border-style:dashed]">{name}</Badge>
                ))}
                <Button variant="outline" size="sm" onClick={acceptSuggestions} title={m.repoDetail.acceptAllTitle}>
                  {m.repoDetail.acceptAll}
                </Button>
              </div>
            </Section>
          </>
        )}

        <Separator />
        <Section title={m.repoDetail.tags(draftTags.length)}>
          <TagEditor
            tags={draftTags}
            selectedTags={selectedTags}
            onToggleTag={onToggleTag}
            onChangeTags={updateDraftTags}
          />
          <SaveRow
            dirty={tagsDirty}
            phase={tagsSavePhase}
            savedLabel={m.common.saved}
            unsavedLabel={m.common.unsaved}
            saveLabel={m.common.save}
            onSave={() => void saveTags()}
          />
        </Section>

        <Separator />
        <Section title={m.repoDetail.notes}>
          <Textarea
            value={draftNotes}
            onChange={(e) => updateDraftNotes(e.target.value)}
            placeholder={m.repoDetail.notesPlaceholder}
            rows={4}
          />
          <SaveRow
            dirty={notesDirty}
            phase={notesSavePhase}
            savedLabel={m.repoDetail.notesSaved}
            unsavedLabel={m.repoDetail.notesUnsaved}
            saveLabel={m.common.save}
            onSave={() => void saveNotes()}
          />
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

function SaveRow({
  dirty,
  phase,
  savedLabel,
  unsavedLabel,
  saveLabel,
  onSave,
}: {
  dirty: boolean;
  phase: SaveActionPhase;
  savedLabel: string;
  unsavedLabel: string;
  saveLabel: string;
  onSave: () => void;
}) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <div className="min-h-[12px] text-[10px] text-muted-foreground">
        {phase === 'ok' ? (
          <span className="inline-flex items-center gap-1 text-success">
            <Check className="size-3" />
            {savedLabel}
          </span>
        ) : dirty ? (
          unsavedLabel
        ) : null}
      </div>
      <SaveActionButton
        variant="outline"
        size="sm"
        phase={phase}
        onClick={onSave}
        disabled={!dirty || phase !== 'idle'}
      >
        {saveLabel}
      </SaveActionButton>
    </div>
  );
}

function resetSavePhase(
  setPhase: (phase: SaveActionPhase) => void,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  setPhase('idle');
}

function flashSaved(
  setPhase: (phase: SaveActionPhase) => void,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (timerRef.current) clearTimeout(timerRef.current);
  setPhase('ok');
  timerRef.current = setTimeout(() => {
    setPhase('idle');
    timerRef.current = null;
  }, 1300);
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
