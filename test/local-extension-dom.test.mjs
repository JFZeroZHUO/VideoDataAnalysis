import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { sharedDouyinPlugin } from '../scripts/build-extension.mjs';
import { applyDouyinPopularFilters } from '../server/douyin-search-filter.mjs';

const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const bundled = await build({ stdin: { contents: "export { extractSearchCards, extractDouyinDetail } from 'douyin-dom-core';", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [sharedDouyinPlugin()] });
const { extractSearchCards, extractDouyinDetail } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

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
