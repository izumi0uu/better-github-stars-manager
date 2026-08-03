import type { ModelStreamEvent } from './provider-stream';

export const AGENT_FIRST_RESPONSE_TIMEOUT_MS = 90_000;
export const AGENT_STREAM_IDLE_TIMEOUT_MS = 45_000;
export const AGENT_IDLE_TIMEOUT_MS = 90_000;
export const AGENT_ABSOLUTE_TURN_TIMEOUT_MS = 10 * 60_000;

export type AgentLivenessTimeoutReason =
  | 'first_response_timeout'
  | 'stream_idle_timeout'
  | 'agent_idle_timeout'
  | 'absolute_turn_timeout';

export type AgentLivenessWatchdog =
  | 'first_response'
  | 'stream_idle'
  | 'agent_idle'
  | 'absolute_turn';

export type AgentLivenessWatchdogState = 'armed' | 'progress' | 'expired' | 'cancelled';

export type AgentLivenessWatchdogEvent = Readonly<{
  watchdog: AgentLivenessWatchdog;
  state: AgentLivenessWatchdogState;
  limitMs: number;
}>;

export type AgentLivenessClock = Readonly<{
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}>;

export type AgentProviderRequestLiveness = Readonly<{
  signal: AbortSignal;
  observeStreamEvent(event: ModelStreamEvent): void;
  observeResponse(): void;
  finish(): void;
}>;

export type AgentTurnLiveness = Readonly<{
  signal: AbortSignal;
  readonly timeoutReason: AgentLivenessTimeoutReason | undefined;
  markAgentProgress(): void;
  beginProviderRequest(): AgentProviderRequestLiveness;
  suspendAgentIdle(): void;
  resumeAgentIdle(): void;
  dispose(): void;
}>;

export type CreateAgentTurnLivenessInput = Readonly<{
  signal?: AbortSignal;
  /** Lets the owner use the same root abort path for watchdog and user cancellation. */
  onTimeout?: (reason: AgentLivenessTimeoutReason) => void;
  /** Observational only; a diagnostics sink must never control the observed turn. */
  onWatchdogState?: (event: AgentLivenessWatchdogEvent) => void;
  firstResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  agentIdleTimeoutMs?: number;
  absoluteTurnTimeoutMs?: number;
  clock?: Partial<AgentLivenessClock>;
}>;

const managedSignals = new WeakSet<AbortSignal>();

/** Production adapters defer their fixed deadline only for per-request liveness signals. */
export function isAgentLivenessManagedSignal(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && managedSignals.has(signal);
}

export function publicAgentLivenessTimeoutMessage(reason: AgentLivenessTimeoutReason): string {
  switch (reason) {
    case 'first_response_timeout':
      return 'AI provider did not begin responding in time.';
    case 'stream_idle_timeout':
      return 'AI provider stopped making progress while streaming.';
    case 'agent_idle_timeout':
      return 'BGSM Agent stopped making progress.';
    case 'absolute_turn_timeout':
      return 'BGSM Agent reached the maximum turn duration.';
  }
}

export function createAgentTurnLiveness(
  input: CreateAgentTurnLivenessInput = {},
): AgentTurnLiveness {
  const clock: AgentLivenessClock = {
    now: input.clock?.now ?? Date.now,
    setTimer: input.clock?.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer: input.clock?.clearTimer ?? ((timer) => clearTimeout(timer)),
  };
  const firstResponseTimeoutMs = positiveTimeout(
    input.firstResponseTimeoutMs,
    AGENT_FIRST_RESPONSE_TIMEOUT_MS,
    'first-response',
  );
  const streamIdleTimeoutMs = positiveTimeout(
    input.streamIdleTimeoutMs,
    AGENT_STREAM_IDLE_TIMEOUT_MS,
    'stream-idle',
  );
  const agentIdleTimeoutMs = positiveTimeout(
    input.agentIdleTimeoutMs,
    AGENT_IDLE_TIMEOUT_MS,
    'agent-idle',
  );
  const absoluteTurnTimeoutMs = positiveTimeout(
    input.absoluteTurnTimeoutMs,
    AGENT_ABSOLUTE_TURN_TIMEOUT_MS,
    'absolute-turn',
  );
  const controller = new AbortController();
  let timeoutReason: AgentLivenessTimeoutReason | undefined;
  let disposed = false;
  let agentIdleSuspended = false;
  let agentIdleTimer: ReturnType<typeof setTimeout> | null = null;
  const providerRequests = new Set<() => void>();
  const emitWatchdogState = (
    watchdog: AgentLivenessWatchdog,
    state: AgentLivenessWatchdogState,
    limitMs: number,
  ) => {
    try {
      input.onWatchdogState?.({ watchdog, state, limitMs });
    } catch {
      // Diagnostics cannot alter Agent execution.
    }
  };

  const clearAgentIdleTimer = () => {
    if (agentIdleTimer === null) return;
    clock.clearTimer(agentIdleTimer);
    agentIdleTimer = null;
  };
  const clearAll = () => {
    clearAgentIdleTimer();
    clock.clearTimer(absoluteTimer);
    for (const finish of providerRequests) finish();
    providerRequests.clear();
  };
  const timeout = (reason: AgentLivenessTimeoutReason) => {
    if (controller.signal.aborted || disposed) return;
    timeoutReason = reason;
    emitWatchdogState(watchdogForTimeout(reason), 'expired', timeoutLimit(reason, {
      firstResponseTimeoutMs,
      streamIdleTimeoutMs,
      agentIdleTimeoutMs,
      absoluteTurnTimeoutMs,
    }));
    try {
      input.onTimeout?.(reason);
    } finally {
      controller.abort(reason);
    }
  };
  const armAgentIdle = () => {
    clearAgentIdleTimer();
    if (
      controller.signal.aborted ||
      disposed ||
      agentIdleSuspended ||
      providerRequests.size > 0
    ) return;
    agentIdleTimer = clock.setTimer(() => timeout('agent_idle_timeout'), agentIdleTimeoutMs);
    emitWatchdogState('agent_idle', 'armed', agentIdleTimeoutMs);
  };
  const absoluteTimer = clock.setTimer(
    () => timeout('absolute_turn_timeout'),
    absoluteTurnTimeoutMs,
  );
  emitWatchdogState('absolute_turn', 'armed', absoluteTurnTimeoutMs);
  const abortFromSource = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abortFromSource, { once: true });
  if (input.signal?.aborted) abortFromSource();
  controller.signal.addEventListener('abort', clearAll, { once: true });
  armAgentIdle();

  return Object.freeze({
    signal: controller.signal,
    get timeoutReason() {
      return timeoutReason;
    },
    markAgentProgress() {
      emitWatchdogState('agent_idle', 'progress', agentIdleTimeoutMs);
      armAgentIdle();
    },
    beginProviderRequest() {
      const requestController = new AbortController();
      managedSignals.add(requestController.signal);
      let firstResponseTimer: ReturnType<typeof setTimeout> | null = null;
      let streamIdleTimer: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      const clearRequestTimers = () => {
        if (firstResponseTimer !== null) {
          clock.clearTimer(firstResponseTimer);
          firstResponseTimer = null;
        }
        if (streamIdleTimer !== null) {
          clock.clearTimer(streamIdleTimer);
          streamIdleTimer = null;
        }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        if (controller.signal.aborted && !requestController.signal.aborted) {
          requestController.abort(controller.signal.reason);
        }
        clearRequestTimers();
        controller.signal.removeEventListener('abort', abortFromRoot);
        providerRequests.delete(finish);
        armAgentIdle();
      };
      const abortFromRoot = () => {
        requestController.abort(controller.signal.reason);
        finish();
      };
      const armStreamIdle = () => {
        if (finished || controller.signal.aborted) return;
        if (streamIdleTimer !== null) clock.clearTimer(streamIdleTimer);
        streamIdleTimer = clock.setTimer(
          () => timeout('stream_idle_timeout'),
          streamIdleTimeoutMs,
        );
        emitWatchdogState('stream_idle', 'armed', streamIdleTimeoutMs);
      };
      const observeResponse = () => {
        if (finished || controller.signal.aborted) return;
        if (firstResponseTimer !== null) {
          clock.clearTimer(firstResponseTimer);
          firstResponseTimer = null;
        }
        emitWatchdogState('first_response', 'progress', firstResponseTimeoutMs);
        armAgentIdle();
      };
      const observeStreamEvent = (event: ModelStreamEvent) => {
        switch (event.type) {
          case 'response_start':
            observeResponse();
            armStreamIdle();
            return;
          case 'text_delta':
          case 'refusal_delta':
          case 'tool_call_arguments_delta':
            if (event.delta.length === 0) return;
            observeResponse();
            emitWatchdogState('stream_idle', 'progress', streamIdleTimeoutMs);
            armStreamIdle();
            return;
          case 'tool_call_start':
          case 'tool_call_end':
          case 'usage':
            observeResponse();
            emitWatchdogState('stream_idle', 'progress', streamIdleTimeoutMs);
            armStreamIdle();
            return;
          case 'response_end':
            observeResponse();
            emitWatchdogState('stream_idle', 'progress', streamIdleTimeoutMs);
            finish();
            return;
          case 'error':
            finish();
            return;
        }
      };
      controller.signal.addEventListener('abort', abortFromRoot, { once: true });
      providerRequests.add(finish);
      clearAgentIdleTimer();
      if (controller.signal.aborted) {
        abortFromRoot();
      } else {
        firstResponseTimer = clock.setTimer(
          () => timeout('first_response_timeout'),
          firstResponseTimeoutMs,
        );
        emitWatchdogState('first_response', 'armed', firstResponseTimeoutMs);
      }
      return Object.freeze({
        signal: requestController.signal,
        observeStreamEvent,
        observeResponse,
        finish,
      });
    },
    suspendAgentIdle() {
      agentIdleSuspended = true;
      clearAgentIdleTimer();
    },
    resumeAgentIdle() {
      agentIdleSuspended = false;
      armAgentIdle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      input.signal?.removeEventListener('abort', abortFromSource);
      clearAll();
    },
  });
}

function watchdogForTimeout(reason: AgentLivenessTimeoutReason): AgentLivenessWatchdog {
  switch (reason) {
    case 'first_response_timeout': return 'first_response';
    case 'stream_idle_timeout': return 'stream_idle';
    case 'agent_idle_timeout': return 'agent_idle';
    case 'absolute_turn_timeout': return 'absolute_turn';
  }
}

function timeoutLimit(
  reason: AgentLivenessTimeoutReason,
  limits: Readonly<{
    firstResponseTimeoutMs: number;
    streamIdleTimeoutMs: number;
    agentIdleTimeoutMs: number;
    absoluteTurnTimeoutMs: number;
  }>,
): number {
  switch (reason) {
    case 'first_response_timeout': return limits.firstResponseTimeoutMs;
    case 'stream_idle_timeout': return limits.streamIdleTimeoutMs;
    case 'agent_idle_timeout': return limits.agentIdleTimeoutMs;
    case 'absolute_turn_timeout': return limits.absoluteTurnTimeoutMs;
  }
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TypeError(`Agent ${label} timeout must be a positive safe integer.`);
  }
  return timeout;
}
