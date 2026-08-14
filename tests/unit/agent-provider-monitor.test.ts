import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderDiagnosticsMonitor } from '@/agent-observability/provider-monitor';
import { createProviderDiagnosticsRuntime } from '@/agent-observability/provider-monitor-runtime';
import { AgentProviderError, type AgentExecutionTraceEvent } from '@/agent-harness';
import { authStore } from '@/auth/auth-store';
import type { ProviderDiagnosticsShare } from '@/dev-agent/provider-diagnostics-bridge';
import type { AgentProviderConfig, Config } from '@/types';

vi.mock('@/auth/auth-store', () => ({
  authStore: {
    getConfig: vi.fn(),
    getToken: vi.fn(),
    getAgentApiKey: vi.fn(),
  },
}));

describe('Provider diagnostics monitor', () => {
  it('persists a session and publishes ordered, content-free Provider lifecycle events', async () => {
    const stored = new Map<string, unknown>();
    const posts: unknown[] = [];
    let now = 100;
    const monitor = createProviderDiagnosticsMonitor({
      storage: storage(stored),
      now: () => now++,
      fetchImpl: vi.fn(async (_input, init) => {
        posts.push(JSON.parse(String(init?.body)) as unknown);
        return new Response('{}', { status: 202 });
      }),
      getCurrentReport: async () => report(),
    });

    await monitor.start({
      sessionId: 'provider-monitor:test',
      startedAt: 100,
      expiresAt: 10_000,
    });
    monitor.recordProbeStarted({ requestId: 'probe:test', report: report() });
    monitor.observeExecutionEvent('agent-turn:test', preparedEvent());
    monitor.observeExecutionEvent('agent-turn:test', streamEvent('text', 32));
    monitor.observeExecutionEvent('agent-turn:test', streamEvent('tool_arguments', 16));
    monitor.observeExecutionEvent('agent-turn:test', usageEvent());
    monitor.observeExecutionEvent('agent-turn:test', finishedEvent());
    await monitor.flush();

    expect(stored.has('bgsm_provider_diagnostics_monitor')).toBe(true);
    expect(posts.map((value) => (value as { event: { kind: string } }).event.kind)).toEqual([
      'probe_started',
      'provider_request_prepared',
      'provider_stream_activity',
      'provider_usage',
      'provider_finished',
    ]);
    const serialized = JSON.stringify(posts);
    expect(serialized).toContain('"textBytes":32');
    expect(serialized).toContain('"toolArgumentBytes":16');
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('Authorization');
  });

  it('associates whole-library analysis requests with their durable job root', async () => {
    const posts: unknown[] = [];
    const monitor = createProviderDiagnosticsMonitor({
      storage: storage(new Map()),
      now: () => 100,
      fetchImpl: vi.fn(async (_input, init) => {
        posts.push(JSON.parse(String(init?.body)) as unknown);
        return new Response('{}', { status: 202 });
      }),
    });
    await monitor.start({
      sessionId: 'provider-monitor:organize',
      startedAt: 100,
      expiresAt: 10_000,
    });
    monitor.observeExecutionEvent('organize-job:test', {
      ...preparedEvent(),
      requestKind: 'organize_analysis',
      providerStep: null,
    });
    await monitor.flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      event: {
        rootOperationId: 'organize-job:test',
        kind: 'provider_request_prepared',
        data: { requestKind: 'organize_analysis', providerStep: null },
      },
    });
  });

  it('expires session state without publishing another event', async () => {
    const stored = new Map<string, unknown>();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    let now = 100;
    const monitor = createProviderDiagnosticsMonitor({
      storage: storage(stored),
      now: () => now,
      fetchImpl,
    });
    await monitor.start({
      sessionId: 'provider-monitor:expired',
      startedAt: 100,
      expiresAt: 200,
    });
    now = 201;
    monitor.recordConfigurationChanged(report());
    await monitor.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await monitor.status()).toBeNull();
    expect(stored.has('bgsm_provider_diagnostics_monitor')).toBe(false);
  });

  it('recovers a restarted localhost bridge once with a fresh bounded report', async () => {
    const stored = new Map<string, unknown>();
    const posts: unknown[] = [];
    const fetchImpl = vi.fn(async (_input, init) => {
      posts.push(JSON.parse(String(init?.body)) as unknown);
      return new Response('{}', { status: posts.length === 1 ? 409 : 202 });
    });
    const monitor = createProviderDiagnosticsMonitor({
      storage: storage(stored),
      now: () => 100,
      fetchImpl,
      getCurrentReport: async () => report(),
    });
    await monitor.start({
      sessionId: 'provider-monitor:recovery',
      startedAt: 100,
      expiresAt: 10_000,
    });
    monitor.observeExecutionEvent('agent-turn:recovery', preparedEvent());
    await monitor.flush();

    expect(posts).toHaveLength(2);
    expect((posts[0] as { report?: unknown }).report).toBeUndefined();
    expect((posts[1] as { report?: unknown }).report).toEqual(report());
    expect(await monitor.status()).not.toBeNull();
  });

  it('does not let a stale 409 recovery replace a newly started session', async () => {
    const stored = new Map<string, unknown>();
    const posts: Array<{ sessionId: string }> = [];
    let resolveOldRequest!: (response: Response) => void;
    const oldRequest = new Promise<Response>((resolve) => {
      resolveOldRequest = resolve;
    });
    const fetchImpl = vi.fn(async (_input, init) => {
      const post = JSON.parse(String(init?.body)) as { sessionId: string };
      posts.push(post);
      return posts.length === 1 ? oldRequest : new Response('{}', { status: 202 });
    });
    const monitor = createProviderDiagnosticsMonitor({
      storage: storage(stored),
      now: () => 100,
      fetchImpl,
      getCurrentReport: async () => report(),
    });
    await monitor.start({
      sessionId: 'provider-monitor:old',
      startedAt: 100,
      expiresAt: 10_000,
    });
    monitor.observeExecutionEvent('agent-turn:old', preparedEvent());
    await Promise.resolve();
    await monitor.stop();
    await monitor.start({
      sessionId: 'provider-monitor:new',
      startedAt: 100,
      expiresAt: 10_000,
    });
    resolveOldRequest(new Response('{}', { status: 409 }));
    await monitor.flush();

    expect(posts.map((post) => post.sessionId)).toEqual(['provider-monitor:old']);
    expect(await monitor.status()).toEqual({
      sessionId: 'provider-monitor:new',
      startedAt: 100,
      expiresAt: 10_000,
    });
    expect(stored.get('bgsm_provider_diagnostics_monitor')).toEqual({
      sessionId: 'provider-monitor:new',
      startedAt: 100,
      expiresAt: 10_000,
    });

    monitor.observeExecutionEvent('agent-turn:new', preparedEvent());
    await monitor.flush();
    expect(posts.map((post) => post.sessionId)).toEqual([
      'provider-monitor:old',
      'provider-monitor:new',
    ]);
  });
});

describe('Provider diagnostics runtime probe scrubbing', () => {
  const providerConfig: AgentProviderConfig = {
    provider: 'custom-openai-compatible',
    protocol: 'responses',
    baseUrl: 'https://relay.example.com/v1',
    model: 'custom-model',
    declaredContextWindow: 100_000,
    workingContextWindow: 80_000,
    apiKeyEncrypted: 'ciphertext-must-not-leak',
    apiKeyCryptoMeta: { iv: 'iv', salt: 'salt' },
    credentialScope: {
      provider: 'custom-openai-compatible',
      origin: 'https://relay.example.com',
    },
    credentialRevision: 'credential-revision',
    capability: null,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('scrubs the configured main GitHub token and agent key', async () => {
    const stored = new Map<string, unknown>();
    const posts: string[] = [];
    const mainToken = 'configured-main-token-value';
    const agentApiKey = 'agent-key-value-123';
    vi.mocked(authStore.getToken).mockResolvedValue(mainToken);
    vi.mocked(authStore.getAgentApiKey).mockResolvedValue(agentApiKey);
    vi.mocked(authStore.getConfig).mockResolvedValue({
      agentProvider: providerConfig,
    } as Partial<Config> as Config);
    vi.stubGlobal('chrome', {
      storage: { session: storage(stored) },
      permissions: { contains: vi.fn(async () => true) },
    });
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.body !== undefined) posts.push(String(init.body));
      return new Response('{}', { status: 202 });
    }));
    const runtime = createProviderDiagnosticsRuntime();
    await runtime.monitor.start({
      sessionId: 'provider-monitor:scrub',
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    posts.length = 0;
    runtime.recordProbeFailure('probe:scrub', Date.now(), new AgentProviderError(
      'http_error',
      `HTTP 401: keys ${mainToken} and ${agentApiKey} rejected; header Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456`,
      401,
    ));
    await vi.waitFor(() => {
      expect(posts.some((body) => body.includes('probe_failed'))).toBe(true);
    });
    await runtime.monitor.flush();
    const serialized = posts.join('\n');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain(mainToken);
    expect(serialized).not.toContain(agentApiKey);
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });
});

function storage(values: Map<string, unknown>) {
  return {
    async get(key: string) {
      return { [key]: values.get(key) };
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
}

function report(): ProviderDiagnosticsShare {
  return {
    schemaVersion: 1,
    generatedAt: 100,
    source: { versionHash: 'test-build', runtime: 'chrome-extension' },
    privacy: {
      credentialsIncluded: false,
      rawCaptureIncluded: false,
      chatContentIncluded: false,
      providerResponseContentIncluded: false,
    },
    provider: {
      id: 'custom-openai-compatible',
      label: 'Custom OpenAI-compatible',
      protocol: 'responses',
      canonicalOrigin: 'https://relay.example.com',
      canonicalBaseUrl: 'https://relay.example.com/v1',
      completionEndpoint: 'https://relay.example.com/v1/responses',
      model: 'custom-model',
      credentialState: 'saved',
      hostAccess: 'granted',
      declaredContextWindow: 100_000,
      workingContextWindow: 80_000,
      capability: null,
    },
    probe: {
      state: 'not_run',
      startedAt: null,
      completedAt: null,
      latencyMs: null,
      failure: null,
    },
  };
}

function preparedEvent(): Extract<AgentExecutionTraceEvent, { kind: 'provider_request_prepared' }> {
  return {
    kind: 'provider_request_prepared',
    requestId: 'provider-request:test',
    requestKind: 'turn',
    providerStep: 0,
    requestAttempt: 1,
    providerClass: 'custom',
    protocol: 'responses',
    modelCapabilityRevision: 'capability:test',
    requestBytes: 4_096,
    historyBytes: 2_048,
    estimatedInputTokens: 1_024,
    maxOutputTokens: 512,
  };
}

function streamEvent(
  streamClass: 'text' | 'tool_arguments',
  utf8Bytes: number,
): AgentExecutionTraceEvent {
  return {
    kind: 'provider_stream_item',
    requestId: 'provider-request:test',
    requestKind: 'turn',
    providerStep: 0,
    requestAttempt: 1,
    streamClass,
    utf8Bytes,
  };
}

function usageEvent(): AgentExecutionTraceEvent {
  return {
    kind: 'provider_usage',
    requestId: 'provider-request:test',
    requestKind: 'turn',
    providerStep: 0,
    requestAttempt: 1,
    inputTokens: 1_024,
    outputTokens: 64,
    totalTokens: 1_088,
    source: 'provider',
  };
}

function finishedEvent(): AgentExecutionTraceEvent {
  return {
    kind: 'provider_finished',
    requestId: 'provider-request:test',
    requestKind: 'turn',
    providerStep: 0,
    requestAttempt: 1,
    finishReason: 'stop',
    durationMs: 250,
  };
}
