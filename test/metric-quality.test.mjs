import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectChannelsMetricQuality, inspectDouyinMetricQuality, isSearchLeaderboardEligible, isStrictLeaderboardEligible, strictRejectionReason } from '../server/metric-quality.mjs';

test('只有热门筛选、详情AI声明与四项详情指标都验证成功才可进入抖音榜', () => {
  const candidate = {
    platform: 'douyin',
    likeCount: 100,
    favoriteCount: 20,
    commentCount: 10,
    shareCount: 5,
    aiDeclared: true,
    rawMetrics: { searchFilterVerified: true, detailAiDeclarationVerified: true, metricsVerified: true }
  };
  assert.equal(inspectDouyinMetricQuality(candidate).complete, true);
  assert.equal(isStrictLeaderboardEligible(candidate), true);
});

test('关闭AI限定时搜索榜只要求热门筛选生效且点赞为正', () => {
  const candidate = {
    platform: 'douyin', likeCount: 3680, favoriteCount: null, commentCount: null, shareCount: null,
    rawMetrics: { searchFilterVerified: true, aiVerificationSkipped: true }
  };
  assert.equal(isStrictLeaderboardEligible(candidate), false);
  assert.equal(isSearchLeaderboardEligible(candidate), true);
});

test('缺少收藏指标会进入待补采', () => {
  const candidate = {
    platform: 'douyin',
    likeCount: 100,
    favoriteCount: null,
    commentCount: 10,
    shareCount: 5,
    aiDeclared: true,
    rawMetrics: { searchFilterVerified: true, detailAiDeclarationVerified: true, metricsVerified: false }
  };
  assert.equal(isStrictLeaderboardEligible(candidate), false);
  assert.match(strictRejectionReason(candidate), /favoriteCount/);
});

test('没有确认详情页AI声明的抖音视频不进入正式榜', () => {
  const candidate = {
    platform: 'douyin',
    likeCount: 100,
    favoriteCount: 20,
    commentCount: 10,
    shareCount: 5,
    rawMetrics: { searchFilterVerified: true, metricsVerified: true }
  };
  assert.equal(isStrictLeaderboardEligible(candidate), false);
  assert.match(strictRejectionReason(candidate), /详情页.*疑似AI生成/);
});

test('只有搜索卡片AI标识、没有详情声明仍不能进入正式榜', () => {
  const candidate = {
    platform: 'douyin',
    likeCount: 100,
    favoriteCount: 20,
    commentCount: 10,
    shareCount: 5,
    platformAiBadge: true,
    rawMetrics: { searchFilterVerified: true, platformAiBadgeVerified: true, metricsVerified: true }
  };
  assert.equal(isStrictLeaderboardEligible(candidate), false);
});

test('视频号只有明确AI证据且公域喜欢分享点赞评论完整时才能进入榜单', () => {
  const candidate = {
    platform: 'channels',
    recommendCount: 2910,
    likeCount: 580,
    commentCount: 46,
    shareCount: 92,
    rawMetrics: { aiEvidenceVerified: true, aiEvidenceType: 'author_disclosure', metricsVerified: true }
  };
  assert.equal(inspectChannelsMetricQuality(candidate).complete, true);
  assert.equal(isStrictLeaderboardEligible(candidate), true);
});

test('视频号缺少分享指标或只有系统推断时不进入正式榜', () => {
  const missingMetric = {
    platform: 'channels', recommendCount: 2910, likeCount: 580, commentCount: 46, shareCount: null,
    rawMetrics: { aiEvidenceVerified: true, metricsVerified: false }
  };
  const inferredOnly = {
    platform: 'channels', recommendCount: 2910, likeCount: 580, commentCount: 46, shareCount: 92,
    rawMetrics: { aiEvidenceVerified: false, metricsVerified: true }
  };
  assert.equal(isStrictLeaderboardEligible(missingMetric), false);
  assert.match(strictRejectionReason(missingMetric), /shareCount/);
  assert.equal(isStrictLeaderboardEligible(inferredOnly), false);
  assert.match(strictRejectionReason(inferredOnly), /明确AI声明/);
});
