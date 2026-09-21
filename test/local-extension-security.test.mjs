import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { sharedDouyinPlugin } from '../scripts/build-extension.mjs';

const bundle = await build({ entryPoints: ['local-extension/background.js'], bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [sharedDouyinPlugin()] });
const { createBackground, allowedOrigin, permissionPattern, validateRequest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const popupSource = await readFile(new URL('../local-extension/popup.js', import.meta.url), 'utf8');
const EXTENSION_ID = 'local-extension-test';
const ORIGIN = 'https://analysis.example';
const channel = 'video-data-analysis';
const request = (overrides = {}) => ({ channel, direction: 'request', action: 'request', id: 'test-1', url: '/api/meta', method: 'GET', ...overrides });
const popupSender = () => ({ id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` });
const pageSender = (origin = ORIGIN, overrides = {}) => ({ id: EXTENSION_ID, url: `${origin}/workspace`, origin, frameId: 0, tab: { id: 1, url: `${origin}/workspace` }, ...overrides });

async function backgroundHarness({ approved = [], granted = [], tabUrls = [ORIGIN] } = {}) {
  const data = { authorizedOrigins: [...approved] };
  const permissions = new Set(granted);
  const scripts = [];
  const serviceRequests = [];
  const injected = [];
  const accessLevels = [];
  const listeners = { messages: [], removed: [] };
  const tabs = new Map(tabUrls.map((url, index) => [index + 1, { id: index + 1, url }]));
  let douyinOpened = 0;
  const chrome = {
    runtime: { id: EXTENSION_ID, getURL: (file) => `chrome-extension://${EXTENSION_ID}/${file}`, onMessage: { addListener: (listener) => listeners.messages.push(listener) } },
    storage: { local: {
      get: async (key) => ({ [key]: structuredClone(data[key]) }),
      set: async (values) => Object.assign(data, structuredClone(values)),
      setAccessLevel: async (value) => accessLevels.push(value)
    } },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => permissions.has(origin)),
      remove: async ({ origins }) => { origins.forEach((origin) => permissions.delete(origin)); return true; },
      onRemoved: { addListener: (listener) => listeners.removed.push(listener) }
    },
    tabs: { get: async (id) => { if (!tabs.has(id)) throw new Error('tab not found'); return { ...tabs.get(id) }; } },
    scripting: {
      getRegisteredContentScripts: async () => structuredClone(scripts),
      unregisterContentScripts: async ({ ids }) => { for (let index = scripts.length - 1; index >= 0; index--) if (ids.includes(scripts[index].id)) scripts.splice(index, 1); },
      registerContentScripts: async (values) => scripts.push(...structuredClone(values)),
      executeScript: async (value) => { injected.push(structuredClone(value)); return []; }
    }
  };
  const background = createBackground(chrome, {
    store: {},
    serviceFactory: () => ({ ready: Promise.resolve(), request: async (url, options) => { serviceRequests.push({ url, options }); return { accepted: true }; } }),
    collectorFactory: () => ({ runTask: async () => {}, openDouyin: async () => ({ opened: ++douyinOpened }) })
  });
  await background.ready;
  return { ...background, chrome, data, permissions, scripts, serviceRequests, injected, accessLevels, listeners, tabs };
}

test('background 仅接受 HTTPS 或指定 loopback，拒绝凭证 URL', () => {
  assert.equal(allowedOrigin('https://analysis.example:444/path?q=1'), 'https://analysis.example:444');
  assert.equal(allowedOrigin('http://127.0.0.1:4318/'), 'http://127.0.0.1:4318');
  assert.equal(permissionPattern('https://analysis.example:444'), 'https://analysis.example/*');
  for (const value of ['http://analysis.example', 'http://localhost:4318', 'http://127.0.0.1:4319', 'file:///tmp/index.html', 'https://user:password@analysis.example/', 'not a URL']) assert.equal(allowedOrigin(value), null, value);
});

test('background 仅扩展 popup 可以授权；用户授予 host permission 仍需 exact-origin 授权', async () => {
  const h = await backgroundHarness({ granted: [permissionPattern(ORIGIN)] });
  await assert.rejects(h.dispatch(request(), pageSender()), { status: 403 });
  for (const sender of [pageSender(), { ...popupSender(), id: 'another-extension' }, { ...popupSender(), tab: { id: 1 }, frameId: 0 }, { ...popupSender(), url: `chrome-extension://${EXTENSION_ID}/settings.html` }]) {
    await assert.rejects(h.dispatch({ action: 'authorize', origin: ORIGIN, tabId: 1 }, sender), { status: 403 });
  }
  assert.deepEqual(h.data.authorizedOrigins, []);
  assert.deepEqual(await h.dispatch({ action: 'authorize', origin: ORIGIN, tabId: 1 }, popupSender()), { origin: ORIGIN, authorized: true });
  assert.deepEqual(h.accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.deepEqual(h.injected, [{ target: { tabId: 1 }, files: ['bridge.js'] }]);
  assert.deepEqual(h.scripts[0].matches, ['https://analysis.example/*']);
  assert.equal(h.scripts[0].allFrames, false);
  assert.deepEqual(await h.dispatch(request(), pageSender()), { accepted: true });
  assert.equal(h.serviceRequests.length, 1);
});

test('popup 授权需要当前标签 origin 精确匹配及浏览器 host permission', async () => {
  const h = await backgroundHarness();
  await assert.rejects(h.dispatch({ action: 'authorize', origin: ORIGIN, tabId: 1 }, popupSender()), { status: 403 });
  h.permissions.add(permissionPattern(ORIGIN));
  h.tabs.get(1).url = 'https://different.example/workspace';
  await assert.rejects(h.dispatch({ action: 'authorize', origin: ORIGIN, tabId: 1 }, popupSender()), { status: 403 });
  assert.deepEqual(h.data.authorizedOrigins, []);
  assert.equal(h.injected.length, 0);
});

test('已授权网站也不能读取其它 origin、子框架、伪造 sender 或权限撤回后的数据', async () => {
  const h = await backgroundHarness({ approved: [ORIGIN], granted: [permissionPattern(ORIGIN)] });
  for (const sender of [pageSender('https://evil.example'), pageSender('https://analysis.example:444'), pageSender(ORIGIN, { frameId: 1 }), pageSender(ORIGIN, { origin: 'https://evil.example' }), pageSender(ORIGIN, { id: 'other-extension' }), pageSender(ORIGIN, { tab: undefined })]) {
    await assert.rejects(h.dispatch(request(), sender), { status: 403 });
  }
  h.permissions.clear();
  await assert.rejects(h.dispatch(request(), pageSender()), { status: 403 });
  assert.equal(h.serviceRequests.length, 0);
});

test('网页不能利用自定义 action 授权或撤销其它站点', async () => {
  const h = await backgroundHarness({ approved: [ORIGIN], granted: [permissionPattern(ORIGIN)] });
  for (const action of ['status', 'authorize', 'revoke', 'open-douyin']) await assert.rejects(h.dispatch({ action, origin: ORIGIN, tabId: 1 }, pageSender()), { code: 'INVALID_REQUEST' });
  assert.deepEqual(h.data.authorizedOrigins, [ORIGIN]);
  assert.equal(h.serviceRequests.length, 0);
});

test('撤销立即使残留 bridge 无权请求，共用 host permission 的另一个 origin 不受影响', async () => {
  const other = 'https://analysis.example:444';
  const h = await backgroundHarness({ approved: [ORIGIN, other], granted: [permissionPattern(ORIGIN)] });
  await h.dispatch({ action: 'revoke', origin: ORIGIN }, popupSender());
  assert.deepEqual(h.data.authorizedOrigins, [other]);
  assert.equal(h.permissions.has(permissionPattern(other)), true);
  await assert.rejects(h.dispatch(request(), pageSender()), { status: 403 });
  assert.deepEqual(await h.dispatch(request(), pageSender(other)), { accepted: true });
  await h.dispatch({ action: 'revoke', origin: other }, popupSender());
  assert.deepEqual(h.data.authorizedOrigins, []);
  assert.equal(h.permissions.has(permissionPattern(other)), false);
  assert.equal(h.scripts.length, 0);
});

test('worker 启动清理浏览器已撤销权限，不信任持久化的失效授权', async () => {
  const h = await backgroundHarness({ approved: [ORIGIN, 'https://removed.example'], granted: [permissionPattern(ORIGIN)] });
  assert.deepEqual(h.data.authorizedOrigins, [ORIGIN]);
  assert.equal(h.scripts.length, 1);
  await assert.rejects(h.dispatch(request(), pageSender('https://removed.example')), { status: 403 });
});

test('并发 popup 授权序列化后不丢失网站，撤销不移除必需的抖音权限', async () => {
  const second = 'https://second.example';
  const douyin = 'https://www.douyin.com';
  const h = await backgroundHarness({ granted: [ORIGIN, second, douyin].map(permissionPattern), tabUrls: [ORIGIN, second, douyin] });
  await Promise.all([ORIGIN, second, douyin].map((origin, index) => h.dispatch({ action: 'authorize', tabId: index + 1, origin }, popupSender())));
  assert.deepEqual(h.data.authorizedOrigins, [ORIGIN, second, douyin]);
  await h.dispatch({ action: 'revoke', origin: douyin }, popupSender());
  assert.equal(h.permissions.has(permissionPattern(douyin)), true);
  await assert.rejects(h.dispatch(request(), pageSender(douyin)), { status: 403 });
});

test('background 二次校验协议、方法、外部及编码 DeepSeek 路由，不只依赖 bridge', () => {
  assert.deepEqual(validateRequest(request({ url: '/api/materials?keywords=%E8%88%9E%E8%B9%88', method: 'POST', body: { keywords: ['舞蹈'] } })), {
    url: '/api/materials?keywords=%E8%88%9E%E8%B9%88', method: 'POST', body: { keywords: ['舞蹈'] }
  });
  for (const message of [request({ action: 'script' }), request({ direction: 'response' }), request({ channel: 'other' }), request({ method: 'DELETE' }), ...[
    'https://evil.example/api/meta', '//evil.example/api/meta', '/api/../settings', '/api/deepseek/status', '/api/meta\\../settings',
    '/api/%64eepseek/status', '/api/DeepSeek/status', '/api/meta#fragment', '/api/%252e%252e/settings', '/api/%2f%2fevil.example/meta', '/api/%invalid'
  ].map((url) => request({ url }))]) assert.throws(() => validateRequest(message), undefined, JSON.stringify(message));
});

test('runtime listener 将拒绝转换为错误消息，合法打开抖音不转发任意 URL', async () => {
  const h = await backgroundHarness({ approved: [ORIGIN], granted: [permissionPattern(ORIGIN)] });
  const response = await new Promise((resolve) => assert.equal(h.listeners.messages[0](request(), pageSender('https://evil.example'), resolve), true));
  assert.equal(response.ok, false);
  assert.equal(response.error.status, 403);
  assert.deepEqual(await h.dispatch(request({ url: '/api/local/open-douyin', method: 'POST', body: { url: 'https://evil.example' } }), pageSender()), { opened: 1 });
  assert.equal(h.serviceRequests.length, 0);
});

async function popupHarness({ tabUrl = ORIGIN, approved = [], permissionGranted = true } = {}) {
  const calls = [];
  const origins = [...approved];
  function element(tag) {
    return { tag, children: [], dataset: {}, handlers: {}, textContent: '', disabled: false,
      addEventListener(event, listener) { this.handlers[event] = listener; },
      setAttribute(name, value) { this[name] = value; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }
    };
  }
  const nodes = Object.fromEntries(['status', 'origins', 'authorize', 'attention', 'open-douyin', 'current-origin'].map((id) => [id, element(id)]));
  const context = vm.createContext({ URL, document: { getElementById: (id) => nodes[id], createElement: element }, chrome: {
    tabs: { query: async () => [{ id: 7, url: tabUrl }] },
    permissions: { request: async (value) => { calls.push({ kind: 'permission', value }); return permissionGranted; } },
    runtime: { sendMessage: async (message) => {
      calls.push({ kind: 'message', message });
      if (message.action === 'authorize') origins.push(message.origin);
      if (message.action === 'revoke') origins.splice(origins.indexOf(message.origin), 1);
      return { ok: true, data: { origins, attention: null } };
    } }
  } });
  await vm.runInContext(`(async () => { ${popupSource}\n })()`, context);
  return { nodes, calls, origins };
}

test('popup 初次打开不自动申请权限，点击授权先执行浏览器权限手势再发送 exact origin', async () => {
  const h = await popupHarness({ tabUrl: `${ORIGIN}:444/workspace` });
  assert.equal(h.calls.some((call) => call.kind === 'permission'), false);
  assert.equal(h.nodes.authorize.disabled, false);
  h.calls.length = 0;
  await h.nodes.authorize.handlers.click();
  assert.equal(h.calls[0].kind, 'permission');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].value)), { origins: ['https://analysis.example/*'] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].message)), { action: 'authorize', tabId: 7, origin: `${ORIGIN}:444` });
  assert.equal(h.nodes.authorize.disabled, true);
});

test('popup 用户拒绝 host permission 不写入授权；不安全页面禁用授权入口', async () => {
  const rejected = await popupHarness({ permissionGranted: false });
  await rejected.nodes.authorize.handlers.click();
  assert.equal(rejected.calls.some((call) => call.message?.action === 'authorize'), false);
  assert.match(rejected.nodes.status.textContent, /未授权/);
  for (const tabUrl of ['chrome://extensions', 'http://analysis.example', 'https://user:password@analysis.example/']) {
    const h = await popupHarness({ tabUrl });
    assert.equal(h.nodes.authorize.disabled, true, tabUrl);
    await h.nodes.authorize.handlers.click();
    assert.equal(h.calls.some((call) => call.kind === 'permission'), false, tabUrl);
  }
});

test('popup 撤销按钮只撤销对应 origin 并刷新状态', async () => {
  const h = await popupHarness({ approved: [ORIGIN, 'https://other.example'] });
  const revoke = h.nodes.origins.children[0].children[1];
  await revoke.handlers.click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find((call) => call.message?.action === 'revoke').message)), { action: 'revoke', origin: ORIGIN });
  assert.deepEqual(h.origins, ['https://other.example']);
  assert.equal(h.nodes.authorize.disabled, false);
  assert.match(h.nodes.status.textContent, /已撤销/);
});
