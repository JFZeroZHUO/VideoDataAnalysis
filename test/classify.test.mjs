import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAi, classifyContentIntent, classifyProduct, enrichCollectedVideo } from '../server/classify.mjs';

const groups = {
  '喂养': [{ keyword: '奶瓶', enabled: true }, { keyword: '奶嘴', enabled: true }],
  '出行与睡眠': [{ keyword: '安全座椅', enabled: true }]
};

test('识别 AI 数字人类型', () => {
  const result = classifyAi('AI 数字人讲解奶嘴月龄');
  assert.equal(result.type, 'AI 数字人');
  assert.ok(result.confidence >= 0.9);
});

test('详情页“疑似AI生成”声明可作为高可信AI候选证据', () => {
  const result = classifyAi('平台标识：疑似AI生成');
  assert.equal(result.type, '疑似 AI');
  assert.ok(result.confidence >= 0.9);
  assert.match(result.evidence, /抖音详情页/);
});

test('优先命中更具体的产品关键词', () => {
  const result = classifyProduct('安全座椅侧撞结构 AI 动画', groups);
  assert.equal(result.group, '出行与睡眠');
});

test('采集记录能补全产品组和 AI 类型', () => {
  const result = enrichCollectedVideo({
    title: '奶瓶材质 AI 3D 动画',
    platform: 'douyin',
    sourceUrl: 'https://example.com/video/1'
  }, groups);
  assert.equal(result.productGroup, '喂养');
  assert.equal(result.aiType, 'AI 产品动画');
});

test('区分带货转化与AI制作服务引流', () => {
  assert.equal(classifyContentIntent('点击购物车领取优惠券，到手价只要99').type, '带货转化');
  assert.equal(classifyContentIntent('母婴AI广告案例，想做同款可私信定制').type, 'AI引流宣传');
});
