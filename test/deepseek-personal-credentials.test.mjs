import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDeepSeek, deepSeekRequestAccess, discoverDeepSeekConfigs, getDeepSeekStatus, suggestKeywords } from '../server/deepseek-keywords.mjs';

const personalA = 'sk-person-A-12345678901234567890';
const personalB = 'sk-person-B-12345678901234567890';
const ownerKey = 'sk-owner-key-12345678901234567890';
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const suggestions = (word) => reply({ choices: [{ message: { content: JSON.stringify({ categories: [{ label: '核心相关词', keywords: [word] }] }) } }] });

function environment(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

function localEnvironment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-personal-test-'));
  const envFile = path.join(root, '.env.local');
  fs.writeFileSync(envFile, '', 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  environment(t, { VERCEL: undefined, VERCEL_URL: undefined, DEPLOYMENT_MODE: undefined, PUBLIC_APP_ORIGIN: undefined,
    DEEPSEEK_API_KEY: ownerKey, DEEPSEEK_MODEL: 'deepseek-v4-pro', DEEPSEEK_BASE_URL: 'https://owner-proxy.invalid/v1', DEEPSEEK_ENV_FILE: envFile });
}

test('两位用户并发扩词只使用各自请求密钥与模型，不串用本地或对方配置', async (t) => {
  localEnvironment(t);
  const calls = [];
  let resolveA;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (options.headers.Authorization === `Bearer ${personalA}`) return new Promise((resolve) => { resolveA = () => resolve(suggestions('舞蹈教程')); });
    return suggestions('咖啡器具');
  });
  const first = suggestKeywords('舞蹈', [], { allowLocalConfig: true, credentials: { apiKey: personalA, model: 'deepseek-flash', baseUrl: 'https://untrusted.invalid' } });
  const second = await suggestKeywords('咖啡', [], { allowLocalConfig: true, credentials: { apiKey: personalB, model: 'deepseek-v4-pro' } });
  resolveA();
  const one = await first;
  assert.equal(one.categories[0].keywords[0], '舞蹈教程');
  assert.equal(second.categories[0].keywords[0], '咖啡器具');
  assert.equal(one.model, 'deepseek-flash');
  assert.equal(second.model, 'deepseek-v4-pro');
  assert.deepEqual(calls.map((call) => call.options.headers.Authorization), [`Bearer ${personalA}`, `Bearer ${personalB}`]);
  assert.ok(calls.every((call) => call.url === 'https://api.deepseek.com/chat/completions' && call.options.redirect === 'error'));
  assert.equal(getDeepSeekStatus({ allowLocalConfig: true }).model, 'deepseek-v4-pro');
});

test('个人密钥认证失败绝不回退到owner key，且上游错误中的密钥不外泄', async (t) => {
  localEnvironment(t);
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    count += 1;
    assert.equal(options.headers.Authorization, `Bearer ${personalA}`);
    return reply({ error: { message: `bad key ${personalA} ${ownerKey}` } }, 401);
  });
  await assert.rejects(suggestKeywords('舞蹈', [], { allowLocalConfig: true, credentials: { apiKey: personalA } }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, 'DEEPSEEK_UNAUTHORIZED');
    assert.ok(!JSON.stringify(error).includes(personalA));
    assert.ok(!error.message.includes(ownerKey));
    return true;
  });
  assert.equal(count, 1);
});

test('模型验证只GET官方models，不调用生成接口、不保存个人key', async (t) => {
  localEnvironment(t);
  const before = getDeepSeekStatus({ allowLocalConfig: true });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return reply({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'unapproved-model' }] });
  });
  const verified = await configureDeepSeek(personalA, 'deepseek-flash', { allowLocalConfig: true });
  assert.equal(verified.configured, true);
  assert.equal(verified.persistence, 'request');
  assert.equal(verified.automatic, false);
  assert.deepEqual(verified.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.ok(!JSON.stringify(verified).includes(personalA));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/models');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(getDeepSeekStatus({ allowLocalConfig: true }), before);
});

test('hosted模式禁止读取本地文件和环境owner key，即使调用方传allowLocalConfig', async (t) => {
  environment(t, { VERCEL: '1', DEEPSEEK_API_KEY: ownerKey, DEEPSEEK_MODEL: 'deepseek-v4-pro' });
  t.mock.method(fs, 'readdirSync', () => assert.fail('hosted must not scan env files'));
  t.mock.method(fs, 'readFileSync', () => assert.fail('hosted must not read env files'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('hosted must not send owner credentials'));
  assert.equal(getDeepSeekStatus({ allowLocalConfig: true }).configured, false);
  assert.equal(getDeepSeekStatus({ allowLocalConfig: true }).allowLocalConfig, false);
  assert.deepEqual(discoverDeepSeekConfigs(), []);
  await assert.rejects(suggestKeywords('舞蹈', [], { allowLocalConfig: true }), { status: 403, code: 'DEEPSEEK_PERSONAL_KEY_REQUIRED' });
});

test('cloud模式同样禁用owner key，非本机请求缺个人密钥不会触发fetch', async (t) => {
  environment(t, { VERCEL: undefined, DEPLOYMENT_MODE: 'cloud', DEEPSEEK_API_KEY: ownerKey });
  t.mock.method(globalThis, 'fetch', () => assert.fail('must not send owner credentials'));
  assert.equal(getDeepSeekStatus({ allowLocalConfig: true }).allowLocalConfig, false);
  await assert.rejects(suggestKeywords('舞蹈'), { code: 'DEEPSEEK_PERSONAL_KEY_REQUIRED' });
});

test('本机仍能自动用env，但返回状态不包含密钥', async (t) => {
  localEnvironment(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${ownerKey}`);
    return suggestions('舞蹈教程');
  });
  const status = getDeepSeekStatus({ allowLocalConfig: true });
  assert.equal(status.configured, true);
  assert.equal(status.automatic, true);
  assert.equal(status.persistence, 'environment');
  assert.ok(!JSON.stringify(status).includes(ownerKey));
  assert.equal((await suggestKeywords('舞蹈', [], { allowLocalConfig: true })).count, 1);
});

test('本地代理显式模型保持原样，个人模型限制不覆盖owner env设置', async (t) => {
  localEnvironment(t);
  process.env.DEEPSEEK_MODEL = 'local-proxy-custom-model';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://owner-proxy.invalid/v1/chat/completions');
    assert.equal(JSON.parse(options.body).model, 'local-proxy-custom-model');
    return suggestions('舞蹈教程');
  });
  assert.equal(getDeepSeekStatus({ allowLocalConfig: true }).model, 'local-proxy-custom-model');
  assert.equal((await suggestKeywords('舞蹈', [], { allowLocalConfig: true })).model, 'local-proxy-custom-model');
});

test('fetch异常和不可解析的上游正文也转换为不含密钥的固定错误', async (t) => {
  localEnvironment(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`fetch failed ${personalA}`); });
  await assert.rejects(configureDeepSeek(personalA), (error) => error.code === 'DEEPSEEK_UNAVAILABLE' && !error.message.includes(personalA) && !error.cause);
  t.mock.method(globalThis, 'fetch', async () => reply({ choices: [{ message: { content: `{bad: ${personalA}}` } }] }));
  await assert.rejects(suggestKeywords('舞蹈', [], { credentials: { apiKey: personalA } }), (error) => error.code === 'DEEPSEEK_INVALID_RESPONSE' && !error.message.includes(personalA));
});

test('无效个人credentials或未批准模型直接拒绝，不能隐式改用本地配置', async (t) => {
  localEnvironment(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('invalid credentials must not fetch'));
  for (const credentials of [null, {}, { apiKey: '' }, { apiKey: personalA, model: 'deepseek-chat' }]) {
    await assert.rejects(suggestKeywords('舞蹈', [], { credentials, allowLocalConfig: true }), { status: 400 });
  }
});

function request({ host = '127.0.0.1:4318', origin = 'http://127.0.0.1:4318', remoteAddress = '127.0.0.1', headers = {}, encrypted = false } = {}) {
  return { headers: { host, ...(origin === undefined ? {} : { origin }), 'content-type': 'application/json; charset=utf-8', ...headers }, socket: { remoteAddress, encrypted } };
}

test('JSON与同源校验：禁止外站、null来源、非JSON以及伪造转发host', (t) => {
  environment(t, { VERCEL: undefined, VERCEL_URL: undefined, DEPLOYMENT_MODE: undefined, PUBLIC_APP_ORIGIN: undefined });
  assert.equal(deepSeekRequestAccess(request(), { requireJson: true }).allowLocalConfig, true);
  for (const origin of ['https://attacker.invalid', 'null', 'http://localhost:9999']) {
    assert.throws(() => deepSeekRequestAccess(request({ origin }), { requireJson: true }), { status: 403 });
  }
  assert.throws(() => deepSeekRequestAccess(request({ headers: { 'content-type': 'text/plain' } }), { requireJson: true }), { status: 415 });
  assert.throws(() => deepSeekRequestAccess(request({ origin: 'https://attacker.invalid', headers: { 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'https' } })), { status: 403 });
});

test('LAN、代理和非loopback主机都不能使用owner key，IPv6本机可以', (t) => {
  environment(t, { VERCEL: undefined, VERCEL_URL: undefined, DEPLOYMENT_MODE: undefined, PUBLIC_APP_ORIGIN: undefined });
  assert.equal(deepSeekRequestAccess(request({ remoteAddress: '192.168.1.20' })).allowLocalConfig, false);
  assert.equal(deepSeekRequestAccess(request({ headers: { forwarded: 'for=192.168.1.20' } })).allowLocalConfig, false);
  assert.equal(deepSeekRequestAccess(request({ host: 'attacker.invalid', origin: 'http://attacker.invalid' })).allowLocalConfig, false);
  assert.equal(deepSeekRequestAccess(request({ host: '[::1]:4318', origin: 'http://[::1]:4318', remoteAddress: '::1' })).allowLocalConfig, true);
  assert.equal(deepSeekRequestAccess(request({ remoteAddress: '::ffff:127.0.0.1' })).allowLocalConfig, true);
});

test('hosted同源用直接host或显式PUBLIC_APP_ORIGIN，不信任x-forwarded-host', (t) => {
  environment(t, { VERCEL: '1', VERCEL_URL: undefined, DEPLOYMENT_MODE: undefined, PUBLIC_APP_ORIGIN: 'https://video.example.test' });
  const incoming = request({ host: 'internal:3000', origin: 'https://video.example.test', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-host': 'untrusted.invalid' } });
  assert.equal(deepSeekRequestAccess(incoming).allowLocalConfig, false);
  assert.throws(() => deepSeekRequestAccess({ ...incoming, headers: { ...incoming.headers, origin: 'https://untrusted.invalid' } }), { status: 403 });
});
