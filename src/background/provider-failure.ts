import { describeAgentProviderConnectionFailure } from '@/agent-harness';
import { scrubAgentProviderConnectionFailure } from '@/agent-observability/redaction';
import { authStore } from '@/auth/auth-store';

/**
 * A provider failure may echo the request, so the description is scrubbed of
 * every locally held secret before it reaches a surface or a diagnostics record.
 */
export async function describeSafeAgentProviderConnectionFailure(error: unknown) {
  const failure = describeAgentProviderConnectionFailure(error);
  const settledSecrets = await Promise.allSettled([
    authStore.getToken(),
    authStore.getAgentApiKey(),
  ]);
  const secrets = settledSecrets.flatMap((result) => (
    result.status === "fulfilled" && result.value ? [result.value] : []
  ));
  return scrubAgentProviderConnectionFailure(failure, secrets);
}
