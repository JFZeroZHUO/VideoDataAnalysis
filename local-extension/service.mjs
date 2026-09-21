import { analyzeCandidate } from '../server/ranking.mjs';

const STATE_KEY = 'video-data-analysis:state:v1';
const MAX_RECORDS = 5000;
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const METRICS = ['viewCount', 'likeCount', 'favoriteCount', 'commentCount', 'shareCount', 'recommendCount'];
const CLOSED = new Set(['completed', 'failed', 'cancelled']);
const TIME_RANGES = new Set(['one_day', 'one_week', 'half_year', 'unlimited']);
const MATERIAL_FIELDS = new Set(['platform', 'sourceUrl', 'platformItemId', 'title', 'authorName', 'publishedAt', 'thumbnailUrl', 'query', 'queryTerms', 'rawMetrics', 'firstCollectedAt', 'lastCollectedAt', 'rightsStatus', ...METRICS]);
const RAW_FIELDS = new Set(['querySearchTerm', 'querySearchTerms', 'sourceText', 'searchFilterVerified', 'detailAiDeclarationChecked', 'detailAiDeclarationVerified', 'aiEvidenceVerified', 'metricsVerified', 'platformAiLabel', 'detailCollectedAt', 'aiDeclarationScope', 'aiEvidenceType', 'aiVerificationSkipped', 'aiEvidenceRequired', 'collectionScope', 'searchFilter', 'metricEvidence']);
const RAW_BOOLEANS = ['searchFilterVerified', 'detailAiDeclarationChecked', 'detailAiDeclarationVerified', 'aiEvidenceVerified', 'metricsVerified', 'aiVerificationSkipped', 'aiEvidenceRequired'];
const FILTER_DEFAULTS = { productGroup: 'all', aiType: 'all', contentIntent: 'all', brand: 'all', aiEvidence: 'all', quality: 'all', search: '', sort: 'likeCount', direction: 'desc' };
const AI_LABEL = /疑似\s*AI\s*生成|(?:作者声明[：:]?\s*)?内容由\s*AI\s*生成|本内容(?:由|使用)\s*AI\s*生成/i;
const error = (message, status = 400, code = 'LOCAL_INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const text = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const terms = (value, max = 40) => [...new Set((Array.isArray(value) ? value : []).map((word) => text(word, 80)).filter(Boolean))].slice(0, max);
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function checkFields(value, allowed) {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.has(key))) throw error('备份包含不支持的字段，未导入任何内容。', 400, 'LOCAL_INVALID_BACKUP');
}
function checkedTerms(value, max = 40) {
  if (!Array.isArray(value) || value.length > max || value.some((word) => typeof word !== 'string' || !word.trim() || word.length > 80)) throw error('关键词须为非空文本，每个不超过80字，队列最多40个。');
  return [...new Set(value.map((word) => word.trim()))];
}
function safeMessage(value) {
  return text(typeof value === 'string' ? value : '', 500).replace(/sk-[\w-]{8,}|Bearer\s+\S+|(?:api[_-]?key|cookie|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '[已隐藏]').slice(0, 240) || '采集未完成，请检查抖音页面后重试。';
}
function videoUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return null;
    const id = url.pathname.match(/^\/video\/(\d{6,30})\/?$/)?.[1] || url.searchParams.get('modal_id');
    return /^\d{6,30}$/.test(id || '') ? { sourceUrl: `https://www.douyin.com/video/${id}`, platformItemId: id } : null;
  } catch { return null; }
}
function thumbnail(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const domains = ['douyin.com', 'douyinpic.com', 'douyincdn.com', 'byteimg.com', 'ibytedtos.com', 'pstatp.com', 'volces.com', 'bytedance.com', 'bytedance.net'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
function normalizeRaw(value, strict) {
  if (strict) checkFields(value || {}, RAW_FIELDS);
  const raw = plain(value) ? value : {};
  const result = {};
  for (const key of RAW_BOOLEANS) {
    if (strict && raw[key] != null && typeof raw[key] !== 'boolean') throw error('备份标识字段类型无效。');
    if (typeof raw[key] === 'boolean') result[key] = raw[key];
  }
  for (const key of ['querySearchTerm', 'sourceText', 'platformAiLabel', 'detailCollectedAt', 'aiDeclarationScope', 'aiEvidenceType', 'collectionScope']) {
    if (strict && raw[key] != null && (typeof raw[key] !== 'string' || raw[key].length > (key === 'sourceText' ? 4000 : 240))) throw error('备份文本长度或类型无效。');
    if (typeof raw[key] === 'string') result[key] = text(raw[key], key === 'sourceText' ? 4000 : 240);
  }
  result.querySearchTerms = strict && raw.querySearchTerms != null ? checkedTerms(raw.querySearchTerms, 80) : terms(raw.querySearchTerms, 80);
  if (raw.searchFilter) {
    const allowed = new Set(['sort', 'sortLabel', 'timeRange', 'timeLabel', 'contentType', 'verified']);
    if (strict) checkFields(raw.searchFilter, allowed);
    result.searchFilter = {};
    for (const key of allowed) if (typeof raw.searchFilter[key] === 'string') result.searchFilter[key] = text(raw.searchFilter[key], 80);
    result.searchFilter.verified = raw.searchFilter.verified === true;
  }
  if (raw.metricEvidence) {
    if (strict) checkFields(raw.metricEvidence, new Set(METRICS));
    result.metricEvidence = {};
    for (const key of METRICS) {
      const entry = raw.metricEvidence[key];
      if (!plain(entry)) { if (strict && entry != null) throw error('备份指标证据无效。'); continue; }
      if (strict) checkFields(entry, new Set(['value', 'selector', 'text', 'verified']));
      if (strict && ((entry.value != null && (!Number.isFinite(entry.value) || entry.value < 0 || entry.value > Number.MAX_SAFE_INTEGER)) ||
        (entry.selector != null && (typeof entry.selector !== 'string' || entry.selector.length > 300)) ||
        (entry.text != null && (typeof entry.text !== 'string' || entry.text.length > 300)) ||
        (entry.verified != null && typeof entry.verified !== 'boolean'))) throw error('备份指标证据类型无效。');
      const numeric = Number.isFinite(entry.value) && entry.value >= 0 && entry.value <= Number.MAX_SAFE_INTEGER;
      result.metricEvidence[key] = { value: numeric ? entry.value : null, selector: text(entry.selector, 300) || null, text: text(entry.text, 300), verified: numeric && entry.verified === true };
    }
  }
  return result;
}
function candidate(input, { strict = false, task } = {}) {
  if (strict) checkFields(input, MATERIAL_FIELDS);
  if (!plain(input)) throw error('素材格式无效。');
  const source = videoUrl(input.sourceUrl);
  if (!source || !text(input.title, 2000) || (input.platform && input.platform !== 'douyin')) throw error('素材必须包含抖音公开视频链接和标题。');
  if (strict && input.platformItemId && input.platformItemId !== source.platformItemId) throw error('备份视频标识不一致。');
  if (strict) {
    for (const [key, max] of [['title', 2000], ['authorName', 200], ['publishedAt', 100], ['query', 80], ['firstCollectedAt', 40], ['lastCollectedAt', 40]]) {
      if (input[key] != null && (typeof input[key] !== 'string' || input[key].length > max)) throw error('备份素材文本类型或长度无效。');
    }
    if (input.rightsStatus != null && !['authorized', 'denied', 'unknown'].includes(input.rightsStatus)) throw error('备份授权状态无效。');
    if (input.queryTerms != null) checkedTerms(input.queryTerms, 80);
  }
  const raw = normalizeRaw(input.rawMetrics, strict);
  const query = text(input.query || raw.querySearchTerm || (task?.keywords?.length === 1 ? task.keywords[0] : ''), 80);
  if (task && !task.keywords.includes(query)) throw error('素材来源词不属于本次搜索队列。');
  const queryTerms = task ? [query] : terms([...(Array.isArray(input.queryTerms) ? input.queryTerms : []), ...raw.querySearchTerms, query], 80);
  if (!queryTerms.length) throw error('素材缺少原始搜索关键词。');
  const result = { platform: 'douyin', ...source, title: text(input.title, 2000), authorName: text(input.authorName, 200), publishedAt: text(input.publishedAt, 100) || null,
    thumbnailUrl: thumbnail(input.thumbnailUrl), query: query || queryTerms[0], queryTerms,
    rightsStatus: ['authorized', 'denied'].includes(input.rightsStatus) ? input.rightsStatus : 'unknown',
    firstCollectedAt: text(input.firstCollectedAt, 40) || now(), lastCollectedAt: text(input.lastCollectedAt, 40) || now(), rawMetrics: raw };
  if (strict && input.thumbnailUrl && !result.thumbnailUrl) throw error('备份封面链接不是允许的公开图片地址。');
  for (const key of METRICS) {
    if (strict && input[key] != null && (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > Number.MAX_SAFE_INTEGER)) throw error('备份互动指标无效。');
    result[key] = Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= Number.MAX_SAFE_INTEGER ? input[key] : null;
  }
  result.rawMetrics.querySearchTerm = result.query;
  result.rawMetrics.querySearchTerms = result.queryTerms;
  result.rawMetrics.detailAiDeclarationVerified = raw.detailAiDeclarationVerified === true && raw.aiDeclarationScope === 'detail' && AI_LABEL.test(raw.platformAiLabel || '');
  if (task) { result.rawMetrics.aiEvidenceRequired = task.requireAiEvidence; result.rawMetrics.aiVerificationSkipped = !task.requireAiEvidence; }
  return result;
}
function present(material) {
  const raw = material.rawMetrics || {};
  const verified = raw.detailAiDeclarationVerified === true;
  const value = analyzeCandidate({ ...material, aiDeclared: verified, platformAiLabel: raw.platformAiLabel,
    rawMetrics: { ...raw, queryKeyword: material.query, queryGroup: `搜索主题 · ${material.query}`, queryLane: 'user_keyword' } }, {});
  const missing = ['likeCount', 'favoriteCount', 'commentCount', 'shareCount'].filter((key) => material[key] === null);
  const complete = missing.length === 0 && raw.metricsVerified === true;
  const ratio = (key) => material.likeCount > 0 && material[key] !== null ? Math.round(material[key] / material.likeCount * 10000) / 100 : null;
  return { ...value, id: material.platformItemId, materialStatus: complete ? 'ready' : 'metrics_partial',
    aiProof: { verified, label: verified ? raw.platformAiLabel : null, checkedAt: raw.detailCollectedAt || null, scope: raw.aiDeclarationScope || null, sourceType: verified ? (raw.aiEvidenceType === 'author_disclosure' ? 'author_disclosure' : 'platform_declaration') : null },
    metricQuality: { verified: complete, coverage: (4 - missing.length) / 4, missing }, mediaStatus: 'source_only', mediaUrl: null,
    marketingScore: complete ? value.marketingScore : null, interactionValue: complete ? value.interactionValue : null,
    systemHeat: null, favoriteLikeRate: ratio('favoriteCount'), commentLikeRate: ratio('commentCount'), shareLikeRate: ratio('shareCount') };
}
function mergeMaterial(previous, next) {
  if (!previous) return next;
  const merged = { ...previous, ...next, firstCollectedAt: previous.firstCollectedAt, queryTerms: terms([...previous.queryTerms, ...next.queryTerms], 80), rawMetrics: { ...previous.rawMetrics, ...next.rawMetrics } };
  for (const key of METRICS) if (next[key] === null) merged[key] = previous[key];
  for (const key of ['detailAiDeclarationVerified', 'aiEvidenceVerified', 'metricsVerified']) if (previous.rawMetrics[key] === true) merged.rawMetrics[key] = true;
  if (previous.rawMetrics.detailAiDeclarationVerified && !next.rawMetrics.detailAiDeclarationVerified) {
    for (const key of ['platformAiLabel', 'detailCollectedAt', 'aiDeclarationScope', 'aiEvidenceType']) if (previous.rawMetrics[key] != null) merged.rawMetrics[key] = previous.rawMetrics[key];
  }
  merged.rawMetrics.metricEvidence = { ...previous.rawMetrics.metricEvidence, ...next.rawMetrics.metricEvidence };
  merged.rawMetrics.querySearchTerms = merged.queryTerms;
  return merged;
}
function searchState(input = {}, strict = false) {
  if (!plain(input)) throw error('搜索设置格式无效。');
  if (strict) checkFields(input, new Set(['keywords', 'resultScope', 'requireAiEvidence', 'timeRange', 'updatedAt', 'filters']));
  const keywords = checkedTerms(input.keywords || []);
  const requireAiEvidence = input.requireAiEvidence === true;
  const filters = { ...FILTER_DEFAULTS, aiEvidence: requireAiEvidence ? 'verified' : 'all' };
  if (input.filters != null) {
    checkFields(input.filters, new Set(Object.keys(FILTER_DEFAULTS)));
    for (const key of Object.keys(FILTER_DEFAULTS)) if (input.filters[key] != null) {
      if (typeof input.filters[key] !== 'string' || input.filters[key].length > 240) throw error('搜索筛选条件无效。');
      filters[key] = input.filters[key];
    }
  }
  if (!['all', 'verified', 'pending'].includes(filters.aiEvidence) || !['all', 'ready', 'metrics_partial'].includes(filters.quality) || !['asc', 'desc'].includes(filters.direction)) throw error('搜索筛选条件无效。');
  if (strict && ((input.requireAiEvidence != null && typeof input.requireAiEvidence !== 'boolean') || (input.timeRange != null && !TIME_RANGES.has(input.timeRange)) || (input.resultScope != null && !['history', 'current'].includes(input.resultScope)))) throw error('备份搜索设置无效。');
  return { keywords, resultScope: keywords.length && input.resultScope !== 'history' ? 'current' : 'history', requireAiEvidence,
    timeRange: TIME_RANGES.has(input.timeRange) ? input.timeRange : 'half_year', filters, updatedAt: now() };
}
function parseTerms(value) { if (value === null) return null; try { return checkedTerms(JSON.parse(value)); } catch { throw error('当前搜索关键词范围无效，请刷新后重试。'); } }
function filtered(materials, params) {
  let rows = materials.map(present);
  const queries = parseTerms(params.get('queryTerms'));
  if (queries) rows = rows.filter((row) => row.queryTerms.some((term) => queries.includes(term)));
  for (const key of ['productGroup', 'aiType', 'contentIntent', 'brand']) {
    const value = params.get(key);
    if (value && value !== 'all') rows = rows.filter((row) => row[key === 'brand' ? 'brandName' : key] === value);
  }
  if (params.get('aiEvidence') === 'verified') rows = rows.filter((row) => row.aiProof.verified);
  if (params.get('aiEvidence') === 'pending') rows = rows.filter((row) => !row.aiProof.verified);
  if (params.get('quality') && params.get('quality') !== 'all') rows = rows.filter((row) => row.materialStatus === params.get('quality'));
  const search = (params.get('search') || '').trim().toLowerCase();
  if (search) rows = rows.filter((row) => [row.title, row.authorName, row.productName, row.brandName, row.productGroup].some((value) => value?.toLowerCase().includes(search)));
  const sort = ['likeCount', ...METRICS, 'systemHeat', 'marketingScore', 'favoriteLikeRate', 'shareLikeRate', 'lastCollectedAt', 'firstCollectedAt', 'publishedAt'].includes(params.get('sort')) ? params.get('sort') : 'likeCount';
  const direction = params.get('direction') === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    if (a[sort] == null) return b[sort] == null ? 0 : 1;
    if (b[sort] == null) return -1;
    return direction * (typeof a[sort] === 'number' ? a[sort] - b[sort] : String(a[sort]).localeCompare(String(b[sort])));
  });
}
function facets(rows) {
  const group = (key) => [...new Set(rows.map((item) => item[key]).filter(Boolean))].map((value) => ({ value, count: rows.filter((item) => item[key] === value).length }));
  return { products: group('productGroup'), brands: group('brandName'), formats: group('creativeFormat'), hooks: group('hookType') };
}
const average = (values) => { const valid = values.filter(Number.isFinite); return valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length * 100) / 100 : null; };
function analysis(state, params) {
  const rows = filtered(state.materials, params);
  const group = (key) => [...new Set(rows.map((item) => item[key] || '未识别'))].map((label) => {
    const items = rows.filter((row) => (row[key] || '未识别') === label);
    return { label, count: items.length, avgLikes: average(items.map((row) => row.likeCount)), avgMarketingScore: average(items.map((row) => row.marketingScore)), avgFavoriteLikeRate: average(items.map((row) => row.favoriteLikeRate)), avgShareLikeRate: average(items.map((row) => row.shareLikeRate)) };
  }).sort((a, b) => b.count - a.count);
  const ready = rows.filter((row) => row.metricQuality.verified).length;
  return { summary: { materials: rows.length, aiVerified: rows.filter((row) => row.aiProof.verified).length, metricsReady: ready, brands: new Set(rows.map((row) => row.brandName).filter(Boolean)).size, categories: group('productGroup').length,
    avgMarketingScore: average(rows.map((row) => row.marketingScore)), avgFavoriteLikeRate: average(rows.map((row) => row.favoriteLikeRate)), avgShareLikeRate: average(rows.map((row) => row.shareLikeRate)) },
    funnel: { searchCards: state.jobs[0]?.searchCardCount || 0, detailAiVerified: state.jobs[0]?.aiCandidateCount || 0, storedCandidates: rows.length, storedMaterials: rows.length, metricsReady: ready },
    categories: group('productGroup'), intents: group('contentIntent'), formats: group('creativeFormat'), hooks: group('hookType'), audiences: group('targetAudience'), opportunities: rows.filter((row) => Number.isFinite(row.marketingScore)).sort((a, b) => b.marketingScore - a.marketingScore).slice(0, 12), basis: '公开指标与文本规则，不代表实际投放回报' };
}

export function createLocalService({ store, runTask, version = '1.0.0' }) {
  let queue = Promise.resolve();
  const read = async () => (await store.get(STATE_KEY)) || { schemaVersion: 1, materials: [], jobs: [], searchState: null };
  const write = (operation) => {
    const pending = queue.then(async () => {
      const state = clone(await read());
      const result = await operation(state);
      if (new TextEncoder().encode(JSON.stringify({ materials: state.materials, searchState: state.searchState })).byteLength > MAX_BACKUP_BYTES - 1024 * 1024) throw error('本机素材库已达到容量限制，请先导出备份。', 507, 'LOCAL_STORAGE_LIMIT');
      await store.set(STATE_KEY, state);
      return clone(result);
    });
    queue = pending.catch(() => {});
    return pending;
  };
  const ready = write((state) => {
    for (const job of state.jobs) if (!CLOSED.has(job.status)) Object.assign(job, { status: 'failed', phase: 'interrupted', finishedAt: now(), message: '扩展已重启，上次任务中断；已采集素材仍保留，请按原词重新采集。' });
  });
  async function request(input, { method = 'GET', body } = {}) {
    await ready;
    if (typeof input !== 'string' || !input.startsWith('/api/') || input.startsWith('//') || input.includes('\\') || /[\u0000-\u0020]/.test(input)) throw error('不允许请求外部地址。');
    const url = new URL(input, 'https://local.invalid');
    const route = url.pathname;
    const params = url.searchParams;
    const verb = String(method).toUpperCase();
    if (params.has('platform') && params.get('platform') !== 'douyin') throw error('在线扩展首版仅支持抖音。', 501, 'LOCAL_PLATFORM_UNSUPPORTED');
    if (verb === 'POST' && route === '/api/local/search-state') {
      const settings = searchState(body, true);
      return write((state) => { state.searchState = settings; return settings; });
    }
    if (verb === 'POST' && route === '/api/collect/douyin') {
      if (typeof runTask !== 'function') throw error('采集器尚未就绪。', 503, 'LOCAL_COLLECTOR_UNAVAILABLE');
      const settings = searchState(body);
      if (!settings.keywords.length) throw error('请先添加至少一个搜索关键词。');
      const job = await write((state) => {
        const active = state.jobs.find((item) => !CLOSED.has(item.status));
        if (active) throw Object.assign(error('已有任务正在采集，请等待完成。', 409, 'LOCAL_JOB_BUSY'), { jobId: active.id });
        const item = { id: crypto.randomUUID(), platform: 'douyin', status: 'queued', phase: 'queued', keywords: settings.keywords, requireAiEvidence: settings.requireAiEvidence, timeRange: settings.timeRange,
          createdAt: now(), startedAt: now(), finishedAt: null, message: '任务已发送到当前浏览器，等待打开抖音。', progress: 0, scannedCount: 0, searchCardCount: 0, aiCandidateCount: 0, addedCount: 0, updatedCount: 0, failedCount: 0, collectionDiagnostics: {} };
        state.jobs.unshift(item); state.jobs = state.jobs.slice(0, 100);
        state.searchState = { ...settings, filters: state.searchState?.filters || settings.filters };
        return item;
      });
      const requestedCount = Number(body?.maxResults);
      const task = { ...job, jobId: job.id, queries: job.keywords.map((keyword) => ({ query: keyword, keyword })), maxResults: Number.isFinite(requestedCount) ? Math.min(Math.max(Math.floor(requestedCount), 1), 800) : 200, topN: [15, 20, 50].includes(Number(body?.topN)) ? Number(body.topN) : 20 };
      const update = (action) => write((state) => { const current = state.jobs.find((item) => item.id === job.id); if (!current || CLOSED.has(current.status)) return current; return action(current, state); });
      const hooks = {
        progress: (patch = {}) => update((current) => {
          current.status = 'running';
          for (const key of ['progress', 'scannedCount', 'searchCardCount', 'aiCandidateCount', 'failedCount', 'tabId']) if (Number.isFinite(patch[key]) && patch[key] >= 0) current[key] = Math.min(patch[key], key === 'progress' ? 99 : Number.MAX_SAFE_INTEGER);
          if (patch.phase) current.phase = text(patch.phase, 60);
          if (patch.message) current.message = safeMessage(patch.message);
          if (plain(patch.collectionDiagnostics)) {
            const diagnostics = patch.collectionDiagnostics;
            current.collectionDiagnostics = {
              linkFailureCount: Number.isFinite(diagnostics.linkFailureCount) ? Math.max(0, diagnostics.linkFailureCount) : 0,
              failureSamples: (Array.isArray(diagnostics.failureSamples) ? diagnostics.failureSamples : []).slice(0, 5).map((item) => ({ query: text(item?.query, 80), title: text(item?.title, 120), message: safeMessage(item?.message || item?.reason) }))
            };
          }
          return current;
        }),
        batch: (candidates) => update((current, state) => {
          if (!Array.isArray(candidates) || candidates.length > 200) throw error('采集批次过大或格式无效。');
          for (const input of candidates) {
            let material;
            try { material = candidate(input, { task }); } catch { current.failedCount += 1; continue; }
            current.scannedCount += 1;
            if (task.requireAiEvidence && material.rawMetrics.detailAiDeclarationVerified !== true) continue;
            const index = state.materials.findIndex((item) => item.sourceUrl === material.sourceUrl);
            if (index < 0) {
              if (state.materials.length >= MAX_RECORDS) throw error('本机素材库已达到 5000 条上限，请先导出备份。', 507, 'LOCAL_STORAGE_LIMIT');
              state.materials.push(material); current.addedCount += 1;
            } else { state.materials[index] = mergeMaterial(state.materials[index], material); current.updatedCount += 1; }
          }
          return { addedCount: current.addedCount, updatedCount: current.updatedCount, failedCount: current.failedCount };
        }),
        complete: () => update((current) => {
          const accepted = current.addedCount + current.updatedCount;
          const allFailed = accepted === 0 && (current.failedCount > 0 || current.collectionDiagnostics.linkFailureCount > 0);
          return Object.assign(current, { status: allFailed ? 'failed' : 'completed', phase: allFailed ? 'parse_failed' : 'completed', progress: 100, finishedAt: now(), message: allFailed
            ? '采集未完成：本轮没有成功入库的素材，且存在卡片或链接解析失败；请查看任务诊断后重试。'
            : accepted ? `采集完成：新增 ${current.addedCount} 条，更新 ${current.updatedCount} 条；素材已保存在本机浏览器。结果受每词预算和页面可见范围限制，并非全网穷尽。`
              : `本轮未采集到${current.requireAiEvidence ? '具备详情页AI声明的' : '可解析的'}视频；请检查关键词、抖音结果及任务诊断。` });
        }),
        fail: (message) => update((current) => Object.assign(current, { status: 'failed', phase: 'failed', progress: 100, finishedAt: now(), message: safeMessage(message) }))
      };
      Promise.resolve().then(() => runTask(clone(task), hooks)).then(() => hooks.complete()).catch((cause) => hooks.fail(cause?.message || '采集未完成，请确认抖音已登录、验证已完成后重试。')).catch(() => {});
      return job;
    }
    if (verb === 'POST' && route === '/api/local/restore') {
      const backup = body?.backup;
      let serialized;
      try { serialized = JSON.stringify(backup); } catch { throw error('备份格式无效。'); }
      if (serialized && new TextEncoder().encode(serialized).byteLength > MAX_BACKUP_BYTES) throw error('备份文件超过 50MB 限制。');
      checkFields(backup, new Set(['schemaVersion', 'exportedAt', 'materials', 'searchState']));
      if (backup.schemaVersion !== 1 || !Array.isArray(backup.materials) || backup.materials.length > MAX_RECORDS) throw error('备份版本或素材数量无效。');
      const materials = backup.materials.map((item) => candidate(item, { strict: true }));
      const settings = backup.searchState ? searchState(backup.searchState, true) : null;
      return write((state) => {
        if (state.jobs.some((job) => !CLOSED.has(job.status))) throw error('请等待采集结束后再恢复备份。', 409, 'LOCAL_JOB_BUSY');
        let added = 0;
        let updated = 0;
        for (const material of materials) {
          const index = state.materials.findIndex((item) => item.sourceUrl === material.sourceUrl);
          if (index < 0) { state.materials.push(material); added += 1; } else { state.materials[index] = mergeMaterial(state.materials[index], material); updated += 1; }
        }
        if (state.materials.length > MAX_RECORDS) throw error('合并后素材数量超过本机容量限制。', 507, 'LOCAL_STORAGE_LIMIT');
        if (settings) state.searchState = settings;
        return { addedCount: added, updatedCount: updated, total: state.materials.length };
      });
    }
    if (verb === 'POST' && (route.endsWith('/download') || route === '/api/local/open-douyin')) throw error('此操作需要扩展页面支持；首版不提供自动下载。', 501, 'LOCAL_OPERATION_UNSUPPORTED');
    if (verb !== 'GET') throw error('不支持的本机服务接口。', 404, 'LOCAL_NOT_FOUND');
    await queue;
    const state = await read();
    const rows = filtered(state.materials, params);
    if (route === '/api/meta') {
      const count = state.materials.length;
      const counts = { douyin: rows.filter((row) => row.rawMetrics.searchFilterVerified === true && row.likeCount > 0).length, xiaohongshu: 0, channels: 0 };
      const materialCounts = { douyin: count, xiaohongshu: 0, channels: 0 };
      const recent = [...new Set(state.materials.slice().reverse().flatMap((item) => item.queryTerms))].slice(0, 10).map((term) => ({ term, materialCount: state.materials.filter((item) => item.queryTerms.includes(term)).length }));
      return { counts, materialCounts, candidateCounts: materialCounts, pendingCounts: { douyin: rows.filter((row) => !row.metricQuality.verified).length }, latestJobs: { douyin: state.jobs[0] || null }, searchStates: { douyin: state.searchState }, recentSearchTerms: { douyin: recent },
        activePlatforms: state.jobs.some((job) => !CLOSED.has(job.status)) ? ['douyin'] : [], collectorAvailable: true,
        localExtension: { connected: true, version, storage: 'indexeddb' }, browserHelper: { connected: true, version, compatible: true }, collectorBrowser: { connected: false, ready: false }, channelsDesktop: { available: false }, collectionMode: 'local_extension' };
    }
    if (route === '/api/materials') return { materials: rows.slice(0, Math.min(Math.max(Number(params.get('limit')) || 500, 1), MAX_RECORDS)), count: rows.length, facets: facets(rows) };
    if (route === '/api/jobs') return { jobs: clone(state.jobs.slice(0, Math.max(1, Math.min(Number(params.get('limit')) || 20, 100)))) };
    if (route.startsWith('/api/jobs/')) { const job = state.jobs.find((item) => item.id === route.slice(10)); if (!job) throw error('任务不存在。', 404, 'LOCAL_NOT_FOUND'); return clone(job); }
    if (route === '/api/local/attention') return { job: clone(state.jobs.find((job) => !CLOSED.has(job.status) && /login|verif|blocked|attention|captcha/.test(job.phase)) || null) };
    if (route === '/api/category-rankings') {
      const eligible = rows.filter((row) => row.rawMetrics.searchFilterVerified === true && row.likeCount > 0);
      const groups = [...new Set(eligible.map((row) => row.productGroup))].map((group) => { const items = eligible.filter((row) => row.productGroup === group); return { group, total: items.length, videos: items.slice(0, Math.min(Number(params.get('limitPerGroup')) || 20, 50)).map((row, index) => ({ ...row, categoryRank: index + 1 })) }; });
      return { groups };
    }
    if (route === '/api/analysis') return analysis(state, params);
    if (route === '/api/local/backup') return clone({ schemaVersion: 1, exportedAt: now(), materials: state.materials, searchState: state.searchState });
    if (route === '/api/export/materials.csv') {
      const cell = (value) => {
        const source = String(value ?? '');
        const escaped = /^[\t\r\n]|^\s*[=+@-]/u.test(source) ? `'${source}` : source;
        return `"${escaped.replace(/"/g, '""')}"`;
      };
      const columns = ['title', 'authorName', 'query', ...METRICS, 'sourceUrl'];
      return { csv: '\ufeff' + [columns, ...rows.map((row) => columns.map((key) => row[key]))].map((row) => row.map(cell).join(',')).join('\r\n') };
    }
    throw error('不支持的本机服务接口。', 404, 'LOCAL_NOT_FOUND');
  }
  return { request, ready };
}
