import { authStore } from '@/auth/auth-store';
import {
  describeAgentProviderConnectionFailure,
  type AgentExecutionTraceEvent,
  type AgentProviderConnectionFailureDetails,
  type AgentProviderConnectionResult,
} from '@/agent-harness';
import {
  getAgentProviderHostAccess,
  hasAgentProviderHostPermission,
} from '@/agent-harness/provider-access';
import { VERSION_HASH } from '@/dev';
import {
  createProviderDebugSnapshot,
  createProviderDiagnosticsShare,
  type ProviderDebugProbeState,
} from '@/dev-agent/provider-debug';
import { createProviderDiagnosticsMonitor } from './provider-monitor';
import { scrubAgentProviderConnectionFailure } from './redaction';

export type ProviderDiagnosticsRuntime = Readonly<{
  monitor: ReturnType<typeof createProviderDiagnosticsMonitor>;
  recordConfigurationChanged(): void;
  recordProbeStarted(requestId: string, startedAt: number): Promise<void>;
  recordProbeSucceeded(
    requestId: string,
    startedAt: number,
    result: AgentProviderConnectionResult,
  ): void;
  recordProbeFailure(requestId: string, startedAt: number, error: unknown): void;
  observeExecutionEvent(rootOperationId: string, event: AgentExecutionTraceEvent): void;
}>;

/** Owns the Provider monitor's development-only projection and lifecycle hooks. */
export function createProviderDiagnosticsRuntime(): ProviderDiagnosticsRuntime {
  const createCurrentReport = async (probe: ProviderDebugProbeState) => {
    const config = (await authStore.getConfig()).agentProvider;
    const snapshot = createProviderDebugSnapshot(config);
    const access = getAgentProviderHostAccess(config.provider, config.baseUrl);
    const hostAccess = access.kind === 'required'
      ? 'built-in'
      : await hasAgentProviderHostPermission(config.provider, config.baseUrl)
        ? 'granted'
        : 'required';
    return createProviderDiagnosticsShare({
      snapshot,
      hostAccess,
      probe,
      versionHash: VERSION_HASH,
    });
  };
  const monitor = createProviderDiagnosticsMonitor({
    storage: chrome.storage.session,
    getCurrentReport: () => createCurrentReport({ kind: 'idle' }),
  });

  return Object.freeze({
    monitor,

    recordConfigurationChanged() {
      void createCurrentReport({ kind: 'idle' })
        .then((report) => monitor.recordConfigurationChanged(report))
        .catch(() => undefined);
    },

    recordProbeStarted(requestId, startedAt) {
      return createCurrentReport({ kind: 'running', startedAt })
        .then((report) => {
          monitor.recordProbeStarted({ requestId, report });
          return monitor.flush();
        })
        .catch(() => undefined);
    },

    recordProbeSucceeded(requestId, startedAt, result) {
      const completedAt = Date.now();
      void createCurrentReport({
        kind: 'success',
        startedAt,
        completedAt,
        result,
      }).then((report) => {
        monitor.recordProbeSucceeded({
          requestId,
          report,
          providerLabel: result.providerLabel,
          model: result.model,
          completionEndpoint: result.completionEndpoint,
          latencyMs: result.latencyMs,
        });
      }).catch(() => undefined);
    },

    recordProbeFailure(requestId, startedAt, error) {
      const completedAt = Date.now();
      const failure = describeAgentProviderConnectionFailure(error);
      // failure.message can echo provider-supplied error text; scrub configured
      // secrets and known credential patterns before it crosses to the bridge.
      void scrubFailureDetails(failure)
        .then((scrubbed) => createCurrentReport({
          kind: 'error',
          startedAt,
          completedAt,
          message: scrubbed.message,
          failure: scrubbed,
        }).then((report) => {
          monitor.recordProbeFailed({
            requestId,
            report,
            latencyMs: Math.max(0, completedAt - startedAt),
            phase: scrubbed.phase,
            code: scrubbed.code,
            status: scrubbed.status,
            message: scrubbed.message,
          });
        }))
        .catch(() => undefined);
    },

    observeExecutionEvent(rootOperationId, event) {
      monitor.observeExecutionEvent(rootOperationId, event);
    },
  });
}

async function scrubFailureDetails(
  failure: AgentProviderConnectionFailureDetails,
): Promise<AgentProviderConnectionFailureDetails> {
  const settledSecrets = await Promise.allSettled([
    authStore.getToken(),
    authStore.getWatchNotificationsToken(),
    authStore.getAgentApiKey(),
  ]);
  const secrets = settledSecrets.flatMap((result) => (
    result.status === 'fulfilled' && result.value ? [result.value] : []
  ));
  return scrubAgentProviderConnectionFailure(failure, secrets);
}
