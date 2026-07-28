import { describe, expect, it } from 'vitest';
import type { AgentProviderConfig } from '@/types';
import {
  createProviderDebugSnapshot,
  createProviderDiagnosticsShare,
  createSavedProviderProbeRequest,
  readProviderConnectionFailureDetails,
} from '@/dev-agent/provider-debug';
import {
  parseProviderDiagnosticsMonitorEvent,
  parseProviderDiagnosticsShare,
} from '@/dev-agent/provider-diagnostics-bridge';

const providerConfig: AgentProviderConfig = {
  provider: 'custom-openai-compatible',
  protocol: 'responses',
  baseUrl: 'https://proxy.example.com/v1/',
  model: 'gpt-5.4',
  declaredContextWindow: 272_000,
  workingContextWindow: 128_000,
  apiKeyEncrypted: 'ciphertext-must-not-leak',
  apiKeyCryptoMeta: { iv: 'iv', salt: 'salt' },
  credentialScope: {
    provider: 'custom-openai-compatible',
    origin: 'https://proxy.example.com',
  },
  credentialRevision: 'credential-revision',
  capability: null,
};

describe('Provider diagnostics projection', () => {
  it('projects only non-secret Provider evidence and canonicalizes the endpoint', () => {
    const snapshot = createProviderDebugSnapshot(providerConfig);

    expect(snapshot).toEqual(expect.objectContaining({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      canonicalOrigin: 'https://proxy.example.com',
      canonicalBaseUrl: 'https://proxy.example.com/v1',
      completionEndpoint: 'https://proxy.example.com/v1/responses',
      credentialState: 'saved',
      declaredContextWindow: 272_000,
      workingContextWindow: 128_000,
    }));
    expect(JSON.stringify(snapshot)).not.toContain('ciphertext-must-not-leak');
    expect(JSON.stringify(snapshot)).not.toContain('credential-revision');
  });

  it('creates a saved-credential probe request without an API key field', () => {
    expect(createSavedProviderProbeRequest(providerConfig)).toEqual({
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: 'https://proxy.example.com/v1/',
      model: 'gpt-5.4',
      declaredContextWindow: 272_000,
      workingContextWindow: 128_000,
    });
  });

  it('creates a bounded Agent share without credentials or Provider response content', () => {
    const secret = 'sk-auditsecret1234567890';
    const report = createProviderDiagnosticsShare({
      snapshot: {
        ...createProviderDebugSnapshot(providerConfig),
        canonicalBaseUrl: `https://proxy.example.com/v1/${secret}`,
        completionEndpoint: `https://proxy.example.com/v1/${secret}/responses`,
        model: `model-${secret}`,
      },
      hostAccess: 'granted',
      versionHash: 'test-build',
      generatedAt: 100,
      probe: {
        kind: 'error',
        startedAt: 10,
        completedAt: 90,
        message: 'localized failure',
        failure: {
          schemaVersion: 1,
          phase: 'tool_request',
          code: 'http_error',
          status: 400,
          message: `AI provider rejected key ${secret}.`,
        },
      },
    });

    expect(report.probe).toEqual(expect.objectContaining({
      state: 'failed',
      latencyMs: 80,
      failure: expect.objectContaining({ phase: 'tool_request', status: 400 }),
    }));
    expect(report.privacy).toEqual({
      credentialsIncluded: false,
      rawCaptureIncluded: false,
      chatContentIncluded: false,
      providerResponseContentIncluded: false,
    });
    expect(JSON.stringify(report)).not.toContain('ciphertext-must-not-leak');
    expect(JSON.stringify(report)).not.toContain('credential-revision');
    expect(JSON.stringify(report)).not.toContain('localized failure');
    expect(JSON.stringify(report)).toContain('[REDACTED]');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('reprojects bridge input so unknown secret-shaped fields cannot be retained', () => {
    const report = createProviderDiagnosticsShare({
      snapshot: createProviderDebugSnapshot(providerConfig),
      hostAccess: 'granted',
      versionHash: 'test-build',
      generatedAt: 100,
      probe: { kind: 'idle' },
    });
    const parsed = parseProviderDiagnosticsShare({
      ...report,
      apiKey: 'must-not-survive',
      provider: { ...report.provider, authorization: 'must-not-survive' },
    });

    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive');
  });

  it('reprojects monitor event data through a kind-specific allowlist', () => {
    const parsed = parseProviderDiagnosticsMonitorEvent({
      schemaVersion: 1,
      sessionId: 'provider-monitor:test',
      emittedAt: 100,
      kind: 'provider_error',
      rootOperationId: 'agent-turn:test',
      requestId: 'provider-request:test',
      data: {
        requestKind: 'turn',
        providerStep: 0,
        requestAttempt: 1,
        code: 'http_error',
        status: 429,
        retryable: true,
        overflow: false,
        authorization: 'must-not-survive',
        responseBody: 'must-not-survive',
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.data).toEqual({
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      code: 'http_error',
      status: 429,
      retryable: true,
      overflow: false,
    });
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive');
  });

  it('accepts only the structured background failure shape', () => {
    expect(readProviderConnectionFailureDetails({
      schemaVersion: 1,
      phase: 'tool_acknowledgement',
      code: 'protocol_error',
      status: null,
      message: 'The provider returned an invalid probe acknowledgement.',
    })).toEqual(expect.objectContaining({
      phase: 'tool_acknowledgement',
      code: 'protocol_error',
    }));
    expect(readProviderConnectionFailureDetails({
      schemaVersion: 1,
      phase: 'tool_acknowledgement',
      code: 'protocol_error',
      status: null,
      message: '',
    })).toBeNull();
  });
});
