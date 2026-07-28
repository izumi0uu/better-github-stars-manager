/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { Conversation } from '@/ui/ai-elements/chat';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('Agent conversation scroll following', () => {
  it('pauses above the tail and resumes only from the explicit latest-message affordance', async () => {
    const renderConversation = (scrollKey: number, text: string) => (
      <Conversation active scrollKey={scrollKey} resumeLabel="Jump to latest">
        <div>{text}</div>
      </Conversation>
    );
    const container = mountReact(renderConversation(0, 'First'), mountedRoots);
    const viewport = container.querySelector<HTMLElement>('.gsm-scrollbar-stable');
    if (!viewport) throw new Error('expected conversation viewport');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    const initialCalls = scrollIntoView.mock.calls.length;

    await act(async () => {
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Promise.resolve();
    });
    const resume = container.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-resume-follow"]',
    );
    expect(resume?.textContent).toContain('Jump to latest');

    await act(async () => {
      mountedRoots[0].render(renderConversation(1, 'Second'));
      await Promise.resolve();
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(initialCalls);

    await click(resume!);
    expect(scrollIntoView).toHaveBeenCalledTimes(initialCalls + 1);
    expect(container.querySelector('[data-testid="conversation-resume-follow"]')).toBeNull();

    await act(async () => {
      mountedRoots[0].render(renderConversation(2, 'Third'));
      await Promise.resolve();
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(initialCalls + 2);
    expect(viewport.className).toContain('motion-reduce:scroll-auto');
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});
