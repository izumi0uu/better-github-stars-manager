import { REPO_URL } from '@/lib/links';
import type {
  AgentCredentialScope,
  AgentProviderCapabilityRecord,
  AgentProviderConfig,
  AgentProviderId,
  AgentCustomProviderProtocol,
  AgentModelContextCapability,
} from '@/types';
import { CONTEXT_BUDGET_POLICY_REVISION } from './compaction/budgets';

export type AgentModelDefinition = {
  id: string;
  label: string;
  /** Compatibility projection; contextCapability is authoritative. */
  contextWindow?: number;
  contextCapability?: AgentModelContextCapability;
};

export type AgentProviderDefinition = {
  id: AgentProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: AgentModelDefinition[];
};

export type AgentProviderProtocol =
  | AgentCustomProviderProtocol
  | 'anthropic-messages';

export type AgentProviderProfile = Readonly<
  | {
      adapter: 'openai-compatible';
      protocol: 'chat-completions';
      identityVersion: string;
      outputTokenField: 'max_tokens' | 'max_completion_tokens';
    }
  | {
      adapter: 'openai-responses';
      protocol: 'responses';
      identityVersion: string;
    }
  | {
      adapter: 'anthropic-messages';
      protocol: 'anthropic-messages';
      identityVersion: string;
    }
>;

export type AgentProviderEndpoint = Readonly<{
  provider: AgentProviderId;
  canonicalOrigin: string;
  canonicalBaseUrl: string;
  completionEndpoint: string;
  completionPathname: string;
  profile: AgentProviderProfile;
}>;

const PROVIDERS: Record<
  AgentProviderId,
  Omit<AgentProviderDefinition, 'models'> & { models: readonly AgentModelDefinition[] }
> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    models: [
      model('gpt-5.5', 'GPT-5.5', 1_050_000, 128_000, 'openai:gpt-5.5:2026-04-23'),
      model('gpt-5.5-pro', 'GPT-5.5 Pro', 1_050_000, 128_000, 'openai:gpt-5.5-pro:2026-04-23'),
      model('gpt-5.4', 'GPT-5.4', 1_050_000, 128_000, 'openai:gpt-5.4:2026-03-05'),
      model('gpt-5.4-pro', 'GPT-5.4 Pro', 1_050_000, 128_000, 'openai:gpt-5.4-pro:2026-03-05'),
      model('gpt-5.4-mini', 'GPT-5.4 mini', 400_000, 128_000, 'openai:gpt-5.4-mini:2026-03-17'),
      model('gpt-5.4-nano', 'GPT-5.4 nano', 400_000, 128_000, 'openai:gpt-5.4-nano:2026-03-17'),
      model('gpt-5.3-chat-latest', 'GPT-5.3 Chat', 128_000, 16_384, 'pi-ai:0.80.10:openai'),
      model('gpt-5.3-codex', 'GPT-5.3 Codex', 400_000, 128_000, 'openai:gpt-5.3-codex:current'),
      model('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 128_000, 32_000, 'pi-ai:0.80.10:openai'),
      model('gpt-5-mini', 'GPT-5 mini', 400_000, 128_000, 'openai:gpt-5-mini:2025-08-07'),
      model('gpt-5', 'GPT-5', 400_000, 128_000, 'openai:gpt-5:2025-08-07'),
      model('gpt-5-nano', 'GPT-5 nano', 400_000, 128_000, 'pi-ai:0.80.10:openai'),
      model('gpt-5-pro', 'GPT-5 Pro', 400_000, 128_000, 'pi-ai:0.80.10:openai'),
      model('gpt-4o-mini', 'GPT-4o mini', 128_000, 16_384, 'openai:gpt-4o-mini:2024-07-18'),
      model('gpt-4.1-mini', 'GPT-4.1 mini', 1_047_576, 32_768, 'openai:gpt-4.1-mini:2025-04-14'),
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    models: [
      { id: 'openrouter/auto', label: 'OpenRouter Auto' },
      model('openai/gpt-5.5', 'OpenAI GPT-5.5', 1_050_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5.5-pro', 'OpenAI GPT-5.5 Pro', 1_050_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5.4', 'OpenAI GPT-5.4', 1_050_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5.4-pro', 'OpenAI GPT-5.4 Pro', 1_050_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5.4-mini', 'OpenAI GPT-5.4 Mini', 400_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5.4-nano', 'OpenAI GPT-5.4 Nano', 400_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5.3-chat', 'OpenAI GPT-5.3 Chat', 128_000, 16_384, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5.3-codex', 'OpenAI GPT-5.3 Codex', 400_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('openai/gpt-5-mini', 'OpenAI GPT-5 mini', 400_000, 128_000, 'openrouter:models-api:2026-07-17'),
      model('openai/gpt-5', 'OpenAI GPT-5', 400_000, 128_000, 'openrouter:models-api:2026-07-17'),
      model('anthropic/claude-opus-4.7', 'Claude Opus 4.7', 1_000_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('anthropic/claude-opus-4.6', 'Claude Opus 4.6', 1_000_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6', 1_000_000, 128_000, 'pi-ai:0.80.10:openrouter'),
      model('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', 1_000_000, 64_000, 'pi-ai:0.80.10:openrouter'),
      model('anthropic/claude-sonnet-4', 'Claude Sonnet 4', 200_000, 64_000, 'pi-ai:0.80.10:openrouter'),
      model('anthropic/claude-haiku-4.5', 'Claude Haiku 4.5', 200_000, 64_000, 'pi-ai:0.80.10:openrouter'),
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    models: [
      model('claude-opus-4-7', 'Claude Opus 4.7', 1_000_000, 128_000, 'pi-ai:0.80.10:anthropic'),
      model('claude-opus-4-6', 'Claude Opus 4.6', 1_000_000, 128_000, 'pi-ai:0.80.10:anthropic'),
      model('claude-opus-4-5', 'Claude Opus 4.5', 200_000, 64_000, 'pi-ai:0.80.10:anthropic'),
      model('claude-sonnet-4-6', 'Claude Sonnet 4.6', 1_000_000, 128_000, 'pi-ai:0.80.10:anthropic'),
      model('claude-sonnet-4-5', 'Claude Sonnet 4.5', 1_000_000, 64_000, 'pi-ai:0.80.10:anthropic'),
      model('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000, 'anthropic:standard-context:2026-07-17'),
    ],
  },
  'custom-openai-compatible': {
    id: 'custom-openai-compatible',
    label: 'Custom AI service',
    baseUrl: '',
    defaultModel: 'gpt-5.4',
    models: [
      model('gpt-5.4', 'GPT-5.4', 1_050_000, 128_000, 'openai:gpt-5.4:2026-03-05'),
    ],
  },
};

export const MODELS = Object.fromEntries(
  Object.entries(PROVIDERS).map(([provider, config]) => [provider, config.models]),
) as Record<AgentProviderId, readonly AgentModelDefinition[]>;

export function getProviders(): AgentProviderDefinition[] {
  return Object.values(PROVIDERS).map((provider) => ({
    ...provider,
    models: [...provider.models],
  }));
}

export function getProvider(provider: AgentProviderId): AgentProviderDefinition {
  const resolved = PROVIDERS[normalizeAgentProvider(provider)];
  return {
    ...resolved,
    models: [...resolved.models],
  };
}

export function getModels(provider: AgentProviderId): AgentModelDefinition[] {
  return [...PROVIDERS[normalizeAgentProvider(provider)].models];
}

export function trustedAgentModelContextCapability(
  provider: AgentProviderId,
  modelId: string,
): AgentModelContextCapability | undefined {
  const resolvedProvider = normalizeAgentProvider(provider);
  const normalizedModel = normalizeAgentModel(resolvedProvider, modelId);
  const capability = resolvedProvider === 'custom-openai-compatible'
    ? findUniqueKnownModelContextCapability(normalizedModel)
    : PROVIDERS[resolvedProvider].models.find(
        (candidate) => candidate.id === normalizedModel,
      )?.contextCapability;
  return capability ? Object.freeze({ ...capability }) : undefined;
}

export function resolveAgentModelContextCapability(input: Readonly<{
  provider: AgentProviderId;
  model: string;
  declaredContextWindow?: number | null;
}>): AgentModelContextCapability | undefined {
  const provider = normalizeAgentProvider(input.provider);
  const declared = normalizeAgentContextWindow(input.declaredContextWindow);
  const trusted = trustedAgentModelContextCapability(provider, input.model);
  if (provider !== 'custom-openai-compatible' && trusted) return trusted;
  if (provider === 'custom-openai-compatible' && declared === null && trusted) return trusted;
  if (declared === null) return undefined;
  const normalizedModel = normalizeAgentModel(provider, input.model);
  return Object.freeze({
    schemaVersion: 1,
    contextWindow: declared,
    maxOutputTokens: Math.min(trusted?.maxOutputTokens ?? 8_192, declared),
    source: 'user-declared',
    sourceRevision: 'user-settings:v1',
    capabilityRevision: `mcc:v1:declared:${provider}:${normalizedModel}:${declared}`,
  });
}

function findUniqueKnownModelContextCapability(
  modelId: string,
): AgentModelContextCapability | undefined {
  let match: AgentModelContextCapability | undefined;
  for (const provider of ['openai', 'openrouter', 'anthropic'] as const) {
    const candidate = PROVIDERS[provider].models.find((model) => model.id === modelId)
      ?.contextCapability;
    if (!candidate) continue;
    if (match) return undefined;
    match = candidate;
  }
  return match;
}

export function normalizeAgentContextWindow(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (!Number.isSafeInteger(value) || Number(value) < 4_096 || Number(value) > 2_000_000) {
    return null;
  }
  return Number(value);
}

export function trustedAgentModelContextWindow(
  provider: AgentProviderId,
  model: string,
): number | undefined {
  return trustedAgentModelContextCapability(provider, model)?.contextWindow;
}

function model(
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
  sourceRevision: string,
): AgentModelDefinition {
  return Object.freeze({
    id,
    label,
    contextWindow,
    contextCapability: Object.freeze({
      schemaVersion: 1 as const,
      contextWindow,
      maxOutputTokens,
      source: 'builtin-official' as const,
      sourceRevision,
      capabilityRevision: `mcc:v1:${id}:${contextWindow}:${maxOutputTokens}:${sourceRevision}`,
    }),
  });
}

export function normalizeAgentProvider(value: unknown): AgentProviderId {
  if (value === 'openrouter') return 'openrouter';
  if (value === 'anthropic') return 'anthropic';
  if (value === 'custom-openai-compatible') return 'custom-openai-compatible';
  return 'openai';
}

export function normalizeAgentCustomProviderProtocol(
  provider: AgentProviderId,
  value: unknown,
): AgentCustomProviderProtocol | null {
  if (normalizeAgentProvider(provider) !== 'custom-openai-compatible') return null;
  return value === 'responses' ? 'responses' : 'chat-completions';
}

export function normalizeAgentModel(
  provider: AgentProviderId,
  value: unknown,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || PROVIDERS[normalizeAgentProvider(provider)].defaultModel;
}

export function normalizeAgentBaseUrl(
  provider: AgentProviderId,
  value: unknown,
  protocol?: AgentCustomProviderProtocol | null,
): string | null {
  const resolvedProvider = normalizeAgentProvider(provider);
  if (resolvedProvider !== 'custom-openai-compatible') return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    return resolveAgentProviderEndpoint(resolvedProvider, raw, protocol).canonicalBaseUrl;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

export function resolveAgentProviderProfile(
  provider: AgentProviderId,
  protocol?: AgentCustomProviderProtocol | null,
): AgentProviderProfile {
  const resolvedProvider = normalizeAgentProvider(provider);
  if (resolvedProvider === 'openai') {
    return Object.freeze({
      adapter: 'openai-responses',
      protocol: 'responses',
      identityVersion: 'openai-responses:v1',
    });
  }
  if (resolvedProvider === 'anthropic') {
    return Object.freeze({
      adapter: 'anthropic-messages',
      protocol: 'anthropic-messages',
      identityVersion: 'anthropic-messages:2023-06-01:v1',
    });
  }
  if (
    resolvedProvider === 'custom-openai-compatible' &&
    normalizeAgentCustomProviderProtocol(resolvedProvider, protocol) === 'responses'
  ) {
    return Object.freeze({
      adapter: 'openai-responses',
      protocol: 'responses',
      identityVersion: 'custom-openai-compatible-responses:v1',
    });
  }
  return chatCompletionsProfile(resolvedProvider);
}

export function resolveAgentProviderEndpoint(
  provider: AgentProviderId,
  value: unknown,
  protocol?: AgentCustomProviderProtocol | null,
): AgentProviderEndpoint {
  const resolvedProvider = normalizeAgentProvider(provider);
  const profile = resolveAgentProviderProfile(resolvedProvider, protocol);
  const raw = resolvedProvider === 'custom-openai-compatible'
    ? (typeof value === 'string' ? value.trim() : '')
    : PROVIDERS[resolvedProvider].baseUrl;
  if (!raw) throw new Error('AGENT_BASE_URL_EMPTY');
  return resolveAgentProviderEndpointFromRaw(resolvedProvider, raw, profile);
}

/** Resolves the standalone Chat adapter without changing native service defaults. */
export function resolveOpenAICompatibleEndpoint(
  provider: AgentProviderId,
  value: unknown,
): AgentProviderEndpoint {
  const resolvedProvider = normalizeAgentProvider(provider);
  if (resolvedProvider === 'anthropic') throw new Error('AGENT_PROVIDER_UNSUPPORTED');
  if (resolvedProvider !== 'openai') {
    return resolveAgentProviderEndpoint(
      resolvedProvider,
      value,
      'chat-completions',
    );
  }
  return resolveAgentProviderEndpointFromRaw(
    resolvedProvider,
    PROVIDERS.openai.baseUrl,
    chatCompletionsProfile('openai'),
  );
}

export function normalizeAgentCredentialScope(
  value: unknown,
): AgentCredentialScope | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AgentCredentialScope>;
  if (
    candidate.provider !== 'openai' &&
    candidate.provider !== 'openrouter' &&
    candidate.provider !== 'anthropic' &&
    candidate.provider !== 'custom-openai-compatible'
  ) return null;
  if (typeof candidate.origin !== 'string') return null;
  try {
    const origin = new URL(candidate.origin).origin;
    const expected = resolveAgentProviderEndpoint(
      candidate.provider,
      candidate.provider === 'custom-openai-compatible' ? origin : null,
    ).canonicalOrigin;
    if (origin !== expected) return null;
    return { provider: candidate.provider, origin };
  } catch {
    return null;
  }
}

function normalizeAgentProviderCapability(
  value: unknown,
): AgentProviderCapabilityRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AgentProviderCapabilityRecord>;
  if (
    typeof candidate.fingerprint !== 'string' ||
    !candidate.fingerprint.startsWith('pcf:v1:') ||
    !Number.isSafeInteger(candidate.verifiedAt) ||
    (candidate.verifiedAt as number) < 0 ||
    candidate.textChat !== true ||
    candidate.namedToolRoundTrip !== true
  ) return null;
  const contextCapability = normalizeModelContextCapability(candidate.contextCapability);
  if (!contextCapability) return null;
  return {
    fingerprint: candidate.fingerprint,
    verifiedAt: candidate.verifiedAt as number,
    textChat: true,
    namedToolRoundTrip: true,
    contextCapability,
  };
}

function normalizeModelContextCapability(value: unknown): AgentModelContextCapability | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AgentModelContextCapability>;
  if (
    candidate.schemaVersion !== 1 ||
    normalizeAgentContextWindow(candidate.contextWindow) === null ||
    !Number.isSafeInteger(candidate.maxOutputTokens) ||
    Number(candidate.maxOutputTokens) <= 0 ||
    Number(candidate.maxOutputTokens) > Number(candidate.contextWindow) ||
    !['builtin-official', 'provider-verified', 'user-declared'].includes(String(candidate.source)) ||
    typeof candidate.sourceRevision !== 'string' || !candidate.sourceRevision ||
    typeof candidate.capabilityRevision !== 'string' || !candidate.capabilityRevision
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    contextWindow: Number(candidate.contextWindow),
    maxOutputTokens: Number(candidate.maxOutputTokens),
    source: candidate.source as AgentModelContextCapability['source'],
    sourceRevision: candidate.sourceRevision,
    capabilityRevision: candidate.capabilityRevision,
  });
}

export function normalizeAgentProviderConfig(
  value: Partial<AgentProviderConfig> | null | undefined,
): AgentProviderConfig {
  const provider = normalizeAgentProvider(value?.provider);
  const protocol = normalizeAgentCustomProviderProtocol(provider, value?.protocol);
  const invalidCustomProtocol = provider === 'custom-openai-compatible' &&
    value?.protocol != null &&
    value.protocol !== 'chat-completions' &&
    value.protocol !== 'responses';
  const apiKeyEncrypted =
    typeof value?.apiKeyEncrypted === 'string' && value.apiKeyEncrypted
      ? value.apiKeyEncrypted
      : null;
  const apiKeyCryptoMeta = value?.apiKeyCryptoMeta ?? null;
  const hasCiphertext = !!(apiKeyEncrypted && apiKeyCryptoMeta);
  const credentialScope = hasCiphertext
    ? normalizeAgentCredentialScope(value?.credentialScope)
    : null;
  const credentialRevision =
    hasCiphertext && credentialScope &&
    typeof value?.credentialRevision === 'string' &&
    value.credentialRevision.trim().startsWith('cr:v1:')
      ? value.credentialRevision.trim()
      : null;
  return {
    provider,
    protocol,
    baseUrl: normalizeAgentBaseUrl(provider, value?.baseUrl, protocol),
    model: normalizeAgentModel(provider, value?.model),
    declaredContextWindow: normalizeAgentContextWindow(value?.declaredContextWindow),
    workingContextWindow: normalizeAgentContextWindow(value?.workingContextWindow),
    apiKeyEncrypted,
    apiKeyCryptoMeta,
    credentialScope,
    credentialRevision,
    capability: credentialRevision && !invalidCustomProtocol
      ? normalizeAgentProviderCapability(value?.capability)
      : null,
  };
}

export function isSavedAgentCredentialEligible(
  config: AgentProviderConfig,
  requested: Pick<AgentProviderConfig, 'provider' | 'baseUrl'>,
): boolean {
  if (
    !config.apiKeyEncrypted ||
    !config.apiKeyCryptoMeta ||
    !config.credentialScope ||
    !config.credentialRevision
  ) return false;
  try {
    const endpoint = resolveAgentProviderEndpoint(requested.provider, requested.baseUrl);
    return config.credentialScope.provider === endpoint.provider &&
      config.credentialScope.origin === endpoint.canonicalOrigin;
  } catch {
    return false;
  }
}

export async function providerCapabilityFingerprintV1(
  config: Pick<
    AgentProviderConfig,
    | 'provider'
    | 'protocol'
    | 'baseUrl'
    | 'model'
    | 'credentialRevision'
    | 'declaredContextWindow'
    | 'workingContextWindow'
  >,
): Promise<string> {
  if (!config.credentialRevision) throw new Error('AGENT_CREDENTIAL_REVISION_MISSING');
  const endpoint = resolveAgentProviderEndpoint(
    config.provider,
    config.baseUrl,
    config.protocol,
  );
  const model = normalizeAgentModel(endpoint.provider, config.model);
  const contextIdentity = resolveAgentProviderContextIdentity({
    provider: endpoint.provider,
    model,
    declaredContextWindow: config.declaredContextWindow,
    workingContextWindow: config.workingContextWindow,
  });
  const tuple = JSON.stringify([
    endpoint.provider,
    endpoint.canonicalOrigin,
    endpoint.completionPathname,
    endpoint.profile.protocol,
    model,
    contextIdentity.capabilityRevision,
    contextIdentity.policyAlgorithmRevision,
    contextIdentity.workingWindow,
    endpoint.profile.identityVersion,
    config.credentialRevision,
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(tuple),
  ));
  const binary = Array.from(digest, (byte) => String.fromCharCode(byte)).join('');
  return `pcf:v1:${btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
}

export const UNRESOLVED_AGENT_CONTEXT_CAPABILITY_REVISION = 'mcc:v1:unresolved';

export function resolveAgentProviderContextIdentity(input: Readonly<{
  provider: AgentProviderId;
  model: string;
  declaredContextWindow?: number | null;
  workingContextWindow?: number | null;
}>): Readonly<{
  capabilityRevision: string;
  policyAlgorithmRevision: string;
  workingWindow: number | null;
}> {
  const capability = resolveAgentModelContextCapability(input);
  const configuredWorkingWindow = normalizeAgentContextWindow(input.workingContextWindow);
  return Object.freeze({
    capabilityRevision: capability?.capabilityRevision
      ?? UNRESOLVED_AGENT_CONTEXT_CAPABILITY_REVISION,
    policyAlgorithmRevision: CONTEXT_BUDGET_POLICY_REVISION,
    workingWindow: capability
      ? Math.min(capability.contextWindow, configuredWorkingWindow ?? capability.contextWindow)
      : null,
  });
}

export function buildProviderHeaders(
  provider: AgentProviderId,
): Record<string, string> {
  if (provider === 'openrouter') {
    return {
      'HTTP-Referer': REPO_URL,
      'X-Title': 'Better GitHub Stars Manager',
    };
  }
  return {};
}

function chatCompletionsProfile(
  provider: Exclude<AgentProviderId, 'anthropic'>,
): Extract<AgentProviderProfile, { adapter: 'openai-compatible' }> {
  return Object.freeze({
    adapter: 'openai-compatible',
    protocol: 'chat-completions',
    identityVersion: provider === 'openai'
      ? 'openai-chat-completions:v1'
      : provider === 'openrouter'
        ? 'openrouter-chat-completions:v1'
        : 'custom-openai-compatible-chat-completions:v1',
    outputTokenField: provider === 'openai' ? 'max_completion_tokens' : 'max_tokens',
  });
}

function resolveAgentProviderEndpointFromRaw(
  provider: AgentProviderId,
  raw: string,
  profile: AgentProviderProfile,
): AgentProviderEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AGENT_BASE_URL_INVALID');
  }
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password) {
    throw new Error('AGENT_BASE_URL_INVALID');
  }
  url.search = '';
  url.hash = '';
  const withoutTrailingSlash = url.pathname.replace(/\/+$/, '') || '/';
  const suffix = profile.protocol === 'chat-completions'
    ? '/chat/completions'
    : profile.protocol === 'responses'
      ? '/responses'
      : '/messages';
  const basePath = withoutTrailingSlash.endsWith(suffix)
    ? withoutTrailingSlash.slice(0, -suffix.length) || '/'
    : withoutTrailingSlash;
  const normalizedBasePath = basePath === '/' ? '' : basePath;
  const completionPathname = `${normalizedBasePath}${suffix}`;
  const canonicalOrigin = url.origin;
  return Object.freeze({
    provider,
    canonicalOrigin,
    canonicalBaseUrl: `${canonicalOrigin}${normalizedBasePath}`,
    completionEndpoint: `${canonicalOrigin}${completionPathname}`,
    completionPathname,
    profile,
  });
}
