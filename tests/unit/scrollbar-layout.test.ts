import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('scrollbar layout boundaries', () => {
  it('keeps layout-affecting gutters out of the global scrollbar rule', () => {
    const css = read('src/ui/styles/utilities.css');
    const universalRule = css.match(/\*\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(universalRule).not.toContain('scrollbar-gutter');
    expect(css).toMatch(/\.gsm-scrollbar-stable\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
    expect(css).toMatch(/\.no-scrollbar\s*\{[^}]*scrollbar-gutter:\s*auto;/s);
  });

  it('reserves stable gutters only on explicit scrolling surfaces', () => {
    const scrollingSurfaces = [
      'src/ui/components/FilterSidebar.tsx',
      'src/ui/components/RepoDetailPanel.tsx',
      'src/ui/ai-elements/chat.tsx',
      'src/popup/Popup.tsx',
    ];

    for (const path of scrollingSurfaces) {
      expect(read(path), path).toContain('gsm-scrollbar-stable');
    }
  });

  it('sizes the full-screen host without viewport scrollbar overflow', () => {
    const entrypoint = read('src/content/stars-page/index.tsx');
    const hostStyle = entrypoint.match(/host\.style\.cssText\s*=\s*'([^']+)'/)?.[1] ?? '';

    expect(hostStyle).toContain('inset:0');
    expect(hostStyle).not.toMatch(/100v[wh]/);
  });
});
