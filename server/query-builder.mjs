import { PRODUCT_TAXONOMY, getBrandsForGroup } from './domain-rules.mjs';

function enabledKeywords(entries = []) {
  return entries
    .filter((entry) => typeof entry === 'string' || entry.enabled !== false)
    .map((entry) => typeof entry === 'string' ? entry : entry.keyword)
    .map((keyword) => String(keyword || '').trim())
    .filter(Boolean);
}

function orderedGroups(keywordGroups) {
  const taxonomyOrder = new Map(PRODUCT_TAXONOMY.map((item, index) => [item.group, { index, priority: item.priority }]));
  return Object.entries(keywordGroups)
    .map(([groupName, entries]) => ({
      groupName,
      products: enabledKeywords(entries),
      priority: taxonomyOrder.get(groupName)?.priority || 50,
      order: taxonomyOrder.get(groupName)?.index ?? 999
    }))
    .filter((group) => group.products.length)
    .sort((a, b) => b.priority - a.priority || a.order - b.order || a.groupName.localeCompare(b.groupName, 'zh-CN'));
}

function makeSpec({ query, keyword = null, groupName = null, brandName = null, lane, aiCue = null, aiTargeted = false }) {
  return {
    query,
    keyword,
    groupName,
    brandName,
    lane,
    aiCue,
    aiTargeted
  };
}

// 抖音只使用宽品类入口召回，具体产品与品牌留到结果页和详情页识别。
// generic=true 表示它是品类概念而非具体产品词，不能直接拿来给视频定产品名。
const DOUYIN_BROAD_CATEGORIES = [
  { groupName: '奶瓶与母乳喂养', term: '奶瓶', keyword: '奶瓶' },
  { groupName: '纸尿裤与日常护理', term: '纸尿裤', keyword: '纸尿裤' },
  { groupName: '婴童洗护与皮肤护理', term: '婴童洗护', generic: true },
  { groupName: '辅食工具与儿童餐具', term: '宝宝辅食', generic: true },
  { groupName: '奶粉辅食与营养', term: '婴幼儿奶粉', keyword: '婴幼儿奶粉' },
  { groupName: '童车与出行安全', term: '婴儿车', keyword: '婴儿车' },
  { groupName: '睡眠与婴童家居', term: '婴童家居', generic: true },
  { groupName: '孕产与产后护理', term: '孕产用品', generic: true },
  { groupName: '童装童鞋与寝具', term: '婴童服饰', generic: true },
  { groupName: '玩具与早教启蒙', term: '早教玩具', generic: true },
  { groupName: '健康监测与安全防护', term: '婴童护理', generic: true },
  { groupName: '清洁消毒与家庭日用', term: '母婴清洁', generic: true }
];

export function buildDouyinCategoryQueries(keywordGroups, maxQueries = 20) {
  const safeMax = Math.max(1, Math.min(Number(maxQueries) || 20, DOUYIN_BROAD_CATEGORIES.length));
  const enabledGroups = new Map(orderedGroups(keywordGroups).map((group) => [group.groupName, group]));
  const result = [];
  for (const category of DOUYIN_BROAD_CATEGORIES) {
    const group = enabledGroups.get(category.groupName);
    if (!group) continue;
    const keyword = category.generic || !group.products.includes(category.keyword) ? null : category.keyword;
    result.push(makeSpec({
      query: `${category.term}AI`,
      keyword,
      groupName: category.groupName,
      lane: 'category_ai',
      aiCue: 'AI',
      aiTargeted: true
    }));
  }
  // 兼容用户自建品类：未进入默认宽品类表时，只取该组第一个启用词，不再轮换细分词或品牌词。
  for (const group of enabledGroups.values()) {
    if (DOUYIN_BROAD_CATEGORIES.some((category) => category.groupName === group.groupName)) continue;
    const keyword = group.products[0];
    result.push(makeSpec({
      query: `${keyword}AI`,
      keyword,
      groupName: group.groupName,
      lane: 'category_ai',
      aiCue: 'AI',
      aiTargeted: true
    }));
  }
  return result.slice(0, safeMax);
}

export function buildCustomSearchQueries(keywords = [], maxQueries = 40) {
  const safeMax = Math.max(1, Math.min(Number(maxQueries) || 40, 40));
  const unique = new Map();
  for (const raw of Array.isArray(keywords) ? keywords : []) {
    const query = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!query) continue;
    const key = query.toLowerCase();
    if (unique.has(key)) continue;
    const keyword = query.replace(/(?:\s*(?:AI|AIGC))$/i, '').trim() || query;
    unique.set(key, makeSpec({
      query,
      keyword,
      groupName: `搜索主题 · ${keyword}`,
      lane: 'user_keyword',
      aiCue: /AIGC/i.test(query) ? 'AIGC' : /AI/i.test(query) ? 'AI' : null,
      aiTargeted: /(?:AI|AIGC)/i.test(query)
    }));
  }
  return [...unique.values()].slice(0, safeMax);
}

export function buildProductQueries(keywordGroups, maxQueries = 30, options = {}) {
  const safeMax = Math.max(1, Math.min(Number(maxQueries) || 30, 60));
  const seed = Number.isInteger(options.rotationSeed)
    ? options.rotationSeed
    : Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const groups = orderedGroups(keywordGroups);
  const result = [];

  // 第一轮保证品类覆盖：只搜索具体产品词，AI 身份由平台标识与详情证据判断。
  groups.forEach((group, index) => {
    const keyword = group.products[(seed + index) % group.products.length];
    result.push(makeSpec({
      query: keyword,
      keyword,
      groupName: group.groupName,
      lane: 'product'
    }));
  });

  // 第二轮搜索品类头部/活跃品牌，避免只得到泛品类内容。
  groups.forEach((group, index) => {
    const brands = getBrandsForGroup(group.groupName);
    if (!brands.length) return;
    const brandName = brands[(seed + index) % brands.length];
    const keyword = group.products[(seed + index * 3) % group.products.length];
    result.push(makeSpec({
      query: `${brandName} ${keyword}`,
      keyword,
      groupName: group.groupName,
      brandName,
      lane: 'brand_product'
    }));
  });

  // 有余量时补充第二个产品词；仍不追加 AI、广告、宣传片等限制词。
  groups.forEach((group, index) => {
    if (group.products.length < 2) return;
    const keyword = group.products[(seed + index + 1) % group.products.length];
    result.push(makeSpec({
      query: keyword,
      keyword,
      groupName: group.groupName,
      lane: 'product_secondary'
    }));
  });

  const unique = new Map();
  for (const spec of result) unique.set(spec.query.toLowerCase(), spec);
  return [...unique.values()].slice(0, safeMax);
}
