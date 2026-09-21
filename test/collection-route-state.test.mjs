import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual registered route with isolated collector/storage dependencies.
// No server is started, no real collection is triggered, and no user database is opened.
const source = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const routeStart = source.indexOf("app.post('/api/collect/:platform'");
const routeEnd = source.indexOf("app.post('/api/channels/open-search'", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart);
const routeSource = source.slice(routeStart, routeEnd);

function requestCollection(overrides = {}, body = { keywords: ['舞蹈'], requireAiEvidence: false, timeRange: 'half_year' }, platform = 'douyin') {
  const calls = [];
  let handler;
  const environment = {
    app: { post: (_path, callback) => { handler = callback; } },
    supportedPlatforms: new Set(['douyin', 'xiaohongshu', 'channels']),
    hasActiveCdpJob: () => false,
    hasActiveBrowserHelperJob: () => false,
    hasActiveChannelsDesktopJob: () => false,
    getRecentJobs: () => [],
    findBrowserExecutable: () => 'test-browser',
    isBrowserHelperConnected: () => true,
    savePlatformSearchState: (...args) => calls.push(['save', ...args]),
    startCdpCollection: (selectedPlatform, settings) => { calls.push(['cdp', selectedPlatform, settings]); return { id: 'accepted-job' }; },
    startBrowserHelperCollection: () => { throw new Error('普通模式不应走不支持的扩展路径'); },
    startChannelsDesktopCollection: (settings) => { calls.push(['channels', settings]); return { id: 'channel-job' }; },
    ...overrides
  };
  vm.runInNewContext(routeSource, environment, { filename: 'actual-collection-route.mjs' });
  const response = { statusCode: 200, payload: null, status(value) { this.statusCode = value; return this; }, json(value) { this.payload = value; return this; } };
  let error;
  handler({ params: { platform }, body }, response, (value) => { error = value; });
  return { response, calls, error };
}

test('普通搜索成功接收后才保存原词、AI开关和任务ID', () => {
  const { calls, response, error } = requestCollection();
  assert.equal(error, undefined);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls.map((call) => call[0]), ['cdp', 'save']);
  assert.deepEqual(Array.from(calls[0][2].keywords), ['舞蹈']);
  assert.equal(calls[0][2].requireAiEvidence, false);
  assert.equal(calls[1][4].requireAiEvidence, false);
  assert.equal(calls[1][4].jobId, 'accepted-job');
  assert.equal(calls[1][4].timeRange, 'half_year');
});

test('跨采集引擎的平台忙冲突返回原任务，不覆盖搜索状态', () => {
  const { response, calls } = requestCollection({
    hasActiveBrowserHelperJob: () => true,
    getRecentJobs: () => [{ id: 'original-job', platform: 'douyin', status: 'running' }]
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.jobId, 'original-job');
  assert.equal(calls.length, 0);
});

test('启动器拒绝或浏览器不可用时不保存一个未执行的新关键词', () => {
  const conflict = Object.assign(new Error('正在采集'), { status: 409, jobId: 'old-job' });
  const failed = requestCollection({ startCdpCollection: () => { throw conflict; } });
  assert.equal(failed.error, conflict);
  assert.equal(failed.calls.length, 0);
  const unavailable = requestCollection({ findBrowserExecutable: () => null });
  assert.equal(unavailable.response.statusCode, 503);
  assert.equal(unavailable.calls.length, 0);
});

test('空关键词拒绝且不触发采集或修改搜索状态', () => {
  const { response, calls } = requestCollection({}, { keywords: [] });
  assert.equal(response.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('视频号也在接收成功后保存任务关键词', () => {
  const { response, calls } = requestCollection({}, { keywords: ['舞蹈'], requireAiEvidence: false }, 'channels');
  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls.map((call) => call[0]), ['channels', 'save']);
  assert.equal(calls[1][4].jobId, 'channel-job');
});
