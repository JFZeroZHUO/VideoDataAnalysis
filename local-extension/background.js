import { createLocalStore } from './database.mjs';
import { createLocalService } from './service.mjs';
import { createCollector } from './collector.mjs';

export const VERSION = '3.0.0';
const CHANNEL = 'video-data-analysis';
const ORIGINS_KEY = 'authorizedOrigins';

export function allowedOrigin(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === 'https:' || url.origin === 'http://127.0.0.1:4318' ? url.origin : null;
  } catch { return null; }
}

export function permissionPattern(origin) {
  const url = new URL(origin);
  // Chrome host permissions are host-scoped; request dispatch additionally checks the exact origin.
  return `${url.protocol}//${url.hostname}/*`;
}

function httpError(message, status = 403, code = 'NOT_AUTHORIZED') {
  return Object.assign(new Error(message), { status, code });
}

export function validateRequest(message) {
  if (message?.channel !== CHANNEL || message.direction !== 'request' || message.action !== 'request') {
    throw httpError('不支持的扩展消息', 400, 'INVALID_REQUEST');
  }
  if (typeof message.url !== 'string' || !message.url.startsWith('/api/') ||
      /[\\\u0000-\u0020\u007f]/.test(message.url)) {
    throw httpError('只允许本机素材接口', 400, 'INVALID_ROUTE');
  }
  let parsed;
  try {
    parsed = new URL(message.url, 'https://extension.invalid');
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname.includes('//') || /[\\%?#\u0000-\u0020\u007f]/.test(pathname) || parsed.hash) throw new Error('invalid route');
    const normalized = new URL(pathname, 'https://extension.invalid');
    if (parsed.origin !== 'https://extension.invalid' || normalized.origin !== parsed.origin ||
        !normalized.pathname.startsWith('/api/') || /^\/api\/deepseek(?:\/|$)/i.test(normalized.pathname)) throw new Error('invalid route');
    normalized.search = parsed.search;
    parsed = normalized;
  } catch { throw httpError('不支持的本机接口', 400, 'INVALID_ROUTE'); }
  const method = message.method || 'GET';
  if (!['GET', 'POST'].includes(method)) throw httpError('不支持的请求方法', 405, 'METHOD_NOT_ALLOWED');
  return { url: `${parsed.pathname}${parsed.search}`, method, body: message.body };
}

export function createBackground(chromeApi, { store = createLocalStore(), serviceFactory = createLocalService, collectorFactory = createCollector } = {}) {
  const collector = collectorFactory(chromeApi);
  const service = serviceFactory({ store, runTask: collector.runTask, version: VERSION });
  let authorizationQueue = Promise.resolve();
  const origins = async () => {
    const saved = (await chromeApi.storage.local.get(ORIGINS_KEY))[ORIGINS_KEY];
    return Array.isArray(saved) ? saved.filter((origin) => allowedOrigin(origin) === origin) : [];
  };
  const trustedPopup = (sender) => sender?.id === chromeApi.runtime.id && !sender.tab &&
    sender.url === chromeApi.runtime.getURL('popup.html');
  const scriptId = (origin) => `local-bridge-${[...origin].map((character) => character.charCodeAt(0).toString(16)).join('')}`;
  async function syncScripts() {
    const approved = await origins();
    const valid = [];
    for (const origin of approved) {
      if (await chromeApi.permissions.contains({ origins: [permissionPattern(origin)] })) valid.push(origin);
    }
    if (valid.length !== approved.length) await chromeApi.storage.local.set({ [ORIGINS_KEY]: valid });
    const scripts = await chromeApi.scripting.getRegisteredContentScripts();
    const own = scripts.filter((item) => item.id.startsWith('local-bridge-'));
    if (own.length) await chromeApi.scripting.unregisterContentScripts({ ids: own.map((item) => item.id) });
    if (valid.length) await chromeApi.scripting.registerContentScripts(valid.map((origin) => ({
      id: scriptId(origin), matches: [permissionPattern(origin)], js: ['bridge.js'],
      runAt: 'document_start', allFrames: false, persistAcrossSessions: true
    })));
  }
  const serializeAuthorization = (operation) => {
    const result = authorizationQueue.then(operation);
    authorizationQueue = result.catch(() => {});
    return result;
  };
  const ready = Promise.all([
    service.ready,
    chromeApi.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    serializeAuthorization(syncScripts)
  ]);

  async function dispatch(message, sender) {
    await ready;
    if (trustedPopup(sender)) {
      if (message?.action === 'status') return { version: VERSION, origins: await origins(), attention: await service.request('/api/local/attention', { method: 'GET' }) };
      if (message?.action === 'authorize') return serializeAuthorization(async () => {
        const tab = await chromeApi.tabs.get(message.tabId);
        const origin = allowedOrigin(tab.url);
        if (!origin || origin !== message.origin || !await chromeApi.permissions.contains({ origins: [permissionPattern(origin)] })) {
          throw httpError('请在扩展弹窗中授权当前网站');
        }
        const approved = [...new Set([...await origins(), origin])];
        await chromeApi.storage.local.set({ [ORIGINS_KEY]: approved });
        await syncScripts();
        await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] });
        return { origin, authorized: true };
      });
      if (message?.action === 'revoke') return serializeAuthorization(async () => {
        const origin = allowedOrigin(message.origin);
        if (!origin) throw httpError('网站地址无效', 400);
        const remaining = (await origins()).filter((value) => value !== origin);
        await chromeApi.storage.local.set({ [ORIGINS_KEY]: remaining });
        await syncScripts();
        // Keep the required Douyin permission and permissions used by another exact origin.
        const pattern = permissionPattern(origin);
        if (pattern !== 'https://www.douyin.com/*' && !remaining.some((value) => permissionPattern(value) === pattern)) {
          await chromeApi.permissions.remove({ origins: [pattern] });
        }
        return { revoked: true };
      });
      if (message?.action === 'open-douyin') return collector.openDouyin();
      throw httpError('不支持的扩展操作', 400, 'INVALID_REQUEST');
    }
    const origin = allowedOrigin(sender?.url);
    if (sender?.id !== chromeApi.runtime.id || !sender.tab || sender.frameId !== 0 || !origin ||
        (sender.origin && sender.origin !== origin) || !(await origins()).includes(origin) ||
        !await chromeApi.permissions.contains({ origins: [permissionPattern(origin)] })) {
      throw httpError('此网站尚未获得本机助手授权');
    }
    const request = validateRequest(message);
    if (request.url === '/api/local/open-douyin' && request.method === 'POST') return collector.openDouyin();
    return service.request(request.url, { method: request.method, body: request.body });
  }
  chromeApi.runtime.onMessage.addListener((message, sender, respond) => {
    dispatch(message, sender).then((data) => respond({ ok: true, data }), (error) => respond({
      ok: false, error: { message: error.message || '本机助手请求失败', status: error.status || 500, code: error.code || 'EXTENSION_ERROR' }
    }));
    return true;
  });
  chromeApi.permissions.onRemoved.addListener(() => serializeAuthorization(syncScripts).catch(() => {}));
  return { dispatch, ready };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) createBackground(chrome);
