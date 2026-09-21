import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLabeledMetric, parseCompactNumber } from '../server/number-utils.mjs';

test('解析中文缩写数值', () => {
  assert.equal(parseCompactNumber('4.82万'), 48200);
  assert.equal(parseCompactNumber('1.2亿'), 120000000);
  assert.equal(parseCompactNumber('3.1k'), 3100);
});

test('解析指标在数值前后的两种文本', () => {
  assert.equal(extractLabeledMetric('点赞 2.3万', ['点赞']), 23000);
  assert.equal(extractLabeledMetric('1.8万 评论', ['评论']), 18000);
});
