import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentMascotIcon,
  resolveAgentMascotState,
  type AgentMascotStateInput,
} from '@/ui/components/AgentMascot';

const IDLE_INPUT: AgentMascotStateInput = {
  chatStatus: null,
  chatRunning: false,
  hasAgentError: false,
  hasContextRecovery: false,
  preflightStatus: null,
  runState: null,
  automaticContinuation: false,
  hasWorkbenchError: false,
  workbenchDisconnected: false,
  hasReceipt: false,
};

describe('AgentMascot state resolution', () => {
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

  it.each([
    ['idle', {}],
    ['queued', { chatStatus: 'queued', chatRunning: true }],
    ['queued', { preflightStatus: 'requesting' }],
    ['queued', { runState: 'checking_provider' }],
    ['working', { chatStatus: 'working', chatRunning: true }],
    ['working', { runState: 'analyzing' }],
    ['working', { automaticContinuation: true }],
    ['compacting', { chatStatus: 'compacting', chatRunning: true }],
    ['tool', { chatStatus: 'tool', chatRunning: true }],
    ['tool', { runState: 'applying' }],
    ['waiting', { hasContextRecovery: true }],
    ['waiting', { preflightStatus: 'ready' }],
    ['waiting', { runState: 'review' }],
    ['done', { chatStatus: 'done' }],
    ['done', { preflightStatus: 'no_work' }],
    ['done', { hasReceipt: true }],
    ['stopped', { chatStatus: 'stopped' }],
    ['stopped', { runState: 'cancelled' }],
    ['error', { chatStatus: 'error' }],
    ['error', { runState: 'interrupted' }],
    ['error', { workbenchDisconnected: true }],
  ] as const)('returns %s for %o', (expected, overrides) => {
    expect(resolveAgentMascotState({ ...IDLE_INPUT, ...overrides })).toBe(expected);
  });

  it('keeps a workbench failure visible ahead of workbench activity', () => {
    expect(resolveAgentMascotState({
      ...IDLE_INPUT,
      hasWorkbenchError: true,
      runState: 'applying',
    })).toBe('error');
  });

  it('preserves a terminal chat event while its turn is still settling', () => {
    expect(resolveAgentMascotState({
      ...IDLE_INPUT,
      chatRunning: true,
      chatStatus: 'stopped',
    })).toBe('stopped');
    expect(resolveAgentMascotState({
      ...IDLE_INPUT,
      chatRunning: true,
      chatStatus: 'done',
    })).toBe('done');
  });

  it('lets new active work replace stale terminal chat status', () => {
    expect(resolveAgentMascotState({
      ...IDLE_INPUT,
      chatStatus: 'stopped',
      preflightStatus: 'starting',
    })).toBe('queued');
    expect(resolveAgentMascotState({
      ...IDLE_INPUT,
      chatStatus: 'done',
      runState: 'analyzing',
    })).toBe('working');
  });

  it('shows a running review follow-up as working instead of waiting', () => {
    expect(resolveAgentMascotState({
      ...IDLE_INPUT,
      chatRunning: true,
      chatStatus: 'working',
      runState: 'review',
    })).toBe('working');
  });
});
