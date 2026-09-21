import { resolveModernCardUrls } from 'douyin-dom-core';

// Adapt the already-tested same-card resolver to extension tabs. No cookies,
// browser debugger, hidden APIs, or index-based substitute cards are used.
export async function resolveExtensionCard({ chromeApi, tabId, row, evaluate, wait, diagnostics, query, timeoutMs = 5000 }) {
  let current = await chromeApi.tabs.get(tabId);
  const popups = new Map();
  let popupListener = null;
  const official = (url) => {
    try { return new URL(url).origin === 'https://www.douyin.com'; } catch { return false; }
  };
  const refresh = async () => {
    current = await chromeApi.tabs.get(tabId);
    for (const popup of popups.values()) {
      const updated = await chromeApi.tabs.get(popup.id).catch(() => null);
      popup.closed = !updated;
      if (updated) popup.current = updated;
    }
  };
  const onCreated = (created) => {
    // Only tabs opened by this exact clicked search tab, during this click.
    // Existing user tabs are never enumerated, modified or closed.
    if (created.openerTabId !== tabId || popups.has(created.id)) return;
    const popup = { id: created.id, current: created, closed: false,
      url: () => official(popup.current.url) ? popup.current.url : '',
      isClosed: () => popup.closed,
      close: async () => {
        if (popup.closed || !official(popup.current.url)) return;
        await chromeApi.tabs.remove(popup.id); popup.closed = true;
      } };
    popups.set(created.id, popup);
    popupListener?.(popup);
  };
  const page = {
    url: () => current.url || '',
    evaluate: (func, argument) => evaluate(tabId, func, argument),
    waitForTimeout: async (milliseconds) => { await wait(milliseconds); await refresh(); },
    locator: (selector) => ({
      count: () => evaluate(tabId, function countSearchCards(selector) {
        return document.querySelectorAll(selector).length;
      }, selector),
      click: async () => {
        const before = current.url;
        try {
          await evaluate(tabId, function clickMarkedSearchCard({ selector, row }) {
            const matches = document.querySelectorAll(selector);
            if (matches.length !== 1) throw new Error('原卡片无法唯一定位');
            const card = matches[0];
            const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const text = normalize(card.innerText).slice(0, 2000);
            const image = card.querySelector('img');
            if (!(row.cardText && text === row.cardText) && !(row.thumbnailUrl && row.title &&
                text.includes(normalize(row.title)) && (image?.currentSrc || image?.src) === row.thumbnailUrl)) {
              throw new Error('点击前卡片内容发生变化，未使用旧位置代替');
            }
            card.scrollIntoView({ block: 'center', behavior: 'instant' });
            // Click the cover where possible, not author/profile/shop links.
            const cover = [...card.querySelectorAll('video, img')].find((element) => !element.closest('a[href*="/user/"], a[href*="/shop/"]'));
            (cover || card).click();
          }, { selector, row });
        } catch (error) {
          // A full navigation may destroy the script context after a successful click.
          await refresh();
          if (current.url === before && ![...popups.values()].some((popup) => popup.url())) throw error;
        }
        await refresh();
      }
    }),
    keyboard: { press: async () => {
      await evaluate(tabId, function dismissVideoModal() {
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      });
      await refresh();
    } },
    goBack: async () => { await chromeApi.tabs.goBack(tabId); await refresh(); },
    // Do not reload: it can discard native filters/scroll state and invalidate
    // the remaining cards. Report an interrupted task rather than silently mix ranks.
    goto: async () => { throw new Error('无法安全恢复原热门筛选，请重新开始采集'); },
    on: (_event, listener) => { popupListener = listener; chromeApi.tabs.onCreated.addListener(onCreated); },
    off: () => { popupListener = null; chromeApi.tabs.onCreated.removeListener(onCreated); }
  };
  try {
    return await resolveModernCardUrls(page, [row], { diagnostics, query, timeoutMs, pollIntervalMs: 250, restoreTimeoutMs: 1500 });
  } finally {
    page.off();
  }
}
