import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  MAX_TOOL_RESULT_BYTES,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@/agent-harness';
import {
  AGENT_ARTIFACT_UNTRUSTED_TOOL_OUTPUT_INSTRUCTION,
  agentArtifactCoverageDirectives,
  applyAgentArtifactCoverageEvidence,
  createAgentArtifactCoverage,
  createBgsmAgentArtifactContinuationToolRegistry,
  createBgsmAgentArtifactEvidenceHandoff,
  createBgsmAgentToolResultExternalizer,
  digestAgentArtifactTouchedChunks,
  type AgentArtifactContinuationCheckpoint,
  type AgentArtifactCoverageEvidence,
  type AgentArtifactCoverageRecord,
} from '@/bgsm-agent';
import {
  BgsmAgentArtifactCoverageStalledError,
  BGSM_AGENT_ARTIFACT_CONTINUATION_PREAMBLE,
  buildBgsmAgentArtifactContinuationMessages,
  createBgsmAgentArtifactAdmissionRuntime,
  runBgsmAgentEpisodes,
} from '@/background/bgsm-agent-episode-driver';
import type { AgentArtifactCoverageCheckpointProposal } from '@/storage/agent-session-store';

const SESSION_ID = 'session-artifact-episodes';
const ATTEMPT_ID = 'attempt-artifact-episodes';
const LAUNCH_DIGEST = `asl:v1:${'l'.repeat(43)}` as const;
const ARTIFACT_SHA = 'a'.repeat(43);
const MANIFEST_SHA = 'm'.repeat(43);

function createMemoryCoverageCoordinator() {
  let coverage: AgentArtifactCoverageRecord[] = [];
  let continuation: AgentArtifactContinuationCheckpoint | null = null;
  let repromptWrites = 0;
  const applyProposals = async (
    proposals: readonly AgentArtifactCoverageCheckpointProposal[],
  ) => {
    for (const proposal of proposals) {
      if (proposal.kind === 'start') {
        coverage = [...coverage, proposal.record];
        continue;
      }
      const record = coverage.find((candidate) => candidate.coverageId === proposal.coverageId);
      if (!record) throw new Error('fixture coverage record missing');
      const pending = coverage.find((candidate) => candidate.state === 'pending');
      if (!pending || pending.coverageId !== record.coverageId) {
        throw new Error('fixture coverage order mismatch');
      }
      const applied = await applyAgentArtifactCoverageEvidence(record, proposal.evidence);
      coverage = coverage.map((candidate) => (
        candidate.coverageId === record.coverageId ? applied.record : candidate
      ));
    }
  };
  return {
    coordinator: {
      async checkpointArtifactEnvelope(input: Readonly<{
        proposals: readonly AgentArtifactCoverageCheckpointProposal[];
        continuation: AgentArtifactContinuationCheckpoint | null;
      }>) {
        await applyProposals(input.proposals);
        assert.deepEqual(
          input.continuation?.directives ?? [],
          agentArtifactCoverageDirectives(coverage),
        );
        continuation = input.continuation;
        return {
          artifactCoverage: [...coverage],
          artifactContinuation: continuation,
        };
      },
      async markArtifactRepromptUsed(input: Readonly<{
        continuation: AgentArtifactContinuationCheckpoint;
      }>) {
        assert.equal(continuation?.nonProgressRepromptUsed, false);
        assert.equal(input.continuation.nonProgressRepromptUsed, true);
        repromptWrites += 1;
        continuation = input.continuation;
        return continuation;
      },
    },
    getCoverage: () => [...coverage],
    getContinuation: () => continuation,
    getRepromptWrites: () => repromptWrites,
  };
}

async function createEpisodeFixture(pageCount: number) {
  const memory = createMemoryCoverageCoordinator();
  const admissionRuntime = await createBgsmAgentArtifactAdmissionRuntime({
    sessionId: SESSION_ID,
    turnAttemptId: ATTEMPT_ID,
    launchDigest: LAUNCH_DIGEST,
    coordinator: memory.coordinator,
  });
  const evidenceHandoff = createBgsmAgentArtifactEvidenceHandoff();
  let storedArtifact: { artifactId: string; byteLength: number } | null = null;
  const externalizer = createBgsmAgentToolResultExternalizer({
    turnAttemptId: ATTEMPT_ID,
    evidenceHandoff,
    admissionAuthority: admissionRuntime.authority,
    artifactStore: async (input) => {
      storedArtifact = {
        artifactId: input.artifactId,
        byteLength: new TextEncoder().encode(input.content).byteLength,
      };
      return {
        ...storedArtifact,
        contentType: input.contentType,
        artifactSha256: ARTIFACT_SHA,
        integrityManifestSha256: MANIFEST_SHA,
      };
    },
    artifactDisposer: async () => {},
  });
  const readArguments: Array<{
    artifactId: string;
    cursor?: string;
    byteOffset?: number;
    search?: { query: string; fromByte: number };
  }> = [];
  const continuationRegistry = createBgsmAgentArtifactContinuationToolRegistry({
    artifactEvidenceHandoff: evidenceHandoff,
    authorize: admissionRuntime.authorizeContinuationRead,
    artifactReader: async (input) => {
      if (!storedArtifact) throw new Error('fixture artifact was not stored');
      readArguments.push({ ...input.arguments });
      const readKind = input.arguments.search !== undefined
        ? 'search' as const
        : input.arguments.byteOffset !== undefined
          ? 'offset' as const
          : 'page' as const;
      const index = readKind === 'page' && input.arguments.cursor !== undefined
        ? Number(input.arguments.cursor.slice('cursor:'.length))
        : 0;
      const baseBytes = Math.floor(storedArtifact.byteLength / pageCount);
      const pageBytes = readKind === 'page'
        ? index === pageCount - 1
          ? storedArtifact.byteLength - baseBytes * (pageCount - 1)
          : baseBytes
        : 0;
      const nextCursor = readKind === 'page'
        ? index === pageCount - 1 ? null : `cursor:${index + 1}`
        : null;
      const touchedChunks = readKind === 'search'
        ? []
        : [{
            index,
            byteLength: readKind === 'page' ? pageBytes : 1,
            sha256: 'c'.repeat(43),
          }];
      const content = readKind === 'page' ? 'p'.repeat(pageBytes) : 'located';
      const evidence: AgentArtifactCoverageEvidence = {
        schemaVersion: 1,
        artifactId: storedArtifact.artifactId,
        artifactBytes: storedArtifact.byteLength,
        artifactSha256: ARTIFACT_SHA,
        integrityManifestSha256: MANIFEST_SHA,
        readKind,
        cursorSupplied: input.arguments.cursor !== undefined,
        inputCursor: input.arguments.cursor ?? null,
        pageBytes,
        nextCursor,
        touchedChunks,
        touchedChunkCount: touchedChunks.length,
        touchedChunkBytes: touchedChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
        touchedChunkDigest: await digestAgentArtifactTouchedChunks(touchedChunks),
        integrityVerified: true,
      };
      return {
        result: {
          artifactId: storedArtifact.artifactId,
          content,
          contentType: 'application/json',
          byteLength: new TextEncoder().encode(content).byteLength,
          totalBytes: storedArtifact.byteLength,
          nextCursor,
          ...(readKind === 'search' ? { matchByteOffset: 0 } : {}),
        },
        evidence,
      };
    },
  });
  const largeRead: AgentTool = {
    name: 'large_read',
    description: 'Return one deliberately oversized read result.',
    risk: 'read',
    async execute() {
      return { payload: 'x'.repeat(MAX_TOOL_RESULT_BYTES + 8_192) };
    },
  };
  return {
    admissionRuntime,
    externalizer,
    largeRead,
    continuationTools: [...continuationRegistry.getActiveTools()],
    readArguments,
    memory,
  };
}

function initialMessages(): AgentMessage[] {
  return [
    { id: 'system', role: 'system', content: 'System prompt.', createdAt: 1 },
    { id: 'user', role: 'user', content: 'Inspect every byte.', createdAt: 2 },
  ];
}

async function coverageEvidence(input: Readonly<{
  artifactId: string;
  artifactBytes: number;
  readKind: AgentArtifactCoverageEvidence['readKind'];
  inputCursor: string | null;
  nextCursor: string | null;
  pageBytes: number;
  touchedChunkIndex?: number;
}>): Promise<AgentArtifactCoverageEvidence> {
  const touchedChunks = input.pageBytes === 0
    ? []
    : [{
        index: input.touchedChunkIndex ?? 0,
        byteLength: input.pageBytes,
        sha256: 'c'.repeat(43),
      }];
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    artifactBytes: input.artifactBytes,
    artifactSha256: ARTIFACT_SHA,
    integrityManifestSha256: MANIFEST_SHA,
    readKind: input.readKind,
    cursorSupplied: input.inputCursor !== null,
    inputCursor: input.inputCursor,
    pageBytes: input.pageBytes,
    nextCursor: input.nextCursor,
    touchedChunks,
    touchedChunkCount: touchedChunks.length,
    touchedChunkBytes: input.pageBytes,
    touchedChunkDigest: await digestAgentArtifactTouchedChunks(touchedChunks),
    integrityVerified: true,
  };
}

describe('BGSM Agent episode driver', () => {
  it('authorizes locating reads only between exact pending pages without moving coverage', async () => {
    const memory = createMemoryCoverageCoordinator();
    const runtime = await createBgsmAgentArtifactAdmissionRuntime({
      sessionId: SESSION_ID,
      turnAttemptId: ATTEMPT_ID,
      launchDigest: LAUNCH_DIGEST,
      coordinator: memory.coordinator,
    });
    const artifactId = 'artifact-targeted-read';
    const artifactBytes = 8;
    const source = await runtime.authority.startCoverage({
      sessionId: SESSION_ID,
      turnAttemptId: ATTEMPT_ID,
      sourceToolCallId: 'source-targeted-read',
      toolName: 'large_read',
      artifact: {
        artifactId,
        byteLength: artifactBytes,
        contentType: 'application/json',
        artifactSha256: ARTIFACT_SHA,
        integrityManifestSha256: MANIFEST_SHA,
      },
      requiredBeforeFinal: [],
    });
    assert.ok(source.admissionToken);
    await runtime.authority.admitEnvelope({
      admissionTokens: [source.admissionToken],
      requiredBeforeFinal: source.requiredBeforeFinal,
      projectedMessages: initialMessages(),
      canonicalRawMessages: [initialMessages()[1]!],
      envelopeKind: 'canonical_source',
    });

    const authorize = (arguments_: {
      artifactId: string;
      cursor?: string;
      byteOffset?: number;
      search?: { query: string; fromByte: number };
    }) => runtime.authorizeContinuationRead({
      sessionId: SESSION_ID,
      toolCallId: 'targeted-read',
      arguments: arguments_,
    });
    const searchEvidence = await coverageEvidence({
      artifactId,
      artifactBytes,
      readKind: 'search',
      inputCursor: null,
      nextCursor: null,
      pageBytes: 0,
    });
    const offsetEvidence = await coverageEvidence({
      artifactId,
      artifactBytes,
      readKind: 'offset',
      inputCursor: null,
      nextCursor: null,
      pageBytes: 0,
    });
    assert.equal(authorize({ artifactId }), true);
    assert.equal(authorize({ artifactId, search: { query: 'needle', fromByte: 0 } }), false);
    assert.equal(authorize({ artifactId, byteOffset: 2 }), false);
    await assert.rejects(
      () => runtime.authority.admitInspection({
        sessionId: SESSION_ID,
        turnAttemptId: ATTEMPT_ID,
        sourceToolCallId: 'pre-first-search',
        artifactId,
        accessKind: 'search',
        evidence: searchEvidence,
        requiredBeforeFinal: runtime.requiredBeforeFinal(),
      }),
      /issued pending artifact cursor/u,
    );

    const firstPage = await runtime.authority.admitInspection({
      sessionId: SESSION_ID,
      turnAttemptId: ATTEMPT_ID,
      sourceToolCallId: 'first-page',
      artifactId,
      accessKind: 'page',
      evidence: await coverageEvidence({
        artifactId,
        artifactBytes,
        readKind: 'page',
        inputCursor: null,
        nextCursor: 'cursor:1',
        pageBytes: 4,
      }),
      requiredBeforeFinal: runtime.requiredBeforeFinal(),
    });
    await runtime.authority.admitEnvelope({
      admissionTokens: [firstPage.admissionToken],
      requiredBeforeFinal: firstPage.requiredBeforeFinal,
      projectedMessages: initialMessages(),
      canonicalRawMessages: [initialMessages()[1]!],
      envelopeKind: 'internal_continuation',
    });

    const pending = memory.getCoverage()[0]!;
    const progressSnapshot = {
      state: pending.state,
      bytesDelivered: pending.bytesDelivered,
      expectedCursor: pending.expectedCursor,
      progressToken: pending.progressToken,
      cursorChainDigest: pending.cursorChainDigest,
    };
    assert.equal(progressSnapshot.state, 'pending');
    assert.equal(progressSnapshot.bytesDelivered, 4);
    assert.equal(progressSnapshot.expectedCursor, 'cursor:1');
    assert.equal(authorize({ artifactId }), false);
    assert.equal(authorize({ artifactId, cursor: 'cursor:1' }), true);
    assert.equal(authorize({ artifactId, cursor: 'guessed' }), false);
    assert.equal(authorize({ artifactId, search: { query: 'needle', fromByte: 0 } }), true);
    assert.equal(authorize({ artifactId, byteOffset: 2 }), true);

    for (const [accessKind, arguments_, evidence] of [
      ['search', { artifactId, search: { query: 'needle', fromByte: 0 } }, searchEvidence],
      ['offset', { artifactId, byteOffset: 2 }, offsetEvidence],
    ] as const) {
      const inspection = await runtime.authority.admitInspection({
        sessionId: SESSION_ID,
        turnAttemptId: ATTEMPT_ID,
        sourceToolCallId: `${accessKind}-between-pages`,
        artifactId,
        accessKind,
        evidence,
        requiredBeforeFinal: runtime.requiredBeforeFinal(),
      });
      await runtime.authority.admitEnvelope({
        admissionTokens: [inspection.admissionToken],
        requiredBeforeFinal: inspection.requiredBeforeFinal,
        projectedMessages: initialMessages(),
        canonicalRawMessages: [initialMessages()[1]!],
        envelopeKind: 'internal_continuation',
      });
      assert.equal(authorize(arguments_), true);
      const current = memory.getCoverage()[0]!;
      assert.deepEqual({
        state: current.state,
        bytesDelivered: current.bytesDelivered,
        expectedCursor: current.expectedCursor,
        progressToken: current.progressToken,
        cursorChainDigest: current.cursorChainDigest,
      }, progressSnapshot);
    }

    const finalPage = await runtime.authority.admitInspection({
      sessionId: SESSION_ID,
      turnAttemptId: ATTEMPT_ID,
      sourceToolCallId: 'final-page',
      artifactId,
      accessKind: 'page',
      evidence: await coverageEvidence({
        artifactId,
        artifactBytes,
        readKind: 'page',
        inputCursor: 'cursor:1',
        nextCursor: null,
        pageBytes: 4,
        touchedChunkIndex: 1,
      }),
      requiredBeforeFinal: runtime.requiredBeforeFinal(),
    });
    await runtime.authority.admitEnvelope({
      admissionTokens: [finalPage.admissionToken],
      requiredBeforeFinal: finalPage.requiredBeforeFinal,
      projectedMessages: initialMessages(),
      canonicalRawMessages: [initialMessages()[1]!],
      envelopeKind: 'internal_continuation',
    });
    assert.equal(memory.getCoverage()[0]?.state, 'complete');
    assert.equal(authorize({ artifactId }), false);
    assert.equal(authorize({ artifactId, cursor: 'cursor:1' }), false);
    assert.equal(authorize({ artifactId, search: { query: 'needle', fromByte: 0 } }), false);
    assert.equal(authorize({ artifactId, byteOffset: 2 }), false);
    await assert.rejects(
      () => runtime.authority.admitInspection({
        sessionId: SESSION_ID,
        turnAttemptId: ATTEMPT_ID,
        sourceToolCallId: 'post-complete-search',
        artifactId,
        accessKind: 'search',
        evidence: searchEvidence,
        requiredBeforeFinal: runtime.requiredBeforeFinal(),
      }),
      /no pending obligation/u,
    );
  });

  it('gives initial, pending, and re-prompt reader phases distinct safe instructions', async () => {
    const artifactId = 'artifact-prompt-phases';
    const initial = await createAgentArtifactCoverage({
      artifactId,
      sourceToolCallId: 'prompt-source',
      expectedBytes: 8,
      artifactSha256: ARTIFACT_SHA,
      integrityManifestSha256: MANIFEST_SHA,
    });
    const initialPrompt = buildBgsmAgentArtifactContinuationMessages(
      initialMessages(),
      'Continuation-only context.',
      initial,
      false,
    )[0]!.content;
    assert.equal(initialPrompt.includes(JSON.stringify({ artifactId })), true);
    assert.match(initialPrompt, /This first exhaustive call must happen before any locator/u);
    assert.match(initialPrompt, /Only after that exhaustive page returns a non-null nextCursor/u);
    assert.equal(initialPrompt.includes(AGENT_ARTIFACT_UNTRUSTED_TOOL_OUTPUT_INSTRUCTION), true);

    const pending = (await applyAgentArtifactCoverageEvidence(initial, await coverageEvidence({
      artifactId,
      artifactBytes: 8,
      readKind: 'page',
      inputCursor: null,
      nextCursor: 'cursor:1',
      pageBytes: 4,
    }))).record;
    const pendingPrompt = buildBgsmAgentArtifactContinuationMessages(
      initialMessages(),
      'Continuation-only context.',
      pending,
      false,
    )[0]!.content;
    assert.match(pendingPrompt, /Before the next exhaustive page, you may make a bounded locating read/u);
    assert.equal(pendingPrompt.includes(JSON.stringify({ artifactId, cursor: 'cursor:1' })), true);
    assert.equal(pendingPrompt.includes(AGENT_ARTIFACT_UNTRUSTED_TOOL_OUTPUT_INSTRUCTION), true);

    const repromptPrompt = buildBgsmAgentArtifactContinuationMessages(
      initialMessages(),
      'Continuation-only context.',
      pending,
      true,
    )[0]!.content;
    assert.match(repromptPrompt, /only constrained re-prompt/u);
    assert.match(repromptPrompt, /Do not add prose, sibling tool calls, byteOffset, search/u);
    assert.doesNotMatch(repromptPrompt, /may make a bounded locating read/u);
    assert.equal(repromptPrompt.includes(JSON.stringify({ artifactId, cursor: 'cursor:1' })), true);
    assert.equal(repromptPrompt.includes(AGENT_ARTIFACT_UNTRUSTED_TOOL_OUTPUT_INSTRUCTION), true);
  });

  it('crosses eight pages, checkpoints a reduced projection, and admits one final answer', async () => {
    const fixture = await createEpisodeFixture(10);
    const events: AgentEvent[] = [];
    let sourceIssued = false;
    let readerCalls = 0;
    let reductions = 0;
    const result = await runBgsmAgentEpisodes({
      sessionId: SESSION_ID,
      systemPrompt: 'Ordinary-only system prompt.',
      continuationSystemPrompt: 'Continuation-only system prompt.',
      messages: initialMessages(),
      rawMessages: [initialMessages()[1]!],
      ordinaryTools: [fixture.largeRead],
      continuationTools: fixture.continuationTools,
      admissionHost: fixture.externalizer,
      admissionRuntime: fixture.admissionRuntime,
      provider: {
        async generate(input) {
          const toolNames = input.tools.map((tool) => tool.name);
          if (toolNames.includes('large_read') && !sourceIssued) {
            assert.match(input.messages[0]?.content ?? '', /Ordinary-only system prompt/u);
            assert.doesNotMatch(input.messages[0]?.content ?? '', /Continuation-only system prompt/u);
            assert.equal(toolNames.includes('read_agent_artifact'), false);
            sourceIssued = true;
            return {
              toolCalls: [{ id: 'source-call', name: 'large_read', arguments: {} }],
            };
          }
          if (toolNames.length === 1 && toolNames[0] === 'read_agent_artifact') {
            assert.match(input.messages[0]?.content ?? '', /Continuation-only system prompt/u);
            assert.doesNotMatch(input.messages[0]?.content ?? '', /Ordinary-only system prompt/u);
            const artifactId = fixture.admissionRuntime.nextPendingCoverage()?.artifactId;
            assert.ok(artifactId);
            const arguments_: { artifactId: string; cursor?: string } = { artifactId };
            if (readerCalls > 0) arguments_.cursor = `cursor:${readerCalls}`;
            if (readerCalls === 0 || readerCalls === 8) {
              assert.match(
                input.messages[0]?.content ?? '',
                new RegExp(JSON.stringify(arguments_).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
              );
            }
            const response = {
              toolCalls: [{
                id: `reader-call-${readerCalls}`,
                name: 'read_agent_artifact',
                arguments: arguments_,
              }],
            };
            readerCalls += 1;
            return response;
          }
          assert.deepEqual(toolNames, ['large_read']);
          assert.match(input.messages[0]?.content ?? '', /Ordinary-only system prompt/u);
          assert.doesNotMatch(
            input.messages[0]?.content ?? '',
            new RegExp(BGSM_AGENT_ARTIFACT_CONTINUATION_PREAMBLE, 'u'),
          );
          return { content: 'Final answer after exact exhaustive coverage.' };
        },
      },
      createContextContinuation: () => async (continuation) => {
        reductions += 1;
        return {
          kind: 'ready',
          messages: [
            continuation.messages[0]!,
            continuation.messages[1]!,
            ...continuation.messages.slice(-2),
          ],
        };
      },
      emit: (event) => events.push(event),
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(readerCalls, 10);
    assert.equal(reductions, 1);
    assert.equal(fixture.readArguments[0]?.cursor, undefined);
    assert.deepEqual(
      fixture.readArguments.slice(1).map((arguments_) => arguments_.cursor),
      Array.from({ length: 9 }, (_, index) => `cursor:${index + 1}`),
    );
    assert.equal(fixture.memory.getCoverage()[0]?.state, 'complete');
    assert.equal(fixture.memory.getContinuation(), null);
    assert.deepEqual(
      result.rawMessages?.map((message) => message.role),
      ['user', 'agent', 'tool', 'agent'],
    );
    assert.equal(events.filter((event) => event.type === 'agent_done').length, 1);
    assert.equal(events.filter((event) => event.type === 'assistant_stream_start').length, 0);
  });

  it('converts a max-step locator-only continuation into one re-prompt and a typed stall', async () => {
    const fixture = await createEpisodeFixture(4);
    let sourceIssued = false;
    let firstPageIssued = false;
    let locatingReads = 0;
    let sawReprompt = false;
    await assert.rejects(
      () => runBgsmAgentEpisodes({
        sessionId: SESSION_ID,
        systemPrompt: 'System prompt.',
        continuationSystemPrompt: 'System prompt.',
        messages: initialMessages(),
        rawMessages: [initialMessages()[1]!],
        ordinaryTools: [fixture.largeRead],
        continuationTools: fixture.continuationTools,
        admissionHost: fixture.externalizer,
        admissionRuntime: fixture.admissionRuntime,
        provider: {
          async generate(input) {
            if (input.tools.some((tool) => tool.name === 'large_read') && !sourceIssued) {
              sourceIssued = true;
              return { toolCalls: [{ id: 'locator-source', name: 'large_read', arguments: {} }] };
            }
            assert.deepEqual(input.tools.map((tool) => tool.name), ['read_agent_artifact']);
            const artifactId = fixture.admissionRuntime.nextPendingCoverage()?.artifactId;
            assert.ok(artifactId);
            if (!firstPageIssued) {
              firstPageIssued = true;
              return {
                toolCalls: [{
                  id: 'locator-first-page',
                  name: 'read_agent_artifact',
                  arguments: { artifactId },
                }],
              };
            }
            if ((input.messages[0]?.content ?? '').includes('only constrained re-prompt')) {
              sawReprompt = true;
              return { content: 'Still no exhaustive page.' };
            }
            locatingReads += 1;
            return {
              toolCalls: [{
                id: `locator-search-${locatingReads}`,
                name: 'read_agent_artifact',
                arguments: { artifactId, search: { query: 'needle', fromByte: 0 } },
              }],
            };
          },
        },
        createContextContinuation: () => async (continuation) => ({
          kind: 'ready',
          messages: [...continuation.messages],
        }),
      }),
      (error: unknown) => error instanceof BgsmAgentArtifactCoverageStalledError
        && error.code === 'agent_artifact_coverage_stalled',
    );
    assert.ok(locatingReads > 8);
    assert.equal(sawReprompt, true);
    assert.equal(fixture.memory.getRepromptWrites(), 1);
    assert.equal(fixture.memory.getContinuation()?.nonProgressRepromptUsed, true);
    assert.equal(fixture.memory.getCoverage()[0]?.state, 'pending');
  });

  it('durably consumes one no-progress re-prompt and then throws a typed stall', async () => {
    const fixture = await createEpisodeFixture(2);
    let sourceIssued = false;
    let prematureCalls = 0;
    await assert.rejects(
      () => runBgsmAgentEpisodes({
        sessionId: SESSION_ID,
        systemPrompt: 'System prompt.',
        continuationSystemPrompt: 'System prompt.',
        messages: initialMessages(),
        rawMessages: [initialMessages()[1]!],
        ordinaryTools: [fixture.largeRead],
        continuationTools: fixture.continuationTools,
        admissionHost: fixture.externalizer,
        admissionRuntime: fixture.admissionRuntime,
        provider: {
          async generate(input) {
            if (input.tools.some((tool) => tool.name === 'large_read') && !sourceIssued) {
              sourceIssued = true;
              return { toolCalls: [{ id: 'stall-source', name: 'large_read', arguments: {} }] };
            }
            if (prematureCalls === 1) {
              assert.match(
                input.messages[0]?.content ?? '',
                /only constrained re-prompt/u,
              );
            }
            prematureCalls += 1;
            return { content: 'Premature final prose.' };
          },
        },
        createContextContinuation: () => async (continuation) => ({
          kind: 'ready',
          messages: [...continuation.messages],
        }),
      }),
      (error: unknown) => error instanceof BgsmAgentArtifactCoverageStalledError
        && error.code === 'agent_artifact_coverage_stalled',
    );
    assert.equal(prematureCalls, 2);
    assert.equal(fixture.memory.getRepromptWrites(), 1);
    assert.equal(fixture.memory.getContinuation()?.nonProgressRepromptUsed, true);
    assert.doesNotMatch(
      JSON.stringify(fixture.memory.getContinuation()?.projectedMessages),
      /Premature final prose/u,
    );
    assert.equal(fixture.memory.getCoverage()[0]?.state, 'pending');
  });
});
