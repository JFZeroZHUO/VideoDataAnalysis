export const EXTENSION_MODE = import.meta.env?.VITE_STORAGE_MODE === 'extension';

// The online build never falls back to a localhost API or sends collection data to the host.
export function extensionRequest(url, options = {}, target = globalThis.window, timeoutMs = url === '/api/local/restore' || url === '/api/local/backup' ? 30000 : 6000) {
  if (!target?.postMessage) return Promise.reject(new Error('请在安装了抖音本机助手的桌面浏览器中打开。'));
  const id = globalThis.crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); target.removeEventListener('message', receive); };
    const receive = (event) => {
      const data = event.data;
      if (event.source !== target || event.origin !== target.location.origin || data?.channel !== 'video-data-analysis' ||
          data.direction !== 'response' || data.id !== id) return;
      cleanup();
      if (data.ok === true) resolve(data.data);
      else reject(Object.assign(new Error(data.error?.message || '扩展请求失败，请重试。'), {
        status: data.error?.status, code: data.error?.code, details: data.error
      }));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('未连接抖音本机助手。请安装扩展、授权当前网站，再点击“检测连接”。'), { code: 'EXTENSION_NOT_CONNECTED' }));
    }, timeoutMs);
    target.addEventListener('message', receive);
    try {
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      target.postMessage({ channel: 'video-data-analysis', direction: 'request', action: 'request', id,
        url, method: options.method || 'GET', body }, target.location.origin);
    } catch (error) { cleanup(); reject(error); }
  });
}

export function saveDownload(content, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
