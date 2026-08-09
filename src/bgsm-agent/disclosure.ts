import type { AgentProviderId } from '@/types';

export const AGENT_DATA_DISCLOSURE_VERSION = 2 as const;

export const AGENT_SENT_TASK_DATA_CATEGORIES = Object.freeze([
  'prompt_or_bounded_task_instruction',
  'selected_or_frozen_scope_public_repository_metadata',
  'selected_or_frozen_scope_public_repository_code_snippets',
  'selected_or_frozen_scope_private_notes',
  'visible_bounded_tag_taxonomy',
  'protocol_observations',
] as const);

export const AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES = Object.freeze([
  'credentials_or_secrets',
  'github_token',
  'unrelated_or_out_of_scope_stars',
] as const);

export const AGENT_PROVIDER_KEY_AUTHENTICATION_EXCEPTION = Object.freeze({
  category: 'selected_provider_api_key_authentication_header' as const,
  destination: 'bound_provider_origin_only' as const,
  modelVisible: false as const,
  logged: false as const,
});

export type AgentSentTaskDataCategory = typeof AGENT_SENT_TASK_DATA_CATEGORIES[number];
export type AgentNotSentAsTaskDataCategory =
  typeof AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES[number];

export type AgentDataDisclosureAcceptance = Readonly<{
  version: typeof AGENT_DATA_DISCLOSURE_VERSION;
  provider: AgentProviderId;
  origin: string;
  acceptedAt: number;
}>;

export function createAgentDataDisclosureAcceptance(input: Readonly<{
  provider: AgentProviderId;
  origin: string;
  acceptedAt: number;
}>): AgentDataDisclosureAcceptance {
  const acceptance = {
    version: AGENT_DATA_DISCLOSURE_VERSION,
    provider: input.provider,
    origin: input.origin,
    acceptedAt: input.acceptedAt,
  };
  validateAgentDataDisclosureAcceptance(acceptance);
  return Object.freeze(acceptance);
}

export function validateAgentDataDisclosureAcceptance(
  value: unknown,
): asserts value is AgentDataDisclosureAcceptance {
  if (!isRecord(value)) throw new TypeError('Agent disclosure acceptance must be an object.');
  assertExactKeys(value, ['version', 'provider', 'origin', 'acceptedAt']);
  if (value.version !== AGENT_DATA_DISCLOSURE_VERSION) {
    throw new TypeError('Agent disclosure acceptance version is unsupported.');
  }
  if (
    value.provider !== 'openai' &&
    value.provider !== 'openrouter' &&
    value.provider !== 'anthropic' &&
    value.provider !== 'custom-openai-compatible'
  ) {
    throw new TypeError('Agent disclosure provider is invalid.');
  }
  assertCanonicalOrigin(value.origin);
  const acceptedAt = value.acceptedAt;
  if (!Number.isSafeInteger(acceptedAt) || (acceptedAt as number) < 0) {
    throw new TypeError('Agent disclosure acceptedAt must be a nonnegative safe integer.');
  }
}

export function isDisclosureAcceptedFor(
  acceptance: AgentDataDisclosureAcceptance | null,
  provider: AgentProviderId,
  canonicalOrigin: string,
): boolean {
  if (!acceptance) return false;
  try {
    validateAgentDataDisclosureAcceptance(acceptance);
    assertCanonicalOrigin(canonicalOrigin);
  } catch {
    return false;
  }
  return (
    acceptance.version === AGENT_DATA_DISCLOSURE_VERSION &&
    acceptance.provider === provider &&
    acceptance.origin === canonicalOrigin
  );
}

function assertCanonicalOrigin(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Agent disclosure origin must be a canonical origin string.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Agent disclosure origin must be a valid URL origin.');
  }
  if (parsed.origin !== value || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new TypeError('Agent disclosure origin must equal its canonical HTTP(S) origin.');
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected contract keys: ${actual.join(', ')}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
