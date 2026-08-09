import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import {
  AgentExecutionLedger,
  AgentProviderError,
  CONTEXT_PROFILE_8192,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  runAgentLoop,
} from '@/agent-harness';
import { createBgsmAgentTools } from '@/bgsm-agent';

const user: AgentMessage = {
  id: 'ledger-user',
  role: 'user',
  content: 'Apply the requested tag.',
  createdAt: 1,
};

type WriteArgs = { full_name: string; tags: string[] };
type WriteData = { full_name: string; tags: string[]; changed: boolean; reason: null | 'missing' };

function writeTool(
  writer: (args: WriteArgs, context: Parameters<NonNullable<AgentTool<WriteArgs, WriteData>['execute']>>[1]) => Promise<WriteData>,
): AgentTool<WriteArgs, WriteData> {
  return {
    name: 'assign_repo_tags',
    description: 'Assign tags.',
    risk: 'write',
    validate(input) {
      const value = input as WriteArgs;
      return { full_name: value.full_name.trim(), tags: value.tags.map((tag) => tag.trim()) };
    },
    writeEffectPlan: {
      canonicalEffects(args: WriteArgs) {
        return args.tags
          .map((tag) => ['assign_repo_tags', 'scope:test', args.full_name.trim().toLocaleLowerCase('en-US'), tag.trim().toLocaleLowerCase('en-US')] as const)
          .sort((left, right) => left[3].localeCompare(right[3]));
      },
      selectEffects(args: WriteArgs, effects: readonly (readonly [string, ...string[]])[]) {
        const selected = new Set(effects.map((effect) => effect[3]));
        return { ...args, tags: args.tags.filter((tag) => selected.has(tag.trim().toLocaleLowerCase('en-US'))) };
      },
      replayResult(args: WriteArgs) {
        return { full_name: args.full_name, tags: args.tags, changed: false, reason: null };
      },
      classifyResult(result: WriteData) {
        return result.reason === null ? 'committed' : 'failed';
      },
    },
    execute: writer,
  };
}

function providerFor(callId: string, args: WriteArgs) {
  return {
    async generate() {
      return { toolCalls: [{ id: callId, name: 'assign_repo_tags', arguments: args }] };
    },
  };
}

const allow = async () => ({ type: 'allow' as const });

describe('agent execution ledger', () => {
  it.each([
    ['none', 'none'],
    ['failed', 'all_failed'],
    ['authorized', 'unsafe'],
    ['started', 'unsafe'],
    ['committed', 'unsafe'],
    ['unknown', 'unsafe'],
  ] as const)('classifies %s write state as %s', (state, expected) => {
    const ledger = new AgentExecutionLedger();
    if (state !== 'none') {
      ledger.authorize({
        callId: `settlement-${state}`,
        toolName: 'assign_repo_tags',
        args: { full_name: 'owner/repo', tags: ['A'] },
        effects: [['assign_repo_tags', 'scope:test', 'owner/repo', 'a']],
        selectedEffects: [['assign_repo_tags', 'scope:test', 'owner/repo', 'a']],
      });
      if (state === 'started') ledger.markStarted(`settlement-${state}`);
      if (state === 'failed' || state === 'committed' || state === 'unknown') {
        ledger.settle(`settlement-${state}`, state);
      }
    }

    assert.equal(ledger.writeSettlement(), expected);
  });

  it('keeps a committed write receipt when byte recovery permits only a minimal envelope', async () => {
    const ledger = new AgentExecutionLedger();
    const writer = vi.fn(async (args: WriteArgs) => ({
      full_name: `${args.full_name}-${'x'.repeat(1_000)}`,
      tags: args.tags,
      changed: true,
      reason: null,
    }));
    const tool = writeTool(async (args, context) => {
      context.markWriteStarted?.();
      return writer(args);
    });
    let providerCalls = 0;
    const first = await runAgentLoop({
      sessionId: 'ledger-minimum-byte-receipt',
      messages: [user],
      rawMessages: [user],
      provider: {
        inspectRequest(request) {
          const containsToolEnvelope = request.messages.some((message) => (
            message.role === 'assistant' || message.role === 'tool'
          ));
          return {
            serializedHistoryBytes: containsToolEnvelope ? 1_001 : 100,
            serializedRequestBytes: containsToolEnvelope ? 2_001 : 200,
            historyByteLimit: 1_000,
            requestByteLimit: 2_000,
            accepted: !containsToolEnvelope,
            ...(containsToolEnvelope
              ? { failure: 'provider_history_too_large' as const }
              : {}),
          };
        },
        async generate() {
          providerCalls += 1;
          return providerCalls === 1
            ? {
                toolCalls: [{
                  id: 'minimum-write-call',
                  name: tool.name,
                  arguments: { full_name: 'owner/repo', tags: ['A'] },
                }],
              }
            : { content: 'Write completed.' };
        },
      },
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      contextPolicy: CONTEXT_PROFILE_8192,
      async onToolEnvelopeSettled() {
        return { kind: 'ready', messages: [user] };
      },
    });

    const receipt = first.rawMessages?.find((message) => (
      message.role === 'tool' && message.toolCallId === 'minimum-write-call'
    ));
    assert.ok(receipt);
    assert.deepEqual(JSON.parse(receipt.content), {
      ok: true,
      data: { writeOutcome: 'committed' },
    });
    assert.equal(ledger.stateForCall('minimum-write-call'), 'committed');

    const replay = await runAgentLoop({
      sessionId: 'ledger-minimum-byte-receipt',
      messages: [user],
      provider: providerFor('minimum-write-call', {
        full_name: 'owner/repo',
        tags: ['A'],
      }),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      maxSteps: 1,
    });
    assert.equal(writer.mock.calls.length, 1);
    assert.equal(
      replay.messages.find((message) => message.role === 'tool')?.content,
      receipt.content,
    );
  });

  it('keeps resolved write failures consistent across transcript, event, and replay', async () => {
    const ledger = new AgentExecutionLedger();
    const events: AgentEvent[] = [];
    const writer = vi.fn(async (args: WriteArgs) => ({
      full_name: args.full_name,
      tags: args.tags,
      changed: false,
      reason: 'missing' as const,
    }));
    const tool = writeTool(async (args, context) => {
      context.markWriteStarted?.();
      return writer(args);
    });
    const args = { full_name: 'owner/missing', tags: ['A'] };
    const first = await runAgentLoop({
      sessionId: 'ledger-resolved-failure',
      messages: [user],
      provider: providerFor('resolved-failure-call', args),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      emit: (event) => events.push(event),
      maxSteps: 1,
    });
    const firstReceipt = first.messages.find((message) => message.role === 'tool');
    assert.ok(firstReceipt);
    assert.deepEqual(JSON.parse(firstReceipt.content), {
      ok: false,
      error: { code: 'write_failed', message: 'Write did not commit.' },
    });
    assert.equal(ledger.stateForCall('resolved-failure-call'), 'failed');
    assert.equal(events.some((event) => (
      event.type === 'tool_execution_end'
      && event.callId === 'resolved-failure-call'
      && event.ok === false
      && event.writeOutcome === 'failed'
    )), true);

    const replay = await runAgentLoop({
      sessionId: 'ledger-resolved-failure',
      messages: [user],
      provider: providerFor('resolved-failure-call', args),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      maxSteps: 1,
    });
    assert.equal(writer.mock.calls.length, 1);
    assert.equal(
      replay.messages.find((message) => message.role === 'tool')?.content,
      firstReceipt.content,
    );
  });

  it('reuses a settled call and does not invoke permission or the writer again', async () => {
    const ledger = new AgentExecutionLedger();
    const writer = vi.fn(async (args: WriteArgs) => ({
      full_name: args.full_name,
      tags: args.tags,
      changed: true,
      reason: null,
    }));
    const tool = writeTool(async (args, context) => {
      context.markWriteStarted?.();
      return writer(args);
    });
    const permission = vi.fn(allow);

    await runAgentLoop({
      sessionId: 'ledger-call',
      messages: [user],
      provider: providerFor('call-1', { full_name: 'owner/repo', tags: ['A', 'B'] }),
      tools: [tool],
      permissions: permission,
      executionLedger: ledger,
      maxSteps: 1,
    });
    const replay = await runAgentLoop({
      sessionId: 'ledger-call',
      messages: [user],
      provider: providerFor('call-1', { full_name: 'owner/repo', tags: ['A', 'B'] }),
      tools: [tool],
      permissions: permission,
      executionLedger: ledger,
      maxSteps: 1,
    });

    assert.equal(writer.mock.calls.length, 1);
    assert.equal(permission.mock.calls.length, 1);
    assert.equal(ledger.stateForCall('call-1'), 'committed');
    assert.equal(replay.messages.filter((message) => message.role === 'tool').length, 1);
  });

  it('writes only the new effect for a new call ID and normalizes effect identity', async () => {
    const ledger = new AgentExecutionLedger();
    const received: string[][] = [];
    const tool = writeTool(async (args, context) => {
      context.markWriteStarted?.();
      received.push(args.tags);
      return { ...args, changed: true, reason: null };
    });
    const first = { full_name: 'owner/repo', tags: ['  A  '] };
    const second = { full_name: 'OWNER/REPO', tags: ['a', 'B'] };

    await runAgentLoop({
      sessionId: 'ledger-partial',
      messages: [user],
      provider: providerFor('call-a', first),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      maxSteps: 1,
    });
    await runAgentLoop({
      sessionId: 'ledger-partial',
      messages: [user],
      provider: providerFor('call-b', second),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      maxSteps: 1,
    });

    assert.deepEqual(received, [['A'], ['B']]);
    assert.equal(ledger.stateForEffect(['assign_repo_tags', 'scope:test', 'owner/repo', 'a']), 'committed');
    assert.equal(ledger.stateForEffect(['assign_repo_tags', 'scope:test', 'owner/repo', 'b']), 'committed');
  });

  it('executes only new repository-removal and global-deletion effects across retries', async () => {
    const ledger = new AgentExecutionLedger();
    const removals: unknown[] = [];
    const deletions: unknown[] = [];
    const tools = createBgsmAgentTools({
      repositoryScope: ['owner/repo'],
      scopeFingerprint: 'scope:test',
      removeVisibleTags: async (changes, context) => {
        context.markWriteStarted?.();
        removals.push(changes);
        const changed = changes.reduce((total, change) => total + change.tags.length, 0);
        return {
          requested: changed,
          changed,
          skipped: 0,
          repositoriesChanged: changes.length,
        };
      },
      deleteTagsEverywhere: async (tags, context) => {
        context.markWriteStarted?.();
        deletions.push(tags);
        return {
          requestedTags: tags.length,
          assignmentsRemoved: tags.length,
          repositoriesChanged: tags.length,
        };
      },
    });
    const remove = tools.find((tool) => tool.name === 'remove_repo_tags');
    const del = tools.find((tool) => tool.name === 'delete_tags_everywhere');
    assert.ok(remove);
    assert.ok(del);

    const run = (callId: string, tool: AgentTool, args: unknown) => runAgentLoop({
      sessionId: 'ledger-batch-tag-delete',
      messages: [user],
      provider: {
        async generate() {
          return { toolCalls: [{ id: callId, name: tool.name, arguments: args }] };
        },
      },
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      maxSteps: 1,
    });

    await run('remove-a', remove, {
      changes: [{ full_name: 'owner/repo', tags: ['legacy'] }],
    });
    await run('remove-b', remove, {
      changes: [{ full_name: 'OWNER/REPO', tags: ['LEGACY', 'unused'] }],
    });
    await run('delete-a', del, { tags: ['obsolete'] });
    await run('delete-b', del, { tags: ['OBSOLETE', 'unused'] });

    assert.deepEqual(removals, [
      [{ full_name: 'owner/repo', tags: ['legacy'] }],
      [{ full_name: 'owner/repo', tags: ['unused'] }],
    ]);
    assert.deepEqual(deletions, [['obsolete'], ['unused']]);
    assert.equal(
      ledger.stateForEffect(['remove_repo_tags', 'scope:test', 'owner/repo', 'legacy']),
      'committed',
    );
    assert.equal(
      ledger.stateForEffect(['remove_repo_tags', 'scope:test', 'owner/repo', 'unused']),
      'committed',
    );
    assert.equal(ledger.stateForEffect(['delete_tags_everywhere', 'obsolete']), 'committed');
    assert.equal(ledger.stateForEffect(['delete_tags_everywhere', 'unused']), 'committed');
  });

  it('blocks automatic replay after an uncertain writer outcome', async () => {
    const ledger = new AgentExecutionLedger();
    const writer = vi.fn(async (_args: WriteArgs, context: Parameters<NonNullable<AgentTool<WriteArgs, WriteData>['execute']>>[1]) => {
      context.markWriteStarted?.();
      throw new Error('uncertain');
    });
    const tool = writeTool(writer);
    const first = await runAgentLoop({
      sessionId: 'ledger-unknown',
      messages: [user],
      provider: providerFor('call-unknown-a', { full_name: 'owner/repo', tags: ['A'] }),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      maxSteps: 1,
    });
    const second = await runAgentLoop({
      sessionId: 'ledger-unknown',
      messages: [user],
      provider: providerFor('call-unknown-b', { full_name: 'owner/repo', tags: ['a'] }),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      maxSteps: 1,
    });

    assert.equal(writer.mock.calls.length, 1);
    assert.equal(ledger.stateForEffect(['assign_repo_tags', 'scope:test', 'owner/repo', 'a']), 'unknown');
    assert.equal(JSON.parse(first.messages.find((message) => message.role === 'tool')!.content).error.code, 'write_outcome_unknown');
    assert.equal(JSON.parse(second.messages.find((message) => message.role === 'tool')!.content).error.code, 'write_replay_blocked');
  });

  it('keeps a committed write when cancellation races its resolved result', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const ledger = new AgentExecutionLedger();
    const tool = writeTool(async (args, context) => {
      context.markWriteStarted?.();
      markStarted();
      await gate;
      return { ...args, changed: true, reason: null };
    });
    const running = runAgentLoop({
      sessionId: 'ledger-cancel',
      messages: [user],
      provider: providerFor('call-cancel', { full_name: 'owner/repo', tags: ['A'] }),
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      signal: controller.signal,
      maxSteps: 1,
    });
    await started;
    controller.abort();
    release();
    const result = await running;

    assert.equal(result.reason, 'aborted');
    assert.equal(ledger.stateForCall('call-cancel'), 'committed');
    assert.equal(JSON.parse(result.messages.find((message) => message.role === 'tool')!.content).ok, true);
  });

  it('does not replay a committed effect across overflow recovery and preserves its receipts', async () => {
    const ledger = new AgentExecutionLedger();
    const writer = vi.fn(async (args: WriteArgs) => ({
      full_name: args.full_name,
      tags: args.tags,
      changed: true,
      reason: null,
    }));
    const tool = writeTool(async (args, context) => {
      context.markWriteStarted?.();
      return writer(args);
    });
    const permission = vi.fn(allow);
    const events: AgentEvent[] = [];
    const rawSnapshots: AgentMessage[][] = [];
    let providerCalls = 0;
    let continuationCalls = 0;

    const result = await runAgentLoop({
      sessionId: 'ledger-overflow',
      messages: [user],
      rawMessages: [user],
      provider: {
        async generate() {
          providerCalls += 1;
          if (providerCalls === 1 || providerCalls === 3) {
            return {
              toolCalls: [{
                id: providerCalls === 1 ? 'overflow-write-a' : 'overflow-write-b',
                name: 'assign_repo_tags',
                arguments: providerCalls === 1
                  ? { full_name: 'owner/repo', tags: ['A'] }
                  : { full_name: 'OWNER/REPO', tags: [' a '] },
              }],
            };
          }
          throw new AgentProviderError(
            'context_overflow',
            'Provider context overflowed.',
            400,
          );
        },
      },
      tools: [tool],
      permissions: permission,
      executionLedger: ledger,
      emit: (event) => events.push(event),
      async onContextOverflow(continuation) {
        continuationCalls += 1;
        rawSnapshots.push([...(continuation.rawMessages ?? [])]);
        return { kind: 'ready', messages: [user] };
      },
    });

    const receipts = result.rawMessages?.filter((message) => message.role === 'tool') ?? [];
    assert.equal(result.reason, 'context_limit');
    assert.equal(result.contextFailureReason, 'provider_context_overflow_repeated');
    assert.equal(providerCalls, 5);
    assert.equal(continuationCalls, 2);
    assert.equal(writer.mock.calls.length, 1);
    assert.equal(permission.mock.calls.length, 1);
    assert.deepEqual(writer.mock.calls[0]?.[0], { full_name: 'owner/repo', tags: ['A'] });
    assert.equal(ledger.stateForCall('overflow-write-a'), 'committed');
    assert.equal(ledger.stateForCall('overflow-write-b'), 'committed');
    assert.equal(
      ledger.stateForEffect(['assign_repo_tags', 'scope:test', 'owner/repo', 'a']),
      'committed',
    );
    assert.deepEqual(rawSnapshots.map((snapshot) => snapshot.map((message) => message.role)), [
      ['user', 'agent', 'tool'],
      ['user', 'agent', 'tool', 'agent', 'tool'],
    ]);
    assert.deepEqual(receipts.map((message) => message.toolCallId), [
      'overflow-write-a',
      'overflow-write-b',
    ]);
    assert.equal(rawSnapshots[0]?.[2]?.content, receipts[0]?.content);
    assert.equal(rawSnapshots[1]?.[2]?.content, receipts[0]?.content);
    assert.equal(JSON.parse(receipts[0]!.content).data.changed, true);
    assert.equal(JSON.parse(receipts[1]!.content).data.changed, false);
    assert.equal(events.filter((event) => event.type === 'tool_execution_start').length, 1);
  });

  it('rejects a tool call ID hidden by overflow compaction without corrupting raw history', async () => {
    const ledger = new AgentExecutionLedger();
    const writer = vi.fn(async (args: WriteArgs) => ({
      full_name: args.full_name,
      tags: args.tags,
      changed: true,
      reason: null,
    }));
    const tool = writeTool(async (args, context) => {
      context.markWriteStarted?.();
      return writer(args);
    });
    let providerCalls = 0;
    const result = await runAgentLoop({
      sessionId: 'ledger-overflow-call-id',
      messages: [user],
      rawMessages: [user],
      provider: {
        async generate() {
          providerCalls += 1;
          if (providerCalls === 2) {
            throw new AgentProviderError(
              'context_overflow',
              'Provider context overflowed.',
              400,
            );
          }
          return {
            toolCalls: [{
              id: 'overflow-reused-call',
              name: 'assign_repo_tags',
              arguments: { full_name: 'owner/repo', tags: ['A'] },
            }],
          };
        },
      },
      tools: [tool],
      permissions: allow,
      executionLedger: ledger,
      async onContextOverflow() {
        return { kind: 'ready', messages: [user] };
      },
    });

    assert.equal(result.reason, 'protocol_error');
    assert.equal(providerCalls, 3);
    assert.equal(writer.mock.calls.length, 1);
    assert.equal(ledger.stateForCall('overflow-reused-call'), 'committed');
    assert.deepEqual(
      result.rawMessages?.filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId),
      ['overflow-reused-call'],
    );
  });

  it('rejects a write tool without an effect canonicalizer when a ledger is active', async () => {
    const tool: AgentTool = {
      name: 'unsafe_write',
      description: 'Unsafe write',
      risk: 'write',
      async execute() { throw new Error('must not run'); },
    };
    const result = await runAgentLoop({
      sessionId: 'ledger-contract',
      messages: [user],
      provider: {
        async generate() {
          return { toolCalls: [{ id: 'unsafe-call', name: 'unsafe_write', arguments: {} }] };
        },
      },
      tools: [tool],
      permissions: allow,
      executionLedger: new AgentExecutionLedger(),
      maxSteps: 1,
    });

    assert.equal(JSON.parse(result.messages.find((message) => message.role === 'tool')!.content).error.code, 'write_effect_plan_required');
  });
});
