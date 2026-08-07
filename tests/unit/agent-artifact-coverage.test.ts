import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  AgentArtifactCoverageError,
  agentArtifactCoverageDirectives,
  applyAgentArtifactCoverageEvidence,
  createAgentArtifactCoverage,
  createAgentArtifactCoverageReceipt,
  digestAgentArtifactTouchedChunks,
  settleAgentArtifactCoverageIncomplete,
  validateAgentArtifactCoverageRecord,
  type AgentArtifactCoverageEvidence,
  type AgentArtifactTouchedChunk,
} from '@/bgsm-agent/artifact-coverage';

const ARTIFACT_DIGEST = 'a'.repeat(43);
const MANIFEST_DIGEST = 'm'.repeat(43);

async function pageEvidence(input: Readonly<{
  artifactId?: string;
  artifactBytes?: number;
  cursorSupplied?: boolean;
  inputCursor?: string | null;
  pageBytes: number;
  nextCursor: string | null;
  chunkIndex?: number;
}>): Promise<AgentArtifactCoverageEvidence> {
  const touchedChunks: AgentArtifactTouchedChunk[] = input.pageBytes === 0
    ? []
    : [{ index: input.chunkIndex ?? 0, byteLength: input.pageBytes, sha256: 'c'.repeat(43) }];
  return {
    schemaVersion: 1,
    artifactId: input.artifactId ?? 'artifact-one',
    artifactBytes: input.artifactBytes ?? 10,
    artifactSha256: ARTIFACT_DIGEST,
    integrityManifestSha256: MANIFEST_DIGEST,
    readKind: 'page',
    cursorSupplied: input.cursorSupplied ?? false,
    inputCursor: input.inputCursor ?? null,
    pageBytes: input.pageBytes,
    nextCursor: input.nextCursor,
    touchedChunks,
    touchedChunkCount: touchedChunks.length,
    touchedChunkBytes: input.pageBytes,
    touchedChunkDigest: await digestAgentArtifactTouchedChunks(touchedChunks),
    integrityVerified: true,
  };
}

async function coverage(artifactId = 'artifact-one', sourceToolCallId = 'call-one') {
  return createAgentArtifactCoverage({
    artifactId,
    sourceToolCallId,
    expectedBytes: 10,
    artifactSha256: ARTIFACT_DIGEST,
    integrityManifestSha256: MANIFEST_DIGEST,
  });
}

describe('Agent artifact exact coverage', () => {
  it('accepts only omitted first cursor followed by each exact issued cursor through null', async () => {
    const initial = await coverage();
    const first = await applyAgentArtifactCoverageEvidence(initial, await pageEvidence({
      pageBytes: 4,
      nextCursor: 'cursor-four',
    }));
    assert.equal(first.advanced, true);
    assert.equal(first.record.bytesDelivered, 4);
    assert.equal(first.record.expectedCursor, 'cursor-four');
    assert.notEqual(first.record.progressToken, initial.progressToken);

    const second = await applyAgentArtifactCoverageEvidence(first.record, await pageEvidence({
      cursorSupplied: true,
      inputCursor: 'cursor-four',
      pageBytes: 6,
      nextCursor: null,
      chunkIndex: 1,
    }));
    assert.equal(second.record.state, 'complete');
    assert.equal(second.record.bytesDelivered, 10);
    assert.equal(second.record.expectedCursor, null);
    assert.equal(createAgentArtifactCoverageReceipt(second.record, 100).byteLength, 10);
  });

  it('does not advance offset or search evidence', async () => {
    const initial = await coverage();
    const base = await pageEvidence({ pageBytes: 4, nextCursor: 'targeted-cursor' });
    for (const readKind of ['offset', 'search'] as const) {
      const evidence: AgentArtifactCoverageEvidence = {
        ...base,
        readKind,
        cursorSupplied: false,
        inputCursor: null,
        ...(readKind === 'search' ? { pageBytes: 0, nextCursor: null } : {}),
      };
      const result = await applyAgentArtifactCoverageEvidence(initial, evidence);
      assert.equal(result.advanced, false);
      assert.deepEqual(result.record, initial);
    }
  });

  it('rejects supplied first, stale, skipped, repeated, cross-artifact, and tampered evidence', async () => {
    const initial = await coverage();
    const suppliedFirst = await pageEvidence({
      cursorSupplied: true,
      inputCursor: 'cursor-zero',
      pageBytes: 4,
      nextCursor: 'cursor-four',
    });
    await assert.rejects(
      () => applyAgentArtifactCoverageEvidence(initial, suppliedFirst),
      AgentArtifactCoverageError,
    );

    const firstEvidence = await pageEvidence({ pageBytes: 4, nextCursor: 'cursor-four' });
    const first = (await applyAgentArtifactCoverageEvidence(initial, firstEvidence)).record;
    for (const inputCursor of ['cursor-zero', 'cursor-eight']) {
      const wrongCursor = await pageEvidence({
        cursorSupplied: true,
        inputCursor,
        pageBytes: 3,
        nextCursor: 'cursor-seven',
      });
      await assert.rejects(
        () => applyAgentArtifactCoverageEvidence(first, wrongCursor),
        AgentArtifactCoverageError,
      );
    }
    const repeated = await pageEvidence({
      cursorSupplied: true,
      inputCursor: 'cursor-four',
      pageBytes: 3,
      nextCursor: 'cursor-four',
    });
    await assert.rejects(
      () => applyAgentArtifactCoverageEvidence(first, repeated),
      AgentArtifactCoverageError,
    );
    const crossArtifact = await pageEvidence({
      artifactId: 'artifact-other',
      cursorSupplied: true,
      inputCursor: 'cursor-four',
      pageBytes: 3,
      nextCursor: 'cursor-seven',
    });
    await assert.rejects(
      () => applyAgentArtifactCoverageEvidence(first, crossArtifact),
      AgentArtifactCoverageError,
    );
    const tampered = {
      ...firstEvidence,
      cursorSupplied: true,
      inputCursor: 'cursor-four',
      touchedChunkDigest: `atc:v1:${await sha256Base64Url('tampered')}`,
    };
    await assert.rejects(
      () => applyAgentArtifactCoverageEvidence(first, tampered),
      AgentArtifactCoverageError,
    );
    assert.throws(
      () => validateAgentArtifactCoverageRecord({
        ...first,
        bytesDelivered: 1,
        expectedCursor: null,
      }),
      /impossible cursor or byte boundary/u,
    );
  });

  it('sorts opaque directives deterministically while preserving record admission order', async () => {
    const first = await coverage('artifact-one', 'call-one');
    const second = await coverage('artifact-two', 'call-two');
    assert.deepEqual(
      agentArtifactCoverageDirectives([first, second]).map((directive) => directive.reference),
      [first.coverageId, second.coverageId].sort(),
    );
    assert.deepEqual([first, second].map((record) => record.sourceToolCallId), ['call-one', 'call-two']);
    const incomplete = await settleAgentArtifactCoverageIncomplete(first, 'provider_error');
    assert.equal(incomplete.state, 'incomplete');
    assert.equal(incomplete.failureCode, 'provider_error');
    assert.throws(() => createAgentArtifactCoverageReceipt(incomplete, 100), AgentArtifactCoverageError);
  });
});
