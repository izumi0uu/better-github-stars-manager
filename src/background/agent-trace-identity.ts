import type { AgentTraceProviderIdentity } from '@/agent-harness';
import { sha256Base64Url } from '@/agent-harness/canonical-json';
import type { AgentProviderId } from '@/types';

/**
 * Trace and binding identities deliberately record a provider class and
 * protocol rather than the configured endpoint, so a custom origin never leaks
 * into a trace or a durable organize binding.
 */
export function agentTraceProviderIdentity(
  provider: Readonly<{
    providerId: AgentProviderId;
    endpoint: Readonly<{ profile: Readonly<{ protocol: string }> }>;
  }>,
  modelCapabilityRevision: string,
): AgentTraceProviderIdentity {
  const providerClass = provider.providerId === 'custom-openai-compatible'
    ? 'custom'
    : provider.providerId;
  const protocol = provider.endpoint.profile.protocol === 'chat-completions'
    ? 'chat_completions'
    : provider.endpoint.profile.protocol === 'anthropic-messages'
      ? 'anthropic_messages'
      : 'responses';
  return Object.freeze({ providerClass, protocol, modelCapabilityRevision });
}

export async function organizeAnalysisProviderBinding(provider: Readonly<{
  providerId: AgentProviderId;
  model: string;
  endpoint: Readonly<{
    completionEndpoint: string;
    profile: Readonly<{ protocol: string }>;
  }>;
  contextCapability: Readonly<{ capabilityRevision: string }>;
}>) {
  return Object.freeze({
    version: 1,
    provider: provider.providerId,
    model: provider.model,
    protocol: provider.endpoint.profile.protocol,
    capabilityRevision: provider.contextCapability.capabilityRevision,
    endpointFingerprint: `endpoint:v1:${await sha256Base64Url(provider.endpoint.completionEndpoint)}`,
  });
}
