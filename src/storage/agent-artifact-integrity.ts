import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  AGENT_ARTIFACT_INTEGRITY_SCHEMA_VERSION,
  AgentArtifactCorruptionError,
  type AgentArtifactChunkRecord,
  type AgentArtifactIntegrityManifest,
  type AgentArtifactRecord,
} from './agent-storage-model';

export function sameArtifactIntegrity(
  left: AgentArtifactIntegrityManifest | null,
  right: AgentArtifactIntegrityManifest | null,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function buildArtifactIntegrityManifest(
  chunks: readonly AgentArtifactChunkRecord[],
): Promise<AgentArtifactIntegrityManifest> {
  const body = {
    schemaVersion: AGENT_ARTIFACT_INTEGRITY_SCHEMA_VERSION,
    chunks: chunks.map((chunk) => ({
      byteLength: chunk.byteLength,
      sha256: chunk.sha256,
    })),
  } as const;
  return {
    ...body,
    manifestSha256: await sha256Base64Url(canonicalJson(body)),
  };
}

export function requireArtifactIntegrity(
  artifact: AgentArtifactRecord,
): AgentArtifactIntegrityManifest {
  if (!artifact.integrity) {
    throw new AgentArtifactCorruptionError(
      artifact.id,
      'ready artifact has no integrity manifest',
    );
  }
  return artifact.integrity;
}

export async function verifyArtifactIntegrityManifest(
  artifact: AgentArtifactRecord,
): Promise<void> {
  const integrity = requireArtifactIntegrity(artifact);
  const digest = await sha256Base64Url(canonicalJson({
    schemaVersion: integrity.schemaVersion,
    chunks: integrity.chunks,
  }));
  if (digest !== integrity.manifestSha256) {
    throw new AgentArtifactCorruptionError(artifact.id, 'integrity manifest digest is invalid');
  }
}

export async function verifyChunkDigests(
  artifactId: string,
  chunks: readonly AgentArtifactChunkRecord[],
): Promise<void> {
  const digests = await Promise.all(chunks.map((chunk) => sha256Base64Url(chunk.payload)));
  if (chunks.some((chunk, index) => chunk.sha256 !== digests[index])) {
    throw new AgentArtifactCorruptionError(artifactId, 'chunk digest does not match its payload');
  }
}
