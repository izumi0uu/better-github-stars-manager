/**
 * @vitest-environment jsdom
 */
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BgsmAgentConversationBinding,
  BgsmAgentConversationCandidate,
} from '@/bgsm-agent/conversation-binding';
import { parseScopeFingerprint } from '@/bgsm-agent/scope';
import type { BgsmAgentTurnInput } from '@/bgsm-agent/session';
import { AgentHost } from '@/ui/components/AgentHost';
import type { BgsmAgentTurnHandlers } from '@/utils/messaging';
import type {
  AgentSessionCommitResult,
  LoadedAgentSession,
} from '@/storage/agent-session-store';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const messagingMocks = vi.hoisted(() => ({
  startBgsmAgentTurn: vi.fn(),
  inspectCatalog: vi.fn(),
  inspectActive: vi.fn(),
  loadSession: vi.fn(),
  getOrCreateSession: vi.fn(),
  createSession: vi.fn(),
  retryDraft: vi.fn(),
}));
const presentationMocks = vi.hoisted(() => ({
  ownsWorkbench: false,
}));
const workbenchMocks = vi.hoisted(() => ({
  releaseOwnership: null as (() => void) | null,
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return {
    ...actual,
    startBgsmAgentTurn: messagingMocks.startBgsmAgentTurn,
    inspectBgsmAgentSessionCatalog: messagingMocks.inspectCatalog,
    inspectActiveBgsmAgentSessionTurn: messagingMocks.inspectActive,
    loadDurableBgsmAgentSession: messagingMocks.loadSession,
    getOrCreateInitialDurableBgsmAgentSession: messagingMocks.getOrCreateSession,
    createDurableBgsmAgentSession: messagingMocks.createSession,
    readDurableAgentRetryDraftCandidate: messagingMocks.retryDraft,
  };
});

vi.mock('@/ui/agent-ui-presentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/agent-ui-presentation')>();
  return {
    ...actual,
    selectOrganizeWorkbenchView: (...args: Parameters<typeof actual.selectOrganizeWorkbenchView>) => {
      const view = actual.selectOrganizeWorkbenchView(...args);
      if (!presentationMocks.ownsWorkbench) return view;
      return {
        ...view,
        capabilities: {
          ...view.capabilities,
          canSwitchSession: false,
          canChat: true,
        },
      };
    },
  };
});

vi.mock('@/ui/hooks/use-bgsm-agent-workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/hooks/use-bgsm-agent-workbench')>();
  return {
    ...actual,
    useBgsmAgentWorkbench: (...args: Parameters<typeof actual.useBgsmAgentWorkbench>) => {
      const workbench = actual.useBgsmAgentWorkbench(...args);
      const [, forceOwnershipRender] = useState(0);
      workbenchMocks.releaseOwnership = () => {
        workbench.clearTerminal();
        forceOwnershipRender((revision) => revision + 1);
      };
      return { ...workbench, state: { ...workbench.state } };
    },
  };
});

type CapturedTurn = Readonly<{
  input: BgsmAgentTurnInput;
  handlers: BgsmAgentTurnHandlers;
}>;

const mountedRoots: MountedRoot[] = [];
let turns: CapturedTurn[];
let turnBindings: Map<string, BgsmAgentConversationBinding>;

beforeEach(() => {
  turns = [];
  turnBindings = new Map();
  presentationMocks.ownsWorkbench = false;
  workbenchMocks.releaseOwnership = null;
  messagingMocks.startBgsmAgentTurn.mockReset();
  messagingMocks.inspectCatalog.mockReset();
  messagingMocks.inspectActive.mockReset();
  messagingMocks.inspectActive.mockResolvedValue(null);
  messagingMocks.loadSession.mockReset();
  messagingMocks.getOrCreateSession.mockReset();
  messagingMocks.createSession.mockReset();
  messagingMocks.createSession.mockImplementation(async (sessionId: string) => (
    loadedEmptySession(sessionId)
  ));
  messagingMocks.retryDraft.mockReset();
  messagingMocks.retryDraft.mockResolvedValue(null);
  messagingMocks.startBgsmAgentTurn.mockImplementation((
    input: BgsmAgentTurnInput,
    handlers: BgsmAgentTurnHandlers,
  ) => {
    turns.push({ input, handlers });
    return { stop: vi.fn(), acknowledge: vi.fn() };
  });
  vi.stubGlobal('chrome', { runtime: {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
});

describe('AgentHost repository selection', () => {
  it('uses the latest repository in an unbound session without creating another conversation', async () => {
    const container = await mountHarness(selectedRepository('owner/repo-a'));

    await click(actionButton(container, 'select-repo-b'));
    await click(actionButton(container, 'select-repo-c'));

    await expectSessionCount(container, 1);
    expect(composerText(container)).toContain('owner/repo-c');
    const turn = await sendPrompt(container, 'Inspect this repository');
    expect(turn.input.candidateContract).toEqual(selectedRepository('owner/repo-c'));
    expect(turn.input.binding).toBeUndefined();
    expect(turn.input.baseRevision).toBe(0);
    expect(turn.input.history).toEqual([]);
  });

  it('starts a fresh conversation when the selected repository differs from the hydrated conversation', async () => {
    const staleView = currentView('');
    const hydrated = loadedBoundSession(
      'session-stale-current-view',
      conversationBinding(staleView, 'h'),
    );
    enableDurableSessions(hydrated);

    const container = await mountHarness(selectedRepository('owner/repo-b'));
    await flushEffects();

    await expectSessionCount(container, 2);
    expect(composerText(container)).toContain('owner/repo-b');
    const turn = await sendPrompt(container, 'Inspect the selected repository');
    expect(turn.input.sessionId).not.toBe(hydrated.session.id);
    expect(turn.input.baseRevision).toBe(0);
    expect(turn.input.candidateContract).toEqual(selectedRepository('owner/repo-b'));
    expect(turn.input.binding).toBeUndefined();
  });

  it('starts a fresh conversation when the tag-filtered view differs from the hydrated conversation', async () => {
    const staleView = currentView('');
    const hydrated = loadedBoundSession(
      'session-stale-unfiltered-view',
      conversationBinding(staleView, 'i'),
    );
    enableDurableSessions(hydrated);
    const taggedView = currentView('', ['agents']);

    const container = await mountHarness(taggedView);
    await flushEffects();

    await expectSessionCount(container, 2);
    const turn = await sendPrompt(container, 'Inspect the tagged view');
    expect(turn.input.sessionId).not.toBe(hydrated.session.id);
    expect(turn.input.baseRevision).toBe(0);
    expect(turn.input.candidateContract).toEqual(taggedView);
    expect(turn.input.binding).toBeUndefined();
  });

  it('starts a fresh conversation when an idle bound repository changes', async () => {
    const repositoryA = selectedRepository('owner/repo-a');
    const container = await mountHarness(repositoryA);
    const first = await sendPrompt(container, 'Inspect repository A');
    await bindAndComplete(first, conversationBinding(repositoryA, 'a'));

    await click(actionButton(container, 'select-repo-b'));
    await flushEffects();

    await expectSessionCount(container, 2);
    expect(composerText(container)).toContain('owner/repo-b');
    const second = await sendPrompt(container, 'Inspect repository B');
    expect(second.input.sessionId).not.toBe(first.input.sessionId);
    expect(second.input.baseRevision).toBe(0);
    expect(second.input.history).toEqual([]);
    expect(second.input.candidateContract).toEqual(selectedRepository('owner/repo-b'));
    expect(second.input.binding).toBeUndefined();
  });

  it('keeps the latest busy-time selection and rotates after the turn settles', async () => {
    const repositoryA = selectedRepository('owner/repo-a');
    const container = await mountHarness(repositoryA);
    const first = await sendPrompt(container, 'Inspect repository A');
    await bindTurn(first, conversationBinding(repositoryA, 'b'));

    await click(actionButton(container, 'select-repo-b'));
    await click(actionButton(container, 'select-repo-c'));
    expect(turns).toHaveLength(1);
    expect(composerText(container)).toContain('owner/repo-a');

    await completeTurn(first);
    await flushEffects();

    expect(composerText(container)).toContain('owner/repo-c');
    const second = await sendPrompt(container, 'Inspect the latest selection');
    expect(second.input.sessionId).not.toBe(first.input.sessionId);
    expect(second.input.candidateContract).toEqual(selectedRepository('owner/repo-c'));
    expect(second.input.binding).toBeUndefined();
  });

  it('blocks stale-scope chat while the workbench owns the bound session', async () => {
    presentationMocks.ownsWorkbench = true;
    const repositoryA = selectedRepository('owner/repo-a');
    const container = await mountHarness(repositoryA);
    const first = await sendPrompt(container, 'Inspect repository A');
    await bindAndComplete(first, conversationBinding(repositoryA, 'd'));

    await click(actionButton(container, 'select-repo-b'));
    await flushEffects();

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    expect(container.textContent).toContain(
      'Selected owner/repo-b · finish or discard the current Organize run to switch conversations',
    );
    expect(turns).toHaveLength(1);

    await releaseWorkbenchOwnership();
    await flushEffects();

    await expectSessionCount(container, 2);
    expect(composerText(container)).toContain('owner/repo-b');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
  });

  it('starts a fresh conversation when bound current-view tags change', async () => {
    const initialView = currentView('');
    const container = await mountHarness(initialView);
    const first = await sendPrompt(container, 'Inspect this view');
    await bindAndComplete(first, conversationBinding(initialView, 'c'));

    await click(actionButton(container, 'select-tag-agents'));
    await flushEffects();

    await expectSessionCount(container, 2);
    const second = await sendPrompt(container, 'Inspect the tagged view');
    expect(second.input.sessionId).not.toBe(first.input.sessionId);
    expect(second.input.baseRevision).toBe(0);
    expect(second.input.history).toEqual([]);
    expect(second.input.candidateContract).toEqual(currentView('', ['agents']));
    expect(second.input.binding).toBeUndefined();
  });
});

function Harness({ initialCandidate }: { initialCandidate: BgsmAgentConversationCandidate }) {
  const [candidate, setCandidate] = useState(initialCandidate);
  return (
    <>
      <button
        type="button"
        data-testid="select-repo-b"
        onClick={() => setCandidate(selectedRepository('owner/repo-b'))}
      >
        Select B
      </button>
      <button
        type="button"
        data-testid="select-repo-c"
        onClick={() => setCandidate(selectedRepository('owner/repo-c'))}
      >
        Select C
      </button>
      <button
        type="button"
        data-testid="select-tag-agents"
        onClick={() => setCandidate(currentView('', ['agents']))}
      >
        Select agents tag
      </button>
      <AgentHost
        open
        onHide={() => {}}
        onPresentationChange={() => {}}
        defaultCandidate={candidate}
        chatCandidate={candidate}
        scopeCount={candidate.kind === 'selected_repository' ? 1 : 2}
      />
    </>
  );
}

async function mountHarness(initialCandidate: BgsmAgentConversationCandidate) {
  const container = mountReact(<Harness initialCandidate={initialCandidate} />, mountedRoots);
  await flushEffects();
  return container;
}

async function releaseWorkbenchOwnership(): Promise<void> {
  const releaseOwnership = workbenchMocks.releaseOwnership;
  if (!releaseOwnership) throw new Error('Workbench release callback not found.');
  await act(async () => {
    presentationMocks.ownsWorkbench = false;
    releaseOwnership();
    await Promise.resolve();
  });
}

async function sendPrompt(container: HTMLElement, prompt: string): Promise<CapturedTurn> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('Agent composer not found.');
  await setTextareaValue(textarea, prompt);
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
  const turn = turns.at(-1);
  if (!turn) throw new Error('Agent turn did not start.');
  return turn;
}

async function bindAndComplete(
  turn: CapturedTurn,
  binding: BgsmAgentConversationBinding,
): Promise<void> {
  await act(async () => {
    turnBindings.set(turn.input.turnAttemptId, binding);
    turn.handlers.onEvent?.({
      ...deliveryIdentity(turn.input),
      type: 'conversation_bound',
      binding,
    });
    deliverTurnResult(turn);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function bindTurn(
  turn: CapturedTurn,
  binding: BgsmAgentConversationBinding,
): Promise<void> {
  await act(async () => {
    turnBindings.set(turn.input.turnAttemptId, binding);
    turn.handlers.onEvent?.({
      ...deliveryIdentity(turn.input),
      type: 'conversation_bound',
      binding,
    });
    await Promise.resolve();
  });
}

async function completeTurn(turn: CapturedTurn): Promise<void> {
  await act(async () => {
    deliverTurnResult(turn);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deliverTurnResult(turn: CapturedTurn): void {
  turn.handlers.onResult?.({
    ...deliveryIdentity(turn.input),
    reason: 'final_answer',
    changed: false,
    changedCount: 0,
    commit: commitForTurn(turn),
  });
}

function commitForTurn(turn: CapturedTurn): AgentSessionCommitResult {
  const appliedRevision = turn.input.baseRevision + 1;
  const messages = [
    {
      sequence: 1,
      id: `${turn.input.turnAttemptId}:user`,
      role: 'user' as const,
      content: turn.input.prompt,
      createdAt: 1,
    },
    {
      sequence: 2,
      id: `${turn.input.turnAttemptId}:assistant`,
      role: 'agent' as const,
      content: 'Done.',
      createdAt: 2,
    },
  ];
  return {
    session: {
      id: turn.input.sessionId,
      revision: appliedRevision,
      ...(turnBindings.has(turn.input.turnAttemptId)
        ? { binding: turnBindings.get(turn.input.turnAttemptId) }
        : {}),
    },
    summary: {
      id: turn.input.sessionId,
      title: turn.input.prompt,
      createdAt: 1,
      updatedAt: 2,
    },
    turnAttemptId: turn.input.turnAttemptId,
    idempotent: false,
    appliedRevision,
    digest: `asd:v1:${'a'.repeat(43)}`,
    launchDigest: `asl:v1:${'b'.repeat(43)}`,
    outcome: {
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      writeSettlement: 'none',
    },
    transcript: {
      sessionId: turn.input.sessionId,
      messages,
      nextBeforeSequence: null,
    },
    presentationMessages: messages,
  } as AgentSessionCommitResult;
}

function deliveryIdentity(input: BgsmAgentTurnInput) {
  return {
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
  };
}

function conversationBinding(
  candidateContract: BgsmAgentConversationCandidate,
  fingerprintCharacter: string,
): BgsmAgentConversationBinding {
  return {
    version: 1,
    candidateContract,
    scopeFingerprint: parseScopeFingerprint(
      `fs:${fingerprintCharacter.repeat(43)}`,
    ),
    label: candidateContract.kind === 'selected_repository'
      ? candidateContract.selectedRepositoryIdHint
      : 'Current view',
    count: candidateContract.kind === 'selected_repository' ? 1 : 2,
    providerFingerprint: `pcf:v1:${'p'.repeat(43)}`,
  };
}

function selectedRepository(selectedRepositoryIdHint: string): BgsmAgentConversationCandidate {
  return { kind: 'selected_repository', selectedRepositoryIdHint };
}

function currentView(
  query: string,
  tags: readonly string[] = [],
): BgsmAgentConversationCandidate {
  return {
    kind: 'current_view',
    filter: {
      query,
      languages: [],
      tags,
      tagMode: 'any',
      showTombstone: false,
      onlyFavorite: false,
      onlyUntagged: false,
      onlyArchived: false,
      onlyOwned: false,
      sortKey: 'starred_at',
      sortDir: 'desc',
    },
  };
}

function loadedBoundSession(
  id: string,
  binding: BgsmAgentConversationBinding,
): LoadedAgentSession {
  return {
    session: { id, revision: 1, binding },
    transcript: { sessionId: id, messages: [], nextBeforeSequence: null },
    summary: { id, title: 'Previous conversation', createdAt: 1, updatedAt: 1 },
    lastAppliedTurnAttemptId: `${id}:attempt`,
    appliedTurnReceipts: [],
  };
}

function loadedEmptySession(id: string): LoadedAgentSession {
  return {
    session: { id, revision: 0 },
    transcript: { sessionId: id, messages: [], nextBeforeSequence: null },
    summary: { id, title: '', createdAt: 1, updatedAt: 1 },
    lastAppliedTurnAttemptId: null,
    appliedTurnReceipts: [],
  };
}

function enableDurableSessions(hydrated: LoadedAgentSession): void {
  messagingMocks.inspectCatalog.mockResolvedValue({
    summaries: [hydrated.summary],
    corruptions: [],
  });
  messagingMocks.loadSession.mockResolvedValue(hydrated);
  messagingMocks.getOrCreateSession.mockResolvedValue(hydrated);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
  });
}

function actionButton(container: HTMLElement, testId: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`Action button not found: ${testId}`);
  return button;
}

async function expectSessionCount(container: HTMLElement, count: number): Promise<void> {
  const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]');
  if (!toggle) throw new Error('Session menu toggle not found.');
  await click(toggle);
  expect(document.body.querySelectorAll('[data-testid="agent-session-item"]')).toHaveLength(count);
  await click(toggle);
}

function composerText(container: HTMLElement): string {
  return container.querySelector('textarea')?.closest('form')?.textContent ?? '';
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
