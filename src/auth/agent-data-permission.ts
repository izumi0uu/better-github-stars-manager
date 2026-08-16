/** Firefox's optional declaration for Cubby's personal-communications traffic. */
export const AGENT_PERSONAL_COMMUNICATIONS_DATA_COLLECTION = Object.freeze([
  'personalCommunications',
] as const);

type DataCollectionDetails = {
  data_collection: readonly ['personalCommunications'];
};

export type AgentDataCollectionPermissions = {
  contains(details: DataCollectionDetails): Promise<boolean>;
  request(details: DataCollectionDetails): Promise<boolean>;
};

export type AgentDataCollectionPermissionResult = 'granted' | 'denied' | 'not_applicable';
export type AgentPermissionBrowserTarget = 'chrome' | 'firefox';

/** Synchronous manifest identity keeps the request inside the user action. */
export function resolveAgentPermissionBrowserTarget(
  target?: AgentPermissionBrowserTarget,
): AgentPermissionBrowserTarget | 'unknown' {
  if (target) return target;
  try {
    const manifest = chrome.runtime.getManifest() as chrome.runtime.ManifestV3 & {
      browser_specific_settings?: { gecko?: unknown };
    };
    return manifest.browser_specific_settings?.gecko ? 'firefox' : 'chrome';
  } catch {
    return 'unknown';
  }
}

function permissionApi(
  permissions?: AgentDataCollectionPermissions,
): AgentDataCollectionPermissions | null {
  if (permissions) return permissions;
  const candidate = chrome.permissions as unknown as Partial<AgentDataCollectionPermissions>;
  return typeof candidate?.contains === 'function' && typeof candidate.request === 'function'
    ? candidate as AgentDataCollectionPermissions
    : null;
}

function permissionDetails(): DataCollectionDetails {
  return { data_collection: AGENT_PERSONAL_COMMUNICATIONS_DATA_COLLECTION };
}

/**
 * Checks the optional Firefox permission without touching unsupported Chrome
 * permission shapes.
 */
export async function hasAgentPersonalCommunicationsPermission(
  target?: AgentPermissionBrowserTarget,
  permissions?: Pick<AgentDataCollectionPermissions, 'contains'>,
): Promise<boolean> {
  const browserTarget = resolveAgentPermissionBrowserTarget(target);
  if (browserTarget === 'chrome') return true;
  if (browserTarget !== 'firefox') return false;
  const api = permissions ?? permissionApi();
  if (!api) return false;
  try {
    return await api.contains(permissionDetails());
  } catch {
    return false;
  }
}

/**
 * Called directly by the explicit disclosure button. The Firefox request is
 * started before any asynchronous work, then verified through `contains`.
 */
export async function requestAgentPersonalCommunicationsPermission(
  target?: AgentPermissionBrowserTarget,
  permissions?: AgentDataCollectionPermissions,
): Promise<AgentDataCollectionPermissionResult> {
  const browserTarget = resolveAgentPermissionBrowserTarget(target);
  if (browserTarget === 'chrome') return 'not_applicable';
  if (browserTarget !== 'firefox') return 'denied';
  const api = permissionApi(permissions);
  if (!api) return 'denied';
  const details = permissionDetails();
  try {
    if (!await api.request(details)) return 'denied';
    return await api.contains(details) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
