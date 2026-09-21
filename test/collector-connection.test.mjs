import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorConnection, isCollectorConnectionError } from '../server/collector-connection.mjs';

const closed = () => new Error('browserContext.newPage: Target page, context or browser has been closed');
function fakeBrowser({ newPage, contexts, connected = true } = {}) {
  const handlers = new Map();
  const calls = { pages: 0, front: 0 };
  const page = { bringToFront: async () => { calls.front += 1; } };
  const context = { newPage: async () => { calls.pages += 1; return newPage ? newPage() : page; } };
  const browser = {
    isConnected: () => connected,
    contexts: () => contexts || [context],
    on: (name, callback) => handlers.set(name, callback),
    disconnect: () => handlers.get('disconnected')?.(),
    close: () => { throw new Error('Connection manager must never close a browser'); }
  };
  return { browser, page, calls };
}

test('缓存仍报告connected但端点已消失时，会清理缓存、启动并重新连接', async () => {
  const old = fakeBrowser();
  const next = fakeBrowser();
  let ready = true;
  let connects = 0;
  let launches = 0;
  let probes = 0;
  const manager = createCollectorConnection({
    probe: async () => { probes += 1; return ready; },
    connect: async () => (++connects === 1 ? old.browser : next.browser),
    launch: async () => { launches += 1; ready = true; }
  });
  assert.equal(await manager.ensure(), old.browser);
  ready = false;
  assert.equal(await manager.ensure(), next.browser);
  assert.equal(connects, 2);
  assert.equal(launches, 1);
  assert.equal(probes, 3);
});

test('端点正常但缓存上下文已关闭，打开页面自动重连一次成功', async () => {
  const stale = fakeBrowser({ newPage: async () => { throw closed(); } });
  const next = fakeBrowser();
  let connects = 0;
  const retries = [];
  const manager = createCollectorConnection({ probe: async () => true, connect: async () => (++connects === 1 ? stale.browser : next.browser), launch: async () => assert.fail('ready endpoint must not relaunch') });
  const result = await manager.openPage({ onRetry: (error) => retries.push(error) });
  assert.equal(result.browser, next.browser);
  assert.equal(result.page, next.page);
  assert.equal(connects, 2);
  assert.equal(stale.calls.pages, 1);
  assert.equal(next.calls.pages, 1);
  assert.equal(next.calls.front, 1);
  assert.equal(retries.length, 1);
});

test('连续两次页面连接失败即终止，并提供明确错误码及最后原因', async () => {
  const failures = [closed(), closed()];
  let connects = 0;
  let retries = 0;
  const manager = createCollectorConnection({ probe: async () => true,
    connect: async () => { const error = failures[connects++]; return fakeBrowser({ newPage: async () => { throw error; } }).browser; }, launch: async () => {} });
  await assert.rejects(manager.openPage({ onRetry: () => { retries += 1; } }), (error) => {
    assert.equal(error.code, 'COLLECTOR_STARTUP_FAILED');
    assert.equal(error.cause, failures[1]);
    return true;
  });
  assert.equal(connects, 2);
  assert.equal(retries, 1);
});

test('非连接错误原样抛出，不重连也不调用onRetry', async () => {
  const failure = new Error('Permission denied by browser policy');
  const target = fakeBrowser({ newPage: async () => { throw failure; } });
  let connects = 0;
  const manager = createCollectorConnection({ probe: async () => true, connect: async () => { connects += 1; return target.browser; }, launch: async () => {} });
  await assert.rejects(manager.openPage({ onRetry: () => assert.fail('not recoverable') }), (error) => error === failure);
  assert.equal(connects, 1);
});

test('并发ensure共用一次启动及连接，后续ensure仍检查端点', async () => {
  const target = fakeBrowser();
  let ready = false;
  let launches = 0;
  let connects = 0;
  let probes = 0;
  const manager = createCollectorConnection({ probe: async () => { probes += 1; return ready; },
    launch: async () => { launches += 1; ready = true; }, connect: async () => { connects += 1; return target.browser; } });
  const results = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);
  assert.ok(results.every((browser) => browser === target.browser));
  assert.equal(launches, 1);
  assert.equal(connects, 1);
  assert.equal(probes, 2);
  assert.equal(await manager.ensure(), target.browser);
  assert.equal(probes, 3);
});

test('旧连接的延迟断开事件或条件invalidate不会清除新缓存', async () => {
  const old = fakeBrowser();
  const next = fakeBrowser();
  let connects = 0;
  const manager = createCollectorConnection({ probe: async () => true, connect: async () => (++connects === 1 ? old.browser : next.browser), launch: async () => {} });
  await manager.ensure();
  manager.invalidate(old.browser);
  await manager.ensure();
  old.browser.disconnect();
  manager.invalidate(old.browser);
  assert.equal(await manager.ensure(), next.browser);
  assert.equal(connects, 2);
  manager.invalidate();
  await manager.ensure();
  assert.equal(connects, 3);
});

test('只读ensure不会启动浏览器，且失效缓存不会继续返回', async () => {
  const target = fakeBrowser();
  let ready = true;
  let connects = 0;
  const manager = createCollectorConnection({ probe: async () => ready, connect: async () => { connects += 1; return target.browser; }, launch: async () => assert.fail('read-only must not launch') });
  await manager.ensure();
  ready = false;
  assert.equal(await manager.ensure({ allowLaunch: false }), null);
  ready = true;
  await manager.ensure({ allowLaunch: false });
  assert.equal(connects, 2);
});

test('只读状态检查先发起时，并发采集仍可在其结束后启动一次', async () => {
  const target = fakeBrowser();
  let ready = false;
  let launches = 0;
  let connects = 0;
  const manager = createCollectorConnection({ probe: async () => ready, launch: async () => { launches += 1; ready = true; }, connect: async () => { connects += 1; return target.browser; } });
  const [status, first, second] = await Promise.all([manager.ensure({ allowLaunch: false }), manager.ensure(), manager.ensure()]);
  assert.equal(status, null);
  assert.equal(first, target.browser);
  assert.equal(second, target.browser);
  assert.equal(launches, 1);
  assert.equal(connects, 1);
});

test('连接失败后pending会释放，不把失败Promise永久缓存', async () => {
  const target = fakeBrowser();
  const failure = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  let connects = 0;
  const manager = createCollectorConnection({ probe: async () => true, connect: async () => { if (++connects === 1) throw failure; return target.browser; }, launch: async () => {} });
  await assert.rejects(manager.ensure(), (error) => error === failure);
  assert.equal(await manager.ensure(), target.browser);
  assert.equal(connects, 2);
});

test('一次任务重连耗尽后不保留坏连接，下一次任务仍可建立新连接', async () => {
  const next = fakeBrowser();
  let connects = 0;
  const manager = createCollectorConnection({ probe: async () => true,
    connect: async () => ++connects <= 2 ? fakeBrowser({ newPage: async () => { throw closed(); } }).browser : next.browser,
    launch: async () => {} });
  await assert.rejects(manager.openPage(), { code: 'COLLECTOR_STARTUP_FAILED' });
  assert.equal((await manager.openPage()).browser, next.browser);
  assert.equal(connects, 3);
});

test('连接没有上下文时重连，bringToFront连接中断也可重试', async () => {
  const next = fakeBrowser();
  let connects = 0;
  const manager = createCollectorConnection({ probe: async () => true, connect: async () => (++connects === 1 ? fakeBrowser({ contexts: [] }).browser : next.browser), launch: async () => {} });
  assert.equal((await manager.openPage()).browser, next.browser);
  assert.equal(connects, 2);

  const stale = fakeBrowser({ newPage: async () => ({ bringToFront: async () => { throw new Error('Browser disconnected'); } }) });
  connects = 0;
  const another = createCollectorConnection({ probe: async () => true, connect: async () => (++connects === 1 ? stale.browser : next.browser), launch: async () => {} });
  assert.equal((await another.openPage()).page, next.page);
  assert.equal(connects, 2);
});

test('只识别可恢复的连接异常，不将一般超时或权限问题当作关闭', () => {
  assert.equal(isCollectorConnectionError(closed()), true);
  assert.equal(isCollectorConnectionError(new Error('Browser disconnected')), true);
  assert.equal(isCollectorConnectionError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isCollectorConnectionError(new Error('Timeout 30000ms exceeded')), false);
  assert.equal(isCollectorConnectionError(new Error('Permission denied')), false);
});
