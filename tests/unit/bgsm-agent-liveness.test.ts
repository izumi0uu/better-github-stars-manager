import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
  type AgentEvent,
  createAgentTurnLiveness,
  isAgentLivenessManagedSignal,
  runAgentLoop,
} from '@/agent-harness';

class ManualClock {
  #now = 0;
  #nextId = 0;
  #timers = new Map<number, { dueAt: number; callback: () => void }>();

  readonly now = () => this.#now;

  readonly setTimer = (callback: () => void, delayMs: number) => {
    const id = ++this.#nextId;
    this.#timers.set(id, { dueAt: this.#now + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    this.#timers.delete(timer as unknown as number);
  };

  advanceBy(durationMs: number): void {
    const deadline = this.#now + durationMs;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.dueAt <= deadline)
        .sort(([leftId, left], [rightId, right]) => (
          left.dueAt - right.dueAt || leftId - rightId
        ))[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.#now = timer.dueAt;
      timer.callback();
    }
    this.#now = deadline;
  }
}

function createLiveness(clock: ManualClock, overrides: Partial<{
  firstResponseTimeoutMs: number;
  streamIdleTimeoutMs: number;
  agentIdleTimeoutMs: number;
  absoluteTurnTimeoutMs: number;
}> = {}) {
  return createAgentTurnLiveness({
    firstResponseTimeoutMs: 90,
    streamIdleTimeoutMs: 45,
    agentIdleTimeoutMs: 90,
    absoluteTurnTimeoutMs: 600,
    clock,
    ...overrides,
  });
}

describe('Cubby progress-aware liveness', () => {
  it('terminates an unanswered Provider request at the first-response deadline', () => {
    const clock = new ManualClock();
    const liveness = createLiveness(clock);
    const request = liveness.beginProviderRequest();

    assert.equal(isAgentLivenessManagedSignal(liveness.signal), false);
    assert.equal(isAgentLivenessManagedSignal(request.signal), true);
    clock.advanceBy(89);
    assert.equal(liveness.signal.aborted, false);
    clock.advanceBy(1);

    assert.equal(liveness.timeoutReason, 'first_response_timeout');
    assert.equal(liveness.signal.aborted, true);
    assert.equal(request.signal.aborted, true);
  });

  it('resets stream-idle only for meaningful Provider stream events', () => {
    const clock = new ManualClock();
    const liveness = createLiveness(clock);
    const request = liveness.beginProviderRequest();

    request.observeStreamEvent({ type: 'response_start' });
    clock.advanceBy(44);
    request.observeStreamEvent({ type: 'text_delta', delta: '' });
    clock.advanceBy(1);

    assert.equal(liveness.timeoutReason, 'stream_idle_timeout');
    assert.equal(liveness.signal.aborted, true);
  });

  it('allows a healthy multi-step turn to exceed ninety seconds while progress continues', () => {
    const clock = new ManualClock();
    const liveness = createLiveness(clock);
    const first = liveness.beginProviderRequest();

    first.observeStreamEvent({ type: 'response_start' });
    clock.advanceBy(40);
    first.observeStreamEvent({ type: 'text_delta', delta: 'working' });
    clock.advanceBy(40);
    first.observeStreamEvent({ type: 'tool_call_start', index: 0, id: 'call-1', name: 'list_tags' });
    clock.advanceBy(40);
    first.observeStreamEvent({ type: 'tool_call_end', index: 0 });
    first.finish();
    clock.advanceBy(80);
    liveness.markAgentProgress();

    assert.equal(clock.now(), 200);
    assert.equal(liveness.signal.aborted, false);
  });

  it('enforces the absolute deadline even when Agent progress continues', () => {
    const clock = new ManualClock();
    const liveness = createLiveness(clock, { absoluteTurnTimeoutMs: 180 });

    clock.advanceBy(80);
    liveness.markAgentProgress();
    clock.advanceBy(80);
    liveness.markAgentProgress();
    clock.advanceBy(20);

    assert.equal(liveness.timeoutReason, 'absolute_turn_timeout');
    assert.equal(liveness.signal.aborted, true);
  });

  it('enforces Agent-idle while setup has not reached a Provider request', () => {
    const clock = new ManualClock();
    const liveness = createLiveness(clock);

    clock.advanceBy(90);

    assert.equal(liveness.timeoutReason, 'agent_idle_timeout');
    assert.equal(liveness.signal.aborted, true);
  });

  it('emits allowlisted watchdog transitions without depending on UI activity', () => {
    const clock = new ManualClock();
    const transitions: Array<{ watchdog: string; state: string; limitMs: number }> = [];
    const liveness = createAgentTurnLiveness({
      firstResponseTimeoutMs: 90,
      streamIdleTimeoutMs: 45,
      agentIdleTimeoutMs: 90,
      absoluteTurnTimeoutMs: 600,
      clock,
      onWatchdogState: (event) => transitions.push(event),
    });
    const request = liveness.beginProviderRequest();
    request.observeStreamEvent({ type: 'response_start' });
    request.observeStreamEvent({ type: 'text_delta', delta: 'work' });
    clock.advanceBy(45);

    assert.deepEqual(transitions.at(-1), {
      watchdog: 'stream_idle',
      state: 'expired',
      limitMs: 45,
    });
    assert.equal(transitions.some((event) => (
      event.watchdog === 'absolute_turn' && event.state === 'armed'
    )), true);
  });

  it('reports watchdog expiry from the Agent loop as a Provider failure, not a user stop', async () => {
    const clock = new ManualClock();
    const liveness = createLiveness(clock);
    const events: AgentEvent[] = [];
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const pending = runAgentLoop({
      sessionId: 'liveness-timeout',
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Find matching repositories.',
        createdAt: 1,
      }],
      provider: {
        async generate(input) {
          providerStarted();
          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        },
      },
      tools: [],
      liveness,
      emit: (event) => events.push(event),
    });

    await started;
    clock.advanceBy(90);
    const result = await pending;
    liveness.dispose();

    assert.equal(result.reason, 'provider_error');
    assert.equal(liveness.timeoutReason, 'first_response_timeout');
    assert.deepEqual(events.filter((event) => event.type === 'agent_error'), [{
      type: 'agent_error',
      sessionId: 'liveness-timeout',
      message: 'AI provider did not begin responding in time.',
      category: 'provider',
    }]);
  });

  it('keeps an externally stopped turn distinct from a watchdog timeout', () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const liveness = createAgentTurnLiveness({ signal: controller.signal, clock });

    controller.abort('user_stop');

    assert.equal(liveness.signal.aborted, true);
    assert.equal(liveness.timeoutReason, undefined);
  });

  it('lets a user stop win over an already armed first-response watchdog', () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const liveness = createAgentTurnLiveness({
      signal: controller.signal,
      firstResponseTimeoutMs: 90,
      streamIdleTimeoutMs: 45,
      agentIdleTimeoutMs: 90,
      absoluteTurnTimeoutMs: 600,
      clock,
    });
    const request = liveness.beginProviderRequest();

    controller.abort('user_stop');
    clock.advanceBy(600);

    assert.equal(request.signal.aborted, true);
    assert.equal(liveness.signal.aborted, true);
    assert.equal(liveness.timeoutReason, undefined);
  });
});
