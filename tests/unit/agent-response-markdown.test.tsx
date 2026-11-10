import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageResponse } from '@/ui/ai-elements/response';

describe('agent response network boundaries', () => {
  it('renders text and links without embedding provider-controlled remote resources', () => {
    const html = renderToStaticMarkup(<MessageResponse linkSafety={{ enabled: false }}>{'![preview](https://example.invalid/pixel?data=synthetic)\n\n[reference](https://example.com/docs)\n\n<img src="https://example.invalid/raw" />'}</MessageResponse>);
    expect(html).not.toMatch(/<img\b|<iframe\b/);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('reference');
  });

  it('keeps security settings authoritative and removes unsafe link protocols', () => {
    const html = renderToStaticMarkup(<MessageResponse linkSafety={{ enabled: false }} skipHtml={false} disallowedElements={[]} urlTransform={(url) => url}>{'<img src="https://example.invalid/raw" />\n\n[unsafe](javascript:alert)\n\n![remote](https://example.invalid/pixel)'}</MessageResponse>);
    expect(html).not.toMatch(/<img\b|href="javascript:/);
  });
});
