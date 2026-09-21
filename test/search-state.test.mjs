import test from 'node:test';
import assert from 'node:assert/strict';
import { DOUYIN_SEARCH_STATE_KEY, defaultMaterialFilters, filtersForAiMode, materialRequestParams,
  normalizeSearchState, readStoredDouyinSearchState, storeDouyinSearchState } from '../src/search-state.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('无设置及旧版仅存关键词时默认普通热门模式，舞蹈无需AI及完整指标', () => {
  assert.equal(readStoredDouyinSearchState().requireAiEvidence, false);
  const storage = memoryStorage();
  storage.setItem(DOUYIN_SEARCH_STATE_KEY, JSON.stringify({ keywords: ['舞蹈'], resultScope: 'current' }));
  const state = readStoredDouyinSearchState(storage);
  assert.equal(state.exists, true);
  assert.equal(state.requireAiEvidence, false);
  const request = materialRequestParams('douyin', state.filters, state.keywords, state.resultScope);
  assert.equal(request.aiEvidence, 'all');
  assert.equal(request.quality, 'all');
  assert.equal(request.queryTerms, '["舞蹈"]');
});

test('从旧AI筛选关闭开关立即解除AI类型、证据和完整指标限制', () => {
  const next = filtersForAiMode({ ...defaultMaterialFilters(true), aiType: 'AI数字人', quality: 'ready' }, false);
  assert.equal(next.aiEvidence, 'all');
  assert.equal(next.quality, 'all');
  assert.equal(next.aiType, 'all');
  assert.equal(filtersForAiMode(next, true).aiEvidence, 'verified');
});

test('刷新保留关键词、AI模式、发布时间、展示范围及手工筛选', () => {
  const storage = memoryStorage();
  for (const enabled of [false, true]) {
    for (const scope of ['current', 'history']) {
      const state = normalizeSearchState({ keywords: ['舞蹈', '汽车'], requireAiEvidence: enabled,
        timeRange: 'one_week', resultScope: scope, filters: { ...defaultMaterialFilters(enabled), sort: 'commentCount', direction: 'asc', quality: 'metrics_partial' } });
      storeDouyinSearchState(storage, state);
      assert.deepEqual(readStoredDouyinSearchState(storage), { ...state, exists: true });
    }
  }
});

test('当前关键词只使用原词，切历史范围才取消来源词过滤', () => {
  const filters = defaultMaterialFilters(false);
  assert.equal(materialRequestParams('douyin', filters, ['舞蹈'], 'current').queryTerms, '["舞蹈"]');
  assert.equal(materialRequestParams('douyin', filters, ['舞蹈'], 'history').queryTerms, undefined);
  assert.equal(materialRequestParams('channels', filters, ['舞蹈'], 'current').queryTerms, undefined);
});

test('损坏或受限的本地存储不会使网页崩溃', () => {
  const storage = memoryStorage();
  storage.setItem(DOUYIN_SEARCH_STATE_KEY, '{broken');
  assert.equal(readStoredDouyinSearchState(storage).exists, false);
  assert.doesNotThrow(() => storeDouyinSearchState({ setItem() { throw new Error('blocked'); } }, {}));
});
