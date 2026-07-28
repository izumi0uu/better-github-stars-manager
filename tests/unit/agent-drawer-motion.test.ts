import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Agent drawer motion', () => {
  it('uses compositor-safe directional motion with a reduced-motion path', () => {
    const motion = readFileSync('src/ui/styles/motion.css', 'utf8');
    const drawerRule = motion.match(/\.gsm-agent-drawer\s*\{([^}]*)\}/)?.[1] ?? '';
    const openRule = motion.match(/\.gsm-agent-drawer\[data-state='open'\]\s*\{([^}]*)\}/)?.[1] ?? '';
    const reducedMotion = motion.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? '';

    expect(drawerRule).toContain('transform: translate3d(24px, 0, 0)');
    expect(drawerRule).toContain('opacity: 0');
    expect(drawerRule).not.toMatch(/transition:\s*all/);
    expect(openRule).toContain('transform: translate3d(0, 0, 0)');
    expect(openRule).toContain('opacity: 1');
    expect(reducedMotion).toContain('.gsm-agent-drawer');
    expect(reducedMotion).toContain('transition: none !important');
  });
});
