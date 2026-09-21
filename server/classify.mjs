const AI_PRODUCT_FEATURE_ONLY = /(?:AI|智能).{0,8}(?:早教机|故事机|监控器|摄像头|体温计|翻译|对话|陪伴机器人|学习机)(?!.*(?:生成|制作|广告|短片|动画|AIGC))/i;

const AI_RULES = [
  {
    type: '疑似 AI',
    pattern: /疑似\s*AI\s*生成/i,
    confidence: 0.94,
    label: '抖音详情页标注“疑似AI生成”'
  },
  {
    type: '全 AI 生成',
    pattern: /(?:作者声明[：:]?\s*内容由\s*AI\s*生成|全\s*AI|纯\s*AI|AI\s*生成(?:的)?(?:视频|短片|广告|动画|内容|画面)|#?AIGC\b(?:\s*(?:视频|短片|广告|动画|创作))?|#AI(?:生成|创作|广告)|AI品牌宣传片)/i,
    confidence: 0.97,
    label: '明确声明为AI生成内容'
  },
  {
    type: 'AI 数字人',
    pattern: /(?:AI\s*数字人|数字人讲解|虚拟人|虚拟主播|AI主播)/i,
    confidence: 0.93,
    label: '命中数字人/虚拟主播线索'
  },
  {
    type: 'AI 产品动画',
    pattern: /(?:AI.{0,8}(?:产品动画|产品广告|3D动画|结构演示|产品演示|商业广告|创意短片)|3D.{0,8}(?:动画|拆解|演示)|生成式动画)/i,
    confidence: 0.91,
    label: '命中AI产品动画/3D演示线索'
  },
  {
    type: 'AI 配音',
    pattern: /(?:AI\s*配音|合成音|机器配音|克隆声音|AI旁白)/i,
    confidence: 0.86,
    label: '命中AI配音线索'
  },
  {
    type: 'AI 辅助剪辑',
    pattern: /(?:AI\s*(?:创作|剪辑|特效|制作)|即梦|可灵|Sora|Runway|海螺|Seedance|剪映\s*AI).{0,16}(?:视频|广告|短片|动画|制作|案例)?/i,
    confidence: 0.82,
    label: '命中AI制作工具或辅助创作线索'
  }
];

const INTENT_RULES = [
  {
    type: '带货转化',
    pattern: /(?:购物车|小黄车|橱窗|直播间|到手价|券后|拍下|下单|链接|现货|限时|限量|买\s*\d|第二件|赠品|包邮|佣金|同款购买|店铺)/i,
    confidence: 0.94,
    label: '出现价格、购买入口或促销转化词'
  },
  {
    type: 'AI引流宣传',
    pattern: /(?:AI视频制作|AIGC制作|AI广告案例|商业广告案例|接单|代做|定制视频|私信|教程|工作流|提示词|课程|学员|同款怎么做|制作团队|创意工作室)/i,
    confidence: 0.91,
    label: '内容主要在推广AI制作能力、服务或教程'
  },
  {
    type: '种草测评',
    pattern: /(?:种草|测评|评测|开箱|实测|亲测|使用体验|好物分享|推荐|避坑|对比|清单|值不值得|回购|真实体验)/i,
    confidence: 0.88,
    label: '出现体验、推荐、测评或对比表达'
  },
  {
    type: '品牌AI宣传',
    pattern: /(?:品牌片|品牌宣传|官方发布|新品发布|全新上市|品牌故事|年度大片|概念广告|TVC|campaign|官宣)/i,
    confidence: 0.86,
    label: '出现品牌传播、新品发布或官方宣传表达'
  },
  {
    type: '产品功能演示',
    pattern: /(?:功能演示|结构演示|拆解|卖点|防胀气|恒温|消毒|折叠|减震|侧撞|材质|成分|容量|一键|实验证明|使用方法)/i,
    confidence: 0.84,
    label: '以产品结构、功能、成分或使用方式为核心'
  }
];

export function classifyAi(text = '') {
  const normalized = String(text).replace(/\s+/g, ' ');
  if (AI_PRODUCT_FEATURE_ONLY.test(normalized)) {
    return { type: '疑似 AI', confidence: 0.2, evidence: '只命中产品自带AI功能，未发现视频由AI制作的证据' };
  }
  for (const rule of AI_RULES) {
    if (rule.pattern.test(normalized)) {
      return { type: rule.type, confidence: rule.confidence, evidence: rule.label };
    }
  }
  if (/(动画|3D|数字人|虚拟主播|AI旁白)/i.test(normalized)) {
    return { type: '疑似 AI', confidence: 0.58, evidence: '存在生成式内容线索，但缺少明确AI制作声明' };
  }
  return { type: '疑似 AI', confidence: 0.35, evidence: '未发现平台AI标识或明确制作声明' };
}

export function classifyProduct(text = '', keywordGroups = {}) {
  const normalized = String(text).toLowerCase();
  let best = { group: '未分类', keyword: null, score: -1 };
  for (const [groupName, entries] of Object.entries(keywordGroups)) {
    for (const entry of entries) {
      const keyword = typeof entry === 'string' ? entry : entry.keyword;
      const enabled = typeof entry === 'string' ? true : entry.enabled !== false;
      if (!enabled || !keyword) continue;
      const index = normalized.indexOf(keyword.toLowerCase());
      if (index !== -1) {
        const score = keyword.length * 10 - Math.min(index, 100) / 100;
        if (score > best.score) best = { group: groupName, keyword, score };
      }
    }
  }
  return { group: best.group, productName: best.keyword, evidence: best.keyword ? `产品词命中：${best.keyword}` : '未命中产品词库' };
}

export function classifyContentIntent(text = '', { brandName = null } = {}) {
  const normalized = String(text).replace(/\s+/g, ' ');
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(normalized)) return { type: rule.type, confidence: rule.confidence, evidence: rule.label };
  }
  if (brandName && /(?:广告|宣传|大片|短片|新品|创意)/i.test(normalized)) {
    return { type: '品牌AI宣传', confidence: 0.78, evidence: '品牌明确，且内容具有广告或新品传播表达' };
  }
  if (/(?:AI|AIGC|生成|Seedance|即梦|可灵).{0,18}(?:创意|视觉|概念|短片|广告|大片|未来|科幻)/i.test(normalized)) {
    return { type: 'AI概念创意', confidence: 0.72, evidence: '以AI视觉或概念创意为主，未发现明确交易或服务引流词' };
  }
  return { type: '待判定', confidence: 0.45, evidence: '现有标题与详情不足以判断内容传播目的' };
}

export function enrichCollectedVideo(video, keywordGroups) {
  const contentText = [video.title, video.authorName, video.rawText, video.platformAiLabel].filter(Boolean).join(' ');
  const ai = classifyAi(contentText);
  const product = classifyProduct(contentText, keywordGroups);
  const intent = classifyContentIntent(contentText);
  return {
    ...video,
    title: video.title || video.rawText?.split('\n').find(Boolean) || '未命名视频',
    productGroup: product.group,
    aiType: ai.type,
    aiConfidence: ai.confidence,
    aiEvidence: `${ai.evidence}；${product.evidence}`,
    contentIntent: intent.type,
    intentConfidence: intent.confidence,
    intentEvidence: intent.evidence
  };
}
