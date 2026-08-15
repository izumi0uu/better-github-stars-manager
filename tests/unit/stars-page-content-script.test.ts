import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = () => readFileSync('src/content/stars-page/index.tsx', 'utf8');

describe('stars-page content script invariants', () => {
  it('keeps manager CSS scoped to the shadow root', () => {
    const code = source();

    expect(code).toContain("import cssText from '@/ui/styles/index.css?inline';");
    expect(code).toContain("const shadow = host.attachShadow({ mode: 'open' });");
    expect(code).toContain('sheet.replaceSync(cssText);');
    expect(code).toContain('shadow.adoptedStyleSheets = [sheet];');
    expect(code).toContain('styleEl.textContent = cssText;');
    expect(code).not.toContain("import '@/ui/styles/index.css'");
  });

  it('unmounts React before removing the host and restores page scroll', () => {
    const code = source();
    const unmountIndex = code.indexOf('panelRoot?.unmount();');
    const removeIndex = code.indexOf('panelHost?.remove();');
    const unlockIndex = code.indexOf('unlockPageScroll();');

    expect(code).toContain('let panelRoot: Root | null = null;');
    expect(code).toContain('panelRoot = createRoot(root);');
    expect(unmountIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(unmountIndex);
    expect(unlockIndex).toBeGreaterThan(removeIndex);
    expect(code).toContain('savedHtmlOverflow = document.documentElement.style.overflow;');
    expect(code).toContain('savedBodyOverflow = document.body.style.overflow;');
    expect(code).toContain("document.documentElement.style.overflow = savedHtmlOverflow ?? '';");
    expect(code).toContain("document.body.style.overflow = savedBodyOverflow ?? '';");
  });

  it('keeps GitHub shortcut suppression inside editable shadow-root targets', () => {
    const code = source();

    expect(code).toContain("shadow.addEventListener('keydown', stopEditableKeydownAtShadowBoundary)");
    expect(code).not.toMatch(/addEventListener\('keydown',[\s\S]*?,\s*true\)/u);
    expect(code).toContain("document.addEventListener('turbo:load', sync);");
    expect(code).toContain("document.addEventListener('turbo:render', sync);");
    expect(code).toContain("window.addEventListener('popstate', sync);");
  });
});
