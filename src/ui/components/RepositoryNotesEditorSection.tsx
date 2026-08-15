import { useEffect, useRef, useState } from 'react';
import type { Star, Tag } from '@/types';
import { useI18n } from '@/i18n';
import { useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { Separator } from '@/ui/shadcn/separator';
import { Textarea } from '@/ui/shadcn/textarea';
import { bgCall } from '@/utils/messaging';
import type { SaveActionPhase } from './SaveActionButton';
import { shouldAdoptIncomingTextDraft } from './tag-draft';
import {
  flashRepositorySaved,
  RepositoryDetailSection,
  RepositoryEditorSaveRow,
  resetRepositorySavePhase,
} from './RepositoryEditorShared';

type RepositoryNotesEditorSectionProps = {
  star: Star;
  tag: Tag | undefined;
  onDataChanged?: () => void;
  onMeaningfulAction?: () => void;
};

export function RepositoryNotesEditorSection({
  star,
  tag,
  onDataChanged,
  onMeaningfulAction,
}: RepositoryNotesEditorSectionProps) {
  const notes = tag?.notes ?? '';
  const { m } = useI18n();

  const [draftNotes, setDraftNotes] = useState(notes);
  const [savePhase, setSavePhase] = useState<SaveActionPhase>('idle');
  const draftNotesRef = useRef(notes);
  const loadedRepoRef = useRef(star.full_name);
  const loadedNotesRef = useRef(notes);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const repoChanged = loadedRepoRef.current !== star.full_name;

    if (repoChanged) {
      loadedRepoRef.current = star.full_name;
      loadedNotesRef.current = notes;
      draftNotesRef.current = notes;
      setDraftNotes(notes);
      resetRepositorySavePhase(setSavePhase, timerRef);
      return;
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
      resetRepositorySavePhase(setSavePhase, timerRef);
    }

    loadedNotesRef.current = notes;
  }, [star.full_name, notes]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current ?? undefined);
    };
  }, []);

  const ownsCompletion = (fullName: string) => (
    mountedRef.current && loadedRepoRef.current === fullName
  );

  const updateDraftNotes = (nextNotes: string) => {
    draftNotesRef.current = nextNotes;
    resetRepositorySavePhase(setSavePhase, timerRef);
    setDraftNotes(nextNotes);
  };

  const notesInput = useImeBufferedInput(draftNotes, updateDraftNotes);
  const dirty = draftNotes !== notes;

  const saveNotes = async () => {
    const fullName = star.full_name;
    const nextNotes = notesInput.value;
    if (nextNotes === notes) return;

    let ok = false;
    setSavePhase('busy');
    try {
      await bgCall('setNotes', { full_name: fullName, notes: nextNotes });
      if (!ownsCompletion(fullName)) return;
      onDataChanged?.();
      onMeaningfulAction?.();
      ok = true;
      flashRepositorySaved(setSavePhase, timerRef);
    } catch {
      // Preserve the existing failure presentation: retain the draft and return to idle.
    } finally {
      if (!ok && ownsCompletion(fullName)) setSavePhase('idle');
    }
  };

  return (
    <>
      <Separator />
      <RepositoryDetailSection title={m.repoDetail.notes}>
        <Textarea
          {...notesInput.inputProps}
          placeholder={m.repoDetail.notesPlaceholder}
          rows={4}
        />
        <RepositoryEditorSaveRow
          dirty={dirty}
          phase={savePhase}
          savedLabel={m.repoDetail.notesSaved}
          unsavedLabel={m.repoDetail.notesUnsaved}
          saveLabel={m.common.save}
          onSave={() => void saveNotes()}
        />
      </RepositoryDetailSection>
    </>
  );
}
