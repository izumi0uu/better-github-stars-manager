/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { AgentPanel as PresentationalAgentPanel } from '@/ui/components/AgentPanel';
import { useBgsmAgent } from '@/ui/hooks/use-bgsm-agent';
import type { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';
import { createAgentWorkbenchState, type AgentWorkbenchState } from '@/ui/agent-workbench-state';
import { cleanupMountedRootsAndBody, click, mountReact, type MountedRoot } from './test-utils';
import type { BgsmAgentTurnResult } from '@/bgsm-agent/turn-protocol';
import type {
  BgsmAgentTurnHandlers,
  BgsmOrganizeJobPresentation,
} from '@/utils/messaging';
import type { BgsmAgentTurnInput } from '@/bgsm-agent/session';
import type {
  AgentRetryDraft,
  AgentSessionCommitResult,
  LoadedAgentSession,
} from '@/storage/agent-session-store';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import {
  createFrozenScope,
  parseScopeFingerprint,
  projectFrozenScope,
  type LaunchCandidateContract,
} from '@/bgsm-agent/scope';
import { parseControllerId, parseProposalId, parseRunId } from '@/bgsm-agent/identity';
import { createEmptyRunBudgetUsage, createProductionRunBudget } from '@/bgsm-agent/policy';
import type { OrganizeJobRunSnapshot } from '@/bgsm-agent/events';
import { WORKER_LOST_COPY } from '@/ui/agent-workbench-state';

const messagingMocks = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  createSession: vi.fn(),
  inspectCatalog: vi.fn(),
  inspectActive: vi.fn(),
  loadSession: vi.fn(),
  retryDraft: vi.fn(),
  startBgsmAgentTurn: vi.fn(),
  requestPreflight: vi.fn(),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return {
    ...actual,
    startBgsmAgentTurn: messagingMocks.startBgsmAgentTurn,
    getOrCreateInitialDurableBgsmAgentSession: messagingMocks.getOrCreate,
    createDurableBgsmAgentSession: messagingMocks.createSession,
    inspectBgsmAgentSessionCatalog: messagingMocks.inspectCatalog,
    inspectActiveBgsmAgentSessionTurn: messagingMocks.inspectActive,
    loadDurableBgsmAgentSession: messagingMocks.loadSession,
    readDurableAgentRetryDraftCandidate: messagingMocks.retryDraft,
  };
});

const conversationRenderMock = vi.hoisted(() => vi.fn());

type ConversationProps = Readonly<{
  active?: boolean;
  scrollKey: string | number;
  resumeLabel: string;
  className?: string;
  children: ReactNode;
}>;

vi.mock('@/ui/ai-elements/chat', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown> & {
    Conversation: (props: ConversationProps) => ReactElement;
  };
  return {
    ...actual,
    Conversation: (props: Parameters<typeof actual.Conversation>[0]) => {
      conversationRenderMock();
      return createElement(actual.Conversation, props);
    },
  };
});

const mountedRoots: MountedRoot[] = [];
const scrollIntoViewMock = vi.fn();

function commitForMessages(
  input: Pick<BgsmAgentTurnInput, 'sessionId' | 'turnAttemptId' | 'baseRevision' | 'prompt'>,
  messages: readonly {
    id: string;
    role: 'user' | 'agent' | 'tool';
    content: string;
    createdAt: number;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: readonly { id: string; name: string; arguments: unknown }[];
  }[],
  options: Readonly<{
    reason?: 'final_answer' | 'provider_error' | 'aborted' | 'context_limit';
    changed?: boolean;
    changedCount?: number;
    writeSettlement?: 'none' | 'all_failed' | 'unsafe';
    contextFailureReason?: string;
    organizeLibraryAction?: 'request_confirmation' | 'start_analysis';
    candidateCheckpoint?: unknown;
    binding?: unknown;
  }> = {},
): AgentSessionCommitResult {
  const appliedRevision = input.baseRevision + 1;
  const transcript = messages.map((message, index) => ({
    sequence: index + 1,
    ...message,
    ...(message.toolCalls ? { toolCalls: [...message.toolCalls] } : {}),
  }));
  const presentationMessages = transcript
    .filter((message): message is typeof message & { role: 'user' | 'agent' } => (
      message.role === 'user' || message.role === 'agent'
    ))
    .filter((message) => message.content.trim().length > 0);
  return {
    session: {
      id: input.sessionId,
      revision: appliedRevision,
      ...(options.candidateCheckpoint ? { compaction: options.candidateCheckpoint as never } : {}),
      ...(options.binding ? { binding: options.binding as never } : {}),
    },
    summary: {
      id: input.sessionId,
      title: input.prompt,
      createdAt: 1,
      updatedAt: 2,
    },
    turnAttemptId: input.turnAttemptId,
    idempotent: false,
    appliedRevision,
    digest: `asd:v1:${'a'.repeat(43)}`,
    launchDigest: `asl:v1:${'b'.repeat(43)}`,
    outcome: {
      reason: options.reason ?? 'final_answer',
      changed: options.changed ?? false,
      changedCount: options.changedCount ?? 0,
      writeSettlement: options.writeSettlement ?? 'none',
      ...(options.contextFailureReason ? { contextFailureReason: options.contextFailureReason as never } : {}),
      ...(options.organizeLibraryAction
        ? {
            organizeLibraryAction: options.organizeLibraryAction,
            handoffAnchor: { messageId: presentationMessages.at(-1)?.id ?? null, createdAt: 2 },
          }
        : {}),
    },
    transcript: {
      sessionId: input.sessionId,
      messages: transcript,
      nextBeforeSequence: null,
    },
    presentationMessages: presentationMessages.map((message) => ({
      sequence: message.sequence,
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
  } as AgentSessionCommitResult;
}


function durableEmptySession(id: string): LoadedAgentSession {
  return {
    session: { id, revision: 0 },
    transcript: { sessionId: id, messages: [], nextBeforeSequence: null },
    summary: { id, title: '', createdAt: 1, updatedAt: 1 },
    lastAppliedTurnAttemptId: null,
    appliedTurnReceipts: [],
  };
}
function selectedRepositoryBinding(): Record<string, unknown> {
  return {
    version: 1,
    candidateContract: {
      kind: 'selected_repository',
      selectedRepositoryIdHint: 'owner/repo',
    },
    scopeFingerprint: `fs:${'a'.repeat(43)}`,
    label: 'owner/repo',
    count: 1,
    providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
  };
}

beforeEach(() => {
  messagingMocks.startBgsmAgentTurn.mockReset();
  messagingMocks.getOrCreate.mockReset();
  messagingMocks.createSession.mockReset();
  messagingMocks.inspectCatalog.mockReset();
  messagingMocks.inspectActive.mockReset();
  messagingMocks.loadSession.mockReset();
  messagingMocks.retryDraft.mockReset();
  messagingMocks.inspectCatalog.mockResolvedValue({ summaries: [], corruptions: [] });
  messagingMocks.inspectActive.mockResolvedValue(null);
  messagingMocks.retryDraft.mockResolvedValue(null);
  messagingMocks.startBgsmAgentTurn.mockReturnValue({
    stop: vi.fn(),
    detach: vi.fn(),
    acknowledge: vi.fn(),
  });
  messagingMocks.requestPreflight.mockReset();
  conversationRenderMock.mockReset();
  scrollIntoViewMock.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoViewMock,
  });
});

function AgentPanel({
  open,
  onClose,
  onDataChanged,
  onOpenOptions,
  handoff = null,
  onDismissHandoff,
  defaultCandidate = { kind: 'all_live_stars' },
  blockedConversationCandidate = null,
  scopeCount,
  workbenchState,
  onClearTerminal,
  onStop,
  onTakeControl,
  agentOverrides,
}: {
  open: boolean;
  onClose: () => void;
  onDataChanged?: () => void;
  onOpenOptions?: () => void;
  handoff?: { remainingUntagged: number; autoTagged: number } | null;
  onDismissHandoff?: () => void;
  defaultCandidate?: LaunchCandidateContract;
  blockedConversationCandidate?: BgsmAgentConversationCandidate | null;
  scopeCount?: number;
  workbenchState?: AgentWorkbenchState;
  onClearTerminal?: () => void;
  onStop?: () => void;
  onTakeControl?: () => void;
  agentOverrides?: Partial<ReturnType<typeof useBgsmAgent>>;
}) {
  const agent = useBgsmAgent(onDataChanged, {
    kind: 'selected_repository',
    selectedRepositoryIdHint: 'owner/repo',
  });
  const presentedAgent = { ...agent, ...agentOverrides };
  const workbench = {
    state: workbenchState ?? createAgentWorkbenchState('controller:v1:test', presentedAgent.sessionId),
    displayedProcessed: 0,
    terminalDismissFailed: false,
    requestPreflight: messagingMocks.requestPreflight,
    captureAgentHandoffAuthority: vi.fn(() => 0),
    applyAgentHandoff: vi.fn((handoff) => {
      if (handoff.action === 'request_confirmation') {
        messagingMocks.requestPreflight(handoff.instruction);
      }
      return true;
    }),
    startWholeLibraryFromAgent: vi.fn(),
    confirmPreflight: vi.fn(),
    cancelPreflight: vi.fn(),
    stop: onStop ?? vi.fn(),
    continueRemaining: vi.fn(),
    discardBlockedRun: vi.fn(),
    discardReview: vi.fn(),
    toggleProposalRow: vi.fn(),
    setAllProposalRowsSelected: vi.fn(),
    applySelected: vi.fn(),
    clearTerminal: onClearTerminal ?? vi.fn(),
    takeControl: onTakeControl ?? vi.fn(),
    restartWholeLibrary: vi.fn(),
    requestOrganizeReviewPage: vi.fn(),
    requestOrganizeReceiptPage: vi.fn(),
    resumeOrganizeApply: vi.fn(),
  } as ReturnType<typeof useBgsmAgentWorkbench>;
  return (
    <PresentationalAgentPanel
      open={open}
      onHide={onClose}
      onOpenOptions={onOpenOptions}
      agent={presentedAgent}
      workbench={workbench}
      defaultCandidate={defaultCandidate}
      blockedConversationCandidate={blockedConversationCandidate}
      scopeCount={scopeCount}
      handoff={handoff}
      onDismissHandoff={onDismissHandoff}
    />
  );
}

function ProjectionTransitionHarness() {
  const [workbenchState, setWorkbenchState] = useState<AgentWorkbenchState>(() => (
    durableWorkbenchState('review', { role: 'owner' })
  ));
  return (
    <>
      <button
        type="button"
        data-testid="projection-observer"
        onClick={() => setWorkbenchState((current) => ({ ...current, role: 'observer' }))}
      />
      <button
        type="button"
        data-testid="projection-owner-lost"
        onClick={() => setWorkbenchState((current) => ({ ...current, role: 'owner_lost' }))}
      />
      <button
        type="button"
        data-testid="projection-conflict"
        onClick={() => setWorkbenchState((current) => ({
          ...current,
          error: 'A second Organize run was rejected.',
          organizeFailureReason: 'already_started',
        }))}
      />
      <button
        type="button"
        data-testid="projection-session-deleted"
        onClick={() => setWorkbenchState((current) => ({
          ...current,
          deletedSessionIds: new Set([...current.deletedSessionIds, 'session-lock-test']),
        }))}
      />
      <button
        type="button"
        data-testid="projection-terminal"
        onClick={() => setWorkbenchState(completedWorkbenchState())}
      />
      <AgentPanel
        open
        onClose={vi.fn()}
        workbenchState={workbenchState}
        agentOverrides={{
          activeSessionId: 'session-lock-test',
          sessionId: 'session-lock-test',
          sessionReady: true,
          sessionOperationPending: false,
        }}
      />
    </>
  );
}

function TakeoverFocusHarness() {
  const [workbenchState, setWorkbenchState] = useState<AgentWorkbenchState>(() => (
    durableWorkbenchState('review', { role: 'owner_lost' })
  ));
  return (
    <AgentPanel
      open
      onClose={vi.fn()}
      workbenchState={workbenchState}
      onTakeControl={() => setWorkbenchState((current) => ({
        ...current,
        role: 'owner',
        organizeJob: current.organizeJob
          ? { ...current.organizeJob, revision: current.organizeJob.revision + 1 }
          : null,
      }))}
    />
  );
}

async function mountAgentPanel(element: ReactElement) {
  const container = mountReact(element, mountedRoots);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}
function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function composerNote(container: HTMLElement): Element | null {
  return container.querySelector('textarea')?.closest('form')?.firstElementChild ?? null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('AgentPanel', () => {
  it('keeps chat disabled until Agent and Workbench share the same session identity', async () => {
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        workbenchState={createAgentWorkbenchState(
          'controller:v1:session-rebind',
          'session-awaiting-rebind',
        )}
      />,
    );

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
      .toBe(true);
  });

  it('blocks chat from using the old scope while an Organize-owned session waits to switch', async () => {
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        defaultCandidate={{
          kind: 'selected_repository',
          selectedRepositoryIdHint: 'owner/repo-b',
        }}
        blockedConversationCandidate={{
          kind: 'selected_repository',
          selectedRepositoryIdHint: 'owner/repo-b',
        }}
      />,
    );

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.disabled).toBe(true);
    expect(composerNote(container)?.textContent).toContain('owner/repo-b');
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('opens the single Cubby settings surface without starting a request', async () => {
    const onOpenOptions = vi.fn();
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onOpenOptions={onOpenOptions} />
    );
    const chips = [...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="agent-ready-quick-chips"] button',
    )];
    expect(chips).toHaveLength(4);
    await click(chips[3]!);
    expect(onOpenOptions).toHaveBeenCalledOnce();
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('lists scope functions and inserts the selected prompt without sending', async () => {
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);

    const functionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Suggested actions"]');
    const composer = container.querySelector('textarea')?.closest('form');
    const header = container.querySelector('#gsm-agent-dialog-title')?.closest('.border-b');
    expect(composer?.contains(functionButton)).toBe(true);
    expect(header?.contains(functionButton)).toBe(false);

    await click(functionButton!);
    await waitFor(() => {
      expect(document.body.querySelector('[role="group"][aria-label="Choose an action"]')).toBeTruthy();
    });
    const menu = document.body.querySelector<HTMLElement>('[role="group"][aria-label="Choose an action"]')!;
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[role="menuitem"]')).toBeNull();
    const suggestions = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    expect(suggestions).toHaveLength(4);
    await click(suggestions[0]!);

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.value.length).toBeGreaterThan(0);
    expect(document.body.querySelector('[role="group"][aria-label="Choose an action"]')).toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('inserts a tag cleanup request for the Agent without UI-side capability gating', async () => {
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Suggested actions"]')!);
    await waitFor(() => {
      expect(document.body.querySelector('[role="group"][aria-label="Choose an action"]')).toBeTruthy();
    });
    const menu = document.body.querySelector<HTMLElement>('[role="group"][aria-label="Choose an action"]')!;
    const suggestions = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    expect(suggestions).toHaveLength(4);
    await click(suggestions[3]!);

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.value.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(textarea);
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('sends with Enter while Shift+Enter remains available for a new line', async () => {
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;

    await setTextareaValue(textarea, 'Send this with Enter');
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Send this with Enter' }),
      expect.any(Object),
    );

    messagingMocks.startBgsmAgentTurn.mockClear();
    await setTextareaValue(textarea, 'Keep editing');
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('adds code search and private notes suggestions for one selected repository', async () => {
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        defaultCandidate={{
          kind: 'selected_repository',
          selectedRepositoryIdHint: 'owner/repo',
        }}
      />,
    );

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Suggested actions"]')!);
    await waitFor(() => {
      expect(document.body.querySelector('[role="group"][aria-label="Choose an action"]')).toBeTruthy();
    });
    const menu = document.body.querySelector<HTMLElement>('[role="group"][aria-label="Choose an action"]')!;
    const suggestions = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    expect(suggestions).toHaveLength(6);
    await click(suggestions[4]!);

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value.length).toBeGreaterThan(0);
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('shows the canonical selected repository without freeze copy before binding arrives', async () => {
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        defaultCandidate={{
          kind: 'selected_repository',
          selectedRepositoryIdHint: 'owner/repo',
        }}
        scopeCount={1}
      />,
    );

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'What does this repository do?');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(composerNote(container)?.textContent).toBe('owner/repo');
  });

  it('renders the intro, prompt chips, and scoped composer note without idle machine status', async () => {
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onOpenOptions={vi.fn()} />
    );
    const quickChips = container.querySelector('[data-testid="agent-ready-quick-chips"]');
    expect(quickChips).toBeTruthy();
    expect(quickChips?.querySelectorAll('button')).toHaveLength(4);
    expect(composerNote(container)?.textContent?.trim().length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="agent-header-status"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-mascot"]')?.getAttribute('data-state')).toBe('idle');
  });

  it('closes from the backdrop or Escape while the drawer is open', async () => {
    const onClose = vi.fn();
    const container = await mountAgentPanel(<AgentPanel open onClose={onClose} />);

    await act(async () => {
      container.querySelector<HTMLElement>('.gsm-agent-drawer-scrim')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    await act(async () => {
      mountedRoots[0].render(<AgentPanel open={false} onClose={onClose} />);
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('provides modal semantics, traps focus, and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const container = await mountAgentPanel(<AgentPanel open onClose={onClose} />);
    const drawer = container.querySelector<HTMLElement>('aside')!;

    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.getAttribute('aria-labelledby')).toBe('gsm-agent-dialog-title');
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('Ask Cubby');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close Cubby');
    const focusable = [...drawer.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    await act(async () => {
      focusable.at(-1)?.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(focusable[0]);

    await act(async () => {
      mountedRoots.at(-1)?.render(<AgentPanel open={false} onClose={onClose} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(opener);
  });

  it('fills the composer from the whole-library suggestion without starting work', async () => {
    const onDataChanged = vi.fn();

    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onDataChanged={onDataChanged} />
    );

    const chips = [...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="agent-ready-quick-chips"] button',
    )];
    expect(chips).toHaveLength(3);
    await click(chips[1]!);

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value.length).toBeGreaterThan(0);
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
    expect(onDataChanged).not.toHaveBeenCalled();
  });

  it('keeps the whole-library suggestion independent from a selected-repository chat scope', async () => {
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        defaultCandidate={{
          kind: 'selected_repository',
          selectedRepositoryIdHint: 'owner/repo',
        }}
      />,
    );

    const chips = [...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="agent-ready-quick-chips"] button',
    )];
    expect(chips).toHaveLength(3);
    await click(chips[1]!);

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value.length).toBeGreaterThan(0);
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();
  });

  it('sends custom user prompts to the agent stream', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();

    await setTextareaValue(textarea!, 'Only tag TypeScript build tools');
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    expect(sendButton).not.toBeNull();
    await click(sendButton!);

    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Only tag TypeScript build tools' }),
      expect.any(Object),
    );
    expect(container.textContent).toContain('Only tag TypeScript build tools');
    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeTruthy();

    await act(async () => {
      handlers?.onEvent?.({
        type: 'message_update',
        ...deliveryIdentity(turnInput!),
        message: {
          id: 'm-agent',
          role: 'agent',
          content: 'I inspected your tags and skipped unclear repos.',
          createdAt: 1,
        },
      });
      handlers?.onResult?.({
        ...deliveryIdentity(turnInput!),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turnInput!, [
          { id: 'custom-user', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          {
            id: 'm-agent',
            role: 'agent',
            content: 'I inspected your tags and skipped unclear repos.',
            createdAt: 2,
          },
        ]),
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('I inspected your tags');
    });
  });

  it('sends a typed whole-library request through Agent handoff before scope confirmation', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const prompt = 'Create useful tags for all my starred repositories.';

    await setTextareaValue(textarea, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();
    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt }),
      expect.any(Object),
    );
    expect(textarea.value).toBe('');
    if (!turn) throw new Error('expected whole-library Agent turn');
    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'tool_execution_start',
        toolName: 'request_full_library_organization',
        callId: 'whole-library-handoff',
        risk: 'suggest',
      });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="agent-tool-activity"]')).toBeTruthy();

    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'tool_execution_end',
        toolName: 'request_full_library_organization',
        callId: 'whole-library-handoff',
        ok: true,
        risk: 'suggest',
        writeOutcome: 'not_applicable',
      });
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn!.input, [
          { id: 'whole-user', role: 'user', content: prompt, createdAt: 1 },
          { id: 'whole-agent', role: 'agent', content: 'Opening scope confirmation.', createdAt: 2 },
        ]),
        organizeLibraryHandoff: {
          type: 'organize_whole_library',
          action: 'request_confirmation',
          instruction: prompt,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(messagingMocks.requestPreflight).toHaveBeenCalledWith(prompt);
    expect(container.querySelector('[data-testid="agent-readonly-result-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-tool-activity"]')).toBeNull();
  });

  it('keeps whole-library read-only questions in the regular agent stream', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const prompt = 'Summarize all my starred repositories without changing tags.';

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt }),
      expect.any(Object),
    );
    if (!turn) throw new Error('expected read-only whole-library turn');
    await act(async () => {
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn!.input, [
          { id: 'read-only-whole-user', role: 'user', content: prompt, createdAt: 1 },
          {
            id: 'read-only-whole-agent',
            role: 'agent',
            content: 'Here is the requested read-only summary.',
            createdAt: 2,
          },
        ]),
      });
      await Promise.resolve();
    });
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Here is the requested read-only summary.');
  });

  it('honors Agent handoff for varied whole-library language', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const prompt = '把我收藏的项目都归归类';

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();
    if (!turn) throw new Error('expected semantic fallback turn');

    await act(async () => {
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn!.input, [
          { id: 'handoff-user', role: 'user', content: prompt, createdAt: 1 },
          {
            id: 'handoff-agent',
            role: 'agent',
            content: 'I will open scope confirmation.',
            createdAt: 2,
          },
        ]),
        organizeLibraryHandoff: {
          type: 'organize_whole_library',
          action: 'request_confirmation',
          instruction: prompt,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messagingMocks.requestPreflight).toHaveBeenCalledWith(prompt);
  });

  it('grows one transient assistant message and atomically reconciles the final result', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Stream this');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    if (!turn) throw new Error('expected turn');

    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'assistant_stream_start',
        step: 0,
      });
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'assistant_text_delta',
        step: 0,
        delta: 'Hello ',
      });
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'assistant_text_delta',
        step: 0,
        delta: '## world',
      });
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-streaming-message"]')?.textContent)
        .toBe('Hello ## world');
    });
    const streaming = container.querySelector('[data-testid="agent-streaming-message"]');
    expect(streaming?.getAttribute('aria-busy')).toBe('true');
    expect(streaming?.querySelector('h2')).toBeNull();

    const finalMessages = [
      { id: 'stream-user', role: 'user' as const, content: 'Stream this', createdAt: 1 },
      { id: 'stream-final', role: 'agent' as const, content: 'Hello\n\n## world', createdAt: 2 },
    ];
    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'message_update',
        message: finalMessages[1],
      });
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn!.input, finalMessages),
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-streaming-message"]')).toBeNull();
    await waitFor(() => {
      expect(container.querySelector('h2')?.textContent).toBe('world');
    });
    expect(container.textContent?.match(/Hello/g)).toHaveLength(1);
  });

  it('shows active tool progress but keeps recoverable tool failures internal', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Inspect tags');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    if (!turn) throw new Error('expected turn');
    const emit = async (event: Parameters<NonNullable<BgsmAgentTurnHandlers['onEvent']>>[0]) => {
      await act(async () => {
        turn!.handlers.onEvent?.(event);
        await Promise.resolve();
      });
    };

    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_queued',
      toolName: 'list_tags',
      callId: 'call-read',
    });
    const toolActivityRowCount = () => (
      container.querySelector('[data-testid="agent-tool-activity"]')?.children.length ?? 0
    );
    expect(toolActivityRowCount()).toBe(1);
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_start',
      toolName: 'list_tags',
      callId: 'call-read',
      risk: 'read',
    });
    expect(toolActivityRowCount()).toBe(1);
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_end',
      toolName: 'list_tags',
      callId: 'call-read',
      ok: true,
      risk: 'read',
      writeOutcome: 'not_applicable',
    });
    expect(toolActivityRowCount()).toBe(1);
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_queued',
      toolName: 'inspect_tag',
      callId: 'call-failed',
    });
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_end',
      toolName: 'inspect_tag',
      callId: 'call-failed',
      ok: false,
      risk: 'read',
      writeOutcome: 'not_applicable',
    });
    expect(toolActivityRowCount()).toBe(1);
    expect(container.textContent).not.toContain('Failed');
    expect(container.textContent).not.toContain("Cubby couldn't complete this request");
    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeTruthy();
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_queued',
      toolName: 'get_star',
      callId: 'call-exact-repository',
    });
    expect(toolActivityRowCount()).toBe(2);
    expect(container.textContent).not.toContain('Tool result');
    expect(container.textContent).not.toContain('secret arguments');

    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_queued',
      toolName: 'remove_repo_tags',
      callId: 'call-remove-tags',
    });
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_queued',
      toolName: 'delete_tags_everywhere',
      callId: 'call-delete-tags',
    });
    expect(toolActivityRowCount()).toBe(4);
  });

  it('clears the previous turn tool activity when the next turn starts', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Inspect local data');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'tool_execution_start',
        toolName: 'search_stars',
        callId: 'first-turn-read',
        risk: 'read',
      });
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'tool_execution_end',
        toolName: 'search_stars',
        callId: 'first-turn-read',
        ok: true,
        risk: 'read',
        writeOutcome: 'not_applicable',
      });
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, [
          { id: 'first-user', role: 'user', content: turns[0].input.prompt, createdAt: 1 },
          {
            id: 'first-tool-call',
            role: 'agent',
            content: '',
            createdAt: 2,
            toolCalls: [{ id: 'first-turn-read', name: 'search_stars', arguments: {} }],
          },
          {
            id: 'first-tool',
            role: 'tool',
            content: '{"ok":true,"data":{"items":[]}}',
            createdAt: 3,
            toolCallId: 'first-turn-read',
            toolName: 'search_stars',
          },
          { id: 'first-answer', role: 'agent', content: 'Inspection complete.', createdAt: 4 },
        ]),
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-tool-activity"]')).toBeNull();

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Now answer a follow-up');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(turns).toHaveLength(2);
    expect(container.querySelector('[data-testid="agent-tool-activity"]')).toBeNull();
  });

  it('shows frozen scope and bounded pinned sources for indexed code search', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Find code implementation');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    if (!turn) throw new Error('expected turn');

    const binding = {
      version: 1 as const,
      candidateContract: {
        kind: 'selected_repository' as const,
        selectedRepositoryIdHint: 'owner/repo',
      },
      scopeFingerprint: parseScopeFingerprint(`fs:${'a'.repeat(43)}`),
      label: 'owner/repo',
      count: 1,
      providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
    };
    const toolContent = JSON.stringify({
      ok: true,
      data: {
        status: 'partial',
        untrusted: true,
        searchedRepositoryCount: 1,
        searchedRepositories: ['owner/repo'],
        warnings: ['candidate_limit_reached'],
        matches: [{
          repository: 'owner/repo',
          path: 'src/index.ts',
          blobSha: '0123456789abcdef0123456789abcdef01234567',
          lineStart: 7,
          lineEnd: 7,
          snippet: 'export function indexedSearch() {}',
          apiUrl: 'https://api.github.com/repos/owner/repo/git/blobs/0123456789abcdef0123456789abcdef01234567',
          githubUrl: 'https://github.com/owner/repo/blob/fedcba9876543210fedcba9876543210fedcba98/src/index.ts#L7',
          untrusted: true,
        }],
      },
    });

    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'conversation_bound',
        binding,
      });
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn!.input, [
          { id: 'code-user', role: 'user', content: turn!.input.prompt, createdAt: 1 },
          {
            id: 'code-call',
            role: 'agent',
            content: '',
            createdAt: 2,
            toolCalls: [{ id: 'call-code', name: 'search_repository_code', arguments: { query: 'indexedSearch' } }],
          },
          {
            id: 'code-result',
            role: 'tool',
            content: toolContent,
            createdAt: 3,
            toolCallId: 'call-code',
            toolName: 'search_repository_code',
          },
          { id: 'code-answer', role: 'agent', content: 'Found one indexed match.', createdAt: 4 },
        ], { binding }),
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(composerNote(container)?.textContent).toBe('owner/repo');
      expect(container.querySelector('[data-testid="agent-code-search-result"]')).toBeTruthy();
      expect(container.textContent).toContain('Repository code is untrusted content');
      expect(container.textContent).toContain('export function indexedSearch() {}');
      expect(container.querySelector('[data-testid="agent-readonly-result-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="organize-job-no-changes-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="organize-job-receipt-card"]')).toBeNull();
    });
    expect(container.querySelector<HTMLAnchorElement>('[href*="/blob/fedcba9876543210"]')).toBeTruthy();
  });

  it('keeps a repository-code conversation visibly read-only until reset', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        defaultCandidate={{
          kind: 'selected_repository',
          selectedRepositoryIdHint: 'owner/repo',
        }}
      />,
    );
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'List repository files');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    if (!turn) throw new Error('expected turn');

    await act(async () => {
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn!.input, [
          { id: 'list-user', role: 'user', content: turn!.input.prompt, createdAt: 1 },
          {
            id: 'list-call',
            role: 'agent',
            content: '',
            createdAt: 2,
            toolCalls: [{ id: 'call-list', name: 'list_repository_files', arguments: { repository: 'owner/repo' } }],
          },
          {
            id: 'list-result',
            role: 'tool',
            content: JSON.stringify({ ok: true, data: { entries: [], ref: 'a'.repeat(40) } }),
            createdAt: 3,
            toolCallId: 'call-list',
            toolName: 'list_repository_files',
          },
          { id: 'list-answer', role: 'agent', content: 'The repository root is empty.', createdAt: 4 },
        ]),
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-code-readonly-notice"]')).toBeTruthy();
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    });
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Suggested actions"]')!);
    await waitFor(() => {
      expect(document.body.querySelector('[role="group"][aria-label="Choose an action"]')).toBeTruthy();
    });
    expect([...document.body.querySelector('[role="group"][aria-label="Choose an action"]')!.querySelectorAll('button')]).toHaveLength(5);
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();

    await setTextareaValue(
      container.querySelector<HTMLTextAreaElement>('textarea')!,
      'Tag all my starred repositories.',
    );
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();
    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: 'Tag all my starred repositories.' }),
      expect.any(Object),
    );
    if (!turn) throw new Error('expected routed read-only turn');
    await act(async () => {
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn!.input, [
          { id: 'list-user', role: 'user', content: 'List repository files', createdAt: 1 },
          {
            id: 'list-call',
            role: 'agent',
            content: '',
            createdAt: 2,
            toolCalls: [{ id: 'call-list', name: 'list_repository_files', arguments: { repository: 'owner/repo' } }],
          },
          {
            id: 'list-result',
            role: 'tool',
            content: JSON.stringify({ ok: true, data: { entries: [], ref: 'a'.repeat(40) } }),
            createdAt: 3,
            toolCallId: 'call-list',
            toolName: 'list_repository_files',
          },
          { id: 'list-answer', role: 'agent', content: 'The repository root is empty.', createdAt: 4 },
          { id: 'readonly-user', role: 'user', content: turn!.input.prompt, createdAt: 5 },
          {
            id: 'readonly-answer',
            role: 'agent',
            content: 'Start a new conversation before changing tags.',
            createdAt: 6,
          },
        ], { binding: selectedRepositoryBinding() }),
      });
      await Promise.resolve();
    });

    const notice = container.querySelector<HTMLElement>('[data-testid="agent-code-readonly-notice"]')!;
    const reset = [...notice.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Start new conversation'));
    await click(reset!);
    expect(container.querySelector('[data-testid="agent-code-readonly-notice"]')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(container.querySelector<HTMLTextAreaElement>('textarea'));
    });
  });

  it('keeps the real durable conflict draft sendable after winner convergence', async () => {
    const session = durableEmptySession('panel-durable-conflict');
    const rejectedPrompt = '  Keep this prompt exactly.\nSecond line.  ';
    const conflictMessage = 'Another Cubby turn is already active for this conversation.';
    const winner = {
      executionEpochId: 'panel-worker-winner',
      launch: {
        turnAttemptId: 'panel-winner-attempt',
        sessionId: session.session.id,
        baseRevision: session.session.revision,
        prompt: 'Winning prompt',
      },
    } as const;
    const turns: Array<{
      input: BgsmAgentTurnInput;
      handlers: BgsmAgentTurnHandlers;
      options: unknown;
    }> = [];
    messagingMocks.getOrCreate.mockResolvedValue(session);
    messagingMocks.loadSession.mockResolvedValue(session);
    messagingMocks.inspectActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers, options) => {
      turns.push({ input, handlers, options });
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn() },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await waitFor(() => expect(textarea.disabled).toBe(false));

    await setTextareaValue(textarea, rejectedPrompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await waitFor(() => expect(turns).toHaveLength(1));
    await act(async () => {
      await turns[0]!.handlers.onError?.({
        ...deliveryIdentity(turns[0]!.input),
        message: conflictMessage,
        category: 'other',
        code: 'agent_session_turn_active',
      });
    });
    await waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]).toMatchObject({
      input: winner.launch,
      options: {
        expectedExecutionEpochId: winner.executionEpochId,
        resumeOnly: true,
      },
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
      expect(textarea.value).toBe(rejectedPrompt);
    });
    expect(container.textContent).toContain(conflictMessage);
    expect(container.querySelector('[data-testid="agent-durable-retry-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-durable-retry-button"]')).toBeNull();
    expect('retrySourceAttemptId' in turns[1]!.input).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
      .toBe(true);

    await act(async () => {
      await turns[1]!.handlers.onResult?.({
        turnAttemptId: winner.launch.turnAttemptId,
        sessionId: winner.launch.sessionId,
        baseRevision: winner.launch.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(winner.launch, [
          { id: 'winner-user', role: 'user', content: winner.launch.prompt, createdAt: 1 },
          { id: 'winner-agent', role: 'agent', content: 'Winning answer', createdAt: 2 },
        ]),
      });
    });

    await waitFor(() => expect(textarea.value).toBe(rejectedPrompt));
    expect(container.textContent).toContain('Winning answer');
    expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
    expect(container.textContent).toContain(conflictMessage);
    expect(container.querySelector('[data-testid="agent-durable-retry-card"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
      .toBe(false);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await waitFor(() => expect(turns).toHaveLength(3));
    expect(turns[2]!.input).toMatchObject({
      sessionId: session.session.id,
      baseRevision: 1,
      prompt: rejectedPrompt.trim(),
    });
    expect('retrySourceAttemptId' in turns[2]!.input).toBe(false);
    expect(messagingMocks.getOrCreate).toHaveBeenCalledTimes(1);
    expect(messagingMocks.createSession).not.toHaveBeenCalled();
  });

  it('keeps the rejected fresh draft when the subscribed winner fails at the provider', async () => {
    const session = durableEmptySession('panel-durable-conflict-winner-failed');
    const rejectedPrompt = '  Keep B exact after A fails.\nSecond line.  ';
    const winnerPrompt = 'Winning A prompt';
    const conflictMessage = 'Another Cubby turn is already active for this conversation.';
    const winnerFailure = 'Provider returned 503 while finishing the winning turn.';
    const winner = {
      executionEpochId: 'panel-worker-winner-failed',
      launch: {
        turnAttemptId: 'panel-winner-failed-attempt',
        sessionId: session.session.id,
        baseRevision: session.session.revision,
        prompt: winnerPrompt,
      },
    } as const;
    const turns: Array<{
      input: BgsmAgentTurnInput;
      handlers: BgsmAgentTurnHandlers;
      options: unknown;
    }> = [];
    messagingMocks.getOrCreate.mockResolvedValue(session);
    messagingMocks.loadSession.mockResolvedValue(session);
    messagingMocks.inspectActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers, options) => {
      turns.push({ input, handlers, options });
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn() },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await waitFor(() => expect(textarea.disabled).toBe(false));

    await setTextareaValue(textarea, rejectedPrompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await waitFor(() => expect(turns).toHaveLength(1));
    await act(async () => {
      await turns[0]!.handlers.onError?.({
        ...deliveryIdentity(turns[0]!.input),
        message: conflictMessage,
        category: 'other',
        code: 'agent_session_attempt_conflict',
      });
    });
    await waitFor(() => expect(turns).toHaveLength(2));
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
      .toBe(true);

    await act(async () => {
      await turns[1]!.handlers.onError?.({
        ...deliveryIdentity(turns[1]!.input),
        message: winnerFailure,
        category: 'provider',
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe(rejectedPrompt);
      expect(container.textContent).toContain(winnerFailure);
    });
    const conflictCard = container.querySelector<HTMLElement>('[data-testid="agent-provider-error-card"]')!;
    expect(conflictCard.textContent).toContain(conflictMessage);
    expect(conflictCard.textContent).not.toContain(winnerFailure);
    expect(textarea.value).not.toBe(winnerPrompt);
    expect(container.querySelector('[data-testid="agent-durable-retry-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-durable-retry-button"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
      .toBe(false);

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await waitFor(() => expect(turns).toHaveLength(3));
    expect(turns[2]!.input).toMatchObject({
      sessionId: session.session.id,
      baseRevision: session.session.revision,
      prompt: rejectedPrompt.trim(),
    });
    expect('retrySourceAttemptId' in turns[2]!.input).toBe(false);
  });

  it('revokes transient fresh-resend authority when the restored draft is edited', async () => {
    const prompt = '  Preserve this exact conflict draft.  ';
    const clearTransientSafeResend = vi.fn();
    const startTurn = vi.fn();
    function EditedConflictPanel() {
      const [transientPrompt, setTransientPrompt] = useState<string | null>(prompt);
      return (
        <AgentPanel
          open
          onClose={vi.fn()}
          agentOverrides={{
            phase: 'failed',
            running: false,
            error: 'Another Cubby turn is already active for this conversation.',
            draftRecovery: prompt,
            durableRetryDraft: null,
            canRetryLastTurn: false,
            transientSafeResendPrompt: transientPrompt,
            clearTransientSafeResend: () => {
              clearTransientSafeResend();
              setTransientPrompt(null);
            },
            startTurn,
          }}
        />
      );
    }
    const container = await mountAgentPanel(<EditedConflictPanel />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    await waitFor(() => expect(textarea.value).toBe(prompt));
    expect(send.disabled).toBe(false);

    await setTextareaValue(textarea, `${prompt}changed`);
    expect(clearTransientSafeResend).toHaveBeenCalledTimes(1);
    await setTextareaValue(textarea, prompt);
    expect(send.disabled).toBe(true);
    await click(send);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it('restores a failed prompt, removes partial output, and disables blind retry after a write starts', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Apply exact request');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    if (!turn) throw new Error('expected turn');

    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'assistant_text_delta',
        step: 0,
        delta: 'Partial output',
      });
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'tool_execution_start',
        toolName: 'assign_repo_tags',
        callId: 'write-call',
        risk: 'write',
      });
      turn!.handlers.onError?.({
        ...deliveryIdentity(turn!.input),
        message: 'Connection interrupted.',
        category: 'provider',
      });
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Apply exact request');
    expect(container.textContent).not.toContain('Partial output');
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retry).toBeUndefined();
    expect(container.textContent).toContain('A change may already be applied. Review the results before retrying.');
    expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
    expect(container.textContent).toContain('Connection interrupted.');
    expect(container.querySelector('[data-testid="agent-tool-activity"]')).toBeNull();
  });

  it('unlocks a read-only turn after transport failure and offers the original prompt for retry', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const prompt = 'Find exactly three terminal coding agents.';

    await setTextareaValue(textarea, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    if (!turn) throw new Error('expected turn');

    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'assistant_text_delta',
        step: 0,
        delta: 'Searching candidates...',
      });
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'tool_execution_start',
        toolName: 'search_stars',
        callId: 'read-call',
        risk: 'read',
      });
      turn!.handlers.onError?.({
        ...deliveryIdentity(turn!.input),
        message: 'Cubby stopped before finishing. Try again.',
        category: 'other',
      });
      await Promise.resolve();
    });

    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe(prompt);
    expect(container.textContent).not.toContain('Searching candidates...');
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retry?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
      .toBe(false);
  });

  it('reuses one session and sends committed protocol history on the next turn', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const onClose = vi.fn();
    const container = await mountAgentPanel(<AgentPanel open onClose={onClose} />);
    const firstTextarea = container.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(firstTextarea!, 'Inspect my tags');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(turns).toHaveLength(1);
    expect(turns[0].input.history).toEqual([]);
    const sessionId = turns[0].input.sessionId;
    const firstTurnMessages = [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'Inspect my tags',
        createdAt: 1,
      },
      {
        id: 'assistant-call-1',
        role: 'agent' as const,
        content: '',
        createdAt: 2,
        toolCalls: [{ id: 'call-1', name: 'list_tags', arguments: {} }],
      },
      {
        id: 'tool-1',
        role: 'tool' as const,
        content: '{"ok":true,"data":{"tags":[]}}',
        createdAt: 3,
        toolCallId: 'call-1',
        toolName: 'list_tags',
      },
      {
        id: 'assistant-final-1',
        role: 'agent' as const,
        content: 'I inspected your tags.',
        createdAt: 4,
      },
    ];

    await act(async () => {
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, firstTurnMessages),
      });
      await Promise.resolve();
    });

    await act(async () => {
      mountedRoots[0].render(<AgentPanel open={false} onClose={onClose} />);
      await Promise.resolve();
    });
    const closedDrawer = container.querySelector('aside');
    expect(closedDrawer?.getAttribute('data-state')).toBe('closed');
    expect(closedDrawer?.getAttribute('aria-hidden')).toBe('true');
    expect(closedDrawer?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('textarea')).not.toBeNull();
    await act(async () => {
      mountedRoots[0].render(<AgentPanel open onClose={onClose} />);
      await Promise.resolve();
    });

    const reopenedDrawer = container.querySelector('aside');
    expect(reopenedDrawer?.getAttribute('data-state')).toBe('open');
    expect(reopenedDrawer?.getAttribute('aria-hidden')).toBe('false');
    expect(reopenedDrawer?.hasAttribute('inert')).toBe(false);

    const secondTextarea = container.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(secondTextarea!, 'What changed?');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(turns).toHaveLength(2);
    expect(turns[1].input.sessionId).toBe(sessionId);
    expect(turns[1].input.baseRevision).toBe(1);
    expect(turns[1].input.prompt).toBe('What changed?');
    expect(turns[1].input.history).toEqual(firstTurnMessages);
  });

  it('retains a settled failed turn in the next model request', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'First attempt');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'provider_error',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, [
          {
            id: 'failed-user',
            role: 'user',
            content: 'First attempt',
            createdAt: 1,
          },
          {
            id: 'failed-assistant',
            role: 'agent',
            content: 'Partial response',
            createdAt: 2,
          },
        ]),
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Try again');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(turns).toHaveLength(2);
    expect(turns[1].input.sessionId).toBe(turns[0].input.sessionId);
    expect(turns[1].input.history).toEqual([
      {
        id: 'failed-user',
        role: 'user',
        content: 'First attempt',
        createdAt: 1,
      },
      {
        id: 'failed-assistant',
        role: 'agent',
        content: 'Partial response',
        createdAt: 2,
      },
    ]);
  });

  it('surfaces an unrecoverable worker restart instead of leaving the turn running', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    const acknowledge = vi.fn();
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Resume this turn');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      turn?.handlers.onResult?.({
        ...deliveryIdentity(turn.input),
        reason: 'attempt_state_lost',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      await Promise.resolve();
    });

    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'no_transition',
      appliedRevision: null,
    });
    expect(container.textContent).toContain("The extension restarted, so Cubby couldn't recover this request");
    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeNull();
  });

  it('accepts only the background commit projection and ignores legacy transition fields', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    const acknowledge = vi.fn();
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Commit this answer');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      turn?.handlers.onResult?.({
        ...deliveryIdentity(turn.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turn.input, [
          { id: 'rejected-user', role: 'user', content: turn.input.prompt, createdAt: 1 },
          { id: 'rejected-answer', role: 'agent', content: 'Uncommitted answer', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });

    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'applied',
      appliedRevision: 1,
    });
    expect(container.textContent).toContain('Uncommitted answer');
    expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeNull();
  });

  it('ignores stale event, result, and error delivery before changing any UI state', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    const onDataChanged = vi.fn();
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onDataChanged={onDataChanged} />
    );
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'First turn');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, [
          { id: 'first-user', role: 'user', content: 'First turn', createdAt: 1 },
          { id: 'first-agent', role: 'agent', content: 'First answer', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Current turn');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    expect(turns[1].input.baseRevision).toBe(1);
    const before = container.innerHTML;

    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'message_update',
        message: {
          id: 'stale-agent',
          role: 'agent',
          content: 'Stale transcript mutation',
          createdAt: 3,
        },
      });
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'agent_error',
        message: 'Stale event error',
      });
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: true,
        changedCount: 99,
        commit: null,
      });
      turns[0].handlers.onError?.({
        ...deliveryIdentity(turns[0].input),
        message: 'Stale transport error',
      });
      turns[0].handlers.onEvent?.({
        turnAttemptId: turns[1].input.turnAttemptId,
        sessionId: 'wrong-session',
        baseRevision: turns[1].input.baseRevision,
        type: 'agent_error',
        message: 'Wrong session event error',
      });
      turns[0].handlers.onResult?.({
        turnAttemptId: turns[1].input.turnAttemptId,
        sessionId: 'wrong-session',
        baseRevision: turns[1].input.baseRevision,
        reason: 'final_answer',
        changed: true,
        changedCount: 100,
        commit: null,
      });
      turns[0].handlers.onError?.({
        turnAttemptId: turns[1].input.turnAttemptId,
        sessionId: 'wrong-session',
        baseRevision: turns[1].input.baseRevision,
        message: 'Wrong session transport error',
      });
      await Promise.resolve();
    });

    expect(container.innerHTML).toBe(before);
    expect(container.textContent).not.toContain('Stale transcript mutation');
    expect(container.textContent).not.toContain('Stale event error');
    expect(container.textContent).not.toContain('Stale transport error');
    expect(container.textContent).not.toContain('Wrong session event error');
    expect(container.textContent).not.toContain('Wrong session transport error');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    expect(onDataChanged).not.toHaveBeenCalled();
  });

  it('rolls back only the context-limited turn and restores its prompt once', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Keep this committed');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'message_update',
        message: {
          id: 'committed-answer',
          role: 'agent',
          content: 'Committed answer stays visible.',
          createdAt: 1,
        },
      });
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, [
          { id: 'committed-user', role: 'user', content: turns[0].input.prompt, createdAt: 1 },
          { id: 'committed-answer', role: 'agent', content: 'Committed answer stays visible.', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, '  Restore this exact prompt  ');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    expect(turns[1].input.prompt).toBe('Restore this exact prompt');
    await act(async () => {
      turns[1].handlers.onEvent?.({
        ...deliveryIdentity(turns[1].input),
        type: 'message_update',
        message: {
          id: 'transient-tool',
          role: 'tool',
          toolName: 'list_tags',
          content: '{"ok":true}',
          createdAt: 3,
        },
      });
      turns[1].handlers.onEvent?.({
        ...deliveryIdentity(turns[1].input),
        type: 'message_update',
        message: {
          id: 'transient-answer',
          role: 'agent',
          content: 'This partial answer must disappear.',
          createdAt: 4,
        },
      });
      turns[1].handlers.onResult?.({
        ...deliveryIdentity(turns[1].input),
        reason: 'context_limit',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('  Restore this exact prompt  ');
      expect(container.textContent).toContain('Committed answer stays visible.');
      expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
      expect(container.textContent).not.toContain('This partial answer must disappear.');
      expect(container.textContent).not.toContain('{"ok":true}');
    });
    const afterRecovery = container.innerHTML;

    await act(async () => {
      turns[1].handlers.onResult?.({
        ...deliveryIdentity(turns[1].input),
        reason: 'context_limit',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      turns[1].handlers.onEvent?.({
        ...deliveryIdentity(turns[1].input),
        type: 'message_update',
        message: {
          id: 'late-answer',
          role: 'agent',
          content: 'Late mutation',
          createdAt: 5,
        },
      });
      turns[1].handlers.onError?.({
        ...deliveryIdentity(turns[1].input),
        message: 'Late error',
      });
      await Promise.resolve();
    });

    expect(container.innerHTML).toBe(afterRecovery);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('  Restore this exact prompt  ');
  });

  it('commits settled write receipts before showing repeated-overflow recovery', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    const acknowledge = vi.fn();
    const onDataChanged = vi.fn();
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge };
    });

    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onDataChanged={onDataChanged} onOpenOptions={vi.fn()} />,
    );
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Apply the tag safely');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    const input = turn!.input;
    const writeResult = JSON.stringify({
      ok: true,
      data: { full_name: 'owner/repo', tags: ['agent'], changed: true, reason: null },
    });

    await act(async () => {
      turn?.handlers.onEvent?.({
        ...deliveryIdentity(input),
        type: 'tool_execution_start',
        callId: 'write-before-overflow',
        toolName: 'assign_repo_tags',
        risk: 'write',
      });
      turn?.handlers.onEvent?.({
        ...deliveryIdentity(input),
        type: 'tool_execution_end',
        callId: 'write-before-overflow',
        toolName: 'assign_repo_tags',
        risk: 'write',
        ok: true,
        writeOutcome: 'committed',
      });
      turn?.handlers.onResult?.({
        ...deliveryIdentity(input),
        reason: 'context_limit',
        contextFailureReason: 'provider_context_overflow_repeated',
        changed: true,
        changedCount: 1,
        commit: commitForMessages(input, [
          { id: 'settled-user', role: 'user', content: input.prompt, createdAt: 1 },
          {
            id: 'settled-write-envelope',
            role: 'agent',
            content: '',
            createdAt: 2,
            toolCalls: [{
              id: 'write-before-overflow',
              name: 'assign_repo_tags',
              arguments: { full_name: 'owner/repo', tags: ['agent'] },
            }],
          },
          {
            id: 'settled-write-receipt',
            role: 'tool',
            content: writeResult,
            createdAt: 3,
            toolCallId: 'write-before-overflow',
            toolName: 'assign_repo_tags',
          },
        ], {
          reason: 'context_limit',
          changed: true,
          changedCount: 1,
          writeSettlement: 'unsafe',
        }),
      });
      await Promise.resolve();
    });

    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'applied',
      appliedRevision: 1,
    });
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Apply the tag safely');
    expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeTruthy();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Apply the tag safely');
  });

  it('starts a fresh empty session from the explicit header control after a terminal failure', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Conversation to replace');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'message_update',
        message: { id: 'old-answer', role: 'agent', content: 'Old transcript', createdAt: 1 },
      });
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, [
          { id: 'old-user', role: 'user', content: turns[0].input.prompt, createdAt: 1 },
          { id: 'old-answer', role: 'agent', content: 'Old transcript', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Prompt that will be restored');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[1].handlers.onResult?.({
        ...deliveryIdentity(turns[1].input),
        reason: 'context_limit',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      await Promise.resolve();
    });

    const resetAction = container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]');
    expect(resetAction).toBeDefined();
    await click(resetAction!);
    expect(container.textContent).not.toContain('Old transcript');
    expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Fresh request');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    expect(turns).toHaveLength(3);
    expect(turns[2].input.sessionId).not.toBe(turns[1].input.sessionId);
    expect(turns[2].input.baseRevision).toBe(0);
    expect(turns[2].input.history).toEqual([]);
    expect(turns[2].input.checkpoint).toBeUndefined();
  });

  it('keeps separate in-memory conversations available for switching', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const send = async (prompt: string, answer: string) => {
      await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
      const turn = turns.at(-1)!;
      await act(async () => {
        turn.handlers.onResult?.({
          ...deliveryIdentity(turn.input),
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: commitForMessages(turn.input, [
            { id: `${turns.length}-user`, role: 'user', content: prompt, createdAt: turns.length },
            { id: `${turns.length}-answer`, role: 'agent', content: answer, createdAt: turns.length + 1 },
          ]),
        });
        await Promise.resolve();
      });
    };

    await send('First conversation', 'First answer');
    const firstSessionId = turns[0].input.sessionId;
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]')!);
    await send('Second conversation', 'Second answer');
    const secondSessionId = turns[1].input.sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);

    await click(container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')!);
    const firstItem = document.body.querySelector<HTMLElement>(
      `[data-testid="agent-session-item"][data-session-id="${firstSessionId}"]`,
    );
    expect(firstItem?.textContent).toContain('First conversation');
    await click(firstItem!.querySelector<HTMLButtonElement>('button')!);
    expect(container.textContent).toContain('First answer');
    expect(container.textContent).not.toContain('Second answer');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')!);
    const currentItem = document.body.querySelector<HTMLElement>(
      `[data-testid="agent-session-item"][data-session-id="${firstSessionId}"]`,
    );
    await click(currentItem!.querySelector<HTMLButtonElement>('button')!);
    expect(document.body.querySelector('[data-testid="agent-session-list"]')).toBeNull();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();

    await send('Continue first conversation', 'Follow-up answer');
    expect(turns[2].input.sessionId).toBe(firstSessionId);
    expect(turns[2].input.baseRevision).toBe(1);
    expect(turns[2].input.history.map((message) => message.content)).toEqual([
      'First conversation',
      'First answer',
    ]);
  });

  it('requires confirmation before deleting a conversation and preserves the last one', async () => {
    const onClose = vi.fn();
    let firstTurn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | null = null;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      firstTurn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={onClose} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Conversation to keep');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      if (!firstTurn) throw new Error('Expected an agent turn.');
      firstTurn.handlers.onResult?.({
        ...deliveryIdentity(firstTurn.input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(firstTurn.input, [
          { id: 'delete-user', role: 'user', content: 'Conversation to keep', createdAt: 1 },
          { id: 'delete-answer', role: 'agent', content: 'Saved answer', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')!);

    const items = [...document.body.querySelectorAll<HTMLElement>('[data-testid="agent-session-item"]')];
    expect(items).toHaveLength(2);
    const firstDelete = items[0].querySelector<HTMLButtonElement>('[data-testid="agent-session-delete"]')!;
    await click(firstDelete);
    const confirmation = document.body.querySelector<HTMLElement>('[data-testid="agent-session-delete-confirm"]');
    expect(confirmation).not.toBeNull();
    expect(document.body.querySelectorAll('[data-testid="agent-session-item"]')).toHaveLength(2);
    const cancelDelete = [...confirmation!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Cancel'))!;
    expect(document.activeElement).toBe(cancelDelete);

    await click(cancelDelete);
    expect(document.body.querySelector('[data-testid="agent-session-delete-confirm"]')).toBeNull();
    expect(document.activeElement).toBe(firstDelete);

    await click(firstDelete);
    const focusedCancel = document.activeElement as HTMLButtonElement;
    expect(focusedCancel.textContent).toContain('Cancel');
    await act(async () => {
      focusedCancel.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(document.body.querySelector('[data-testid="agent-session-delete-confirm"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="agent-session-list"]')).not.toBeNull();
    expect(document.activeElement).toBe(firstDelete);
    expect(onClose).not.toHaveBeenCalled();

    await click(firstDelete);
    await click([...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="agent-session-delete-confirm"] button')]
      .find((button) => button.textContent?.includes('Delete'))!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')!);
    expect(document.body.querySelectorAll('[data-testid="agent-session-item"]')).toHaveLength(1);

    const remainingDelete = document.body.querySelector<HTMLButtonElement>('[data-testid="agent-session-delete"]');
    expect(remainingDelete?.disabled).toBe(true);
  });

  it('focuses and positions the conversation popover, then closes it on Escape', async () => {
    const onClose = vi.fn();
    const container = await mountAgentPanel(<AgentPanel open onClose={onClose} />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')!;
    await click(toggle);
    const menu = document.body.querySelector<HTMLElement>('[data-testid="agent-session-list"]')!;
    expect(menu.parentElement?.hasAttribute('data-radix-popper-content-wrapper')).toBe(true);
    expect(menu.dataset.align).toBe('end');
    expect(menu.dataset.side).toBe('bottom');
    expect(document.activeElement).toBe(
      menu.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]'),
    );

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="agent-session-list"]')).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses the conversation popover on an outside pointer interaction', async () => {
    const onClose = vi.fn();
    const container = await mountAgentPanel(<AgentPanel open onClose={onClose} />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')!;
    await click(toggle);
    expect(document.body.querySelector('[data-testid="agent-session-list"]')).not.toBeNull();

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      }));
      outside.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="agent-session-list"]')).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps terminal chat and conversation controls available before Dismiss', async () => {
    const onClearTerminal = vi.fn();
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        workbenchState={completedWorkbenchState()}
        onClearTerminal={onClearTerminal}
        agentOverrides={{
          activeSessionId: 'session-lock-test',
          sessionId: 'session-lock-test',
          sessionReady: true,
          sessionOperationPending: false,
        }}
      />,
    );

    const newConversation = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start new conversation"]',
    );
    const sessionToggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]');
    expect(newConversation?.disabled).toBe(false);
    expect(sessionToggle?.disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);

    const dismiss = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Dismiss');
    expect(dismiss?.disabled).toBe(false);
    await click(dismiss!);
    expect(onClearTerminal).toHaveBeenCalledOnce();
  });

  it('renders Dismiss for a cancelled terminal result without an Apply row', async () => {
    const onClearTerminal = vi.fn();
    const state = durableWorkbenchState('cancelled', { role: null });
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        workbenchState={state}
        onClearTerminal={onClearTerminal}
        agentOverrides={{
          activeSessionId: 'session-lock-test',
          sessionId: 'session-lock-test',
          sessionReady: true,
          sessionOperationPending: false,
        }}
      />,
    );

    expect(container.querySelector('[data-testid="organize-job-stop-card"]')).not.toBeNull();
    const dismiss = buttonWithText(container, 'Discard');
    expect(dismiss.disabled).toBe(false);
    await click(dismiss);
    expect(onClearTerminal).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')?.disabled)
      .toBe(false);
  });

  it('shows observer state as read-only while leaving chat and sessions available', async () => {
    const state = durableWorkbenchState('review', { role: 'observer' });
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        workbenchState={state}
        agentOverrides={{
          activeSessionId: 'session-lock-test',
          sessionId: 'session-lock-test',
          sessionReady: true,
          sessionOperationPending: false,
        }}
      />,
    );

    expect(container.querySelector('[data-testid="organize-job-control-notice"]')?.textContent)
      .toContain('controlled from another Cubby page');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Take control')))
      .toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')?.disabled)
      .toBe(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]')?.disabled)
      .toBe(false);
  });

  it('keeps observer review pagination readable while selection and Apply stay disabled', async () => {
    const base = durableWorkbenchState('review', { role: 'observer' });
    const proposalId = base.organizeJob!.proposalId;
    const proposalRowId = `${proposalId}:row:0`;
    const proposedActions = [{
      kind: 'add_existing_tag' as const,
      tag: 'TypeScript',
      evidence: 'Repository topic',
    }];
    const state: AgentWorkbenchState = {
      ...base,
      proposal: {
        proposalId,
        actionableCount: 2,
        nonActionableCount: 0,
        review: {
          version: 1,
          proposalId,
          runId: base.organizeJob!.runId,
          generation: base.organizeJob!.generation,
          rows: [{
            proposalRowId,
            frozenIndex: 0,
            repositoryId: 'owner/repo-0',
            proposedActions,
            preselected: true,
          }],
        },
      },
      selectedProposalRowIds: new Set([proposalRowId]),
      organizeReviewPage: {
        type: 'bgsmOrganizeReviewPage',
        controllerId: base.organizeJob!.controllerId,
        sessionId: base.organizeJob!.sessionId,
        runId: base.organizeJob!.runId,
        generation: base.organizeJob!.generation,
        requestId: 'review-page:observer',
        jobId: base.organizeJob!.jobId,
        revision: base.organizeJob!.revision,
        proposalId,
        totalRows: 2,
        selectedRepositories: 1,
        selectedActions: 1,
        rowOffset: 0,
        rows: [{
          position: 0,
          proposalRowId,
          repositoryId: 'owner/repo-0',
          proposedActions,
          selected: true,
        }],
        nextRowOffset: 1,
      },
    };
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={state} />,
    );

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')?.disabled)
      .toBe(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Select owner/repo-0"]')?.disabled)
      .toBe(true);
    expect(buttonWithText(container, 'Apply 1 tag to 1 repository').disabled).toBe(true);
  });

  it('offers exactly one Take control action for owner-lost state', async () => {
    const onTakeControl = vi.fn();
    const state = durableWorkbenchState('review', { role: 'owner_lost' });
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        workbenchState={state}
        onTakeControl={onTakeControl}
        agentOverrides={{
          activeSessionId: 'session-lock-test',
          sessionId: 'session-lock-test',
          sessionReady: true,
          sessionOperationPending: false,
        }}
      />,
    );

    const takeControl = buttonWithText(container, 'Take control');
    expect(takeControl.disabled).toBe(false);
    expect(container.querySelectorAll('[data-testid="organize-job-control-notice"]')).toHaveLength(1);
    await click(takeControl);
    expect(onTakeControl).toHaveBeenCalledOnce();
  });

  it('announces takeover success and moves focus into the surviving workbench', async () => {
    const container = await mountAgentPanel(<TakeoverFocusHarness />);
    const takeControl = buttonWithText(container, 'Take control');
    takeControl.focus();
    await click(takeControl);

    const workbench = container.querySelector<HTMLElement>('[data-testid="organize-job-workbench"]');
    expect(document.activeElement).toBe(workbench);
    expect(container.textContent).toContain('You now control this run.');
    expect(container.querySelector('[data-testid="organize-job-control-notice"]')).toBeNull();
  });

  it('keeps Take control busy and renders typed failures inline', async () => {
    const base = durableWorkbenchState('review', { role: 'owner_lost' });
    const pending: AgentWorkbenchState = {
      ...base,
      pendingCommand: {
        id: 'take-control:pending',
        kind: 'take_control',
        runId: base.organizeJob!.runId,
        generation: base.organizeJob!.generation,
        jobId: base.organizeJob!.jobId,
        baselineRevision: base.organizeJob!.revision,
      },
    };
    const pendingContainer = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={pending} />,
    );
    const busy = buttonWithText(pendingContainer, 'Taking control…');
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');

    const failed: AgentWorkbenchState = {
      ...base,
      takeControlFailure: 'revision_conflict',
    };
    const failedContainer = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={failed} />,
    );
    expect(failedContainer.querySelector('[data-testid="organize-job-take-control-error"]')?.textContent)
      .toContain('changed while taking control');
  });

  it('preserves unsent input across role, conflict, deletion, and terminal projections', async () => {
    const container = await mountAgentPanel(<ProjectionTransitionHarness />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await setTextareaValue(textarea, 'Keep this unsent draft');

    for (const testId of [
      'projection-observer',
      'projection-owner-lost',
      'projection-conflict',
      'projection-session-deleted',
      'projection-terminal',
    ]) {
      await click(container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!);
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep this unsent draft');
    }
  });

  it('marks terminal provenance when the origin conversation was deleted', async () => {
    const state = completedWorkbenchState();
    const deleted: AgentWorkbenchState = {
      ...state,
      deletedSessionIds: new Set([state.organizeJob!.originAgentSessionId]),
    };
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={deleted} />,
    );
    expect(container.textContent).toContain('Started from a conversation that has been deleted.');
  });

  it('offers a working Pause action while tag changes are applying', async () => {
    const onStop = vi.fn();
    const state = durableWorkbenchState('applying', {
      apply: {
        applyId: 'apply:v1:pause-test',
        total: 3,
        settled: 1,
        changed: 1,
        unchanged: 0,
        skipped: 0,
        failed: 0,
      },
    });
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={state} onStop={onStop} />,
    );

    const pause = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Pause');
    expect(pause).toBeDefined();
    expect(pause?.disabled).toBe(false);
    await click(pause!);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('presents a temporary transport loss only as reconnecting', async () => {
    const state: AgentWorkbenchState = {
      ...createAgentWorkbenchState('controller:v1:reconnecting-test', 'session-reconnecting-test'),
      role: 'owner',
      snapshot: workbenchSnapshot('analyzing'),
      transport: 'disconnected',
      conversationAnchor: { messageId: null, createdAt: 1 },
    };
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={state} />,
    );

    expect(container.querySelector('[data-testid="agent-header-status"]')?.textContent)
      .toBe('Cubby connection was interrupted. Reconnecting…');
    expect(container.querySelector('[data-testid="organize-job-current-phase"]')).toBeNull();
    expect(container.querySelector('[data-testid="organize-job-error-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-mascot"]')?.getAttribute('data-state')).toBe('queued');
  });

  it('gives an interrupted workbench both restart and discard exits', async () => {
    const onClearTerminal = vi.fn();
    const state: AgentWorkbenchState = {
      ...createAgentWorkbenchState('controller:v1:interrupted-test', 'session-interrupted-test'),
      role: 'owner',
      snapshot: workbenchSnapshot('interrupted'),
      error: WORKER_LOST_COPY,
      conversationAnchor: { messageId: null, createdAt: 1 },
    };
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        workbenchState={state}
        onClearTerminal={onClearTerminal}
      />,
    );

    expect(container.textContent).toContain('Restart full-library analysis');
    const discard = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Discard this analysis');
    expect(discard).toBeDefined();
    await click(discard!);
    expect(onClearTerminal).toHaveBeenCalledOnce();
  });

  it('shows review loading instead of an empty stepper while the first page is pending', async () => {
    const state = durableWorkbenchState('review', {
      organizeReviewRequestId: 'review-page:pending',
    });
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={state} />,
    );

    expect(container.querySelector('[data-testid="organize-job-review-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="organize-job-proposal-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
  });

  it('blocks an invalid durable review with restart and discard actions', async () => {
    const base = durableWorkbenchState('review');
    const state: AgentWorkbenchState = {
      ...base,
      organizeJob: {
        ...base.organizeJob!,
        coverage: {
          ...base.organizeJob!.coverage,
          analyzed: 0,
          analysisFailed: 1,
        },
      },
    };
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={state} />,
    );

    expect(container.textContent).toContain('Analysis paused before completion');
    expect(container.textContent).toContain('Restart full-library analysis');
    expect(container.textContent).toContain('Discard this analysis');
    expect(container.querySelector('[data-testid="organize-job-proposal-card"]')).toBeNull();
  });

  it('stops a pending turn before resetting and ignores all delayed callbacks', async () => {
    const turns: Array<{
      input: BgsmAgentTurnInput;
      handlers: BgsmAgentTurnHandlers;
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      const stop = vi.fn();
      turns.push({ input, handlers, stop });
      return { stop, acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Pending request');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'message_update',
        message: { id: 'pending-answer', role: 'agent', content: 'Pending transcript', createdAt: 1 },
      });
      await Promise.resolve();
    });

    const stopButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Stop');
    expect(stopButton).toBeDefined();
    await click(stopButton!);
    expect(turns[0].stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Pending request');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    expect(container.textContent).not.toContain('Pending transcript');

    await act(async () => {
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'aborted',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      await Promise.resolve();
    });

    const recoveredCard = container.querySelector('[data-testid="agent-durable-retry-card"]');
    expect(recoveredCard?.textContent).toContain('Pending request');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="agent-durable-retry-button"]')?.disabled)
      .toBe(false);

    const resetButton = container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]');
    expect(resetButton).not.toBeNull();
    await click(resetButton!);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    expect(container.textContent).not.toContain('Pending request');
    expect(container.textContent).not.toContain('Pending transcript');
    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeNull();
    const afterReset = container.innerHTML;

    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'message_update',
        message: { id: 'delayed-answer', role: 'agent', content: 'Delayed mutation', createdAt: 2 },
      });
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: true,
        changedCount: 1,
        commit: null,
      });
      turns[0].handlers.onError?.({
        ...deliveryIdentity(turns[0].input),
        message: 'Delayed error',
      });
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe(afterReset);

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'After reset');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    expect(turns).toHaveLength(2);
    expect(turns[1].input.sessionId).not.toBe(turns[0].input.sessionId);
    expect(turns[1].input.baseRevision).toBe(0);
    expect(turns[1].input.history).toEqual([]);
  });

  it('does not refill the composer when a durable retry is claimed by a new attempt', async () => {
    const prompt = 'Retry this durable read-only request';
    const retryableDraft: AgentRetryDraft = {
      sessionId: 'session-durable-retry-claim',
      turnAttemptId: 'attempt-stopped-original',
      baseRevision: 2,
      prompt,
      kind: 'stopped',
      settlement: 'retryable',
      updatedAt: 1,
    };
    let resolveRetry!: (result: BgsmAgentTurnResult | null) => void;
    const retryPromise = new Promise<BgsmAgentTurnResult | null>((resolve) => {
      resolveRetry = resolve;
    });
    const startTurn = vi.fn(() => retryPromise);
    const onClose = vi.fn();
    const renderPanel = (
      overrides: Partial<ReturnType<typeof useBgsmAgent>>,
    ) => (
      <AgentPanel
        open
        onClose={onClose}
        agentOverrides={{
          error: null,
          contextLimitRecovery: null,
          draftRecovery: null,
          lastTurnResult: null,
          startTurn,
          ...overrides,
        }}
      />
    );
    const container = await mountAgentPanel(renderPanel({
      phase: 'stopped',
      running: false,
      durableRetryDraft: retryableDraft,
      canRetryLastTurn: true,
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;

    expect(textarea.value).toBe(prompt);
    await click(container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-durable-retry-button"]',
    )!);
    expect(startTurn).toHaveBeenCalledWith(prompt, {
      retrySourceAttemptId: retryableDraft.turnAttemptId,
    });
    expect(textarea.value).toBe('');

    const claimedDraft: AgentRetryDraft = {
      ...retryableDraft,
      turnAttemptId: 'attempt-retry-claimed',
      settlement: 'stop_pending',
      updatedAt: 2,
    };
    const root = mountedRoots.at(-1)!;
    await act(async () => {
      root.render(renderPanel({
        phase: 'working',
        running: true,
        durableRetryDraft: claimedDraft,
        canRetryLastTurn: false,
      }));
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(container.querySelector('[data-testid="agent-durable-retry-button"]')).toBeNull();

    const retryInput: BgsmAgentTurnInput = {
      sessionId: claimedDraft.sessionId,
      turnAttemptId: claimedDraft.turnAttemptId,
      baseRevision: claimedDraft.baseRevision,
      prompt,
      history: [],
    };
    const successfulResult: BgsmAgentTurnResult = {
      ...deliveryIdentity(retryInput),
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      commit: commitForMessages(retryInput, [
        { id: 'claimed-retry-user', role: 'user', content: prompt, createdAt: 1 },
        { id: 'claimed-retry-agent', role: 'agent', content: 'Retry completed.', createdAt: 2 },
      ]),
    };
    await act(async () => {
      resolveRetry(successfulResult);
      await retryPromise;
      root.render(renderPanel({
        phase: 'done',
        running: false,
        durableRetryDraft: null,
        canRetryLastTurn: false,
        lastTurnResult: successfulResult,
      }));
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  });

  it('detaches a stopped turn after a bounded wait without authorizing an unproven exact retry', async () => {
    vi.useFakeTimers();
    try {
      const turns: Array<{
        input: BgsmAgentTurnInput;
        handlers: BgsmAgentTurnHandlers;
        stop: ReturnType<typeof vi.fn>;
        detach: ReturnType<typeof vi.fn>;
      }> = [];
      messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
        const stop = vi.fn();
        const detach = vi.fn();
        turns.push({ input, handlers, stop, detach });
        return { stop, detach, acknowledge: vi.fn() };
      });

      const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
      await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Stop without terminal');
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
      const stopButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Stop');
      await click(stopButton!);

      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(3_000);
        await Promise.resolve();
      });

      expect(turns[0].stop).toHaveBeenCalledOnce();
      expect(turns[0].detach).toHaveBeenCalledOnce();
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]')?.disabled)
        .toBe(false);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="agent-durable-retry-button"]'))
        .toBeNull();
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
        .toBe(true);
      await setTextareaValue(
        container.querySelector<HTMLTextAreaElement>('textarea')!,
        'Stop without terminal, reviewed',
      );
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
        .toBe(false);
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
      expect(turns).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['failed', true],
    ['committed', false],
    ['unknown', false],
  ] as const)('allows an exact retry only when every started write is %s', async (writeOutcome, safeToRetry) => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const prompt = `Write outcome ${writeOutcome}`;
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'tool_execution_start',
        toolName: 'assign_repo_tags',
        callId: `write-${writeOutcome}`,
        risk: 'write',
      });
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'tool_execution_end',
        toolName: 'assign_repo_tags',
        callId: `write-${writeOutcome}`,
        risk: 'write',
        ok: writeOutcome !== 'failed',
        writeOutcome,
      });
      turns[0].handlers.onError?.({
        ...deliveryIdentity(turns[0].input),
        message: 'Provider failed after the write boundary.',
        category: 'provider',
      });
      await Promise.resolve();
    });

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry');
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    if (safeToRetry) {
      expect(retry?.disabled).toBe(false);
    } else {
      expect(retry).toBeUndefined();
    }
    expect(send.disabled).toBe(!safeToRetry);

    if (safeToRetry) {
      await click(retry!);
      expect(turns).toHaveLength(2);
    } else {
      expect(container.textContent).toContain('A change may already be applied');
      await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, `${prompt} - verify first`);
      expect(send.disabled).toBe(false);
    }
  });

  it('waits for the stop result and refreshes data when a raced write reports changed', async () => {
    let turn: {
      input: BgsmAgentTurnInput;
      handlers: BgsmAgentTurnHandlers;
      stop: ReturnType<typeof vi.fn>;
    } | undefined;
    const onDataChanged = vi.fn();
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      const stop = vi.fn();
      turn = { input, handlers, stop };
      return { stop, acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onDataChanged={onDataChanged} />,
    );
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Apply tags');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    if (!turn) throw new Error('expected turn');
    await act(async () => {
      turn!.handlers.onEvent?.({
        ...deliveryIdentity(turn!.input),
        type: 'tool_execution_start',
        toolName: 'assign_repo_tags',
        callId: 'write-race',
        risk: 'write',
      });
      await Promise.resolve();
    });
    const stop = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Stop');
    await click(stop!);
    expect(turn.stop).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);

    await act(async () => {
      turn!.handlers.onResult?.({
        ...deliveryIdentity(turn!.input),
        reason: 'aborted',
        changed: true,
        changedCount: 1,
        commit: null,
      });
      await Promise.resolve();
    });
    expect(onDataChanged).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Apply tags');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retry).toBeUndefined();
  });

  it('keeps normal checkpoint and final-answer flow visually invisible', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'First request');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    const firstMessages = [
      { id: 'checkpoint-user', role: 'user' as const, content: 'First request', createdAt: 1 },
      { id: 'checkpoint-answer', role: 'agent' as const, content: 'First visible answer', createdAt: 2 },
    ];
    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'message_update',
        message: firstMessages[1],
      });
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, firstMessages),
      });
      await Promise.resolve();
    });

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Second request');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[1].handlers.onEvent?.({
        ...deliveryIdentity(turns[1].input),
        type: 'message_update',
        message: { id: 'second-answer', role: 'agent', content: 'Second visible answer', createdAt: 4 },
      });
      turns[1].handlers.onResult?.({
        ...deliveryIdentity(turns[1].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[1].input, [
          ...firstMessages,
          { id: 'second-user', role: 'user', content: 'Second request', createdAt: 3 },
          { id: 'second-answer', role: 'agent', content: 'Second visible answer', createdAt: 4 },
        ], {
          candidateCheckpoint: {
            schemaVersion: 1,
            summary: 'Earlier conversation summary',
            summarizedMessageCount: 2,
            summarizedThroughMessageId: 'checkpoint-answer',
          },
        }),
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('First visible answer');
    expect(container.textContent).toContain('Second visible answer');
    expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
    expect(container.textContent).not.toContain('Earlier conversation summary');
    expect(container.querySelectorAll('button[aria-label="Start new conversation"]')).toHaveLength(1);
  });

  it('creates a fresh session after the Agent panel is remounted', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const firstContainer = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(firstContainer.querySelector<HTMLTextAreaElement>('textarea')!, 'First mount');
    await click(firstContainer.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turns[0].input, [
          {
            id: 'first-user',
            role: 'user',
            content: 'First mount',
            createdAt: 1,
          },
          {
            id: 'first-assistant',
            role: 'agent',
            content: 'Committed reply',
            createdAt: 2,
          },
        ]),
      });
      await Promise.resolve();
    });
    const firstRoot = mountedRoots.shift();
    await act(async () => {
      firstRoot?.unmount();
      await Promise.resolve();
    });

    const secondContainer = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(secondContainer.querySelector<HTMLTextAreaElement>('textarea')!, 'Second mount');
    await click(secondContainer.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(turns).toHaveLength(2);
    expect(turns[1].input.sessionId).not.toBe(turns[0].input.sessionId);
    expect(turns[1].input.history).toEqual([]);
    expect(secondContainer.textContent).not.toContain('Committed reply');
  });

  it('detaches an in-flight turn when the Agent panel unmounts', async () => {
    const stop = vi.fn();
    const detach = vi.fn();
    messagingMocks.startBgsmAgentTurn.mockReturnValue({
      stop,
      detach,
      acknowledge: vi.fn(),
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Still running');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    const root = mountedRoots.shift();

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });

    expect(detach).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it('renders assistant replies as markdown while keeping user prompts plain', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(textarea!, '# keep this plain');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      handlers?.onEvent?.({
        type: 'message_update',
        ...deliveryIdentity(turnInput!),
        message: {
          id: 'm-agent-markdown',
          role: 'agent',
          content: '## Suggested tags\n\n- Add `react` to vercel/ai\n- Skip unclear repos',
          createdAt: 1,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('h1')).toBeNull();
      expect(container.querySelector('h2')?.textContent).toBe('Suggested tags');
      expect(container.querySelector('li code')?.textContent).toBe('react');
      expect(container.textContent).toContain('# keep this plain');
    });
  });

  it('does not rerender or force-scroll the conversation while the user types', async () => {
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    scrollIntoViewMock.mockClear();
    const renderCount = conversationRenderMock.mock.calls.length;

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Drafting a question');

    expect(conversationRenderMock).toHaveBeenCalledTimes(renderCount);
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('scrolls the conversation to the newest agent message', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    scrollIntoViewMock.mockClear();

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(textarea!, 'Please suggest tags');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      handlers?.onEvent?.({
        type: 'message_update',
        ...deliveryIdentity(turnInput!),
        message: {
          id: 'm-agent-scroll',
          role: 'agent',
          content: 'Done.',
          createdAt: 1,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'end' });
    });
  });

  it('shows stream errors as chat messages', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(textarea!, 'Please tag everything');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      handlers?.onError?.({
        ...deliveryIdentity(turnInput!),
        message: 'Model provider timed out while streaming.',
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Model provider timed out while streaming.');
      expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
      expect(container.textContent).toContain('Retry');
    });
  });



  it('renders Auto Tags handoff card and inserts its suggestion into the composer', async () => {
    const onDismissHandoff = vi.fn();
    const container = await mountAgentPanel(
      <AgentPanel
        open
        onClose={vi.fn()}
        handoff={{ remainingUntagged: 12, autoTagged: 40 }}
        onDismissHandoff={onDismissHandoff}
        defaultCandidate={{ kind: 'still_untagged_after_auto_tags' }}
        scopeCount={12}
      />
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-auto-tags-handoff-card"]')).toBeTruthy();
    });
    const handoffActions = container.querySelector<HTMLElement>('[data-testid="agent-handoff-quick-chips"]')!;
    expect(handoffActions).toBeTruthy();
    const handoffChips = [...handoffActions.querySelectorAll('button')];
    expect(handoffChips.length).toBeGreaterThan(0);
    await click(handoffChips[0]!);
    expect(onDismissHandoff).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value.length).toBeGreaterThan(0);
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('keeps disclosure copy and synthetic capability warnings out of cleanup answers', async () => {
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} onOpenOptions={vi.fn()} />);
    expect(container.querySelector('[data-testid="agent-privacy-disclosure"]')).toBeNull();
    expect(container.textContent).not.toContain('What this chat can send');
    expect(container.textContent).not.toContain('private notes');

    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Clean up duplicate tags like js / javascript and remove empty tags.');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'message_update',
        message: {
          id: 'cleanup-answer',
          role: 'agent',
          content: 'I inspected local tag usage and found no cleanup needed.',
          createdAt: 1,
        },
      });
      handlers?.onResult?.({
        ...deliveryIdentity(turnInput!),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turnInput!, [
          { id: 'cleanup-user', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          {
            id: 'cleanup-answer',
            role: 'agent',
            content: 'I inspected local tag usage and found no cleanup needed.',
            createdAt: 2,
          },
        ]),
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.textContent).toContain('I inspected local tag usage and found no cleanup needed.');
      expect(container.querySelector('[data-testid="agent-destructive-confirm-card"]')).toBeNull();
      expect(container.textContent).not.toContain('Not available in first-safe release');
    });
  });
  it('keeps a short context compaction silent and out of the transcript', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Continue organizing tags');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'assistant_text_delta',
        step: 0,
        delta: 'PARTIAL_OVERFLOW_CANARY',
      });
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await waitFor(() => {
      expect(container.textContent).toContain('PARTIAL_OVERFLOW_CANARY');
    });
    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'context_compaction_start',
      });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
    expect(container.textContent).not.toContain('PARTIAL_OVERFLOW_CANARY');
    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'context_compaction_end',
        ok: true,
        summarizedMessageCount: 12,
      });
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'agent_start',
      });
      handlers?.onResult?.({
        ...deliveryIdentity(turnInput!),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turnInput!, [
          { id: 'u1', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          { id: 'a1', role: 'agent', content: 'Done reviewing the compacted history.', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-compaction-note"]')).toBeNull();
      expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
      expect(container.textContent).toContain('Done reviewing the compacted history.');
    });
  });

  it('does not flash a failed bubble while recovering through compaction', async () => {
    vi.useFakeTimers();
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Continue organizing tags');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'tool_execution_start',
        toolName: 'list_stars',
        callId: 'overflowing-read',
        risk: 'read',
      });
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'tool_execution_end',
        toolName: 'list_stars',
        callId: 'overflowing-read',
        ok: false,
        risk: 'read',
        writeOutcome: 'not_applicable',
      });
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Failed');
    expect(container.textContent).not.toContain("Cubby couldn't complete this request");
    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeTruthy();

    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'context_compaction_start',
      });
      vi.advanceTimersByTime(299);
    });
    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
    expect(container.textContent).not.toContain('Failed');
    expect(container.textContent).not.toContain("Cubby couldn't complete this request");

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeTruthy();
    expect(container.textContent).not.toContain('Failed');
    expect(container.textContent).not.toContain("Cubby couldn't complete this request");

    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'context_compaction_end',
        ok: true,
        summarizedMessageCount: 12,
      });
      handlers?.onResult?.({
        ...deliveryIdentity(turnInput!),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turnInput!, [
          { id: 'u-after-compaction', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          { id: 'a-after-compaction', role: 'agent', content: 'Organization continued successfully.', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Organization continued successfully.');
    expect(container.textContent).not.toContain('Failed');
    expect(container.textContent).not.toContain("Cubby couldn't complete this request");
  });

  it('shows only a delayed compaction status and restores the previous tool status', async () => {
    vi.useFakeTimers();
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Continue organizing tags');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'tool_execution_start',
        toolName: 'search_stars',
        callId: 'tool-1',
        risk: 'read',
      });
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'context_compaction_start',
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-mascot"]')?.getAttribute('data-state')).toBe('tool');
    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-mascot"]')?.getAttribute('data-state')).toBe('compacting');

    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'context_compaction_end',
        ok: true,
        summarizedMessageCount: 12,
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-header-status"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-mascot"]')?.getAttribute('data-state')).toBe('tool');

    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'context_compaction_start',
      });
      vi.advanceTimersByTime(299);
    });
    const stop = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Stop');
    await click(stop!);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-header-status"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-mascot"]')?.getAttribute('data-state')).toBe('stopped');
  });

  it('shows a single streaming status line without reasoning theater', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Find similar tools');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeTruthy();
    expect(container.textContent).not.toContain('I will call the model provider');

    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'tool_execution_start',
        toolName: 'search_stars',
        callId: 'call-1',
        risk: 'read',
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-tool-activity"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeNull();
  });

  it('keeps a completed discovery answer free of redundant machine status UI', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Compare note apps');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      handlers?.onEvent?.({
        ...deliveryIdentity(turnInput!),
        type: 'message_update',
        message: {
          id: 'answer-1',
          role: 'agent',
          content: 'Obsidian and Logseq stand out.',
          createdAt: 1,
        },
      });
      handlers?.onResult?.({
        ...deliveryIdentity(turnInput!),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: commitForMessages(turnInput!, [
          { id: 'user-1', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          { id: 'answer-1', role: 'agent', content: 'Obsidian and Logseq stand out.', createdAt: 2 },
        ]),
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Obsidian and Logseq stand out.');
      expect(container.querySelector('[data-testid="agent-header-status"]')).toBeNull();
      expect(container.querySelector('[data-testid="agent-readonly-result-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="organize-job-no-changes-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="organize-job-receipt-card"]')).toBeNull();
    });
  });

  it('does not render an organize stepper for stale timeline-only state', async () => {
    const base = createAgentWorkbenchState('controller:v1:timeline-only', 'session-timeline-only');
    const workbenchState: AgentWorkbenchState = {
      ...base,
      timeline: [{ id: 'old-preflight', state: 'preflight', label: 'Scope requested' }],
    };
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} workbenchState={workbenchState} />,
    );

    expect(container.querySelector('[data-testid="organize-job-workbench"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-run-stepper"]')).toBeNull();
  });


  it('classifies credential failures as provider auth with Options + retry', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, nextHandlers: BgsmAgentTurnHandlers) => {
      turnInput = input;
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const onOpenOptions = vi.fn();
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} onOpenOptions={onOpenOptions} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Compare these two repos');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      handlers?.onError?.({
        ...deliveryIdentity(turnInput!),
        message: 'API key rejected or missing host permission for the configured provider.',
        category: 'authentication',
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.textContent).toContain('AI service authorization failed');
      expect(container.textContent).toContain('Open options');
      expect(container.textContent).toContain('Retry after updating settings');
    });
    const openOptions = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open options'));
    expect(openOptions).toBeTruthy();
    await click(openOptions as HTMLButtonElement);
    expect(onOpenOptions).toHaveBeenCalled();
  });

  it.each([
    ['capability_unresolved', 'settings', 'AI service settings need attention', 'Adjust AI service settings'],
    ['provider_context_overflow_repeated', 'settings', 'AI service settings need attention', 'Adjust AI service settings'],
    ['provider_request_byte_limit_repeated', 'settings', 'AI service settings need attention', 'Adjust AI service settings'],
    ['current_turn_too_large', 'edit', 'This request is too large', 'Edit prompt'],
    ['tool_result_memory_limit', 'retry', "Cubby reached this request's data limit", 'Retry'],
  ] as const)(
    'maps irreducible %s to a focused recovery action without exposing internal identifiers',
    async (reason, action, title, actionLabel) => {
      const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
      messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
        turns.push({ input, handlers });
        return { stop: vi.fn(), acknowledge: vi.fn() };
      });
      const onOpenOptions = vi.fn();
      const container = await mountAgentPanel(
        <AgentPanel open onClose={vi.fn()} onOpenOptions={onOpenOptions} />,
      );
      const prompt = `Recover this draft for ${action}`;
      await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
      const failedSessionId = turns[0].input.sessionId;
      await act(async () => {
        turns[0].handlers.onResult?.({
          ...deliveryIdentity(turns[0].input),
          reason: 'context_limit',
          contextFailureReason: reason,
          changed: false,
          changedCount: 0,
          commit: null,
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(container.textContent).toContain(title);
        expect(container.textContent).toContain(actionLabel);
        expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeTruthy();
        if (action === 'edit') {
          expect(container.textContent).toContain('Adjust AI service settings');
        } else if (action === 'retry') {
          expect(container.textContent).toContain('you do not need to shorten the prompt');
          expect(container.textContent).not.toContain('This request is too large');
          expect(container.textContent).not.toContain('Edit prompt');
          expect(container.textContent).not.toContain('Adjust AI service settings');
        }
        expect(container.textContent).toContain('Draft preserved');
        expect(container.textContent).not.toContain('Context limit reached');
        expect(container.textContent).not.toContain('Continue in new conversation');
        expect(container.textContent).not.toContain(reason);
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(prompt);
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
      });

      const recoveryAction = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === actionLabel);
      expect(recoveryAction).toBeDefined();
      await click(recoveryAction!);

      if (action === 'settings') {
        expect(onOpenOptions).toHaveBeenCalledOnce();
        expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(prompt);
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
        expect(turns).toHaveLength(2);
        expect(turns[1].input.sessionId).toBe(failedSessionId);
      } else if (action === 'edit') {
        const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
        expect(turns).toHaveLength(1);
        expect(textarea.value).toBe(prompt);
        expect(textarea.disabled).toBe(false);
        expect(document.activeElement).toBe(textarea);
        await setTextareaValue(textarea, 'Shorter prompt');
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
        expect(turns).toHaveLength(2);
        expect(turns[1].input.prompt).toBe('Shorter prompt');
        expect(turns[1].input.sessionId).toBe(failedSessionId);
      } else if (action === 'retry') {
        expect(turns).toHaveLength(2);
        expect(turns[1].input.prompt).toBe(prompt);
        expect(turns[1].input.sessionId).toBe(failedSessionId);
      }
    },
  );

  it('blocks an internal context retry after repository context changes', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const initial = (
      <AgentPanel open onClose={vi.fn()} />
    );
    const container = await mountAgentPanel(initial);
    const prompt = 'Continue inspecting repository A';
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'context_limit',
        contextFailureReason: 'tool_result_memory_limit',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      await Promise.resolve();
    });

    await act(async () => {
      mountedRoots.at(-1)?.render(
        <AgentPanel
          open
          onClose={vi.fn()}
          blockedConversationCandidate={{
            kind: 'selected_repository',
            selectedRepositoryIdHint: 'owner/repo-b',
          }}
        />,
      );
      await Promise.resolve();
    });

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retry?.disabled).toBe(true);
    expect(composerNote(container)?.textContent).toContain('owner/repo-b');
    await click(retry!);
    expect(turns).toHaveLength(1);
  });

  it('unlocks prompt editing after an internal memory terminal with a committed write', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    const prompt = 'Apply safe tags and continue analysis';
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'tool_execution_start',
        toolName: 'assign_repo_tags',
        callId: 'committed-before-memory-limit',
        risk: 'write',
      });
      turns[0].handlers.onEvent?.({
        ...deliveryIdentity(turns[0].input),
        type: 'tool_execution_end',
        toolName: 'assign_repo_tags',
        callId: 'committed-before-memory-limit',
        risk: 'write',
        ok: true,
        writeOutcome: 'committed',
      });
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'context_limit',
        contextFailureReason: 'tool_result_memory_limit',
        changed: true,
        changedCount: 1,
        commit: null,
      });
      await Promise.resolve();
    });

    const edit = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Edit prompt');
    expect(edit).toBeDefined();
    expect(container.textContent).toContain('a change may already be applied');
    expect(container.textContent).not.toContain('Retry to continue');
    await click(edit!);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    expect(textarea.disabled).toBe(false);
    expect(send.disabled).toBe(true);
    await setTextareaValue(textarea, `${prompt} - inspect previous results without repeating writes`);
    expect(send.disabled).toBe(false);
    await click(send);
    expect(turns).toHaveLength(2);
    expect(turns[1].input.sessionId).toBe(turns[0].input.sessionId);
  });

  it.each([
    'provider_context_overflow',
    'provider_request_byte_limit',
    'summary_provider_failed',
    'summary_invalid',
    'no_candidate',
    'fallback_too_large',
    'final_preflight_failed',
  ] as const)(
    'keeps %s as a retryable bounded provider failure rather than forcing a new conversation',
    async (reason) => {
      const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
      messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
        turns.push({ input, handlers });
        return { stop: vi.fn(), acknowledge: vi.fn() };
      });
      const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
      const prompt = `Recover this draft for ${reason}`;
      await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

      await act(async () => {
        turns[0].handlers.onResult?.({
          ...deliveryIdentity(turns[0].input),
          reason: 'context_limit',
          contextFailureReason: reason,
          changed: false,
          changedCount: 0,
          commit: null,
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
        const errorCard = container.querySelector<HTMLElement>('[data-testid="agent-provider-error-card"]');
        expect(errorCard?.textContent).toContain('Retry');
        expect(errorCard?.textContent).not.toContain(reason);
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(prompt);
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
      });
    },
  );

  it('preserves a long draft and usable recovery actions in a narrow drawer', async () => {
    let turn: { input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers } | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onOpenOptions={vi.fn()} />,
    );
    container.style.width = '280px';
    const prompt = `Inspect ${'repository-with-a-very-long-name-'.repeat(16)}`;
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    await act(async () => {
      turn?.handlers.onResult?.({
        ...deliveryIdentity(turn.input),
        reason: 'context_limit',
        contextFailureReason: 'current_turn_too_large',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      await Promise.resolve();
    });

    const drawer = container.querySelector('aside');
    const banner = container.querySelector<HTMLElement>('[data-testid="agent-context-recovery-banner"]');
    expect(drawer?.className).toContain('w-full');
    expect(drawer?.className).toContain('max-w-[460px]');
    expect(banner?.querySelector('button')?.parentElement?.className).toContain('flex-wrap');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(prompt);
    expect(container.textContent).not.toContain('Continue in new conversation');
  });

  it('opens the workbench directly without provider readiness checks', async () => {
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onOpenOptions={vi.fn()} />
    );

    expect(container.querySelector('[data-testid="agent-setup-gate"]')).toBeNull();
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-ready-quick-chips"]')).toBeTruthy();
  });


  it('marks the drawer active while running so hide keeps the same thread', async () => {
    messagingMocks.startBgsmAgentTurn.mockImplementation(() => ({ stop: vi.fn(), acknowledge: vi.fn() }));
    const onClose = vi.fn();
    const container = await mountAgentPanel(<AgentPanel open onClose={onClose} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Background turn');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    const drawer = container.querySelector('aside');
    expect(drawer?.getAttribute('data-agent-active')).toBe('true');
    expect(container.querySelector('button[aria-label="Hide Cubby"]')).toBeTruthy();
    await click(container.querySelector('button[aria-label="Hide Cubby"]')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the composer available after an unexpected context terminal', async () => {
    const turns: Array<{ input: BgsmAgentTurnInput; handlers: BgsmAgentTurnHandlers }> = [];
    messagingMocks.startBgsmAgentTurn.mockImplementation((input: BgsmAgentTurnInput, handlers: BgsmAgentTurnHandlers) => {
      turns.push({ input, handlers });
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });

    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Overflowing prompt');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await act(async () => {
      turns[0].handlers.onResult?.({
        ...deliveryIdentity(turns[0].input),
        reason: 'context_limit',
        changed: false,
        changedCount: 0,
        commit: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
      expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Overflowing prompt');
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    });
  });
});

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 25; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    textarea.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

function deliveryIdentity(input: BgsmAgentTurnInput) {
  return {
    turnAttemptId: input.turnAttemptId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
  };
}

function completedWorkbenchState(): AgentWorkbenchState {
  const controllerId = parseControllerId('controller:v1:session-lock-test');
  const sessionId = 'session-lock-test';
  const organizeJob: BgsmOrganizeJobPresentation = {
    controllerId,
    sessionId,
    runId: parseRunId('run:v1:session-lock-test'),
    generation: 1,
    jobId: 'organize-job:v1:session-lock-test',
    originAgentSessionId: sessionId,
    revision: 1,
    status: 'completed',
    scopeLabel: 'All stars',
    scopeCount: 1,
    capturedAt: 1,
    proposalId: parseProposalId('proposal:v1:session-lock-test'),
    coverage: {
      total: 1,
      analyzed: 1,
      actionable: 1,
      unchanged: 0,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 0,
    },
    selectedRepositories: 1,
    selectedActions: 1,
    apply: {
      applyId: 'apply:v1:session-lock-test',
      total: 1,
      settled: 1,
      changed: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    },
  };
  return {
    ...createAgentWorkbenchState(controllerId, sessionId),
    organizeJob,
  };
}

function durableWorkbenchState(
  status: BgsmOrganizeJobPresentation['status'],
  overrides: Partial<AgentWorkbenchState & Pick<BgsmOrganizeJobPresentation, 'apply'>> = {},
): AgentWorkbenchState {
  const base = completedWorkbenchState();
  const { apply, ...stateOverrides } = overrides;
  return {
    ...base,
    ...stateOverrides,
    role: stateOverrides.role ?? (status === 'completed' || status === 'cancelled' ? null : 'owner'),
    organizeJob: {
      ...base.organizeJob!,
      status,
      apply: apply === undefined ? null : apply,
    },
    organizeReceiptPage: null,
    organizeReceiptRequestId: null,
  };
}

function workbenchSnapshot(state: OrganizeJobRunSnapshot['state']): OrganizeJobRunSnapshot {
  return {
    controllerId: parseControllerId(`controller:v1:${state}-test`),
    sessionId: `session-${state}-test`,
    runId: parseRunId(`run:v1:${state}-test`),
    generation: 1,
    state,
    terminalReason: state === 'interrupted' ? 'worker_lost' : null,
    frozenScope: projectFrozenScope(createFrozenScope({
      kind: 'all_live_stars',
      label: 'All stars',
      filterSnapshot: '{}',
      repositoryIds: ['owner/repo'],
      capturedAt: 1,
      fingerprint: parseScopeFingerprint(`fs:${'w'.repeat(43)}`),
    })),
    budget: createProductionRunBudget(),
    usage: createEmptyRunBudgetUsage(),
    coverage: {
      total: 1,
      analyzed: state === 'analyzing' ? 0 : 1,
      actionable: 0,
      unchanged: state === 'analyzing' ? 0 : 1,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 0,
    },
    proposalId: null,
    continuationCursor: null,
  };
}
