/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagEditor } from '@/ui/components/TagEditor';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('TagEditor delete semantics', () => {
  it('removes manual chips from the draft without persisting visible removal', async () => {
    const onChangeTags = vi.fn();
    const onRemoveVisibleTag = vi.fn();
    const container = mountReact(
      <TagEditor
        tags={['manual', 'auto']}
        editableTags={['manual']}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onChangeTags={onChangeTags}
        onRemoveVisibleTag={onRemoveVisibleTag}
      />,
      mountedRoots,
    );

    await click(removeButton(container, 0));

    expect(onChangeTags).toHaveBeenCalledWith([]);
    expect(onRemoveVisibleTag).not.toHaveBeenCalled();
  });

  it('persists removal for auto-only visible chips', async () => {
    const onChangeTags = vi.fn();
    const onRemoveVisibleTag = vi.fn();
    const container = mountReact(
      <TagEditor
        tags={['manual', 'auto']}
        editableTags={['manual']}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onChangeTags={onChangeTags}
        onRemoveVisibleTag={onRemoveVisibleTag}
      />,
      mountedRoots,
    );

    await click(removeButton(container, 1));

    expect(onChangeTags).not.toHaveBeenCalled();
    expect(onRemoveVisibleTag).toHaveBeenCalledWith('auto');
  });
});

function removeButton(container: HTMLElement, index: number): HTMLButtonElement {
  const buttons = [...container.querySelectorAll('button[title="Remove tag"]')];
  const button = buttons[index];
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing remove button ${index}`);
  return button;
}
