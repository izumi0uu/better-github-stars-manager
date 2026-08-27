import {
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_PROVIDER_ORIGIN_MISMATCH,
} from '@/api/errors';
import type { AgentProviderId } from '@/types';
import { resolveAgentProviderEndpoint } from './models';

export type AgentProviderHostAccess = Readonly<{
  kind: 'optional';
  canonicalOrigin: string;
  permissionPattern: string;
}>;

export type AgentHostPermissions = {
  contains(details: { origins: string[] }): Promise<boolean>;
  request(details: { origins: string[] }): Promise<boolean>;
};

/**
 * Every provider origin is optional. Only GitHub is a required host permission,
 * so a user who never configures Cubby is never asked to grant a model provider
 * — including the built-in ones.
 */
export function getAgentProviderHostAccess(
  provider: AgentProviderId,
  baseUrl: string | null | undefined,
): AgentProviderHostAccess {
  const endpoint = resolveAgentProviderEndpoint(provider, baseUrl);
  const originUrl = new URL(endpoint.canonicalOrigin);
  return Object.freeze({
    kind: 'optional',
    canonicalOrigin: endpoint.canonicalOrigin,
    permissionPattern: `${originUrl.protocol}//${originUrl.hostname}/*`,
  });
}

export async function hasAgentProviderHostPermission(
  provider: AgentProviderId,
  baseUrl: string | null | undefined,
  permissions?: Pick<AgentHostPermissions, 'contains'>,
): Promise<boolean> {
  const access = getAgentProviderHostAccess(provider, baseUrl);
  return (permissions ?? chrome.permissions)
    .contains({ origins: [access.permissionPattern] })
    .catch(() => false);
}

export async function requestAgentProviderHostPermission(
  provider: AgentProviderId,
  baseUrl: string | null | undefined,
  permissions: AgentHostPermissions = chrome.permissions,
): Promise<void> {
  const access = getAgentProviderHostAccess(provider, baseUrl);
  if (await permissions.contains({ origins: [access.permissionPattern] })) return;
  if (!await permissions.request({ origins: [access.permissionPattern] })) {
    throw new Error(AGENT_HOST_PERMISSION_DENIED);
  }
}

export function assertAgentProviderExactOrigin(
  expectedCanonicalOrigin: string,
  contactedEndpoint: string,
): void {
  let contactedOrigin: string;
  try {
    contactedOrigin = new URL(contactedEndpoint).origin;
  } catch {
    throw new Error(AGENT_PROVIDER_ORIGIN_MISMATCH);
  }
  if (contactedOrigin !== expectedCanonicalOrigin) {
    throw new Error(AGENT_PROVIDER_ORIGIN_MISMATCH);
  }
}
