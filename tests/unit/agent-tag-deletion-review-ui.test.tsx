/** @vitest-environment jsdom */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTagDeletionReview } from '@/ui/components/AgentTagDeletionReview';
import { cleanupMountedRootsAndBody, click, mountReact, type MountedRoot } from './test-utils';

const bridge = vi.hoisted(() => ({ decide: vi.fn(async (_payload: unknown) => true) }));
vi.mock('@/utils/messaging', () => ({ bgCall: async (type: string, payload: unknown) => {
  if (type === 'decideAgentTagDeletion') return bridge.decide(payload);
  return [{ id: 'review', sessionId: 'session', proposal: { kind: 'repository', changes: [{ full_name: 'octocat/repo', tags: ['legacy'] }] } }];
} }));
const roots: MountedRoot[] = [];
afterEach(() => { cleanupMountedRootsAndBody(roots); vi.clearAllMocks(); });

describe('tag deletion review controls', () => {
  it.each([true, false])('sends only the displayed review identity on user decision %s', async (approved) => {
    const container = mountReact(<AgentTagDeletionReview active sessionId="session" />, roots);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('li')?.textContent).toContain('octocat/repo');
    expect(container.querySelector('li')?.textContent).toContain('legacy');
    expect(bridge.decide).not.toHaveBeenCalled();
    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    await click(buttons[approved ? 1 : 0]);
    expect(bridge.decide).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session', id: 'review', approved });
    expect(container.querySelector('[data-testid="agent-tag-deletion-review"]')).toBeNull();
  });
});
