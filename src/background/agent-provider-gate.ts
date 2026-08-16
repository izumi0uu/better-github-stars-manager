import {
  AGENT_API_KEY_EMPTY,
  AGENT_CONTEXT_CAPABILITY_REQUIRED,
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_PROVIDER_IDENTITY_CHANGED,
  AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED,
} from '@/api/errors';
import {
  normalizeAgentModel,
  resolveAgentModelContextCapability,
  resolveAgentProviderEndpoint,
  type AgentProviderEndpoint,
} from '@/agent-harness/models';
import type { ModelProvider } from '@/agent-harness/provider';
import type {
  AgentProviderConnectionResult,
  AgentProviderRegistryConfig,
} from '@/agent-harness/provider-registry';
import type {
  AgentCustomProviderProtocol,
  AgentProviderConfig,
  AgentProviderId,
  AgentModelContextCapability,
} from '@/types';
import type { AgentProviderCredentialSnapshot } from '@/auth/auth-store';
import {
  isDisclosureAcceptedFor,
  type AgentDataDisclosureAcceptance,
} from '@/bgsm-agent/disclosure';

export type AgentProviderConnectionRequest = {
  provider?: AgentProviderId;
  protocol?: AgentCustomProviderProtocol | null;
  baseUrl?: string | null;
  model?: string;
  apiKey?: string;
  declaredContextWindow?: number | null;
  workingContextWindow?: number | null;
};

type AgentProviderGateAuth = {
  getConfig(): Promise<{
    agentProvider: AgentProviderConfig;
    agentDataDisclosureAcceptance: AgentDataDisclosureAcceptance | null;
  }>;
  getAgentProviderCredentialSnapshot(requested?: {
    provider: AgentProviderId;
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
    model: string;
    declaredContextWindow?: number | null;
    workingContextWindow?: number | null;
  }): Promise<AgentProviderCredentialSnapshot | null>;
  validateAgentProviderCredentialSnapshot(
    snapshot: AgentProviderCredentialSnapshot,
  ): Promise<boolean>;
  recordAgentProviderCapability(input: {
    provider: AgentProviderId;
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
    model: string;
    declaredContextWindow?: number | null;
    workingContextWindow?: number | null;
    credentialSource: 'saved' | 'transient';
    credentialRevision: string | null;
    verifiedAt: number;
  }): Promise<boolean>;
};

type AgentProviderGateDependencies<TProvider extends ModelProvider> = {
  auth: AgentProviderGateAuth;
  hasHostPermission(
    provider: AgentProviderId,
    baseUrl: string | null | undefined,
  ): Promise<boolean>;
  hasDataCollectionPermission(): Promise<boolean>;
  testConnection(config: AgentProviderRegistryConfig): Promise<AgentProviderConnectionResult>;
  createProvider(config: AgentProviderRegistryConfig): TProvider;
  assertContextCapabilityFeasible?(input: Readonly<{
    capability: AgentModelContextCapability;
    workingContextWindow: number | null;
  }>): void;
  now?: () => number;
};

export type GatedAgentRuntimeProvider<TProvider extends ModelProvider = ModelProvider> = {
  provider: TProvider;
  providerId: AgentProviderId;
  model: string;
  endpoint: AgentProviderEndpoint;
  fingerprint: string;
  contextCapability: AgentModelContextCapability;
  workingContextWindow: number | null;
};

export type PreparedGatedAgentRuntimeProvider<TProvider extends ModelProvider = ModelProvider> = Readonly<{
  fingerprint: string;
  create(): Promise<GatedAgentRuntimeProvider<TProvider>>;
}>;

export function createAgentProviderGate<TProvider extends ModelProvider>(
  dependencies: AgentProviderGateDependencies<TProvider>,
) {
  const now = dependencies.now ?? Date.now;

  async function validateSavedRuntimeIdentity(
    snapshot: AgentProviderCredentialSnapshot,
  ): Promise<boolean> {
    return dependencies.auth.validateAgentProviderCredentialSnapshot(snapshot);
  }

  async function assertProviderConsent(endpoint: AgentProviderEndpoint): Promise<void> {
    const { agentDataDisclosureAcceptance } = await dependencies.auth.getConfig();
    if (!isDisclosureAcceptedFor(
      agentDataDisclosureAcceptance,
      endpoint.provider,
      endpoint.canonicalOrigin,
    )) {
      throw new Error(AGENT_DATA_DISCLOSURE_REQUIRED);
    }
    if (!await dependencies.hasDataCollectionPermission()) {
      throw new Error(AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED);
    }
  }

  async function validateProviderRequestAuthority(
    endpoint: AgentProviderEndpoint,
    snapshot: AgentProviderCredentialSnapshot | null,
  ): Promise<boolean> {
    await assertProviderConsent(endpoint);
    return snapshot ? validateSavedRuntimeIdentity(snapshot) : true;
  }

  async function resolveConnectionInput(request: AgentProviderConnectionRequest) {
    const stored = await dependencies.auth.getConfig();
    const config = stored.agentProvider;
    const provider = request.provider ?? config.provider;
    const endpoint = resolveAgentProviderEndpoint(
      provider,
      request.baseUrl === undefined ? config.baseUrl : request.baseUrl,
      request.protocol === undefined ? config.protocol : request.protocol,
    );
    const model = normalizeAgentModel(
      endpoint.provider,
      request.model ?? config.model,
    );
    const declaredContextWindow = request.declaredContextWindow === undefined
      ? config.declaredContextWindow ?? null
      : request.declaredContextWindow;
    const workingContextWindow = request.workingContextWindow === undefined
      ? config.workingContextWindow ?? null
      : request.workingContextWindow;
    const contextCapability = resolveAgentModelContextCapability({
      provider: endpoint.provider,
      model,
      declaredContextWindow,
    });
    const typedApiKey = request.apiKey?.trim();
    if (typedApiKey) {
      return {
        endpoint,
        model,
        apiKey: typedApiKey,
        credentialSource: 'transient' as const,
        credentialRevision: null,
        snapshot: null,
        contextCapability,
        declaredContextWindow,
        workingContextWindow,
      };
    }
    const snapshot = await dependencies.auth.getAgentProviderCredentialSnapshot({
      provider: endpoint.provider,
      protocol: endpoint.provider === 'custom-openai-compatible'
        ? endpoint.profile.protocol as AgentCustomProviderProtocol
        : null,
      baseUrl: endpoint.canonicalBaseUrl,
      model,
      declaredContextWindow,
      workingContextWindow,
    });
    return {
      endpoint,
      model,
      apiKey: snapshot?.apiKey ?? '',
      credentialSource: 'saved' as const,
      credentialRevision: snapshot?.credentialRevision ?? null,
      snapshot,
      contextCapability,
      declaredContextWindow,
      workingContextWindow,
    };
  }

  async function prepareRuntimeProvider(): Promise<PreparedGatedAgentRuntimeProvider<TProvider>> {
    const snapshot = await dependencies.auth.getAgentProviderCredentialSnapshot();
    if (!snapshot) throw new Error(AGENT_API_KEY_EMPTY);
    const endpoint = resolveAgentProviderEndpoint(
      snapshot.provider,
      snapshot.canonicalBaseUrl,
      snapshot.provider === 'custom-openai-compatible'
        ? snapshot.protocol as AgentCustomProviderProtocol
        : null,
    );
    await assertProviderConsent(endpoint);
    if (!await dependencies.hasHostPermission(endpoint.provider, endpoint.canonicalBaseUrl)) {
      throw new Error(AGENT_HOST_PERMISSION_DENIED);
    }
    if (!snapshot.contextCapability || !snapshot.capabilityReady) {
      throw new Error(AGENT_CONTEXT_CAPABILITY_REQUIRED);
    }
    dependencies.assertContextCapabilityFeasible?.({
      capability: snapshot.contextCapability,
      workingContextWindow: snapshot.workingContextWindow ?? null,
    });
    return Object.freeze({
      fingerprint: snapshot.fingerprint,
      create: async () => {
        await assertProviderConsent(endpoint);
        if (!await dependencies.hasHostPermission(
          endpoint.provider,
          endpoint.canonicalBaseUrl,
        )) {
          throw new Error(AGENT_HOST_PERMISSION_DENIED);
        }
        return {
          provider: dependencies.createProvider({
            provider: endpoint.provider,
            protocol: endpoint.provider === 'custom-openai-compatible'
              ? endpoint.profile.protocol as AgentCustomProviderProtocol
              : null,
            baseUrl: endpoint.canonicalBaseUrl,
            model: snapshot.model,
            apiKey: snapshot.apiKey,
            expectedOrigin: endpoint.canonicalOrigin,
            validateRuntimeIdentity: () => validateProviderRequestAuthority(endpoint, snapshot),
            hostPermissionCheck: () => dependencies.hasHostPermission(
              endpoint.provider,
              endpoint.canonicalBaseUrl,
            ),
          }),
          providerId: endpoint.provider,
          model: snapshot.model,
          endpoint,
          fingerprint: snapshot.fingerprint,
          contextCapability: snapshot.contextCapability!,
          workingContextWindow: snapshot.workingContextWindow ?? null,
        };
      },
    });
  }

  return {
    async testConnection(
      request: AgentProviderConnectionRequest,
    ): Promise<AgentProviderConnectionResult> {
      const input = await resolveConnectionInput(request);
      if (!input.apiKey) throw new Error(AGENT_API_KEY_EMPTY);
      await assertProviderConsent(input.endpoint);
      if (!await dependencies.hasHostPermission(
        input.endpoint.provider,
        input.endpoint.canonicalBaseUrl,
      )) {
        throw new Error(AGENT_HOST_PERMISSION_DENIED);
      }
      if (!input.contextCapability) throw new Error(AGENT_CONTEXT_CAPABILITY_REQUIRED);
      dependencies.assertContextCapabilityFeasible?.({
        capability: input.contextCapability,
        workingContextWindow: input.workingContextWindow,
      });
      const result = await dependencies.testConnection({
        provider: input.endpoint.provider,
        protocol: input.endpoint.provider === 'custom-openai-compatible'
          ? input.endpoint.profile.protocol as AgentCustomProviderProtocol
          : null,
        baseUrl: input.endpoint.canonicalBaseUrl,
        model: input.model,
        apiKey: input.apiKey,
        expectedOrigin: input.endpoint.canonicalOrigin,
        validateRuntimeIdentity: () => validateProviderRequestAuthority(
          input.endpoint,
          input.snapshot,
        ),
        hostPermissionCheck: () => dependencies.hasHostPermission(
          input.endpoint.provider,
          input.endpoint.canonicalBaseUrl,
        ),
      });
      if (input.credentialSource === 'saved' && input.credentialRevision) {
        const recorded = await dependencies.auth.recordAgentProviderCapability({
          provider: input.endpoint.provider,
          protocol: input.endpoint.provider === 'custom-openai-compatible'
            ? input.endpoint.profile.protocol as AgentCustomProviderProtocol
            : null,
          baseUrl: input.endpoint.canonicalBaseUrl,
          model: input.model,
          declaredContextWindow: input.declaredContextWindow,
          workingContextWindow: input.workingContextWindow,
          credentialSource: input.credentialSource,
          credentialRevision: input.credentialRevision,
          verifiedAt: now(),
        });
        if (!recorded) throw new Error(AGENT_PROVIDER_IDENTITY_CHANGED);
      }
      return result;
    },

    prepareRuntimeProvider,

    async createRuntimeProvider(): Promise<GatedAgentRuntimeProvider<TProvider>> {
      return await (await prepareRuntimeProvider()).create();
    },
  };
}
