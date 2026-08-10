// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractRepoFullName, isUnstarElement } from '@/content/stars-page/native-star-listener';

describe('native-star-listener', () => {
  it('detects unstar forms and buttons correctly', () => {
    const form = document.createElement('form');
    form.action = 'https://github.com/facebook/react/unstar';
    const button = document.createElement('button');
    button.type = 'submit';
    button.setAttribute('aria-label', 'Unstar this repository');
    form.appendChild(button);
    document.body.appendChild(form);

    expect(isUnstarElement(button)).toBe(true);
    expect(extractRepoFullName(button)).toBe('facebook/react');

    document.body.removeChild(form);
  });

  it('ignores star (non-unstar) elements', () => {
    const form = document.createElement('form');
    form.action = 'https://github.com/facebook/react/star';
    const button = document.createElement('button');
    button.type = 'submit';
    button.setAttribute('aria-label', 'Star this repository');
    form.appendChild(button);
    document.body.appendChild(form);

    expect(isUnstarElement(button)).toBe(false);

    document.body.removeChild(form);
  });
});
