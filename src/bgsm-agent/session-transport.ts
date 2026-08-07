import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  validateBgsmAgentConversationCandidate,
  type BgsmAgentConversationCandidate,
} from './conversation-binding';
import type { BgsmAgentSessionTransition } from './session';

/**
 * Chromium has a hard 64 MiB extension-message cap and rejects larger payloads
 * with "Message exceeded maximum allowed size of 64MiB". The 8 MiB value below
 * is a transport budget, not a model-context limit: it leaves room for RPC
 * envelopes and avoids large serialization copies in both the UI and worker.
 *
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/messaging
 * @see https://chromium.googlesource.com/chromium/src/+/main/extensions/renderer/api/messaging/messaging_util.cc
 */
export const AGENT_SESSION_TURN_TRANSPORT_MAX_BYTES = 8 * 1024 * 1024;
export const BGSM_AGENT_PROMPT_MAX_BYTES = 512 * 1024;
export const AGENT_TURN_IDENTIFIER_MAX_BYTES = 512;

const UTF8_ENCODER = new TextEncoder();

export type AgentSessionAttemptDigest = `asd:v1:${string}`;
export type AgentSessionLaunchDigest = `asl:v1:${string}`;

export type AgentSessionLaunchIdentity = Readonly<{
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
  prompt: string;
  retrySourceAttemptId?: string;
  candidateContract?: BgsmAgentConversationCandidate;
}>;

export function assertAgentTurnTransportIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  assertTrimmedNonempty(value, label);
  assertUtf8TextMaxBytes(value, label, AGENT_TURN_IDENTIFIER_MAX_BYTES);
}

export function validateAgentSessionLaunchIdentity(
  value: unknown,
): asserts value is AgentSessionLaunchIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent session launch must be an object.');
  }
  const candidateContract = 'candidateContract' in value ? value.candidateContract : undefined;
  const retrySourceAttemptId = 'retrySourceAttemptId' in value
    ? value.retrySourceAttemptId
    : undefined;
  const expectedKeys = [
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'prompt',
    ...(retrySourceAttemptId === undefined ? [] : ['retrySourceAttemptId']),
    ...(candidateContract === undefined ? [] : ['candidateContract']),
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError('Agent session launch keys are invalid.');
  }
  const turnAttemptId = 'turnAttemptId' in value ? value.turnAttemptId : undefined;
  const sessionId = 'sessionId' in value ? value.sessionId : undefined;
  const baseRevision = 'baseRevision' in value ? value.baseRevision : undefined;
  const prompt = 'prompt' in value ? value.prompt : undefined;
  assertAgentTurnTransportIdentifier(turnAttemptId, 'Agent turn attempt ID');
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  if (!Number.isSafeInteger(baseRevision) || Number(baseRevision) < 0) {
    throw new TypeError('Agent session base revision must be a nonnegative safe integer.');
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new TypeError('Agent turn prompt must be nonempty.');
  }
  assertUtf8TextMaxBytes(prompt, 'Agent turn prompt', BGSM_AGENT_PROMPT_MAX_BYTES);
  if (retrySourceAttemptId !== undefined) {
    assertAgentTurnTransportIdentifier(retrySourceAttemptId, 'Agent retry source attempt ID');
  }
  if (candidateContract !== undefined) {
    validateBgsmAgentConversationCandidate(candidateContract);
  }
  assertAgentSessionTransportPayloadSize(value, 'Agent session launch');
}

export function validateAgentTurnOpaqueReferences(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new TypeError('Agent opaque references must contain between 1 and 8 values.');
  }
  const seen = new Set<string>();
  for (const reference of value) {
    assertAgentTurnTransportIdentifier(reference, 'Agent opaque reference');
    if (seen.has(reference)) throw new TypeError('Agent opaque references must be unique.');
    seen.add(reference);
  }
}
export type AgentActiveTurnTransport = Readonly<{
  executionEpochId: string;
  launch: AgentSessionLaunchIdentity;
}>;

/** A launch digest lets a restarted worker replay only the exact admitted request. */
export async function digestAgentSessionLaunch(
  launch: AgentSessionLaunchIdentity,
): Promise<AgentSessionLaunchDigest> {
  validateAgentSessionLaunchIdentity(launch);
  const digest = await sha256Base64Url(canonicalJson({
    turnAttemptId: launch.turnAttemptId,
    sessionId: launch.sessionId,
    baseRevision: launch.baseRevision,
    prompt: launch.prompt,
    retrySourceAttemptId: launch.retrySourceAttemptId ?? null,
    candidateContract: launch.candidateContract ?? null,
  }));
  return `asl:v1:${digest}`;
}

/** UI and background must hash the same canonical payload before trusting a replay receipt. */
export async function digestAgentSessionTransition(
  transition: BgsmAgentSessionTransition,
): Promise<AgentSessionAttemptDigest> {
  return `asd:v1:${await sha256Base64Url(canonicalJson(transition))}`;
}

export function serializedJsonUtf8Bytes(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('Agent session transport payload is not JSON serializable.');
  }
  if (serialized === undefined) {
    throw new TypeError('Agent session transport payload is not JSON serializable.');
  }
  return UTF8_ENCODER.encode(serialized).byteLength;
}

export function assertAgentSessionTransportPayloadSize(value: unknown, label: string): void {
  const bytes = serializedJsonUtf8Bytes(value);
  if (bytes > AGENT_SESSION_TURN_TRANSPORT_MAX_BYTES) {
    throw new RangeError(
      `${label} exceeds the ${AGENT_SESSION_TURN_TRANSPORT_MAX_BYTES}-byte transport limit.`,
    );
  }
}

function assertTrimmedNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be trimmed and nonempty.`);
  }
}

function assertUtf8TextMaxBytes(value: string, label: string, maxBytes: number): void {
  if (UTF8_ENCODER.encode(value).byteLength > maxBytes) {
    throw new RangeError(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
}

