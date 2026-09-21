import test from 'node:test';
import assert from 'node:assert/strict';
import { DOUYIN_TIME_RANGE_LABELS, normalizeDouyinTimeRange } from '../server/douyin-search-filter.mjs';

test('抖音发布时间选项映射到页面文案', () => {
  assert.equal(DOUYIN_TIME_RANGE_LABELS.one_week, '一周内');
  assert.equal(DOUYIN_TIME_RANGE_LABELS.half_year, '半年内');
  assert.equal(normalizeDouyinTimeRange('one_day'), 'one_day');
  assert.equal(normalizeDouyinTimeRange('invalid'), 'half_year');
});
