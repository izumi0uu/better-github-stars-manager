/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@/types';

const tag: Tag = {
  full_name: 'octocat/project',
  manualTags: ['work'],
  autoTags: [],
  dismissedAutoTags: [],
  manualTagsMtime: '2026-01-01T00:00:00.000Z',
  autoTagsMtime: '2026-01-01T00:00:00.000Z',
  dismissedAutoTagsMtime: '2026-01-01T00:00:00.000Z',
  notes: '',
  mtime: '2026-01-01T00:00:00.000Z',
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.doUnmock('@/auth/auth-store');
  vi.doUnmock('@/i18n');
  vi.doUnmock('@/utils/messaging');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('repo chip DOM lifecycle', () => {
  it('builds SVG nodes, stays idempotent, preserves navigation, and cleans up', async () => {
    vi.resetModules();
    window.history.replaceState(null, '', '/octocat/project');
    document.body.innerHTML = [
      '<span itemprop="author"><a>octocat</a></span>',
      '<strong itemprop="name"><a data-pjax>project</a></strong>',
    ].join('');
    const bgCall = vi.fn(async (type: string) => {
      if (type === 'getTag') return { tag };
      if (type === 'getUsername') return { username: 'octocat' };
      return undefined;
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.doMock('@/auth/auth-store', () => ({
      authStore: { getLocale: vi.fn(async () => 'en') },
    }));
    vi.doMock('@/i18n', () => ({
      messageFor: () => ({
        repoChip: {
          untagged: 'Untagged',
          filterByTag: (value: string) => `Filter by ${value}`,
          editTags: 'Edit tags',
        },
        tagEditor: { bulkPlaceholder: 'tag1, tag2, …' },
      }),
    }));
    vi.doMock('@/utils/messaging', () => ({ bgCall }));

    const { onExecute } = await import('@/content/repo-chip/index');
    onExecute();
    await flush();

    const anchor = document.querySelector('strong[itemprop="name"]');
    const host = anchor?.nextElementSibling as HTMLElement | null;
    expect(host?.shadowRoot).not.toBeNull();
    expect(host?.shadowRoot?.querySelector('.edit svg path')?.getAttribute('d'))
      .toBe('M12 20h9');
    expect(host?.shadowRoot?.innerHTML).not.toContain('<script');

    document.dispatchEvent(new Event('turbo:render'));
    await flush();
    expect(anchor?.parentElement?.querySelectorAll('strong + span')).toHaveLength(1);

    (host?.shadowRoot?.querySelector('.tag') as HTMLElement).click();
    await flush();
    expect(open).toHaveBeenCalledWith(
      'https://github.com/octocat?tab=stars#gsm-tag=work',
      '_blank',
    );

    (host?.shadowRoot?.querySelector('.edit') as HTMLElement).click();
    await flush();
    const save = host?.shadowRoot?.querySelector<HTMLButtonElement>('.editor button');
    expect(save?.getAttribute('aria-label')).toBe('Save');
    expect(save?.querySelector('svg path')?.getAttribute('d')).toBe('M20 6 9 17l-5-5');

    window.history.replaceState(null, '', '/settings/profile');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(host?.isConnected).toBe(false);
  });
});
