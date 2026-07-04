import { Heart } from 'lucide-react';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { cn } from '@/lib/utils';

export function FavoriteButton({
  active,
  busy,
  activeLabel,
  inactiveLabel,
  onToggle,
}: {
  active: boolean;
  busy: boolean;
  activeLabel: string;
  inactiveLabel: string;
  onToggle: (next: boolean) => void;
}) {
  const label = active ? activeLabel : inactiveLabel;

  return (
    <button
      type="button"
      disabled={busy}
      className="gsm-favorite-action gsm-touch-target"
      data-active={active ? 'true' : 'false'}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        if (busy) return;
        onToggle(!active);
      }}
    >
      <ActionIcon phase={active ? 'favorite-on' : 'favorite-off'}>
        <Heart className={cn('size-4', { 'fill-current': active })} />
      </ActionIcon>
    </button>
  );
}
