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
        disclosureAccepted={false}
        disclosureBusy={false}
        customHostAccessRequired
        hostAccessGranted={false}
        hostAccessBusy={false}
        onGrantAccess={() => {}}
        onAcceptDisclosure={() => {}}
      />,
      mountedRoots,
    );

    const details = container.querySelector('details');
    const summary = container.querySelector('summary');
    expect(details?.open).toBe(false);
    expect(summary?.textContent).toContain('https://relay.example.com:8443');
    expect(summary?.textContent).toContain('direct connection');
    expect(summary?.textContent).not.toContain('BGSM proxy');
    expect(container.textContent).toContain('Accept data sharing');

    (summary as HTMLElement).click();
    expect(details?.open).toBe(true);
    expect(container.textContent).toContain('Code snippets or private notes only when you ask Cubby');
    expect(container.textContent).toContain('GitHub token, API keys, other credentials');
    expect(container.textContent).toContain('provider-required authentication header');
    expect(container.textContent).toContain("Anthropic's x-api-key");
    expect(container.textContent).not.toContain('as an Authorization header');
  });

  it('keeps disclosure acceptance and custom host access as separate actions', async () => {
    const onGrantAccess = vi.fn();
    const onAcceptDisclosure = vi.fn();
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="Custom OpenAI-compatible"
        canonicalOrigin="https://relay.example.com"
        disclosureAccepted={false}
        disclosureBusy={false}
        customHostAccessRequired
        hostAccessGranted={false}
        hostAccessBusy={false}
        onGrantAccess={onGrantAccess}
        onAcceptDisclosure={onAcceptDisclosure}
      />,
      mountedRoots,
    );

    const grant = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Allow access'));
    expect(grant).toBeInstanceOf(HTMLButtonElement);
    expect(container.textContent).toContain('Allow browser access to test or use this custom service.');
    await click(grant as HTMLButtonElement);
    expect(onGrantAccess).toHaveBeenCalledOnce();
    expect(onAcceptDisclosure).not.toHaveBeenCalled();
    const accept = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Accept data sharing'));
    await click(accept as HTMLButtonElement);
    expect(onAcceptDisclosure).toHaveBeenCalledOnce();
  });

  it('prevents host access while disclosure permission is pending', () => {
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="Custom OpenAI-compatible"
        canonicalOrigin="https://relay.example.com"
        disclosureAccepted={false}
        disclosureBusy
        customHostAccessRequired
        hostAccessGranted={false}
        hostAccessBusy={false}
        onGrantAccess={() => {}}
        onAcceptDisclosure={() => {}}
      />,
      mountedRoots,
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    const accept = buttons.find((button) => button.querySelector('[data-icon="inline-start"]'));
    const grant = buttons.find((button) => button.textContent?.includes('Allow access'));
    expect(accept?.disabled).toBe(true);
    expect(grant?.disabled).toBe(true);
  });

  it('does not show host-access actions for a built-in provider', () => {
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="OpenAI"
        canonicalOrigin="https://api.openai.com"
        disclosureAccepted
        disclosureBusy={false}
        customHostAccessRequired={false}
        hostAccessGranted
        hostAccessBusy={false}
        onGrantAccess={() => {}}
        onAcceptDisclosure={() => {}}
      />,
      mountedRoots,
    );

    expect(container.textContent).toContain('built-in browser access');
    expect(container.textContent).toContain('Data sharing accepted');
    expect([...container.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('Allow access'))).toBe(false);
  });
});
