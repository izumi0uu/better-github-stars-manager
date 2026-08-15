import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import {
  parseScopeFingerprint,
  validateLaunchCandidateContract,
  type LaunchCandidateContract,
  type ScopeFingerprint,
} from './scope';

export type BgsmAgentConversationCandidate = Extract<
  LaunchCandidateContract,
  { kind: 'selected_repository' | 'current_view' }
>;

export type BgsmAgentConversationBinding = Readonly<{
  version: 1;
  candidateContract: BgsmAgentConversationCandidate;
  scopeFingerprint: ScopeFingerprint;
  label: string;
  count: number;
  providerFingerprint: string;
}>;

export async function createBgsmAgentConversationScopeFingerprint(input: Readonly<{
  candidateContract: BgsmAgentConversationCandidate;
  repositoryIds: readonly string[];
  label: string;
}>): Promise<ScopeFingerprint> {
  validateBgsmAgentConversationCandidate(input.candidateContract);
  assertRepositoryIds(input.repositoryIds);
  assertTrimmedNonempty(input.label, 'Conversation scope label');
  const digest = await sha256Base64Url(canonicalJson({
    candidateContract: input.candidateContract,
    repositoryIds: input.repositoryIds,
    label: input.label,
  }));
  return parseScopeFingerprint(`fs:${digest}`);
}

export function createBgsmAgentConversationBinding(input: Omit<
  BgsmAgentConversationBinding,
  'version'
>): BgsmAgentConversationBinding {
  const binding = Object.freeze({ version: 1 as const, ...input });
  validateBgsmAgentConversationBinding(binding);
  return binding;
}

export function validateBgsmAgentConversationBinding(
  value: unknown,
): asserts value is BgsmAgentConversationBinding {
  if (!isRecord(value)) throw new TypeError('Conversation binding must be an object.');
  assertExactKeys(value, [
    'version',
    'candidateContract',
    'scopeFingerprint',
    'label',
    'count',
    'providerFingerprint',
  ]);
  if (value.version !== 1) throw new TypeError('Conversation binding version must be 1.');
  validateBgsmAgentConversationCandidate(value.candidateContract);
  if (typeof value.scopeFingerprint !== 'string'
    || !parseScopeFingerprint(value.scopeFingerprint)) {
    throw new TypeError('Conversation scope fingerprint is malformed.');
  }
  assertTrimmedNonempty(value.label, 'Conversation scope label');
  if (!Number.isSafeInteger(value.count) || Number(value.count) <= 0) {
    throw new TypeError('Conversation scope count must be a positive safe integer.');
  }
  if (typeof value.providerFingerprint !== 'string'
    || !/^pcf:v1:[A-Za-z0-9_-]{43}$/u.test(value.providerFingerprint)) {
    throw new TypeError('Conversation provider fingerprint is malformed.');
  }
}

export function validateBgsmAgentConversationCandidate(
  value: unknown,
): asserts value is BgsmAgentConversationCandidate {
  validateLaunchCandidateContract(value);
  if (value.kind !== 'selected_repository' && value.kind !== 'current_view') {
    throw new TypeError('Conversation scope must be a selected repository or current view.');
  }
}

function assertRepositoryIds(value: readonly string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Conversation scope repository IDs must be nonempty.');
  }
  const seen = new Set<string>();
  for (const repositoryId of value) {
    assertTrimmedNonempty(repositoryId, 'Conversation scope repository ID');
    if (seen.has(repositoryId)) {
      throw new TypeError('Conversation scope repository IDs must be unique and ordered.');
    }
    seen.add(repositoryId);
  }
}

function assertTrimmedNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new TypeError(`${label} must be trimmed and nonempty.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected conversation binding keys: ${actual.join(', ')}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
