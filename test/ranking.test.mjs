import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandidate, rankCandidates } from '../server/ranking.mjs';

const groups = {
  喂养: [{ keyword: '奶瓶', enabled: true }, { keyword: '调奶器', enabled: true }],
  出行: [{ keyword: '婴儿车', enabled: true }]
};

function verifiedDouyinMetrics(overrides = {}) {
  return {
    likeCount: 1200,
    favoriteCount: 80,
    commentCount: 30,
    shareCount: 20,
    platformAiBadge: true,
    platformAiLabel: '疑似AI生成',
    aiDeclared: true,
    rawMetrics: { searchFilterVerified: true, detailAiDeclarationVerified: true, metricsVerified: true },
    ...overrides
  };
}

test('明确产品、品牌和 AI 证据获得高相关性', () => {
  const result = analyzeCandidate({
    platform: 'douyin',
    title: '贝亲奶瓶 AI 产品广告：防胀气结构演示',
    rawText: '#AIGC #母婴好物 #产品测评',
    likeCount: 1200
  }, groups);
  assert.equal(result.productName, '奶瓶');
  assert.equal(result.brandName, '贝亲');
  assert.ok(result.relevanceScore >= 85);
  assert.equal(result.eligible, true);
});

test('产品词候选可凭详情页AI声明进入后续判断', () => {
  const result = analyzeCandidate({
    platform: 'douyin',
    title: '防溢乳垫使用方法与贴合演示',
    platformAiBadge: true,
    platformAiLabel: '疑似AI生成',
    aiDeclared: true,
    rawText: '疑似AI生成 防溢乳垫使用方法'
  }, { 孕产护理: [{ keyword: '防溢乳垫', enabled: true }] });
  assert.equal(result.productName, '防溢乳垫');
  assert.equal(result.aiType, '全 AI 生成');
  assert.equal(result.eligible, true);
});

test('偶然包含产品词的 AI 漫剧不会进入产品榜', () => {
  const result = analyzeCandidate({
    platform: 'douyin',
    title: '穿越公路求生：我的婴儿车能升级',
    rawText: '#AI漫剧 #小说 #第12集',
    likeCount: 99999
  }, groups);
  assert.equal(result.eligible, false);
});

test('榜单只返回指定 Top 数量并写入名次', () => {
  const candidates = Array.from({ length: 25 }, (_, index) => ({
    platform: 'douyin',
    sourceUrl: `https://example.com/${index}`,
    title: `贝亲奶瓶 AI 产品广告 ${index}`,
    rawText: '#AIGC #母婴好物 #产品测评',
    ...verifiedDouyinMetrics({ likeCount: (index + 1) * 100 })
  }));
  const ranked = rankCandidates(candidates, groups, 15);
  assert.equal(ranked.length, 15);
  assert.equal(ranked[0].rankPosition, 1);
  assert.equal(ranked.at(-1).rankPosition, 15);
});

test('严格抖音榜淘汰指标缺失、未验证筛选和零点赞内容', () => {
  const base = {
    platform: 'douyin',
    title: '贝亲奶瓶 AI 产品广告：防胀气结构演示',
    rawText: '#AIGC #母婴好物 #产品测评'
  };
  const ranked = rankCandidates([
    { ...base, sourceUrl: 'https://example.com/valid', ...verifiedDouyinMetrics() },
    { ...base, sourceUrl: 'https://example.com/missing', likeCount: 9999, rawMetrics: { searchFilterVerified: true, metricsVerified: false } },
    { ...base, sourceUrl: 'https://example.com/unfiltered', ...verifiedDouyinMetrics({ rawMetrics: { metricsVerified: true } }) },
    { ...base, sourceUrl: 'https://example.com/zero', ...verifiedDouyinMetrics({ likeCount: 0 }) }
  ], groups, 20);
  assert.deepEqual(ranked.map((candidate) => candidate.sourceUrl), ['https://example.com/valid']);
});

test('关闭AI限定后可按搜索页点赞生成热门榜且不要求AI声明', () => {
  const candidates = [{
    platform: 'douyin', sourceUrl: 'https://example.com/search-only', title: '贝亲奶瓶防胀气使用演示',
    rawText: '#母婴好物 #奶瓶测评', likeCount: 8600,
    rawMetrics: { searchFilterVerified: true, aiVerificationSkipped: true }
  }];
  const ranked = rankCandidates(candidates, groups, 20, { requireAiEvidence: false });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sourceUrl, 'https://example.com/search-only');
});

test('品牌不从详情页相关推荐中误判', () => {
  const result = analyzeCandidate({
    platform: 'douyin',
    title: '智能跟随婴儿车 AI 功能演示',
    authorName: '未来产品实验室',
    rawText: '相关推荐：Babycare新品广告',
    likeCount: 300
  }, groups);
  assert.equal(result.brandName, null);
});

test('产品分类不受详情页推荐词污染，并优先采用已确认的搜索品类', () => {
  const result = analyzeCandidate({
    platform: 'douyin',
    title: '带娃出门终于不累腰了，这款腰凳真的省力',
    authorName: '新手爸爸实验室',
    rawText: '详情页相关推荐：口水巾 童装 隔尿垫 奶瓶',
    rawMetrics: {
      sourceText: '腰凳承重实测，单手抱娃也稳',
      queryKeyword: '腰凳',
      queryGroup: '童车出行',
      detailAiDeclarationVerified: true,
      metricsVerified: true
    },
    platformAiBadge: true,
    platformAiLabel: '疑似AI生成',
    aiDeclared: true,
    likeCount: 3200,
    favoriteCount: 410,
    commentCount: 93,
    shareCount: 167
  }, { 童车出行: [{ keyword: '腰凳', enabled: true }], 喂养: [{ keyword: '奶瓶', enabled: true }] });
  assert.equal(result.productGroup, '童车出行');
  assert.equal(result.productName, '腰凳');
  assert.equal(result.materialStatus, 'ready');
  assert.ok(result.marketingScore > 0);
});

test('AI 功能产品不等于 AI 制作视频', () => {
  const result = analyzeCandidate({
    platform: 'douyin',
    title: 'AI智能早教机，自带网络实时翻译和对话',
    rawText: '#英语启蒙 #AI早教机 #产品推荐',
    likeCount: 300
  }, groups);
  assert.equal(result.eligible, false);
});

test('用户指定的非母婴搜索主题可以正常归类并进入热榜', () => {
  const candidate = {
    platform: 'douyin',
    sourceUrl: 'https://example.com/coffee',
    title: '咖啡机 AI 创意广告：一分钟完成办公室拿铁',
    queryKeyword: '咖啡机',
    queryGroup: '搜索主题 · 咖啡机',
    queryLane: 'user_keyword',
    ...verifiedDouyinMetrics({ likeCount: 6800 })
  };
  const analyzed = analyzeCandidate(candidate, groups);
  assert.equal(analyzed.productGroup, '搜索主题 · 咖啡机');
  assert.equal(analyzed.productName, '咖啡机');
  assert.equal(analyzed.targetAudience, '泛消费人群');
  assert.equal(rankCandidates([candidate], groups, 20).length, 1);
});
