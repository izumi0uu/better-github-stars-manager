/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageFor } from '@/i18n';
import { ReleaseNotesCard } from '@/ui/components/ReleaseNotesCard';
import { cleanupMountedRootsAndBody, click, mountReact, type MountedRoot } from './test-utils';

const mountedRoots: MountedRoot[] = [];

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('ReleaseNotesCard', () => {
  it('renders the approved four-card release summary without baseline overclaims', async () => {
    const onDismiss = vi.fn();
    const container = mountReact(
      <ReleaseNotesCard interactionLocked={false} onDismiss={onDismiss} />,
      mountedRoots,
    );

    expect(container.querySelectorAll('article')).toHaveLength(4);
    expect(container.textContent).toContain('Custom Table Layout');
    expect(container.textContent).toContain('Better Library Browsing');
    expect(container.textContent).toContain('Safer Auto Tags');
    expect(container.textContent).toContain('One-Time Data Refresh');
    expect(container.textContent).toContain('keeps the existing per-repo limit');
    expect(container.textContent).not.toContain('FAB');
    expect(container.textContent).not.toContain('restore panel');
    expect(container.textContent).not.toContain('panel visibility');

    const detailsButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Read details') as HTMLButtonElement | undefined;
    expect(detailsButton).toBeDefined();
    await click(detailsButton!);

    expect(container.textContent).toContain('New');
    expect(container.textContent).toContain('Changed');
    expect(container.textContent).toContain('Fixed');
    expect(container.textContent).toContain('Tag lists can be sorted A-to-Z or Z-to-A with natural name ordering.');
    expect(container.textContent).toContain('Auto Tags is manual-only');
    expect(container.textContent).toContain('One-time sync notice');
    expect(container.textContent).toContain('including archived state');
    expect(container.textContent).toContain('Layout editing locks unrelated interactions');
    expect(container.textContent).toContain('Auth cache is preserved after failed auth writes.');
    expect(container.textContent).toContain('overflow feedback stays visible as an edge cue');
  });

  it('calls dismiss only from the close control', () => {
    const onDismiss = vi.fn();
    const container = mountReact(
      <ReleaseNotesCard interactionLocked={false} onDismiss={onDismiss} />,
      mountedRoots,
    );
    const dismissButton = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss release notes"]');
    expect(dismissButton).not.toBeNull();

    act(() => {
      dismissButton!.click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps localized release notes structurally aligned', () => {
    const en = messageFor('en').releaseNotes;
    const zh = messageFor('zh-CN').releaseNotes;

    expect(en.cards).toHaveLength(4);
    expect(zh.cards).toHaveLength(4);
    expect(en.details.map((section) => section.title)).toEqual(['New', 'Changed', 'Fixed']);
    expect(zh.details.map((section) => section.title)).toEqual(['新增', '变化', '修复']);
    expect(zh.details.map((section) => section.items.length)).toEqual(
      en.details.map((section) => section.items.length),
    );
    expect(zh.cards.map((card) => card.title)).toEqual([
      '自定义表格布局',
      '更好浏览收藏库',
      '更安全的自动标签',
      '一次性数据刷新',
    ]);
    expect(zh.details.flatMap((section) => section.items).join('\n')).toContain('单仓库标签上限');
    expect(zh.details.flatMap((section) => section.items).join('\n')).toContain('archived 状态');
  });
});
