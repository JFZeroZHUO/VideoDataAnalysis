import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCollectorConnection, isCollectorConnectionError } from '../server/collector-connection.mjs';

const source = fs.readFileSync(new URL('../server/cdp-collector.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function runCollection(');
const end = source.indexOf('export async function getCdpStatus()', start);
assert.ok(start >= 0 && end > start);
const runSource = source.slice(start, end);

async function runIsolatedCollection(candidates, failure, connection) {
  const job = {};
  const saved = [];
  const activeJobs = new Map([['douyin', 'test-job']]);
  let detailCalls = 0;
  let navigations = 0;
  const updates = [];
  let searchCalls = 0;
  const page = { bringToFront: async () => {}, goto: async () => { navigations += 1; } };
  const environment = {
    activeJobs,
    updateJob: (_id, patch) => { updates.push(patch); Object.assign(job, patch); },
    normalizeDouyinTimeRange: () => 'half_year',
    browserConnection: connection || { openPage: async () => ({ browser: {}, page }), invalidate: () => {} },
    isCollectorConnectionError,
    getKeywordGroups: () => ({}),
    buildCustomSearchQueries: (terms) => terms.map((term) => ({ searchTerm: term })),
    collectDouyin: async () => { searchCalls += 1; if (failure) throw failure; return candidates; },
    analyzeCandidate: (candidate) => ({ ...candidate, productGroup: '搜索主题 · 舞蹈', relevanceScore: 100 }),
    enrichCandidateDetails: async () => { detailCalls += 1; return []; },
    rankCandidates: () => [],
    upsertVideo: (candidate) => { saved.push(candidate); return { added: true }; }
  };
  vm.runInNewContext(runSource, environment, { filename: 'actual-cdp-run-collection.mjs' });
  await environment.runCollection('test-job', 'douyin', { keywords: ['舞蹈'], requireAiEvidence: false, maxResults: 5 });
  return { job, saved, detailCalls, navigations, activeJobs, updates, searchCalls };
}

test('普通关键词任务跳过AI详情核验但保存可见指标和诊断，结束后保留采集现场', async () => {
  const candidates = [{ sourceUrl: 'https://www.douyin.com/video/7600000000000000001', title: '舞蹈现场', likeCount: 5044000, rawMetrics: { querySearchTerm: '舞蹈' } }];
  candidates.searchCardCount = 5;
  candidates.collectionDiagnostics = { searchCardCount: 5, extractedCardCount: 5, collectedCount: 1, linkFailureCount: 4 };
  const { job, saved, detailCalls, navigations, activeJobs } = await runIsolatedCollection(candidates);
  assert.equal(job.status, 'completed');
  assert.equal(job.addedCount, 1);
  assert.equal(job.scannedCount, 1);
  assert.equal(job.searchCardCount, 5);
  assert.deepEqual(job.collectionDiagnostics, candidates.collectionDiagnostics);
  assert.equal(detailCalls, 0);
  assert.equal(navigations, 0);
  assert.equal(saved[0].likeCount, 5044000);
  assert.equal(saved[0].rawMetrics.aiEvidenceRequired, false);
  assert.equal(saved[0].rawMetrics.aiVerificationSkipped, true);
  assert.equal(activeJobs.size, 0);
});

test('找到搜索卡片但全部链接解析失败，不误报成功采集0条', async () => {
  const candidates = [];
  candidates.searchCardCount = 7;
  candidates.collectionDiagnostics = { searchCardCount: 7, linkFailureCount: 7, collectedCount: 0, failureReasons: { missing_link: 7 } };
  const { job, saved } = await runIsolatedCollection(candidates);
  assert.equal(job.status, 'failed');
  assert.match(job.message, /7.*未能解析/);
  assert.deepEqual(job.collectionDiagnostics, candidates.collectionDiagnostics);
  assert.equal(saved.length, 0);
});

test('原生筛选失败未取得结果时明确失败，中断时保留诊断', async () => {
  const candidates = [];
  candidates.collectionDiagnostics = { skippedQueryCount: 1, failureReasons: { native_filter_failed: 1 } };
  const skipped = await runIsolatedCollection(candidates);
  assert.equal(skipped.job.status, 'failed');
  assert.match(skipped.job.message, /原生筛选/);
  const failure = Object.assign(new Error('需要完成平台验证'), { collectionDiagnostics: { searchCardCount: 5, collectedCount: 0 } });
  const interrupted = await runIsolatedCollection([], failure);
  assert.equal(interrupted.job.status, 'failed');
  assert.deepEqual(interrupted.job.collectionDiagnostics, failure.collectionDiagnostics);
});

test('真实任务流程会在旧上下文关闭时展示重连，再只执行一次关键词采集', async () => {
  let connections = 0;
  const page = { bringToFront: async () => {} };
  const connection = createCollectorConnection({ probe: async () => true, launch: async () => assert.fail('端点正常，不应重启浏览器'),
    connect: async () => {
      const stale = ++connections === 1;
      return { isConnected: () => true, on() {}, contexts: () => [{ newPage: async () => {
        if (stale) throw new Error('browserContext.newPage: Target page, context or browser has been closed');
        return page;
      } }] };
    } });
  await connection.ensure();
  const candidates = [{ sourceUrl: 'https://www.douyin.com/video/7600000000000000002', title: '舞蹈', likeCount: 100 }];
  const result = await runIsolatedCollection(candidates, undefined, connection);
  assert.equal(connections, 2);
  assert.equal(result.updates.filter((patch) => patch.phase === 'reconnecting').length, 1);
  assert.equal(result.searchCalls, 1);
  assert.equal(result.job.status, 'completed');
  assert.equal(result.saved.length, 1);
});

test('启动重连耗尽时不执行搜索，任务失败原因保留而不归咎于用户关窗', async () => {
  const connection = createCollectorConnection({ probe: async () => true, launch: async () => {},
    connect: async () => ({ isConnected: () => true, on() {}, contexts: () => [{ newPage: async () => {
      throw new Error('browserContext.newPage: Target page, context or browser has been closed');
    } }] }) });
  const result = await runIsolatedCollection([], undefined, connection);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.searchCalls, 0);
  assert.match(result.job.message, /自动重试 1 次/);
  assert.match(result.job.errorSummary, /原因：.*browserContext.newPage/);
  assert.equal(result.activeJobs.size, 0);
});
