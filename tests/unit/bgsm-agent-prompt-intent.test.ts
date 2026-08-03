import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { analyzeBgsmPromptIntent } from '@/bgsm-agent';
import { getMessages } from '@/i18n';

describe('Cubby prompt intent', () => {
  it('does not classify ordinary conversation or positive tag intent in code', () => {
    for (const prompt of [
      'hello',
      '你是谁',
      'Auto assign useful tags for my starred repositories.',
      '给它加上 chrome-extension 标签。',
      '把它标记为 chrome-extension。',
      'Please handle the repository we just discussed.',
      'owner/repo is labeled as productivity.',
      "Don't explain; add the chrome-extension tag.",
      "Do not read my notes. Add the chrome-extension tag.",
      '不要解释，直接给它加上 chrome-extension 标签。',
      'Tag repositories without existing tags.',
      'Tag repositories to avoid duplicates.',
      '给不能联网的仓库添加 offline 标签。',
      '给无需配置的仓库添加 zero-config 标签。',
      '给禁止联网的仓库添加 offline 标签。',
      '给这些禁止联网的仓库添加 offline 标签。',
      '为所有禁止修改配置的仓库添加 restricted 标签。',
      '给禁止在后台联网的仓库添加 offline 标签。',
      '我想给这些禁止联网的仓库添加 offline 标签。',
      '给所有禁止联网的私有仓库添加 offline 标签。',
      '我想给这些禁止联网的开源项目添加 offline 标签。',
    ]) {
      assert.deepEqual(analyzeBgsmPromptIntent(prompt).capabilities, {
        manualTagWritesForbidden: false,
        repositoryCodeSearch: false,
        repositoryNotes: false,
      }, prompt);
    }
  });

  it('recognizes repository code search without treating it as a write request', () => {
    const english = analyzeBgsmPromptIntent('Find the implementation of createFrozenScope in this code.');
    const chinese = analyzeBgsmPromptIntent('查找这个仓库里创建冻结范围的源码实现');
    assert.equal(english.capabilities.repositoryCodeSearch, true);
    assert.equal(english.capabilities.manualTagWritesForbidden, false);
    assert.equal(chinese.capabilities.repositoryCodeSearch, true);
  });

  it('recognizes repository directory listing and bounded file reading as code access', () => {
    for (const prompt of [
      'List the files in this repository.',
      'Browse the source directory.',
      'List repository directories.',
      'Open the implementation file.',
      'Open this source path.',
      '列出这个仓库的文件目录。',
      '浏览源码文件树。',
      '打开这个实现文件。',
      '打开这个源码路径。',
    ]) {
      const intent = analyzeBgsmPromptIntent(prompt);
      assert.equal(intent.capabilities.repositoryCodeSearch, true, prompt);
      assert.equal(intent.capabilities.manualTagWritesForbidden, false, prompt);
    }
  });

  it('recognizes direct repository paths, common filenames, and symbol locations', () => {
    for (const prompt of [
      'Open package.json.',
      'Read README.md in this repo.',
      'Browse src/components/AgentPanel.tsx.',
      'Read src/index.ts.',
      'Open lib/main.py.',
      '查看 docs/README.md。',
      'Where is createFrozenScope defined?',
      '打开 package.json。',
      '读取 src/background/index.ts。',
      'createFrozenScope 在哪里定义？',
    ]) {
      const intent = analyzeBgsmPromptIntent(prompt);
      assert.equal(intent.capabilities.repositoryCodeSearch, true, prompt);
      assert.equal(intent.capabilities.manualTagWritesForbidden, false, prompt);
    }
    assert.equal(
      analyzeBgsmPromptIntent('Open example.com in a browser.').capabilities.repositoryCodeSearch,
      false,
    );
    for (const prompt of [
      'Find owner/repo in my stars.',
      'Show notes for owner/repo.',
      'Find owner/repo and assign tags.',
      'Find owner/pdf.js in my stars.',
      'Show notes for owner/tool.py.',
      'Find owner/package.json and assign tags.',
    ]) {
      assert.equal(analyzeBgsmPromptIntent(prompt).capabilities.repositoryCodeSearch, false, prompt);
    }
  });

  it('leaves varied positive tag-write semantics to the model', () => {
    for (const prompt of [
      'Based on the code above, assign useful tags to owner/repo.',
      'Based on the previous result above, assign tags to owner/repo.',
      'Use the previous implementation to add tags to owner/repo.',
      '根据刚才的源码实现给 owner/repo 添加标签。',
      '根据上面的内容给 owner/repo 添加标签。',
      'Assign an open-source tag to owner/repo.',
      '加个 chrome-extension 标签。',
      '给这个仓库贴上 productivity 标签。',
      '补上这个标签。',
      '继续写入这个标签。',
      '应用建议的标签。',
      '帮我把它归类为 productivity。',
      '设置为 github-stars。',
      'Mark owner/repo as chrome-extension.',
      'Please label owner/repo with productivity.',
      'Could you categorize owner/repo as a GitHub tool?',
    ]) {
      const intent = analyzeBgsmPromptIntent(prompt);
      assert.equal(intent.capabilities.manualTagWritesForbidden, false, prompt);
      assert.equal(intent.capabilities.repositoryCodeSearch, false, prompt);
    }
    assert.equal(
      analyzeBgsmPromptIntent('Open the source file for owner/repo.').capabilities.repositoryCodeSearch,
      true,
    );
  });

  it('retains deterministic denial only for explicit tag-write prohibitions', () => {
    for (const prompt of [
      'Do not tag owner/repo.',
      'Never assign tags to owner/repo.',
      'You must not add tags to owner/repo.',
      'You cannot change tags on owner/repo.',
      "You can't tag owner/repo.",
      'Please refrain from tagging owner/repo.',
      'Continue without changing tags on owner/repo.',
      'No tagging owner/repo.',
      'No tag changes for owner/repo.',
      'No changes to the tags.',
      'Leave the tags unchanged.',
      'Keep tags as-is.',
      '不要给 owner/repo 添加标签。',
      '不得给 owner/repo 添加标签。',
      '禁止修改 owner/repo 的标签。',
      '你不能给 owner/repo 添加标签。',
      '您不可修改 owner/repo 的标签。',
      '这次无需添加标签。',
      '你们不能给 owner/repo 添加标签。',
      '这次你不能给 owner/repo 添加标签。',
      '禁止在归档的仓库中添加标签。',
      '禁止向所有归档的仓库添加标签。',
      '禁止在归档的私有仓库中添加标签。',
      '别给 owner/repo 添加标签。',
      'Do not remove tag legacy from owner/repo.',
      'Never delete tag obsolete everywhere.',
      '不要从 owner/repo 移除标签 legacy。',
      '禁止从所有仓库删除标签 obsolete。',
    ]) {
      assert.equal(
        analyzeBgsmPromptIntent(prompt).capabilities.manualTagWritesForbidden,
        true,
        prompt,
      );
    }
  });

  it('does not use positive remove or delete phrasing as a capability gate', () => {
    for (const prompt of [
      'Remove tag legacy from owner/repo.',
      'Delete obsolete and unused tags everywhere.',
      '从 owner/repo 移除标签 legacy。',
      '从所有仓库删除标签 obsolete。',
    ]) {
      assert.equal(
        analyzeBgsmPromptIntent(prompt).capabilities.manualTagWritesForbidden,
        false,
        prompt,
      );
    }
  });

  it('recognizes explicit English and Chinese note requests without implying writes', () => {
    for (const prompt of [
      'Show me the notes for owner/repo.',
      'Summarize my repository notes.',
      '查看 owner/repo 的笔记。',
      '根据我的备注说明为什么收藏这个项目。',
    ]) {
      const intent = analyzeBgsmPromptIntent(prompt);
      assert.equal(intent.capabilities.repositoryNotes, true, prompt);
      assert.equal(intent.capabilities.manualTagWritesForbidden, false, prompt);
    }
  });

  it('does not enable note access for casual or negated mentions', () => {
    for (const prompt of [
      'Notes are a useful product feature.',
      'Do not read my notes.',
      '不要查看我的备注。',
      'Continue.',
    ]) {
      assert.equal(analyzeBgsmPromptIntent(prompt).capabilities.repositoryNotes, false, prompt);
    }
  });

  it('keeps an explicitly read-only notes request available when tag writes are negated', () => {
    const intent = analyzeBgsmPromptIntent("Don't change any tags; show my notes for owner/repo.");
    assert.equal(intent.capabilities.repositoryNotes, true);
    assert.equal(intent.capabilities.manualTagWritesForbidden, true);
  });

  it('routes localized function-menu prompts to their intended read capabilities', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const messages = getMessages(locale).agentPanel;
      const summary = analyzeBgsmPromptIntent(messages.summarizeScopePrompt);
      assert.deepEqual(summary.capabilities, {
        manualTagWritesForbidden: true,
        repositoryCodeSearch: false,
        repositoryNotes: false,
      });

      const code = analyzeBgsmPromptIntent(messages.searchCodePrompt);
      assert.equal(code.capabilities.repositoryCodeSearch, true, `${locale}: code`);
      assert.equal(code.capabilities.manualTagWritesForbidden, true, `${locale}: code write`);

      const notes = analyzeBgsmPromptIntent(messages.reviewNotesPrompt);
      assert.equal(notes.capabilities.repositoryNotes, true, `${locale}: notes`);
      assert.equal(notes.capabilities.manualTagWritesForbidden, true, `${locale}: notes write`);
    }
  });
});
