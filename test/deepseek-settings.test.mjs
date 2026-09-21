import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React, { act } from 'react';
import { create } from 'react-test-renderer';

const built = await build({ entryPoints: [fileURLToPath(new URL('../src/DeepSeekSettings.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { DeepSeekSettings, useDeepSeekConnection } = loaded.exports;
const keyA = 'sk-unit-personal-a-1234567890';
const keyB = 'sk-unit-personal-b-1234567890';

test('清除或切换Key后，尚未完成的旧验证不能重新启用旧Key', async (t) => {
  environment(t, { local: true });
  const realTestFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = async (url, options) => url.endsWith('/configure')
    ? new Promise((resolve) => pending.push(() => resolve({ ok: true, status: 200, json: async () => ({ configured: true, model: 'deepseek-flash' }) })))
    : realTestFetch(url, options);
  const app = await mount();
  try {
    let first;
    await act(async () => { first = app.connection.usePersonalKey(keyA, 'deepseek-flash'); });
    await act(async () => app.connection.clearPersonalKey());
    await act(async () => { pending.shift()(); assert.equal(await first, false); });
    assert.equal(app.connection.source, 'none');
    assert.equal(app.connection.hasPersonalKey, false);
    let older; let newer;
    await act(async () => { older = app.connection.usePersonalKey(keyA, 'deepseek-flash'); newer = app.connection.usePersonalKey(keyB, 'deepseek-flash'); });
    await act(async () => { pending[1](); assert.equal(await newer, true); });
    await act(async () => { pending[0](); assert.equal(await older, false); });
    assert.equal(app.connection.source, 'personal');
    await act(async () => app.connection.useLocalConfig());
    assert.equal(app.connection.hasPersonalKey, false);
  } finally { await app.close(); }
});

function environment(t, { local = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const requests = [];
  let failVerification = false;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const forbiddenStorage = { getItem() { throw new Error('Key 不应读取浏览器存储'); }, setItem() { throw new Error('Key 不应写入浏览器存储'); } };
  globalThis.window = { localStorage: forbiddenStorage, sessionStorage: forbiddenStorage };
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, body });
    let payload;
    let status = 200;
    if (url.endsWith('/status')) payload = { configured: local, allowLocalConfig: local, model: 'local-model' };
    else if (url.endsWith('/configure')) {
      status = failVerification ? 401 : 200;
      payload = failVerification ? { message: 'Key 验证失败' } : { configured: true, model: body.model, persistence: 'request', automatic: false };
    } else if (url.endsWith('/keyword-suggestions')) payload = { seedKeyword: body.keyword, categories: [], count: 0 };
    else throw new Error(`Unexpected request ${url}`);
    return { ok: status === 200, status, json: async () => payload };
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct; });
  return { requests, failVerification(value) { failVerification = value; } };
}

async function mount() {
  let connection;
  function Harness() { connection = useDeepSeekConnection(); return React.createElement(DeepSeekSettings, { connection, id: 'test-settings' }); }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Harness)); });
  return { renderer, get connection() { return connection; }, async close() { await act(async () => renderer.unmount()); } };
}
const form = (app) => app.renderer.root.findByType('form');
const input = (app) => app.renderer.root.findByProps({ name: 'deepseek-personal-key' });
async function setKey(app, value) { await act(async () => input(app).props.onChange({ target: { value } })); }
async function submit(app) { await act(async () => form(app).props.onSubmit({ preventDefault() {} })); }

test('个人Key验证后输入框清空；两页面独立，切换Key只影响自己的请求，不写浏览器存储', async (t) => {
  const env = environment(t);
  const a = await mount(); const b = await mount();
  try {
    assert.equal(input(a).props.type, 'password');
    await setKey(a, keyA); await submit(a);
    assert.equal(input(a).props.value, '');
    assert.equal(a.connection.source, 'personal');
    assert.equal(b.connection.status.configured, false);
    await setKey(b, keyB); await submit(b);
    await act(async () => { await a.connection.suggest('舞蹈', ['舞蹈']); await b.connection.suggest('咖啡', ['咖啡']); });
    const queries = env.requests.filter((request) => request.url.endsWith('/keyword-suggestions'));
    assert.equal(queries[0].body.credentials.apiKey, keyA);
    assert.equal(queries[1].body.credentials.apiKey, keyB);
    assert.equal(JSON.stringify(a.renderer.toJSON()).includes(keyA), false);
    await setKey(a, keyB); await submit(a);
    await act(async () => { await a.connection.suggest('舞蹈', []); });
    assert.equal(env.requests.at(-1).body.credentials.apiKey, keyB);
  } finally { await a.close(); await b.close(); }
});

test('清除个人Key不会自动用本机Key；显式切回本机后才恢复，重新打开页面不恢复个人Key', async (t) => {
  const env = environment(t, { local: true });
  let app = await mount();
  try {
    assert.equal(app.connection.source, 'local');
    await setKey(app, keyA); await submit(app);
    await act(async () => app.connection.clearPersonalKey());
    assert.equal(app.connection.status.configured, false);
    const before = env.requests.length;
    await assert.rejects(app.connection.suggest('舞蹈', []), /先设置/);
    assert.equal(env.requests.length, before);
    await act(async () => app.connection.useLocalConfig());
    await act(async () => { await app.connection.suggest('舞蹈', []); });
    assert.equal('credentials' in env.requests.at(-1).body, false);
    await setKey(app, keyA); await submit(app);
    await app.close(); app = await mount();
    assert.equal(app.connection.source, 'local');
    assert.equal(app.connection.hasPersonalKey, false);
  } finally { await app.close(); }
});

test('替换Key验证失败显示可读错误，保留当前有效Key，不把错误Key写入扩词请求', async (t) => {
  const env = environment(t);
  const app = await mount();
  try {
    await setKey(app, keyA); await submit(app);
    env.failVerification(true);
    await setKey(app, keyB); await submit(app);
    assert.match(app.renderer.root.findByProps({ role: 'alert' }).props.children, /验证失败/);
    await act(async () => { await app.connection.suggest('舞蹈', []); });
    assert.equal(env.requests.at(-1).body.credentials.apiKey, keyA);
  } finally { await app.close(); }
});

test('切换账号后丢弃旧账号尚未完成的扩词响应', async (t) => {
  environment(t);
  const app = await mount();
  try {
    await setKey(app, keyA); await submit(app);
    const previousFetch = globalThis.fetch;
    let resolve;
    globalThis.fetch = (url, options) => url.endsWith('/keyword-suggestions')
      ? new Promise((done) => { resolve = () => done({ ok: true, json: async () => ({ seedKeyword: '舞蹈' }) }); })
      : previousFetch(url, options);
    const pending = app.connection.suggest('舞蹈', []);
    await act(async () => app.connection.clearPersonalKey());
    resolve();
    assert.equal(await pending, null);
  } finally { await app.close(); }
});
