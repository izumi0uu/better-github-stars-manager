import { describe, expect, it } from 'vitest';
import {
  AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED,
  translateError,
} from '@/api/errors';
import {
  AgentProviderError,
  isStructuredProviderContextOverflow,
  publicAgentProviderErrorMessage,
} from '@/agent-harness/provider';
import { getMessages } from '@/i18n';
import { AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE } from '@/bgsm-agent/turn-protocol';

describe('Agent provider error translation', () => {
  it('uses fixed content-free copy for context overflow', () => {
    const error = new AgentProviderError(
      'context_overflow',
      'provider-authored secret must not be used',
      400,
    );
    expect(publicAgentProviderErrorMessage(error))
      .toBe('AI provider request exceeded the model context window.');
  });

  it.each(['protocol_error', 'parse_error'] as const)(
    'maps %s to bounded copy without raw protocol detail or secrets',
    (code) => {
      const secret = 'sk-secret-do-not-show';
      const raw = `Responses stream invalid Anthropic message ${secret}`;

      for (const locale of ['en', 'zh-CN'] as const) {
        const translated = translateError(
          new AgentProviderError(code, raw),
          getMessages(locale),
        );
        expect(translated).not.toContain(secret);
        expect(translated).not.toContain('Responses');
        expect(translated).not.toContain('Anthropic');
        expect(translated).not.toContain('stream');
        expect(translated).not.toContain('message');
      }
    },
  );

  it('maps artifact coverage stalls to bounded localized copy', () => {
    const secret = 'cursor-and-storage-secret';
    for (const locale of ['en', 'zh-CN'] as const) {
      const translated = translateError({
        code: AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE,
        message: secret,
      }, getMessages(locale));
      expect(translated).not.toContain(secret);
      expect(translated.length).toBeGreaterThan(0);
    }
  });

  it('maps the Firefox personal-communications gate to stable localized copy', () => {
    const english = translateError(
      new Error(AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED),
      getMessages('en'),
    );
    const chinese = translateError(
      new Error(AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED),
      getMessages('zh-CN'),
    );
    expect(english).toContain("Firefox's personal-communications permission");
    expect(chinese).toContain('Firefox');
    expect(chinese).toContain('权限');
    expect(english).not.toContain(AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED);
    expect(chinese).not.toContain(AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED);
  });

  it.each([
    'Monthly token limit exceeded for this account.',
    'Organization token quota exhausted.',
    'Insufficient credits or billing balance.',
    'TPM quota exceeded for this deployment.',
  ])('does not classify provider quota text as context overflow: %s', (message) => {
    expect(isStructuredProviderContextOverflow({ error: { message } }, 'openai', 429))
      .toBe(false);
  });
});
