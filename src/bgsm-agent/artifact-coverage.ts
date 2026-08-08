import type {
  AgentMessage,
  AgentRequiredBeforeFinalDirective,
} from '@/agent-harness';
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import type { BgsmAgentSessionMessage } from './session';

export const AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION = 1 as const;
export const AGENT_ARTIFACT_COVERAGE_MAX_RECORDS = 64;
export const AGENT_ARTIFACT_COVERAGE_MAX_TOUCHED_CHUNKS = 2_048;
export const AGENT_ARTIFACT_CONTINUATION_MAX_BYTES = 8 * 1024 * 1024;

const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const COVERAGE_ID_PATTERN = /^aac:v1:[A-Za-z0-9_-]{43}$/u;
const CHAIN_DIGEST_PATTERN = /^ach:v1:[A-Za-z0-9_-]{43}$/u;
const PROGRESS_TOKEN_PATTERN = /^acp:v1:[A-Za-z0-9_-]{43}$/u;
const TOUCHED_CHUNK_DIGEST_PATTERN = /^atc:v1:[A-Za-z0-9_-]{43}$/u;
const TEXT_ENCODER = new TextEncoder();

export type AgentArtifactCoverageState = 'pending' | 'complete' | 'incomplete';
export type AgentArtifactReadKind = 'page' | 'offset' | 'search';

export type AgentArtifactCoverageRecord = Readonly<{
  schemaVersion: typeof AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION;
  coverageId: string;
  artifactId: string;
  sourceToolCallId: string;
  expectedBytes: number;
  artifactSha256: string;
  integrityManifestSha256: string;
  expectedCursor: string | null;
  bytesDelivered: number;
  cursorChainDigest: string;
  progressToken: string;
  state: AgentArtifactCoverageState;
  failureCode: string | null;
}>;

export type AgentArtifactCoverageReceipt = Readonly<{
  schemaVersion: typeof AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION;
  coverageId: string;
  artifactId: string;
  sourceToolCallId: string;
  byteLength: number;
  artifactSha256: string;
  integrityManifestSha256: string;
  cursorChainDigest: string;
  completedAt: number;
}>;

/**
 * Bounded, provider-invisible evidence emitted by a verified artifact read.
 * It contains immutable metadata and a digest of touched manifest entries,
 * never artifact payload text.
 */
export type AgentArtifactCoverageEvidence = Readonly<{
  schemaVersion: typeof AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION;
  artifactId: string;
  artifactBytes: number;
  artifactSha256: string;
  integrityManifestSha256: string;
  readKind: AgentArtifactReadKind;
  cursorSupplied: boolean;
  inputCursor: string | null;
  pageBytes: number;
  nextCursor: string | null;
  touchedChunks: readonly AgentArtifactTouchedChunk[];
  touchedChunkCount: number;
  touchedChunkBytes: number;
  touchedChunkDigest: string;
  integrityVerified: true;
}>;

export type AgentArtifactContinuationCheckpoint = Readonly<{
  schemaVersion: typeof AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION;
  projectedMessages: readonly AgentMessage[];
  canonicalRawMessages: readonly BgsmAgentSessionMessage[];
  directives: readonly AgentRequiredBeforeFinalDirective[];
  nonProgressRepromptUsed: boolean;
  updatedAt: number;
}>;

export type AgentArtifactTouchedChunk = Readonly<{
  index: number;
  byteLength: number;
  sha256: string;
}>;

export class AgentArtifactCoverageError extends Error {
  readonly code = 'agent_artifact_coverage_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'AgentArtifactCoverageError';
  }
}

export async function createAgentArtifactCoverage(input: Readonly<{
  artifactId: string;
  sourceToolCallId: string;
  expectedBytes: number;
  artifactSha256: string;
  integrityManifestSha256: string;
}>): Promise<AgentArtifactCoverageRecord> {
  assertIdentifier(input.artifactId, 'Agent artifact ID');
  assertIdentifier(input.sourceToolCallId, 'Agent artifact source tool call ID');
  assertNonnegativeSafeInteger(input.expectedBytes, 'Agent artifact expected bytes');
  assertDigest(input.artifactSha256, 'Agent artifact digest');
  assertDigest(input.integrityManifestSha256, 'Agent artifact manifest digest');
  const coverageId = await agentArtifactCoverageId(input.artifactId, input.sourceToolCallId);
  const cursorChainDigest = `ach:v1:${await sha256Base64Url(canonicalJson({
    schemaVersion: AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION,
    coverageId,
    artifactId: input.artifactId,
    sourceToolCallId: input.sourceToolCallId,
    expectedBytes: input.expectedBytes,
    artifactSha256: input.artifactSha256,
    integrityManifestSha256: input.integrityManifestSha256,
  }))}`;
  const initial = {
    schemaVersion: AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION,
    coverageId,
    artifactId: input.artifactId,
    sourceToolCallId: input.sourceToolCallId,
    expectedBytes: input.expectedBytes,
    artifactSha256: input.artifactSha256,
    integrityManifestSha256: input.integrityManifestSha256,
    expectedCursor: null,
    bytesDelivered: 0,
    cursorChainDigest,
    progressToken: '',
    state: 'pending' as const,
    failureCode: null,
  };
  const record = {
    ...initial,
    progressToken: await agentArtifactCoverageProgressToken(initial),
  };
  validateAgentArtifactCoverageRecord(record);
  return record;
}

export async function agentArtifactCoverageId(
  artifactId: string,
  sourceToolCallId: string,
): Promise<string> {
  assertIdentifier(artifactId, 'Agent artifact ID');
  assertIdentifier(sourceToolCallId, 'Agent artifact source tool call ID');
  return `aac:v1:${await sha256Base64Url(canonicalJson([
    AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION,
    artifactId,
    sourceToolCallId,
  ]))}`;
}

export async function agentArtifactCoverageProgressToken(
  record: Omit<AgentArtifactCoverageRecord, 'progressToken'>,
): Promise<string> {
  return `acp:v1:${await sha256Base64Url(canonicalJson({
    coverageId: record.coverageId,
    expectedCursor: record.expectedCursor,
    bytesDelivered: record.bytesDelivered,
    cursorChainDigest: record.cursorChainDigest,
    state: record.state,
    failureCode: record.failureCode,
  }))}`;
}

export async function verifyAgentArtifactCoverageRecord(
  record: AgentArtifactCoverageRecord,
): Promise<void> {
  validateAgentArtifactCoverageRecord(record);
  const { progressToken: _progressToken, ...withoutToken } = record;
  const [coverageId, progressToken] = await Promise.all([
    agentArtifactCoverageId(record.artifactId, record.sourceToolCallId),
    agentArtifactCoverageProgressToken(withoutToken),
  ]);
  if (record.coverageId !== coverageId || record.progressToken !== progressToken) {
    throw new AgentArtifactCoverageError('Artifact coverage deterministic identity is inconsistent.');
  }
}

export async function digestAgentArtifactTouchedChunks(
  chunks: readonly AgentArtifactTouchedChunk[],
): Promise<string> {
  if (!Array.isArray(chunks) || chunks.length > AGENT_ARTIFACT_COVERAGE_MAX_TOUCHED_CHUNKS) {
    throw new AgentArtifactCoverageError('Touched chunk evidence is not bounded.');
  }
  let previousIndex = -1;
  for (const chunk of chunks) {
    assertExactKeys(chunk, ['byteLength', 'index', 'sha256'], 'Touched chunk evidence');
    assertNonnegativeSafeInteger(chunk.index, 'Touched chunk index');
    assertPositiveSafeInteger(chunk.byteLength, 'Touched chunk bytes');
    assertDigest(chunk.sha256, 'Touched chunk digest');
    if (chunk.index <= previousIndex) {
      throw new AgentArtifactCoverageError('Touched chunk evidence must be strictly ordered.');
    }
    previousIndex = chunk.index;
  }
  return `atc:v1:${await sha256Base64Url(canonicalJson(chunks))}`;
}

export async function applyAgentArtifactCoverageEvidence(
  current: AgentArtifactCoverageRecord,
  evidence: AgentArtifactCoverageEvidence,
): Promise<Readonly<{ record: AgentArtifactCoverageRecord; advanced: boolean }>> {
  validateAgentArtifactCoverageRecord(current);
  validateAgentArtifactCoverageEvidence(evidence);
  if (current.state !== 'pending') {
    throw new AgentArtifactCoverageError('Only pending artifact coverage can accept evidence.');
  }
  assertStableArtifactEvidence(current, evidence);
  const touchedChunkBytes = evidence.touchedChunks.reduce(
    (total, chunk) => addSafe(total, chunk.byteLength, 'Agent artifact touched chunk bytes'),
    0,
  );
  if (
    evidence.touchedChunks.length !== evidence.touchedChunkCount
    || touchedChunkBytes !== evidence.touchedChunkBytes
    || await digestAgentArtifactTouchedChunks(evidence.touchedChunks) !== evidence.touchedChunkDigest
  ) throw new AgentArtifactCoverageError('Touched chunk evidence is inconsistent.');
  if (evidence.readKind !== 'page') {
    if (current.bytesDelivered === 0 || current.expectedCursor === null) {
      throw new AgentArtifactCoverageError('Locating reads require an issued pending artifact cursor.');
    }
    return { record: current, advanced: false };
  }

  const firstPage = current.bytesDelivered === 0;
  if (firstPage) {
    if (evidence.cursorSupplied || evidence.inputCursor !== null) {
      throw new AgentArtifactCoverageError('The first exhaustive artifact page must omit its cursor.');
    }
  } else if (
    !evidence.cursorSupplied
    || current.expectedCursor === null
    || evidence.inputCursor !== current.expectedCursor
  ) {
    throw new AgentArtifactCoverageError('Artifact coverage did not consume the exact issued cursor.');
  }
  if (current.expectedBytes === 0) {
    if (!firstPage || evidence.pageBytes !== 0 || evidence.nextCursor !== null) {
      throw new AgentArtifactCoverageError('Empty artifact coverage must complete with one empty first page.');
    }
  } else if (evidence.pageBytes <= 0) {
    throw new AgentArtifactCoverageError('An exhaustive artifact page must deliver bytes.');
  }
  if (evidence.touchedChunkBytes < evidence.pageBytes) {
    throw new AgentArtifactCoverageError('Touched chunk evidence does not cover the delivered page.');
  }
  const bytesDelivered = addSafe(current.bytesDelivered, evidence.pageBytes, 'Agent artifact delivered bytes');
  if (bytesDelivered > current.expectedBytes) {
    throw new AgentArtifactCoverageError('Artifact coverage delivered more than the immutable artifact size.');
  }
  if (evidence.nextCursor !== null && evidence.nextCursor === evidence.inputCursor) {
    throw new AgentArtifactCoverageError('Artifact coverage returned a repeated cursor.');
  }
  if (evidence.nextCursor === null && bytesDelivered !== current.expectedBytes) {
    throw new AgentArtifactCoverageError('Artifact coverage ended before every byte was delivered.');
  }
  if (evidence.nextCursor !== null && bytesDelivered === current.expectedBytes) {
    throw new AgentArtifactCoverageError('Artifact coverage issued a cursor after every byte was delivered.');
  }

  const cursorChainDigest = `ach:v1:${await sha256Base64Url(canonicalJson({
    previous: current.cursorChainDigest,
    coverageId: current.coverageId,
    inputCursor: evidence.inputCursor,
    nextCursor: evidence.nextCursor,
    pageBytes: evidence.pageBytes,
    totalBytes: evidence.artifactBytes,
    touchedChunkDigest: evidence.touchedChunkDigest,
  }))}`;
  const state = evidence.nextCursor === null ? 'complete' as const : 'pending' as const;
  const nextWithoutToken = {
    ...current,
    expectedCursor: evidence.nextCursor,
    bytesDelivered,
    cursorChainDigest,
    state,
    failureCode: null,
  };
  const record = {
    ...nextWithoutToken,
    progressToken: await agentArtifactCoverageProgressToken(nextWithoutToken),
  };
  validateAgentArtifactCoverageRecord(record);
  return { record, advanced: true };
}

export async function settleAgentArtifactCoverageIncomplete(
  current: AgentArtifactCoverageRecord,
  failureCode: string,
): Promise<AgentArtifactCoverageRecord> {
  validateAgentArtifactCoverageRecord(current);
  assertFailureCode(failureCode);
  if (current.state === 'complete') return current;
  if (current.state === 'incomplete') {
    if (current.failureCode !== failureCode) {
      throw new AgentArtifactCoverageError('Incomplete artifact coverage settlement is immutable.');
    }
    return current;
  }
  const nextWithoutToken = {
    ...current,
    state: 'incomplete' as const,
    failureCode,
  };
  const record = {
    ...nextWithoutToken,
    progressToken: await agentArtifactCoverageProgressToken(nextWithoutToken),
  };
  validateAgentArtifactCoverageRecord(record);
  return record;
}

export function agentArtifactCoverageDirective(
  record: AgentArtifactCoverageRecord,
): AgentRequiredBeforeFinalDirective | null {
  validateAgentArtifactCoverageRecord(record);
  return record.state === 'pending'
    ? {
        reference: record.coverageId,
        progressToken: record.progressToken,
        requiredBeforeFinal: true,
      }
    : null;
}

export function agentArtifactCoverageDirectives(
  records: readonly AgentArtifactCoverageRecord[],
): AgentRequiredBeforeFinalDirective[] {
  validateAgentArtifactCoverageRecords(records);
  return records.flatMap((record) => {
    const directive = agentArtifactCoverageDirective(record);
    return directive ? [directive] : [];
  }).sort((left, right) => (
    left.reference < right.reference ? -1 : left.reference > right.reference ? 1 : 0
  ));
}

export function createAgentArtifactCoverageReceipt(
  record: AgentArtifactCoverageRecord,
  completedAt: number,
): AgentArtifactCoverageReceipt {
  validateAgentArtifactCoverageRecord(record);
  assertTimestamp(completedAt, 'Agent artifact coverage completion time');
  if (record.state !== 'complete' || record.bytesDelivered !== record.expectedBytes) {
    throw new AgentArtifactCoverageError('Only exact complete artifact coverage has a receipt.');
  }
  const receipt = {
    schemaVersion: AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION,
    coverageId: record.coverageId,
    artifactId: record.artifactId,
    sourceToolCallId: record.sourceToolCallId,
    byteLength: record.expectedBytes,
    artifactSha256: record.artifactSha256,
    integrityManifestSha256: record.integrityManifestSha256,
    cursorChainDigest: record.cursorChainDigest,
    completedAt,
  };
  validateAgentArtifactCoverageReceipt(receipt);
  return receipt;
}

export function validateAgentArtifactCoverageRecords(
  records: unknown,
): asserts records is readonly AgentArtifactCoverageRecord[] {
  if (!Array.isArray(records) || records.length > AGENT_ARTIFACT_COVERAGE_MAX_RECORDS) {
    throw new TypeError('Agent artifact coverage records are not bounded.');
  }
  const ids = new Set<string>();
  for (const record of records) {
    validateAgentArtifactCoverageRecord(record);
    if (ids.has(record.coverageId)) throw new TypeError('Agent artifact coverage IDs must be unique.');
    ids.add(record.coverageId);
  }
}

export function validateAgentArtifactCoverageRecord(
  value: unknown,
): asserts value is AgentArtifactCoverageRecord {
  assertObject(value, 'Agent artifact coverage record');
  assertExactKeys(value, [
    'artifactId',
    'artifactSha256',
    'bytesDelivered',
    'coverageId',
    'cursorChainDigest',
    'expectedBytes',
    'expectedCursor',
    'failureCode',
    'integrityManifestSha256',
    'progressToken',
    'schemaVersion',
    'sourceToolCallId',
    'state',
  ], 'Agent artifact coverage record');
  if (value.schemaVersion !== AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION) {
    throw new TypeError('Agent artifact coverage schema version is unsupported.');
  }
  assertPattern(value.coverageId, COVERAGE_ID_PATTERN, 'Agent artifact coverage ID');
  assertIdentifier(value.artifactId, 'Agent artifact ID');
  assertIdentifier(value.sourceToolCallId, 'Agent artifact source tool call ID');
  assertNonnegativeSafeInteger(value.expectedBytes, 'Agent artifact expected bytes');
  assertDigest(value.artifactSha256, 'Agent artifact digest');
  assertDigest(value.integrityManifestSha256, 'Agent artifact manifest digest');
  if (value.expectedCursor !== null) assertIdentifier(value.expectedCursor, 'Agent artifact expected cursor', 2_048);
  assertNonnegativeSafeInteger(value.bytesDelivered, 'Agent artifact delivered bytes');
  if (value.bytesDelivered > value.expectedBytes) {
    throw new TypeError('Agent artifact delivered bytes exceed expected bytes.');
  }
  assertPattern(value.cursorChainDigest, CHAIN_DIGEST_PATTERN, 'Agent artifact cursor-chain digest');
  assertPattern(value.progressToken, PROGRESS_TOKEN_PATTERN, 'Agent artifact progress token');
  if (value.state !== 'pending' && value.state !== 'complete' && value.state !== 'incomplete') {
    throw new TypeError('Agent artifact coverage state is invalid.');
  }
  if (value.state === 'incomplete') {
    if (value.failureCode === null) throw new TypeError('Incomplete artifact coverage requires a failure code.');
    assertFailureCode(value.failureCode);
  } else if (value.failureCode !== null) {
    throw new TypeError('Pending or complete artifact coverage cannot have a failure code.');
  }
  if (
    value.state === 'complete'
    && (value.expectedCursor !== null || value.bytesDelivered !== value.expectedBytes)
  ) throw new TypeError('Complete artifact coverage does not prove exact completion.');
  if (
    value.state === 'pending'
    && (
      (value.bytesDelivered === 0 && value.expectedCursor !== null)
      || (value.bytesDelivered > 0 && (
        value.expectedCursor === null || value.bytesDelivered >= value.expectedBytes
      ))
    )
  ) throw new TypeError('Pending artifact coverage has an impossible cursor or byte boundary.');
}

export function validateAgentArtifactCoverageReceipt(
  value: unknown,
): asserts value is AgentArtifactCoverageReceipt {
  assertObject(value, 'Agent artifact coverage receipt');
  assertExactKeys(value, [
    'artifactId',
    'artifactSha256',
    'byteLength',
    'completedAt',
    'coverageId',
    'cursorChainDigest',
    'integrityManifestSha256',
    'schemaVersion',
    'sourceToolCallId',
  ], 'Agent artifact coverage receipt');
  if (value.schemaVersion !== AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION) {
    throw new TypeError('Agent artifact coverage receipt schema version is unsupported.');
  }
  assertPattern(value.coverageId, COVERAGE_ID_PATTERN, 'Agent artifact coverage ID');
  assertIdentifier(value.artifactId, 'Agent artifact ID');
  assertIdentifier(value.sourceToolCallId, 'Agent artifact source tool call ID');
  assertNonnegativeSafeInteger(value.byteLength, 'Agent artifact receipt bytes');
  assertDigest(value.artifactSha256, 'Agent artifact digest');
  assertDigest(value.integrityManifestSha256, 'Agent artifact manifest digest');
  assertPattern(value.cursorChainDigest, CHAIN_DIGEST_PATTERN, 'Agent artifact cursor-chain digest');
  assertTimestamp(value.completedAt, 'Agent artifact coverage completion time');
}

export function validateAgentArtifactCoverageEvidence(
  value: unknown,
): asserts value is AgentArtifactCoverageEvidence {
  assertObject(value, 'Agent artifact coverage evidence');
  assertExactKeys(value, [
    'artifactBytes',
    'artifactId',
    'artifactSha256',
    'cursorSupplied',
    'inputCursor',
    'integrityManifestSha256',
    'integrityVerified',
    'nextCursor',
    'pageBytes',
    'readKind',
    'schemaVersion',
    'touchedChunks',
    'touchedChunkBytes',
    'touchedChunkCount',
    'touchedChunkDigest',
  ], 'Agent artifact coverage evidence');
  if (value.schemaVersion !== AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION) {
    throw new TypeError('Agent artifact coverage evidence schema version is unsupported.');
  }
  assertIdentifier(value.artifactId, 'Agent artifact ID');
  assertNonnegativeSafeInteger(value.artifactBytes, 'Agent artifact bytes');
  assertDigest(value.artifactSha256, 'Agent artifact digest');
  assertDigest(value.integrityManifestSha256, 'Agent artifact manifest digest');
  if (value.readKind !== 'page' && value.readKind !== 'offset' && value.readKind !== 'search') {
    throw new TypeError('Agent artifact read kind is invalid.');
  }
  if (typeof value.cursorSupplied !== 'boolean') throw new TypeError('Agent artifact cursor flag is invalid.');
  if (value.inputCursor !== null) assertIdentifier(value.inputCursor, 'Agent artifact input cursor', 2_048);
  if (!value.cursorSupplied && value.inputCursor !== null) {
    throw new TypeError('Omitted Agent artifact cursor cannot have a value.');
  }
  if (value.readKind !== 'page' && value.cursorSupplied) {
    throw new TypeError('Targeted Agent artifact reads cannot supply an exhaustive cursor.');
  }
  assertNonnegativeSafeInteger(value.pageBytes, 'Agent artifact page bytes');
  if (value.nextCursor !== null) assertIdentifier(value.nextCursor, 'Agent artifact next cursor', 2_048);
  if (!Array.isArray(value.touchedChunks)) throw new TypeError('Agent artifact touched chunks must be an array.');
  if (value.touchedChunks.length > AGENT_ARTIFACT_COVERAGE_MAX_TOUCHED_CHUNKS) {
    throw new RangeError('Agent artifact touched chunk count is too large.');
  }
  let previousChunkIndex = -1;
  for (const chunk of value.touchedChunks) {
    assertObject(chunk, 'Agent artifact touched chunk');
    assertExactKeys(chunk, ['byteLength', 'index', 'sha256'], 'Agent artifact touched chunk');
    assertNonnegativeSafeInteger(chunk.index, 'Agent artifact touched chunk index');
    assertPositiveSafeInteger(chunk.byteLength, 'Agent artifact touched chunk bytes');
    assertDigest(chunk.sha256, 'Agent artifact touched chunk digest');
    if (chunk.index <= previousChunkIndex) throw new TypeError('Agent artifact touched chunks are not ordered.');
    previousChunkIndex = chunk.index;
  }
  assertNonnegativeSafeInteger(value.touchedChunkCount, 'Agent artifact touched chunk count');
  if (value.touchedChunkCount !== value.touchedChunks.length) {
    throw new TypeError('Agent artifact touched chunk count does not match evidence.');
  }
  assertNonnegativeSafeInteger(value.touchedChunkBytes, 'Agent artifact touched chunk bytes');
  assertPattern(value.touchedChunkDigest, TOUCHED_CHUNK_DIGEST_PATTERN, 'Agent artifact touched chunk digest');
  if (value.integrityVerified !== true) throw new TypeError('Agent artifact integrity evidence is not verified.');
  if (value.readKind === 'search' && (value.pageBytes !== 0 || value.nextCursor !== null)) {
    throw new TypeError('Agent artifact search evidence cannot describe a page transition.');
  }
}

export function validateAgentArtifactContinuationCheckpoint(
  value: unknown,
): asserts value is AgentArtifactContinuationCheckpoint {
  assertObject(value, 'Agent artifact continuation checkpoint');
  assertExactKeys(value, [
    'canonicalRawMessages',
    'directives',
    'nonProgressRepromptUsed',
    'projectedMessages',
    'schemaVersion',
    'updatedAt',
  ], 'Agent artifact continuation checkpoint');
  if (value.schemaVersion !== AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION) {
    throw new TypeError('Agent artifact continuation schema version is unsupported.');
  }
  if (!Array.isArray(value.projectedMessages) || !Array.isArray(value.canonicalRawMessages)) {
    throw new TypeError('Agent artifact continuation messages must be arrays.');
  }
  value.projectedMessages.forEach((message) => validateContinuationMessage(message, true));
  value.canonicalRawMessages.forEach((message) => validateContinuationMessage(message, false));
  if (!Array.isArray(value.directives) || value.directives.length === 0) {
    throw new TypeError('Agent artifact continuation requires directives.');
  }
  const references = new Set<string>();
  for (const directive of value.directives) {
    assertObject(directive, 'Agent required-before-final directive');
    assertExactKeys(directive, ['progressToken', 'reference', 'requiredBeforeFinal'], 'Agent required-before-final directive');
    assertIdentifier(directive.reference, 'Agent directive reference');
    assertIdentifier(directive.progressToken, 'Agent directive progress token');
    if (directive.requiredBeforeFinal !== true) throw new TypeError('Agent directive must be required before final.');
    if (references.has(directive.reference)) throw new TypeError('Agent directive references must be unique.');
    references.add(directive.reference);
  }
  if (typeof value.nonProgressRepromptUsed !== 'boolean') {
    throw new TypeError('Agent artifact continuation re-prompt flag is invalid.');
  }
  assertTimestamp(value.updatedAt, 'Agent artifact continuation update time');
  if (serializedBytes(value) > AGENT_ARTIFACT_CONTINUATION_MAX_BYTES) {
    throw new RangeError('Agent artifact continuation checkpoint is too large.');
  }
}

function validateContinuationMessage(value: unknown, allowSystem: boolean): void {
  assertObject(value, 'Agent artifact continuation message');
  const expectedKeys = [
    'content',
    'createdAt',
    'id',
    'role',
    ...(value.toolCallId === undefined ? [] : ['toolCallId']),
    ...(value.toolName === undefined ? [] : ['toolName']),
    ...(value.toolCalls === undefined ? [] : ['toolCalls']),
    ...(value.opaqueReferences === undefined ? [] : ['opaqueReferences']),
  ];
  assertExactKeys(value, expectedKeys, 'Agent artifact continuation message');
  assertIdentifier(value.id, 'Agent continuation message ID');
  if (typeof value.content !== 'string') throw new TypeError('Agent continuation message content is invalid.');
  if (TEXT_ENCODER.encode(value.content).byteLength > AGENT_ARTIFACT_CONTINUATION_MAX_BYTES) {
    throw new RangeError('Agent continuation message content is too large.');
  }
  if (
    value.role !== 'user'
    && value.role !== 'agent'
    && value.role !== 'tool'
    && (!allowSystem || value.role !== 'system')
  ) throw new TypeError('Agent continuation message role is invalid.');
  assertTimestamp(value.createdAt, 'Agent continuation message creation time');
  if (value.toolCallId !== undefined) assertIdentifier(value.toolCallId, 'Agent continuation tool call ID');
  if (value.toolName !== undefined) assertIdentifier(value.toolName, 'Agent continuation tool name');
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0 || value.toolCalls.length > 64) {
      throw new TypeError('Agent continuation tool calls are not bounded.');
    }
    for (const call of value.toolCalls) {
      assertObject(call, 'Agent continuation tool call');
      assertExactKeys(call, ['arguments', 'id', 'name'], 'Agent continuation tool call');
      assertIdentifier(call.id, 'Agent continuation tool call ID');
      assertIdentifier(call.name, 'Agent continuation tool call name');
    }
  }
  if (value.opaqueReferences !== undefined) {
    if (
      !Array.isArray(value.opaqueReferences)
      || value.opaqueReferences.length === 0
      || value.opaqueReferences.length > 8
    ) throw new TypeError('Agent continuation opaque references are not bounded.');
    const references = new Set<string>();
    for (const reference of value.opaqueReferences) {
      assertIdentifier(reference, 'Agent continuation opaque reference');
      if (references.has(reference)) throw new TypeError('Agent continuation opaque references must be unique.');
      references.add(reference);
    }
  }
}
function assertStableArtifactEvidence(
  record: AgentArtifactCoverageRecord,
  evidence: AgentArtifactCoverageEvidence,
): void {
  if (
    evidence.artifactId !== record.artifactId
    || evidence.artifactBytes !== record.expectedBytes
    || evidence.artifactSha256 !== record.artifactSha256
    || evidence.integrityManifestSha256 !== record.integrityManifestSha256
    || evidence.integrityVerified !== true
  ) throw new AgentArtifactCoverageError('Artifact coverage evidence does not match its immutable artifact.');
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unexpected fields.`);
  }
}

function assertIdentifier(value: unknown, label: string, maxBytes = 512): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} is invalid.`);
  }
  if (TEXT_ENCODER.encode(value).byteLength > maxBytes) throw new RangeError(`${label} is too large.`);
}

function assertPattern(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${label} is malformed.`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  assertPattern(value, DIGEST_PATTERN, label);
}

function assertFailureCode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,64}$/u.test(value)) {
    throw new TypeError('Agent artifact coverage failure code is invalid.');
  }
}

function assertNonnegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite nonnegative number.`);
  }
}

function addSafe(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${label} overflowed.`);
  return result;
}

function serializedBytes(value: unknown): number {
  return TEXT_ENCODER.encode(canonicalJson(value)).byteLength;
}
