import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverDeepSeekConfigs, normalizeSuggestionPayload, parseDeepSeekEnv } from '../server/deepseek-keywords.mjs';

test('DeepSeek关键词按指定类别清洗、去重且总数不超过20', () => {
  const payload = {
    categories: [
      { label: '产品品类词', keywords: ['纸尿裤', '拉拉裤', '隔尿垫', '纸尿裤'] },
      { label: '品牌词', keywords: ['好奇', '帮宝适', '已有品牌'] },
      { label: '功能卖点词', keywords: Array.from({ length: 15 }, (_, index) => `卖点${index + 1}`) },
      { label: '人群场景词', keywords: ['新生儿', '夜用'] },
      { label: '无效类别', keywords: ['不应出现'] }
    ]
  };
  const result = normalizeSuggestionPayload(payload, '纸尿裤', ['已有品牌']);
  const keywords = result.categories.flatMap((group) => group.keywords);
  assert.ok(keywords.length <= 20);
  assert.equal(new Set(keywords).size, keywords.length);
  assert.ok(!keywords.includes('纸尿裤'));
  assert.ok(!keywords.includes('已有品牌'));
  assert.ok(!keywords.includes('不应出现'));
  assert.deepEqual(result.categories.map((group) => group.label), ['产品/品类词', '品牌/系列词', '需求/场景词']);
});

test('DeepSeek通用关键词类别支持非母婴行业', () => {
  const payload = {
    categories: [
      { label: '核心相关词', keywords: ['咖啡器具', '手冲咖啡'] },
      { label: '产品/品类词', keywords: ['咖啡机', '磨豆机'] },
      { label: '品牌/系列词', keywords: ['德龙咖啡机'] },
      { label: '需求/场景词', keywords: ['办公室咖啡', '居家咖啡'] }
    ]
  };
  const result = normalizeSuggestionPayload(payload, '咖啡', []);
  assert.equal(result.count, 7);
  assert.deepEqual(result.categories.map((group) => group.label), ['核心相关词', '产品/品类词', '品牌/系列词', '需求/场景词']);
});

test('DeepSeek会自动读取最近更新的本地env配置且不依赖网页输入', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maternal-deepseek-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const olderDir = path.join(root, 'older');
  const newerDir = path.join(root, 'newer');
  fs.mkdirSync(olderDir); fs.mkdirSync(newerDir);
  const older = path.join(olderDir, '.env.local');
  const newer = path.join(newerDir, '.env.local');
  fs.writeFileSync(older, 'DEEPSEEK_API_KEY=sk-old-test-key-1234567890\nDEEPSEEK_MODEL=deepseek-old\n');
  fs.writeFileSync(newer, 'DEEPSEEK_API_KEY="sk-new-test-key-1234567890"\nDEEPSEEK_MODEL=deepseek-new\n');
  fs.utimesSync(older, new Date('2026-01-01'), new Date('2026-01-01'));
  fs.utimesSync(newer, new Date('2026-01-02'), new Date('2026-01-02'));

  const configs = discoverDeepSeekConfigs(root);
  assert.equal(configs[0].model, 'deepseek-new');
  assert.equal(configs[0].persistence, 'local_env');
  assert.equal(parseDeepSeekEnv('export DEEPSEEK_API_KEY="sk-demo"').DEEPSEEK_API_KEY, 'sk-demo');
});
