import type { CSSProperties } from 'react';
import indexAgentAtlasUrl from '@/ui/assets/index-agent-atlas.png?url';
import indexAgentStaticUrl from '@/ui/assets/index-agent-static.png?url';
import indexAgentWorkingUrl from '@/ui/assets/index-agent-working.gif?url';
import type { CurrentOrganizeJobState, WorkbenchPreflight } from '@/ui/agent-workbench-state';
import type { BgsmAgentStatus } from '@/ui/hooks/use-bgsm-agent';
import { cn } from '@/lib/utils';

export type AgentMascotState =
  | 'idle'
  | 'queued'
  | 'working'
  | 'compacting'
  | 'tool'
  | 'waiting'
  | 'done'
  | 'stopped'
  | 'error';

export type AgentMascotStateInput = Readonly<{
  chatStatus: BgsmAgentStatus['kind'] | null;
  chatRunning: boolean;
  hasAgentError: boolean;
  hasContextRecovery: boolean;
  preflightStatus: WorkbenchPreflight['status'] | null;
  runState: CurrentOrganizeJobState | null;
  automaticContinuation: boolean;
  hasWorkbenchError: boolean;
  workbenchDisconnected: boolean;
  hasReceipt: boolean;
}>;

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

const ERROR_RUN_STATES: readonly CurrentOrganizeJobState[] = ['failed', 'interrupted'];
const WORKING_RUN_STATES: readonly CurrentOrganizeJobState[] = ['frozen', 'prepared', 'analyzing'];
const WAITING_RUN_STATES: readonly CurrentOrganizeJobState[] = [
  'analysis_blocked',
  'review',
  'budget_exhausted',
  'paused',
];

export function resolveAgentMascotState(input: AgentMascotStateInput): AgentMascotState {
  if (input.chatRunning) {
    if (input.hasAgentError || input.chatStatus === 'error') return 'error';
    if (input.chatStatus === 'stopped') return 'stopped';
    if (input.chatStatus === 'done') return 'done';
    if (input.chatStatus === 'compacting') return 'compacting';
    if (input.chatStatus === 'tool') return 'tool';
    if (input.chatStatus === 'queued') return 'queued';
    return 'working';
  }

  if (input.hasContextRecovery) return 'waiting';
  if (
    input.hasAgentError
    || input.hasWorkbenchError
    || input.workbenchDisconnected
    || input.chatStatus === 'error'
    || includesRunState(ERROR_RUN_STATES, input.runState)
  ) return 'error';

  if (
    input.runState === 'apply_sealed'
    || input.runState === 'applying'
  ) return 'tool';
  if (
    input.preflightStatus === 'requesting'
    || input.preflightStatus === 'starting'
    || input.runState === 'checking_provider'
  ) return 'queued';
  if (
    input.automaticContinuation
    || includesRunState(WORKING_RUN_STATES, input.runState)
  ) return 'working';

  if (
    input.preflightStatus === 'ready'
    || includesRunState(WAITING_RUN_STATES, input.runState)
  ) return 'waiting';
  if (input.runState === 'cancelled' || input.chatStatus === 'stopped') return 'stopped';
  if (
    input.hasReceipt
    || input.preflightStatus === 'no_work'
    || input.runState === 'completed'
    || input.chatStatus === 'done'
  ) return 'done';
  return 'idle';
}

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

function includesRunState(
  states: readonly CurrentOrganizeJobState[],
  state: CurrentOrganizeJobState | null,
): boolean {
  return state !== null && states.includes(state);
}
