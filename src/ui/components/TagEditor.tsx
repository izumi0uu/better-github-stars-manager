import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/ui/shadcn/badge';
import { Input } from '@/ui/shadcn/input';
import { Button } from '@/ui/shadcn/button';
import { shouldIgnoreImeAction, useImeBufferedInput } from '@/ui/hooks/use-ime-input';
import { useI18n } from '@/i18n';
import { mergeTagNames, normalizeTagNames } from './tag-draft';

/**
 * Full tag editor for the detail panel. Each chip is click-to-filter (toggle
 * that tag as a filter); a ✕ removes the tag; an input adds tags. A "批量"
 * toggle reveals a comma-separated bulk editor.
 *
 * Only the `full` variant exists now — list rows render their own compact
 * tag summary inline (see StarRow), so this component is detail-panel-only.
 */
export function TagEditor({
  tags,
  selectedTags,
  onToggleTag,
  onChangeTags,
}: {
  tags: string[];
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onChangeTags: (tags: string[]) => void;
}) {
  const [bulk, setBulk] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const addInput = useImeBufferedInput('');
  const bulkInput = useImeBufferedInput(tags.join(', '));
  const { m } = useI18n();
  const canAdd = !!addInput.value.trim();
  const canApplyBulk = bulkInput.value !== tags.join(', ');

  const removeTag = (t: string) => {
    onChangeTags(tags.filter((x) => x !== t));
  };

  const addTag = () => {
    const v = addInput.value.trim();
    if (!v) return;

    onChangeTags(mergeTagNames(tags, [v]));
    addInput.commit('');
    addInputRef.current?.focus();
  };

  const commitBulk = () => {
    onChangeTags(normalizeTagNames(bulkInput.value.split(/[,\s]+/)));
    setBulk(false);
  };

  const selectedSet = new Set(selectedTags);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {tags.length === 0 ? (
          <span className="text-xs text-muted-foreground">{m.tagEditor.noTags}</span>
        ) : (
          tags.map((t) => {
            const active = selectedSet.has(t);
            return (
              <span key={t} className="inline-flex items-center gap-1">
                <button onClick={() => onToggleTag(t)} title={active ? m.tagEditor.clearTagFilter(t) : m.tagEditor.filterByTag(t)}>
                  <Badge variant={active ? 'tagActive' : 'tag'} className="cursor-pointer hover:opacity-80">{t}</Badge>
                </button>
                <button onClick={() => removeTag(t)} className="text-muted-foreground hover:text-destructive" title={m.tagEditor.removeTag}><X className="size-3" /></button>
              </span>
            );
          })
        )}
      </div>

      {!bulk ? (
        <div className="space-y-2">
          <Input
            ref={addInputRef}
            {...addInput.inputProps}
            placeholder={m.tagEditor.addTagPlaceholder}
            onKeyDown={(e) => {
              if (shouldIgnoreImeAction(e, addInput.composingRef)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
            className="w-full"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={addTag} disabled={!canAdd}>
              {m.tagEditor.addTagButton}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                bulkInput.commit(tags.join(', '));
                setBulk(true);
              }}
              title={m.tagEditor.bulkEditTitle}
            >
              {m.common.bulk}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-dashed border-border/70 bg-muted/20 p-2">
          <Input
            autoFocus
            {...bulkInput.inputProps}
            onKeyDown={(e) => {
              if (shouldIgnoreImeAction(e, bulkInput.composingRef)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                commitBulk();
              }
              if (e.key === 'Escape') {
                bulkInput.commit(tags.join(', '));
                setBulk(false);
              }
            }}
            placeholder={m.tagEditor.bulkPlaceholder}
          />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={commitBulk} disabled={!canApplyBulk}>
              {m.common.apply}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                bulkInput.commit(tags.join(', '));
                setBulk(false);
              }}
            >
              {m.common.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
