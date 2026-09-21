// Isolated UI smoke test. Synthetic bridge fixtures test wiring, not a real Douyin account.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const root = resolve('dist-web');
const server = createServer(async (req, res) => {
  if (req.url === '/api/deepseek/status') { res.setHeader('Content-Type', 'application/json'); return res.end('{"configured":false,"allowLocalConfig":false}'); }
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}/`) && !file.startsWith(`${root}\\`)) { res.statusCode = 403; return res.end(); }
  try {
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.zip': 'application/zip' };
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.SMOKE_CHROME_PATH ? { executablePath: process.env.SMOKE_CHROME_PATH }
    : process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByText('先连接抖音本机助手', { exact: true }).waitFor();
  assert.equal(await page.locator('.platform-rail button').count(), 1);
  assert.equal(await page.locator('.keyword-search-action').isDisabled(), true);
  await page.waitForTimeout(6400);
  assert.match(await page.locator('body').innerText(), /未连接抖音本机助手/);
  await mkdir('storage', { recursive: true });
  await page.screenshot({ path: 'storage/web-smoke-install.png', fullPage: true });

  await page.addInitScript(() => {
    window.__smokeRequests = [];
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (event.source !== window || message?.channel !== 'video-data-analysis' || message.direction !== 'request') return;
      window.__smokeRequests.push(message);
      const path = new URL(message.url, location.origin).pathname;
      const row = { id: 'test-only', title: '舞蹈 UI 测试样本（非真实采集）', sourceUrl: 'https://www.douyin.com/video/7600000000000000001',
        productGroup: '搜索主题 · 舞蹈', likeCount: 125000, aiProof: { verified: false, label: '未核验' } };
      const data = path === '/api/meta' ? { collectorAvailable: true, localExtension: { connected: true, version: '3.0.0' },
        browserHelper: { connected: true, version: '3.0.0' }, materialCounts: { douyin: 1 }, latestJobs: {},
        searchStates: { douyin: { keywords: ['舞蹈'], requireAiEvidence: false, resultScope: 'current' } } }
        : path === '/api/materials' ? { count: 1, materials: [row], facets: {} }
        : path === '/api/collect/douyin' || path.startsWith('/api/jobs/') ? { id: 'smoke-job', platform: 'douyin', status: 'running', phase: 'waiting_login',
          keywords: ['舞蹈'], requireAiEvidence: false, message: '模拟等待登录，未启动真实采集' }
        : path === '/api/local/backup' ? { schemaVersion: 1, materials: [], searchStates: {} }
        : path === '/api/export/materials.csv' ? { csv: '标题,点赞\n测试样本,125000' }
        : { saved: true };
      window.postMessage({ ...message, direction: 'response', ok: true, data }, location.origin);
    });
  });
  await page.reload();
  await page.getByText('舞蹈 UI 测试样本（非真实采集）', { exact: true }).waitFor();
  assert.equal(await page.locator('input[type=checkbox]').isChecked(), false);
  assert.equal(await page.locator('.keyword-search-action').isDisabled(), false);
  await page.getByRole('button', { name: '导出素材CSV' }).click();
  await page.screenshot({ path: 'storage/web-smoke-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'storage/web-smoke-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.keyword-search-action').click();
  await page.getByRole('dialog').filter({ hasText: '请在抖音页面完成验证' }).waitFor();
  const request = await page.evaluate(() => window.__smokeRequests.find((item) => item.url === '/api/collect/douyin'));
  assert.deepEqual(request.body.keywords, ['舞蹈']);
  assert.equal(request.body.requireAiEvidence, false);
  await page.getByRole('button', { name: '稍后处理' }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: built online UI; install/connection state; exact-keyword bridge; ordinary results; CSV; responsive layout; login dialog. Synthetic fixtures only.');
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
