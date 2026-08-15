/**
 * @vitest-environment jsdom
 */
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { getMessages, I18nProvider, messageFor, useI18n } from '@/i18n';
import { getAgentDiagnosticsMessages } from '@/dev-agent/messages';
import { applyFabLabel } from '@/content/stars-page/fab-label';
import type { Locale } from '@/types';

const authMock = vi.hoisted(() => ({
  getLocale: vi.fn<() => Promise<Locale>>(),
  setLocale: vi.fn<(locale: Locale) => Promise<void>>(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  authStore: authMock,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];

function collectShape(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'function') return { [prefix]: `function:${value.length}` };
  if (!value || typeof value !== 'object') return { [prefix]: typeof value };
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => Object.entries(collectShape(child, prefix ? `${prefix}.${key}` : key))),
  );
}

function Consumer() {
  const { locale, setLocale, m } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{m.popup.title}</span>
      <button type="button" onClick={() => void setLocale(locale === 'en' ? 'zh-CN' : 'en')}>
        switch
      </button>
    </div>
  );
}

function mountProvider() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );
  });
  roots.push(root);
  return host;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  storageListeners = [];
  authMock.getLocale.mockReset();
  authMock.setLocale.mockReset();
  authMock.getLocale.mockResolvedValue('en');
  authMock.setLocale.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    storage: {
      onChanged: {
        addListener: vi.fn((listener) => storageListeners.push(listener)),
        removeListener: vi.fn((listener) => {
          storageListeners = storageListeners.filter((item) => item !== listener);
        }),
      },
    },
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('i18n catalog and locale propagation invariants', () => {
  it('keeps catalog key and value-type parity across supported locales', () => {
    assert.deepEqual(collectShape(getMessages('zh-CN')), collectShape(getMessages('en')));
  });

  it('falls back predictably and exposes messageFor as the same lookup function', () => {
    assert.equal(getMessages('en'), messageFor('en'));
    assert.equal(getMessages('missing' as Locale), getMessages('en'));
    assert.equal(messageFor('missing' as Locale), getMessages('en'));
  });

  it('keeps generic Cubby lifecycle statuses separate from tag operations', () => {
    const english = getMessages('en').agentPanel;
    const chinese = getMessages('zh-CN').agentPanel;

    assert.deepEqual(
      [english.agentStarting, english.agentThinking, english.agentWriting, english.agentCompacting],
      ['Gathering context…', 'Looking into it…', 'Putting the answer together…', 'Tidying up our conversation…'],
    );
    assert.deepEqual(
      [chinese.agentStarting, chinese.agentThinking, chinese.agentWriting, chinese.agentCompacting],
      ['正在收集上下文…', '正在仔细查看…', '正在整理答案…', '正在整理这段对话…'],
    );
    assert.equal(chinese.agentApplyingChanges, '正在应用标签变更…');
  });

  it('keeps Cubby scope summaries natural and localized', () => {
    const english = getMessages('en').agentPanel;
    const chinese = getMessages('zh-CN').agentPanel;

    assert.equal(english.askingAboutCurrentView(2), 'Current view · 2 repositories');
    assert.equal(chinese.askingAboutCurrentView(2), '当前视图 · 2 个仓库');
    assert.equal(english.askingAboutAllLiveStars(2), 'All starred repositories · 2 repositories');
    assert.equal(chinese.askingAboutAllLiveStars(2), '全部星标仓库 · 2 个仓库');
    assert.equal(
      english.workbench.repositoriesFrozen(290),
      'This analysis will include 290 repositories.',
    );
    assert.equal(chinese.workbench.repositoriesFrozen(290), '将分析 290 个仓库。');
  });

  it('localizes ownership conflicts and bounded Organize retention', () => {
    const english = getMessages('en');
    const chinese = getMessages('zh-CN');

    assert.equal(english.agentPanel.workbench.takeControl, 'Take control');
    assert.equal(chinese.agentPanel.workbench.takeControl, '接管控制');
    assert.equal(
      english.agentPanel.workbench.takeControlFailedOwnerConnected,
      'The controlling page reconnected, so this page stays read-only.',
    );
    assert.equal(
      chinese.agentPanel.workbench.receiptOriginDeleted,
      '该结果来自一个已删除的对话。',
    );
    assert.match(english.options.agentStorageOrganizeRetention, /separate and bounded/u);
    assert.match(chinese.options.agentStorageOrganizeRetention, /单独有界保存/u);
    assert.match(english.agentPanel.sessionDeleteMessage('Draft'), /completed or cancelled/u);
    assert.match(chinese.agentPanel.sessionDeleteMessage('草稿'), /已完成或已取消/u);
  });

  it('uses Cubby consistently across both product locales', () => {
    const english = getMessages('en');
    const chinese = getMessages('zh-CN');

    assert.deepEqual(
      [
        english.toolbar.agentButton,
        english.agentPanel.title,
        english.agentPanel.agentSettings,
        english.options.agentHeading,
      ],
      ['Cubby', 'Cubby', 'Cubby settings', '2. Cubby'],
    );
    assert.deepEqual(
      [
        chinese.toolbar.agentButton,
        chinese.agentPanel.title,
        chinese.agentPanel.agentSettings,
        chinese.options.agentHeading,
      ],
      ['Cubby', 'Cubby', 'Cubby 设置', '2. Cubby'],
    );
  });

  it('keeps Options section numbering continuous in both product locales', () => {
    const english = getMessages('en').options;
    const chinese = getMessages('zh-CN').options;

    assert.deepEqual(
      [
        english.tokenHeading,
        english.agentHeading,
        english.gistHeading,
        english.behaviorHeading,
      ],
      [
        '1. GitHub Classic PAT',
        '2. Cubby',
        '3. Gist sync',
        '4. Preferences',
      ],
    );
    assert.deepEqual(
      [
        chinese.tokenHeading,
        chinese.agentHeading,
        chinese.gistHeading,
        chinese.behaviorHeading,
      ],
      [
        '1. GitHub Classic PAT',
        '2. Cubby',
        '3. Gist 同步',
        '4. 偏好设置',
      ],
    );
  });

  it('names the bounded Cubby ledger and separate Organize storage in both locales', () => {
    const english = getMessages('en').options;
    const chinese = getMessages('zh-CN').options;

    assert.equal(english.agentStorageDurableData, 'Conversation, recovery & saved artifacts');
    assert.equal(english.agentStorageToolCache, 'Re-fetchable tool cache');
    assert.equal(english.agentStorageLedgerTotal, 'Conversation, recovery & artifact ledger total');
    assert.match(english.agentStorageIntro, /does not represent all Cubby or extension storage/u);
    for (const phrase of [
      'active or preflight task instructions and frozen scope',
      'proposal, Apply, and receipt records',
      'one latest completed or cancelled result',
      'None is counted in this ledger',
      'Deleting the origin conversation keeps that latest result',
    ]) {
      assert.match(english.agentStorageOrganizeRetention, new RegExp(phrase, 'u'));
    }
    assert.equal(
      english.agentStorageThresholds('256 MiB', '512 MiB'),
      'This ledger only: warning at 256 MiB · new ledger writes refused at 512 MiB',
    );
    assert.equal(
      english.agentStorageBrowserUsage('20 MiB', '2 GiB'),
      'Whole-extension browser storage estimate: 20 MiB of 2 GiB',
    );
    assert.match(english.agentStorageClearHint, /Final answers and conversation transcripts/u);
    assert.match(english.agentStorageCacheCleared(2, '4 MiB', 1), /cached tool artifacts/u);

    assert.equal(chinese.agentStorageDurableData, '对话、恢复与已保存工件');
    assert.equal(chinese.agentStorageToolCache, '可重新获取的工具缓存');
    assert.equal(chinese.agentStorageLedgerTotal, '对话、恢复与工件账本总量');
    assert.match(chinese.agentStorageIntro, /不代表 Cubby 或扩展的全部存储/u);
    for (const phrase of [
      '活动中或预检阶段的任务指令与冻结范围',
      '提案、Apply 与回执记录',
      '最近一次已完成或已取消的结果',
      '均不计入此账本',
      '删除来源对话仍会保留该最近结果',
    ]) {
      assert.match(chinese.agentStorageOrganizeRetention, new RegExp(phrase, 'u'));
    }
    assert.equal(
      chinese.agentStorageThresholds('256 MiB', '512 MiB'),
      '仅此账本：256 MiB 时提醒 · 512 MiB 时拒绝新的账本写入',
    );
    assert.equal(
      chinese.agentStorageBrowserUsage('20 MiB', '2 GiB'),
      '整个扩展的浏览器存储估算：已用 20 MiB，可用额度 2 GiB',
    );
    assert.match(chinese.agentStorageClearHint, /最终回答与对话记录/u);
  });

  it('names provider-required authentication without weakening credential exclusion', () => {
    const english = getMessages('en').options;
    const chinese = getMessages('zh-CN').options;

    assert.match(english.agentDisclosureNotSentSecrets, /API keys, other credentials/u);
    assert.match(english.agentDisclosureKeyException, /provider-required authentication header/u);
    assert.match(english.agentDisclosureKeyException, /Anthropic's x-api-key/u);
    assert.doesNotMatch(english.agentDisclosureKeyException, /as an Authorization header/u);
    assert.match(chinese.agentDisclosureNotSentSecrets, /API 密钥、其他凭据/u);
    assert.match(chinese.agentDisclosureKeyException, /服务商要求的认证请求头/u);
    assert.match(chinese.agentDisclosureKeyException, /Anthropic 使用 x-api-key/u);
    assert.doesNotMatch(chinese.agentDisclosureLocalHistory, /最多\s*128/u);
    assert.doesNotMatch(english.agentDisclosureLocalHistory, /at most\s*128/u);
  });

  it('localizes Watch background failures in both product locales', () => {
    const english = getMessages('en').background;
    const chinese = getMessages('zh-CN').background;

    assert.equal(english.watchDisconnectFailed, 'Watch Inbox disconnect failed.');
    assert.equal(chinese.watchDisconnectFailed, '断开 Watch 收件箱失败。');
    assert.equal(english.watchInboxQueryInvalid, 'Invalid Watch inbox query.');
    assert.equal(chinese.watchInboxQueryInvalid, 'Watch 收件箱查询无效。');
  });

  it('keeps Classic PAT authorization explicit across recovery surfaces', () => {
    const english = getMessages('en');
    const chinese = getMessages('zh-CN');

    assert.match(english.manager.noTokenBanner, /GitHub Classic PAT/u);
    assert.match(chinese.manager.noTokenBanner, /GitHub Classic PAT/u);
    assert.match(english.watch.inboxPermissionDenied, /GitHub Classic PAT/u);
    assert.match(chinese.watch.inboxPermissionDenied, /GitHub Classic PAT/u);
    assert.match(english.radar.permissionBody, /GitHub Classic PAT/u);
    assert.match(chinese.radar.permissionBody, /GitHub Classic PAT/u);
    assert.equal(english.popup.connectionRejected, '401 — Classic PAT rejected or expired');
    assert.equal(chinese.popup.connectionRejected, '401 — Classic PAT 被拒绝或已过期');
    assert.match(english.onboarding.noTokenBody, /GitHub Classic PAT/u);
    assert.match(chinese.onboarding.noTokenBody, /GitHub Classic PAT/u);
  });

  it('localizes the development Cubby diagnostics surface while preserving raw evidence identifiers', () => {
    const english = getAgentDiagnosticsMessages('en');
    const chinese = getAgentDiagnosticsMessages('zh-CN');

    assert.equal(english.title, 'Cubby Diagnostics');
    assert.equal(chinese.title, 'Cubby 诊断');
    assert.equal(chinese.rawCapture, '单次原始捕获');
    assert.equal(chinese.providerDebug, 'Provider 调试');
    assert.equal(chinese.testSavedProvider, '测试已保存的 Provider');
    assert.equal(chinese.retainedOperations(2), '2 个保留操作');
    assert.equal(chinese.evidenceRequestFailed('internal_error'), '获取证据失败: internal_error');
    assert.equal(chinese.openAgentDiagnostics, '打开 Cubby 诊断');
  });

  it('starts with Chinese, then honors a stored English locale on mount', async () => {
    authMock.getLocale.mockResolvedValue('en');
    const host = mountProvider();

    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'zh-CN');
    await flush();
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'en');
    assert.equal(host.querySelector('[data-testid="title"]')?.textContent, getMessages('en').popup.title);
  });

  it('updates context from local config locale changes and ignores unrelated storage changes', async () => {
    const host = mountProvider();
    await flush();
    assert.equal(storageListeners.length, 1);
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'en');

    authMock.getLocale.mockResolvedValue('zh-CN');
    await act(async () => {
      storageListeners[0]?.({ other: { oldValue: 1, newValue: 2 } }, 'local');
      storageListeners[0]?.({ gsm_config: { oldValue: { locale: 'en' }, newValue: { locale: 'zh-CN' } } }, 'sync');
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'en');

    await act(async () => {
      storageListeners[0]?.({ gsm_config: { oldValue: { locale: 'en' }, newValue: { locale: 'zh-CN' } } }, 'local');
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'zh-CN');
  });

  it('optimistically switches locale before persistence resolves', async () => {
    let resolveWrite: (() => void) | null = null;
    authMock.setLocale.mockImplementation(() => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));
    const host = mountProvider();
    await flush();

    await act(async () => {
      (host.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-testid="locale"]')?.textContent, 'zh-CN');
    assert.deepEqual(authMock.setLocale.mock.calls.at(-1), ['zh-CN']);

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });
  });

  it('applies the content-script FAB label through the shared non-React message lookup', () => {
    const host = document.createElement('div');
    host.id = 'gsm-fab';
    const button = document.createElement('button');
    host.appendChild(button);
    document.body.appendChild(host);

    assert.equal(applyFabLabel(button, 'zh-CN'), true);
    assert.equal(button.getAttribute('data-tip'), getMessages('zh-CN').popup.title);
    assert.equal(button.getAttribute('aria-label'), getMessages('zh-CN').popup.title);

    host.remove();
    assert.equal(applyFabLabel(button, 'en'), false);
    assert.equal(button.getAttribute('data-tip'), getMessages('zh-CN').popup.title);
  });
});
