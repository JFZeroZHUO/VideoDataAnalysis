import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { deepSeekRequestAccess } from '../server/deepseek-keywords.mjs';

// Execute the actual route registration with isolated upstream handlers, not the
// full server: no real credentials, database, API calls, or listener is created.
const source = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const guardStart = source.indexOf("app.use('/api/deepseek'");
const guardEnd = source.indexOf('app.use(express.json', guardStart);
const routesStart = source.indexOf("app.get('/api/deepseek/status'");
const routesEnd = source.indexOf("app.post('/api/browser-helper/heartbeat'", routesStart);
const errorStart = source.indexOf('app.use((error, _request, response, _next) =>');
const errorEnd = source.indexOf('app.listen(', errorStart);
assert.ok(guardStart >= 0 && guardEnd > guardStart && routesStart >= 0 && routesEnd > routesStart);

function setup(t) {
  const envNames = ['VERCEL', 'DEPLOYMENT_MODE', 'PUBLIC_APP_ORIGIN'];
  const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  t.after(() => { for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const routes = new Map();
  const calls = [];
  let guard;
  vm.runInNewContext(source.slice(guardStart, guardEnd) + source.slice(routesStart, routesEnd), {
    app: { use: (_path, fn) => { guard = fn; }, get: (route, fn) => routes.set(`GET ${route}`, fn), post: (route, fn) => routes.set(`POST ${route}`, fn) },
    deepSeekRequestAccess,
    getDeepSeekStatus: (access) => { calls.push(['status', access]); return { configured: false, ...access }; },
    configureDeepSeek: async (key, model, access) => { calls.push(['verify', key, model, access]); return { configured: true, persistence: 'request', model, automatic: false }; },
    suggestKeywords: async (keyword, existing, options) => { calls.push(['suggest', keyword, existing, options]); return { categories: [], count: 0 }; }
  });
  const execute = async (route, { body, headers = {}, remoteAddress = '127.0.0.1' } = {}) => {
    const method = route.split(' ')[0];
    const request = { method, body, headers: { host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4318', 'content-type': 'application/json', ...headers }, socket: { remoteAddress } };
    let error;
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, json(value) { this.payload = value; } };
    guard(request, response, (value) => { error = value; });
    if (!error) await routes.get(route)(request, response, (value) => { error = value; });
    return { response, error };
  };
  return { calls, execute };
}

test('验证路由等待验证结果且只传入请求个人凭据，返回不缓存', async (t) => {
  const { execute, calls } = setup(t);
  const { response, error } = await execute('POST /api/deepseek/configure', { body: { apiKey: 'sk-personal-not-a-real-key', model: 'deepseek-flash' } });
  assert.equal(error, undefined);
  assert.equal(response.payload.persistence, 'request');
  assert.equal(response.payload.configured, true);
  assert.equal(calls[0][0], 'verify');
  assert.equal(calls[0][1], 'sk-personal-not-a-real-key');
  assert.equal(calls[0][3].allowLocalConfig, true);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
});

test('扩词路由把每次credentials传给后端，远端请求显式禁用本机配置', async (t) => {
  const { execute, calls } = setup(t);
  const credentials = { apiKey: 'sk-personal-not-a-real-key', model: 'deepseek-v4-pro' };
  const { error } = await execute('POST /api/deepseek/keyword-suggestions', { remoteAddress: '192.168.1.20', body: { keyword: '咖啡', existingKeywords: ['手冲'], credentials } });
  assert.equal(error, undefined);
  assert.equal(calls[0][1], '咖啡');
  assert.equal(calls[0][3].credentials, credentials);
  assert.equal(calls[0][3].allowLocalConfig, false);
});

test('DeepSeek拒绝请求也有no-store，不执行上游handler', async (t) => {
  const { execute, calls } = setup(t);
  const crossOrigin = await execute('POST /api/deepseek/configure', { headers: { origin: 'https://attacker.invalid' } });
  assert.equal(crossOrigin.error.status, 403);
  assert.equal(crossOrigin.response.headers['Cache-Control'], 'no-store');
  const wrongType = await execute('POST /api/deepseek/keyword-suggestions', { headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.error.status, 415);
  assert.equal(calls.length, 0);
});

test('状态路由按socket访问权限返回状态，不默认开启owner配置', async (t) => {
  const { execute, calls } = setup(t);
  const { response } = await execute('GET /api/deepseek/status', { remoteAddress: '192.168.1.20' });
  assert.equal(calls[0][0], 'status');
  assert.equal(calls[0][1].allowLocalConfig, false);
  assert.equal(response.payload.allowLocalConfig, false);
});

test('HTTP回归：包含密钥的malformed JSON和未知异常均不回显或记录原始错误', async (t) => {
  setup(t); // Isolate deployment environment; this does not start the real app.
  assert.ok(errorStart >= 0 && errorEnd > errorStart);
  const app = express();
  const secret = 'sk-malformed-secret-not-a-real-key';
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const context = {
    app, deepSeekRequestAccess,
    getDeepSeekStatus: () => ({ configured: false }),
    configureDeepSeek: async () => { throw new Error(`unexpected upstream payload ${secret}`); },
    suggestKeywords: async () => ({ categories: [] }),
    console
  };
  vm.runInNewContext(source.slice(guardStart, guardEnd), context);
  app.use(express.json());
  vm.runInNewContext(source.slice(routesStart, routesEnd) + source.slice(errorStart, errorEnd), context);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const endpoint of ['/api/deepseek/configure', '/API/DeepSeek/configure']) {
    const response = await fetch(`${origin}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"apiKey":"${secret}", malformed}` });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.text();
    assert.ok(!body.includes(secret));
    assert.equal(JSON.parse(body).code, 'DEEPSEEK_REQUEST_FAILED');
  }
  const response = await fetch(`${origin}/api/deepseek/configure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: secret }) });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(secret));
  assert.equal(logged.length, 0);
});
