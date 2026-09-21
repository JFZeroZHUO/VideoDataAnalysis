import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React, { act } from 'react';
import { create } from 'react-test-renderer';

const built = await build({ entryPoints: [fileURLToPath(new URL('../src/ResearchWorkspace.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_STORAGE_MODE":"extension"}' } });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const Workspace = loaded.exports.default;

test('online UI reads extension data, supports exact keywords, ordinary mode, settings and Douyin-only platform', async () => {
  const previous = { window: globalThis.window, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Set(); const calls = []; const fetches = [];
  const rows = [{ id: 'video-1', title: '舞蹈热门样本', sourceUrl: 'https://www.douyin.com/video/7600000000000000001',
    query: '舞蹈', productGroup: '搜索主题 · 舞蹈', likeCount: 125000, commentCount: null,
    aiProof: { verified: false, label: '未核验' } }];
  const fakeWindow = { location: { origin: 'https://ours.example' },
    get localStorage() { throw new Error('online data must use extension'); },
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval,
    addEventListener(name, listener) { listeners.add(listener); }, removeEventListener(name, listener) { listeners.delete(listener); },
    postMessage(message) {
      calls.push(message);
      queueMicrotask(() => {
        const path = new URL(message.url, this.location.origin).pathname;
        const payload = path === '/api/meta' ? { collectorAvailable: true, localExtension: { connected: true, version: '3.0.0' },
          browserHelper: { connected: true, version: '3.0.0' }, materialCounts: { douyin: 1 }, latestJobs: {},
          searchStates: { douyin: { keywords: ['舞蹈'], requireAiEvidence: false, resultScope: 'current' } } }
          : path === '/api/materials' ? { count: 1, materials: rows, facets: {} }
          : path === '/api/collect/douyin' ? { id: 'job-1', platform: 'douyin', status: 'running', keywords: ['舞蹈'], requireAiEvidence: false }
          : path === '/api/local/search-state' ? { saved: true } : null;
        if (!payload) throw new Error(`unexpected bridge path ${path}`);
        for (const receive of listeners) receive({ source: this, origin: this.location.origin,
          data: { ...message, direction: 'response', ok: true, data: payload } });
      });
    }
  };
  globalThis.window = fakeWindow;
  globalThis.fetch = async (url) => {
    fetches.push(url); assert.equal(url, '/api/deepseek/status');
    return { ok: true, json: async () => ({ configured: false, allowLocalConfig: false }) };
  };
  let app;
  try {
    await act(async () => { app = create(React.createElement(Workspace)); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
    assert.equal(app.root.findByProps({ className: 'platform-rail' }).findAllByType('button').length, 1);
    assert.equal(app.root.findAllByType('tbody')[0].findAllByType('tr').length, 1);
    assert.equal(app.root.findByProps({ type: 'checkbox' }).props.checked, false);
    assert.ok(calls.some((call) => call.url === '/api/local/search-state' && call.body.keywords[0] === '舞蹈'));
    await act(async () => app.root.findByProps({ className: 'keyword-search-action' }).props.onClick());
    const task = calls.find((call) => call.url === '/api/collect/douyin');
    assert.deepEqual(task.body.keywords, ['舞蹈']);
    assert.equal(task.body.requireAiEvidence, false);
    assert.equal(fetches.length, 1);
    assert.match(JSON.stringify(app.toJSON()), /不上传云数据库/);
  } finally {
    if (app) await act(async () => app.unmount());
    globalThis.window = previous.window; globalThis.fetch = previous.fetch; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
