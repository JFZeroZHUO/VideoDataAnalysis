import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { sharedDouyinPlugin } from '../scripts/build-extension.mjs';
import { applyDouyinPopularFilters } from '../server/douyin-search-filter.mjs';
import { IDBFactory } from 'fake-indexeddb';
import { createLocalStore } from '../local-extension/database.mjs';
import { createLocalService } from '../local-extension/service.mjs';

const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const bundled = await build({ stdin: { contents: "export { extractSearchCards, extractDouyinDetail } from 'douyin-dom-core';", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [sharedDouyinPlugin()] });
const { extractSearchCards, extractDouyinDetail } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const collectorBundle = await build({ entryPoints: ['local-extension/collector.mjs'], bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [sharedDouyinPlugin()] });
const { createCollector } = await import(`data:text/javascript;base64,${Buffer.from(collectorBundle.outputFiles[0].text).toString('base64')}`);

test('回归61张无链接卡片：点击原卡片取真实地址、还原搜索、普通模式保存且不核验AI', { skip: !executablePath, timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    // All Douyin requests are locally fulfilled fixtures, never the live site/account.
    await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="UTF-8"><body>
      <header><form onsubmit="event.preventDefault()"><input data-e2e="searchbar-input" placeholder="搜索你感兴趣的内容"><button type="button" data-e2e="searchbar-button">搜索</button></form></header>
      <main>${Array.from({ length: 61 }, (_, index) => `<article class="search-result-card" data-fixture-index="${index}">
        <div>00:20</div><div>${index + 10}</div><div>奶瓶产品演示第${index}条</div><div>@独立作者${index}</div>
        </article>`).join('')}</main><script>
      document.querySelector('header button').onclick = () => history.pushState({}, '', '/root/search/' + encodeURIComponent(document.querySelector('input').value) + '?aid=native');
      const cards = [...document.querySelectorAll('article')];
      cards.forEach((card, index) => card.onclick = () => {
        const url = new URL(location.href); url.searchParams.set('modal_id', '738272718205485' + String(index).padStart(4, '0'));
        history.pushState({}, '', url); document.body.dataset.opened = String(index);
      });
      addEventListener('popstate', () => { delete document.body.dataset.opened; document.querySelector('main').prepend(document.querySelector('main').lastElementChild); });
      </script>` }));
    const pages = new Map(); const injected = []; const batches = []; const phases = []; let id = 0;
    const listeners = new Set();
    const chrome = {
      tabs: {
        onCreated: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
        create: async ({ url }) => { const page = await context.newPage(); pages.set(++id, page); await page.goto(url); return { id, url, status: 'complete' }; },
        get: async (tabId) => ({ id: tabId, url: pages.get(tabId).url(), status: 'complete' }),
        update: async (tabId, { url }) => { if (url) await pages.get(tabId).goto(url); return { id: tabId }; },
        goBack: async (tabId) => { await pages.get(tabId).goBack(); },
        remove: async (tabId) => { await pages.get(tabId).close(); pages.delete(tabId); }
      },
      scripting: { executeScript: async ({ target, func, args = [] }) => {
        injected.push(func.name); return [{ result: await pages.get(target.tabId).evaluate(func, args[0]) }];
      } }
    };
    const collector = createCollector(chrome, { maxScrollRounds: 0, wait: async () => {},
      applyFilters: async () => ({ verified: true, sort: 'most_liked', contentType: 'video' }) });
    await collector.runTask({ keywords: ['奶瓶'], maxResults: 61, requireAiEvidence: false }, {
      batch: async (rows) => batches.push(...rows), progress: async (patch) => phases.push(structuredClone(patch))
    });
    assert.equal(batches.length, 61);
    for (let index = 0; index < 61; index += 1) {
      assert.equal(batches[index].sourceUrl, `https://www.douyin.com/video/738272718205485${String(index).padStart(4, '0')}`);
      assert.equal(batches[index].title, `奶瓶产品演示第${index}条`);
      assert.equal(batches[index].likeCount, index + 10);
      assert.equal(batches[index].rawMetrics.detailAiDeclarationChecked, false);
      assert.equal(batches[index].query, '奶瓶');
    }
    assert.equal(injected.includes('extractDouyinDetail'), false);
    assert.equal(pages.size, 1);
    assert.equal(new URL(pages.get(1).url()).searchParams.has('modal_id'), false);
    assert.equal(listeners.size, 0);
    assert.equal(phases.at(-1).collectionDiagnostics.linkFailureCount, 0);
    // Pass the actual extracted candidates through the production service/IndexedDB
    // boundary too: collector batches alone do not prove the table can query them.
    const store = createLocalStore({ indexedDB: new IDBFactory(), name: 'linkless-regression' });
    try {
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      const service = createLocalService({ store, version: '3.0.1', runTask: async (_task, hooks) => {
        await hooks.batch(batches); await hooks.complete(); finish();
      } });
      await service.ready;
      await service.request('/api/collect/douyin', { method: 'POST', body: { keywords: ['奶瓶'], requireAiEvidence: false, maxResults: 61 } });
      await done;
      const result = await service.request(`/api/materials?queryTerms=${encodeURIComponent(JSON.stringify(['奶瓶']))}`);
      assert.equal(result.count, 61);
      assert.equal(new Set(result.materials.map((item) => item.sourceUrl)).size, 61);
      assert.equal((await service.request(`/api/materials?queryTerms=${encodeURIComponent(JSON.stringify(['舞蹈']))}`)).count, 0);
    } finally { await store.close(); }
  } finally { await browser.close(); }
});

test('实际独立Chrome的合成页面验证原生筛选、搜索卡片和详情声明读取', { skip: !executablePath, timeout: 30000 }, async () => {
  // Fresh headless browser only: no user profile, login, network or live Douyin page.
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(`<!doctype html><html><body>
      <button id="filter">筛选</button><aside id="panel" style="display:none;width:420px">
        <section><h3>排序依据</h3><button>综合排序</button><button>最新发布</button><button>最多点赞</button></section>
        <section><h3>发布时间</h3><button>不限</button><button>一天内</button><button>一周内</button><button>半年内</button></section>
        <section><h3>内容形式</h3><button>不限</button><button>视频</button><button>图文</button></section>
      </aside>
      <article class="search-result-card"><a href="https://www.douyin.com/video/7382727182054853891" title="爵士舞基础教学">
        <div>00:20</div><div>1.2万</div><div>爵士舞基础教学</div></a><a href="https://www.douyin.com/user/teacher">@编舞老师</a><div>2天前</div></article>
      <script>document.getElementById('filter').onclick=()=>document.getElementById('panel').style.display='block';
      document.querySelectorAll('section button').forEach(button=>button.onclick=()=>{
        button.parentElement.querySelectorAll('button').forEach(item=>item.setAttribute('aria-selected','false'));
        button.setAttribute('aria-selected','true');
      });</script></body></html>`);
    const filters = await applyDouyinPopularFilters({ evaluate: (...args) => page.evaluate(...args), waitForTimeout: async () => {} }, 'one_week');
    assert.equal(filters.verified, true);
    assert.deepEqual(await page.locator('[aria-selected="true"]').allTextContents(), ['最多点赞', '一周内', '视频']);
    const cards = await page.evaluate(extractSearchCards, 'fixture');
    assert.equal(cards.rows.length, 1);
    assert.equal(cards.rows[0].sourceUrl, 'https://www.douyin.com/video/7382727182054853891');
    assert.equal(cards.rows[0].visibleLikeText, '1.2万');
    assert.equal(cards.rows[0].authorName, '编舞老师');
    await page.setContent(`<html><head><title>爵士舞基础教学 - 抖音</title></head><body>
      <div data-e2e="video-detail"><div>作者声明：内容由AI生成</div><span data-e2e="video-player-digg">1.2万</span>
      <span data-e2e="video-player-collect">456</span><span data-e2e="feed-comment-icon">78</span><span data-e2e="video-player-share">90</span></div></body></html>`);
    const detail = await page.evaluate(extractDouyinDetail, { title: '原卡片', sourceUrl: cards.rows[0].sourceUrl });
    assert.equal(detail.rawMetrics.detailAiDeclarationChecked, true);
    assert.equal(detail.rawMetrics.detailAiDeclarationVerified, true);
    assert.equal(detail.likeCount, 12000); assert.equal(detail.favoriteCount, 456); assert.equal(detail.commentCount, 78);
    assert.equal(detail.rawMetrics.metricsVerified, true);
    await page.locator('[data-e2e="video-detail"] > div').evaluate((element) => { element.textContent = '普通舞蹈实拍'; });
    const regular = await page.evaluate(extractDouyinDetail, { title: '原卡片', sourceUrl: cards.rows[0].sourceUrl });
    assert.equal(regular.rawMetrics.detailAiDeclarationVerified, false);
  } finally { await browser.close(); }
});
