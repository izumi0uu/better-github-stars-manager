/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoTagAgentPrompt } from '@/ui/components/AutoTagAgentPrompt';
import { useAutoTagAgentPrompt } from '@/ui/hooks/use-auto-tag-agent-prompt';
import { cleanupMountedRootsAndBody, click, mountReact, type MountedRoot } from './test-utils';

const { getConfig, update } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/auth/auth-store', () => ({
  authStore: { getConfig, update },
}));

const mountedRoots: MountedRoot[] = [];
const openAgent = vi.fn();
const runAutoTags = vi.fn();

function Harness() {
  const prompt = useAutoTagAgentPrompt({
    onOpenAgent: openAgent,
    onRunAutoTags: runAutoTags,
  });
  return (
    <>
      <button type="button" onClick={() => { void prompt.requestAutoTags(); }}>
        Request Auto Tags
      </button>
      <AutoTagAgentPrompt
        open={prompt.open}
        onChooseAgent={prompt.chooseAgent}
        onChooseAutoTags={prompt.chooseAutoTags}
        onDismiss={prompt.dismiss}
      />
    </>
  );
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

beforeEach(() => {
  getConfig.mockReset();
  update.mockReset();
  openAgent.mockReset();
  runAutoTags.mockReset();
  update.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('one-time Auto Tags Agent choice', () => {
  it('opens Agent for Yes, remembers the answer, and runs later clicks directly', async () => {
    getConfig.mockResolvedValue({ autoTagAgentPromptSeen: false });
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    await click(buttonByText(container, 'Request Auto Tags'));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('Try Agent for smarter tagging?');
    expect(document.activeElement).toBe(buttonByText(container, 'Yes, open Agent'));

    await click(buttonByText(container, 'Yes, open Agent'));
    expect(openAgent).toHaveBeenCalledTimes(1);
    expect(runAutoTags).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ autoTagAgentPromptSeen: true });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await click(buttonByText(container, 'Request Auto Tags'));
    expect(runAutoTags).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('runs local Auto Tags for No and persists the one-time choice', async () => {
    getConfig.mockResolvedValue({ autoTagAgentPromptSeen: false });
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    await click(buttonByText(container, 'Request Auto Tags'));
    await click(buttonByText(container, 'No, use Auto Tags'));

    expect(runAutoTags).toHaveBeenCalledTimes(1);
    expect(openAgent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ autoTagAgentPromptSeen: true });
  });

  it('skips the prompt when it was answered previously', async () => {
    getConfig.mockResolvedValue({ autoTagAgentPromptSeen: true });
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    await click(buttonByText(container, 'Request Auto Tags'));

    expect(runAutoTags).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('lets Escape dismiss without recording an answer', async () => {
    getConfig.mockResolvedValue({ autoTagAgentPromptSeen: false });
    const container = mountReact(<Harness />, mountedRoots);
    await flushEffects();

    await click(buttonByText(container, 'Request Auto Tags'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(update).not.toHaveBeenCalled();

    await click(buttonByText(container, 'Request Auto Tags'));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
