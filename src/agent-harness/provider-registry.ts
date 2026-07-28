import type {
  AgentCustomProviderProtocol,
  AgentProviderId,
} from '@/types';
import { AGENT_PROVIDER_TIMEOUT } from '@/api/errors';
import type { ModelMessage } from './messages';
import {
  getProvider,
  normalizeAgentModel,
  resolveAgentProviderEndpoint,
  type AgentProviderEndpoint,
} from './models';
import {
  AgentProviderError,
  AGENT_PROVIDER_PROBE_DEADLINE_MS,
  type ExactRequestModelProvider,
  type ModelProvider,
} from './provider';
import { createAnthropicMessagesProvider } from './providers/anthropic';
import { createOpenAICompatibleProvider } from './providers/openai-compatible';
import { createOpenAIResponsesProvider } from './providers/openai-responses';
import type { AgentToolDefinition } from './tools';

export type AgentProviderRegistryConfig = Readonly<{
  provider: AgentProviderId;
  protocol?: AgentCustomProviderProtocol | null;
  baseUrl?: string | null;
  model: string;
  apiKey: string;
  expectedOrigin?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  hostPermissionCheck?: () => Promise<boolean>;
  validateRuntimeIdentity?: () => Promise<boolean>;
  now?: () => number;
}>;

export type AgentProviderConnectionResult = Readonly<{
  provider: AgentProviderId;
  providerLabel: string;
  protocol: AgentProviderEndpoint['profile']['protocol'];
  model: string;
  latencyMs: number;
  preview: string;
  canonicalOrigin: string;
  completionEndpoint: string;
  profileIdentityVersion: string;
  capabilities: Readonly<{
    textChat: true;
    namedToolRoundTrip: true;
  }>;
}>;

export type AgentProviderProbePhase = 'tool_request' | 'tool_acknowledgement';

export type AgentProviderConnectionFailureDetails = Readonly<{
  schemaVersion: 1;
  phase: 'configuration' | 'permission' | 'identity' | AgentProviderProbePhase | 'unknown';
  code: string;
  status: number | null;
  message: string;
}>;

export class AgentProviderProbeError extends AgentProviderError {
  readonly phase: AgentProviderProbePhase;

  constructor(phase: AgentProviderProbePhase, error: AgentProviderError) {
    super(error.code, error.message, error.status);
    this.name = 'AgentProviderProbeError';
    this.phase = phase;
  }
}

export type AgentProviderProbeInput = Readonly<{
  provider: ModelProvider;
  endpoint: AgentProviderEndpoint;
  model: string;
  timeoutMs: number;
  now?: () => number;
}>;

const PROBE_TOOL_NAME = 'bgsm_connection_probe';
const PROBE_TOOL: AgentToolDefinition = Object.freeze({
  name: PROBE_TOOL_NAME,
  description: 'Return the provided connection-test nonce.',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { nonce: { type: 'string' } },
    required: ['nonce'],
    additionalProperties: false,
  },
});

export function createRegisteredAgentProvider(
  config: AgentProviderRegistryConfig,
): ExactRequestModelProvider {
  const endpoint = resolveAgentProviderEndpoint(
    config.provider,
    config.baseUrl,
    config.protocol,
  );
  const hostPermissionCheck = config.hostPermissionCheck ?? (async () => true);
  const common = {
    model: config.model,
    apiKey: config.apiKey,
    fetchImpl: config.fetchImpl,
    requestTimeoutMs: config.requestTimeoutMs,
    expectedOrigin: config.expectedOrigin ?? endpoint.canonicalOrigin,
    validateRuntimeIdentity: config.validateRuntimeIdentity,
    now: config.now,
  };

  switch (endpoint.profile.adapter) {
    case 'openai-compatible':
      return createOpenAICompatibleProvider({
        ...common,
        provider: endpoint.provider,
        baseUrl: endpoint.canonicalBaseUrl,
        hostPermissionCheck: () => hostPermissionCheck(),
      });
    case 'openai-responses':
      return createOpenAIResponsesProvider({
        ...common,
        endpoint: endpoint.completionEndpoint,
        hostPermissionCheck,
      });
    case 'anthropic-messages':
      return createAnthropicMessagesProvider({
        ...common,
        hostPermissionCheck,
      });
  }
}

export async function testRegisteredAgentProviderConnection(
  config: AgentProviderRegistryConfig,
): Promise<AgentProviderConnectionResult> {
  const endpoint = resolveAgentProviderEndpoint(
    config.provider,
    config.baseUrl,
    config.protocol,
  );
  const model = normalizeAgentModel(endpoint.provider, config.model);
  const totalTimeoutMs = Math.min(
    config.requestTimeoutMs ?? AGENT_PROVIDER_PROBE_DEADLINE_MS,
    AGENT_PROVIDER_PROBE_DEADLINE_MS,
  );
  const provider = createRegisteredAgentProvider({
    ...config,
    model,
    requestTimeoutMs: totalTimeoutMs,
  });
  return runAgentProviderConnectionProbe({
    provider,
    endpoint,
    model,
    timeoutMs: totalTimeoutMs,
    now: config.now,
  });
}

export async function runAgentProviderConnectionProbe(
  input: AgentProviderProbeInput,
): Promise<AgentProviderConnectionResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let totalTimedOut = false;
  const timer = setTimeout(() => {
    totalTimedOut = true;
    controller.abort();
  }, input.timeoutMs);
  let phase: AgentProviderProbePhase = 'tool_request';
  const userMessage: ModelMessage = {
    role: 'user',
    content: `Call ${PROBE_TOOL_NAME} with nonce "bgsm", then acknowledge its result.`,
  };
  try {
    const toolResponse = await input.provider.generate({
      messages: [userMessage],
      tools: [PROBE_TOOL],
      toolChoice: { name: PROBE_TOOL_NAME },
      maxOutputTokens: 64,
      signal: controller.signal,
    });
    if (
      toolResponse.finishReason !== 'tool_calls' ||
      toolResponse.toolCalls?.length !== 1 ||
      toolResponse.toolCalls[0].name !== PROBE_TOOL_NAME ||
      !isExactProbeArguments(toolResponse.toolCalls[0].arguments)
    ) {
      throw protocolError('The provider did not complete the named tool capability probe.');
    }
    const probeCall = toolResponse.toolCalls[0];
    phase = 'tool_acknowledgement';
    const acknowledgement = await input.provider.generate({
      messages: [
        userMessage,
        { role: 'assistant', content: toolResponse.content ?? '', toolCalls: [probeCall] },
        {
          role: 'tool',
          content: '{"ok":true,"data":{"nonce":"bgsm"}}',
          toolCallId: probeCall.id,
          toolName: probeCall.name,
        },
      ],
      tools: [PROBE_TOOL],
      maxOutputTokens: 64,
      signal: controller.signal,
    });
    const preview = (acknowledgement.content ?? '').trim().slice(0, 160);
    if (
      acknowledgement.finishReason !== 'stop' ||
      acknowledgement.toolCalls?.length ||
      !preview
    ) {
      throw protocolError('The provider returned an invalid probe acknowledgement.');
    }
    return Object.freeze({
      provider: input.endpoint.provider,
      providerLabel: getProvider(input.endpoint.provider).label,
      protocol: input.endpoint.profile.protocol,
      model: input.model,
      latencyMs: Math.max(0, now() - startedAt),
      preview,
      canonicalOrigin: input.endpoint.canonicalOrigin,
      completionEndpoint: input.endpoint.completionEndpoint,
      profileIdentityVersion: input.endpoint.profile.identityVersion,
      capabilities: Object.freeze({
        textChat: true,
        namedToolRoundTrip: true,
      }),
    });
  } catch (error) {
    if (totalTimedOut) {
      throw new AgentProviderProbeError(
        phase,
        new AgentProviderError('timeout', AGENT_PROVIDER_TIMEOUT),
      );
    }
    if (error instanceof AgentProviderError) throw new AgentProviderProbeError(phase, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function describeAgentProviderConnectionFailure(
  error: unknown,
): AgentProviderConnectionFailureDetails {
  const raw = error instanceof Error ? error.message : '';
  const providerError = error instanceof AgentProviderError ? error : null;
  const phase = error instanceof AgentProviderProbeError
    ? error.phase
    : raw === 'AGENT_HOST_PERMISSION_DENIED'
      ? 'permission'
      : raw === 'AGENT_PROVIDER_IDENTITY_CHANGED' || raw === 'AGENT_PROVIDER_ORIGIN_MISMATCH'
        ? 'identity'
        : raw.startsWith('AGENT_')
          ? 'configuration'
          : 'unknown';
  const code = providerError?.code
    ?? (/^AGENT_[A-Z0-9_]+$/u.test(raw) ? raw : 'unknown_error');
  const message = providerError?.message
    ?? (code === raw ? raw : 'Provider connection test failed before a safe error was available.');
  return Object.freeze({
    schemaVersion: 1,
    phase,
    code,
    status: providerError?.status ?? null,
    message: message.slice(0, 1_024),
  });
}

function isExactProbeArguments(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.nonce === 'bgsm';
}

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError('protocol_error', message);
}
