export const DOUYIN_REQUIRED_METRICS = ['likeCount', 'favoriteCount', 'commentCount', 'shareCount'];
export const CHANNELS_REQUIRED_METRICS = ['recommendCount', 'shareCount', 'likeCount', 'commentCount'];

export function inspectDouyinMetricQuality(candidate = {}) {
  const valuesComplete = DOUYIN_REQUIRED_METRICS.every((key) => Number.isFinite(candidate[key]) && candidate[key] >= 0);
  const verified = candidate.rawMetrics?.metricsVerified === true;
  const missing = DOUYIN_REQUIRED_METRICS.filter((key) => !Number.isFinite(candidate[key]) || candidate[key] < 0);
  const totalEngagement = DOUYIN_REQUIRED_METRICS.reduce((sum, key) => sum + (Number.isFinite(candidate[key]) ? candidate[key] : 0), 0);
  return {
    searchFilterVerified: candidate.rawMetrics?.searchFilterVerified === true,
    detailAiDeclarationVerified: candidate.aiDeclared === true && candidate.rawMetrics?.detailAiDeclarationVerified === true,
    verified,
    valuesComplete,
    complete: verified && valuesComplete,
    positive: Number(candidate.likeCount) > 0 && totalEngagement > 0,
    missing,
    totalEngagement
  };
}

export function inspectChannelsMetricQuality(candidate = {}) {
  const valuesComplete = CHANNELS_REQUIRED_METRICS.every((key) => Number.isFinite(candidate[key]) && candidate[key] >= 0);
  const verified = candidate.rawMetrics?.metricsVerified === true;
  const missing = CHANNELS_REQUIRED_METRICS.filter((key) => !Number.isFinite(candidate[key]) || candidate[key] < 0);
  const totalEngagement = ['likeCount', 'favoriteCount', 'commentCount', 'shareCount', 'recommendCount']
    .reduce((sum, key) => sum + (Number.isFinite(candidate[key]) ? candidate[key] : 0), 0);
  return {
    aiEvidenceVerified: candidate.rawMetrics?.aiEvidenceVerified === true,
    verified,
    valuesComplete,
    complete: verified && valuesComplete,
    positive: totalEngagement > 0 && (Number(candidate.recommendCount) > 0 || Number(candidate.likeCount) > 0),
    missing,
    totalEngagement
  };
}

export function isStrictLeaderboardEligible(candidate = {}) {
  if (candidate.platform === 'channels') {
    const quality = inspectChannelsMetricQuality(candidate);
    return quality.aiEvidenceVerified && quality.complete && quality.positive;
  }
  if (candidate.platform !== 'douyin') return true;
  const quality = inspectDouyinMetricQuality(candidate);
  return quality.searchFilterVerified && quality.detailAiDeclarationVerified && quality.complete && quality.positive;
}

export function isSearchLeaderboardEligible(candidate = {}) {
  if (candidate.platform === 'channels') {
    return candidate.rawMetrics?.searchFilterVerified === true &&
      (Number(candidate.recommendCount) > 0 || Number(candidate.likeCount) > 0);
  }
  if (candidate.platform === 'douyin') {
    return candidate.rawMetrics?.searchFilterVerified === true && Number(candidate.likeCount) > 0;
  }
  return Number(candidate.likeCount) > 0;
}

export function strictRejectionReason(candidate = {}) {
  if (candidate.platform === 'channels') {
    const quality = inspectChannelsMetricQuality(candidate);
    if (!quality.aiEvidenceVerified) return '未捕获平台AI声明或作者明确AI声明';
    if (!quality.complete) return `视频号公域详情指标不完整：${quality.missing.join(', ') || '缺少验证证据'}`;
    if (!quality.positive) return '喜欢/推荐与点赞均为0，或互动总量为0';
    return null;
  }
  const quality = inspectDouyinMetricQuality(candidate);
  if (!quality.searchFilterVerified) return '抖音原生热门筛选未确认生效';
  if (!quality.detailAiDeclarationVerified) return '视频详情页未确认“疑似AI生成”声明';
  if (!quality.complete) return `详情指标不完整：${quality.missing.join(', ') || '缺少验证证据'}`;
  if (!quality.positive) return '点赞为0或互动总量为0';
  return null;
}
