import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  failInterruptedJobs,
  getFacets,
  getCategoryRankings,
  getCandidateCounts,
  getJob,
  getKeywordGroups,
  getMarketingAnalysis,
  getMaterialCounts,
  getMaterialFacets,
  getMaterials,
  getPlatformSearchState,
  getPendingCounts,
  getPlatformCounts,
  getRecentSearchTerms,
  getRecentJobs,
  getVideoById,
  getVideos,
  projectDir,
  quarantineInvalidDouyinLeaderboard,
  replaceKeywordGroups,
  savePlatformSearchState,
  updateRightsStatus
} from './db.mjs';
import { findBrowserExecutable } from './collectors/browser.mjs';
import { downloadAuthorizedMedia } from './media.mjs';
import { getCdpStatus, hasActiveCdpJob, startCdpCollection } from './cdp-collector.mjs';
import {
  claimBrowserHelperTask,
  completeBrowserHelperTask,
  failBrowserHelperTask,
  getBrowserHelperStatus,
  hasActiveBrowserHelperJob,
  isBrowserHelperConnected,
  registerBrowserHelper,
  startBrowserHelperCollection,
  updateBrowserHelperTask
} from './browser-helper.mjs';
import { getRulesSummary } from './domain-rules.mjs';
import { configureDeepSeek, deepSeekRequestAccess, getDeepSeekStatus, suggestKeywords } from './deepseek-keywords.mjs';
import {
  getChannelsDesktopStatus,
  hasActiveChannelsDesktopJob,
  openChannelsPublicSearch,
  startChannelsDesktopCollection
} from './channels-desktop.mjs';

const app = express();
const port = Number(process.env.PORT || 4318);
const supportedPlatforms = new Set(['douyin', 'xiaohongshu', 'channels']);

function parseQueryTerms(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value).split('|');
  }
}

failInterruptedJobs();
quarantineInvalidDouyinLeaderboard();

app.disable('x-powered-by');
app.use('/api/deepseek', (request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    request.deepSeekAccess = deepSeekRequestAccess(request, { requireJson: request.method === 'POST' });
    next();
  } catch (error) { next(error); }
});
app.use(express.json({ limit: '1mb' }));

app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const origin = request.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/meta', async (_request, response) => {
  const jobs = getRecentJobs(30);
  const latestJobs = {};
  for (const job of jobs) latestJobs[job.platform] ||= job;
  const collectorBrowser = await getCdpStatus();
  const browserHelper = getBrowserHelperStatus();
  const channelsDesktop = await getChannelsDesktopStatus();
  response.json({
    counts: getPlatformCounts(),
    materialCounts: getMaterialCounts(),
    candidateCounts: getCandidateCounts(),
    pendingCounts: getPendingCounts(),
    searchStates: Object.fromEntries([...supportedPlatforms].map((platform) => [platform, getPlatformSearchState(platform)])),
    recentSearchTerms: Object.fromEntries([...supportedPlatforms].map((platform) => [platform, getRecentSearchTerms(platform, 10)])),
    latestJobs,
    collectorAvailable: Boolean(findBrowserExecutable()),
    activePlatforms: [...supportedPlatforms].filter((platform) => hasActiveCdpJob(platform) || hasActiveBrowserHelperJob(platform) || (platform === 'channels' && hasActiveChannelsDesktopJob())),
    collectorBrowser,
    browserHelper,
    channelsDesktop,
    collectionMode: browserHelper.connected ? 'daily_chrome_helper' : 'visible_chrome_cdp',
    notices: {
      douyin: '按用户关键词逐词搜索并强制应用“最多点赞＋指定发布时间＋视频”；开启AI限定时进入详情核验声明，关闭时只采集热门搜索结果。',
      xiaohongshu: '按品类与品牌矩阵召回，自动区分带货、种草、品牌宣传和AI引流；公开搜索通常不提供浏览量。',
      channels: '使用已登录的微信电脑版，按多关键词进入「搜一搜 → 视频号 → 最热」，逐条打开公域详情页采集喜欢、分享、点赞、评论与AI证据。'
    }
  });
});

app.get('/api/videos', (request, response) => {
  const platform = String(request.query.platform || 'douyin');
  if (!supportedPlatforms.has(platform)) return response.status(400).json({ message: '不支持的平台。' });
  const filters = {
    platform,
    productGroup: String(request.query.productGroup || 'all'),
    aiType: String(request.query.aiType || 'all'),
    contentIntent: String(request.query.contentIntent || 'all'),
    sort: String(request.query.sort || 'systemHeat'),
    direction: String(request.query.direction || 'desc'),
    limit: request.query.limit
  };
  const videos = getVideos(filters);
  response.json({ videos, facets: getFacets(platform), count: videos.length });
});

app.get('/api/materials', (request, response) => {
  const platform = String(request.query.platform || 'douyin');
  if (!supportedPlatforms.has(platform)) return response.status(400).json({ message: '不支持的平台。' });
  const filters = {
    platform,
    productGroup: String(request.query.productGroup || 'all'),
    aiType: String(request.query.aiType || 'all'),
    contentIntent: String(request.query.contentIntent || 'all'),
    brand: String(request.query.brand || 'all'),
    aiEvidence: String(request.query.aiEvidence || 'verified'),
    quality: String(request.query.quality || 'all'),
    queryTerms: parseQueryTerms(request.query.queryTerms),
    search: String(request.query.search || ''),
    sort: String(request.query.sort || 'lastCollectedAt'),
    direction: String(request.query.direction || 'desc'),
    limit: request.query.limit
  };
  const materials = getMaterials(filters);
  response.json({ materials, facets: getMaterialFacets(platform, filters.aiEvidence, filters.queryTerms), count: materials.length });
});

app.get('/api/category-rankings', (request, response) => {
  const platform = String(request.query.platform || 'douyin');
  if (!supportedPlatforms.has(platform)) return response.status(400).json({ message: '不支持的平台。' });
  response.json({
    groups: getCategoryRankings({
      platform,
      productGroup: String(request.query.productGroup || 'all'),
      limitPerGroup: request.query.limitPerGroup,
      sort: String(request.query.sort || 'marketingScore')
    })
  });
});

app.get('/api/analysis', (request, response) => {
  const platform = String(request.query.platform || 'douyin');
  if (!supportedPlatforms.has(platform)) return response.status(400).json({ message: '不支持的平台。' });
  response.json(getMarketingAnalysis(platform));
});

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

app.get('/api/export/materials.csv', (request, response) => {
  const platform = String(request.query.platform || 'douyin');
  if (!supportedPlatforms.has(platform)) return response.status(400).json({ message: '不支持的平台。' });
  const materials = getMaterials({ platform, aiEvidence: 'verified', limit: 2000, sort: 'lastCollectedAt', direction: 'desc' });
  const header = ['平台', '品类', '产品', '品牌', '标题', '作者', '内容方向', '创意形式', '前三秒钩子', 'CTA', '目标人群', '卖点', 'AI声明', 'AI证据类型', '数据质量', '播放', '点赞', '收藏', '评论', '分享', '推荐', '收藏点赞比%', '评论点赞比%', '分享点赞比%', '投流价值分', '来源链接', '采集时间'];
  const rows = materials.map((item) => [
    item.platform, item.productGroup, item.productName, item.brandName, item.title, item.authorName,
    item.contentIntent, item.creativeFormat, item.hookType, item.ctaType, item.targetAudience,
    item.sellingPoints.join('、'), item.aiProof.label, item.aiProof.sourceType, item.materialStatus, item.viewCount,
    item.likeCount, item.favoriteCount, item.commentCount, item.shareCount, item.recommendCount,
    item.favoriteLikeRate, item.commentLikeRate, item.shareLikeRate, item.marketingScore,
    item.sourceUrl, item.lastCollectedAt
  ]);
  const csv = '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="maternal-ai-materials-${platform}.csv"`);
  response.send(csv);
});

app.get('/api/videos/:id', (request, response) => {
  const video = getVideoById(Number(request.params.id));
  if (!video) return response.status(404).json({ message: '视频记录不存在。' });
  response.json(video);
});

app.patch('/api/videos/:id/rights', (request, response) => {
  const allowed = new Set(['unknown', 'authorized', 'denied']);
  const rightsStatus = String(request.body?.rightsStatus || '');
  if (!allowed.has(rightsStatus)) return response.status(400).json({ message: '无效的授权状态。' });
  const video = updateRightsStatus(Number(request.params.id), rightsStatus);
  if (!video) return response.status(404).json({ message: '视频记录不存在。' });
  response.json(video);
});

app.post('/api/videos/:id/download', async (request, response, next) => {
  try {
    const video = await downloadAuthorizedMedia(Number(request.params.id));
    response.json(video);
  } catch (error) {
    next(error);
  }
});

app.post('/api/collect/:platform', (request, response, next) => {
  try {
    const platform = String(request.params.platform);
    if (!supportedPlatforms.has(platform)) return response.status(400).json({ message: '不支持的平台。' });
    const settings = {
      maxResults: request.body?.maxResults,
      maxQueries: request.body?.maxQueries,
      topN: request.body?.topN,
      timeRange: request.body?.timeRange,
      requireAiEvidence: request.body?.requireAiEvidence !== false,
      keywords: Array.isArray(request.body?.keywords)
        ? request.body.keywords.map((keyword) => String(keyword || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 40)
        : []
    };
    if (['douyin', 'channels'].includes(platform) && !settings.keywords.length) {
      return response.status(400).json({ message: `${platform === 'douyin' ? '抖音' : '视频号'}采集只会执行搜索队列中的关键词，请先添加至少一个词。` });
    }
    if (hasActiveCdpJob(platform) || hasActiveBrowserHelperJob(platform) || (platform === 'channels' && hasActiveChannelsDesktopJob())) {
      const activeJob = getRecentJobs(100).find((job) => job.platform === platform && ['queued', 'running'].includes(job.status));
      return response.status(409).json({ message: '该平台已有采集任务在运行，请等待当前任务结束。', jobId: activeJob?.id });
    }
    if (platform === 'channels') {
      const job = startChannelsDesktopCollection(settings);
      savePlatformSearchState(platform, settings.keywords, 'current', { ...settings, jobId: job.id });
      return response.status(202).json(job);
    }
    if (!findBrowserExecutable()) return response.status(503).json({ message: '未找到可用的 Chrome 或 Edge 浏览器。' });
    const canUseBrowserHelper = isBrowserHelperConnected() && !(platform === 'douyin' && settings.requireAiEvidence === false);
    const job = canUseBrowserHelper ? startBrowserHelperCollection(platform, settings) : startCdpCollection(platform, settings);
    if (platform === 'douyin') savePlatformSearchState(platform, settings.keywords, 'current', { ...settings, jobId: job.id });
    response.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

app.post('/api/channels/open-search', async (request, response, next) => {
  try { response.json(await openChannelsPublicSearch(request.body?.keyword)); }
  catch (error) { next(error); }
});

app.get('/api/channels/open-search', async (request, response, next) => {
  try {
    const result = await openChannelsPublicSearch(request.query.keyword);
    response.type('html').send(`<!doctype html><meta charset="utf-8"><title>已在微信中定位</title><style>body{font-family:system-ui;margin:60px;color:#17211f}b{color:#ba3156}</style><h2>已在微信视频号中打开「<b>${String(result.keyword).replace(/[<>&"]/g, '')}</b>」的最热结果</h2><p>请回到微信窗口查看；本页可以关闭。</p>`);
  } catch (error) { next(error); }
});

app.get('/api/deepseek/status', (request, response) => {
  response.json(getDeepSeekStatus(request.deepSeekAccess));
});

app.post('/api/deepseek/configure', async (request, response, next) => {
  try {
    response.json(await configureDeepSeek(request.body?.apiKey, request.body?.model, request.deepSeekAccess));
  } catch (error) {
    next(error);
  }
});

app.post('/api/deepseek/keyword-suggestions', async (request, response, next) => {
  try {
    const result = await suggestKeywords(
      request.body?.keyword,
      Array.isArray(request.body?.existingKeywords) ? request.body.existingKeywords : [],
      { ...request.deepSeekAccess, credentials: request.body?.credentials }
    );
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/browser-helper/heartbeat', (request, response) => {
  response.json(registerBrowserHelper(request.body));
});

app.get('/api/browser-helper/next-task', (_request, response) => {
  const task = claimBrowserHelperTask();
  if (!task) return response.sendStatus(204);
  response.json(task);
});

app.post('/api/browser-helper/tasks/:id/progress', (request, response) => {
  const job = updateBrowserHelperTask(request.params.id, request.body);
  if (!job) return response.status(404).json({ message: '浏览器采集任务不存在或已结束。' });
  response.json(job);
});

app.post('/api/browser-helper/tasks/:id/complete', (request, response) => {
  const job = completeBrowserHelperTask(request.params.id, request.body?.candidates);
  if (!job) return response.status(404).json({ message: '浏览器采集任务不存在或已结束。' });
  response.json(job);
});

app.post('/api/browser-helper/tasks/:id/fail', (request, response) => {
  const job = failBrowserHelperTask(request.params.id, request.body?.message);
  if (!job) return response.status(404).json({ message: '浏览器采集任务不存在。' });
  response.json(job);
});

app.post('/api/browser-helper/setup', (_request, response, next) => {
  try {
    const executablePath = findBrowserExecutable();
    if (!executablePath) return response.status(503).json({ message: '未找到可用的 Chrome 或 Edge 浏览器。' });
    const helperDir = path.join(projectDir, 'browser-helper');
    const browserProcess = spawn(executablePath, ['chrome://extensions/'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    browserProcess.unref();
    const explorerProcess = spawn('explorer.exe', [helperDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    explorerProcess.unref();
    response.json({ ok: true, helperDir });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs', (request, response) => {
  response.json({ jobs: getRecentJobs(request.query.limit || 20) });
});

app.get('/api/jobs/:id', (request, response) => {
  const job = getJob(request.params.id);
  if (!job) return response.status(404).json({ message: '任务不存在。' });
  response.json(job);
});

app.get('/api/keywords', (_request, response) => {
  response.json({ groups: getKeywordGroups() });
});

app.get('/api/rules', (_request, response) => {
  response.json(getRulesSummary());
});

app.put('/api/keywords', (request, response) => {
  const groups = request.body?.groups;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    return response.status(400).json({ message: '关键词分组格式不正确。' });
  }
  response.json({ groups: replaceKeywordGroups(groups) });
});

const mediaDir = path.join(projectDir, 'storage', 'videos');
app.use('/media', express.static(mediaDir, {
  fallthrough: false,
  maxAge: '1h',
  immutable: false,
  setHeaders(response) {
    response.setHeader('Accept-Ranges', 'bytes');
  }
}));

const distDir = path.join(projectDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {
    maxAge: '1h',
    setHeaders(response, filePath) {
      if (filePath.endsWith('index.html')) response.setHeader('Cache-Control', 'no-store');
    }
  }));
  app.get(/.*/, (_request, response, next) => {
    if (_request.path.startsWith('/api/') || _request.path.startsWith('/media/')) return next();
    response.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  if (/^\/api\/deepseek(?:\/|$)/i.test(_request.path || '')) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const status = Number(error.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 500;
    const safeError = String(error.code || '').startsWith('DEEPSEEK_');
    return response.status(status).json({
      message: safeError ? error.message : status === 400 ? '请求格式不正确，请使用有效的 JSON。' : 'DeepSeek 请求未完成，请稍后重试。',
      code: safeError ? error.code : 'DEEPSEEK_REQUEST_FAILED'
    });
  }
  const status = Number(error.status) || 500;
  const exposeMessage = status < 500 || String(error.code || '').startsWith('DEEPSEEK');
  if (status >= 500 && !exposeMessage) console.error(error);
  response.status(status).json({
    message: exposeMessage ? error.message : '服务暂时无法完成请求。',
    detail: exposeMessage ? error.message : undefined,
    jobId: error.jobId,
    code: error.code
  });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`全域短视频投流情报台已启动：http://127.0.0.1:${port}`);
});
