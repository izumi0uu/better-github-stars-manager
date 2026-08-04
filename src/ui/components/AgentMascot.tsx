import type { CSSProperties } from 'react';
import indexAgentAtlasUrl from '@/ui/assets/index-agent-atlas.png?url';
import indexAgentStaticUrl from '@/ui/assets/index-agent-static.png?url';
import indexAgentWorkingUrl from '@/ui/assets/index-agent-working.gif?url';
import type { AgentMascotState } from '@/ui/agent-ui-presentation';
import { cn } from '@/lib/utils';

export type { AgentMascotState } from '@/ui/agent-ui-presentation';

const STATE_SPRITES: Record<AgentMascotState, Readonly<{ row: number; durationMs: number }>> = {
  idle: { row: 0, durationMs: 2_400 },
  queued: { row: 1, durationMs: 1_200 },
  working: { row: 2, durationMs: 880 },
  compacting: { row: 3, durationMs: 1_120 },
  tool: { row: 4, durationMs: 800 },
  waiting: { row: 5, durationMs: 1_760 },
  done: { row: 6, durationMs: 1_520 },
  stopped: { row: 7, durationMs: 2_240 },
  error: { row: 8, durationMs: 1_360 },
};

export function AgentMascot({
  state,
  playing = true,
  className,
}: {
  state: AgentMascotState;
  playing?: boolean;
  className?: string;
}) {
  const sprite = STATE_SPRITES[state];
  const style: CSSProperties = {
    animationDuration: `${sprite.durationMs}ms`,
    backgroundImage: `url("${indexAgentAtlasUrl}")`,
    backgroundPositionY: `${sprite.row * -32}px`,
  };

  return (
    <span
      aria-hidden="true"
      className={cn('gsm-agent-mascot', className)}
      data-playing={playing ? 'true' : 'false'}
      data-state={state}
      data-testid="agent-mascot"
      style={style}
    />
  );
}

export function AgentMascotIcon({
  className,
  running = false,
}: {
  className?: string;
  running?: boolean;
}) {
  return (
    <picture className="block size-5 shrink-0">
      {running && (
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet={indexAgentStaticUrl}
        />
      )}
      <img
        alt=""
        aria-hidden="true"
        className={cn('block size-full [image-rendering:pixelated]', className)}
        data-state={running ? 'working' : 'idle'}
        data-testid="agent-mascot-icon"
        draggable={false}
        src={running ? indexAgentWorkingUrl : indexAgentStaticUrl}
      />
    </picture>
  );
}
