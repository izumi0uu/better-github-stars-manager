import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasAgentPersonalCommunicationsPermission,
  requestAgentPersonalCommunicationsPermission,
  resolveAgentPermissionBrowserTarget,
  type AgentDataCollectionPermissions,
} from '@/auth/agent-data-permission';

function permissions({
  contains = false,
  request = false,
}: {
  contains?: boolean;
  request?: boolean;
} = {}) {
  return {
    contains: vi.fn(async () => contains),
    request: vi.fn(async () => request),
  } satisfies AgentDataCollectionPermissions;
}

const details = { data_collection: ['personalCommunications'] };

afterEach(() => vi.unstubAllGlobals());

describe('Agent personal-communications browser permission', () => {
  it('detects Firefox from the transformed runtime manifest, not build constants', () => {
    vi.stubGlobal('chrome', {
      runtime: {
        getManifest: () => ({ browser_specific_settings: { gecko: { id: 'test@example.com' } } }),
      },
    });
    expect(resolveAgentPermissionBrowserTarget()).toBe('firefox');

    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ manifest_version: 3 }) } });
    expect(resolveAgentPermissionBrowserTarget()).toBe('chrome');
  });
  it('fails closed when the runtime manifest identity is unavailable', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        getManifest: () => {
          throw new Error('manifest unavailable');
        },
      },
    });
    const api = permissions({ contains: true, request: true });

    expect(resolveAgentPermissionBrowserTarget()).toBe('unknown');
    await expect(requestAgentPersonalCommunicationsPermission(undefined, api))
      .resolves.toBe('denied');
    await expect(hasAgentPersonalCommunicationsPermission(undefined, api))
      .resolves.toBe(false);
    expect(api.contains).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });
  it('treats Chrome as not applicable without using unsupported permission shapes', async () => {
    const api = permissions();

    await expect(requestAgentPersonalCommunicationsPermission('chrome', api))
      .resolves.toBe('not_applicable');
    await expect(hasAgentPersonalCommunicationsPermission('chrome', api))
      .resolves.toBe(true);
    expect(api.contains).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });
  it('requests Firefox permission directly and verifies the grant', async () => {
    const api = permissions({ contains: true, request: true });

    await expect(requestAgentPersonalCommunicationsPermission('firefox', api))
      .resolves.toBe('granted');
    expect(api.request).toHaveBeenCalledWith(details);
    expect(api.contains).toHaveBeenCalledWith(details);
    expect(api.request.mock.invocationCallOrder[0])
      .toBeLessThan(api.contains.mock.invocationCallOrder[0]!);
  });
  it('reports Firefox denial and does not manufacture a grant', async () => {
    const api = permissions({ contains: false, request: false });

    await expect(requestAgentPersonalCommunicationsPermission('firefox', api))
      .resolves.toBe('denied');
    await expect(hasAgentPersonalCommunicationsPermission('firefox', api))
      .resolves.toBe(false);
    expect(api.request).toHaveBeenCalledWith(details);
  });

  it('uses the same direct request path when Firefox already granted permission', async () => {
    const api = permissions({ contains: true, request: true });

    await expect(requestAgentPersonalCommunicationsPermission('firefox', api))
      .resolves.toBe('granted');
    expect(api.request).toHaveBeenCalledOnce();
    expect(api.contains).toHaveBeenCalledOnce();
  });
});
