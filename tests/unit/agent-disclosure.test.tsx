/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDataDisclosurePanel } from '@/options/AgentDataDisclosurePanel';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];

describe('Agent data disclosure', () => {
  afterEach(() => cleanupMountedRootsAndBody(mountedRoots));

  it('is collapsed by default and keeps the provider and exact origin visible', async () => {
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="Custom OpenAI-compatible"
        canonicalOrigin="https://relay.example.com:8443"
        customHostAccessRequired
        hostAccessGranted={false}
        hostAccessBusy={false}
        onGrantAccess={() => {}}
      />,
      mountedRoots,
    );

    const details = container.querySelector('details');
    const summary = container.querySelector('summary');
    expect(details?.open).toBe(false);
    expect(summary?.textContent).toContain('https://relay.example.com:8443');
    expect(summary?.textContent).toContain('direct connection');
    expect(summary?.textContent).not.toContain('BGSM proxy');
    expect(container.textContent).not.toContain('Accept disclosure');

    (summary as HTMLElement).click();
    expect(details?.open).toBe(true);
    expect(container.textContent).toContain('Requested code snippets or private notes');
    expect(container.textContent).toContain('GitHub token, credentials in model data');
    expect(container.textContent).toContain('Authorization header for this exact origin');
  });

  it('shows custom host access as the only required action', async () => {
    const onGrantAccess = vi.fn();
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="Custom OpenAI-compatible"
        canonicalOrigin="https://relay.example.com"
        customHostAccessRequired
        hostAccessGranted={false}
        hostAccessBusy={false}
        onGrantAccess={onGrantAccess}
      />,
      mountedRoots,
    );

    const grant = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Grant access'));
    expect(grant).toBeInstanceOf(HTMLButtonElement);
    expect(container.textContent).toContain('Grant host access to test or use this custom service.');
    await click(grant as HTMLButtonElement);
    expect(onGrantAccess).toHaveBeenCalledOnce();
  });

  it('does not show host-access actions for a built-in provider', () => {
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="OpenAI"
        canonicalOrigin="https://api.openai.com"
        customHostAccessRequired={false}
        hostAccessGranted
        hostAccessBusy={false}
        onGrantAccess={() => {}}
      />,
      mountedRoots,
    );

    expect(container.textContent).toContain('built-in host access');
    expect(container.querySelector('button')).toBeNull();
  });
});
