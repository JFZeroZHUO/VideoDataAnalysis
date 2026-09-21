export function isCollectorConnectionError(error) {
  if (['COLLECTOR_CONNECTION_UNAVAILABLE', 'COLLECTOR_CONTEXT_MISSING', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code)) return true;
  return /target (?:page, context or browser has been closed|closed)|(?:browser|context|connection|websocket) (?:has been |is )?(?:closed|disconnected)|no (?:available )?(?:browser )?context|cannot find context|failed to find browser context|connect ECONNREFUSED|socket hang up/i.test(String(error?.message || error || ''));
}

function connectionError(message, code = 'COLLECTOR_CONNECTION_UNAVAILABLE') {
  return Object.assign(new Error(message), { code });
}

export function createCollectorConnection({ probe, connect, launch }) {
  let cachedBrowser = null;
  let pending = null;

  function invalidate(expectedBrowser) {
    if (expectedBrowser === undefined || cachedBrowser === expectedBrowser) cachedBrowser = null;
  }

  function usable(browser) {
    try { return Boolean(browser?.isConnected() && browser.contexts().length); }
    catch { return false; }
  }

  async function resolveConnection(allowLaunch) {
    try {
      if (!await probe()) {
        invalidate();
        if (!allowLaunch) return null;
        await launch();
        if (!await probe()) throw connectionError('采集浏览器启动后仍无法连接调试端点。');
      }
      if (usable(cachedBrowser)) return cachedBrowser;
      invalidate();
      const browser = await connect();
      if (!usable(browser)) throw connectionError('采集浏览器连接已失效或没有可用的浏览器上下文。', 'COLLECTOR_CONTEXT_MISSING');
      cachedBrowser = browser;
      browser.on('disconnected', () => invalidate(browser));
      return browser;
    } catch (error) {
      invalidate();
      throw error;
    }
  }

  async function ensure({ allowLaunch = true } = {}) {
    if (pending) {
      const browser = await pending;
      // A read-only status check must not suppress an overlapping collection start.
      return !browser && allowLaunch ? ensure({ allowLaunch }) : browser;
    }
    const attempt = resolveConnection(allowLaunch);
    pending = attempt;
    try { return await attempt; }
    finally { if (pending === attempt) pending = null; }
  }

  async function openPage({ onRetry } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let browser;
      try {
        browser = await ensure();
        const context = browser.contexts()[0];
        if (!context) throw connectionError('采集浏览器缺少可用上下文。', 'COLLECTOR_CONTEXT_MISSING');
        const page = await context.newPage();
        await page.bringToFront();
        return { browser, page };
      } catch (error) {
        if (!isCollectorConnectionError(error)) throw error;
        if (browser) invalidate(browser);
        if (attempt === 1) {
          throw Object.assign(new Error('采集浏览器连接失效，自动重连后仍无法打开页面。请重新打开采集浏览器后重试。', { cause: error }), { code: 'COLLECTOR_STARTUP_FAILED' });
        }
        await onRetry?.(error);
      }
    }
  }

  return { ensure, invalidate, openPage };
}
