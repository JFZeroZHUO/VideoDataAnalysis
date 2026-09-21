import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPageAttentionText } from '../server/verification.mjs';

test('识别抖音图片拖拽验证文案', () => {
  const result = detectPageAttentionText('在城市中能看到的场所 请选择所有符合上文描述的图片，并拖拽到下方 拖拽到这里 提交');
  assert.equal(result.requiresAttention, true);
  assert.equal(result.kind, 'verification');
});

test('可见验证码容器优先于普通结果内容', () => {
  const result = detectPageAttentionText('这里同时存在搜索结果链接', true);
  assert.equal(result.requiresAttention, true);
  assert.equal(result.kind, 'verification');
});

test('区分登录提示和普通页面', () => {
  assert.equal(detectPageAttentionText('扫码登录后即可查看完整内容').kind, 'login');
  assert.deepEqual(detectPageAttentionText('母婴用品 AI 创意视频 搜索结果'), {
    requiresAttention: false,
    kind: null,
    label: null
  });
});
