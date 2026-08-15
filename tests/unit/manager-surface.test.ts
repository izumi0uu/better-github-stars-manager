import { describe, expect, it } from 'vitest';
import {
  managerSurfaceDirection,
  managerSurfaceFromNavigation,
  managerSurfaceFromShortcut,
} from '@/ui/manager-surface';

describe('manager surface navigation', () => {
  it('maps only the three documented number shortcuts', () => {
    expect(managerSurfaceFromShortcut('1')).toBe('stars');
    expect(managerSurfaceFromShortcut('2')).toBe('watch');
    expect(managerSurfaceFromShortcut('3')).toBe('radar');
    for (const key of ['0', '4', 'x', '', '1.5']) {
      expect(managerSurfaceFromShortcut(key)).toBeNull();
    }
  });

  it('cycles arrow navigation and honors Home and End', () => {
    expect(managerSurfaceFromNavigation('stars', 'ArrowLeft')).toBe('radar');
    expect(managerSurfaceFromNavigation('radar', 'ArrowRight')).toBe('stars');
    expect(managerSurfaceFromNavigation('watch', 'ArrowLeft')).toBe('stars');
    expect(managerSurfaceFromNavigation('watch', 'ArrowRight')).toBe('radar');
    expect(managerSurfaceFromNavigation('radar', 'Home')).toBe('stars');
    expect(managerSurfaceFromNavigation('stars', 'End')).toBe('radar');
  });

  it('derives transition direction from the shared surface order', () => {
    expect(managerSurfaceDirection('stars', 'watch')).toBe('forward');
    expect(managerSurfaceDirection('watch', 'radar')).toBe('forward');
    expect(managerSurfaceDirection('radar', 'watch')).toBe('backward');
    expect(managerSurfaceDirection('radar', 'stars')).toBe('backward');
  });
});
