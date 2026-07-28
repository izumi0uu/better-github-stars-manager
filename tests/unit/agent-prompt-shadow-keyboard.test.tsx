// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopEditableKeydownAtShadowBoundary } from '@/content/stars-page/keyboard-boundary';
import { PromptInput } from '@/ui/ai-elements/chat';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

describe('Agent prompt ShadowRoot keyboard boundary', () => {
  it('submits plain Enter after the target handler while containing GitHub shortcuts', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.appendChild(container);
    shadow.addEventListener('keydown', stopEditableKeydownAtShadowBoundary);
    const onSubmit = vi.fn();
    const documentKeydown = vi.fn();
    document.addEventListener('keydown', documentKeydown);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PromptInput
          value="tag this repository"
          onValueChange={() => {}}
          onSubmit={onSubmit}
          placeholder="Ask"
          submitLabel="Send"
          inputLabel="Message"
        />,
      );
    });
    const textarea = shadow.querySelector('textarea');
    expect(textarea).toBeTruthy();
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    await act(async () => {
      textarea!.dispatchEvent(enter);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(enter.defaultPrevented).toBe(true);
    expect(documentKeydown).not.toHaveBeenCalled();

    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    const composingEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      composed: true,
      cancelable: true,
      isComposing: true,
    });
    await act(async () => {
      textarea!.dispatchEvent(shiftEnter);
      textarea!.dispatchEvent(composingEnter);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(documentKeydown).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    document.removeEventListener('keydown', documentKeydown);
  });
});
