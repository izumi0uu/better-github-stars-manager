import { describe, expect, it, vi } from 'vitest';
import {
  isSavedAgentCredentialEligible,
  normalizeAgentProviderConfig,
  providerCapabilityFingerprintV1,
  resolveAgentProviderContextIdentity,
  resolveAgentProviderEndpoint,
  UNRESOLVED_AGENT_CONTEXT_CAPABILITY_REVISION,
} from '@/agent-harness/models';
import { CONTEXT_BUDGET_POLICY_REVISION } from '@/agent-harness/compaction/budgets';
import {
  assertAgentProviderExactOrigin,
  getAgentProviderHostAccess,
  requestAgentProviderHostPermission,
} from '@/agent-harness/provider-access';
import type { AgentProviderConfig } from '@/types';
import manifestConfig from '../../manifest.config';

function savedConfig(overrides: Partial<AgentProviderConfig> = {}): AgentProviderConfig {
  return {
    provider: 'custom-openai-compatible',
    baseUrl: 'https://relay.example.com/v1',
    model: 'custom-model',
    apiKeyEncrypted: 'ciphertext',
    apiKeyCryptoMeta: { iv: 'iv', salt: 'salt' },
    credentialScope: {
      provider: 'custom-openai-compatible',
      origin: 'https://relay.example.com',
    },
    credentialRevision: 'cr:v1:saved-revision',
    capability: null,
    ...overrides,
    protocol: overrides.protocol ?? 'chat-completions',
  };
}

describe('agent provider endpoint and credential identities', () => {
  it('defaults legacy Custom protocol to Chat and discards capability for malformed protocol input', () => {
    const legacy = normalizeAgentProviderConfig({
      ...savedConfig(),
      protocol: undefined,
    });
    expect(legacy.protocol).toBe('chat-completions');
    expect(resolveAgentProviderEndpoint(
      legacy.provider,
      legacy.baseUrl,
      legacy.protocol,
    ).completionEndpoint).toBe('https://relay.example.com/v1/chat/completions');

    const malformed = normalizeAgentProviderConfig({
      ...savedConfig(),
      protocol: 'unknown' as never,
      capability: {
        fingerprint: 'pcf:v1:stale',
        verifiedAt: 1,
        textChat: true,
        namedToolRoundTrip: true,
      },
    });
    expect(malformed.protocol).toBe('chat-completions');
    expect(malformed.capability).toBeNull();
    expect(normalizeAgentProviderConfig({
      provider: 'anthropic',
      protocol: 'responses',
    }).protocol).toBeNull();
  });

  it.each([
    ['openai', null, 'responses', 'openai-responses', 'https://api.openai.com/v1/responses'],
    ['openrouter', null, 'chat-completions', 'openai-compatible', 'https://openrouter.ai/api/v1/chat/completions'],
    ['anthropic', null, 'anthropic-messages', 'anthropic-messages', 'https://api.anthropic.com/v1/messages'],
    ['custom-openai-compatible', 'chat-completions', 'chat-completions', 'openai-compatible', 'https://relay.example.com/v1/chat/completions'],
    ['custom-openai-compatible', 'responses', 'responses', 'openai-responses', 'https://relay.example.com/v1/responses'],
  ] as const)(
    'resolves %s through %s to one concrete adapter profile',
    (provider, protocol, resolvedProtocol, adapter, completionEndpoint) => {
      const endpoint = resolveAgentProviderEndpoint(
        provider,
        provider === 'custom-openai-compatible' ? 'https://relay.example.com/v1' : null,
        protocol,
      );
      expect(endpoint).toEqual(expect.objectContaining({ completionEndpoint }));
      expect(endpoint.profile).toEqual(expect.objectContaining({
        protocol: resolvedProtocol,
        adapter,
      }));
    },
  );

  it.each([
    'https://RELAY.example.com:443/v1',
    'https://relay.example.com/v1/',
    'https://relay.example.com/root/../v1/chat/completions?ignored=1#fragment',
  ])('canonicalizes equivalent custom endpoint form %s', (baseUrl) => {
    expect(resolveAgentProviderEndpoint('custom-openai-compatible', baseUrl)).toEqual(
      expect.objectContaining({
        canonicalOrigin: 'https://relay.example.com',
        canonicalBaseUrl: 'https://relay.example.com/v1',
        completionEndpoint: 'https://relay.example.com/v1/chat/completions',
        completionPathname: '/v1/chat/completions',
      }),
    );
  });

  it.each([
    'https://RELAY.example.com:443/v1',
    'https://relay.example.com/v1/',
    'https://relay.example.com/root/../v1/responses?ignored=1#fragment',
  ])('canonicalizes equivalent Custom Responses endpoint form %s', (baseUrl) => {
    expect(resolveAgentProviderEndpoint(
      'custom-openai-compatible',
      baseUrl,
      'responses',
    )).toEqual(expect.objectContaining({
      canonicalOrigin: 'https://relay.example.com',
      canonicalBaseUrl: 'https://relay.example.com/v1',
      completionEndpoint: 'https://relay.example.com/v1/responses',
      completionPathname: '/v1/responses',
    }));
  });

  it('uses the fixed provider endpoint even when stale custom input is present', () => {
    expect(resolveAgentProviderEndpoint('openai', 'https://attacker.example/v9')).toEqual(
      expect.objectContaining({
        canonicalOrigin: 'https://api.openai.com',
        completionEndpoint: 'https://api.openai.com/v1/responses',
      }),
    );
  });

  it('binds saved credentials to provider and exact canonical origin only', () => {
    const config = savedConfig();
    expect(isSavedAgentCredentialEligible(config, {
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/gateway/v2',
    })).toBe(true);
    expect(isSavedAgentCredentialEligible(config, {
      provider: 'openai',
      baseUrl: null,
    })).toBe(false);
    expect(isSavedAgentCredentialEligible(config, {
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com:8443/v1',
    })).toBe(false);
    expect(isSavedAgentCredentialEligible({
      ...config,
      credentialScope: null,
      credentialRevision: null,
    }, {
      provider: config.provider,
      baseUrl: config.baseUrl,
    })).toBe(false);
  });

  it('fingerprints endpoint path, model, profile, and saved revision separately from key eligibility', async () => {
    const base = savedConfig();
    const original = await providerCapabilityFingerprintV1(base);
    const equivalent = await providerCapabilityFingerprintV1({
      ...base,
      baseUrl: 'https://relay.example.com/v1/chat/completions?ignored=1',
    });
    const pathChanged = await providerCapabilityFingerprintV1({
      ...base,
      baseUrl: 'https://relay.example.com/gateway/v2',
    });
    const modelChanged = await providerCapabilityFingerprintV1({
      ...base,
      model: 'other-model',
    });
    const revisionChanged = await providerCapabilityFingerprintV1({
      ...base,
      credentialRevision: 'cr:v1:replacement',
    });
    const originChanged = await providerCapabilityFingerprintV1({
      ...base,
      baseUrl: 'https://other.example/v1',
    });
    const providerAndProfileChanged = await providerCapabilityFingerprintV1({
      ...base,
      provider: 'openai',
      protocol: null,
      baseUrl: null,
    });
    const protocolChanged = await providerCapabilityFingerprintV1({
      ...base,
      protocol: 'responses',
    });

    expect(original).toMatch(/^pcf:v1:/);
    expect(equivalent).toBe(original);
    expect(pathChanged).not.toBe(original);
    expect(modelChanged).not.toBe(original);
    expect(revisionChanged).not.toBe(original);
    expect(originChanged).not.toBe(original);
    expect(providerAndProfileChanged).not.toBe(original);
    expect(protocolChanged).not.toBe(original);
    expect(resolveAgentProviderEndpoint('openai', null).profile.identityVersion)
      .not.toBe(resolveAgentProviderEndpoint(
        'custom-openai-compatible', base.baseUrl,
      ).profile.identityVersion);
  });

  it('binds fingerprints to resolved context capability and effective policy identity', async () => {
    const custom = savedConfig({
      declaredContextWindow: null,
      workingContextWindow: null,
    });
    const unresolved = await providerCapabilityFingerprintV1(custom);
    const declared = await providerCapabilityFingerprintV1({
      ...custom,
      declaredContextWindow: 32_768,
    });
    const capped = await providerCapabilityFingerprintV1({
      ...custom,
      declaredContextWindow: 32_768,
      workingContextWindow: 16_384,
    });
    const redundantCap = await providerCapabilityFingerprintV1({
      ...custom,
      declaredContextWindow: 32_768,
      workingContextWindow: 64_000,
    });

    expect(unresolved).not.toBe(declared);
    expect(capped).not.toBe(declared);
    expect(redundantCap).toBe(declared);

    const unresolvedIdentity = resolveAgentProviderContextIdentity({
      provider: custom.provider,
      model: custom.model,
    });
    expect(unresolvedIdentity).toEqual({
      capabilityRevision: UNRESOLVED_AGENT_CONTEXT_CAPABILITY_REVISION,
      policyAlgorithmRevision: CONTEXT_BUDGET_POLICY_REVISION,
      workingWindow: null,
    });
  });

  it('binds exact Custom presets and explicit overrides as distinct context identities', async () => {
    const automatic = savedConfig({
      model: 'gpt-5.4',
      declaredContextWindow: null,
      workingContextWindow: null,
    });
    const explicit = {
      ...automatic,
      declaredContextWindow: 1_050_000,
    };

    expect(resolveAgentProviderContextIdentity(automatic)).toEqual({
      capabilityRevision:
        'mcc:v1:gpt-5.4:1050000:128000:openai:gpt-5.4:2026-03-05',
      policyAlgorithmRevision: CONTEXT_BUDGET_POLICY_REVISION,
      workingWindow: 1_050_000,
    });
    expect(resolveAgentProviderContextIdentity(explicit)).toEqual({
      capabilityRevision:
        'mcc:v1:declared:custom-openai-compatible:gpt-5.4:1050000',
      policyAlgorithmRevision: CONTEXT_BUDGET_POLICY_REVISION,
      workingWindow: 1_050_000,
    });
    expect(resolveAgentProviderContextIdentity({
      ...automatic,
      model: 'GPT-5.4',
    }).capabilityRevision).toBe(UNRESOLVED_AGENT_CONTEXT_CAPABILITY_REVISION);
    expect(await providerCapabilityFingerprintV1(automatic))
      .not.toBe(await providerCapabilityFingerprintV1(explicit));
  });

  it('ignores declarations that cannot override a trusted built-in capability', async () => {
    const native = savedConfig({
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5.4',
      declaredContextWindow: null,
      workingContextWindow: null,
    });
    const original = await providerCapabilityFingerprintV1(native);
    const ignoredDeclaration = await providerCapabilityFingerprintV1({
      ...native,
      declaredContextWindow: 32_768,
    });

    expect(ignoredDeclaration).toBe(original);
    expect(resolveAgentProviderContextIdentity(native)).toEqual(expect.objectContaining({
      capabilityRevision:
        'mcc:v1:gpt-5.4:1050000:128000:openai:gpt-5.4:2026-03-05',
      policyAlgorithmRevision: CONTEXT_BUDGET_POLICY_REVISION,
      workingWindow: 1_050_000,
    }));
  });
});

describe('agent provider host access', () => {
  it('keeps built-in hosts required and custom hosts optional', () => {
    expect(getAgentProviderHostAccess('openai', null)).toEqual({
      kind: 'required',
      canonicalOrigin: 'https://api.openai.com',
      permissionPattern: 'https://api.openai.com/*',
    });
    expect(getAgentProviderHostAccess(
      'custom-openai-compatible',
      'https://Relay.Example.com:8443/v1?x=1',
    )).toEqual({
      kind: 'optional',
      canonicalOrigin: 'https://relay.example.com:8443',
      permissionPattern: 'https://relay.example.com/*',
    });
  });

  it('requests custom permission explicitly and fails closed on denial', async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
    };

    await expect(requestAgentProviderHostPermission(
      'custom-openai-compatible',
      'https://relay.example.com:8443/v1',
      permissions,
    )).rejects.toThrow('AGENT_HOST_PERMISSION_DENIED');
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ['https://relay.example.com/*'],
    });
    expect(permissions.contains).not.toHaveBeenCalled();
  });

  it('never requests optional permission for built-in providers', async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
    };
    await expect(requestAgentProviderHostPermission(
      'openai', null, permissions,
    )).resolves.toBeUndefined();
    expect(permissions.contains).not.toHaveBeenCalled();
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it('allows local HTTP only and rejects remote HTTP before permission access', () => {
    expect(getAgentProviderHostAccess(
      'custom-openai-compatible', 'http://localhost:11434/v1',
    )).toEqual({
      kind: 'optional',
      canonicalOrigin: 'http://localhost:11434',
      permissionPattern: 'http://localhost/*',
    });
    expect(getAgentProviderHostAccess(
      'custom-openai-compatible', 'http://127.0.0.1:8080/v1',
    ).permissionPattern).toBe('http://127.0.0.1/*');
    expect(() => getAgentProviderHostAccess(
      'custom-openai-compatible', 'http://relay.example.com/v1',
    )).toThrow('AGENT_BASE_URL_INVALID');
  });

  it('keeps provider registry host modes conformant with the source manifest', () => {
    const manifest = manifestConfig as chrome.runtime.ManifestV3;
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      getAgentProviderHostAccess('openai', null).permissionPattern,
      getAgentProviderHostAccess('openrouter', null).permissionPattern,
      getAgentProviderHostAccess('anthropic', null).permissionPattern,
    ]));
    expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining([
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]));
    expect(manifest.host_permissions).not.toContain('https://*/*');
  });

  it('enforces exact origin independently of Chrome match-pattern granularity', () => {
    const access = getAgentProviderHostAccess(
      'custom-openai-compatible',
      'https://relay.example.com:8443/v1',
    );
    expect(() => assertAgentProviderExactOrigin(
      access.canonicalOrigin,
      'https://relay.example.com:8443/v2/chat/completions',
    )).not.toThrow();
    expect(() => assertAgentProviderExactOrigin(
      access.canonicalOrigin,
      'https://relay.example.com/v1/chat/completions',
    )).toThrow('AGENT_PROVIDER_ORIGIN_MISMATCH');
  });
});
