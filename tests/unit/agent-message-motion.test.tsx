import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Message } from '@/ui/ai-elements/chat';

describe('Agent message motion', () => {
  it('marks message bubbles with their conversational direction', () => {
    const user = renderToStaticMarkup(<Message role="user">Sent</Message>);
    const assistant = renderToStaticMarkup(<Message role="assistant">Received</Message>);

    expect(user).toContain('data-role="user"');
    expect(user).toContain('gsm-agent-message-bubble');
    expect(assistant).toContain('data-role="assistant"');
    expect(assistant).toContain('gsm-agent-message-bubble');
  });

  it('uses mount-only compositor motion with directional offsets', () => {
    const motion = readFileSync('src/ui/styles/motion.css', 'utf8');
    const bubbleRule = motion.match(/\.gsm-agent-message-bubble\s*\{([^}]*)\}/)?.[1] ?? '';
    const startingStyle = motion.match(/@starting-style\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';

    expect(bubbleRule).toContain('opacity: 1');
    expect(bubbleRule).toContain('transform: translate3d(0, 0, 0) scale(1)');
    expect(bubbleRule).not.toMatch(/transition:\s*all/);
    expect(motion).toContain("[data-role='user'] .gsm-agent-message-bubble");
    expect(motion).toContain('--gsm-agent-message-enter-x: 8px');
    expect(motion).toContain("[data-role='assistant'] .gsm-agent-message-bubble");
    expect(motion).toContain('--gsm-agent-message-enter-x: -8px');
    expect(startingStyle).toContain('scale(0.985)');
  });
});
