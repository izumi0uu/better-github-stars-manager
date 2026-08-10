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
  verifyAgentArtifactCoverageRecord,
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

  it('rejects stale progress tokens after any immutable artifact identity changes', async () => {
    const initial = await coverage();
    await verifyAgentArtifactCoverageRecord(initial);
    for (const patch of [
      { artifactId: 'artifact-other' },
      { sourceToolCallId: 'call-other' },
      { expectedBytes: initial.expectedBytes + 1 },
      { artifactSha256: 'z'.repeat(43) },
      { integrityManifestSha256: 'n'.repeat(43) },
    ]) {
      await assert.rejects(
        () => verifyAgentArtifactCoverageRecord({ ...initial, ...patch }),
        /deterministic identity is inconsistent/u,
      );
    }
  });

  it('admits locators only between pending pages without changing coverage', async () => {
    const initial = await coverage();
    const firstPage = await pageEvidence({ pageBytes: 4, nextCursor: 'targeted-cursor' });
    const locators: readonly AgentArtifactCoverageEvidence[] = [
      {
        ...firstPage,
        readKind: 'offset',
        cursorSupplied: false,
        inputCursor: null,
      },
      {
        ...firstPage,
        readKind: 'search',
        cursorSupplied: false,
        inputCursor: null,
        pageBytes: 0,
        nextCursor: null,
        touchedChunks: [],
        touchedChunkCount: 0,
        touchedChunkBytes: 0,
        touchedChunkDigest: await digestAgentArtifactTouchedChunks([]),
      },
    ];
    for (const locator of locators) {
      await assert.rejects(
        () => applyAgentArtifactCoverageEvidence(initial, locator),
        /issued pending artifact cursor/u,
      );
    }

    const pending = (await applyAgentArtifactCoverageEvidence(initial, firstPage)).record;
    const snapshot = {
      bytesDelivered: pending.bytesDelivered,
      cursorChainDigest: pending.cursorChainDigest,
      expectedCursor: pending.expectedCursor,
      progressToken: pending.progressToken,
      state: pending.state,
    };
    for (const locator of locators) {
      const result = await applyAgentArtifactCoverageEvidence(pending, locator);
      assert.equal(result.advanced, false);
      assert.deepEqual({
        bytesDelivered: result.record.bytesDelivered,
        cursorChainDigest: result.record.cursorChainDigest,
        expectedCursor: result.record.expectedCursor,
        progressToken: result.record.progressToken,
        state: result.record.state,
      }, snapshot);
    }

    const complete = (await applyAgentArtifactCoverageEvidence(pending, await pageEvidence({
      cursorSupplied: true,
      inputCursor: 'targeted-cursor',
      pageBytes: 6,
      nextCursor: null,
      chunkIndex: 1,
    }))).record;
    for (const locator of locators) {
      await assert.rejects(
        () => applyAgentArtifactCoverageEvidence(complete, locator),
        /Only pending artifact coverage/u,
      );
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
      ...await pageEvidence({
        cursorSupplied: true,
        inputCursor: 'cursor-four',
        pageBytes: 3,
        nextCursor: 'cursor-seven',
      }),
      touchedChunkDigest: `atc:v1:${await sha256Base64Url('tampered')}`,
    };
    await assert.rejects(
      () => applyAgentArtifactCoverageEvidence(first, tampered),
      /Touched chunk evidence is inconsistent/u,
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
