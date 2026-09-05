/** @vitest-environment jsdom */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoManagerRuntime } from '@/demo/runtime';
import { RadarRecommendations } from '@/ui/components/RadarRecommendations';
import type { ManagerRuntime } from '@/runtime/manager-runtime';
import { useRadar } from '@/ui/hooks/use-radar';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { cleanupMountedRootsAndBody, click, mountReact, type MountedRoot } from './test-utils';

const roots: MountedRoot[] = [];
function ForYou() {
  const radar = useRadar();
  return <RadarRecommendations
    recommendations={radar.recommendations}
    discoverView="for-you"
    loading={radar.recommendationLoading}
    refreshing={radar.recommendationRefreshing}
    error={radar.recommendationError}
    pendingAction={radar.pendingAction}
    recommendationFavorites={radar.recommendationFavorites}
    actionError={radar.actionError}
    onDiscoverViewChange={radar.setDiscoverView}
    onRefresh={() => { void radar.refreshRecommendations(); }}
    onRetryQuery={() => { void radar.reloadRecommendations(); }}
    onOpenOptions={() => {}}
    onStar={radar.star}
    onIgnore={radar.ignoreRecommendation}
    onRestoreIgnored={radar.restoreIgnoredRecommendation}
    onSetFavorite={radar.setFavorite}
    onAddTag={radar.addTag}
  />;
}
async function mount(runtime: ManagerRuntime) {
  const container = mountReact(
    <ManagerRuntimeProvider runtime={runtime}><TooltipProvider><ForYou /></TooltipProvider></ManagerRuntimeProvider>, roots,
  );
  await settle();
  return container;
}
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
function favorite(container: HTMLElement, key: string): HTMLButtonElement {
  const row = container.querySelector(`[data-recommendation-row="${key}"]`);
  const button = row?.querySelector<HTMLButtonElement>('[data-recommendation-action="favorite"]');
  if (!button) throw new Error(`Missing favorite for ${key}`);
  return button;
}
afterEach(() => {
  cleanupMountedRootsAndBody(roots);
  vi.restoreAllMocks();
});

describe('For You favorite authority', () => {
  it('survives remount, reconciles another page, and cancels the persisted favorite without starring', async () => {
    const runtime = createDemoManagerRuntime();
    const candidate = (await runtime.queryRecommendations()).recommendations[0];
    await runtime.setFavorite(candidate.repositoryFullName, true);
    const star = vi.spyOn(runtime, 'starRepository');
    const setFavorite = vi.spyOn(runtime, 'setFavorite');
    const first = await mount(runtime);
    expect(favorite(first, candidate.repositoryKey).getAttribute('aria-pressed')).toBe('true');
    act(() => roots.shift()!.unmount());
    const remounted = await mount(runtime);
    await click(favorite(remounted, candidate.repositoryKey));
    await settle();
    expect(setFavorite).toHaveBeenLastCalledWith(candidate.repositoryFullName, false);
    expect(favorite(remounted, candidate.repositoryKey).getAttribute('aria-pressed')).toBe('false');
    await act(async () => { await runtime.setFavorite(candidate.repositoryFullName, true); });
    await settle();
    expect(favorite(remounted, candidate.repositoryKey).getAttribute('aria-pressed')).toBe('true');
    expect(star).not.toHaveBeenCalled();
  });

  it('shows only an in-flight override and rolls back a failed write to the committed value', async () => {
    const runtime = createDemoManagerRuntime();
    const candidate = (await runtime.queryRecommendations()).recommendations[0];
    const container = await mount(runtime);
    const mutation = Promise.withResolvers<void>();
    vi.spyOn(runtime, 'setFavorite').mockReturnValueOnce(mutation.promise);
    const button = favorite(container, candidate.repositoryKey);
    await click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.disabled).toBe(true);
    await act(async () => { mutation.reject(new Error('FAVORITE_WRITE_FAILED')); });
    await settle();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('FAVORITE_WRITE_FAILED');
    await act(async () => { await runtime.setFavorite(candidate.repositoryFullName, true); });
    await settle();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});
