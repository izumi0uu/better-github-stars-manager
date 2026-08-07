import {
  okToolResult,
  serializedToolResultByteLength,
} from '@/agent-harness';
import type {
  AgentMessage,
  AgentRequiredBeforeFinalDirective,
  AgentToolResultAdmissionHost,
  ToolResult,
} from '@/agent-harness';
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import { validateAgentArtifactCoverageEvidence } from './artifact-coverage';
import type {
  AgentArtifactCoverageEvidence,
  AgentArtifactReadKind,
} from './artifact-coverage';

export const BGSM_AGENT_ARTIFACT_POINTER_STATUS = 'artifact_available' as const;
export const BGSM_AGENT_ARTIFACT_READER_INSTRUCTION =
  'Call read_agent_artifact with this exact artifactId. For exhaustive traversal, omit cursor on the first page, then reuse each returned nextCursor exactly until null. byteOffset and search are targeted reads only and do not advance exhaustive coverage.';
export const BGSM_AGENT_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const BGSM_AGENT_ARTIFACT_SEARCH_MAX_QUERY_BYTES = 512;

const TOOL_RESULT_ARTIFACT_ID_PREFIX = 'tool-result:v1:';
const TOOL_RESULT_ARTIFACT_CONTENT_TYPE = 'application/json';
const TOOL_RESULT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_EVIDENCE_HANDOFFS = 64;
const MAX_HANDOFF_IDENTIFIER_BYTES = 512;
const encoder = new TextEncoder();

export type BgsmAgentArtifactReadArgs = Readonly<{
  artifactId: string;
  cursor?: string;
  byteOffset?: number;
  search?: Readonly<{ query: string; fromByte: number }>;
}>;

export type BgsmAgentArtifactReadResult = Readonly<{
  artifactId: string;
  content: string;
  contentType: string;
  byteLength: number;
  totalBytes: number;
  nextCursor: string | null;
  matchByteOffset?: number | null;
}>;

export type BgsmAgentArtifactAccessKind = AgentArtifactReadKind;

export type BgsmAgentArtifactReader = (
  input: Readonly<{
    sessionId: string;
    toolCallId: string;
    arguments: BgsmAgentArtifactReadArgs;
    maxSerializedResultBytes: number;
    signal?: AbortSignal;
  }>,
) => Promise<Readonly<{
  result: BgsmAgentArtifactReadResult;
  evidence: AgentArtifactCoverageEvidence;
}>>;

export type BgsmAgentArtifactReadAuthorization = (
  input: Readonly<{
    sessionId: string;
    toolCallId: string;
    arguments: BgsmAgentArtifactReadArgs;
  }>,
) => boolean | Promise<boolean>;

export type BgsmAgentArtifactEvidenceHandoff = Readonly<{
  publish(input: Readonly<{
    sessionId: string;
    toolCallId: string;
    artifactId: string;
    accessKind: BgsmAgentArtifactAccessKind;
    evidence: AgentArtifactCoverageEvidence;
  }>): void;
  consume(input: Readonly<{
    sessionId: string;
    toolCallId: string;
  }>): BgsmAgentArtifactEvidenceHandoffEntry | null;
  clear(input: Readonly<{
    sessionId: string;
    toolCallId: string;
  }>): void;
}>;

export type BgsmAgentArtifactEvidenceHandoffEntry = Readonly<{
  artifactId: string;
  accessKind: BgsmAgentArtifactAccessKind;
  evidence: AgentArtifactCoverageEvidence;
}>;

export function createBgsmAgentArtifactEvidenceHandoff(
  maximumEntries = MAX_EVIDENCE_HANDOFFS,
): BgsmAgentArtifactEvidenceHandoff {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new RangeError('Artifact evidence handoff capacity must be a positive safe integer.');
  }
  const entries = new Map<string, BgsmAgentArtifactEvidenceHandoffEntry>();
  return Object.freeze({
    publish(input) {
      const key = evidenceHandoffKey(input.sessionId, input.toolCallId);
      validateAgentArtifactCoverageEvidence(input.evidence);
      if (
        input.artifactId !== input.evidence.artifactId
        || input.accessKind !== input.evidence.readKind
      ) throw new TypeError('Artifact evidence handoff identity does not match evidence.');
      if (entries.has(key)) {
        throw new TypeError('Artifact evidence already exists for this tool call.');
      }
      if (entries.size >= maximumEntries) {
        throw new RangeError('Artifact evidence handoff capacity was exceeded.');
      }
      requireBoundedIdentifier(input.artifactId, 'Artifact evidence artifact ID');
      entries.set(key, Object.freeze({
        artifactId: input.artifactId,
        accessKind: input.accessKind,
        evidence: immutableCoverageEvidence(input.evidence),
      }));
    },
    consume(input) {
      const key = evidenceHandoffKey(input.sessionId, input.toolCallId);
      const entry = entries.get(key) ?? null;
      entries.delete(key);
      return entry;
    },
    clear(input) {
      entries.delete(evidenceHandoffKey(input.sessionId, input.toolCallId));
    },
  });
}

export type BgsmAgentToolResultArtifactStoreInput = Readonly<{
  artifactId: string;
  sessionId: string;
  turnAttemptId: string;
  toolCallId: string;
  toolName: string;
  storageClass: 'cache';
  content: string;
  contentType: 'application/json';
  expiresAt: number;
}>;

export type BgsmAgentStoredToolResultArtifact = Readonly<{
  artifactId: string;
  byteLength: number;
  contentType: string;
  artifactSha256: string;
  integrityManifestSha256: string;
}>;

export type BgsmAgentToolResultArtifactStore = (
  input: BgsmAgentToolResultArtifactStoreInput,
) => Promise<BgsmAgentStoredToolResultArtifact>;

export type BgsmAgentToolResultArtifactDisposer = (
  input: Readonly<{
    artifactId: string;
    sessionId: string;
    turnAttemptId: string;
  }>,
) => Promise<void>;

export type BgsmAgentArtifactAdmissionDecision = Readonly<{
  requiredBeforeFinal: readonly AgentRequiredBeforeFinalDirective[];
  admissionToken?: unknown;
}>;

/**
 * Application-owned proposal/checkpoint boundary. The first two callbacks are
 * pure proposal builders; only admitEnvelope may delegate to the background
 * attempt coordinator that owns durable coverage writes.
 */
export type BgsmAgentArtifactAdmissionAuthority = Readonly<{
  startCoverage(input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
    sourceToolCallId: string;
    toolName: string;
    artifact: BgsmAgentStoredToolResultArtifact;
    requiredBeforeFinal: readonly AgentRequiredBeforeFinalDirective[];
  }>): Promise<BgsmAgentArtifactAdmissionDecision>;
  admitInspection(input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
    sourceToolCallId: string;
    artifactId: string;
    accessKind: BgsmAgentArtifactAccessKind;
    evidence: AgentArtifactCoverageEvidence;
    requiredBeforeFinal: readonly AgentRequiredBeforeFinalDirective[];
  }>): Promise<BgsmAgentArtifactAdmissionDecision>;
  admitEnvelope(input: Readonly<{
    admissionTokens: readonly unknown[];
    requiredBeforeFinal: readonly AgentRequiredBeforeFinalDirective[];
    projectedMessages: readonly AgentMessage[];
    canonicalRawMessages: readonly AgentMessage[];
    envelopeKind: 'canonical_source' | 'internal_continuation';
  }>): Promise<void>;
}>;

/**
 * Creates the BGSM implementation of the generic harness admission host.
 * Storage and durable attempt authority are constructor dependencies so this
 * module never opens IndexedDB or mutates an attempt row itself.
 */
export function createBgsmAgentToolResultExternalizer(input: Readonly<{
  turnAttemptId: string;
  artifactStore: BgsmAgentToolResultArtifactStore;
  artifactDisposer: BgsmAgentToolResultArtifactDisposer;
  evidenceHandoff: BgsmAgentArtifactEvidenceHandoff;
  admissionAuthority: BgsmAgentArtifactAdmissionAuthority;
  now?: () => number;
}>): AgentToolResultAdmissionHost {
  requireBoundedIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  const now = input.now ?? Date.now;

  return Object.freeze({
    async afterToolResult(admissionInput) {
      const evidence = input.evidenceHandoff.consume({
        sessionId: admissionInput.sessionId,
        toolCallId: admissionInput.toolCall.id,
      });

      if (admissionInput.risk === 'write') return null;
      if (admissionInput.toolCall.name === 'read_agent_artifact') {
        if (!admissionInput.result.ok) {
          if (admissionInput.requiredBeforeFinal.length > 0) {
            throw new TypeError('Required artifact continuation read failed.');
          }
          return null;
        }
        if (!evidence) {
          throw new TypeError('Successful artifact reads require call-scoped coverage evidence.');
        }
        const decision = await input.admissionAuthority.admitInspection({
          sessionId: admissionInput.sessionId,
          turnAttemptId: input.turnAttemptId,
          sourceToolCallId: admissionInput.toolCall.id,
          artifactId: evidence.artifactId,
          accessKind: evidence.accessKind,
          evidence: evidence.evidence,
          requiredBeforeFinal: admissionInput.requiredBeforeFinal,
        });
        return {
          result: admissionInput.result,
          opaqueReferences: [evidence.artifactId],
          requiredBeforeFinal: decision.requiredBeforeFinal,
          ...(decision.admissionToken === undefined
            ? {}
            : { admissionToken: decision.admissionToken }),
        };
      }

      if (evidence) {
        throw new TypeError('Artifact evidence was published for a non-reader tool call.');
      }
      if (!admissionInput.result.ok) return null;
      if (
        serializedToolResultByteLength(admissionInput.result)
        <= admissionInput.allowance.maxSerializedBytes
      ) return null;

      const content = serializeSuccessfulToolResult(admissionInput.result);
      const artifactId = await createToolResultArtifactId({
        sessionId: admissionInput.sessionId,
        turnAttemptId: input.turnAttemptId,
        toolName: admissionInput.toolCall.name,
        toolCallId: admissionInput.toolCall.id,
      });
      const stored = await input.artifactStore({
        artifactId,
        sessionId: admissionInput.sessionId,
        turnAttemptId: input.turnAttemptId,
        toolCallId: admissionInput.toolCall.id,
        toolName: admissionInput.toolCall.name,
        storageClass: 'cache',
        content,
        contentType: TOOL_RESULT_ARTIFACT_CONTENT_TYPE,
        expiresAt: now() + TOOL_RESULT_ARTIFACT_TTL_MS,
      });
      const dispose = onceBestEffort(async () => {
        await input.artifactDisposer({
          artifactId: stored.artifactId,
          sessionId: admissionInput.sessionId,
          turnAttemptId: input.turnAttemptId,
        });
      });

      try {
        validateStoredArtifact(stored, artifactId, content);
        const decision = await input.admissionAuthority.startCoverage({
          sessionId: admissionInput.sessionId,
          turnAttemptId: input.turnAttemptId,
          sourceToolCallId: admissionInput.toolCall.id,
          toolName: admissionInput.toolCall.name,
          artifact: stored,
          requiredBeforeFinal: admissionInput.requiredBeforeFinal,
        });
        if (decision.requiredBeforeFinal.length === 0) {
          throw new TypeError('Externalized results require coverage before finalization.');
        }
        return {
          result: artifactPointerResult(stored),
          opaqueReferences: [stored.artifactId],
          requiredBeforeFinal: decision.requiredBeforeFinal,
          ...(decision.admissionToken === undefined
            ? {}
            : { admissionToken: decision.admissionToken }),
          dispose,
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
    async admitEnvelope(envelopeInput) {
      await input.admissionAuthority.admitEnvelope(envelopeInput);
    },
  });
}

function artifactPointerResult(artifact: BgsmAgentStoredToolResultArtifact): ToolResult {
  return okToolResult({
    status: BGSM_AGENT_ARTIFACT_POINTER_STATUS,
    artifactId: artifact.artifactId,
    contentType: artifact.contentType,
    byteLength: artifact.byteLength,
    instruction: BGSM_AGENT_ARTIFACT_READER_INSTRUCTION,
  });
}

async function createToolResultArtifactId(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  toolName: string;
  toolCallId: string;
}>): Promise<string> {
  return `${TOOL_RESULT_ARTIFACT_ID_PREFIX}${await sha256Base64Url(canonicalJson(input))}`;
}

function serializeSuccessfulToolResult(result: ToolResult): string {
  if (!result.ok) throw new TypeError('Only successful tool results can be externalized.');
  const serialized = JSON.stringify(result);
  if (typeof serialized !== 'string') {
    throw new TypeError('Tool result did not serialize to JSON.');
  }
  return serialized;
}

function validateStoredArtifact(
  artifact: BgsmAgentStoredToolResultArtifact,
  expectedArtifactId: string,
  content: string,
): void {
  requireBoundedIdentifier(artifact.artifactId, 'Stored artifact ID');
  if (artifact.artifactId !== expectedArtifactId) {
    throw new TypeError('Artifact storage changed the deterministic artifact ID.');
  }
  const expectedBytes = encoder.encode(content).byteLength;
  if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength !== expectedBytes) {
    throw new TypeError('Artifact storage changed the serialized byte length.');
  }
  if (artifact.contentType !== TOOL_RESULT_ARTIFACT_CONTENT_TYPE) {
    throw new TypeError('Artifact storage changed the serialized content type.');
  }
  requireBoundedIdentifier(artifact.artifactSha256, 'Stored artifact digest');
  requireBoundedIdentifier(
    artifact.integrityManifestSha256,
    'Stored artifact integrity-manifest digest',
  );
}

function accessKindForArguments(args: BgsmAgentArtifactReadArgs): BgsmAgentArtifactAccessKind {
  if (args.search) return 'search';
  if (args.byteOffset !== undefined) return 'offset';
  return 'page';
}

export function publishBgsmAgentArtifactReadEvidence(input: Readonly<{
  handoff: BgsmAgentArtifactEvidenceHandoff;
  sessionId: string;
  toolCallId: string;
  arguments: BgsmAgentArtifactReadArgs;
  result: BgsmAgentArtifactReadResult;
  evidence: AgentArtifactCoverageEvidence;
}>): void {
  validateAgentArtifactCoverageEvidence(input.evidence);
  const accessKind = accessKindForArguments(input.arguments);
  if (
    input.result.artifactId !== input.arguments.artifactId
    || input.evidence.artifactId !== input.result.artifactId
    || input.evidence.artifactBytes !== input.result.totalBytes
    || input.evidence.readKind !== accessKind
  ) throw new TypeError('Artifact reader returned evidence for another read.');
  if (accessKind === 'page') {
    const cursorSupplied = input.arguments.cursor !== undefined;
    if (
      input.evidence.cursorSupplied !== cursorSupplied
      || input.evidence.inputCursor !== (input.arguments.cursor ?? null)
      || input.evidence.pageBytes !== input.result.byteLength
      || input.evidence.nextCursor !== input.result.nextCursor
    ) throw new TypeError('Artifact reader returned inconsistent page evidence.');
  }
  input.handoff.publish({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    artifactId: input.result.artifactId,
    accessKind,
    evidence: input.evidence,
  });
}

function immutableCoverageEvidence(
  evidence: AgentArtifactCoverageEvidence,
): AgentArtifactCoverageEvidence {
  return Object.freeze({
    ...evidence,
    touchedChunks: Object.freeze(evidence.touchedChunks.map((chunk) => Object.freeze({
      ...chunk,
    }))),
  });
}

function evidenceHandoffKey(sessionId: string, toolCallId: string): string {
  requireBoundedIdentifier(sessionId, 'Artifact evidence session ID');
  requireBoundedIdentifier(toolCallId, 'Artifact evidence tool-call ID');
  return `${sessionId.length}:${sessionId}${toolCallId}`;
}

function requireBoundedIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || encoder.encode(value).byteLength > MAX_HANDOFF_IDENTIFIER_BYTES
  ) throw new TypeError(`${label} must be a bounded identifier.`);
}

function onceBestEffort(dispose: () => Promise<void>): () => Promise<void> {
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    try {
      await dispose();
    } catch {
      // Admission cleanup cannot replace the bounded result chosen by the harness.
    }
  };
}
