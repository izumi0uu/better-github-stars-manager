/** @vitest-environment jsdom */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoManagerRuntime } from '@/demo/runtime';
import { I18nProvider } from '@/i18n';
import type { WatchRepositoryDetail } from '@/runtime/manager-runtime';
import { ManagerWorkspace } from '@/ui/ManagerWorkspace';
import { useFilterStore } from '@/ui/filter-store';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { cleanupMountedRootsAndBody, click, mountReact, setInputValue, type MountedRoot } from './test-utils';

// jsdom has no measured viewport; exercise the real rows and editors, not their geometry.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 40 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

const roots: MountedRoot[] = [];
function required<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function setNotes(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function saveButton(section: ParentNode): HTMLButtonElement {
  const button = [...section.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent?.trim() === 'Save');
  if (!button) throw new Error('Missing editor save action');
  return button;
}
async function mountWorkspace() {
  const runtime = createDemoManagerRuntime();
  const watch = await runtime.queryWatchInbox({ unreadOnly: true });
  const fullName = watch.groups[0].repositoryFullName;
  await runtime.setTags(fullName, ['committed-tag']);
  await runtime.setNotes(fullName, 'committed note');
  const onCommandsChange = vi.fn();
  const onActivityChange = vi.fn();
  const container = mountReact(
    <ManagerRuntimeProvider runtime={runtime}>
      <I18nProvider source={runtime}>
        <ManagerWorkspace
          allowHashTagOverride={false}
          onCommandsChange={onCommandsChange}
          onActivityChange={onActivityChange}
          extension={{ renderOverlays: ({ agentCandidate, scopeCount }) => (
            <output data-workspace-scope={agentCandidate.kind} data-scope-count={scopeCount}>
              {agentCandidate.kind === 'selected_repository' ? agentCandidate.selectedRepositoryIdHint : ''}
            </output>
          ) }}
        />
      </I18nProvider>
    </ManagerRuntimeProvider>, roots,
  );
  await settle();
  return { runtime, container, fullName, onCommandsChange, onActivityChange };
}
async function openWatchRepository(container: HTMLElement, fullName: string) {
  await click(required<HTMLButtonElement>(container, '#gsm-watch-surface-tab'));
  const group = required<HTMLElement>(container, `[data-watch-repository="${fullName}"]`);
  const button = [...group.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent?.trim() === fullName);
  if (!button) throw new Error('Missing repository selection');
  await click(button);
  await settle();
}

afterEach(() => {
  cleanupMountedRootsAndBody(roots);
  useFilterStore.setState({ query: '', languages: [], tags: [], onlyFavorite: false, onlyOwned: false, onlyArchived: false, onlyUntagged: false, libraryViewHydrated: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('workspace committed projections', () => {
  it.each(['success', 'failure'] as const)('keeps both real Watch editors mounted through independent saves and a reload %s', async (settlement) => {
    const { runtime, container, fullName, onCommandsChange, onActivityChange } = await mountWorkspace();
    await openWatchRepository(container, fullName);
    const textarea = required<HTMLTextAreaElement>(container, '[data-repository-detail] textarea');
    const tagInput = required<HTMLInputElement>(container, '[data-repository-detail] input');
    const activityCalls = onActivityChange.mock.calls.length;
    await setNotes(textarea, 'unsaved independent note');
    await setInputValue(tagInput, 'saved-tag');
    await act(async () => { tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    const reload = Promise.withResolvers<WatchRepositoryDetail>();
    const readDetail = runtime.getWatchRepositoryDetail.bind(runtime);
    vi.spyOn(runtime, 'getWatchRepositoryDetail').mockReturnValue(reload.promise);
    await click(saveButton(tagInput.parentElement!.parentElement!.parentElement!));
    expect(container.querySelector('[data-repository-detail] textarea')).toBe(textarea);
    expect(textarea.value).toBe('unsaved independent note');
    await act(async () => {
      if (settlement === 'success') reload.resolve(await readDetail(fullName));
      else reload.reject(new Error('DETAIL_RELOAD_FAILED'));
    });
    expect(container.querySelector('[data-repository-detail] textarea')).toBe(textarea);
    expect(textarea.value).toBe('unsaved independent note');
    vi.mocked(runtime.getWatchRepositoryDetail).mockImplementation(readDetail);

    await setInputValue(tagInput, 'unsaved-tag');
    await act(async () => { tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await click(saveButton(textarea.parentElement!));
    await settle();
    expect(container.querySelector('[data-repository-detail] input')).toBe(tagInput);
    expect(container.querySelector('[data-repository-detail]')?.textContent).toContain('unsaved-tag');
    expect((await readDetail(fullName)).tag?.manualTags).not.toContain('unsaved-tag');
    expect(onCommandsChange).toHaveBeenCalledTimes(1);
    expect(onActivityChange.mock.calls.length).toBe(activityCalls);
  });

  it('fences a late Watch reload after close and a subsequent repository selection', async () => {
    const { runtime, container, fullName } = await mountWorkspace();
    await openWatchRepository(container, fullName);
    const detail = await runtime.getWatchRepositoryDetail(fullName);
    const reload = Promise.withResolvers<WatchRepositoryDetail>();
    vi.spyOn(runtime, 'getWatchRepositoryDetail').mockReturnValue(reload.promise);
    await act(async () => { await runtime.setFavorite(fullName, true); });
    await click(required<HTMLButtonElement>(container, '.drawer-anim button[title]').parentElement!.querySelectorAll<HTMLButtonElement>('button')[2]);
    await act(async () => { reload.resolve(detail); });
    expect(container.querySelector('[data-repository-detail]')).toBeNull();
    const staleSelection = Promise.withResolvers<WatchRepositoryDetail>();
    vi.mocked(runtime.getWatchRepositoryDetail).mockReturnValue(staleSelection.promise);
    await openWatchRepository(container, fullName);

    vi.mocked(runtime.getWatchRepositoryDetail).mockRestore();
    const watch = await runtime.queryWatchInbox({ unreadOnly: true });
    const other = watch.groups.find((group) => group.repositoryFullName !== fullName)!;
    await openWatchRepository(container, other.repositoryFullName);
    await act(async () => { staleSelection.resolve(detail); });
    expect(container.querySelector('[data-repository-detail]')?.textContent).toContain(other.repositoryFullName);
    expect(required<HTMLTextAreaElement>(container, '[data-repository-detail] textarea').value).not.toBe('committed note');
  });

  it('passes current Agent scope directly to overlays without rebinding refresh commands', async () => {
    const { container, onCommandsChange } = await mountWorkspace();
    const scope = required<HTMLOutputElement>(container, '[data-workspace-scope]');
    expect(scope.dataset.workspaceScope).toBe('current_view');
    const commands = onCommandsChange.mock.calls[0][0];
    const row = required<HTMLElement>(container, '[data-layout-row-grid]');
    await act(async () => row.click());
    expect(scope.dataset.workspaceScope).toBe('selected_repository');
    expect(scope.dataset.scopeCount).toBe('1');
    expect(scope.textContent).toBe(required<HTMLElement>(container, '[data-repository-detail]').dataset.repositoryDetail);
    expect(onCommandsChange).toHaveBeenCalledTimes(1);
    act(() => commands.refreshStars());
    await settle();
    expect(onCommandsChange).toHaveBeenCalledTimes(1);
    expect(scope.dataset.workspaceScope).toBe('selected_repository');
  });

  it('renders a recoverable Stars query error alongside committed rows', async () => {
    vi.useFakeTimers();
    const { runtime, container } = await mountWorkspace();
    const firstRow = required<HTMLElement>(container, '[data-layout-row-grid]');
    const readStars = runtime.queryStars.bind(runtime);
    vi.spyOn(runtime, 'queryStars').mockRejectedValueOnce(new Error('QUERY_UNAVAILABLE'));
    act(() => useFilterStore.getState().setQuery('failed search'));
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    const alert = required<HTMLElement>(container, '[data-stars-query-error][role="alert"]');
    expect(container.contains(firstRow)).toBe(true);
    vi.mocked(runtime.queryStars).mockImplementation(readStars);
    await click(required<HTMLButtonElement>(alert, 'button'));
    expect(container.querySelector('[data-stars-query-error]')).toBeNull();
  });
});
