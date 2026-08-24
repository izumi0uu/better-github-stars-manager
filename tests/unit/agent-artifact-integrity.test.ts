import { describe, expect, it } from 'vitest';
import { sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  buildArtifactIntegrityManifest,
  sameArtifactIntegrity,
  verifyArtifactIntegrityManifest,
  verifyChunkDigests,
} from '@/storage/agent-artifact-integrity';
import type {
  AgentArtifactChunkRecord,
  AgentArtifactRecord,
} from '@/storage/agent-storage-model';

async function chunk(index: number, payload: string): Promise<AgentArtifactChunkRecord> {
  return {
    id: `artifact-one:${index}`,
    artifactId: 'artifact-one',
    index,
    byteLength: new TextEncoder().encode(payload).byteLength,
    sha256: await sha256Base64Url(payload),
    payload,
  };
}

describe('Agent artifact integrity', () => {
  it('builds and verifies a canonical chunk manifest', async () => {
    const chunks = [await chunk(0, 'hello'), await chunk(1, '😀')];
    const integrity = await buildArtifactIntegrityManifest(chunks);
    const artifact: AgentArtifactRecord = {
      id: 'artifact-one',
      schemaVersion: 2,
      sessionId: 'session-one',
      turnAttemptId: 'attempt-one',
      ownerMessageId: null,
      toolCallId: 'call-one',
      toolName: 'read_repository',
      storageClass: 'cache',
      state: 'ready',
      contentType: 'text/plain',
      encoding: 'utf8',
      sha256: await sha256Base64Url('hello😀'),
      integrity,
      byteLength: 9,
      chunkCount: 2,
      createdAt: 1,
      lastAccessedAt: 1,
      expiresAt: null,
    };

    await expect(verifyArtifactIntegrityManifest(artifact)).resolves.toBeUndefined();
    await expect(verifyChunkDigests(artifact.id, chunks)).resolves.toBeUndefined();

    const rebuilt = await buildArtifactIntegrityManifest(chunks);
    expect(sameArtifactIntegrity(integrity, rebuilt)).toBe(true);
    const changed = await buildArtifactIntegrityManifest([
      await chunk(0, 'hello!'),
      await chunk(1, '😀'),
    ]);
    expect(sameArtifactIntegrity(integrity, changed)).toBe(false);
  });

  it('rejects tampered manifest and chunk digests', async () => {
    const chunks = [await chunk(0, 'hello')];
    const integrity = await buildArtifactIntegrityManifest(chunks);
    const artifact = {
      id: 'artifact-one',
      integrity: { ...integrity, manifestSha256: await sha256Base64Url('tampered') },
    } as AgentArtifactRecord;

    await expect(verifyArtifactIntegrityManifest(artifact)).rejects.toThrow(
      'integrity manifest digest is invalid',
    );
    await expect(verifyChunkDigests(artifact.id, [{
      ...chunks[0]!,
      payload: 'changed',
    }])).rejects.toThrow('chunk digest does not match its payload');
  });
});
