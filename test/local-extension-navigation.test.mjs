import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { sharedDouyinPlugin } from '../scripts/build-extension.mjs';

const bundle = await build({ stdin: { contents: "export { resolveExtensionCard } from './local-extension/card-navigation.mjs'; export { createCollectionDiagnostics } from 'douyin-dom-core';", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [sharedDouyinPlugin()] });
const { resolveExtensionCard, createCollectionDiagnostics } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const search = new URL('https://www.douyin.com/search/奶瓶?type=general').href;
const video = 'https://www.douyin.com/video/7382727182054853891';
const row = { cardKey: 'fixture-0', cardText: '奶瓶实际视频', title: '奶瓶实际视频', sourceUrl: null };

function fixture(mode, { found = true, restored = true } = {}) {
  const tabs = new Map([[1, { id: 1, url: search }], [2, { id: 2, url: video }]]);
  const listeners = new Set(); const removed = []; const clicked = [];
  let clock = 0; let due = Infinity;
  const chromeApi = { tabs: {
    get: async (id) => { if (!tabs.has(id)) throw new Error('closed'); return { ...tabs.get(id) }; },
    onCreated: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    remove: async (id) => { removed.push(id); tabs.delete(id); },
    goBack: async () => { if (restored) tabs.get(1).url = search; }
  } };
  const evaluate = async (id, func, arg) => {
    assert.equal(id, 1);
    if (func.name === 'countSearchCards') return 1;
    if (func.name === 'dismissVideoModal') return;
    if (func.name === 'clickMarkedSearchCard') {
      assert.equal(arg.row.cardKey, row.cardKey); clicked.push(arg.selector); due = clock + 600;
      if (mode === 'popup') {
        tabs.set(3, { id: 3, openerTabId: 1, url: 'about:blank' });
        for (const listener of listeners) listener(tabs.get(3));
      }
      // An unrelated newly opened user tab must never be used or closed.
      tabs.set(4, { id: 4, openerTabId: 99, url: video });
      for (const listener of listeners) listener(tabs.get(4));
      return;
    }
    assert.equal(arg.cardKey, row.cardKey);
    return { found, reason: 'card_ambiguous' };
  };
  const wait = async (ms) => {
    clock += ms;
    if (clock >= due) {
      due = Infinity;
      if (mode === 'modal') tabs.get(1).url = `${search}&modal_id=7382727182054853891`;
      if (mode === 'path') tabs.get(1).url = video;
      if (mode === 'popup') tabs.get(3).url = video;
    }
  };
  const diagnostics = createCollectionDiagnostics();
  const run = () => resolveExtensionCard({ chromeApi, tabId: 1, row, evaluate, wait, diagnostics, query: '奶瓶', timeoutMs: 1000 });
  return { run, tabs, removed, clicked, listeners, diagnostics };
}

for (const mode of ['modal', 'path', 'popup']) test(`扩展点击取址 ${mode}：等待延迟地址并恢复，只关闭此次打开的视频标签`, async () => {
  const h = fixture(mode); const result = await h.run();
  assert.equal(result.rows[0].sourceUrl, video);
  assert.equal(h.tabs.get(1).url, search);
  assert.equal(h.tabs.get(2).url, video);
  assert.equal(h.tabs.has(4), true);
  assert.deepEqual(h.removed, mode === 'popup' ? [3] : []);
  assert.equal(h.diagnostics.clickResolvedCount, 1);
  assert.equal(h.listeners.size, 0);
});

test('没有新链接时不借用旧视频标签或无关新标签', async () => {
  const h = fixture('no-link'); const result = await h.run();
  assert.equal(result.rows.length, 0);
  assert.equal(h.diagnostics.linkFailureCount, 1);
  assert.equal(h.diagnostics.failureReasons.url_unresolved, 1);
  assert.deepEqual(h.removed, []);
  assert.equal(h.listeners.size, 0);
});

test('同名卡片无法唯一确定时不点击', async () => {
  const h = fixture('modal', { found: false }); const result = await h.run();
  assert.equal(result.rows.length, 0);
  assert.deepEqual(h.clicked, []);
  assert.equal(h.diagnostics.failureReasons.card_ambiguous, 1);
});

test('返回失败报告中断，不能重新加载搜索页而丢失原排序', async () => {
  const h = fixture('modal', { restored: false }); await h.run();
  assert.equal(h.diagnostics.restoreFailureCount, 1);
  assert.equal(h.diagnostics.failureReasons.search_restore_failed, 1);
  assert.equal(h.clicked.length, 1);
  assert.equal(h.listeners.size, 0);
});
