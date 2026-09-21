import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatformAiLabel, hasPlatformAiBadge } from '../server/ai-badge.mjs';

test('识别抖音搜索卡片的疑似AI生成标识', () => {
  assert.equal(detectPlatformAiLabel('03:18\n疑似 AI 生成\n1.2万'), '疑似AI生成');
  assert.equal(hasPlatformAiBadge({ platformAiLabel: '疑似AI生成' }), true);
});

test('普通产品视频文案不会被当成平台AI标识', () => {
  assert.equal(detectPlatformAiLabel('防溢乳垫使用方法 AI品牌宣传片'), null);
  assert.equal(hasPlatformAiBadge({}), false);
});
