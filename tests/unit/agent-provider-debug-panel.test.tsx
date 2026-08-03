/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderDebugPanel } from '@/dev-agent/ProviderDebugPanel';
import { authStore } from '@/auth/auth-store';
import type { AgentProviderConfig } from '@/types';
import { cleanupMountedRootsAndBody, mountReact, type MountedRoot } from './test-utils';

vi.mock('@/auth/auth-store', () => ({
  authStore: {
    getConfig: vi.fn(),
  },
}));

const mountedRoots: MountedRoot[] = [];
const providerMonitorRequests: Array<Record<string, unknown>> = [];
let providerMonitorState: Record<string, unknown> | null = null;
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

beforeEach(() => {
  providerMonitorRequests.length = 0;
  providerMonitorState = null;
  vi.mocked(authStore.getConfig).mockResolvedValue({
    agentProvider: providerConfig,
  } as Awaited<ReturnType<typeof authStore.getConfig>>);
  vi.stubGlobal('chrome', {
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
    },
    runtime: {
      sendMessage: vi.fn(async () => {
        return {
          ok: false,
          error: 'AI provider returned an invalid response.',
          details: {
            schemaVersion: 1,
            phase: 'tool_request',
            code: 'protocol_error',
            status: null,
            message: 'The provider did not complete the named tool capability probe.',
          },
        };
      }),
      connect: vi.fn(() => createProviderMonitorControlPort()),
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    const report = JSON.parse(String(init?.body)) as unknown;
    return {
      ok: true,
      status: 201,
      json: async () => ({
        bridgeVersion: 2,
        sessionId: 'provider-monitor:test-session',
        startedAt: 100,
        receivedAt: 100,
        updatedAt: 100,
        expiresAt: 1_000,
        eventCount: 1,
        droppedEventCount: 0,
        report,
        latestEvent: {
          sequence: 1,
          receivedAt: 100,
          event: {
            schemaVersion: 1,
            sessionId: 'provider-monitor:test-session',
            emittedAt: 100,
            kind: 'monitor_started',
            rootOperationId: null,
            requestId: null,
            data: {},
          },
        },
      }),
    };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('Provider Debug panel', () => {
  it('shows the structured probe failure stage returned by the background', async () => {
    const container = mountReact(<ProviderDebugPanel />, mountedRoots);
    await flushEffects();
    const testButton = container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-test-provider"]')!;

    await act(async () => {
      testButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const error = container.querySelector('[data-testid="agent-diagnostics-provider-error"]')!;
    expect(error.textContent).toContain('tool_request');
    expect(error.textContent).toContain('protocol_error');
  });

  it('publishes and revokes a credential-free loopback report only after user action', async () => {
    const container = mountReact(<ProviderDebugPanel />, mountedRoots);
    await flushEffects();
    expect(fetch).not.toHaveBeenCalled();
    const shareButton = container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-share-provider"]')!;

    await act(async () => {
      shareButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ['http://127.0.0.1/*'],
    });
    const publishCall = vi.mocked(fetch).mock.calls[0]!;
    expect(String(publishCall[0])).toBe('http://127.0.0.1:5173/__bgsm/diagnostics/provider/latest');
    expect(publishCall[1]?.method).toBe('POST');
    const serialized = String(publishCall[1]?.body);
    expect(serialized).toContain('"credentialsIncluded":false');
    expect(serialized).not.toContain('ciphertext-must-not-leak');
    expect(serialized).not.toContain('credential-revision');
    expect(container.querySelector('[data-testid="agent-diagnostics-provider-shared"]')).not.toBeNull();
    expect(providerMonitorRequests).toContainEqual(expect.objectContaining({
      type: 'start_provider_monitor',
      state: expect.objectContaining({ sessionId: 'provider-monitor:test-session' }),
    }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-diagnostics-stop-provider-share"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.method).toBe('DELETE');
    expect(providerMonitorRequests).toContainEqual(expect.objectContaining({
      type: 'stop_provider_monitor',
    }));
  });
});

function createProviderMonitorControlPort() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const emit = (message: unknown) => {
    for (const listener of messageListeners) listener(message);
  };
  queueMicrotask(() => emit({ version: 1, type: 'ready', port: 'control' }));
  return {
    postMessage(request: Record<string, unknown>) {
      providerMonitorRequests.push(request);
      queueMicrotask(() => {
        if (request.type === 'start_provider_monitor') {
          providerMonitorState = request.state as Record<string, unknown>;
          emit({
            version: 1,
            requestId: request.requestId,
            type: 'control_result',
            action: 'provider_monitor_started',
            state: providerMonitorState,
          });
          return;
        }
        if (request.type === 'stop_provider_monitor') {
          providerMonitorState = null;
          emit({
            version: 1,
            requestId: request.requestId,
            type: 'control_result',
            action: 'provider_monitor_stopped',
          });
          return;
        }
        emit({
          version: 1,
          requestId: request.requestId,
          type: 'control_result',
          action: 'provider_monitor_status',
          state: providerMonitorState,
        });
      });
    },
    disconnect() {},
    onMessage: {
      addListener(listener: (message: unknown) => void) {
        messageListeners.push(listener);
      },
    },
    onDisconnect: {
      addListener(listener: () => void) {
        disconnectListeners.push(listener);
      },
    },
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
