import { Save } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import { SuccessCheck } from '@/ui/shadcn/success-check';
import { ActionIcon } from '@/ui/shadcn/action-icon';

export type SaveActionPhase = 'idle' | 'busy' | 'ok';

function SaveActionButton({
  phase,
  children,
  ...props
}: {
  phase: SaveActionPhase;
} & ComponentProps<typeof Button>) {
  return (
    <Button {...props}>
      <ActionIcon phase={phase}>
        {phase === 'ok' ? (
          <SuccessCheck data-icon="inline-start" />
        ) : phase === 'busy' ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Save className="size-4" data-icon="inline-start" />
        )}
      </ActionIcon>
      {children}
    </Button>
  );
}

export { SaveActionButton };
