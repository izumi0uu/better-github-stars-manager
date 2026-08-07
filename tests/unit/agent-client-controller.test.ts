import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBgsmAgentClientController,
  type BgsmAgentClientController,
  type BgsmAgentClientLabels,
  type BgsmAgentClientSnapshot,
} from '@/ui/agent-client-controller';
import type * as MessagingModule from '@/utils/messaging';

const messaging = vi.hoisted(() => ({
  create: vi.fn(),
  inspect: vi.fn(),
  inspectActive: vi.fn(),
  load: vi.fn(),
  retryDraft: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof MessagingModule>();
  return {
    ...actual,
    createDurableBgsmAgentSession: messaging.create,
    inspectBgsmAgentSessionCatalog: messaging.inspect,
    inspectActiveBgsmAgentSessionTurn: messaging.inspectActive,
    loadDurableBgsmAgentSession: messaging.load,
    readDurableAgentRetryDraftCandidate: messaging.retryDraft,
    startBgsmAgentTurn: messaging.start,
  };
});

beforeEach(() => {
  messaging.create.mockReset();
  messaging.inspect.mockReset();
  messaging.inspectActive.mockReset();
  messaging.load.mockReset();
  messaging.retryDraft.mockReset();
  messaging.start.mockReset();
  messaging.inspect.mockResolvedValue({ summaries: [], corruptions: [] });
  messaging.inspectActive.mockResolvedValue(null);
  messaging.retryDraft.mockResolvedValue(null);
  messaging.create.mockResolvedValue(loadedEmptySession('durable-session'));
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BgsmAgentClientController', () => {
  it('keeps its cached snapshot stable and publishes one immutable atomic hydration view', async () => {
    const controller = createBgsmAgentClientController({ labels: labels() });
    const initial = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(initial);
    const seen: BgsmAgentClientSnapshot[] = [];
    const unsubscribe = controller.subscribe(() => seen.push(controller.getSnapshot()));

    const deactivate = controller.activate();
    await waitForReady(controller);

    const hydrated = controller.getSnapshot();
    expect(hydrated).not.toBe(initial);
    expect(hydrated.sessionReady).toBe(true);
    expect(hydrated.activeSessionId).toBe('durable-session');
    expect(hydrated.sessions.map((session) => session.id)).toContain('durable-session');
    expect(hydrated.messages).toEqual([]);
    expect(Object.isFrozen(hydrated)).toBe(true);
    expect(Object.isFrozen(hydrated.sessions)).toBe(true);
    expect(Object.isFrozen(hydrated.messages)).toBe(true);
    expect(seen.filter((snapshot) => snapshot.sessionReady)).toEqual([hydrated]);

    unsubscribe();
    deactivate();
  });

  it('does not touch Chrome/session messaging while constructed but inactive', () => {
    const controller = createBgsmAgentClientController({ labels: labels() });

    expect(controller.getSnapshot().sessionReady).toBe(false);
    expect(messaging.inspect).not.toHaveBeenCalled();
    expect(messaging.create).not.toHaveBeenCalled();
    expect(messaging.start).not.toHaveBeenCalled();
  });

  it('joins Strict Mode reactivation to one hydration generation', async () => {
    const deferred = createDeferred<{ summaries: never[]; corruptions: never[] }>();
    messaging.inspect.mockReturnValue(deferred.promise);
    const controller = createBgsmAgentClientController({ labels: labels() });

    const firstDeactivate = controller.activate();
    firstDeactivate();
    const secondDeactivate = controller.activate();
    expect(messaging.inspect).toHaveBeenCalledTimes(1);

    deferred.resolve({ summaries: [], corruptions: [] });
    await waitForReady(controller);
    expect(controller.getSnapshot()).toMatchObject({
      sessionReady: true,
      activeSessionId: 'durable-session',
    });
    expect(messaging.inspect).toHaveBeenCalledTimes(1);
    secondDeactivate();
  });

  it('keeps page instances and their selection snapshots isolated', async () => {
    const first = createBgsmAgentClientController({ labels: labels() });
    const second = createBgsmAgentClientController({ labels: labels() });
    expect(first.getSnapshot().activeSessionId).not.toBe(second.getSnapshot().activeSessionId);
    const deactivate = first.activate();


    await waitForReady(first);
    expect(second.getSnapshot().sessionReady).toBe(false);
    deactivate();
  });

  it('detaches an in-flight Port on deactivation without requesting stop', async () => {
    const stop = vi.fn();
    const detach = vi.fn();
    messaging.start.mockReturnValue({ stop, detach, acknowledge: vi.fn() });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const result = controller.startTurn('Keep running after this page closes');
    await Promise.resolve();
    await vi.waitFor(() => expect(messaging.start).toHaveBeenCalledTimes(1));

    deactivate();

    expect(stop).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toBeNull();
  });
});

function labels(): BgsmAgentClientLabels {
  return {
    agentCompacting: 'Compacting',
    agentDone: 'Done',
    agentQueued: 'Queued',
    agentStarting: 'Starting',
    agentStopped: 'Stopped',
    agentThinking: 'Thinking',
    agentWriting: 'Writing',
    agentReadingData: 'Reading',
    agentPreparingOrganizationScope: 'Preparing',
    agentApplyingChanges: 'Applying',
    attemptResumeStateUnknown: 'Resume unknown',
    attemptStateLost: 'Attempt lost',
    turnFailed: 'Turn failed',
  };
}

function loadedEmptySession(id: string) {
  return {
    session: { id, revision: 0 },
    transcript: { sessionId: id, messages: [], nextBeforeSequence: null },
    summary: { id, title: '', createdAt: 1, updatedAt: 1 },
    lastAppliedTurnAttemptId: null,
    appliedTurnReceipts: [],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitForReady(controller: BgsmAgentClientController): Promise<void> {
  await vi.waitFor(() => expect(controller.getSnapshot().sessionReady).toBe(true));
}
