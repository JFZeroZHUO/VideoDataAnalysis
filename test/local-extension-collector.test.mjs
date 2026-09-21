import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { sharedDouyinPlugin, buildExtension } from '../scripts/build-extension.mjs';

const bundled = await build({ entryPoints: ['local-extension/collector.mjs'], bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [sharedDouyinPlugin()] });
const { createCollector, normalizeSearchCandidate, matchesDouyinDestination } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const video = (id = '7382727182054853891') => `https://www.douyin.com/video/${id}`;
const row = (overrides = {}) => ({ sourceUrl: video(), title: '舞蹈教学：300万播放，收藏999', rawText: '舞蹈教学：300万播放，收藏999', visibleLikeText: '1.2万', ...overrides });
const filterState = { verified: true, sort: 'most_liked', timeRange: 'half_year', contentType: 'video' };

function harness({ rows = [row()], readiness = [], detailVerified = true, filterError = false, maxScrollRounds = 0 } = {}) {
  let nextId = 1;
  const tabs = new Map(); const visited = []; const phases = []; const batches = []; const injected = []; const filterQueries = [];
  const chrome = {
    tabs: {
      create: async (settings) => { const created = { id: nextId++, windowId: 1, status: 'complete', ...settings }; tabs.set(created.id, created); return created; },
      get: async (id) => { if (!tabs.has(id)) throw new Error('tab missing'); return { ...tabs.get(id) }; },
      update: async (id, settings) => { const item = tabs.get(id); if (!item) throw new Error('tab missing'); Object.assign(item, settings); if (settings.url) visited.push(settings.url); return { ...item }; }
    },
    scripting: { executeScript: async ({ target, func, args = [] }) => {
      injected.push(func.name);
      if (func.name === 'inspectDouyinPage') return [{ result: readiness.length ? readiness.shift() : { count: 1, detail: true } }];
      if (func.name === 'extractSearchCards') return [{ result: { rows: typeof rows === 'function' ? rows(tabs.get(target.tabId).url) : rows } }];
      if (func.name === 'extractDouyinDetail') {
        const candidate = args[0];
        return [{ result: { ...candidate, platformAiLabel: detailVerified ? '内容由AI生成' : null,
          rawMetrics: { ...candidate.rawMetrics, aiDeclarationScope: 'detail', detailAiDeclarationChecked: true, detailAiDeclarationVerified: detailVerified } } }];
      }
      if (func.name === 'scrollDouyinResults') return [{ result: true }];
      throw new Error(`Unexpected injected function: ${func.name}`);
    } }
  };
  const collector = createCollector(chrome, { wait: async () => {}, maxScrollRounds, attentionPolls: 15,
    applyFilters: async (_page, timeRange) => {
      filterQueries.push(timeRange);
      if (filterError) throw new Error('最多点赞不可用');
      return filterState;
    } });
  const hooks = { progress: async (patch) => phases.push(structuredClone(patch)), batch: async (batch) => batches.push(...structuredClone(batch)) };
  return { chrome, collector, hooks, tabs, visited, phases, batches, injected, filterQueries };
}

test('普通搜索仅原词逐一执行，不使用隐藏扩词或母婴词，且不访问详情', async () => {
  const h = harness();
  await h.collector.runTask({ keywords: ['舞蹈', '咖啡机'], queries: [{ query: '纸尿裤AI' }], maxResults: 20, timeRange: 'one_week', requireAiEvidence: false }, h.hooks);
  assert.deepEqual(h.visited, ['舞蹈', '咖啡机'].map((keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`));
  assert.equal(h.tabs.size, 1);
  assert.equal(h.injected.includes('extractDouyinDetail'), false);
  assert.deepEqual(h.batches.map((candidate) => candidate.query), ['舞蹈', '咖啡机']);
  assert.deepEqual(h.filterQueries, ['one_week', 'one_week']);
  assert.equal(h.batches[0].viewCount, null);
  assert.equal(h.batches[0].favoriteCount, null);
  assert.equal(h.batches[0].likeCount, 12000);
  assert.equal(h.batches[0].rawMetrics.searchFilterVerified, true);
  assert.equal(h.batches[0].rawMetrics.detailAiDeclarationChecked, false);
});

test('总预算均分到每词：前词额满仍执行下一词，同一视频保留每个来源词', async () => {
  const h = harness({ rows: [1, 2, 3, 4].map((id) => row({ sourceUrl: video(`738272718205485389${id}`) })) });
  await h.collector.runTask({ keywords: ['舞蹈', '爵士'], maxResults: 3, requireAiEvidence: false }, h.hooks);
  assert.equal(h.visited.length, 2);
  assert.deepEqual(h.batches.map((candidate) => candidate.query), ['舞蹈', '舞蹈', '爵士']);
  assert.equal(h.batches[0].sourceUrl, h.batches[2].sourceUrl);
  assert.equal(h.phases.at(-1).collectionDiagnostics.collectedCount, 2);
  assert.match(h.phases.at(-1).message, /2 个词已达分配预算.*并非全网完整排名/);
});

test('预算小于队列长度也每词至少采集一条，不会漏掉后续关键词', async () => {
  const h = harness({ rows: [row(), row({ sourceUrl: video('7382727182054853892') })] });
  await h.collector.runTask({ keywords: ['舞蹈', '爵士', '街舞'], maxResults: 1 }, h.hooks);
  assert.equal(h.visited.length, 3);
  assert.deepEqual(h.batches.map((candidate) => candidate.query), ['舞蹈', '爵士', '街舞']);
  assert.match(h.phases.at(-1).message, /各词累计 3\/3 条/);
});

test('文本中的播放量和收藏宣传不能伪装成公开指标，卡片声明不能当详情证据', () => {
  const candidate = normalizeSearchCandidate(row({ visibleLikeText: null, platformAiLabel: '疑似AI生成' }), { query: '舞蹈', keyword: '舞蹈' }, filterState);
  assert.equal(candidate.viewCount, null); assert.equal(candidate.likeCount, null); assert.equal(candidate.favoriteCount, null);
  assert.equal(candidate.platformAiBadge, false); assert.equal(candidate.platformAiLabel, null);
  assert.equal(candidate.rawMetrics.metricsVerified, false);
});

test('支持抖音 root/search 同词重定向，但不接受错词、错视频或其它域名', () => {
  const target = 'https://www.douyin.com/search/%E8%88%9E%E8%B9%88?type=general';
  assert.equal(matchesDouyinDestination('https://www.douyin.com/root/search/舞蹈?aid=1&type=general', target), true);
  assert.equal(matchesDouyinDestination('https://www.douyin.com/root/search/纸尿裤', target), false);
  assert.equal(matchesDouyinDestination('https://evil.example/search/舞蹈', target), false);
  assert.equal(matchesDouyinDestination(video('7382727182054853892'), video()), false);
  assert.equal(matchesDouyinDestination(video() + '?recommend=1', video()), true);
});

test('没有可靠视频链接时不点其它卡片、不猜链接，并给出明确失败信息', async () => {
  const h = harness({ rows: [row({ sourceUrl: null, cardIndex: 0 })] });
  await assert.rejects(h.collector.runTask({ keywords: ['舞蹈'] }, h.hooks), /没有可靠视频链接/);
  assert.equal(h.batches.length, 0);
  assert.equal(h.tabs.size, 1);
  assert.equal(h.phases.find((phase) => phase.collectionDiagnostics)?.collectionDiagnostics.linkFailureCount, 1);
});

test('开启AI筛选只接受已核验的详情声明', async () => {
  const verified = harness();
  await verified.collector.runTask({ keywords: ['舞蹈'], requireAiEvidence: true }, verified.hooks);
  assert.equal(verified.tabs.size, 2);
  assert.equal(verified.batches.length, 1);
  assert.equal(verified.batches[0].rawMetrics.detailAiDeclarationVerified, true);
  assert.equal(verified.batches[0].rawMetrics.aiDeclarationScope, 'detail');
  const unverified = harness({ detailVerified: false });
  await unverified.collector.runTask({ keywords: ['舞蹈'], requireAiEvidence: true }, unverified.hooks);
  assert.equal(unverified.batches.length, 0);
  assert.equal(unverified.injected.includes('extractDouyinDetail'), true);
});

test('原生最多点赞筛选失败不能将默认结果入库', async () => {
  const h = harness({ filterError: true });
  await assert.rejects(h.collector.runTask({ keywords: ['舞蹈', '爵士'] }, h.hooks), /所有关键词.*筛选/);
  assert.equal(h.batches.length, 0);
  assert.equal(h.injected.includes('extractSearchCards'), false);
  assert.equal(h.phases.filter((phase) => phase.phase === 'search_skipped').length, 2);
});

test('登录和安全验证暂停等待人工完成，然后从当前词继续', async () => {
  const h = harness({ readiness: [{ login: true }, { verification: true }, { count: 1 }, { count: 1 }, { count: 1 }] });
  await h.collector.runTask({ keywords: ['舞蹈'], requireAiEvidence: false }, h.hooks);
  assert.equal(h.phases.some((phase) => phase.phase === 'waiting_login'), true);
  assert.equal(h.phases.some((phase) => phase.phase === 'waiting_verification'), true);
  assert.equal(h.batches.length, 1);
  assert.equal(h.visited.length, 1);
});

test('验证码未完成不会采集卡片或尝试自动解题', async () => {
  const h = harness({ readiness: Array.from({ length: 15 }, () => ({ verification: true })) });
  await assert.rejects(h.collector.runTask({ keywords: ['舞蹈'] }, h.hooks), /等待登录或安全验证超时/);
  assert.equal(h.batches.length, 0); assert.equal(h.filterQueries.length, 0);
  assert.equal(h.injected.every((name) => name === 'inspectDouyinPage'), true);
});

test('标签页关闭立即报告，并允许用户重新发起任务', async () => {
  const h = harness();
  const original = h.chrome.tabs.get;
  h.chrome.tabs.get = async () => { throw new Error('closed'); };
  await assert.rejects(h.collector.runTask({ keywords: ['舞蹈'] }, h.hooks), /标签页已关闭/);
  h.chrome.tabs.get = original;
  await h.collector.runTask({ keywords: ['舞蹈'] }, h.hooks);
  assert.equal(h.batches.length, 1);
});

test('扩展产物可以实际构建，ZIP仅含允许文件，不含Node或本机密钥/数据库', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vda-extension-test-'));
  try {
    const result = await buildExtension({ outputDirectory: join(folder, 'extension'), zipPath: join(folder, 'extension.zip') });
    const archive = unzipSync(new Uint8Array(await readFile(result.zipPath)));
    assert.deepEqual(Object.keys(archive).sort(), ['background.js', 'bridge.js', 'manifest.json', 'popup.css', 'popup.html', 'popup.js']);
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json']));
    assert.equal(manifest.version, '3.0.1');
    assert.deepEqual(manifest.host_permissions, ['https://www.douyin.com/*']);
    assert.equal(manifest.permissions.some((permission) => ['cookies', 'debugger', '<all_urls>'].includes(permission)), false);
    const source = new TextDecoder().decode(archive['background.js']);
    assert.doesNotMatch(source, /(?:from\s+["']node:|require\(["'](?:fs|playwright|node:)|127\.0\.0\.1:4318\/api|DEEPSEEK_API_KEY)/);
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    await rm(folder, { recursive: true, force: true });
  }
});
