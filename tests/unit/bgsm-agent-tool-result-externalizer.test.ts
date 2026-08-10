import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  errorToolResult,
  okToolResult,
} from '@/agent-harness';
import type {
  AgentRequiredBeforeFinalDirective,
} from '@/agent-harness';
import {
  BGSM_AGENT_ARTIFACT_READER_INSTRUCTION,
  createBgsmAgentArtifactEvidenceHandoff,
  createBgsmAgentToolResultExternalizer,
} from '@/bgsm-agent';
import type {
  AgentArtifactCoverageEvidence,
  BgsmAgentArtifactAdmissionAuthority,
  BgsmAgentToolResultArtifactStoreInput,
} from '@/bgsm-agent';

const encoder = new TextEncoder();
const directive = Object.freeze({
  reference: 'coverage:artifact',
  progressToken: 'progress:0',
  requiredBeforeFinal: true as const,
});

function allowance(maxSerializedBytes = 800) {
  return {
    maxSerializedBytes,
    contextRemainingTokens: 10_000,
    memoryRemainingBytes: 10_000,
  };
}

function assistantMessage(callId: string, toolName: string) {
  return {
    id: `assistant:${callId}`,
    role: 'agent' as const,
    content: '',
    createdAt: 1,
    toolCalls: [{ id: callId, name: toolName, arguments: {} }],
  };
}

function coverageEvidence(
  readKind: AgentArtifactCoverageEvidence['readKind'] = 'page',
): AgentArtifactCoverageEvidence {
  return {
    schemaVersion: 1,
    artifactId: 'artifact-reader',
    artifactBytes: 4,
    artifactSha256: 'a'.repeat(43),
    integrityManifestSha256: 'b'.repeat(43),
    readKind,
    cursorSupplied: false,
    inputCursor: null,
    pageBytes: readKind === 'page' ? 4 : 0,
    nextCursor: null,
    touchedChunks: [{ index: 0, byteLength: 4, sha256: 'c'.repeat(43) }],
    touchedChunkCount: 1,
    touchedChunkBytes: 4,
    touchedChunkDigest: `atc:v1:${'d'.repeat(43)}`,
    integrityVerified: true,
  };
}

function authority(overrides: Partial<BgsmAgentArtifactAdmissionAuthority> = {}) {
  const base: BgsmAgentArtifactAdmissionAuthority = {
    async startCoverage() {
      return { requiredBeforeFinal: [directive], admissionToken: 'start-token' };
    },
    async admitInspection(input) {
      return {
        requiredBeforeFinal: input.requiredBeforeFinal,
        admissionToken: 'read-token',
      };
    },
    async admitEnvelope() {},
  };
  return { ...base, ...overrides } satisfies BgsmAgentArtifactAdmissionAuthority;
}

function externalizer(input: Readonly<{
  storeInputs?: BgsmAgentToolResultArtifactStoreInput[];
  disposeIds?: string[];
  evidenceHandoff?: ReturnType<typeof createBgsmAgentArtifactEvidenceHandoff>;
  admissionAuthority?: BgsmAgentArtifactAdmissionAuthority;
}> = {}) {
  const storeInputs = input.storeInputs ?? [];
  const disposeIds = input.disposeIds ?? [];
  const evidenceHandoff = input.evidenceHandoff ?? createBgsmAgentArtifactEvidenceHandoff();
  return {
    evidenceHandoff,
    storeInputs,
    disposeIds,
    host: createBgsmAgentToolResultExternalizer({
      turnAttemptId: 'attempt:externalizer',
      evidenceHandoff,
      admissionAuthority: input.admissionAuthority ?? authority(),
      now: () => 1_000,
      artifactStore: async (storeInput) => {
        storeInputs.push(storeInput);
        return {
          artifactId: storeInput.artifactId,
          byteLength: encoder.encode(storeInput.content).byteLength,
          contentType: storeInput.contentType,
          artifactSha256: 'artifact-sha256',
          integrityManifestSha256: 'manifest-sha256',
        };
      },
      artifactDisposer: async ({ artifactId }) => {
        disposeIds.push(artifactId);
      },
    }),
  };
}

function admissionInput(input: Readonly<{
  callId: string;
  toolName: string;
  result: ReturnType<typeof okToolResult> | ReturnType<typeof errorToolResult>;
  risk?: 'read' | 'suggest' | 'write';
  requiredBeforeFinal?: readonly AgentRequiredBeforeFinalDirective[];
}>) {
  return {
    sessionId: 'session:externalizer',
    assistantMessage: assistantMessage(input.callId, input.toolName),
    toolCall: { id: input.callId, name: input.toolName, arguments: {} },
    result: input.result,
    risk: input.risk ?? 'read',
    allowance: allowance(),
    requiredBeforeFinal: input.requiredBeforeFinal ?? [],
  };
}

describe('Cubby tool-result externalizer', () => {
  it('stores deterministic cache input and returns the exact bounded pointer contract', async () => {
    const first = externalizer();
    const second = externalizer();
    const result = okToolResult({ rows: ['x'.repeat(2_000)] });

    const firstAdmission = await first.host.afterToolResult(admissionInput({
      callId: 'call:large-read',
      toolName: 'list_stars',
      result,
    }));
    const secondAdmission = await second.host.afterToolResult(admissionInput({
      callId: 'call:large-read',
      toolName: 'list_stars',
      result,
    }));

    assert.ok(firstAdmission);
    assert.ok(secondAdmission);
    assert.equal(first.storeInputs.length, 1);
    assert.equal(second.storeInputs.length, 1);
    assert.equal(first.storeInputs[0]?.artifactId, second.storeInputs[0]?.artifactId);
    assert.deepEqual(first.storeInputs[0], {
      artifactId: first.storeInputs[0]?.artifactId,
      sessionId: 'session:externalizer',
      turnAttemptId: 'attempt:externalizer',
      toolCallId: 'call:large-read',
      toolName: 'list_stars',
      storageClass: 'cache',
      content: JSON.stringify(result),
      contentType: 'application/json',
      expiresAt: 1_000 + 24 * 60 * 60 * 1_000,
    });
    assert.deepEqual(firstAdmission.opaqueReferences, [first.storeInputs[0]?.artifactId]);
    assert.deepEqual(firstAdmission.requiredBeforeFinal, [directive]);
    assert.deepEqual(firstAdmission.result, okToolResult({
      status: 'artifact_available',
      artifactId: first.storeInputs[0]?.artifactId,
      contentType: 'application/json',
      byteLength: encoder.encode(JSON.stringify(result)).byteLength,
      instruction: BGSM_AGENT_ARTIFACT_READER_INSTRUCTION,
    }));
  });

  it('keeps read evidence out of model data and consumes it exactly once on success', async () => {
    const handoff = createBgsmAgentArtifactEvidenceHandoff();
    let admittedEvidence: AgentArtifactCoverageEvidence | null = null;
    const currentEvidence = (): AgentArtifactCoverageEvidence | null => admittedEvidence;
    const fixture = externalizer({
      evidenceHandoff: handoff,
      admissionAuthority: authority({
        async admitInspection(input) {
          admittedEvidence = input.evidence;
          return { requiredBeforeFinal: [directive], admissionToken: 'inspection-token' };
        },
      }),
    });
    const modelResult = okToolResult({
      artifactId: 'artifact-reader',
      content: 'data',
      contentType: 'application/json',
      byteLength: 4,
      totalBytes: 4,
      nextCursor: null,
    });
    handoff.publish({
      sessionId: 'session:externalizer',
      toolCallId: 'call:reader',
      artifactId: 'artifact-reader',
      accessKind: 'page',
      evidence: coverageEvidence(),
    });

    const admitted = await fixture.host.afterToolResult(admissionInput({
      callId: 'call:reader',
      toolName: 'read_agent_artifact',
      result: modelResult,
    }));

    assert.ok(admitted);
    assert.deepEqual(admitted.result, modelResult);
    assert.deepEqual(admitted.opaqueReferences, ['artifact-reader']);
    assert.equal(admitted.retainOnNoProgress, undefined);
    assert.equal(currentEvidence()?.artifactId, 'artifact-reader');
    assert.doesNotMatch(JSON.stringify(admitted.result), new RegExp('a'.repeat(43), 'u'));
    await assert.rejects(
      () => fixture.host.afterToolResult(admissionInput({
        callId: 'call:reader',
        toolName: 'read_agent_artifact',
        result: modelResult,
      })),
      /call-scoped coverage evidence/u,
    );
  });

  it('clears failed-reader evidence and rejects evidence attached to write results', async () => {
    const fixture = externalizer();
    fixture.evidenceHandoff.publish({
      sessionId: 'session:externalizer',
      toolCallId: 'call:failed-reader',
      artifactId: 'artifact-reader',
      accessKind: 'search',
      evidence: coverageEvidence('search'),
    });
    const failed = await fixture.host.afterToolResult(admissionInput({
      callId: 'call:failed-reader',
      toolName: 'read_agent_artifact',
      result: errorToolResult('bounded_error', 'Bounded ordinary error.'),
    }));
    await assert.rejects(
      () => fixture.host.afterToolResult(admissionInput({
        callId: 'call:failed-required-reader',
        toolName: 'read_agent_artifact',
        result: errorToolResult('bounded_error', 'Bounded ordinary error.'),
        requiredBeforeFinal: [directive],
      })),
      /continuation read failed/u,
    );
    fixture.evidenceHandoff.publish({
      sessionId: 'session:externalizer',
      toolCallId: 'call:write',
      artifactId: 'artifact-reader',
      accessKind: 'offset',
      evidence: coverageEvidence('offset'),
    });
    await assert.rejects(
      () => fixture.host.afterToolResult(admissionInput({
        callId: 'call:write',
        toolName: 'assign_repo_tags',
        risk: 'write',
        result: okToolResult({ payload: 'x'.repeat(2_000) }),
      })),
      /evidence was published for a write tool call/u,
    );
    const ordinary = await fixture.host.afterToolResult(admissionInput({
      callId: 'call:ordinary-read',
      toolName: 'list_tags',
      result: okToolResult({ count: 1 }),
    }));

    assert.equal(failed, null);
    assert.equal(ordinary, null);
    assert.equal(fixture.storeInputs.length, 0);
    assert.equal(fixture.evidenceHandoff.consume({
      sessionId: 'session:externalizer',
      toolCallId: 'call:failed-reader',
    }), null);
    assert.equal(fixture.evidenceHandoff.consume({
      sessionId: 'session:externalizer',
      toolCallId: 'call:write',
    }), null);
  });

  it.each([
    ['page', undefined],
    ['search', true],
    ['offset', true],
  ] as const)('marks only token-backed %s reader evidence for no-progress retention', async (
    accessKind,
    expectedRetainOnNoProgress,
  ) => {
    const fixture = externalizer();
    const callId = `call:${accessKind}`;
    fixture.evidenceHandoff.publish({
      sessionId: 'session:externalizer',
      toolCallId: callId,
      artifactId: 'artifact-reader',
      accessKind,
      evidence: coverageEvidence(accessKind),
    });
    const result = okToolResult({
      artifactId: 'artifact-reader',
      content: 'data',
      contentType: 'application/json',
      byteLength: 4,
      totalBytes: 4,
      nextCursor: null,
      ...(accessKind === 'search' ? { matchByteOffset: 0 } : {}),
    });

    const admitted = await fixture.host.afterToolResult(admissionInput({
      callId,
      toolName: 'read_agent_artifact',
      result,
      requiredBeforeFinal: [directive],
    }));

    assert.ok(admitted);
    assert.deepEqual(admitted.requiredBeforeFinal, [directive]);
    assert.deepEqual(admitted.opaqueReferences, ['artifact-reader']);
    assert.equal(admitted.admissionToken, 'read-token');
    assert.equal(admitted.retainOnNoProgress, expectedRetainOnNoProgress);
  });

  it('does not request locator retention without an admission token', async () => {
    const fixture = externalizer({
      admissionAuthority: authority({
        async admitInspection(input) {
          return { requiredBeforeFinal: input.requiredBeforeFinal };
        },
      }),
    });
    fixture.evidenceHandoff.publish({
      sessionId: 'session:externalizer',
      toolCallId: 'call:no-token',
      artifactId: 'artifact-reader',
      accessKind: 'search',
      evidence: coverageEvidence('search'),
    });
    const admitted = await fixture.host.afterToolResult(admissionInput({
      callId: 'call:no-token',
      toolName: 'read_agent_artifact',
      result: okToolResult({
        artifactId: 'artifact-reader',
        content: 'data',
        contentType: 'application/json',
        byteLength: 4,
        totalBytes: 4,
        nextCursor: null,
        matchByteOffset: 0,
      }),
      requiredBeforeFinal: [directive],
    }));
    assert.ok(admitted);
    assert.equal(admitted.admissionToken, undefined);
    assert.equal(admitted.retainOnNoProgress, undefined);
  });

  it('delegates complete envelope checkpointing without owning durable mutation', async () => {
    let checkpoint: unknown;
    const fixture = externalizer({
      admissionAuthority: authority({
        async admitEnvelope(input) {
          checkpoint = input;
        },
      }),
    });
    const envelope = {
      admissionTokens: ['token'],
      requiredBeforeFinal: [directive],
      projectedMessages: [assistantMessage('call:checkpoint', 'list_tags')],
      canonicalRawMessages: [assistantMessage('call:checkpoint', 'list_tags')],
      envelopeKind: 'canonical_source' as const,
    };

    await fixture.host.admitEnvelope?.(envelope);

    assert.equal(checkpoint, envelope);
  });

  it('disposes a pointer once and immediately disposes storage when coverage start fails', async () => {

    const disposeIds: string[] = [];
    const fixture = externalizer({ disposeIds });
    const admitted = await fixture.host.afterToolResult(admissionInput({
      callId: 'call:dispose',
      toolName: 'list_tags',
      result: okToolResult({ rows: ['x'.repeat(2_000)] }),
    }));
    assert.ok(admitted?.dispose);
    await admitted.dispose();
    await admitted.dispose();
    assert.deepEqual(disposeIds, [fixture.storeInputs[0]?.artifactId]);

    const failedDisposeIds: string[] = [];
    const failed = externalizer({
      disposeIds: failedDisposeIds,
      admissionAuthority: authority({
        async startCoverage() {
          throw new Error('coverage unavailable');
        },
      }),
    });
    await assert.rejects(
      () => failed.host.afterToolResult(admissionInput({
        callId: 'call:coverage-failure',
        toolName: 'list_tags',
        result: okToolResult({ rows: ['x'.repeat(2_000)] }),
      })),
      /coverage unavailable/u,
    );
    assert.deepEqual(failedDisposeIds, [failed.storeInputs[0]?.artifactId]);
  });
});
