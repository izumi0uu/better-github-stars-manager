import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentMascot,
  AgentMascotIcon,
  type AgentMascotState,
} from '@/ui/components/AgentMascot';

const MASCOT_STATES = [
  'idle',
  'queued',
  'working',
  'compacting',
  'tool',
  'waiting',
  'done',
  'stopped',
  'error',
] as const satisfies readonly AgentMascotState[];

describe('AgentMascot rendering', () => {
  it('renders the idle toolbar mascot as a static decorative image', () => {
    const markup = renderToStaticMarkup(createElement(AgentMascotIcon));

    expect(markup).toContain('data-testid="agent-mascot-icon"');
    expect(markup).toContain('data-state="idle"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('draggable="false"');
    expect(markup).toContain('index-agent-static');
    expect(markup).not.toContain('index-agent-working');
    expect(markup).not.toContain('animation');
  });

  it('renders the working GIF with a static reduced-motion fallback', () => {
    const markup = renderToStaticMarkup(createElement(AgentMascotIcon, { running: true }));

    expect(markup).toContain('data-state="working"');
    expect(markup).toContain('index-agent-working');
    expect(markup).toContain('media="(prefers-reduced-motion: reduce)"');
    expect(markup).toContain('index-agent-static');
    expect(markup).not.toContain('aria-label="Loading"');
  });

  it.each(MASCOT_STATES)('renders the %s sprite selected by the unified presentation', (state) => {
    const markup = renderToStaticMarkup(createElement(AgentMascot, { state, playing: true }));

    expect(markup).toContain(`data-state="${state}"`);
    expect(markup).toContain('data-playing="true"');
    expect(markup).toContain('data-testid="agent-mascot"');
    expect(markup).toContain('index-agent-atlas');
    expect(markup).toContain('aria-hidden="true"');
  });
});
