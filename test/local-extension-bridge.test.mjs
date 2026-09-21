import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridgeSource = fs.readFileSync(new URL('../local-extension/bridge.js', import.meta.url), 'utf8');
const channel = 'video-data-analysis';
const clone = (value) => JSON.parse(JSON.stringify(value));

function createHarness({ origin = 'https://analysis.example', sendMessage = async () => ({ ok: true, data: { accepted: true } }) } = {}) {
  const listeners = [];
  const requests = [];
  const responses = [];
  const window = {
    addEventListener: (event, listener) => {
      assert.equal(event, 'message');
      listeners.push(listener);
    },
    postMessage: (message, targetOrigin) => responses.push({ message: clone(message), targetOrigin })
  };
  const context = vm.createContext({
    window,
    location: new URL(`${origin}/workspace`),
    URL,
    chrome: { runtime: { sendMessage: async (message) => {
      requests.push(clone(message));
      return sendMessage(message);
    } } }
  });
  const inject = () => vm.runInContext(bridgeSource, context);
  inject();
  return {
    window, listeners, requests, responses, inject,
    dispatch: async (message, overrides = {}) => {
      const event = { source: window, origin, data: message, ...overrides };
      await Promise.all(listeners.map((listener) => listener(event)));
    }
  };
}

function request(overrides = {}) {
  return { channel, direction: 'request', id: 'request-1', action: 'request', url: '/api/meta', method: 'GET', ...overrides };
}

test('同窗口同源合法请求只转发协议字段，并向原origin返回结果', async () => {
  const harness = createHarness();
  const message = request({ url: '/api/collect/douyin', method: 'POST', body: { keywords: ['舞蹈'] }, senderOrigin: 'https://forged.example', extra: '不转发' });
  await harness.dispatch(message);
  assert.deepEqual(harness.requests, [{
    channel, direction: 'request', action: 'request', id: 'request-1',
    url: '/api/collect/douyin', method: 'POST', body: { keywords: ['舞蹈'] }
  }]);
  assert.deepEqual(harness.responses, [{
    targetOrigin: 'https://analysis.example',
    message: { channel, direction: 'response', id: 'request-1', ok: true, data: { accepted: true } }
  }]);
});

test('跨窗口、跨origin及非协议消息不转发也不响应', async () => {
  const harness = createHarness();
  await harness.dispatch(request(), { source: {} });
  await harness.dispatch(request(), { origin: 'https://other.example' });
  await harness.dispatch(request(), { origin: 'null' });
  for (const message of [null, [], 'hello', request({ channel: 'other' }), request({ direction: 'response' }), request({ action: 'run-script' }), request({ id: '' }), request({ id: {} })]) {
    await harness.dispatch(message);
  }
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(harness.responses, []);
});

test('仅HTTPS和指定loopback origin安装监听器', async () => {
  for (const origin of ['http://analysis.example', 'http://localhost:4318', 'http://127.0.0.1:4319', 'file://']) {
    const harness = createHarness({ origin });
    assert.equal(harness.listeners.length, 0, origin);
    await harness.dispatch(request());
    assert.deepEqual(harness.requests, [], origin);
  }
  const local = createHarness({ origin: 'http://127.0.0.1:4318' });
  await local.dispatch(request());
  assert.equal(local.requests.length, 1);
  assert.equal(local.responses[0].targetOrigin, 'http://127.0.0.1:4318');
});

test('拒绝绝对URL、跨域路径、越界路径和DeepSeek直连或编码绕过', async () => {
  for (const url of [
    'https://analysis.example/api/meta',
    'https://evil.example/api/meta',
    '//evil.example/api/meta',
    '/settings',
    '/api/../settings',
    '/api/deepseek',
    '/api/deepseek/models?x=1',
    '/api/DeepSeek/chat',
    '/api/%64eepseek/chat',
    '/api/materials/../deepseek/chat',
    '/api/%2e%2e/settings',
    '/api/%252e%252e/settings',
    '/api/%2f%2fevil.example/meta',
    '/api/%5cdeepseek/chat',
    '/api/meta\\..\\deepseek',
    '/api/meta#fragment',
    '/api/meta\n',
    '/api/%invalid',
    null
  ]) {
    const harness = createHarness();
    await harness.dispatch(request({ url }));
    assert.deepEqual(harness.requests, [], String(url));
    assert.equal(harness.responses[0]?.message.ok, false, String(url));
    assert.equal(harness.responses[0]?.message.error.code, 'INVALID_BRIDGE_REQUEST', String(url));
  }
});

test('API查询字符串保留，默认GET，POST不改变body', async () => {
  const harness = createHarness();
  await harness.dispatch(request({ id: 1, url: '/api/materials?query=%2Fapi%2Fdeepseek&term=%E8%88%9E%E8%B9%88', method: undefined }));
  await harness.dispatch(request({ id: 2, url: '/api/local/restore', method: 'post', body: { backup: { schemaVersion: 1 } } }));
  assert.equal(harness.requests[0].url, '/api/materials?query=%2Fapi%2Fdeepseek&term=%E8%88%9E%E8%B9%88');
  assert.equal(harness.requests[0].method, 'GET');
  assert.equal(harness.requests[1].method, 'POST');
  assert.deepEqual(harness.requests[1].body, { backup: { schemaVersion: 1 } });
  assert.equal(harness.responses[0].message.id, 1);
});

test('非GET和POST方法不会交给background', async () => {
  for (const method of ['DELETE', 'PUT', 'OPTIONS', '', {}, 1]) {
    const harness = createHarness();
    await harness.dispatch(request({ method }));
    assert.equal(harness.requests.length, 0, String(method));
    assert.equal(harness.responses[0].message.error.status, 400, String(method));
  }
});

test('background业务错误按协议返回且不能覆盖请求id', async () => {
  const harness = createHarness({ sendMessage: async () => ({
    id: 'forged-id', direction: 'request', ok: false,
    error: { message: '当前网站尚未获授权', status: 403, code: 'ORIGIN_NOT_ALLOWED' }
  }) });
  await harness.dispatch(request());
  assert.deepEqual(harness.responses[0].message, {
    channel, direction: 'response', id: 'request-1', ok: false,
    error: { message: '当前网站尚未获授权', status: 403, code: 'ORIGIN_NOT_ALLOWED' }
  });
});

test('runtime异常和无效响应转换成可显示错误', async () => {
  const rejected = createHarness({ sendMessage: async () => { throw new Error('Extension context invalidated'); } });
  await rejected.dispatch(request());
  assert.equal(rejected.responses[0].message.ok, false);
  assert.deepEqual(rejected.responses[0].message.error, {
    message: 'Extension context invalidated', status: 503, code: 'EXTENSION_UNAVAILABLE'
  });
  const empty = createHarness({ sendMessage: async () => undefined });
  await empty.dispatch(request());
  assert.equal(empty.responses[0].message.error.status, 502);
  assert.equal(empty.responses[0].message.error.code, 'INVALID_EXTENSION_RESPONSE');
});

test('重复注入不重复监听或重复转发', async () => {
  const harness = createHarness();
  harness.inject();
  harness.inject();
  assert.equal(harness.listeners.length, 1);
  await harness.dispatch(request());
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.responses.length, 1);
});
