import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  X,
  Archive,
  Star as StarIcon,
  Check,
} from "lucide-react";
import type { Star, Tag } from "@/types";
import { suggestTags } from "@/ui/suggest";
import { bgCall } from "@/utils/messaging";
import { translateError } from "@/api/errors";
import { TagEditor } from "./TagEditor";
import { SaveActionButton, type SaveActionPhase } from "./SaveActionButton";
import {
  mergeTagNames,
  sameTagNames,
  shouldAdoptIncomingTagDraft,
  shouldAdoptIncomingTextDraft,
} from "./tag-draft";
import { autoTagNames, manualTagNames, visibleTagNames } from "@/tags/tag-model";
import { Badge } from "@/ui/shadcn/badge";
import { Button } from "@/ui/shadcn/button";
import { Textarea } from "@/ui/shadcn/textarea";
import { Separator } from "@/ui/shadcn/separator";
import { useImeBufferedInput } from "@/ui/hooks/use-ime-input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import {
  getLockedAnchorProps,
  getLockedRegionProps,
  shouldIgnorePanelShortcut,
} from "@/ui/interaction-lock";

/** single-repo detail drawer (tag/note/suggest deep-edit lives here so rows stay compact); flex aside, no portal. */
export function RepoDetailPanel({
  star,
  tag,
  selectedTags,
  onToggleTag,
  onDataChanged,
  onMeaningfulAction,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  interactionLocked = false,
}: {
  star: Star;
  tag: Tag | undefined;
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onDataChanged?: () => void;
  onMeaningfulAction?: () => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  interactionLocked?: boolean;
}) {
  const manualTags = manualTagNames(tag);
  const autoTags = autoTagNames(tag);
  const myTagsKey = manualTags.join("\u0000");
  const notes = tag?.notes ?? "";
  const { m } = useI18n();

  const [excluded, setExcluded] = useState<string[]>([]);
  const [draftTags, setDraftTags] = useState(manualTags);
  const [draftNotes, setDraftNotes] = useState(notes);
  const [tagsSavePhase, setTagsSavePhase] = useState<SaveActionPhase>("idle");
  const [notesSavePhase, setNotesSavePhase] = useState<SaveActionPhase>("idle");
  const [tagError, setTagError] = useState<string | null>(null);
  const draftTagsRef = useRef(manualTags);
  const draftNotesRef = useRef(notes);
  const loadedRepoRef = useRef(star.full_name);
  const loadedTagsRef = useRef(manualTags);
  const loadedNotesRef = useRef(notes);
  const tagsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    bgCall<string[]>("listExcluded")
      .then((names) => {
        if (!cancelled) setExcluded(names ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const repoChanged = loadedRepoRef.current !== star.full_name;

    if (repoChanged) {
      loadedRepoRef.current = star.full_name;
      loadedTagsRef.current = manualTags;
      loadedNotesRef.current = notes;
      draftTagsRef.current = manualTags;
      draftNotesRef.current = notes;
      setDraftTags(manualTags);
      setDraftNotes(notes);
      setTagError(null);
      resetSavePhase(setTagsSavePhase, tagsTimerRef);
      resetSavePhase(setNotesSavePhase, notesTimerRef);
      return;
    }

    if (
      shouldAdoptIncomingTagDraft(
        draftTagsRef.current,
        loadedTagsRef.current,
        manualTags,
      )
    ) {
      draftTagsRef.current = manualTags;
      setDraftTags(manualTags);
      resetSavePhase(setTagsSavePhase, tagsTimerRef);
    }

    if (
      shouldAdoptIncomingTextDraft(
        draftNotesRef.current,
        loadedNotesRef.current,
        notes,
      )
    ) {
      draftNotesRef.current = notes;
      setDraftNotes(notes);
      resetSavePhase(setNotesSavePhase, notesTimerRef);
    }

    loadedTagsRef.current = manualTags;
    loadedNotesRef.current = notes;
  }, [star.full_name, myTagsKey, notes]);

  useEffect(
    () => () => {
      if (tagsTimerRef.current) clearTimeout(tagsTimerRef.current);
      if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    },
    [],
  );

  const suggestions = suggestTags(star, [...draftTags, ...autoTags], excluded);
  const tagsDirty = !sameTagNames(draftTags, manualTags);
  const notesDirty = draftNotes !== notes;

  const updateDraftTags = (nextTags: string[]) => {
    draftTagsRef.current = nextTags;
    setTagError(null);
    resetSavePhase(setTagsSavePhase, tagsTimerRef);
    setDraftTags(nextTags);
  };

  const updateDraftNotes = (nextNotes: string) => {
    draftNotesRef.current = nextNotes;
    resetSavePhase(setNotesSavePhase, notesTimerRef);
    setDraftNotes(nextNotes);
  };

  const notesInput = useImeBufferedInput(draftNotes, updateDraftNotes);

  const saveTags = async () => {
    const nextTags = draftTagsRef.current;
    if (sameTagNames(nextTags, manualTags)) return;

    let ok = false;
    setTagsSavePhase("busy");
    setTagError(null);
    try {
      await bgCall("setTags", { full_name: star.full_name, tags: nextTags });
      onDataChanged?.();
      onMeaningfulAction?.();
      ok = true;
      flashSaved(setTagsSavePhase, tagsTimerRef);
    } catch (e) {
      setTagError(m.popup.failed(m.repoDetail.tagsAction, translateError(e, m)));
    } finally {
      if (!ok) setTagsSavePhase("idle");
    }
  };

  const saveNotes = async () => {
    const nextNotes = notesInput.value;
    if (nextNotes === notes) return;

    let ok = false;
    setNotesSavePhase("busy");
    try {
      await bgCall("setNotes", { full_name: star.full_name, notes: nextNotes });
      onDataChanged?.();
      onMeaningfulAction?.();
      ok = true;
      flashSaved(setNotesSavePhase, notesTimerRef);
    } finally {
      if (!ok) setNotesSavePhase("idle");
    }
  };

  const acceptSuggestions = () => {
    if (suggestions.length === 0) return;
    updateDraftTags(mergeTagNames(draftTagsRef.current, suggestions));
  };

  const removeVisibleTag = async (name: string) => {
    setTagError(null);
    try {
      await bgCall("removeVisibleTag", { full_name: star.full_name, name });
      updateDraftTags(draftTagsRef.current.filter((tagName) => tagName.toLowerCase() !== name.toLowerCase()));
      onDataChanged?.();
      onMeaningfulAction?.();
    } catch (e) {
      setTagError(m.popup.failed(m.repoDetail.tagsAction, translateError(e, m)));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnorePanelShortcut(interactionLocked, e.target)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "[" && hasPrev) onPrev();
      else if (e.key === "]" && hasNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext, interactionLocked]);

  const selectedSet = new Set(selectedTags);

  return (
    <div
      className={cn(
        "gsm-scrollbar-stable flex h-full w-[340px] flex-col overflow-auto border-l border-border bg-card max-[640px]:w-full",
        {
          "opacity-55": interactionLocked,
        },
      )}
      {...getLockedRegionProps(interactionLocked)}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onPrev}
          disabled={!hasPrev || interactionLocked}
          title={m.repoDetail.previousTitle}
          className={cn({ "opacity-30": !hasPrev })}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNext}
          disabled={!hasNext || interactionLocked}
          title={m.repoDetail.nextTitle}
          className={cn({ "opacity-30": !hasNext })}
        >
          <ChevronRight className="size-4" />
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          disabled={interactionLocked}
          title={m.repoDetail.closeTitle}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        <div>
          <a
            href={star.html_url}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "break-all text-[13px] font-semibold text-primary underline underline-offset-2 hover:underline",
              { "pointer-events-none opacity-70": interactionLocked },
            )}
            {...getLockedAnchorProps(interactionLocked)}
          >
            {star.full_name}
          </a>
          <div className="mt-0.5 flex gap-2">
            {star.archived && (
              <span
                className="inline-flex items-center gap-1 text-xs text-warning"
                title={m.starRow.archived}
              >
                <Archive className="size-3" />
                {m.starRow.archived}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <Meta
            label={m.repoDetail.language}
            value={star.language ?? m.common.none}
          />
          <Meta
            label={m.repoDetail.stars}
            value={
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <StarIcon className="size-3 fill-current" />
                {fmt(star.stargazers_count)}
              </span>
            }
          />
          <Meta
            label={m.repoDetail.updated}
            value={star.pushed_at ? star.pushed_at.slice(0, 10) : m.common.none}
          />
          <Meta
            label={star.viewer_has_starred === false ? m.repoDetail.librarySource : m.repoDetail.starred}
            value={star.viewer_has_starred === false
              ? m.repoDetail.ownedPublicRepository
              : star.starred_at.slice(0, 10)}
          />
        </div>

        {star.description && (
          <>
            <Separator />
            <Section title={m.repoDetail.description}>
              <p className="m-0 text-xs leading-relaxed text-foreground">
                {star.description}
              </p>
            </Section>
          </>
        )}

        {star.topics.length > 0 && (
          <>
            <Separator />
            <Section title={m.repoDetail.topics(star.topics.length)}>
              <div className="flex flex-wrap gap-1">
                {star.topics.map((topic) => (
                  <button
                    key={topic}
                    onClick={() => onToggleTag(topic)}
                    title={m.repoDetail.filterTopic}
                  >
                    <Badge
                      variant={selectedSet.has(topic) ? "tagActive" : "tag"}
                      className="cursor-pointer hover:opacity-80"
                    >
                      {topic}
                    </Badge>
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
                  <Badge
                    key={name}
                    variant="outline"
                    className="opacity-70 [border-style:dashed]"
                  >
                    {name}
                  </Badge>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={acceptSuggestions}
                  title={m.repoDetail.acceptAllTitle}
                >
                  {m.repoDetail.acceptAll}
                </Button>
              </div>
            </Section>
          </>
        )}

        <Separator />
        <Section title={m.repoDetail.tags(visibleTagNames({ manualTags: draftTags, autoTags }).length)}>
          <TagEditor
            tags={visibleTagNames({ manualTags: draftTags, autoTags })}
            editableTags={draftTags}
            selectedTags={selectedTags}
            onToggleTag={onToggleTag}
            onChangeTags={updateDraftTags}
            onRemoveVisibleTag={(name) => void removeVisibleTag(name)}
          />
          {tagError && (
            <div className="mt-1 text-xs text-destructive" role="alert">
              {tagError}
            </div>
          )}
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
            {...notesInput.inputProps}
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
      <div className="gsm-meta-label mb-1">{title}</div>
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
      <div className="gsm-muted-count min-h-[12px]">
        {phase === "ok" ? (
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
        disabled={!dirty || phase !== "idle"}
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
  setPhase("idle");
}

function flashSaved(
  setPhase: (phase: SaveActionPhase) => void,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (timerRef.current) clearTimeout(timerRef.current);
  setPhase("ok");
  timerRef.current = setTimeout(() => {
    setPhase("idle");
    timerRef.current = null;
  }, 1300);
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="gsm-muted-count-soft">{label}</div>
      <div className="text-foreground">{value}</div>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
