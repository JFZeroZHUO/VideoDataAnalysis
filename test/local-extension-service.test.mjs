import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createLocalStore } from '../local-extension/database.mjs';
import { createLocalService } from '../local-extension/service.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const params = (words) => `?queryTerms=${encodeURIComponent(JSON.stringify(words))}`;
const post = (body) => ({ method: 'POST', body });
const record = (id = '123456789', query = '舞蹈', extra = {}) => ({
  platform: 'douyin', sourceUrl: `https://www.douyin.com/video/${id}`, title: `${query}公开舞台视频`, query,
  likeCount: 800, favoriteCount: null, commentCount: null, shareCount: null, viewCount: null,
  rawMetrics: { querySearchTerm: query, searchFilterVerified: true, searchFilter: { sortLabel: '最多点赞', verified: true } }, ...extra
});
async function fixture(t, options = {}) {
  const indexedDB = new IDBFactory();
  const store = createLocalStore({ indexedDB, name: 'test' });
  const calls = [];
  const service = createLocalService({ store, version: '3.0.0', runTask: (task, hooks) => {
    calls.push({ task, hooks });
    return new Promise(() => {});
  }, ...options });
  await service.ready;
  t.after(() => store.close());
  const start = async (words = ['舞蹈'], extra = {}) => {
    const job = await service.request('/api/collect/douyin', post({ keywords: words, requireAiEvidence: false, ...extra }));
    await tick();
    return { job, ...calls.at(-1) };
  };
  return { indexedDB, store, calls, service, start };
}

test('IndexedDB get/set/remove commits and survives connection reopening', async () => {
  const indexedDB = new IDBFactory();
  const first = createLocalStore({ indexedDB, name: 'reopen' });
  await first.set('material', { title: '舞蹈', likes: null });
  assert.deepEqual(await first.get('material'), { title: '舞蹈', likes: null });
  await first.close();
  const second = createLocalStore({ indexedDB, name: 'reopen' });
  assert.deepEqual(await second.get('material'), { title: '舞蹈', likes: null });
  await second.remove('material');
  assert.equal(await second.get('material'), undefined);
  await second.close();
});

test('ordinary collection preserves exact multi-keyword queue and missing metrics without maternal/AI gate', async (t) => {
  const { service, start } = await fixture(t);
  const { task, hooks } = await start(['舞蹈', '商用咖啡机', 'Sora Dance']);
  assert.deepEqual(task.queries, ['舞蹈', '商用咖啡机', 'Sora Dance'].map((keyword) => ({ keyword, query: keyword })));
  assert.equal(task.requireAiEvidence, false);
  await hooks.batch([record(), record('123456790', '商用咖啡机'), record('123456791', 'Sora Dance', { title: '第1集 舞蹈剧情' })]);
  await hooks.complete();
  const data = await service.request('/api/materials');
  assert.equal(data.count, 3);
  assert.equal(data.materials[0].favoriteCount, null);
  assert.equal(data.materials[0].marketingScore, null);
  assert.equal(data.materials[0].favoriteLikeRate, null);
  assert.equal(data.materials[0].metricQuality.verified, false);
  assert.equal(data.materials[0].aiProof.verified, false);
  assert.equal((await service.request(`/api/materials${params(['舞蹈'])}`)).count, 1);
  assert.equal((await service.request('/api/materials?aiEvidence=verified')).count, 0);
  assert.equal((await service.request('/api/materials?quality=ready')).count, 0);
  assert.equal((await service.request('/api/category-rankings')).groups.flatMap((group) => group.videos).length, 3);
  const analysis = await service.request('/api/analysis');
  assert.equal(analysis.summary.materials, 3);
  assert.equal(analysis.summary.aiVerified, 0);
  assert.equal(analysis.summary.avgMarketingScore, null);
});

test('incremental concurrent batches are serialized, deduplicate, and retain genuine query provenance', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks } = await start(['舞蹈', '跳舞']);
  await Promise.all([
    hooks.batch([record('123456789', '舞蹈', { queryTerms: ['纸尿裤'], rawMetrics: { querySearchTerms: ['奶瓶'] } })]),
    hooks.batch([record('123456789', '跳舞', { likeCount: 999 })]),
    hooks.batch([record('123456790', '舞蹈')]),
    hooks.progress({ phase: 'searching', message: '逐词搜索', progress: 40 })
  ]);
  const rows = (await service.request('/api/materials')).materials;
  assert.equal(rows.length, 2);
  const shared = rows.find((row) => row.platformItemId === '123456789');
  assert.equal(shared.likeCount, 999);
  assert.deepEqual(shared.queryTerms, ['舞蹈', '跳舞']);
  assert.equal((await service.request(`/api/materials${params(['舞蹈'])}`)).count, 2);
  assert.equal((await service.request(`/api/materials${params(['纸尿裤'])}`)).count, 0);
  assert.equal((await service.request(`/api/materials${params(['跳舞'])}`)).count, 1);
});

test('AI collection requires captured detail-page declaration, never title alone or a bare boolean', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks } = await start(['舞蹈'], { requireAiEvidence: true });
  const evidence = { detailAiDeclarationVerified: true, aiDeclarationScope: 'detail', platformAiLabel: '作者声明：内容由 AI 生成', detailCollectedAt: '2026-09-21T10:00:00Z' };
  await hooks.batch([
    record('123456781', '舞蹈', { title: 'AI生成视频舞蹈' }),
    record('123456782', '舞蹈', { rawMetrics: { detailAiDeclarationVerified: true } }),
    record('123456783', '舞蹈', { rawMetrics: { ...evidence, aiDeclarationScope: 'search' } }),
    record('123456784', '舞蹈', { rawMetrics: evidence })
  ]);
  const data = await service.request('/api/materials');
  assert.equal(data.count, 1);
  assert.equal(data.materials[0].platformItemId, '123456784');
  assert.equal(data.materials[0].aiProof.verified, true);
  assert.match(data.materials[0].aiProof.label, /内容由 AI 生成/);
});

test('ordinary recollection retains already verified AI evidence and previously observed missing metrics', async (t) => {
  const { service, start } = await fixture(t);
  const first = await start(['舞蹈'], { requireAiEvidence: true });
  const evidence = { detailAiDeclarationVerified: true, aiDeclarationScope: 'detail', platformAiLabel: '疑似AI生成', detailCollectedAt: '2026-09-21T10:00:00Z', metricsVerified: true,
    metricEvidence: { favoriteCount: { value: 0, text: '0', selector: '[data-e2e="video-player-collect"]', verified: true } } };
  await first.hooks.batch([record('123456789', '舞蹈', { favoriteCount: 0, commentCount: 10, shareCount: 20, rawMetrics: evidence })]);
  await first.hooks.complete();
  const second = await start(['舞蹈']);
  await second.hooks.batch([record('123456789', '舞蹈', { likeCount: 900 })]);
  const item = (await service.request('/api/materials')).materials[0];
  assert.equal(item.aiProof.verified, true);
  assert.equal(item.aiProof.label, '疑似AI生成');
  assert.equal(item.favoriteCount, 0);
  assert.equal(item.likeCount, 900);
  assert.equal(item.favoriteLikeRate, 0);
  assert.equal(item.rawMetrics.metricEvidence.favoriteCount.text, '0');
});

test('search state including filters persists in extension database and safe backup', async (t) => {
  const { service, store } = await fixture(t);
  const settings = { keywords: ['舞蹈'], resultScope: 'current', requireAiEvidence: false, timeRange: 'one_week', filters: { aiEvidence: 'all', quality: 'all', search: '广场', sort: 'likeCount', direction: 'asc' } };
  await service.request('/api/local/search-state', post(settings));
  const reloaded = createLocalService({ store });
  const state = (await reloaded.request('/api/meta')).searchStates.douyin;
  assert.deepEqual(state.keywords, ['舞蹈']);
  assert.equal(state.filters.search, '广场');
  assert.equal(state.filters.direction, 'asc');
  const backup = await reloaded.request('/api/local/backup');
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.searchState.timeRange, 'one_week');
  assert.deepEqual(Object.keys(backup).sort(), ['exportedAt', 'materials', 'schemaVersion', 'searchState']);
  await assert.rejects(service.request('/api/local/search-state', post({ ...settings, apiKey: 'secret' })), /不支持的字段/);
});

test('worker restart marks waiting task interrupted while retaining already committed results', async (t) => {
  const { service, store, start } = await fixture(t);
  const { hooks, job } = await start();
  await hooks.batch([record()]);
  await hooks.progress({ phase: 'waiting_login', tabId: 12, message: '请先登录' });
  assert.equal((await service.request('/api/local/attention')).job.id, job.id);
  const reloaded = createLocalService({ store });
  const restored = await reloaded.request(`/api/jobs/${job.id}`);
  assert.equal(restored.status, 'failed');
  assert.equal(restored.phase, 'interrupted');
  assert.equal((await reloaded.request('/api/materials')).count, 1);
  assert.equal((await reloaded.request('/api/local/attention')).job, null);
  await hooks.batch([record('123456790')]);
  assert.equal((await reloaded.request('/api/materials')).count, 1, 'stale hooks cannot mutate an interrupted job');
});

test('active job prevents concurrent start; failure retains materials and redacts credentials', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks, job } = await start();
  await assert.rejects(service.request('/api/collect/douyin', post({ keywords: ['咖啡机'] })), (cause) => cause.status === 409);
  await hooks.batch([record()]);
  await hooks.fail('读取失败 token=private-secret sk-superprivate123456 Bearer bearer-secret');
  const failed = await service.request(`/api/jobs/${job.id}`);
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.message, /private-secret|sk-superprivate123456|bearer-secret/);
  assert.equal((await service.request('/api/materials')).count, 1);
  await hooks.complete();
  assert.equal((await service.request(`/api/jobs/${job.id}`)).status, 'failed');
});

test('backup restore merges safely and roundtrips metric evidence without credentials or jobs', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks } = await start();
  await hooks.batch([record('123456789')]);
  await hooks.complete();
  const backup = await service.request('/api/local/backup');
  const merged = await service.request('/api/local/restore', post({ backup: { ...backup, materials: [record('123456789', '跳舞', { likeCount: 1000 }), record('123456790', '咖啡机')] } }));
  assert.deepEqual(merged, { addedCount: 1, updatedCount: 1, total: 2 });
  const exported = await service.request('/api/local/backup');
  await service.request('/api/local/restore', post({ backup: exported }));
  assert.equal((await service.request('/api/materials')).count, 2);
  assert.deepEqual((await service.request(`/api/materials${params(['跳舞'])}`)).materials[0].queryTerms, ['舞蹈', '跳舞']);
  assert.doesNotMatch(JSON.stringify(exported), /"(?:apiKey|jobs|cookies|authorizedOrigins)"/);
});

test('malicious or malformed backup fails atomically and never clears the existing library', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks } = await start();
  await hooks.batch([record()]);
  await hooks.complete();
  const base = { schemaVersion: 1, materials: [record('123456790', '咖啡机')], searchState: null };
  const attacks = [
    { ...base, apiKey: 'secret' },
    { ...base, schemaVersion: 2 },
    { ...base, materials: [...base.materials, record('123456792', '舞蹈', { sourceUrl: 'javascript:alert(1)' })] },
    { ...base, materials: [record('123456790', '舞蹈', { sourceUrl: 'https://www.douyin.com.evil.test/video/123456789' })] },
    { ...base, materials: [record('123456790', '舞蹈', { sourceUrl: 'https://user:password@www.douyin.com/video/123456790' })] },
    { ...base, materials: [record('123456790', '舞蹈', { thumbnailUrl: 'https://evil.test/track.png' })] },
    { ...base, materials: [record('123456790', '舞蹈', { platform: 'channels' })] },
    { ...base, materials: [record('123456790', '舞蹈', { likeCount: -1 })] },
    { ...base, materials: [record('123456790', '舞蹈', { likeCount: '1000' })] },
    { ...base, materials: [record('123456790', '舞蹈', { rawMetrics: { cookie: 'secret' } })] },
    { ...base, materials: [record('123456790', '舞蹈', { rawMetrics: { metricEvidence: { likeCount: { value: 10, token: 'secret' } } } })] },
    { ...base, materials: [record('123456790', '舞蹈', { queryTerms: 'not-an-array' })] },
    { ...base, searchState: { keywords: ['舞蹈'], filters: { cookie: 'secret' } } },
    JSON.parse('{"schemaVersion":1,"materials":[],"__proto__":{"polluted":true}}')
  ];
  for (const backup of attacks) {
    await assert.rejects(service.request('/api/local/restore', post({ backup })));
    assert.equal((await service.request('/api/materials')).count, 1);
  }
  assert.equal({}.polluted, undefined);
});

test('invalid scope does not silently fall back to unrelated historical results; nulls sort last', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks } = await start();
  await hooks.batch([record('123456789', '舞蹈', { likeCount: null }), record('123456790', '舞蹈', { likeCount: 0 }), record('123456791', '舞蹈', { likeCount: 10 })]);
  assert.equal((await service.request(`/api/materials${params([])}`)).count, 0);
  await assert.rejects(service.request('/api/materials?queryTerms=broken'), /关键词范围无效/);
  assert.deepEqual((await service.request('/api/materials?sort=likeCount&direction=asc')).materials.map((item) => item.likeCount), [0, 10, null]);
  assert.deepEqual((await service.request('/api/materials?sort=likeCount&direction=desc')).materials.map((item) => item.likeCount), [10, 0, null]);
  assert.equal((await service.request('/api/materials?search=unrelated')).count, 0);
});

test('invalid collection records are rejected without poisoning good rows and no task can fabricate provenance', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks, job } = await start();
  await hooks.batch([record(), record('123456790', '奶瓶'), record('123456791', '舞蹈', { sourceUrl: 'https://evil.test/video' }), null]);
  assert.equal((await service.request('/api/materials')).count, 1);
  assert.equal((await service.request(`/api/jobs/${job.id}`)).failedCount, 3);
});

test('CSV escapes quotes/newlines/formulas and exports missing metrics as blank not zero', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks } = await start();
  await hooks.batch([record('123456789', '舞蹈', { title: '=HYPERLINK("evil")\n舞蹈', authorName: '@danger', likeCount: 0 })]);
  const { csv } = await service.request('/api/export/materials.csv');
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /"'=HYPERLINK\(""evil""\)\n舞蹈"/);
  assert.match(csv, /"'@danger"/);
  assert.match(csv, /"舞蹈","","0","","","",""/);
});

test('unsupported routes/platforms are explicit errors and oversized keywords are not silently replaced', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.request('https://evil.test'), /外部地址/);
  await assert.rejects(service.request('/api/materials?platform=channels'), (cause) => cause.status === 501);
  await assert.rejects(service.request('/api/not-real'), (cause) => cause.status === 404);
  await assert.rejects(service.request('/api/collect/douyin', post({ keywords: [] })), /至少一个/);
  await assert.rejects(service.request('/api/collect/douyin', post({ keywords: ['舞'.repeat(81)] })), /80字/);
  await assert.rejects(service.request('/api/collect/douyin', post({ keywords: ['词'].fill(41) })), /最多40个/);
});

test('a failed database write rejects atomically and the next valid write still succeeds', async (t) => {
  const { service, store, start } = await fixture(t);
  const { hooks } = await start();
  const originalSet = store.set;
  store.set = () => Promise.reject(new Error('模拟存储容量不足'));
  await assert.rejects(hooks.batch([record()]), /容量不足/);
  store.set = originalSet;
  assert.equal((await service.request('/api/materials')).count, 0);
  await hooks.batch([record()]);
  assert.equal((await service.request('/api/materials')).count, 1);
});

test('zero accepted records with parser/link failures is a failed job, not a successful empty collection', async (t) => {
  const { service, start } = await fixture(t);
  const first = await start();
  await first.hooks.progress({ searchCardCount: 5, collectionDiagnostics: { linkFailureCount: 5, failureSamples: [{ query: '舞蹈', title: '舞台', message: '视频链接未解析' }] } });
  await first.hooks.complete();
  const failed = await service.request(`/api/jobs/${first.job.id}`);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'parse_failed');
  assert.equal(failed.collectionDiagnostics.failureSamples[0].message, '视频链接未解析');
  const second = await start();
  await second.hooks.batch([record('123456799', '舞蹈', { sourceUrl: 'not-a-video' })]);
  await second.hooks.complete();
  assert.equal((await service.request(`/api/jobs/${second.job.id}`)).status, 'failed');
});

test('collector rejection is surfaced, sanitized, and never rolls back a previously saved batch', async (t) => {
  const { service } = await fixture(t, { runTask: async (_task, hooks) => {
    await hooks.batch([record()]);
    throw new Error('浏览器窗口被关闭 token=secret-value');
  } });
  const job = await service.request('/api/collect/douyin', post({ keywords: ['舞蹈'] }));
  let current;
  for (let index = 0; index < 30; index += 1) {
    current = await service.request(`/api/jobs/${job.id}`);
    if (current.status === 'failed') break;
    await tick();
  }
  assert.equal(current.status, 'failed');
  assert.match(current.message, /浏览器窗口被关闭/);
  assert.doesNotMatch(current.message, /secret-value/);
  assert.equal((await service.request('/api/materials')).count, 1);
});

test('backup merge cannot run during collection and malformed metric evidence never changes the library', async (t) => {
  const { service, start } = await fixture(t);
  const { hooks } = await start();
  await assert.rejects(service.request('/api/local/restore', post({ backup: { schemaVersion: 1, materials: [record()] } })), (cause) => cause.status === 409);
  await hooks.complete();
  await assert.rejects(service.request('/api/local/restore', post({ backup: { schemaVersion: 1, materials: [record('123456789', '舞蹈', { rawMetrics: { metricEvidence: { likeCount: { value: '800', verified: true } } } })] } })));
  assert.equal((await service.request('/api/materials')).count, 0);
});
