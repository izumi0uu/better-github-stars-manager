export const MANAGER_SURFACES = ['stars', 'watch', 'radar'] as const;
export type ManagerSurface = typeof MANAGER_SURFACES[number];
export type ManagerSurfaceDirection = 'backward' | 'forward';

export function managerSurfaceDirection(
  current: ManagerSurface,
  next: ManagerSurface,
): ManagerSurfaceDirection {
  return MANAGER_SURFACES.indexOf(next) < MANAGER_SURFACES.indexOf(current)
    ? 'backward'
    : 'forward';
}

export function managerSurfaceFromShortcut(key: string): ManagerSurface | null {
  const index = Number(key) - 1;
  return Number.isInteger(index) && index >= 0 && index < MANAGER_SURFACES.length
    ? MANAGER_SURFACES[index]!
    : null;
}

export function managerSurfaceFromNavigation(
  current: ManagerSurface,
  key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
): ManagerSurface {
  if (key === 'Home') return MANAGER_SURFACES[0];
  if (key === 'End') return MANAGER_SURFACES[MANAGER_SURFACES.length - 1];
  const currentIndex = MANAGER_SURFACES.indexOf(current);
  const direction = key === 'ArrowRight' ? 1 : -1;
  return MANAGER_SURFACES[
    (currentIndex + direction + MANAGER_SURFACES.length) % MANAGER_SURFACES.length
  ]!;
}
