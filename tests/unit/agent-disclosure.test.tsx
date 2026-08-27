/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES,
  AGENT_SENT_TASK_DATA_CATEGORIES,
} from '@/bgsm-agent/disclosure';
import { getMessages } from '@/i18n';
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
    // The panel must state that host access is requested separately and on demand;
    // read the copy from the catalog so this stays a rendering contract, not a
    // duplicated wording assertion.
    expect(container.textContent).toContain(
      getMessages('en').options.agentDisclosureProviderAccess,
    );
  });

  it('renders every declared task-data category in the disclosure list', () => {
    // The runtime category constants are the disclosure contract; the panel is
    // their only user-facing surface. Assert against the rendered
    // data-disclosure-category attributes so dropping a category from the panel
    // fails here instead of only in a source scan.
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="OpenAI"
        canonicalOrigin="https://api.openai.com"
        disclosureAccepted={false}
        disclosureBusy={false}
        hostAccessGranted={false}
        hostAccessBusy={false}
        onGrantAccess={() => {}}
        onAcceptDisclosure={() => {}}
      />,
      mountedRoots,
    );

    const rendered = new Set(
      [...container.querySelectorAll('[data-disclosure-category]')]
        .flatMap((item) => (item.getAttribute('data-disclosure-category') ?? '').split(' '))
        .filter(Boolean),
    );
    expect([...rendered].sort()).toEqual([
      ...AGENT_SENT_TASK_DATA_CATEGORIES,
      ...AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES,
    ].toSorted());
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
    expect(container.textContent).toContain('Allow browser access to test or use this service.');
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

  it('confirms granted access and drops the action for any provider once allowed', () => {
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="OpenAI"
        canonicalOrigin="https://api.openai.com"
        disclosureAccepted
        disclosureBusy={false}
        hostAccessGranted
        hostAccessBusy={false}
        onGrantAccess={() => {}}
        onAcceptDisclosure={() => {}}
      />,
      mountedRoots,
    );

    // Built-in providers are no longer pre-granted, so the panel must confirm the
    // grant rather than describe built-in coverage.
    expect(container.textContent).toContain('Access allowed');
    expect(container.textContent).toContain('Data sharing accepted');
    expect(container.textContent).not.toContain('built-in browser access');
    expect([...container.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('Allow access'))).toBe(false);
  });

  it('requests host access for a built-in provider that has not been granted', async () => {
    const onGrantAccess = vi.fn();
    const container = mountReact(
      <AgentDataDisclosurePanel
        providerLabel="OpenAI"
        canonicalOrigin="https://api.openai.com"
        disclosureAccepted
        disclosureBusy={false}
        hostAccessGranted={false}
        hostAccessBusy={false}
        onGrantAccess={onGrantAccess}
        onAcceptDisclosure={() => {}}
      />,
      mountedRoots,
    );

    const grant = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Allow access'));
    expect(grant).toBeInstanceOf(HTMLButtonElement);
    await click(grant as HTMLButtonElement);
    expect(onGrantAccess).toHaveBeenCalledOnce();
  });
});
