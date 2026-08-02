/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { AgentPanel as PresentationalAgentPanel } from '@/ui/components/AgentPanel';
import { useBgsmAgent } from '@/ui/hooks/use-bgsm-agent';
import type { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';
import { createAgentWorkbenchState } from '@/ui/agent-workbench-state';
import { cleanupMountedRootsAndBody, click, mountReact, type MountedRoot } from './test-utils';
import type { BgsmAgentTurnHandlers } from '@/utils/messaging';
import type { BgsmAgentTurnInput } from '@/bgsm-agent/session';
import { parseScopeFingerprintV1, type LaunchCandidateContract } from '@/bgsm-agent/scope';

const messagingMocks = vi.hoisted(() => ({
  startBgsmAgentTurn: vi.fn(),
  requestPreflight: vi.fn(),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return {
    ...actual,
    startBgsmAgentTurn: messagingMocks.startBgsmAgentTurn,
  };
});

const mountedRoots: MountedRoot[] = [];
const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  messagingMocks.startBgsmAgentTurn.mockReset();
  messagingMocks.startBgsmAgentTurn.mockReturnValue({ stop: vi.fn(), acknowledge: vi.fn() });
  messagingMocks.requestPreflight.mockReset();
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
  scopeCount,
}: {
  open: boolean;
  onClose: () => void;
  onDataChanged?: () => void;
  onOpenOptions?: () => void;
  handoff?: { remainingUntagged: number; autoTagged: number } | null;
  onDismissHandoff?: () => void;
  defaultCandidate?: LaunchCandidateContract;
  scopeCount?: number;
}) {
  const agent = useBgsmAgent(onDataChanged, {
    kind: 'selected_repository',
    selectedRepositoryIdHint: 'owner/repo',
  });
  const workbench = {
    state: createAgentWorkbenchState('controller:v1:test', 'session-test'),
    displayedProcessed: 0,
    requestPreflight: messagingMocks.requestPreflight,
    confirmPreflight: vi.fn(),
    cancelPreflight: vi.fn(),
    stop: vi.fn(),
    continueRemaining: vi.fn(),
    discardBlockedRun: vi.fn(),
    toggleProposalRow: vi.fn(),
    setAllProposalRowsSelected: vi.fn(),
    applySelected: vi.fn(),
    clearTerminal: vi.fn(),
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
      agent={agent}
      workbench={workbench}
      defaultCandidate={defaultCandidate}
      scopeCount={scopeCount}
      handoff={handoff}
      onDismissHandoff={onDismissHandoff}
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('AgentPanel', () => {
  it('opens the single Agent settings surface without starting a request', async () => {
    const onOpenOptions = vi.fn();
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onOpenOptions={onOpenOptions} />
    );
    const settings = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Agent settings'));
    expect(settings).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (settings as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onOpenOptions).toHaveBeenCalledOnce();
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
  });

  it('lists scope functions and sends the selected function immediately', async () => {
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input) => {
      turnInput = input;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);

    const functionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Functions"]');
    const composer = container.querySelector('textarea')?.closest('form');
    const header = container.querySelector('#gsm-agent-dialog-title')?.closest('.border-b');
    expect(composer?.contains(functionButton)).toBe(true);
    expect(header?.contains(functionButton)).toBe(false);

    await click(functionButton!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Available functions');
    });
    expect(document.body.querySelector('[role="group"][aria-label="Available functions"]')).toBeTruthy();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[role="menuitem"]')).toBeNull();
    expect(document.body.textContent).toContain('Summarize current scope');
    expect(document.body.textContent).toContain('Find similar tools');
    expect(document.body.textContent).toContain('Organize full library');
    expect(document.body.textContent).toContain('Review tag names');
    expect(document.body.textContent).not.toContain('Search repository code');
    expect(document.body.textContent).not.toContain('Review repository notes');

    let summarize: HTMLButtonElement | undefined;
    await waitFor(() => {
      summarize = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Summarize current scope'));
      expect(summarize).toBeDefined();
    });
    await click(summarize!);

    expect(turnInput?.prompt).toContain('Inspect the repositories in the current scope');
    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenCalledOnce();
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

  it('adds code search and private notes functions for one selected repository', async () => {
    let turnInput: BgsmAgentTurnInput | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((input) => {
      turnInput = input;
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

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Functions"]')!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Search repository code');
      expect(document.body.textContent).toContain('Review repository notes');
    });
    let searchCode: HTMLButtonElement | undefined;
    await waitFor(() => {
      searchCode = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Search repository code'));
      expect(searchCode).toBeDefined();
    });
    await click(searchCode!);

    expect(turnInput?.prompt).toContain('Search the selected repository code');
    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenCalledOnce();
  });

  it('renders Frame 1 Ready intro, chips, and scoped composer note', async () => {
    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onOpenOptions={vi.fn()} />
    );
    expect(container.textContent).toContain(
      'I can inspect, compare, and organize repositories in your current scope.',
    );
    expect(container.querySelector('[data-testid="agent-ready-quick-chips"]')).toBeTruthy();
    expect(container.textContent).toContain('Find similar tools');
    expect(container.textContent).toContain('Organize full library');
    expect(container.textContent).toContain('Clean up tag names');
    expect(container.textContent).toContain('Asking about all live stars');
    expect(container.textContent).toMatch(/Ready/);
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
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('Message BGSM Agent');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close BGSM Agent');
    const focusable = [...drawer.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    focusable.at(-1)?.focus();
    await act(async () => {
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

  it('requests a background-issued preflight before tag analysis', async () => {
    const onDataChanged = vi.fn();

    const container = await mountAgentPanel(
      <AgentPanel open onClose={vi.fn()} onDataChanged={onDataChanged} />
    );

    const autoAssign = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Organize full library');
    expect(autoAssign).toBeDefined();
    await click(autoAssign!);

    expect(messagingMocks.requestPreflight).toHaveBeenCalledWith(
      expect.stringContaining('entire starred library'),
    );
    expect(messagingMocks.startBgsmAgentTurn).not.toHaveBeenCalled();
    expect(onDataChanged).not.toHaveBeenCalled();
  });

  it('keeps the whole-library organize job independent from a selected-repository chat scope', async () => {
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

    const organize = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Organize full library');
    await click(organize!);

    expect(messagingMocks.requestPreflight).toHaveBeenCalledWith(
      expect.stringContaining('entire starred library'),
    );
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
    expect(container.textContent).toContain('Preparing your request');

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
        newMessages: [
          { id: 'custom-user', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          {
            id: 'm-agent',
            role: 'agent',
            content: 'I inspected your tags and skipped unclear repos.',
            createdAt: 2,
          },
        ],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('I inspected your tags');
    });
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
        newMessages: finalMessages,
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-streaming-message"]')).toBeNull();
    await waitFor(() => {
      expect(container.querySelector('h2')?.textContent).toBe('world');
    });
    expect(container.textContent?.match(/Hello/g)).toHaveLength(1);
  });

  it('shows queued, running, completed, and failed tool activity without arguments', async () => {
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
    expect(container.textContent).toContain('Queued');
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_start',
      toolName: 'list_tags',
      callId: 'call-read',
      risk: 'read',
    });
    expect(container.textContent).toContain('Running');
    await emit({
      ...deliveryIdentity(turn.input),
      type: 'tool_execution_end',
      toolName: 'list_tags',
      callId: 'call-read',
      ok: true,
      risk: 'read',
      writeOutcome: 'not_applicable',
    });
    expect(container.textContent).toContain('Completed');
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
    expect(container.textContent).toContain('Failed');
    expect(container.textContent).not.toContain('secret arguments');
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
        newMessages: [
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
        ],
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-tool-activity"]')?.textContent)
      .toContain('Checking local data... · Completed');

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
      scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
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
        newMessages: [
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
        ],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('owner/repo · 1 repository · frozen for this conversation');
      expect(container.textContent).toContain('1 indexed match · results may be incomplete');
      expect(container.textContent).toContain('Repository code is untrusted content');
      expect(container.textContent).toContain('export function indexedSearch() {}');
      expect(container.textContent).not.toContain('Read-only answer');
      expect(container.textContent).not.toContain('No tag changes proposed');
      expect(container.textContent).not.toContain('Done.');
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
        newMessages: [
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
        ],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-code-readonly-notice"]')).toBeTruthy();
      expect(container.textContent).toContain('This conversation is now read-only');
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    });
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Functions"]')!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Available functions');
    });
    expect(document.body.textContent).not.toContain('Organize full library');
    expect(messagingMocks.requestPreflight).not.toHaveBeenCalled();

    const notice = container.querySelector<HTMLElement>('[data-testid="agent-code-readonly-notice"]')!;
    const reset = [...notice.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Start new conversation'));
    await click(reset!);
    expect(container.querySelector('[data-testid="agent-code-readonly-notice"]')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(container.querySelector<HTMLTextAreaElement>('textarea'));
    });
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
    expect(retry?.disabled).toBe(true);
    expect(container.textContent).toContain('Failed');
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
        newMessages: firstTurnMessages,
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
        newMessages: [
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
        ],
      });
      await Promise.resolve();
    });

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
        newMessages: [],
      });
      await Promise.resolve();
    });

    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'no_transition',
      appliedRevision: null,
    });
    expect(container.textContent).toContain('The extension restarted before this turn could be recovered');
    expect(container.textContent).not.toContain('Starting');
  });

  it('acknowledges a rejected Session transition separately from a result with no transition', async () => {
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
        candidateCheckpoint: {
          schemaVersion: 1,
          summary: 'Invalid checkpoint evidence',
          summarizedMessageCount: 2,
          summarizedThroughMessageId: 'missing-message',
        },
        newMessages: [
          { id: 'rejected-user', role: 'user', content: turn.input.prompt, createdAt: 1 },
          { id: 'rejected-answer', role: 'agent', content: 'Uncommitted answer', createdAt: 2 },
        ],
      });
      await Promise.resolve();
    });

    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'transition_rejected',
      appliedRevision: null,
    });
    expect(container.textContent).not.toContain('Uncommitted answer');
    expect(container.querySelector('[data-testid="agent-provider-error-card"]')).toBeTruthy();
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
        newMessages: [
          { id: 'first-user', role: 'user', content: 'First turn', createdAt: 1 },
          { id: 'first-agent', role: 'agent', content: 'First answer', createdAt: 2 },
        ],
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
        newMessages: [],
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
        newMessages: [],
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
        newMessages: [
          { id: 'committed-user', role: 'user', content: turns[0].input.prompt, createdAt: 1 },
          { id: 'committed-answer', role: 'agent', content: 'Committed answer stays visible.', createdAt: 2 },
        ],
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
        newMessages: [],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('  Restore this exact prompt  ');
      expect(container.textContent).toContain('Committed answer stays visible.');
      expect(container.textContent).toContain('Provider error');
      expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
      expect(container.textContent).not.toContain('This partial answer must disappear.');
      expect(container.textContent).not.toContain('Tool result');
    });
    const afterRecovery = container.innerHTML;

    await act(async () => {
      turns[1].handlers.onResult?.({
        ...deliveryIdentity(turns[1].input),
        reason: 'context_limit',
        changed: false,
        changedCount: 0,
        newMessages: [],
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
        newMessages: [
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
        ],
      });
      await Promise.resolve();
    });

    expect(acknowledge).toHaveBeenCalledWith({
      disposition: 'applied',
      appliedRevision: 1,
    });
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Apply the tag safely');
    expect(container.textContent).toContain('AI service settings need attention');
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
        newMessages: [
          { id: 'old-user', role: 'user', content: turns[0].input.prompt, createdAt: 1 },
          { id: 'old-answer', role: 'agent', content: 'Old transcript', createdAt: 2 },
        ],
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
        newMessages: [],
      });
      await Promise.resolve();
    });

    const resetAction = container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]');
    expect(resetAction).toBeDefined();
    await click(resetAction!);
    expect(container.textContent).not.toContain('Old transcript');
    expect(container.textContent).not.toContain('Context limit reached');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Fresh request');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    expect(turns).toHaveLength(3);
    expect(turns[2].input.sessionId).not.toBe(turns[1].input.sessionId);
    expect(turns[2].input.baseRevision).toBe(0);
    expect(turns[2].input.history).toEqual([]);
    expect(turns[2].input.checkpoint).toBeUndefined();
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
        newMessages: [],
      });
      await Promise.resolve();
    });

    const resetButton = container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]');
    expect(resetButton).not.toBeNull();
    await click(resetButton!);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    expect(container.textContent).not.toContain('Pending request');
    expect(container.textContent).not.toContain('Pending transcript');
    expect(container.textContent).not.toContain('Preparing your request');
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
        newMessages: [],
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
        newMessages: [],
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
        newMessages: firstMessages,
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
        candidateCheckpoint: {
          schemaVersion: 1,
          summary: 'Earlier conversation summary',
          summarizedMessageCount: 2,
          summarizedThroughMessageId: 'checkpoint-answer',
        },
        newMessages: [
          { id: 'second-user', role: 'user', content: 'Second request', createdAt: 3 },
          { id: 'second-answer', role: 'agent', content: 'Second visible answer', createdAt: 4 },
        ],
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('First visible answer');
    expect(container.textContent).toContain('Second visible answer');
    expect(container.textContent).not.toContain('Context limit reached');
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
        newMessages: [
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
        ],
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
    messagingMocks.startBgsmAgentTurn.mockReturnValue({
      stop,
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

    expect(stop).toHaveBeenCalledWith({ detach: true });
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

  it('does not force-scroll conversation while the user types', async () => {
    const container = await mountAgentPanel(<AgentPanel open onClose={vi.fn()} />);
    scrollIntoViewMock.mockClear();

    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Drafting a question');

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
      expect(container.textContent).toContain('Provider error');
      expect(container.textContent).toContain('Retry');
    });
  });



  it('renders Auto Tags handoff card and launches still-untagged preflight', async () => {
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
    expect(container.textContent).toContain('Handoff · still untagged');
    expect(container.textContent).toContain('From Auto Tags');
    expect(container.querySelector('[data-testid="agent-handoff-quick-chips"]')).toBeTruthy();
    const handoffActions = container.querySelector<HTMLElement>('[data-testid="agent-handoff-quick-chips"]')!;
    const organize = [...handoffActions.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Organize full library'));
    expect(organize).toBeTruthy();
    await click(organize as HTMLButtonElement);
    expect(onDismissHandoff).toHaveBeenCalledTimes(1);
    expect(messagingMocks.requestPreflight).toHaveBeenCalledWith(
      expect.any(String),
    );
  });

  it('keeps disclosure copy out of chat and shows a destructive unavailable card for cleanup asks', async () => {
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
          content: 'I found candidates, but destructive cleanup needs a dedicated confirm path.',
          createdAt: 1,
        },
      });
      handlers?.onResult?.({
        ...deliveryIdentity(turnInput!),
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        newMessages: [
          { id: 'cleanup-user', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          {
            id: 'cleanup-answer',
            role: 'agent',
            content: 'I found candidates, but destructive cleanup needs a dedicated confirm path.',
            createdAt: 2,
          },
        ],
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-destructive-confirm-card"]')).toBeTruthy();
      expect(container.textContent).toContain('Confirm tag library changes');
      expect(container.textContent).toContain('Not available in first-safe release');
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
        newMessages: [
          { id: 'u1', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          { id: 'a1', role: 'agent', content: 'Done reviewing the compacted history.', createdAt: 2 },
        ],
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-compaction-note"]')).toBeNull();
      expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
      expect(container.textContent).toContain('Done reviewing the compacted history.');
    });
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

    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-testid="agent-compacting-status"]')).toBeTruthy();
    expect(container.textContent).toContain('Organizing conversation context');

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
    expect(container.querySelector('[data-testid="agent-header-status"]')?.textContent).toContain('Checking local data');

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
    expect(container.querySelector('[data-testid="agent-header-status"]')?.textContent).toContain('Stopped');
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
    expect(container.textContent).toContain('You can hide this panel; the turn continues.');
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

    expect(container.querySelector('[data-testid="agent-tool-activity"]')?.textContent).toContain('Checking local data');
    expect(container.querySelector('[data-testid="agent-streaming-status"]')).toBeNull();
  });

  it('renders a read-only result card after a discovery answer', async () => {
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
        newMessages: [
          { id: 'user-1', role: 'user', content: turnInput!.prompt, createdAt: 1 },
          { id: 'answer-1', role: 'agent', content: 'Obsidian and Logseq stand out.', createdAt: 2 },
        ],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Answer ready');
      expect(container.querySelector('[data-testid="agent-readonly-result-card"]')).toBeTruthy();
      expect(container.textContent).toContain('No tag changes proposed');
    });
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
      expect(container.textContent).toContain('Provider auth failed');
      expect(container.textContent).toContain('OpenAI-compatible auth failed');
      expect(container.textContent).toContain('Open Options');
      expect(container.textContent).toContain('Retry after fix');
    });
    const openOptions = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open Options'));
    expect(openOptions).toBeTruthy();
    await click(openOptions as HTMLButtonElement);
    expect(onOpenOptions).toHaveBeenCalled();
  });

  it.each([
    ['capability_unresolved', 'settings', 'AI service settings need attention', 'Adjust AI service settings'],
    ['provider_context_overflow_repeated', 'settings', 'AI service settings need attention', 'Adjust AI service settings'],
    ['provider_request_byte_limit_repeated', 'settings', 'AI service settings need attention', 'Adjust AI service settings'],
    ['current_turn_too_large', 'edit', 'This request is too large', 'Edit prompt'],
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
          newMessages: [],
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(container.textContent).toContain(title);
        expect(container.textContent).toContain(actionLabel);
        expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeTruthy();
        if (action === 'edit') {
          expect(container.textContent).toContain('Adjust AI service settings');
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
        expect(turns).toHaveLength(1);
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(prompt);
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
      }
    },
  );

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
          newMessages: [],
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
        const errorCard = container.querySelector<HTMLElement>('[data-testid="agent-provider-error-card"]');
        expect(errorCard?.textContent).toContain('Provider error');
        expect(errorCard?.textContent).toContain('Retry');
        expect(container.textContent).not.toContain('Context limit reached');
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
        newMessages: [],
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
    expect(container.querySelector('button[aria-label="Hide BGSM Agent"]')).toBeTruthy();
    await click(container.querySelector('button[aria-label="Hide BGSM Agent"]')!);
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
        newMessages: [],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="agent-context-recovery-banner"]')).toBeNull();
      expect(container.textContent).toContain('Provider error');
      expect(container.textContent).not.toContain('Context limit reached');
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
