import {
  okToolResult,
  serializedToolResultByteLength,
  ToolOutputTooLargeError,
} from '@/agent-harness';
import type {
  BgsmAgentArtifactReader,
  BgsmAgentToolResultArtifactDisposer,
  BgsmAgentToolResultArtifactStore,
} from '@/bgsm-agent/tool-result-externalizer';
import {
  AGENT_ARTIFACT_PAGE_MAX_BYTES,
  AgentStorageCapacityError,
  cleanupAgentToolCache,
  discardUnboundAgentArtifacts,
  findAgentArtifactTextForSession,
  loadAgentArtifactSliceForSession,
  storeAgentArtifact,
} from '@/storage/agent-storage-store';

export type BgsmAgentArtifactStorageAdapter = Readonly<{
  artifactStore: BgsmAgentToolResultArtifactStore;
  artifactDisposer: BgsmAgentToolResultArtifactDisposer;
  artifactReader: BgsmAgentArtifactReader;
}>;

export function createBgsmAgentArtifactStorageAdapter(
  options: Readonly<{ now?: () => number }> = {},
): BgsmAgentArtifactStorageAdapter {
  const now = options.now ?? Date.now;
  return Object.freeze({
    artifactStore: async (input) => {
      const store = () => storeAgentArtifact({ ...input, now });
      let record: Awaited<ReturnType<typeof store>>;
      try {
        record = await store();
      } catch (error) {
        if (!isRecoverableArtifactWriteError(error)) throw error;
        const cleanup = await cleanupAgentToolCache({ targetTotalBytes: 0, now });
        if (cleanup.freedBytes === 0) throw error;
        record = await store();
      }
      if (!record.integrity) {
        throw new TypeError('Ready Agent artifact is missing its integrity manifest.');
      }
      return {
        artifactId: record.id,
        byteLength: record.byteLength,
        contentType: record.contentType,
        artifactSha256: record.sha256,
        integrityManifestSha256: record.integrity.manifestSha256,
      };
    },
    artifactDisposer: async (input) => {
      await discardUnboundAgentArtifacts({
        artifactIds: [input.artifactId],
        sessionId: input.sessionId,
        turnAttemptId: input.turnAttemptId,
        now,
      });
    },
    artifactReader: async (input) => {
      input.signal?.throwIfAborted();
      const search = input.arguments.search
        ? await findAgentArtifactTextForSession({
            sessionId: input.sessionId,
            artifactId: input.arguments.artifactId,
            query: input.arguments.search.query,
            fromByte: input.arguments.search.fromByte,
            now,
          })
        : null;
      if (search?.matchByteOffset === null) {
        const result = {
          artifactId: search.artifactId,
          content: '',
          contentType: search.contentType,
          byteLength: 0,
          totalBytes: search.totalBytes,
          nextCursor: null,
          matchByteOffset: null,
        };
        assertReaderResultFits(result, input.maxSerializedResultBytes);
        return { result, evidence: search.evidence };
      }

      const emptyEnvelopeBytes = serializedToolResultByteLength(okToolResult({
        artifactId: input.arguments.artifactId,
        content: '',
        contentType: 'application/json',
        byteLength: 0,
        totalBytes: 0,
        nextCursor: null,
        ...(search ? { matchByteOffset: Number.MAX_SAFE_INTEGER } : {}),
      }));
      let contentBudget = Math.min(
        AGENT_ARTIFACT_PAGE_MAX_BYTES,
        Math.max(4, input.maxSerializedResultBytes - emptyEnvelopeBytes - 128),
      );
      const pageByteOffset = search?.matchByteOffset ?? input.arguments.byteOffset;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        input.signal?.throwIfAborted();
        const page = await loadAgentArtifactSliceForSession({
          sessionId: input.sessionId,
          artifactId: input.arguments.artifactId,
          ...(input.arguments.cursor === undefined
            ? {}
            : { cursor: input.arguments.cursor }),
          ...(pageByteOffset === undefined ? {} : { byteOffset: pageByteOffset }),
          maxContentBytes: contentBudget,
          now,
        });
        const { evidence: pageEvidence, ...modelPage } = page;
        const result = {
          ...modelPage,
          ...(search ? { matchByteOffset: search.matchByteOffset } : {}),
        };
        if (
          serializedToolResultByteLength(okToolResult(result))
          <= input.maxSerializedResultBytes
        ) {
          return {
            result,
            evidence: search?.evidence ?? pageEvidence,
          };
        }
        contentBudget = Math.floor(contentBudget / 2);
        if (contentBudget < 4) break;
      }
      throw new ToolOutputTooLargeError(
        'Artifact metadata cannot fit the current result budget.',
      );
    },
  });
}

function assertReaderResultFits(result: unknown, maxSerializedResultBytes: number): void {
  if (serializedToolResultByteLength(okToolResult(result)) > maxSerializedResultBytes) {
    throw new ToolOutputTooLargeError('Artifact metadata cannot fit the current result budget.');
  }
}

function isRecoverableArtifactWriteError(error: unknown): boolean {
  return error instanceof AgentStorageCapacityError
    || (!!error && typeof error === 'object'
      && (error as { name?: unknown }).name === 'QuotaExceededError');
}
