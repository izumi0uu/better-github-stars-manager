import {
  getProvider,
  resolveAgentProviderEndpoint,
} from '@/agent-harness/models';
import type {
  AgentProviderConnectionFailureDetails,
  AgentProviderConnectionResult,
} from '@/agent-harness/provider-registry';
import {
  scrubAgentProviderConnectionFailure,
  scrubRawCaptureText,
} from '@/agent-observability/redaction';
import type {
  AgentProviderConfig,
  AgentProviderId,
} from '@/types';
import {
  parseProviderDiagnosticsShare,
  type ProviderDiagnosticsShareV1,
} from './provider-diagnostics-bridge';

export type ProviderDebugHostAccess = 'checking' | 'built-in' | 'granted' | 'required';

export type ProviderDebugProbeState =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | {
      kind: 'success';
      startedAt: number;
      completedAt: number;
      result: AgentProviderConnectionResult;
    }
  | {
      kind: 'error';
      startedAt: number;
      completedAt: number;
      message: string;
      failure: AgentProviderConnectionFailureDetails | null;
    };

export type ProviderDebugSnapshot = Readonly<{
  provider: AgentProviderId;
  providerLabel: string;
  protocol: string;
  canonicalOrigin: string;
  canonicalBaseUrl: string;
  completionEndpoint: string;
  model: string;
  credentialState: 'saved' | 'missing';
  declaredContextWindow: number | null;
  workingContextWindow: number | null;
  capability: AgentProviderConfig['capability'];
}>;

export function createProviderDebugSnapshot(
  config: AgentProviderConfig,
): ProviderDebugSnapshot {
  const endpoint = resolveAgentProviderEndpoint(
    config.provider,
    config.baseUrl,
    config.protocol,
  );
  const credentialState = config.apiKeyEncrypted && config.apiKeyCryptoMeta
    ? 'saved'
    : 'missing';

  return Object.freeze({
    provider: config.provider,
    providerLabel: getProvider(config.provider).label,
    protocol: endpoint.profile.protocol,
    canonicalOrigin: endpoint.canonicalOrigin,
    canonicalBaseUrl: endpoint.canonicalBaseUrl,
    completionEndpoint: endpoint.completionEndpoint,
    model: config.model,
    credentialState,
    declaredContextWindow: config.declaredContextWindow ?? null,
    workingContextWindow: config.workingContextWindow ?? null,
    capability: config.capability,
  });
}

/** Deliberately excludes credentials: the background resolves the saved Key. */
export function createSavedProviderProbeRequest(config: AgentProviderConfig) {
  return {
    provider: config.provider,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: config.model,
    declaredContextWindow: config.declaredContextWindow ?? null,
    workingContextWindow: config.workingContextWindow ?? null,
  };
}

export function createProviderDiagnosticsShare(input: Readonly<{
  snapshot: ProviderDebugSnapshot;
  hostAccess: ProviderDebugHostAccess;
  probe: ProviderDebugProbeState;
  versionHash: string;
  generatedAt?: number;
}>): ProviderDiagnosticsShareV1 {
  const generatedAt = input.generatedAt ?? Date.now();
  const probe = input.probe;
  const report = parseProviderDiagnosticsShare({
    schemaVersion: 1,
    generatedAt,
    source: {
      versionHash: input.versionHash,
      runtime: 'chrome-extension',
    },
    privacy: {
      credentialsIncluded: false,
      rawCaptureIncluded: false,
      chatContentIncluded: false,
      providerResponseContentIncluded: false,
    },
    provider: {
      id: input.snapshot.provider,
      label: scrubRawCaptureText(input.snapshot.providerLabel, []).text,
      protocol: scrubRawCaptureText(input.snapshot.protocol, []).text,
      canonicalOrigin: scrubRawCaptureText(input.snapshot.canonicalOrigin, []).text,
      canonicalBaseUrl: scrubRawCaptureText(input.snapshot.canonicalBaseUrl, []).text,
      completionEndpoint: scrubRawCaptureText(input.snapshot.completionEndpoint, []).text,
      model: scrubRawCaptureText(input.snapshot.model, []).text,
      credentialState: input.snapshot.credentialState,
      hostAccess: input.hostAccess,
      declaredContextWindow: input.snapshot.declaredContextWindow,
      workingContextWindow: input.snapshot.workingContextWindow,
      capability: input.snapshot.capability ? {
        contextWindow: input.snapshot.capability.contextCapability?.contextWindow ?? null,
        source: input.snapshot.capability.contextCapability?.source ?? null,
        verifiedAt: input.snapshot.capability.verifiedAt,
        fingerprint: input.snapshot.capability.fingerprint,
      } : null,
    },
    probe: probe.kind === 'idle'
      ? { state: 'not_run', startedAt: null, completedAt: null, latencyMs: null, failure: null }
      : probe.kind === 'running'
        ? { state: 'running', startedAt: probe.startedAt, completedAt: null, latencyMs: null, failure: null }
        : probe.kind === 'success'
          ? {
              state: 'succeeded',
              startedAt: probe.startedAt,
              completedAt: probe.completedAt,
              latencyMs: probe.result.latencyMs,
              failure: null,
            }
          : {
              state: 'failed',
              startedAt: probe.startedAt,
              completedAt: probe.completedAt,
              latencyMs: Math.max(0, probe.completedAt - probe.startedAt),
              failure: scrubAgentProviderConnectionFailure(probe.failure ?? {
                schemaVersion: 1,
                phase: 'unknown',
                code: 'unknown_error',
                status: null,
                message: probe.message.slice(0, 1_024) || 'Provider connection test failed.',
              }, []),
            },
  });
  if (!report) throw new TypeError('Provider diagnostics projection was invalid.');
  return report;
}

export function readProviderConnectionFailureDetails(
  value: unknown,
): AgentProviderConnectionFailureDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AgentProviderConnectionFailureDetails>;
  if (
    candidate.schemaVersion !== 1
    || ![
      'configuration',
      'permission',
      'identity',
      'tool_request',
      'tool_acknowledgement',
      'unknown',
    ].includes(String(candidate.phase))
    || typeof candidate.code !== 'string'
    || !candidate.code
    || candidate.code.length > 128
    || (candidate.status !== null && (
      !Number.isInteger(candidate.status)
      || Number(candidate.status) < 100
      || Number(candidate.status) > 599
    ))
    || typeof candidate.message !== 'string'
    || !candidate.message
    || candidate.message.length > 1_024
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    phase: candidate.phase as AgentProviderConnectionFailureDetails['phase'],
    code: candidate.code,
    status: candidate.status ?? null,
    message: candidate.message,
  });
}


