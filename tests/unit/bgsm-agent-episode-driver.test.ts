import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  MAX_TOOL_RESULT_BYTES,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@/agent-harness';
import {
  agentArtifactCoverageDirectives,
  applyAgentArtifactCoverageEvidence,
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
      const pending = coverage.find((record) => record.state === 'pending');
      if (!pending || pending.coverageId !== proposal.coverageId) {
        throw new Error('fixture coverage order mismatch');
      }
      const applied = await applyAgentArtifactCoverageEvidence(pending, proposal.evidence);
      coverage = coverage.map((record) => (
        record.coverageId === pending.coverageId ? applied.record : record
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
  const readArguments: Array<{ artifactId: string; cursor?: string }> = [];
  const continuationRegistry = createBgsmAgentArtifactContinuationToolRegistry({
    artifactEvidenceHandoff: evidenceHandoff,
    authorize: admissionRuntime.authorizeContinuationRead,
    artifactReader: async (input) => {
      if (!storedArtifact) throw new Error('fixture artifact was not stored');
      readArguments.push({ ...input.arguments });
      const index = input.arguments.cursor === undefined
        ? 0
        : Number(input.arguments.cursor.slice('cursor:'.length));
      const baseBytes = Math.floor(storedArtifact.byteLength / pageCount);
      const pageBytes = index === pageCount - 1
        ? storedArtifact.byteLength - baseBytes * (pageCount - 1)
        : baseBytes;
      const nextCursor = index === pageCount - 1 ? null : `cursor:${index + 1}`;
      const touchedChunks = [{ index, byteLength: pageBytes, sha256: 'c'.repeat(43) }];
      const evidence: AgentArtifactCoverageEvidence = {
        schemaVersion: 1,
        artifactId: storedArtifact.artifactId,
        artifactBytes: storedArtifact.byteLength,
        artifactSha256: ARTIFACT_SHA,
        integrityManifestSha256: MANIFEST_SHA,
        readKind: 'page',
        cursorSupplied: input.arguments.cursor !== undefined,
        inputCursor: input.arguments.cursor ?? null,
        pageBytes,
        nextCursor,
        touchedChunks,
        touchedChunkCount: 1,
        touchedChunkBytes: pageBytes,
        touchedChunkDigest: await digestAgentArtifactTouchedChunks(touchedChunks),
        integrityVerified: true,
      };
      return {
        result: {
          artifactId: storedArtifact.artifactId,
          content: 'p'.repeat(pageBytes),
          contentType: 'application/json',
          byteLength: pageBytes,
          totalBytes: storedArtifact.byteLength,
          nextCursor,
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

describe('BGSM Agent episode driver', () => {
  it('crosses eight pages, checkpoints a reduced projection, and admits one final answer', async () => {
    const fixture = await createEpisodeFixture(10);
    const events: AgentEvent[] = [];
    let sourceIssued = false;
    let readerCalls = 0;
    let reductions = 0;
    const result = await runBgsmAgentEpisodes({
      sessionId: SESSION_ID,
      systemPrompt: 'System prompt.',
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
            sourceIssued = true;
            return {
              toolCalls: [{ id: 'source-call', name: 'large_read', arguments: {} }],
            };
          }
          if (toolNames.length === 1 && toolNames[0] === 'read_agent_artifact') {
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

  it('durably consumes one no-progress re-prompt and then throws a typed stall', async () => {
    const fixture = await createEpisodeFixture(2);
    let sourceIssued = false;
    let prematureCalls = 0;
    await assert.rejects(
      () => runBgsmAgentEpisodes({
        sessionId: SESSION_ID,
        systemPrompt: 'System prompt.',
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
