import { useEffect, useRef, useState } from 'react';
import type { Star, Tag } from '@/types';
import { translateError } from '@/api/errors';
import { useI18n } from '@/i18n';
import { autoTagNames, manualTagNames, visibleTagNames } from '@/tags/tag-model';
import { suggestTags } from '@/ui/suggest';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { Separator } from '@/ui/shadcn/separator';
import { bgCall } from '@/utils/messaging';
import { TagEditor } from './TagEditor';
import type { SaveActionPhase } from './SaveActionButton';
import {
  mergeTagNames,
  sameTagNames,
  shouldAdoptIncomingTagDraft,
} from './tag-draft';
import {
  flashRepositorySaved,
  RepositoryDetailSection,
  RepositoryEditorSaveRow,
  resetRepositorySavePhase,
} from './RepositoryEditorShared';

type RepositoryTagEditorSectionProps = {
  star: Star;
  tag: Tag | undefined;
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onDataChanged?: () => void;
  onMeaningfulAction?: () => void;
};

export function RepositoryTagEditorSection({
  star,
  tag,
  selectedTags,
  onToggleTag,
  onDataChanged,
  onMeaningfulAction,
}: RepositoryTagEditorSectionProps) {
  const manualTags = manualTagNames(tag);
  const autoTags = autoTagNames(tag);
  const manualTagsKey = manualTags.join('\u0000');
  const { m } = useI18n();

  const [excluded, setExcluded] = useState<string[]>([]);
  const [draftTags, setDraftTags] = useState(manualTags);
  const [savePhase, setSavePhase] = useState<SaveActionPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const draftTagsRef = useRef(manualTags);
  const loadedRepoRef = useRef(star.full_name);
  const loadedTagsRef = useRef(manualTags);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

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
    const repoChanged = loadedRepoRef.current !== star.full_name;

    if (repoChanged) {
      loadedRepoRef.current = star.full_name;
      loadedTagsRef.current = manualTags;
      draftTagsRef.current = manualTags;
      setDraftTags(manualTags);
      setError(null);
      resetRepositorySavePhase(setSavePhase, timerRef);
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
      resetRepositorySavePhase(setSavePhase, timerRef);
    }

    loadedTagsRef.current = manualTags;
  }, [star.full_name, manualTagsKey]);

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

  const suggestions = suggestTags(star, [...draftTags, ...autoTags], excluded);
  const dirty = !sameTagNames(draftTags, manualTags);
  const visibleTags = visibleTagNames({ manualTags: draftTags, autoTags });

  const updateDraftTags = (nextTags: string[]) => {
    draftTagsRef.current = nextTags;
    setError(null);
    resetRepositorySavePhase(setSavePhase, timerRef);
    setDraftTags(nextTags);
  };

  const saveTags = async () => {
    const fullName = star.full_name;
    const nextTags = draftTagsRef.current;
    if (sameTagNames(nextTags, manualTags)) return;

    let ok = false;
    setSavePhase('busy');
    setError(null);
    try {
      await bgCall('setTags', { full_name: fullName, tags: nextTags });
      if (!ownsCompletion(fullName)) return;
      onDataChanged?.();
      onMeaningfulAction?.();
      ok = true;
      flashRepositorySaved(setSavePhase, timerRef);
    } catch (cause) {
      if (!ownsCompletion(fullName)) return;
      setError(m.popup.failed(m.repoDetail.tagsAction, translateError(cause, m)));
    } finally {
      if (!ok && ownsCompletion(fullName)) setSavePhase('idle');
    }
  };

  const acceptSuggestions = () => {
    if (suggestions.length === 0) return;
    updateDraftTags(mergeTagNames(draftTagsRef.current, suggestions));
  };

  const removeVisibleTag = async (name: string) => {
    const fullName = star.full_name;
    setError(null);
    try {
      await bgCall('removeVisibleTag', { full_name: fullName, name });
      if (!ownsCompletion(fullName)) return;
      updateDraftTags(
        draftTagsRef.current.filter(
          (tagName) => tagName.toLowerCase() !== name.toLowerCase(),
        ),
      );
      onDataChanged?.();
      onMeaningfulAction?.();
    } catch (cause) {
      if (!ownsCompletion(fullName)) return;
      setError(m.popup.failed(m.repoDetail.tagsAction, translateError(cause, m)));
    }
  };

  return (
    <>
      {suggestions.length > 0 && (
        <>
          <Separator />
          <RepositoryDetailSection title={m.repoDetail.suggestedTags}>
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
          </RepositoryDetailSection>
        </>
      )}

      <Separator />
      <RepositoryDetailSection title={m.repoDetail.tags(visibleTags.length)}>
        <TagEditor
          tags={visibleTags}
          editableTags={draftTags}
          selectedTags={selectedTags}
          onToggleTag={onToggleTag}
          onChangeTags={updateDraftTags}
          onRemoveVisibleTag={(name) => void removeVisibleTag(name)}
        />
        {error && (
          <div className="mt-1 text-xs text-destructive" role="alert">
            {error}
          </div>
        )}
        <RepositoryEditorSaveRow
          dirty={dirty}
          phase={savePhase}
          savedLabel={m.common.saved}
          unsavedLabel={m.common.unsaved}
          saveLabel={m.common.save}
          onSave={() => void saveTags()}
        />
      </RepositoryDetailSection>
    </>
  );
}
