export const DOUYIN_SEARCH_STATE_KEY = 'media-intelligence:douyin-search-state:v1';

export function normalizeSearchKeywords(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((keyword) => String(keyword || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))].slice(0, 40);
}

export function defaultMaterialFilters(requireAiEvidence = false) {
  return { productGroup: 'all', aiType: 'all', contentIntent: 'all', brand: 'all',
    aiEvidence: requireAiEvidence ? 'verified' : 'all', quality: 'all',
    search: '', sort: 'likeCount', direction: 'desc' };
}

export function filtersForAiMode(filters, enabled) {
  return { ...filters, aiEvidence: enabled ? 'verified' : 'all', aiType: 'all', quality: 'all' };
}

export function normalizeSearchState(value = {}) {
  const keywords = normalizeSearchKeywords(value?.keywords);
  const requireAiEvidence = value?.requireAiEvidence === true;
  const defaults = defaultMaterialFilters(requireAiEvidence);
  const filters = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
    [key, typeof value?.filters?.[key] === 'string' ? value.filters[key] : fallback]));
  if (!['all', 'verified', 'pending'].includes(filters.aiEvidence)) filters.aiEvidence = defaults.aiEvidence;
  if (!['all', 'ready', 'metrics_partial'].includes(filters.quality)) filters.quality = 'all';
  if (!['asc', 'desc'].includes(filters.direction)) filters.direction = 'desc';
  return {
    keywords,
    resultScope: keywords.length && value?.resultScope !== 'history' ? 'current' : 'history',
    requireAiEvidence,
    timeRange: ['one_day', 'one_week', 'half_year', 'unlimited'].includes(value?.timeRange) ? value.timeRange : 'half_year',
    filters
  };
}

export function readStoredDouyinSearchState(storage) {
  try {
    const raw = storage?.getItem(DOUYIN_SEARCH_STATE_KEY);
    if (raw) return { ...normalizeSearchState(JSON.parse(raw)), exists: true };
  } catch { /* Storage may be unavailable or contain an older invalid value. */ }
  return { ...normalizeSearchState(), exists: false };
}

export function storeDouyinSearchState(storage, state) {
  try { storage?.setItem(DOUYIN_SEARCH_STATE_KEY, JSON.stringify(normalizeSearchState(state))); }
  catch { /* The current in-memory settings still work when storage is unavailable. */ }
}

export function materialRequestParams(platform, filters, keywords, resultScope) {
  const params = { platform, ...filters, limit: 500 };
  if (platform === 'douyin' && resultScope === 'current' && keywords.length) {
    params.queryTerms = JSON.stringify(normalizeSearchKeywords(keywords));
  }
  return params;
}
