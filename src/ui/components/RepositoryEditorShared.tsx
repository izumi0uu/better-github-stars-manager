import type { MutableRefObject, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { SaveActionButton, type SaveActionPhase } from './SaveActionButton';

export function RepositoryDetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="gsm-meta-label mb-1">{title}</div>
      {children}
    </div>
  );
}

export function RepositoryEditorSaveRow({
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

export function resetRepositorySavePhase(
  setPhase: (phase: SaveActionPhase) => void,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  setPhase('idle');
}

export function flashRepositorySaved(
  setPhase: (phase: SaveActionPhase) => void,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  clearTimeout(timerRef.current ?? undefined);
  setPhase('ok');
  timerRef.current = setTimeout(() => {
    setPhase('idle');
    timerRef.current = null;
  }, 1300);
}
