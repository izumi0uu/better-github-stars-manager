import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'vitest';
import { mountState, pageOwner } from '@/content/stars-page/mount-state';
import {
  hidePanel,
  isPanelEnabled,
  onPanelToggle,
  resetPanelToggle,
  showPanel,
} from '@/content/stars-page/panel-toggle';

const source = () => readFileSync('src/content/stars-page/index.tsx', 'utf8');

describe('stars-page mount and toggle invariants', () => {
  beforeEach(() => {
    resetPanelToggle();
    onPanelToggle(() => {});
  });

  it('derives owner only from supported stars profile paths', () => {
    assert.equal(pageOwner('/idah'), 'idah');
    assert.equal(pageOwner('/users/Idah'), 'idah');
    assert.equal(pageOwner('/stars'), null);
    assert.equal(pageOwner('/orgs/github'), null);
    assert.equal(pageOwner('/idah/repo'), null);
  });

  it('maps ownership and effective enabled state to panel, fab, or none', () => {
    assert.equal(mountState(false, true), 'none');
    assert.equal(mountState(false, false), 'none');
    assert.equal(mountState(true, true), 'panel');
    assert.equal(mountState(true, false), 'fab');
  });

  it('keeps hide/show session-local and resettable over persisted defaults', () => {
    let dispatches = 0;
    onPanelToggle(() => {
      dispatches += 1;
    });

    assert.equal(isPanelEnabled(true), true);
    hidePanel();
    assert.equal(isPanelEnabled(true), false);
    assert.equal(isPanelEnabled(false), false);
    showPanel();
    assert.equal(isPanelEnabled(false), true);
    resetPanelToggle();
    assert.equal(isPanelEnabled(false), false);
    assert.equal(dispatches, 2);
  });

  it('guards stale async sync results with a generation check before DOM mutation', () => {
    const code = source();
    const syncBlock = code.slice(code.indexOf('async function sync'), code.indexOf('onPanelToggle(sync)'));
    assert.match(syncBlock, /const gen = \+\+syncGen;/);
    assert.match(syncBlock, /await Promise\.all\(\[isOwnStars\(\), authStore\.getConfig\(\)\]\)/);
    assert.match(syncBlock, /if \(gen !== syncGen\) return;/);
    assert.ok(
      syncBlock.indexOf('if (gen !== syncGen) return;') < syncBlock.indexOf('if (state === \'panel\')'),
      'stale generation check must run before injectPanel/ejectFab mutations',
    );
  });

  it('resets the session toggle only when the persisted default changes', () => {
    const code = source();
    const listenerBlock = code.slice(code.indexOf('chrome.storage.onChanged.addListener'), code.length);
    assert.match(listenerBlock, /if \(areaName !== 'local' \|\| !changes\[CONFIG_STORAGE_KEY\]\) return;/);
    assert.match(listenerBlock, /if \(oldCfg\?\.starsPanelDefaultEnabled === newCfg\?\.starsPanelDefaultEnabled\) return;/);
    assert.match(listenerBlock, /resetPanelToggle\(\);/);
    assert.ok(
      listenerBlock.indexOf('resetPanelToggle();') < listenerBlock.indexOf('void sync();'),
      'config-change sync should observe the reset session override',
    );
  });

  it('keeps panel and fab injection idempotent and restores captured scroll values', () => {
    const code = source();
    assert.match(code, /if \(document\.getElementById\('gsm-manager-host'\)\) return; \/\/ idempotent/);
    assert.match(code, /if \(document\.getElementById\('gsm-fab'\)\) return; \/\/ idempotent/);
    assert.match(code, /savedHtmlOverflow = document\.documentElement\.style\.overflow;/);
    assert.match(code, /savedBodyOverflow = document\.body\.style\.overflow;/);
    assert.match(code, /document\.documentElement\.style\.overflow = savedHtmlOverflow \?\? '';/);
    assert.match(code, /document\.body\.style\.overflow = savedBodyOverflow \?\? '';/);
  });
});
