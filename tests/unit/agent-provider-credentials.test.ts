import { beforeEach, describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn(async (value: string) => ({
    cipher: `opaque-cipher:${Array.from(value, (character) =>
      character.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`,
    meta: { iv: 'iv', salt: 'salt' },
  })),
  decrypt: vi.fn(async (cipher: string) => {
    const hex = cipher.replace(/^opaque-cipher:/, '');
    return hex.match(/.{2}/g)?.map((value) =>
      String.fromCharCode(Number.parseInt(value, 16))).join('') ?? null;
  }),
}));

vi.mock('@/auth/crypto', () => cryptoMocks);
vi.mock('@/auth/token-probe', () => ({ probeTokenCapabilities: vi.fn() }));

type StoredState = Record<string, unknown>;

function installChrome(initial: StoredState = {}) {
  const state: StoredState = { ...initial };
  const listeners: Array<(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void> = [];
  const local = {
    get: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.map((item) => [item, state[item]]));
    }),
    set: vi.fn(async (values: StoredState) => {
      for (const [key, value] of Object.entries(values)) {
        const oldValue = state[key];
        state[key] = value;
        for (const listener of listeners) {
          listener({ [key]: { oldValue, newValue: value } }, 'local');
        }
      }
    }),
  };
  vi.stubGlobal('chrome', {
    storage: {
      local,
      onChanged: {
        addListener: vi.fn((listener) => listeners.push(listener)),
      },
    },
  });
  return { state, local, listeners };
}

describe('agent provider credential persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('saves provider/origin scope and a new non-secret revision beside ciphertext', async () => {
    const { state } = installChrome();
    const { authStore, CONFIG_STORAGE_KEY } = await import('@/auth/auth-store');

    await authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://RELAY.example.com:443/v1/chat/completions?ignored=1',
      model: 'custom-model',
      apiKey: 'typed-secret',
    });

    const stored = state[CONFIG_STORAGE_KEY] as {
      agentProvider: Record<string, unknown>;
    };
    expect(stored.agentProvider).toEqual(expect.objectContaining({
      baseUrl: 'https://relay.example.com/v1',
      apiKeyEncrypted: expect.stringMatching(/^opaque-cipher:/),
      credentialScope: {
        provider: 'custom-openai-compatible',
        origin: 'https://relay.example.com',
      },
      credentialRevision: expect.stringMatching(/^cr:v1:/),
      capability: null,
    }));
    expect(JSON.stringify(stored)).not.toContain('typed-secret');

    expect(await authStore.getEligibleAgentApiKey({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/gateway/v2',
    })).toBe('typed-secret');
    expect(await authStore.getEligibleAgentApiKey({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com:8443/v1',
    })).toBeNull();
  });

  it('rejects an invalid explicit Custom target before reporting settings as saved', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');

    await expect(authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'not a URL',
      model: 'custom-model',
    })).rejects.toThrow('AGENT_BASE_URL_INVALID');
    expect((await authStore.getConfig()).agentProvider).toEqual(expect.objectContaining({
      provider: 'openai',
      protocol: null,
      baseUrl: null,
    }));
  });

  it('treats legacy unscoped ciphertext as ineligible without decrypting it', async () => {
    installChrome({
      gsm_config: {
        agentProvider: {
          provider: 'openai',
          baseUrl: null,
          model: 'gpt-5-mini',
          apiKeyEncrypted: 'legacy-cipher',
          apiKeyCryptoMeta: { iv: 'iv', salt: 'salt' },
        },
      },
    });
    const { authStore } = await import('@/auth/auth-store');

    expect(await authStore.getAgentApiKey()).toBeNull();
    expect(cryptoMocks.decrypt).not.toHaveBeenCalled();
  });

  it('normalizes legacy or malformed disclosure records to absent', async () => {
    installChrome({
      gsm_config: {
        agentDataDisclosureAcceptance: {
          version: 1,
          provider: 'openai',
          origin: 'https://api.openai.com',
          acceptedAt: 1,
        },
      },
    });
    const { authStore } = await import('@/auth/auth-store');

    expect((await authStore.getConfig()).agentDataDisclosureAcceptance).toBeNull();
    expect(await authStore.isAgentDataDisclosureAccepted()).toBe(false);
  });

  it('defaults the Auto Tags Agent prompt to unseen and persists a completed choice', async () => {
    const { state } = installChrome({
      gsm_config: { autoTagAgentPromptSeen: 'invalid' },
    });
    const { authStore, CONFIG_STORAGE_KEY } = await import('@/auth/auth-store');

    expect((await authStore.getConfig()).autoTagAgentPromptSeen).toBe(false);
    await authStore.update({ autoTagAgentPromptSeen: true });
    expect((await authStore.getConfig()).autoTagAgentPromptSeen).toBe(true);
    expect((state[CONFIG_STORAGE_KEY] as { autoTagAgentPromptSeen: boolean })
      .autoTagAgentPromptSeen).toBe(true);
  });

  it('binds disclosure acceptance to version/provider/canonical origin but not model or path', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');

    const acceptance = await authStore.acceptAgentDataDisclosure({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://RELAY.example.com:443/v1/chat/completions?ignored=1',
      acceptedAt: 123,
    });
    expect(acceptance).toEqual({
      version: 2,
      provider: 'custom-openai-compatible',
      origin: 'https://relay.example.com',
      acceptedAt: 123,
    });
    expect(await authStore.isAgentDataDisclosureAccepted({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/another/path',
    })).toBe(true);
    expect(await authStore.isAgentDataDisclosureAccepted({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com:8443/v1',
    })).toBe(false);
    expect(await authStore.isAgentDataDisclosureAccepted({
      provider: 'openai',
      baseUrl: null,
    })).toBe(false);
  });

  it('preserves disclosure accepted while provider-key encryption is in flight', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    let releaseEncryption!: (value: {
      cipher: string;
      meta: { iv: string; salt: string };
    }) => void;
    cryptoMocks.encrypt.mockImplementationOnce(() => new Promise((resolve) => {
      releaseEncryption = resolve;
    }));

    const saving = authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      apiKey: 'saved-secret',
    });
    await vi.waitFor(() => expect(cryptoMocks.encrypt).toHaveBeenCalledOnce());
    await authStore.acceptAgentDataDisclosure({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      acceptedAt: 10,
    });
    releaseEncryption({
      cipher: 'opaque-cipher:73617665642d736563726574',
      meta: { iv: 'iv', salt: 'salt' },
    });
    await saving;

    const config = await authStore.getConfig();
    expect(config.agentProvider).toEqual(expect.objectContaining({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
    }));
    expect(config.agentDataDisclosureAcceptance).toEqual({
      version: 2,
      provider: 'custom-openai-compatible',
      origin: 'https://relay.example.com',
      acceptedAt: 10,
    });
  });

  it('persists readiness only for the matching saved revision and invalidates it on capability changes', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'saved-secret',
    });
    const saved = await authStore.getConfig();

    expect(await authStore.recordAgentProviderCapability({
      provider: 'openai',
      baseUrl: null,
      model: 'gpt-5-mini',
      credentialSource: 'transient',
      credentialRevision: saved.agentProvider.credentialRevision,
      verifiedAt: 123,
    })).toBe(false);
    expect((await authStore.getConfig()).agentProvider.capability).toBeNull();

    expect(await authStore.recordAgentProviderCapability({
      provider: 'openai',
      baseUrl: null,
      model: 'gpt-5-mini',
      credentialSource: 'saved',
      credentialRevision: saved.agentProvider.credentialRevision,
      verifiedAt: 123,
    })).toBe(true);
    expect((await authStore.getAgentProviderReadiness()).capabilityReady).toBe(true);

    await authStore.updateAgentProviderConfig({ model: 'gpt-5' });
    const changed = await authStore.getAgentProviderReadiness();
    expect(changed.credentialEligible).toBe(true);
    expect(changed.capabilityReady).toBe(false);
  });

  it('persists Custom readiness against the exact declared and working windows', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 65_536,
      workingContextWindow: 32_768,
      apiKey: 'saved-secret',
    });
    const saved = await authStore.getConfig();

    expect(await authStore.recordAgentProviderCapability({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 65_536,
      workingContextWindow: 32_768,
      credentialSource: 'saved',
      credentialRevision: saved.agentProvider.credentialRevision,
      verifiedAt: 123,
    })).toBe(true);
    expect((await authStore.getAgentProviderReadiness()).capabilityReady).toBe(true);

    expect(await authStore.recordAgentProviderCapability({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 65_536,
      workingContextWindow: 16_384,
      credentialSource: 'saved',
      credentialRevision: saved.agentProvider.credentialRevision,
      verifiedAt: 124,
    })).toBe(false);
  });

  it('invalidates only the capability bound to the reported provider fingerprint', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'saved-secret',
    });
    const saved = await authStore.getConfig();
    await authStore.recordAgentProviderCapability({
      provider: 'openai',
      baseUrl: null,
      model: 'gpt-5-mini',
      credentialSource: 'saved',
      credentialRevision: saved.agentProvider.credentialRevision,
      verifiedAt: 123,
    });
    const fingerprint = (await authStore.getConfig()).agentProvider.capability?.fingerprint;
    expect(fingerprint).toMatch(/^pcf:v1:/);

    expect(await authStore.invalidateAgentProviderCapability(`pcf:v1:${'x'.repeat(43)}`))
      .toBe(false);
    expect((await authStore.getConfig()).agentProvider.capability).not.toBeNull();
    expect(await authStore.invalidateAgentProviderCapability(fingerprint!)).toBe(true);
    expect((await authStore.getConfig()).agentProvider.capability).toBeNull();
  });

  it('keeps a same-origin Custom key but invalidates capability when protocol changes', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      protocol: 'chat-completions',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      apiKey: 'saved-secret',
    });
    const saved = await authStore.getConfig();
    await authStore.recordAgentProviderCapability({
      provider: 'custom-openai-compatible',
      protocol: 'chat-completions',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      declaredContextWindow: 32_768,
      credentialSource: 'saved',
      credentialRevision: saved.agentProvider.credentialRevision,
      verifiedAt: 10,
    });

    await authStore.updateAgentProviderConfig({ protocol: 'responses' });
    const readiness = await authStore.getAgentProviderReadiness();
    expect(readiness.config.protocol).toBe('responses');
    expect(readiness.credentialEligible).toBe(true);
    expect(readiness.capabilityReady).toBe(false);
    expect(await authStore.getAgentApiKey()).toBe('saved-secret');
  });

  it.each([
    {
      name: 'provider',
      patch: { provider: 'openai' as const, protocol: null, baseUrl: null },
    },
    {
      name: 'canonical origin',
      patch: { baseUrl: 'https://other.example.com/v1' },
    },
  ])('clears saved credential material when the $name changes without a replacement key',
    async ({ patch }) => {
      installChrome();
      const { authStore } = await import('@/auth/auth-store');
      await authStore.updateAgentProviderConfig({
        provider: 'custom-openai-compatible',
        protocol: 'chat-completions',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        declaredContextWindow: 32_768,
        apiKey: 'saved-secret',
      });
      const saved = await authStore.getConfig();
      await authStore.recordAgentProviderCapability({
        provider: 'custom-openai-compatible',
        protocol: 'chat-completions',
        baseUrl: 'https://relay.example.com/v1',
        model: 'custom-model',
        declaredContextWindow: 32_768,
        credentialSource: 'saved',
        credentialRevision: saved.agentProvider.credentialRevision,
        verifiedAt: 10,
      });

      await authStore.updateAgentProviderConfig(patch);

      expect((await authStore.getConfig()).agentProvider).toEqual(expect.objectContaining({
        apiKeyEncrypted: null,
        apiKeyCryptoMeta: null,
        credentialScope: null,
        credentialRevision: null,
        capability: null,
      }));
      expect(await authStore.getAgentApiKey()).toBeNull();
    });

  it('invalidates an in-flight credential snapshot when the Custom protocol changes', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      protocol: 'chat-completions',
      baseUrl: 'https://relay.example.com/v1',
      model: 'custom-model',
      apiKey: 'saved-secret',
    });
    const snapshot = await authStore.getAgentProviderCredentialSnapshot();
    expect(snapshot).not.toBeNull();

    await authStore.updateAgentProviderConfig({ protocol: 'responses' });

    expect(await authStore.validateAgentProviderCredentialSnapshot(snapshot!)).toBe(false);
  });

  it('invalidates in-flight snapshots when Custom context settings change', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://relay.example.com/v1',
      model: 'gpt-5.4',
      declaredContextWindow: null,
      workingContextWindow: null,
      apiKey: 'saved-secret',
    });
    const automatic = await authStore.getAgentProviderCredentialSnapshot();
    expect(automatic).toEqual(expect.objectContaining({
      savedDeclaredContextWindow: null,
      savedWorkingContextWindow: null,
      contextCapability: expect.objectContaining({ contextWindow: 1_050_000 }),
    }));

    await authStore.updateAgentProviderConfig({ declaredContextWindow: 65_536 });
    expect(await authStore.validateAgentProviderCredentialSnapshot(automatic!)).toBe(false);

    const overridden = await authStore.getAgentProviderCredentialSnapshot();
    expect(overridden).toEqual(expect.objectContaining({
      savedDeclaredContextWindow: 65_536,
      savedWorkingContextWindow: null,
      contextCapability: expect.objectContaining({
        contextWindow: 65_536,
        source: 'user-declared',
      }),
    }));
    await authStore.updateAgentProviderConfig({ workingContextWindow: 32_768 });
    expect(await authStore.validateAgentProviderCredentialSnapshot(overridden!)).toBe(false);
  });

  it('clears scope, revision, plaintext cache, and capability with the key', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'openai',
      apiKey: 'saved-secret',
    });
    await authStore.clearAgentProviderApiKey();

    expect((await authStore.getConfig()).agentProvider).toEqual(expect.objectContaining({
      apiKeyEncrypted: null,
      apiKeyCryptoMeta: null,
      credentialScope: null,
      credentialRevision: null,
      capability: null,
    }));
    expect(await authStore.getAgentApiKey()).toBeNull();
  });

  it('rotates revision/cache on same-origin replacement and returns one atomic ready snapshot', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'first-secret',
    });
    const first = await authStore.getConfig();
    await authStore.recordAgentProviderCapability({
      provider: 'openai',
      baseUrl: null,
      model: 'gpt-5-mini',
      credentialSource: 'saved',
      credentialRevision: first.agentProvider.credentialRevision,
      verifiedAt: 10,
    });
    const ready = await authStore.getAgentProviderCredentialSnapshot();
    expect(ready).toEqual(expect.objectContaining({
      apiKey: 'first-secret',
      credentialRevision: first.agentProvider.credentialRevision,
      capabilityReady: true,
      completionEndpoint: 'https://api.openai.com/v1/responses',
      model: 'gpt-5-mini',
    }));

    await authStore.updateAgentProviderConfig({ apiKey: 'replacement-secret' });
    const replacement = await authStore.getAgentProviderCredentialSnapshot();
    expect(replacement).toEqual(expect.objectContaining({
      apiKey: 'replacement-secret',
      capabilityReady: false,
    }));
    expect(replacement?.credentialRevision).not.toBe(first.agentProvider.credentialRevision);
    expect(await authStore.validateAgentProviderCredentialSnapshot(ready!)).toBe(false);
    await authStore.clearAgentProviderApiKey();
    expect(await authStore.validateAgentProviderCredentialSnapshot(replacement!)).toBe(false);
  });

  it('does not let a transient test overwrite an existing saved capability', async () => {
    installChrome();
    const { authStore } = await import('@/auth/auth-store');
    await authStore.updateAgentProviderConfig({ apiKey: 'saved-secret' });
    const config = await authStore.getConfig();
    await authStore.recordAgentProviderCapability({
      provider: 'openai',
      baseUrl: null,
      model: config.agentProvider.model,
      credentialSource: 'saved',
      credentialRevision: config.agentProvider.credentialRevision,
      verifiedAt: 10,
    });
    const capability = (await authStore.getConfig()).agentProvider.capability;

    expect(await authStore.recordAgentProviderCapability({
      provider: 'openai',
      baseUrl: null,
      model: config.agentProvider.model,
      credentialSource: 'transient',
      credentialRevision: config.agentProvider.credentialRevision,
      verifiedAt: 20,
    })).toBe(false);
    expect((await authStore.getConfig()).agentProvider.capability).toEqual(capability);
  });

  it.each(['clear', 'replacement'] as const)(
    'does not resurrect credentials or capability when %s wins during fingerprinting',
    async (mutation) => {
      installChrome();
      const { authStore } = await import('@/auth/auth-store');
      await authStore.updateAgentProviderConfig({ apiKey: 'original-secret' });
      const original = await authStore.getConfig();
      let releaseDigest!: (value: ArrayBuffer) => void;
      const digestBarrier = new Promise<ArrayBuffer>((resolve) => {
        releaseDigest = resolve;
      });
      const digestSpy = vi.spyOn(crypto.subtle, 'digest')
        .mockImplementationOnce(() => digestBarrier);
      const pending = authStore.recordAgentProviderCapability({
        provider: 'openai',
        baseUrl: null,
        model: original.agentProvider.model,
        credentialSource: 'saved',
        credentialRevision: original.agentProvider.credentialRevision,
        verifiedAt: 30,
      });
      await vi.waitFor(() => expect(digestSpy).toHaveBeenCalledOnce());

      if (mutation === 'clear') {
        await authStore.clearAgentProviderApiKey();
      } else {
        await authStore.updateAgentProviderConfig({ apiKey: 'replacement-secret' });
      }
      releaseDigest(new Uint8Array(32).buffer);

      expect(await pending).toBe(false);
      const latest = (await authStore.getConfig()).agentProvider;
      expect(latest.capability).toBeNull();
      if (mutation === 'clear') {
        expect(latest.apiKeyEncrypted).toBeNull();
        expect(latest.credentialRevision).toBeNull();
      } else {
        expect(latest.apiKeyEncrypted).not.toBe(original.agentProvider.apiKeyEncrypted);
        expect(latest.credentialRevision).not.toBe(original.agentProvider.credentialRevision);
      }
      digestSpy.mockRestore();
    },
  );

  it('blocks saved custom origin A from probing origin B through the real auth gate', async () => {
    installChrome();
    const [{ authStore }, { createAgentProviderGate }] = await Promise.all([
      import('@/auth/auth-store'),
      import('@/background/agent-provider-gate'),
    ]);
    await authStore.updateAgentProviderConfig({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://origin-a.example/v1',
      model: 'custom-model',
      apiKey: 'saved-secret',
    });
    await authStore.acceptAgentDataDisclosure({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://origin-b.example/v1',
      acceptedAt: 1,
    });
    const fetchSpy = vi.fn();
    const gate = createAgentProviderGate({
      auth: authStore,
      hasHostPermission: vi.fn(async () => true),
      testConnection: async () => {
        await fetchSpy();
        throw new Error('unexpected probe');
      },
      createProvider: () => ({ generate: async () => ({ content: 'unused' }) }),
    });

    await expect(gate.testConnection({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://origin-b.example/v1',
      model: 'custom-model',
    })).rejects.toThrow('AGENT_API_KEY_EMPTY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks a legacy unscoped credential through the real auth gate', async () => {
    installChrome({
      gsm_config: {
        agentProvider: {
          provider: 'custom-openai-compatible',
          baseUrl: 'https://origin-a.example/v1',
          model: 'custom-model',
          apiKeyEncrypted: 'legacy-cipher',
          apiKeyCryptoMeta: { iv: 'iv', salt: 'salt' },
        },
      },
    });
    const [{ authStore }, { createAgentProviderGate }] = await Promise.all([
      import('@/auth/auth-store'),
      import('@/background/agent-provider-gate'),
    ]);
    await authStore.acceptAgentDataDisclosure({
      provider: 'custom-openai-compatible',
      baseUrl: 'https://origin-a.example/v1',
      acceptedAt: 1,
    });
    const fetchSpy = vi.fn();
    const gate = createAgentProviderGate({
      auth: authStore,
      hasHostPermission: vi.fn(async () => true),
      testConnection: async () => {
        await fetchSpy();
        throw new Error('unexpected probe');
      },
      createProvider: () => ({ generate: async () => ({ content: 'unused' }) }),
    });

    await expect(gate.testConnection({})).rejects.toThrow('AGENT_API_KEY_EMPTY');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cryptoMocks.decrypt).not.toHaveBeenCalled();
  });
});
