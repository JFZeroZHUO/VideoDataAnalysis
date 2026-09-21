import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { DOUYIN_SEARCH_STATE_KEY } from '../src/search-state.js';

// Exercise the real React component and its effects without driving a browser.
const built = await build({ entryPoints: [fileURLToPath(new URL('../src/ResearchWorkspace.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const Workspace = loaded.exports.default;

function setup() {
  const stored = new Map([[DOUYIN_SEARCH_STATE_KEY, JSON.stringify({ keywords: ['舞蹈'], resultScope: 'current' })]]);
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const oldWindow = globalThis.window;
  const oldFetch = globalThis.fetch;
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = { localStorage: storage,
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval };
  const rows = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, title: `舞蹈热门视频${index + 1}`,
    sourceUrl: `https://www.douyin.com/video/760000000000000000${index}`, query: '舞蹈', productGroup: '搜索主题 · 舞蹈',
    likeCount: 50000 - index, favoriteCount: null, commentCount: null, shareCount: null,
    aiProof: { verified: false, label: '未核验' }, materialStatus: 'metrics_partial' }));
  const requests = [];
  let failStart = false;
  let latestJob;
  const running = { id: 'active-job', platform: 'douyin', keywords: ['舞蹈'], requireAiEvidence: false,
    status: 'running', message: '正在搜索抖音：舞蹈', progress: 6 };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input, 'http://test.invalid');
    requests.push({ url, options });
    let data;
    let status = 200;
    if (url.pathname === '/api/meta') data = { collectorAvailable: true, materialCounts: { douyin: 6 }, counts: {}, latestJobs: latestJob ? { douyin: latestJob } : {} };
    else if (url.pathname === '/api/deepseek/status') data = { configured: false };
    else if (url.pathname === '/api/materials') {
      const matches = url.searchParams.get('platform') === 'douyin' &&
        !['verified'].includes(url.searchParams.get('aiEvidence')) && url.searchParams.get('quality') !== 'ready';
      data = { materials: matches ? rows : [], count: matches ? 6 : 0, facets: {} };
    } else if (url.pathname === '/api/collect/douyin') {
      status = failStart ? 409 : 200;
      data = failStart ? { message: '已有采集任务在运行', jobId: running.id } : running;
    } else if (url.pathname === '/api/jobs/active-job') data = running;
    else throw new Error(`Unexpected test request: ${url.pathname}`);
    return { ok: status < 400, status, json: async () => data };
  };
  return { requests, storage, setFailStart(value) { failStart = value; }, setLatestJob(value) { latestJob = value; }, cleanup() {
    globalThis.window = oldWindow; globalThis.fetch = oldFetch; globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
  } };
}

async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 230)); }); }
async function mount() { let app; await act(async () => { app = create(React.createElement(Workspace)); }); await settle(); return app; }
const tableRows = (app) => app.root.findAllByType('tbody').flatMap((body) => body.findAllByType('tr'));
const checkbox = (app) => app.root.findByProps({ type: 'checkbox' });
const textContent = (app) => JSON.stringify(app.toJSON());

test('真实组件：旧设置迁移后显示6条舞蹈，AI切换联动，刷新和切平台不再隐藏普通视频', async () => {
  const env = setup();
  let app;
  try {
    app = await mount();
    assert.equal(checkbox(app).props.checked, false);
    assert.equal(tableRows(app).length, 6);
    assert.equal(env.requests.filter((item) => item.url.pathname === '/api/materials').at(-1).url.searchParams.get('queryTerms'), '["舞蹈"]');
    await act(async () => checkbox(app).props.onChange({ target: { checked: true } }));
    await settle();
    assert.equal(tableRows(app).length, 0);
    assert.match(textContent(app), /被当前筛选条件隐藏/);
    await act(async () => checkbox(app).props.onChange({ target: { checked: false } }));
    await settle();
    assert.equal(tableRows(app).length, 6);
    const platformButtons = () => app.root.findByProps({ className: 'platform-rail' }).findAllByType('button');
    await act(async () => platformButtons()[1].props.onClick());
    await settle();
    await act(async () => platformButtons()[0].props.onClick());
    await settle();
    assert.equal(tableRows(app).length, 6);
    await act(async () => app.unmount());
    app = await mount();
    assert.equal(checkbox(app).props.checked, false);
    assert.equal(tableRows(app).length, 6);
    assert.equal(JSON.parse(env.storage.getItem(DOUYIN_SEARCH_STATE_KEY)).filters.quality, 'all');
  } finally { if (app) await act(async () => app.unmount()); env.cleanup(); }
});

test('真实组件：提交的是舞蹈原词和AI关闭模式，忙冲突持续展示且显示原任务模式', async () => {
  const env = setup();
  let app;
  try {
    app = await mount();
    env.setFailStart(true);
    await act(async () => app.root.findByProps({ className: 'keyword-search-action' }).props.onClick());
    const submitted = JSON.parse(env.requests.find((item) => item.url.pathname === '/api/collect/douyin').options.body);
    assert.deepEqual(submitted.keywords, ['舞蹈']);
    assert.equal(submitted.requireAiEvidence, false);
    assert.match(textContent(app), /未启动新任务/);
    assert.match(textContent(app), /普通热门模式 · 跳过AI核验/);
    assert.equal(checkbox(app).props.disabled, true);
    assert.equal(tableRows(app).length, 6);
  } finally { if (app) await act(async () => app.unmount()); env.cleanup(); }
});

test('连接重试失败后明确显示采集失败而不是100%，允许再次搜索', async () => {
  const env = setup();
  let app;
  try {
    env.setLatestJob({ id: 'failed-start', platform: 'douyin', keywords: ['舞蹈'], requireAiEvidence: false,
      status: 'failed', progress: 100, message: '已清理失效连接并自动重试 1 次，仍无法创建采集页' });
    app = await mount();
    const line = app.root.findByProps({ className: 'job-line' });
    assert.equal(line.findByType('span').props.children, '采集失败');
    assert.equal(app.root.findByProps({ className: 'keyword-search-action' }).props.disabled, false);
  } finally { if (app) await act(async () => app.unmount()); env.cleanup(); }
});
