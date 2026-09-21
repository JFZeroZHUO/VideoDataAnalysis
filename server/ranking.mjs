import { classifyAi, classifyContentIntent, classifyProduct } from './classify.mjs';
import { BRAND_CATALOG } from './domain-rules.mjs';
import { isSearchLeaderboardEligible, isStrictLeaderboardEligible } from './metric-quality.mjs';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const brandRules = BRAND_CATALOG.map((brand) => {
  const names = [brand.name, ...(brand.aliases || [])].filter(Boolean).sort((a, b) => b.length - a.length);
  return [brand.name, new RegExp(`(?:${names.map(escapeRegExp).join('|')})`, 'i')];
});

const commercialPattern = /(?:产品|广告|好物|推荐|种草|测评|评测|开箱|体验|使用|教程|功能|卖点|对比|囤货|神器|新品|升级|材质|清洗|消毒|恒温|防胀气|上市)/i;
const productInnovationPattern = /(?:智能|未来|设计|结构|轻便|折叠|高景观|双向|减震|防护|防雨|防晒|一键|容量|温控|恒温|实测)/i;
const narrativePattern = /(?:漫剧|短剧|小说|穿越|求生|第\s*\d+\s*集|剧情|团宠|霸总|重生|合集|连续剧)/i;
const falseProductPattern = /(?:奶瓶糖|奶瓶机器人|奶瓶道具|婴儿车.{0,8}(?:求生|穿越|漫剧|小说))/i;

function classifyMarketingSignals(text = '', video = {}) {
  const rules = [
    ['价格利益钩子', /(?:到手|低至|只要|不到|百元|省钱|一个价|买\d|第[二2]件|限时|券后|\d+\s*元)/i],
    ['痛点警示钩子', /(?:别再|千万别|避坑|踩雷|伤娃|后悔|危险|注意|不做|拒绝)/i],
    ['对比测评钩子', /(?:对比|横评|测评|实测|PK|真香|踩雷|哪款|怎么选)/i],
    ['结果承诺钩子', /(?:省力|透气|防漏|不红屁屁|睡整觉|轻便|一秒|一步|解决|提升)/i],
    ['知识教程钩子', /(?:必看|教程|方法|攻略|指南|一次说清|看懂|科普)/i],
    ['好奇发现钩子', /(?:才发现|挖到|没想到|居然|原来|新手妈妈看过来)/i]
  ];
  const hookType = rules.find(([, pattern]) => pattern.test(text))?.[0] || '弱钩子';
  const ctaRules = [
    ['立即购买', /(?:购物车|小黄车|橱窗|下单|拍下|同款购买|券后)/i],
    ['直播承接', /(?:直播间|今晚直播|进直播|蹲直播)/i],
    ['评论互动', /(?:评论区|评论告诉|扣\s*[123]|留言)/i],
    ['私域引流', /(?:私信|加我|进群|领取资料|免费领取)/i],
    ['关注收藏', /(?:关注|收藏|转发|码住|点赞)/i]
  ];
  const ctaType = ctaRules.find(([, pattern]) => pattern.test(text))?.[0] || '无明确CTA';
  const formatRules = [
    ['对比测评', /(?:对比|横评|测评|评测|实测|PK)/i],
    ['好物种草', /(?:种草|好物|推荐|真香|回购|体验)/i],
    ['产品演示', /(?:使用方法|功能演示|结构|拆解|开箱|操作|防漏|承重)/i],
    ['知识口播', /(?:科普|攻略|指南|一次说清|怎么选|必看)/i],
    ['生活Vlog', /(?:vlog|日常|月子碎片|带娃日记)/i],
    ['品牌创意片', /(?:品牌片|TVC|概念片|新品发布|品牌故事|创意短片)/i]
  ];
  const creativeFormat = formatRules.find(([, pattern]) => pattern.test(text))?.[0] ||
    (video.aiDeclared ? 'AI原生短片' : '其他');
  const audienceRules = [
    ['孕产妈妈', /(?:孕妇|孕期|待产|产妇|月子|产后)/i],
    ['新生儿家庭', /(?:新生儿|NB码|0[-—~]3月|满月)/i],
    ['新手父母', /(?:新手妈妈|新手爸爸|新手爸妈|宝妈)/i],
    ['学步期家庭', /(?:学步|遛娃|幼儿|一岁|两岁|腰凳)/i],
    ['儿童家庭', /(?:儿童|宝宝|婴儿|孩子)/i]
  ];
  const targetAudience = audienceRules.find(([, pattern]) => pattern.test(text))?.[0] || '泛消费人群';
  const sellingPointRules = [
    ['安全防护', /(?:安全|防撞|侧防|认证|防护|稳固)/i],
    ['舒适体验', /(?:透气|柔软|舒适|亲肤|不闷|省力)/i],
    ['功能效率', /(?:一键|恒温|消毒|智能|折叠|轻便|快速)/i],
    ['价格利益', /(?:实惠|划算|低至|到手|百元|一个价|省钱)/i],
    ['成分材质', /(?:成分|材质|无添加|棉柔|有机|食品级)/i],
    ['专业可信', /(?:测评|实测|认证|医生|专家|数据)/i]
  ];
  const sellingPoints = sellingPointRules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const likes = Math.max(Number(video.likeCount) || 0, 1);
  const deepRate = ((Number(video.favoriteCount) || 0) + (Number(video.commentCount) || 0) * 1.5 + (Number(video.shareCount) || 0) * 2) / likes;
  const marketingScore = Math.min(100, Math.round(
    (hookType === '弱钩子' ? 4 : 20) +
    (ctaType === '无明确CTA' ? 2 : 12) +
    Math.min(sellingPoints.length * 7, 21) +
    (creativeFormat === '其他' ? 4 : 12) +
    Math.min(deepRate * 20, 20) + 15
  ));
  return { hookType, ctaType, creativeFormat, targetAudience, sellingPoints, marketingScore };
}

export function detectBrand(text = '') {
  const matched = brandRules.find(([, pattern]) => pattern.test(String(text)));
  return matched ? matched[0] : null;
}

function interactionValue(video) {
  if (video.platform === 'xiaohongshu') {
    return (video.likeCount || 0) + (video.favoriteCount || 0) * 2.6 + (video.commentCount || 0) * 2 + (video.shareCount || 0) * 2.4;
  }
  if (video.platform === 'channels') {
    return (video.viewCount || 0) + (video.likeCount || 0) * 7 + (video.recommendCount || 0) * 8 +
      (video.commentCount || 0) * 11 + (video.shareCount || 0) * 14;
  }
  return (video.viewCount || 0) + (video.likeCount || 0) * 7 + (video.favoriteCount || 0) * 9 +
    (video.commentCount || 0) * 12 + (video.shareCount || 0) * 15;
}

function publishedAgeHours(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/刚刚/.test(text)) return 0.25;
  const relative = text.match(/(\d+(?:\.\d+)?)\s*(分钟|小时|天|周|月|年)前/);
  if (relative) {
    const multipliers = { 分钟: 1 / 60, 小时: 1, 天: 24, 周: 168, 月: 720, 年: 8760 };
    return Number(relative[1]) * multipliers[relative[2]];
  }
  const normalized = text
    .replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '')
    .replace(/[./]/g, '-');
  const hasYear = /^\d{4}-/.test(normalized);
  const date = new Date(hasYear ? normalized : `${new Date(now).getFullYear()}-${normalized}`);
  if (Number.isNaN(date.getTime())) return null;
  let age = (now - date.getTime()) / 3_600_000;
  if (age < -24 * 30 && !hasYear) {
    date.setFullYear(date.getFullYear() - 1);
    age = (now - date.getTime()) / 3_600_000;
  }
  return Math.max(0.25, age);
}

export function analyzeCandidate(video, keywordGroups) {
  const title = String(video.title || '');
  const authorText = String(video.authorName || '');
  const sourceText = String(video.rawMetrics?.sourceText || (video.platform === 'douyin' ? '' : video.rawText || ''));
  const productText = [title, authorText, sourceText].filter(Boolean).join(' ');
  const contentText = [
    productText,
    video.platformAiLabel ? `平台标识：${video.platformAiLabel}` : '',
    video.aiDeclared ? '作者声明内容由 AI 生成' : ''
  ].filter(Boolean).join(' ');
  const queryKeyword = String(video.queryKeyword || video.rawMetrics?.queryKeyword || '').trim();
  const queryGroup = String(video.queryGroup || video.rawMetrics?.queryGroup || '').trim();
  const queryLane = String(video.queryLane || video.rawMetrics?.queryLane || '').trim();
  const queryKeywordConfirmed = Boolean(queryKeyword && productText.toLowerCase().includes(queryKeyword.toLowerCase()));
  const dictionaryProduct = classifyProduct(productText, keywordGroups);
  const product = queryKeywordConfirmed && queryGroup && !queryGroup.startsWith('搜索主题 · ')
    ? { group: queryGroup, productName: queryKeyword, evidence: `搜索产品词与标题/卡片正文共同命中：${queryKeyword}` }
    : dictionaryProduct.group !== '未分类'
      ? dictionaryProduct
      : queryLane === 'user_keyword' && queryKeyword
        ? {
            group: queryGroup || `搜索主题 · ${queryKeyword}`,
            productName: queryKeyword,
            evidence: queryKeywordConfirmed
              ? `用户指定搜索词与标题/卡片正文共同命中：${queryKeyword}`
              : `来自用户明确指定的搜索主题：${queryKeyword}`
          }
        : dictionaryProduct;
  // 品牌和产品只使用搜索卡片正文、标题与作者，避免详情页相关推荐污染分类。
  const brandName = detectBrand(productText);
  const aiEvidenceType = video.rawMetrics?.aiEvidenceType;
  const ai = video.aiDeclared
    ? {
        type: '全 AI 生成',
        confidence: aiEvidenceType === 'author_disclosure' ? 0.96 : 0.99,
        evidence: aiEvidenceType === 'author_disclosure'
          ? `作者文案明确声明：${video.platformAiLabel || '内容使用AI创作'}`
          : `平台原生标注：${video.platformAiLabel || '内容由AI生成'}`
      }
    : classifyAi(contentText);
  const intent = classifyContentIntent(contentText, { brandName });
  const marketing = classifyMarketingSignals(productText, video);
  const productInTitle = Boolean(product.productName && title.toLowerCase().includes(product.productName.toLowerCase()));
  const brandInTitle = Boolean(brandName && title.toLowerCase().includes(brandName.toLowerCase()));

  let relevanceScore = 0;
  if (product.group !== '未分类') relevanceScore += productInTitle ? 34 : 20;
  if (brandName) relevanceScore += brandInTitle ? 16 : 12;
  if (commercialPattern.test(contentText)) relevanceScore += 10;
  if (intent.type !== '待判定') relevanceScore += Math.round(intent.confidence * 10);
  if (ai.confidence >= 0.95) relevanceScore += 28;
  else if (ai.confidence >= 0.9) relevanceScore += 24;
  else if (ai.confidence >= 0.8) relevanceScore += 19;
  if (video.aiDeclared) relevanceScore += 4;
  if (narrativePattern.test(contentText)) relevanceScore -= 42;
  if (falseProductPattern.test(contentText)) relevanceScore -= 58;
  relevanceScore = Math.max(0, Math.min(100, relevanceScore));

  const productIntent = intent.type !== '待判定' || commercialPattern.test(contentText) || productInnovationPattern.test(contentText);
  return {
    ...video,
    productGroup: product.group,
    productName: product.productName,
    brandName,
    aiType: ai.type,
    aiConfidence: ai.confidence,
    aiEvidence: `${ai.evidence}；${product.evidence}${brandName ? `；品牌命中：${brandName}` : '；品牌未明确'}`,
    contentIntent: intent.type,
    intentConfidence: intent.confidence,
    intentEvidence: intent.evidence,
    creativeFormat: marketing.creativeFormat,
    hookType: marketing.hookType,
    ctaType: marketing.ctaType,
    targetAudience: marketing.targetAudience,
    sellingPoints: marketing.sellingPoints,
    marketingScore: marketing.marketingScore,
    materialStatus: video.rawMetrics?.metricsVerified === true ? 'ready' : 'metrics_partial',
    relevanceScore,
    interactionValue: interactionValue(video),
    ageHours: publishedAgeHours(video.publishedAt),
    eligible: product.group !== '未分类' && ai.confidence >= 0.72 && relevanceScore >= 60 && productIntent
  };
}

function percentile(value, values) {
  if (value === null || value === undefined || !values.length) return null;
  if (values.length === 1) return 100;
  const lower = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return ((lower + Math.max(equal - 1, 0) / 2) / (values.length - 1)) * 100;
}

function metricWeights(platform) {
  if (platform === 'xiaohongshu') return { likeCount: 0.30, favoriteCount: 0.40, commentCount: 0.15, shareCount: 0.15 };
  if (platform === 'channels') return { viewCount: 0.40, likeCount: 0.20, recommendCount: 0.15, commentCount: 0.10, shareCount: 0.15 };
  return { viewCount: 0.25, likeCount: 0.35, favoriteCount: 0.18, commentCount: 0.10, shareCount: 0.12 };
}

function scoreMetrics(candidate, distributions) {
  const weights = metricWeights(candidate.platform);
  let sum = 0;
  let used = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (candidate[key] === null || candidate[key] === undefined || !distributions[key]?.length) continue;
    const score = percentile(Math.log1p(candidate[key]), distributions[key]);
    sum += score * weight;
    used += weight;
  }
  return used ? sum / used : 0;
}

function deepEngagementValue(candidate) {
  const likes = Math.max(candidate.likeCount || 0, 1);
  if (candidate.platform === 'xiaohongshu') {
    return ((candidate.favoriteCount || 0) * 1.5 + (candidate.commentCount || 0) * 2 + (candidate.shareCount || 0) * 2.5) / likes;
  }
  return ((candidate.favoriteCount || 0) + (candidate.commentCount || 0) * 2 + (candidate.shareCount || 0) * 3) / likes;
}

function performanceLabel(score, sampleSize) {
  if (sampleSize < 5) return '样本不足';
  if (score >= 85) return '爆款';
  if (score >= 70) return '高表现';
  if (score >= 55) return '值得关注';
  return '一般';
}

function selectDiverse(sorted, topN) {
  const selected = [];
  const selectedUrls = new Set();
  const brandCounts = new Map();
  const groupCounts = new Map();
  const authorCounts = new Map();
  for (const candidate of sorted) {
    const brandCount = candidate.brandName ? brandCounts.get(candidate.brandName) || 0 : 0;
    const groupCount = groupCounts.get(candidate.productGroup) || 0;
    const authorCount = candidate.authorName ? authorCounts.get(candidate.authorName) || 0 : 0;
    if (brandCount >= 2 || groupCount >= 4 || authorCount >= 2) continue;
    selected.push(candidate);
    selectedUrls.add(candidate.sourceUrl);
    if (candidate.brandName) brandCounts.set(candidate.brandName, brandCount + 1);
    groupCounts.set(candidate.productGroup, groupCount + 1);
    if (candidate.authorName) authorCounts.set(candidate.authorName, authorCount + 1);
    if (selected.length >= topN) return selected;
  }
  for (const candidate of sorted) {
    if (selectedUrls.has(candidate.sourceUrl)) continue;
    selected.push(candidate);
    if (selected.length >= topN) break;
  }
  return selected;
}

export function rankCandidates(candidates, keywordGroups, topN = 20, options = {}) {
  const requireAiEvidence = options.requireAiEvidence !== false;
  const analyzed = candidates
    .map((candidate) => analyzeCandidate(candidate, keywordGroups))
    .filter((candidate) => requireAiEvidence
      ? candidate.eligible && candidate.relevanceScore >= 70 && isStrictLeaderboardEligible(candidate)
      : candidate.productGroup !== '未分类' && candidate.relevanceScore >= 30 && isSearchLeaderboardEligible(candidate));
  const weightKeys = new Set(analyzed.flatMap((candidate) => Object.keys(metricWeights(candidate.platform))));
  const distributions = {};
  for (const key of weightKeys) {
    distributions[key] = analyzed
      .map((candidate) => candidate[key])
      .filter((value) => value !== null && value !== undefined)
      .map((value) => Math.log1p(value));
  }
  const velocityDistribution = analyzed
    .filter((candidate) => candidate.ageHours !== null)
    .map((candidate) => Math.log1p(candidate.interactionValue / Math.pow(Math.max(candidate.ageHours, 6), 0.65)));
  const deepDistribution = analyzed.map(deepEngagementValue);

  const scored = analyzed.map((candidate) => {
    const basePerformance = scoreMetrics(candidate, distributions);
    const velocityValue = candidate.ageHours === null
      ? null
      : Math.log1p(candidate.interactionValue / Math.pow(Math.max(candidate.ageHours, 6), 0.65));
    const velocityScore = percentile(velocityValue, velocityDistribution);
    const deepScore = percentile(deepEngagementValue(candidate), deepDistribution) || 0;
    const components = [
      { value: basePerformance, weight: 0.72 },
      { value: velocityScore, weight: 0.18 },
      { value: deepScore, weight: 0.10 }
    ].filter((component) => component.value !== null);
    const performanceScore = components.reduce((sum, component) => sum + component.value * component.weight, 0) /
      components.reduce((sum, component) => sum + component.weight, 0);
    const rankingScore = requireAiEvidence
      ? performanceScore * 0.75 + candidate.aiConfidence * 100 * 0.15 + candidate.intentConfidence * 100 * 0.10
      : performanceScore * 0.85 + candidate.intentConfidence * 100 * 0.15;
    const { eligible, interactionValue: _interactionValue, ageHours: _ageHours, ...video } = candidate;
    return {
      ...video,
      popularityScore: Math.round(performanceScore * 10) / 10,
      performanceLabel: performanceLabel(performanceScore, analyzed.length),
      rankingScore: Math.round(rankingScore * 10) / 10
    };
  }).sort((a, b) => b.rankingScore - a.rankingScore || (b.likeCount || 0) - (a.likeCount || 0));

  return selectDiverse(scored, topN).map((candidate, index) => ({ ...candidate, rankPosition: index + 1 }));
}
