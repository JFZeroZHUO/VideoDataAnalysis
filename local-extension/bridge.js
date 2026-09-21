(() => {
  const channel = 'video-data-analysis';
  const origin = location.origin;
  if (location.protocol !== 'https:' && origin !== 'http://127.0.0.1:4318') return;
  if (globalThis.__videoDataAnalysisBridgeV1) return;
  globalThis.__videoDataAnalysisBridgeV1 = true;

  function apiUrl(value) {
    if (typeof value !== 'string' || !value.startsWith('/api/') || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const parsed = new URL(value, origin);
      const pathname = decodeURIComponent(parsed.pathname);
      if (pathname.includes('//') || /[\\%?#\u0000-\u0020\u007f]/.test(pathname)) return null;
      const normalized = new URL(pathname, origin);
      if (parsed.origin !== origin || normalized.origin !== origin || parsed.hash ||
          !normalized.pathname.startsWith('/api/') || /^\/api\/deepseek(?:\/|$)/i.test(normalized.pathname)) return null;
      return `${normalized.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  function errorResponse(error, status = 503, code = 'EXTENSION_UNAVAILABLE') {
    return {
      ok: false,
      error: {
        message: typeof error?.message === 'string' ? error.message : '浏览器扩展暂时不可用，请重新加载扩展后重试。',
        status: Number.isInteger(error?.status) ? error.status : status,
        code: typeof error?.code === 'string' ? error.code : code
      }
    };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== origin) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        message.channel !== channel || message.direction !== 'request' || message.action !== 'request' ||
        !((typeof message.id === 'string' && message.id.length > 0) ||
          (typeof message.id === 'number' && Number.isFinite(message.id)))) return;

    const respond = (payload) => window.postMessage({ channel, direction: 'response', id: message.id, ...payload }, origin);
    const url = apiUrl(message.url);
    const method = typeof message.method === 'string' ? message.method.toUpperCase() : message.method == null ? 'GET' : null;
    if (!url || !['GET', 'POST'].includes(method)) {
      respond(errorResponse({ message: '仅允许本地扩展的 /api/ GET 或 POST 请求，不允许 DeepSeek 路由。' }, 400, 'INVALID_BRIDGE_REQUEST'));
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        channel, direction: 'request', action: 'request', id: message.id,
        url, method, body: message.body
      });
      if (response?.ok === true) respond({ ok: true, data: response.data });
      else if (response?.ok === false) respond(errorResponse(response.error, 500, 'EXTENSION_REQUEST_FAILED'));
      else respond(errorResponse({ message: '浏览器扩展返回了无效响应，请重新加载扩展后重试。' }, 502, 'INVALID_EXTENSION_RESPONSE'));
    } catch (error) {
      respond(errorResponse(error));
    }
  });
})();
