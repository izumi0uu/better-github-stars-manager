/**
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseScopeFingerprintV1 } from '@/bgsm-agent/scope';
import type { BgsmAgentActiveTurn, BgsmAgentTurnError } from '@/bgsm-agent/turn-protocol';
import type {
  AgentRetryDraft,
  AgentSessionCommitResult,
  AgentSessionPresentationMessage,
} from '@/storage/agent-session-store';
import {
  BackgroundCallError,
  type BgsmAgentTurnHandlers,
} from '@/utils/messaging';
import { useBgsmAgent, type BgsmAgentHookState } from '@/ui/hooks/use-bgsm-agent';
import { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';
import { cleanupMountedRootsAndBody, mountReact, type MountedRoot } from './test-utils';

const mocks = vi.hoisted(() => ({
  startTurn: vi.fn(),
  inspectActive: vi.fn(),
  inspect: vi.fn(),
  initial: vi.fn(),
  create: vi.fn(),
  load: vi.fn(),
  loadCommitted: vi.fn(),
  loadPage: vi.fn(),
  delete: vi.fn(),
  retryRead: vi.fn(),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return {
    ...actual,
    startBgsmAgentTurn: mocks.startTurn,
    inspectActiveBgsmAgentSessionTurn: mocks.inspectActive,
    inspectBgsmAgentSessionCatalog: mocks.inspect,
    getOrCreateInitialDurableBgsmAgentSession: mocks.initial,
    createDurableBgsmAgentSession: mocks.create,
    loadDurableBgsmAgentSession: mocks.load,
    loadDurableBgsmAgentSessionCommittedTurn: mocks.loadCommitted,
    loadDurableBgsmAgentSessionTranscriptPage: mocks.loadPage,
    deleteDurableBgsmAgentSession: mocks.delete,
    readDurableAgentRetryDraftCandidate: mocks.retryRead,
  };
});

const mountedRoots: MountedRoot[] = [];
const rawStorageValues: Record<string, unknown> = {};
const storageValues = rawStorageValues;
const TEST_ATTEMPT_DIGEST = `asd:v1:${'a'.repeat(43)}` as `asd:v1:${string}`;
const TEST_LAUNCH_DIGEST = `asl:v1:${'b'.repeat(43)}` as `asl:v1:${string}`;
let organizePort: ReturnType<typeof createOrganizePort>;
let storageSetGate: Readonly<{
  entered: () => void;
  waitUntilReleased: Promise<void>;
}> | null = null;

beforeEach(() => {
  for (const key of Object.keys(storageValues)) delete storageValues[key];
  storageSetGate = null;
  organizePort = createOrganizePort();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(),
      connect: vi.fn(() => organizePort.port),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null) return { ...storageValues };
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, storageValues[key]]));
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storageValues, values);
          const gate = storageSetGate;
          if (gate) {
            gate.entered();
            await gate.waitUntilReleased;
          }
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageValues[key];
        }),
      },
    },
  });
  mocks.startTurn.mockReset();
  mocks.inspectActive.mockReset();
  mocks.inspectActive.mockResolvedValue(null);
  mocks.inspect.mockReset();
  mocks.initial.mockReset();
  mocks.create.mockReset();
  mocks.load.mockReset();
  mocks.loadCommitted.mockReset();
  mocks.loadCommitted.mockResolvedValue(null);
  mocks.loadPage.mockReset();
  mocks.delete.mockReset();
  mocks.retryRead.mockReset();
  mocks.retryRead.mockResolvedValue(null);
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
});

describe('useBgsmAgent durable sessions', () => {
  it('fails closed when durable hydration is unavailable and can retry initialization', async () => {
    const empty = loadedEmptySession('session-after-retry');
    mocks.inspect
      .mockRejectedValueOnce(new Error('service worker unavailable'))
      .mockResolvedValueOnce({ summaries: [], corruptions: [] });
    mocks.initial.mockResolvedValue(empty);
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();

    expect(agent!.sessionReady).toBe(false);
    expect(agent!.sessionInitializationError).toMatch(/history/i);
    await expect(agent!.startTurn('Do not lose this')).resolves.toBeNull();
    expect(mocks.startTurn).not.toHaveBeenCalled();

    await act(async () => {
      expect(agent!.retrySessionHydration()).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agent!.sessionReady).toBe(true);
    expect(agent!.sessionInitializationError).toBeNull();
    expect(agent!.activeSessionId).toBe(empty.session.id);
  });

  it('converges concurrent empty-catalog pages while later explicit selection stays page-local', async () => {
    const initial = loadedEmptySession('session-shared-initial');
    mocks.inspect.mockResolvedValue({ summaries: [], corruptions: [] });
    mocks.initial.mockResolvedValue(initial);
    mocks.create.mockImplementation(async (sessionId: string) => loadedEmptySession(sessionId));
    let pageA: BgsmAgentHookState | null = null;
    let pageB: BgsmAgentHookState | null = null;

    function Harness() {
      pageA = useBgsmAgent(undefined, selectedRepositoryCandidate());
      pageB = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();

    expect(mocks.initial).toHaveBeenCalledTimes(2);
    expect(pageA!.activeSessionId).toBe(initial.session.id);
    expect(pageB!.activeSessionId).toBe(initial.session.id);

    let selectedByPageA: string | null = null;
    await act(async () => {
      selectedByPageA = await pageA!.createSession();
    });

    expect(selectedByPageA).not.toBeNull();
    expect(selectedByPageA).not.toBe(initial.session.id);
    expect(pageA!.activeSessionId).toBe(selectedByPageA);
    expect(pageB!.activeSessionId).toBe(initial.session.id);
  });

  it('fails hydration closed when the background retry projection cannot be read', async () => {
    const empty = loadedEmptySession('session-retry-projection-unavailable');
    storageValues.gsm_agent_active_session_id = empty.session.id;
    mocks.inspect.mockResolvedValue({ summaries: [empty.summary], corruptions: [] });
    mocks.load.mockResolvedValue(empty);
    mocks.retryRead.mockRejectedValueOnce(new Error('retry projection unavailable'));
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();

    expect(agent!.sessionReady).toBe(false);
    expect(agent!.sessionInitializationError).toMatch(/history/i);
    expect(mocks.startTurn).not.toHaveBeenCalled();
  });

  it('hydrates a retry projection from the background and forwards its source ID on retry', async () => {
    const empty = loadedEmptySession('session-retry-projection');
    const draft: AgentRetryDraft = {
      sessionId: empty.session.id,
      turnAttemptId: 'attempt-retry-projection',
      baseRevision: empty.session.revision,
      prompt: 'Retry only this admitted attempt.',
      kind: 'failed',
      settlement: 'retryable',
      updatedAt: 1,
    };
    storageValues.gsm_agent_active_session_id = empty.session.id;
    mocks.inspect.mockResolvedValue({ summaries: [empty.summary], corruptions: [] });
    mocks.load.mockResolvedValue(empty);
    mocks.retryRead.mockResolvedValue(draft);
    mocks.startTurn.mockReturnValue({
      stop: vi.fn(),
      detach: vi.fn(),
      acknowledge: vi.fn(),
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    expect(agent!.durableRetryDraft).toEqual(draft);
    expect(agent!.canRetryLastTurn).toBe(true);

    await act(async () => {
      void agent!.startTurn(draft.prompt, { retrySourceAttemptId: draft.turnAttemptId });
      await Promise.resolve();
    });
    expect(mocks.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      retrySourceAttemptId: draft.turnAttemptId,
    }), expect.any(Object));
  });
  it('does not connect the workbench until the durable active session is hydrated', async () => {
    storageValues.gsm_agent_active_session_id = 'session-durable';
    const durable = loadedSession('session-durable', 2, 'Durable prompt', 'Durable answer');
    let resolveCatalog!: (value: {
      summaries: typeof durable.summary[];
      corruptions: never[];
    }) => void;
    mocks.inspect.mockImplementation(() => new Promise((resolve) => {
      resolveCatalog = resolve;
    }));
    mocks.load.mockResolvedValue(durable);
    let bootstrapSessionId: string | null = null;

    function Harness() {
      const agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      bootstrapSessionId ??= agent.sessionId;
      useBgsmAgentWorkbench(undefined, agent.sessionId, agent.sessionReady);
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    expect(chrome.runtime.connect).not.toHaveBeenCalled();

    await act(async () => {
      resolveCatalog({ summaries: [durable.summary], corruptions: [] });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(chrome.runtime.connect).toHaveBeenCalledTimes(1);
    expect(organizePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'requestBgsmActiveOrganizeJob',
      sessionId: 'session-durable',
    }));
    expect(organizePort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: bootstrapSessionId,
    }));
  });

  it('detaches an active hydrated turn on unmount without stopping it', async () => {
    const activeSession = loadedSession(
      'session-unmount-active',
      2,
      'Previous prompt',
      'Previous answer',
    );
    const activeTurn = {
      executionEpochId: 'bgsm-worker-unmount',
      launch: {
        turnAttemptId: 'session-unmount-active:attempt:original',
        sessionId: activeSession.session.id,
        baseRevision: activeSession.session.revision,
        prompt: 'Keep running after unmount',
      },
    } as const;
    mocks.inspect.mockResolvedValue({
      summaries: [activeSession.summary],
      corruptions: [],
    });
    mocks.load.mockResolvedValue(activeSession);
    mocks.inspectActive.mockResolvedValue(activeTurn);
    const stop = vi.fn();
    const detach = vi.fn();
    mocks.startTurn.mockReturnValue({ stop, detach, acknowledge: vi.fn() });

    function Harness() {
      useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    cleanupMountedRootsAndBody(mountedRoots);

    expect(detach).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    ['after durable inspection', false],
    ['during the resumed Port connection', true],
  ] as const)('reconciles a worker epoch flip %s against current durable authority', async (_label, emitLiveEvent) => {
    const current = loadedEmptySession(`session-epoch-reconcile-${emitLiveEvent ? 'reconnect' : 'inspect'}`);
    const prompt = 'Keep the inspected durable request attached.';
    const originalTurn = activeTurn(current.session.id, prompt, 'worker-epoch-original');
    const replacementTurn = activeTurn(current.session.id, prompt, 'worker-epoch-replacement');
    storageValues.gsm_agent_active_session_id = current.session.id;
    mocks.inspect.mockResolvedValue({ summaries: [current.summary], corruptions: [] });
    mocks.load.mockResolvedValue(current);
    mocks.inspectActive
      .mockResolvedValueOnce(originalTurn)
      .mockResolvedValueOnce(replacementTurn);
    const handlers: BgsmAgentTurnHandlers[] = [];
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers.push(nextHandlers);
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    let agent: BgsmAgentHookState | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    if (emitLiveEvent) {
      await act(async () => {
        handlers[0]!.onEvent?.({
          type: 'agent_queued',
          ...originalTurn.launch,
        });
      });
    }

    await act(async () => {
      handlers[0]!.onError?.(epochChangedError(originalTurn));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.inspectActive).toHaveBeenCalledTimes(2);
    expect(mocks.startTurn).toHaveBeenCalledTimes(2);
    expect(mocks.startTurn).toHaveBeenNthCalledWith(
      2,
      replacementTurn.launch,
      expect.anything(),
      { expectedExecutionEpochId: replacementTurn.executionEpochId, resumeOnly: true },
    );
    expect(mocks.startTurn.mock.calls.map(([launch]) => launch.turnAttemptId))
      .toEqual([originalTurn.launch.turnAttemptId, originalTurn.launch.turnAttemptId]);
    expect(agent!.messages.filter(({ content }) => content === prompt)).toHaveLength(1);
    expect(agent!.running).toBe(true);
    expect(agent!.sessionReady).toBe(false);
  });

  it('does not resume after deactivation wins an in-flight epoch reinspection', async () => {
    const current = loadedEmptySession('session-epoch-reconcile-deactivated');
    const prompt = 'Detach while current authority is being inspected.';
    const originalTurn = activeTurn(current.session.id, prompt, 'worker-epoch-before-deactivate');
    const replacementTurn = activeTurn(current.session.id, prompt, 'worker-epoch-after-deactivate');
    let resolveInspection!: (turn: BgsmAgentActiveTurn) => void;
    const currentInspection = new Promise<BgsmAgentActiveTurn>((resolve) => {
      resolveInspection = resolve;
    });
    storageValues.gsm_agent_active_session_id = current.session.id;
    mocks.inspect.mockResolvedValue({ summaries: [current.summary], corruptions: [] });
    mocks.load.mockResolvedValue(current);
    mocks.inspectActive
      .mockResolvedValueOnce(originalTurn)
      .mockReturnValueOnce(currentInspection);
    const detach = vi.fn();
    const handlers: BgsmAgentTurnHandlers[] = [];
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers.push(nextHandlers);
      return { stop: vi.fn(), detach, acknowledge: vi.fn() };
    });

    function Harness() {
      useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      handlers[0]!.onError?.(epochChangedError(originalTurn));
      await Promise.resolve();
    });
    cleanupMountedRootsAndBody(mountedRoots);
    await act(async () => {
      resolveInspection(replacementTurn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(detach).toHaveBeenCalledOnce();
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
  });

  it('projects state-uncertain when current durable inspection returns no resumable turn', async () => {
    const current = loadedEmptySession('session-epoch-state-uncertain');
    const prompt = 'Do not silently discard uncertain durable work.';
    const originalTurn = activeTurn(current.session.id, prompt, 'worker-epoch-before-uncertain');
    storageValues.gsm_agent_active_session_id = current.session.id;
    mocks.inspect.mockResolvedValue({ summaries: [current.summary], corruptions: [] });
    mocks.load.mockResolvedValue(current);
    mocks.inspectActive
      .mockResolvedValueOnce(originalTurn)
      .mockResolvedValueOnce(null);
    const handlers: BgsmAgentTurnHandlers[] = [];
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers.push(nextHandlers);
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    let agent: BgsmAgentHookState | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      handlers[0]!.onError?.(epochChangedError(originalTurn));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.inspectActive).toHaveBeenCalledTimes(2);
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    expect(agent!.running).toBe(false);
    expect(agent!.sessionReady).toBe(true);
    expect(agent!.error).toMatch(/couldn't confirm this resumed request/i);
    expect(agent!.draftRecovery).toBe(prompt);
    expect(agent!.canRetryLastTurn).toBe(false);
  });

  it('projects a durable terminal commit found after epoch reconciliation returns null', async () => {
    const current = loadedEmptySession('session-epoch-terminal');
    const prompt = 'Recover the committed answer without another Provider call.';
    const originalTurn = activeTurn(current.session.id, prompt, 'worker-epoch-before-terminal');
    const commit = committedSession(originalTurn.launch);
    const terminal = {
      session: commit.session,
      transcript: commit.transcript,
      summary: commit.summary,
      lastAppliedTurnAttemptId: commit.turnAttemptId,
      appliedTurnReceipts: [{
        turnAttemptId: commit.turnAttemptId,
        appliedRevision: commit.appliedRevision,
        digest: commit.digest,
        launchDigest: commit.launchDigest,
        outcome: commit.outcome,
      }],
    };
    storageValues.gsm_agent_active_session_id = current.session.id;
    mocks.inspect.mockResolvedValue({ summaries: [current.summary], corruptions: [] });
    mocks.load
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(terminal);
    mocks.loadCommitted.mockResolvedValue(commit);
    mocks.inspectActive
      .mockResolvedValueOnce(originalTurn)
      .mockResolvedValueOnce(null);
    const acknowledge = vi.fn();
    const handlers: BgsmAgentTurnHandlers[] = [];
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers.push(nextHandlers);
      return { stop: vi.fn(), detach: vi.fn(), acknowledge };
    });
    let agent: BgsmAgentHookState | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      handlers[0]!.onError?.(epochChangedError(originalTurn));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    expect(mocks.loadCommitted).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'applied',
      appliedRevision: commit.appliedRevision,
    });
    expect(agent!.lastTurnResult?.reason).toBe('final_answer');
    expect(agent!.messages.map(({ content }) => content)).toEqual([prompt, 'Persisted answer']);
    expect(agent!.error).toBeNull();
  });

  it('bounds epoch reconciliation to one replacement resume', async () => {
    const current = loadedEmptySession('session-epoch-reconcile-bounded');
    const prompt = 'Bound replacement reconciliation.';
    const originalTurn = activeTurn(current.session.id, prompt, 'worker-epoch-bounded-original');
    const replacementTurn = activeTurn(current.session.id, prompt, 'worker-epoch-bounded-replacement');
    storageValues.gsm_agent_active_session_id = current.session.id;
    mocks.inspect.mockResolvedValue({ summaries: [current.summary], corruptions: [] });
    mocks.load.mockResolvedValue(current);
    mocks.inspectActive
      .mockResolvedValueOnce(originalTurn)
      .mockResolvedValueOnce(replacementTurn);
    const handlers: BgsmAgentTurnHandlers[] = [];
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers.push(nextHandlers);
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    let agent: BgsmAgentHookState | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      handlers[0]!.onError?.(epochChangedError(originalTurn));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.startTurn).toHaveBeenCalledTimes(2);

    await act(async () => {
      handlers[1]!.onError?.(epochChangedError(replacementTurn));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.inspectActive).toHaveBeenCalledTimes(2);
    expect(mocks.startTurn).toHaveBeenCalledTimes(2);
    expect(agent!.running).toBe(false);
    expect(agent!.sessionReady).toBe(false);
    expect(agent!.sessionInitializationError).toMatch(/history/i);
    expect(agent!.draftRecovery).toBe(prompt);
    await act(async () => {
      expect(agent!.retrySessionHydration()).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(agent!.sessionReady).toBe(true);
  });

  it('hydrates only the preferred transcript and lazily loads another session on switch', async () => {
    storageValues.gsm_agent_active_session_id = 'session-older';
    const older = loadedSession('session-older', 1, 'Older prompt', 'Older answer');
    const newer = loadedSession('session-newer', 2, 'Newer prompt', 'Newer answer');
    const staleNewerSummary = { ...newer.summary, title: 'Stale title' };
    mocks.inspect.mockResolvedValue({
      summaries: [staleNewerSummary, older.summary],
      corruptions: [],
    });
    mocks.load.mockImplementation(async (sessionId: string) => {
      if (sessionId === older.session.id) return older;
      if (sessionId === newer.session.id) return newer;
      throw new Error('missing');
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();

    expect(agent!.sessionReady).toBe(true);
    expect(agent!.activeSessionId).toBe('session-older');
    expect(agent!.messages.map((message) => message.content)).toEqual([
      'Older prompt',
      'Older answer',
    ]);
    expect(mocks.load.mock.calls.map(([sessionId]) => sessionId)).toEqual(['session-older']);

    await act(async () => {
      expect(await agent!.switchSession('session-newer')).toBe(true);
    });
    expect(agent!.activeSessionId).toBe('session-newer');
    expect(agent!.messages.map((message) => message.content)).toEqual([
      'Newer prompt',
      'Newer answer',
    ]);
    expect(agent!.sessions.find(({ id }) => id === newer.session.id)?.title)
      .toBe('Newer prompt');
    expect(mocks.load.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-older',
      'session-newer',
    ]);
    expect(storageValues.gsm_agent_active_session_id).toBe('session-newer');
  });

  it('restores a retry draft when switching back to its durable session', async () => {
    const first = loadedSession('session-switch-draft-first', 2, 'First prompt', 'First answer');
    const second = loadedSession('session-switch-draft-second', 1, 'Second prompt', 'Second answer');
    const retryDraft: AgentRetryDraft = {
      sessionId: second.session.id,
      turnAttemptId: 'session-switch-draft-second:retry-attempt',
      baseRevision: second.session.revision,
      prompt: 'Retry this request after switching conversations.',
      kind: 'failed',
      settlement: 'retryable',
      updatedAt: Date.now(),
    };
    storageValues.gsm_agent_active_session_id = first.session.id;
    mocks.inspect.mockResolvedValue({
      summaries: [first.summary, second.summary],
      corruptions: [],
    });
    mocks.load.mockImplementation(async (sessionId: string) => (
      sessionId === first.session.id ? first : second
    ));
    mocks.retryRead.mockImplementation(async (sessionId: string) => (
      sessionId === second.session.id ? retryDraft : null
    ));
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    expect(agent!.durableRetryDraft).toBeNull();

    await act(async () => {
      expect(await agent!.switchSession(second.session.id)).toBe(true);
    });

    expect(agent!.activeSessionId).toBe(second.session.id);
    expect(agent!.canRetryLastTurn).toBe(true);
    expect(agent!.durableRetryDraft).toMatchObject({
      prompt: 'Retry this request after switching conversations.',
      settlement: 'retryable',
    });
    expect(mocks.retryRead).toHaveBeenCalledWith(second.session.id);
  });

  it('prepends bounded transcript pages without replacing the active session', async () => {
    const loadedRecent = loadedSession('session-paged', 2, 'Recent prompt', 'Recent answer');
    const recent = {
      ...loadedRecent,
      transcript: {
        ...loadedRecent.transcript,
        nextBeforeSequence: 3 as number | null,
      },
    };
    const earlierMessages = [
      {
        id: 'session-paged-old-user',
        role: 'user' as const,
        content: 'Older prompt',
        createdAt: 1,
      },
      {
        id: 'session-paged-old-agent',
        role: 'agent' as const,
        content: 'Older answer',
        createdAt: 2,
      },
    ];
    mocks.inspect.mockResolvedValue({ summaries: [recent.summary], corruptions: [] });
    mocks.load.mockResolvedValue(recent);
    mocks.loadPage.mockResolvedValue({
      sessionId: recent.session.id,
      messages: earlierMessages,
      nextBeforeSequence: null,
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    expect(agent!.hasEarlierMessages).toBe(true);

    await act(async () => {
      expect(await agent!.loadEarlierMessages()).toBe(true);
    });

    expect(mocks.loadPage).toHaveBeenCalledWith(recent.session.id, 3);
    expect(agent!.activeSessionId).toBe(recent.session.id);
    expect(agent!.messages.map((message) => message.content)).toEqual([
      'Older prompt',
      'Older answer',
      'Recent prompt',
      'Recent answer',
    ]);
    expect(agent!.hasEarlierMessages).toBe(false);
    expect(agent!.loadingEarlierMessages).toBe(false);
  });

  it('keeps a transiently unavailable transcript retryable instead of marking it corrupt', async () => {
    storageValues.gsm_agent_active_session_id = 'session-primary';
    const primary = loadedSession('session-primary', 2, 'Primary prompt', 'Primary answer');
    const retryable = loadedSession('session-retryable', 1, 'Retry prompt', 'Retry answer');
    mocks.inspect.mockResolvedValue({
      summaries: [primary.summary, retryable.summary],
      corruptions: [],
    });
    mocks.load.mockImplementation(async (sessionId: string) => {
      if (sessionId === primary.session.id) return primary;
      if (mocks.load.mock.calls.filter(([id]) => id === retryable.session.id).length === 1) {
        throw new Error('temporary transport failure');
      }
      return retryable;
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();

    await act(async () => {
      expect(await agent!.switchSession(retryable.session.id)).toBe(false);
    });
    expect(agent!.sessions.find((session) => session.id === retryable.session.id)?.corrupt)
      .not.toBe(true);

    await act(async () => {
      expect(await agent!.switchSession(retryable.session.id)).toBe(true);
    });
    expect(agent!.activeSessionId).toBe(retryable.session.id);
  });

  it('exposes pending session operations so the composer cannot race a slow switch', async () => {
    storageValues.gsm_agent_active_session_id = 'session-active';
    const active = loadedSession('session-active', 2, 'Active prompt', 'Active answer');
    const next = loadedSession('session-slow', 1, 'Slow prompt', 'Slow answer');
    let resolveNext!: (value: typeof next) => void;
    const nextLoad = new Promise<typeof next>((resolve) => {
      resolveNext = resolve;
    });
    mocks.inspect.mockResolvedValue({
      summaries: [active.summary, next.summary],
      corruptions: [],
    });
    mocks.load.mockImplementation((sessionId: string) => (
      sessionId === active.session.id ? Promise.resolve(active) : nextLoad
    ));
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();

    let switchPromise!: Promise<boolean>;
    await act(async () => {
      switchPromise = agent!.switchSession(next.session.id);
      await Promise.resolve();
    });
    expect(agent!.sessionOperationPending).toBe(true);
    await expect(agent!.startTurn('Must not be discarded')).resolves.toBeNull();
    expect(mocks.startTurn).not.toHaveBeenCalled();

    await act(async () => {
      resolveNext(next);
      expect(await switchPromise).toBe(true);
    });
    expect(agent!.sessionOperationPending).toBe(false);
    expect(agent!.activeSessionId).toBe(next.session.id);
  });

  it('keeps an isolated corrupt session available for explicit deletion', async () => {
    storageValues.gsm_agent_active_session_id = 'session-valid';
    const valid = loadedSession('session-valid', 2, 'Valid prompt', 'Valid answer');
    mocks.inspect.mockResolvedValue({
      summaries: [valid.summary],
      corruptions: [{ sessionId: 'session-corrupt', message: 'Header is malformed.' }],
    });
    mocks.load.mockResolvedValue(valid);
    mocks.delete.mockResolvedValue(true);
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();

    expect(agent!.sessions).toContainEqual(expect.objectContaining({
      id: 'session-corrupt',
      corrupt: true,
    }));
    await act(async () => {
      expect(await agent!.switchSession('session-corrupt')).toBe(false);
      expect(await agent!.deleteSession('session-corrupt')).toBe(true);
    });
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.delete).toHaveBeenCalledWith('session-corrupt');
    expect(agent!.sessions.some((session) => session.id === 'session-corrupt')).toBe(false);
  });


  it('adopts a background-owned commit and acknowledges it without a UI commit RPC', async () => {
    const empty = loadedEmptySession('session-direct-commit');
    mocks.inspect.mockResolvedValue({ summaries: [], corruptions: [] });
    mocks.initial.mockResolvedValue(empty);
    let handlers: BgsmAgentTurnHandlers | null = null;
    const acknowledge = vi.fn();
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    let turnPromise!: Promise<unknown>;
    await act(async () => {
      turnPromise = agent!.startTurn('Persist this turn');
      await Promise.resolve();
    });
    const input = mocks.startTurn.mock.calls[0]![0];
    const messages = [
      { id: 'commit-user', role: 'user' as const, content: input.prompt, createdAt: 1 },
      { id: 'commit-agent', role: 'agent' as const, content: 'Persisted answer', createdAt: 2 },
    ];

    await act(async () => {
      handlers!.onEvent?.({
        type: 'assistant_text_delta',
        step: 1,
        delta: 'Persisted ',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      });
      handlers!.onResult?.({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: committedSession(input, messages),
      });
      await turnPromise;
    });

    expect(acknowledge).toHaveBeenCalledWith({ disposition: 'applied', appliedRevision: 1 });
    expect(agent!.sessions[0]?.title).toBe('Persist this turn');
    expect(agent!.messages.map((message) => message.content)).toEqual([
      'Persist this turn',
      'Persisted answer',
    ]);
    expect(agent!.messages.some((message) => message.streaming)).toBe(false);
  });

  it('uses presentation messages when raw transcript paging omits the current prompt and answer', async () => {
    const empty = loadedEmptySession('session-bounded-presentation');
    mocks.inspect.mockResolvedValue({ summaries: [], corruptions: [] });
    mocks.initial.mockResolvedValue(empty);
    let handlers: BgsmAgentTurnHandlers | null = null;
    const acknowledge = vi.fn();
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    let turnPromise!: Promise<unknown>;
    await act(async () => {
      turnPromise = agent!.startTurn('Keep my prompt visible');
      await Promise.resolve();
    });
    const input = mocks.startTurn.mock.calls[0]![0];
    const promptMessage = {
      sequence: 1,
      id: 'bounded-user',
      role: 'user' as const,
      content: input.prompt,
      createdAt: 1,
    };
    const answerMessage = {
      sequence: 12,
      id: 'bounded-agent',
      role: 'agent' as const,
      content: 'The full analysis is complete.',
      createdAt: 12,
    };
    const transcriptMessages = [{
      sequence: 11,
      id: 'bounded-tool',
      role: 'tool' as const,
      content: '{"bounded":true}',
      createdAt: 11,
      toolCallId: 'bounded-call',
      toolName: 'search_stars',
    }];

    await act(async () => {
      handlers!.onResult?.({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: committedSession(input, transcriptMessages, {
          title: input.prompt,
          nextBeforeSequence: 11,
          presentationMessages: [promptMessage, answerMessage],
        }),
      });
      await turnPromise;
    });

    expect(acknowledge).toHaveBeenCalledWith({ disposition: 'applied', appliedRevision: 1 });
    expect(agent!.messages.map((message) => message.content)).toEqual([
      input.prompt,
      '{"bounded":true}',
      'The full analysis is complete.',
    ]);
    expect(agent!.hasEarlierMessages).toBe(true);
    expect(agent!.error).toBeNull();
  });

  it('orders a replayed retained receipt before newer messages after its turn falls outside the latest page', async () => {
    const empty = loadedEmptySession('session-idempotent-receipt');
    mocks.inspect.mockResolvedValue({ summaries: [empty.summary], corruptions: [] });
    mocks.load.mockResolvedValue(empty);
    let handlers: BgsmAgentTurnHandlers | null = null;
    const acknowledge = vi.fn();
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    let turnPromise!: Promise<unknown>;
    await act(async () => {
      turnPromise = agent!.startTurn('Recover the committed turn');
      await Promise.resolve();
    });
    const input = mocks.startTurn.mock.calls[0]![0];
    const newerMessages = Array.from({ length: 100 }, (_, index) => ({
      sequence: index + 3,
      id: `newer-${index}`,
      role: (index % 2 === 0 ? 'user' : 'agent') as 'user' | 'agent',
      content: `Newer message ${index}`,
      createdAt: index + 3,
    }));
    const replayedPresentation = [
      {
        sequence: 1,
        id: 'receipt-user',
        role: 'user' as const,
        content: input.prompt,
        createdAt: 1,
      },
      {
        sequence: 2,
        id: 'receipt-agent',
        role: 'agent' as const,
        content: 'Recovered.',
        createdAt: 2,
      },
    ];

    await act(async () => {
      handlers!.onResult?.({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: committedSession(input, newerMessages, {
          appliedRevision: 1,
          sessionRevision: 2,
          idempotent: true,
          nextBeforeSequence: 3,
          presentationMessages: replayedPresentation,
        }),
      });
      await turnPromise;
    });

    expect(acknowledge).toHaveBeenCalledWith({ disposition: 'applied', appliedRevision: 1 });
    expect(agent!.messages.map(({ sequence, id, content }) => ({ sequence, id, content }))).toEqual([
      ...replayedPresentation.map(({ sequence, id, content }) => ({ sequence, id, content })),
      ...newerMessages.map(({ sequence, id, content }) => ({ sequence, id, content })),
    ]);
    expect(new Set(agent!.messages.map(({ id }) => id)).size).toBe(102);
    await act(async () => {
      void agent!.startTurn('Continue from latest');
      await Promise.resolve();
    });
    expect(mocks.startTurn.mock.calls[1]![0]).toMatchObject({
      sessionId: input.sessionId,
      baseRevision: 2,
    });
  });

  it('rehydrates before retry when durable turn admission finds the session deleted', async () => {
    const deleted = loadedEmptySession('session-deleted-before-start');
    const replacement = loadedSession(
      'session-admission-replacement',
      2,
      'Admission replacement',
      'Ready for the next prompt',
    );
    mocks.inspect
      .mockResolvedValueOnce({ summaries: [deleted.summary], corruptions: [] })
      .mockResolvedValueOnce({ summaries: [replacement.summary], corruptions: [] });
    mocks.load
      .mockResolvedValueOnce(deleted)
      .mockResolvedValueOnce(replacement);
    const acknowledge = vi.fn();
    let handlers: BgsmAgentTurnHandlers | null = null;
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    let turnPromise!: Promise<unknown>;
    await act(async () => {
      turnPromise = agent!.startTurn('Start against deleted session');
      await Promise.resolve();
    });
    const input = mocks.startTurn.mock.calls[0]![0];
    await act(async () => {
      handlers!.onError?.({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: 'Conversation was deleted in another tab.',
        category: 'other',
        code: 'agent_session_not_found',
      });
      await turnPromise;
    });

    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'no_transition',
      appliedRevision: null,
    });
    expect(agent!.activeSessionId).toBe(replacement.session.id);
    expect(agent!.sessions.some((session) => session.id === deleted.session.id)).toBe(false);
    expect(agent!.messages.map((message) => message.content)).toEqual([
      'Admission replacement',
      'Ready for the next prompt',
    ]);
    expect(agent!.error).toBeNull();
    expect(storageValues.gsm_agent_active_session_id).toBe(replacement.session.id);
  });

  it('resumes a replacement session active turn after admission recovery settles', async () => {
    const deleted = loadedEmptySession('session-deleted-before-replacement-resume');
    const replacement = loadedSession(
      'session-active-admission-replacement',
      2,
      'Replacement prompt',
      'Replacement answer',
    );
    const activeTurn = {
      executionEpochId: 'bgsm-worker-active-admission-replacement',
      launch: {
        turnAttemptId: 'session-active-admission-replacement:attempt:original',
        sessionId: replacement.session.id,
        baseRevision: replacement.session.revision,
        prompt: 'Resume the replacement session turn',
        candidateContract: selectedRepositoryCandidate(),
      },
    } as const;
    mocks.inspect
      .mockResolvedValueOnce({ summaries: [deleted.summary], corruptions: [] })
      .mockResolvedValueOnce({ summaries: [replacement.summary], corruptions: [] });
    mocks.load
      .mockResolvedValueOnce(deleted)
      .mockResolvedValueOnce(replacement);
    mocks.inspectActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeTurn);
    const handlers: BgsmAgentTurnHandlers[] = [];
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers.push(nextHandlers);
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    let markStorageSetEntered!: () => void;
    let releaseStorageSet!: () => void;
    const storageSetEntered = new Promise<void>((resolve) => {
      markStorageSetEntered = resolve;
    });
    const storageSetReleased = new Promise<void>((resolve) => {
      releaseStorageSet = resolve;
    });
    storageSetGate = {
      entered: markStorageSetEntered,
      waitUntilReleased: storageSetReleased,
    };
    let turnPromise!: Promise<unknown>;
    await act(async () => {
      turnPromise = agent!.startTurn('Start against the deleted session');
      await Promise.resolve();
    });
    const initialInput = mocks.startTurn.mock.calls[0]![0];

    await act(async () => {
      handlers[0]!.onError?.({
        turnAttemptId: initialInput.turnAttemptId,
        sessionId: initialInput.sessionId,
        baseRevision: initialInput.baseRevision,
        message: 'Conversation was deleted in another tab.',
        category: 'other',
        code: 'agent_session_not_found',
      });
      await storageSetEntered;
    });

    expect(agent!.activeSessionId).toBe(replacement.session.id);
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseStorageSet();
      await turnPromise;
    });
    await flushAsyncWork();

    expect(mocks.startTurn).toHaveBeenCalledTimes(2);
    expect(mocks.startTurn).toHaveBeenNthCalledWith(
      2,
      activeTurn.launch,
      expect.anything(),
      { expectedExecutionEpochId: activeTurn.executionEpochId, resumeOnly: true },
    );
  });

  it('waits for session switching to settle before resuming its active turn', async () => {
    const initial = loadedEmptySession('session-before-active-switch');
    const target = loadedSession(
      'session-active-switch-target',
      2,
      'Target prompt',
      'Target answer',
    );
    const activeTurn = {
      executionEpochId: 'bgsm-worker-active-switch-target',
      launch: {
        turnAttemptId: 'session-active-switch-target:attempt:original',
        sessionId: target.session.id,
        baseRevision: target.session.revision,
        prompt: 'Resume after switching sessions',
        candidateContract: selectedRepositoryCandidate(),
      },
    } as const;
    mocks.inspect.mockResolvedValue({
      summaries: [initial.summary, target.summary],
      corruptions: [],
    });
    mocks.load.mockImplementation(async (sessionId: string) => (
      sessionId === initial.session.id ? initial : target
    ));
    mocks.inspectActive.mockImplementation(async (sessionId: string) => (
      sessionId === target.session.id ? activeTurn : null
    ));
    mocks.startTurn.mockReturnValue({
      stop: vi.fn(),
      detach: vi.fn(),
      acknowledge: vi.fn(),
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    let markStorageSetEntered!: () => void;
    let releaseStorageSet!: () => void;
    const storageSetEntered = new Promise<void>((resolve) => {
      markStorageSetEntered = resolve;
    });
    const storageSetReleased = new Promise<void>((resolve) => {
      releaseStorageSet = resolve;
    });
    storageSetGate = {
      entered: markStorageSetEntered,
      waitUntilReleased: storageSetReleased,
    };
    let switchPromise!: Promise<boolean>;

    await act(async () => {
      switchPromise = agent!.switchSession(target.session.id);
      await storageSetEntered;
    });

    expect(agent!.activeSessionId).toBe(target.session.id);
    expect(agent!.sessionOperationPending).toBe(true);
    expect(mocks.startTurn).not.toHaveBeenCalled();

    await act(async () => {
      releaseStorageSet();
      expect(await switchPromise).toBe(true);
    });
    await flushAsyncWork();

    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    expect(mocks.startTurn).toHaveBeenCalledWith(
      activeTurn.launch,
      expect.anything(),
      { expectedExecutionEpochId: activeTurn.executionEpochId, resumeOnly: true },
    );
  });

  it('recovers an idempotent create when the response channel closes after commit', async () => {
    const initial = loadedEmptySession('session-create-initial');
    mocks.inspect.mockResolvedValue({ summaries: [initial.summary], corruptions: [] });
    let candidateSessionId = '';
    mocks.create.mockImplementation(async (sessionId: string) => {
      candidateSessionId = sessionId;
      throw new Error('response channel closed');
    });
    mocks.load.mockImplementation(async (sessionId: string) => (
      sessionId === initial.session.id ? initial : loadedEmptySession(sessionId)
    ));
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      expect(await agent!.createSession()).toBe(candidateSessionId);
    });

    expect(candidateSessionId).toMatch(/^bgsm_session_/u);
    expect(agent!.activeSessionId).toBe(candidateSessionId);
    expect(mocks.load).toHaveBeenCalledWith(candidateSessionId);
  });

  it('revalidates a cached transcript before switching after another tab deletes it', async () => {
    const first = loadedSession('session-cached-first', 2, 'First prompt', 'First answer');
    const second = loadedSession('session-cached-second', 1, 'Second prompt', 'Second answer');
    mocks.inspect.mockResolvedValue({
      summaries: [first.summary, second.summary],
      corruptions: [],
    });
    mocks.load
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new BackgroundCallError(
        'Conversation was deleted in another tab.',
        { sessionId: first.session.id },
        'agent_session_not_found',
      ));
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      expect(await agent!.switchSession(second.session.id)).toBe(true);
      expect(await agent!.switchSession(first.session.id)).toBe(false);
    });

    expect(agent!.activeSessionId).toBe(second.session.id);
    expect(agent!.sessions.some(({ id }) => id === first.session.id)).toBe(false);
    expect(mocks.load).toHaveBeenCalledTimes(3);
  });

  it('revalidates cached fallback sessions before deleting the active conversation', async () => {
    const active = loadedSession('session-delete-current', 3, 'Current prompt', 'Current answer');
    const cached = loadedSession('session-delete-cached', 2, 'Cached prompt', 'Cached answer');
    const fallback = loadedSession('session-delete-fallback', 1, 'Fallback prompt', 'Fallback answer');
    let cachedDeletedRemotely = false;
    mocks.inspect.mockResolvedValue({
      summaries: [active.summary, cached.summary, fallback.summary],
      corruptions: [],
    });
    mocks.load.mockImplementation(async (sessionId: string) => {

      if (sessionId === active.session.id) return active;
      if (sessionId === cached.session.id) {
        if (cachedDeletedRemotely) {
          throw new BackgroundCallError(
            'Conversation was deleted in another tab.',
            { sessionId },
            'agent_session_not_found',
          );
        }
        return cached;
      }
      if (sessionId === fallback.session.id) return fallback;
      throw new Error(`Unexpected session ${sessionId}`);
    });
    mocks.delete.mockResolvedValue(true);
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      expect(await agent!.switchSession(cached.session.id)).toBe(true);
      expect(await agent!.switchSession(active.session.id)).toBe(true);
    });
    cachedDeletedRemotely = true;

    await act(async () => {
      expect(await agent!.deleteSession(active.session.id)).toBe(true);
    });

    expect(agent!.activeSessionId).toBe(fallback.session.id);
    expect(agent!.messages.map((message) => message.content)).toEqual([
      'Fallback prompt',
      'Fallback answer',
    ]);
    expect(agent!.sessions.map(({ id }) => id)).not.toContain(active.session.id);
    expect(agent!.sessions.map(({ id }) => id)).not.toContain(cached.session.id);
  });

  it('reconciles an ambiguous delete response against the durable catalog', async () => {
    const active = loadedSession('session-delete-active', 2, 'Active prompt', 'Active answer');
    const deleted = loadedEmptySession('session-delete-ambiguous');
    mocks.inspect
      .mockResolvedValueOnce({
        summaries: [active.summary, deleted.summary],
        corruptions: [],
      })
      .mockResolvedValueOnce({ summaries: [active.summary], corruptions: [] });
    mocks.load.mockResolvedValue(active);
    mocks.delete.mockRejectedValueOnce(new Error('response channel closed'));
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    await act(async () => {
      expect(await agent!.deleteSession(deleted.session.id)).toBe(true);
    });

    expect(agent!.sessions.some(({ id }) => id === deleted.session.id)).toBe(false);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
  });

  it('isolates a session that becomes corrupt during turn admission', async () => {
    const corrupt = loadedEmptySession('session-runtime-corrupt');
    const replacement = loadedSession(
      'session-corrupt-replacement',
      2,
      'Healthy replacement',
      'Ready for another turn',
    );
    mocks.inspect
      .mockResolvedValueOnce({ summaries: [corrupt.summary], corruptions: [] })
      .mockResolvedValueOnce({
        summaries: [replacement.summary],
        corruptions: [{ sessionId: corrupt.session.id, message: 'History is malformed.' }],
      });
    mocks.load
      .mockResolvedValueOnce(corrupt)
      .mockResolvedValueOnce(replacement);
    const acknowledge = vi.fn();
    let handlers: BgsmAgentTurnHandlers | null = null;
    mocks.startTurn.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    let turnPromise!: Promise<unknown>;
    await act(async () => {
      turnPromise = agent!.startTurn('Read a damaged conversation');
      await Promise.resolve();
    });
    const input = mocks.startTurn.mock.calls[0]![0];
    await act(async () => {
      handlers!.onError?.({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: 'Conversation history is corrupt.',
        category: 'other',
        code: 'agent_session_corrupt',
      });
      await turnPromise;
    });

    expect(agent!.activeSessionId).toBe(replacement.session.id);
    expect(agent!.sessions).toContainEqual(expect.objectContaining({
      id: corrupt.session.id,
      corrupt: true,
    }));
    expect(agent!.messages.map((message) => message.content)).toEqual([
      'Healthy replacement',
      'Ready for another turn',
    ]);
    expect(agent!.error).toBeNull();
    expect(agent!.sessionReady).toBe(true);
  });
  it('recovers the active page after a post-commit session deletion invalidation', async () => {
    const deleted = loadedSession(
      'session-deleted-in-another-page',
      3,
      'Unsent composer text stays outside session state',
      'Old answer',
    );
    const replacement = loadedSession(
      'session-after-deletion-invalidation',
      2,
      'Replacement conversation',
      'Ready',
    );
    storageValues.gsm_agent_active_session_id = deleted.session.id;
    mocks.inspect.mockResolvedValue({
      summaries: [deleted.summary, replacement.summary],
      corruptions: [],
    });
    mocks.load.mockImplementation(async (sessionId: string) => (
      sessionId === deleted.session.id ? deleted : replacement
    ));
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, selectedRepositoryCandidate());
      const workbench = useBgsmAgentWorkbench(undefined, agent.sessionId, agent.sessionReady);
      useEffect(() => {
        agent!.invalidateDeletedSessions(workbench.state.deletedSessionIds);
      }, [workbench.state.deletedSessionIds]);
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await flushAsyncWork();
    const activeRequest = organizePort.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'requestBgsmActiveOrganizeJob');
    expect(activeRequest).toBeDefined();

    await act(async () => {
      organizePort.emit({
        type: 'bgsmAgentSessionDeleted',
        controllerId: activeRequest.controllerId,
        sessionId: activeRequest.sessionId,
        deletedSessionId: deleted.session.id,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agent!.activeSessionId).toBe(replacement.session.id);
    expect(agent!.sessions.some(({ id }) => id === deleted.session.id)).toBe(false);
    expect(agent!.messages.map(({ content }) => content)).toEqual([
      'Replacement conversation',
      'Ready',
    ]);
    expect(storageValues.gsm_agent_active_session_id).toBe(replacement.session.id);
  });

});

function selectedRepositoryCandidate() {
  return {
    kind: 'selected_repository' as const,
    selectedRepositoryIdHint: 'owner/repo',
  };
}

function activeTurn(
  sessionId: string,
  prompt: string,
  executionEpochId: string,
): BgsmAgentActiveTurn {
  return {
    executionEpochId,
    launch: {
      turnAttemptId: `${sessionId}:attempt:hydrated`,
      sessionId,
      baseRevision: 0,
      prompt,
      candidateContract: selectedRepositoryCandidate(),
    },
  };
}

function epochChangedError(turn: BgsmAgentActiveTurn): BgsmAgentTurnError {
  return {
    turnAttemptId: turn.launch.turnAttemptId,
    sessionId: turn.launch.sessionId,
    baseRevision: turn.launch.baseRevision,
    message: 'The active request belongs to a previous worker.',
    category: 'other',
    code: 'agent_turn_resume_epoch_changed',
  };
}

function conversationBinding() {
  return {
    version: 1 as const,
    candidateContract: selectedRepositoryCandidate(),
    scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
    label: 'owner/repo',
    count: 1,
    providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
  };
}

function loadedSession(
  id: string,
  updatedAt: number,
  prompt: string,
  answer: string,
) {
  const messages = [
    { sequence: 1, id: `${id}-user`, role: 'user' as const, content: prompt, createdAt: 1 },
    { sequence: 2, id: `${id}-agent`, role: 'agent' as const, content: answer, createdAt: 2 },
  ];
  return {
    session: {
      id,
      revision: 1,
      binding: conversationBinding(),
    },
    transcript: { sessionId: id, messages, nextBeforeSequence: null },
    summary: { id, title: prompt, createdAt: 1, updatedAt },
    lastAppliedTurnAttemptId: `${id}-attempt`,
    appliedTurnReceipts: [{
      turnAttemptId: `${id}-attempt`,
      appliedRevision: 1,
      digest: TEST_ATTEMPT_DIGEST,
    }],
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


function committedSession(
  input: {
    sessionId: string;
    turnAttemptId: string;
    baseRevision: number;
    prompt: string;
  },
  transcriptMessages: Array<{
    sequence?: number;
    id: string;
    role: 'user' | 'agent' | 'tool';
    content: string;
    createdAt: number;
    toolCallId?: string;
    toolName?: string;
  }> = [
    { id: 'commit-user', role: 'user', content: input.prompt, createdAt: 1 },
    { id: 'commit-agent', role: 'agent', content: 'Persisted answer', createdAt: 2 },
  ],
  options: {
    title?: string;
    nextBeforeSequence?: number | null;
    presentationMessages?: readonly AgentSessionPresentationMessage[];
    appliedRevision?: number;
    sessionRevision?: number;
    idempotent?: boolean;
    binding?: ReturnType<typeof conversationBinding>;
    outcomeReason?: AgentSessionCommitResult['outcome']['reason'];
    writeSettlement?: 'none' | 'all_failed' | 'unsafe';
  } = {},
): AgentSessionCommitResult {
  const appliedRevision = options.appliedRevision ?? input.baseRevision + 1;
  const sessionRevision = options.sessionRevision ?? appliedRevision;
  const title = options.title ?? input.prompt;
  const binding = options.binding ?? conversationBinding();
  const transcript = transcriptMessages.map((message, index) => ({
    ...message,
    sequence: message.sequence ?? index + 1,
  }));
  const presentationMessages: readonly AgentSessionPresentationMessage[] =
    options.presentationMessages ?? transcript.flatMap((message) => (
      message.role === 'user' || message.role === 'agent'
        ? [{
            sequence: message.sequence,
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          }]
        : []
    ));
  return {
    session: {
      id: input.sessionId,
      revision: sessionRevision,
      binding,
    },
    summary: {
      id: input.sessionId,
      title,
      createdAt: 1,
      updatedAt: 2,
    },
    turnAttemptId: input.turnAttemptId,
    idempotent: options.idempotent ?? false,
    appliedRevision,
    digest: TEST_ATTEMPT_DIGEST,
    launchDigest: TEST_LAUNCH_DIGEST,
    outcome: {
      reason: options.outcomeReason ?? 'final_answer',
      changed: false,
      changedCount: 0,
      writeSettlement: options.writeSettlement ?? 'none',
    },
    transcript: {
      sessionId: input.sessionId,
      messages: transcript,
      nextBeforeSequence: options.nextBeforeSequence ?? null,
    },
    presentationMessages,
  };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createOrganizePort() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const postMessage = vi.fn();
  const emit = (message: unknown) => {
    for (const listener of messageListeners) {
      listener({
        type: 'bgsmOrganizeJobRunDelivery',
        connectionEpochId: 'connection-epoch-session-deletion',
        deliverySequence: 0,
        deliveryKind: 'live',
        durableRevision: null,
        message,
      });
    }
  };
  const disconnect = vi.fn();
  const port = {
    name: 'bgsm-agent-organize-job',
    postMessage,
    disconnect,
    onMessage: {
      addListener: (listener: (message: unknown) => void) => messageListeners.add(listener),
      removeListener: (listener: (message: unknown) => void) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) => disconnectListeners.add(listener),
      removeListener: (listener: () => void) => disconnectListeners.delete(listener),
    },
  } as unknown as chrome.runtime.Port;
  return { port, postMessage, disconnect, emit };
}
