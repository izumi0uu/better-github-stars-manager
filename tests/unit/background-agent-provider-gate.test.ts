import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentProviderGate } from '@/background/agent-provider-gate';
import type { AgentProviderConfig } from '@/types';
import type { AgentProviderCredentialSnapshot } from '@/auth/auth-store';
import type { AgentProviderRegistryConfig } from '@/agent-harness/provider-registry';
import type { ModelProvider } from '@/agent-harness/provider';
import {
  normalizeAgentModel,
  resolveAgentModelContextCapability,
  resolveAgentProviderEndpoint,
} from '@/agent-harness/models';
import type { AgentDataDisclosureAcceptance } from '@/bgsm-agent/disclosure';

const savedConfig: AgentProviderConfig = {
  provider: 'openai',
  protocol: null,
  baseUrl: null,
  model: 'gpt-5-mini',
  apiKeyEncrypted: 'ciphertext',
  apiKeyCryptoMeta: { iv: 'iv', salt: 'salt' },
  credentialScope: {
    provider: 'openai',
    origin: 'https://api.openai.com',
  },
  credentialRevision: 'cr:v1:saved',
  capability: null,
};

const readySnapshot: AgentProviderCredentialSnapshot = Object.freeze({
  provider: 'openai',
  canonicalBaseUrl: 'https://api.openai.com/v1',
  canonicalOrigin: 'https://api.openai.com',
  completionEndpoint: 'https://api.openai.com/v1/responses',
  protocol: 'responses',
  model: 'gpt-5-mini',
  profileIdentityVersion: 'openai-responses:v1',
  savedCompletionEndpoint: 'https://api.openai.com/v1/responses',
  savedProtocol: 'responses',
  savedProfileIdentityVersion: 'openai-responses:v1',
  savedModel: 'gpt-5-mini',
  savedDeclaredContextWindow: null,
  savedWorkingContextWindow: null,
  encryptedCredentialIdentity: 'encrypted-identity',
  credentialRevision: 'cr:v1:saved',
  fingerprint: 'pcf:v1:ready',
  capabilityReady: true,
  contextCapability: resolveAgentModelContextCapability({
    provider: 'openai',
    model: 'gpt-5-mini',
  }),
  workingContextWindow: null,
  apiKey: 'saved-secret',
});

function snapshotFor(config: AgentProviderConfig): AgentProviderCredentialSnapshot {
  const endpoint = resolveAgentProviderEndpoint(config.provider, config.baseUrl);
  const model = normalizeAgentModel(config.provider, config.model);
  const contextCapability = resolveAgentModelContextCapability({
    provider: endpoint.provider,
    model,
    declaredContextWindow: config.declaredContextWindow,
  });
  return Object.freeze({
    ...readySnapshot,
    provider: endpoint.provider,
    canonicalBaseUrl: endpoint.canonicalBaseUrl,
    canonicalOrigin: endpoint.canonicalOrigin,
    completionEndpoint: endpoint.completionEndpoint,
    model,
    profileIdentityVersion: endpoint.profile.identityVersion,
    savedCompletionEndpoint: endpoint.completionEndpoint,
    protocol: endpoint.profile.protocol,
    savedProtocol: endpoint.profile.protocol,
    savedProfileIdentityVersion: endpoint.profile.identityVersion,
    savedModel: model,
    savedDeclaredContextWindow: config.declaredContextWindow ?? null,
    savedWorkingContextWindow: config.workingContextWindow ?? null,
    credentialRevision: config.credentialRevision ?? readySnapshot.credentialRevision,
    contextCapability,
    workingContextWindow: config.workingContextWindow ?? null,
  });
}

function createHarness(
  config: AgentProviderConfig = savedConfig,
  disclosureTarget: Pick<AgentProviderConfig, 'provider' | 'baseUrl'> = config,
  assertContextCapabilityFeasible = vi.fn(),
) {
  const fetchSpy = vi.fn();
  const runtimeSnapshot = snapshotFor(config);
  const disclosureEndpoint = resolveAgentProviderEndpoint(
    disclosureTarget.provider,
    disclosureTarget.baseUrl,
  );
  const auth = {
    getConfig: vi.fn(async () => ({
      agentProvider: config,
      agentDataDisclosureAcceptance: {
        version: 2 as const,
        provider: disclosureEndpoint.provider,
        origin: disclosureEndpoint.canonicalOrigin,
        acceptedAt: 1,
      } as AgentDataDisclosureAcceptance | null,
    })),
    getAgentProviderCredentialSnapshot: vi.fn(async () => runtimeSnapshot as AgentProviderCredentialSnapshot | null),
    validateAgentProviderCredentialSnapshot: vi.fn(async () => true),
    recordAgentProviderCapability: vi.fn(async () => true),
  };
  const hasHostPermission = vi.fn(async () => true);
  const testConnection = vi.fn(async (providerConfig: AgentProviderRegistryConfig) => {
    if (providerConfig.hostPermissionCheck && !await providerConfig.hostPermissionCheck()) {
      throw new Error('AGENT_HOST_PERMISSION_DENIED');
    }
    if (providerConfig.validateRuntimeIdentity &&
      !await providerConfig.validateRuntimeIdentity()) {
      throw new Error('AGENT_PROVIDER_IDENTITY_CHANGED');
    }
    await fetchSpy('probe-request-1');
    if (providerConfig.hostPermissionCheck && !await providerConfig.hostPermissionCheck()) {
      throw new Error('AGENT_HOST_PERMISSION_DENIED');
    }
    if (providerConfig.validateRuntimeIdentity &&
      !await providerConfig.validateRuntimeIdentity()) {
      throw new Error('AGENT_PROVIDER_IDENTITY_CHANGED');
    }
    await fetchSpy('probe-request-2');
    return {
      provider: 'openai' as const,
      providerLabel: 'OpenAI',
      protocol: 'responses' as const,
      model: 'gpt-5-mini',
      latencyMs: 1,
      preview: 'ok',
      canonicalOrigin: 'https://api.openai.com',
      completionEndpoint: 'https://api.openai.com/v1/chat/completions',
      profileIdentityVersion: 'openai-chat-completions:v1',
      capabilities: {
        textChat: true as const,
        namedToolRoundTrip: true as const,
      },
    };
  });
  const createProvider = vi.fn((providerConfig: AgentProviderRegistryConfig): ModelProvider => ({
    generate: async () => {
      if (providerConfig.hostPermissionCheck && !await providerConfig.hostPermissionCheck()) {
        throw new Error('AGENT_HOST_PERMISSION_DENIED');
      }
      if (providerConfig.validateRuntimeIdentity &&
        !await providerConfig.validateRuntimeIdentity()) {
        throw new Error('AGENT_PROVIDER_IDENTITY_CHANGED');
      }
      await fetchSpy('runtime-request');
      return { content: 'ok' };
    },
  }));
  const gate = createAgentProviderGate({
    auth,
    hasHostPermission,
    testConnection,
    createProvider,
    assertContextCapabilityFeasible,
    now: () => 123,
  });
  return {
    auth,
    assertContextCapabilityFeasible,
    createProvider,
    fetchSpy,
    gate,
    hasHostPermission,
    testConnection,
  };
}

describe('background Agent provider gate', () => {
  it('binds the runtime fingerprint and provider construction to one credential snapshot', async () => {
    const harness = createHarness();
    const prepared = await harness.gate.prepareRuntimeProvider();

    expect(prepared.fingerprint).toBe(readySnapshot.fingerprint);
    expect(harness.auth.getAgentProviderCredentialSnapshot).toHaveBeenCalledOnce();
    expect(harness.createProvider).not.toHaveBeenCalled();

    const runtime = prepared.create();
    expect(runtime.fingerprint).toBe(prepared.fingerprint);
    expect(harness.createProvider).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['wrong provider', { provider: 'openrouter' as const }],
    ['wrong origin', {
      provider: 'custom-openai-compatible' as const,
      baseUrl: 'https://other.example/v1',
    }],
  ])('rejects %s saved-key fallback with zero probe/fetch calls', async (_name, request) => {
    const harness = createHarness(savedConfig, {
      provider: request.provider,
      baseUrl: 'baseUrl' in request ? request.baseUrl : null,
    });
    harness.auth.getAgentProviderCredentialSnapshot.mockResolvedValue(null);

    await expect(harness.gate.testConnection(request)).rejects.toThrow(
      'AGENT_API_KEY_EMPTY',
    );

    expect(harness.auth.getAgentProviderCredentialSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      provider: request.provider,
      protocol: request.provider === 'custom-openai-compatible'
        ? 'chat-completions'
        : null,
      baseUrl: expect.any(String),
      model: expect.any(String),
    }));
    expect(harness.testConnection).not.toHaveBeenCalled();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed on revoked custom permission before probe/fetch', async () => {
    const harness = createHarness(savedConfig, {
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example/v1',
    });
    harness.hasHostPermission.mockResolvedValue(false);

    await expect(harness.gate.testConnection({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example/v1',
      declaredContextWindow: 32_768,
      apiKey: 'transient-secret',
    })).rejects.toThrow('AGENT_HOST_PERMISSION_DENIED');

    expect(harness.testConnection).not.toHaveBeenCalled();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it('passes canonical origin to a transient probe but persists no readiness', async () => {
    const harness = createHarness(savedConfig, {
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example/v1',
    });

    await harness.gate.testConnection({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://RELAY.example:443/v1/chat/completions?ignored=1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      apiKey: ' transient-secret ',
    });

    expect(harness.testConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example/v1',
      model: 'custom-model',
      apiKey: 'transient-secret',
      expectedOrigin: 'https://relay.example',
    }));
    expect(harness.fetchSpy).toHaveBeenCalledTimes(2);
    expect(harness.auth.recordAgentProviderCapability).not.toHaveBeenCalled();
  });

  it('records one capability after a matching saved probe succeeds', async () => {
    const harness = createHarness();

    await harness.gate.testConnection({ provider: 'openai' });

    expect(harness.testConnection).toHaveBeenCalledOnce();
    expect(harness.fetchSpy).toHaveBeenCalledTimes(2);
    expect(harness.auth.recordAgentProviderCapability).toHaveBeenCalledOnce();
    expect(harness.auth.recordAgentProviderCapability).toHaveBeenCalledWith({
      provider: 'openai',
      protocol: null,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      declaredContextWindow: null,
      workingContextWindow: null,
      credentialSource: 'saved',
      credentialRevision: 'cr:v1:saved',
      verifiedAt: 123,
    });
  });

  it('fails a successful saved probe when readiness persistence loses its CAS race', async () => {
    const harness = createHarness();
    harness.auth.recordAgentProviderCapability.mockResolvedValue(false);

    await expect(harness.gate.testConnection({ provider: 'openai' })).rejects.toThrow(
      'AGENT_PROVIDER_IDENTITY_CHANGED',
    );

    expect(harness.testConnection).toHaveBeenCalledOnce();
    expect(harness.fetchSpy).toHaveBeenCalledTimes(2);
    expect(harness.auth.recordAgentProviderCapability).toHaveBeenCalledOnce();
  });

  it('records the exact declared and working windows for a saved Custom probe', async () => {
    const config: AgentProviderConfig = {
      ...savedConfig,
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example/v1',
      model: 'custom-model',
      declaredContextWindow: 65_536,
      workingContextWindow: 32_768,
      credentialScope: {
        provider: 'custom-openai-compatible',
        origin: 'https://relay.example',
      },
    };
    const harness = createHarness(config);

    await harness.gate.testConnection({});

    expect(harness.auth.recordAgentProviderCapability).toHaveBeenCalledWith({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example/v1',
      model: 'custom-model',
      declaredContextWindow: 65_536,
      workingContextWindow: 32_768,
      credentialSource: 'saved',
      credentialRevision: 'cr:v1:saved',
      verifiedAt: 123,
    });
  });

  it('rejects an infeasible context policy before provider transmission', async () => {
    const assertFeasible = vi.fn(() => {
      throw new RangeError('Agent context policy cannot fit the fixed prompt and tool schemas.');
    });
    const harness = createHarness(savedConfig, savedConfig, assertFeasible);

    await expect(harness.gate.testConnection({
      provider: 'openai',
      apiKey: 'transient-secret',
    })).rejects.toThrow(/cannot fit the fixed prompt and tool schemas/u);

    expect(assertFeasible).toHaveBeenCalledOnce();
    expect(harness.testConnection).not.toHaveBeenCalled();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it('allows connection tests and runtime setup without disclosure acceptance', async () => {
    const harness = createHarness();
    harness.auth.getConfig.mockResolvedValue({
      agentProvider: savedConfig,
      agentDataDisclosureAcceptance: null,
    });

    await harness.gate.testConnection({
      provider: 'openai',
      apiKey: 'transient-secret',
    });
    const runtime = await harness.gate.createRuntimeProvider();

    expect(harness.testConnection).toHaveBeenCalledOnce();
    expect(harness.fetchSpy).toHaveBeenCalledTimes(2);
    expect(runtime.providerId).toBe('openai');
    expect(harness.createProvider).toHaveBeenCalledOnce();
  });

  it('allows a changed custom origin when its Chrome host permission is present', async () => {
    const harness = createHarness();

    await harness.gate.testConnection({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example/v1',
      declaredContextWindow: 32_768,
      apiKey: 'transient-secret',
    });

    expect(harness.hasHostPermission).toHaveBeenCalled();
    expect(harness.testConnection).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://relay.example/v1',
      expectedOrigin: 'https://relay.example',
    }));
    expect(harness.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('uses an exact Custom model preset without a declared context window', async () => {
    const customConfig: AgentProviderConfig = {
      ...savedConfig,
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example/v1',
      model: 'gpt-5.4',
      declaredContextWindow: null,
      workingContextWindow: null,
      credentialScope: {
        provider: 'custom-openai-compatible',
        origin: 'https://relay.example',
      },
    };
    const harness = createHarness(customConfig);

    await harness.gate.testConnection({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example/v1',
      model: 'gpt-5.4',
      declaredContextWindow: null,
      apiKey: 'transient-secret',
    });

    expect(harness.assertContextCapabilityFeasible).toHaveBeenCalledWith({
      capability: expect.objectContaining({
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        sourceRevision: 'openai:gpt-5.4:2026-03-05',
      }),
      workingContextWindow: null,
    });
    expect(harness.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('blocks an unknown Custom model without capacity before provider transmission', async () => {
    const harness = createHarness();

    await expect(harness.gate.testConnection({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example/v1',
      model: 'unknown-model',
      declaredContextWindow: null,
      apiKey: 'transient-secret',
    })).rejects.toThrow('AGENT_CONTEXT_CAPABILITY_REQUIRED');

    expect(harness.testConnection).not.toHaveBeenCalled();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks an ineligible credential before runtime provider construction or fetch', async () => {
    const harness = createHarness();
    harness.auth.getAgentProviderCredentialSnapshot.mockResolvedValue(null);

    await expect(harness.gate.createRuntimeProvider()).rejects.toThrow('AGENT_API_KEY_EMPTY');

    expect(harness.createProvider).not.toHaveBeenCalled();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks an untested saved credential without transferring transient capability', async () => {
    const harness = createHarness();
    await harness.gate.testConnection({
      provider: 'openai',
      apiKey: 'transient-secret',
    });
    harness.fetchSpy.mockClear();
    harness.auth.getAgentProviderCredentialSnapshot.mockResolvedValue({
      ...readySnapshot,
      capabilityReady: false,
    });

    await expect(harness.gate.createRuntimeProvider()).rejects.toThrow(
      'AGENT_CONTEXT_CAPABILITY_REQUIRED',
    );

    expect(harness.auth.recordAgentProviderCapability).not.toHaveBeenCalled();
    expect(harness.createProvider).not.toHaveBeenCalled();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it('rechecks runtime permission and passes exact origin to provider creation', async () => {
    const customConfig: AgentProviderConfig = {
      ...savedConfig,
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example:8443/v1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      credentialScope: {
        provider: 'custom-openai-compatible',
        origin: 'https://relay.example:8443',
      },
    };
    const denied = createHarness(customConfig);
    denied.hasHostPermission.mockResolvedValue(false);

    await expect(denied.gate.createRuntimeProvider()).rejects.toThrow(
      'AGENT_HOST_PERMISSION_DENIED',
    );
    expect(denied.createProvider).not.toHaveBeenCalled();
    expect(denied.fetchSpy).not.toHaveBeenCalled();

    const allowed = createHarness(customConfig);
    await allowed.gate.createRuntimeProvider();
    expect(allowed.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://relay.example:8443/v1',
      expectedOrigin: 'https://relay.example:8443',
    }));
  });

  it('revalidates the same saved revision immediately before every runtime fetch', async () => {
    const harness = createHarness();
    const runtime = await harness.gate.createRuntimeProvider();
    harness.auth.validateAgentProviderCredentialSnapshot.mockResolvedValue(false);

    await expect(runtime.provider.generate({
      messages: [],
      tools: [],
      maxOutputTokens: 32,
    })).rejects.toThrow('AGENT_PROVIDER_IDENTITY_CHANGED');

    expect(harness.auth.validateAgentProviderCredentialSnapshot)
      .toHaveBeenCalledWith(readySnapshot);
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it('stops a saved probe when the revision changes between its two fetches', async () => {
    const harness = createHarness();
    harness.auth.validateAgentProviderCredentialSnapshot
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(harness.gate.testConnection({ provider: 'openai' }))
      .rejects.toThrow('AGENT_PROVIDER_IDENTITY_CHANGED');

    expect(harness.fetchSpy).toHaveBeenCalledTimes(1);
    expect(harness.auth.recordAgentProviderCapability).not.toHaveBeenCalled();
  });

  it('stops a Custom probe when host permission is revoked between its two fetches', async () => {
    const customConfig: AgentProviderConfig = {
      ...savedConfig,
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example/v1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      credentialScope: {
        provider: 'custom-openai-compatible',
        origin: 'https://relay.example',
      },
    };
    const harness = createHarness(customConfig);
    harness.hasHostPermission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(harness.gate.testConnection({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example/v1',
    })).rejects.toThrow('AGENT_HOST_PERMISSION_DENIED');

    expect(harness.fetchSpy).toHaveBeenCalledTimes(1);
    expect(harness.auth.recordAgentProviderCapability).not.toHaveBeenCalled();
  });

});
