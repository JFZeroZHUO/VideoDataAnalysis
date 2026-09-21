import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { collectDouyin } from './collectors/douyin.mjs';
import { collectXiaohongshu } from './collectors/xiaohongshu.mjs';
import { collectChannels } from './collectors/channels.mjs';
import { findBrowserExecutable } from './collectors/browser.mjs';
import {
  clearPlatformRanking,
  createJob,
  getJob,
  getKeywordGroups,
  projectDir,
  recomputeSystemHeat,
  resolvePendingCandidate,
  updateJob,
  upsertPendingCandidate,
  upsertVideo
} from './db.mjs';
import { buildCustomSearchQueries, buildDouyinCategoryQueries, buildProductQueries } from './query-builder.mjs';
import { analyzeCandidate, rankCandidates } from './ranking.mjs';
import { enrichCandidateDetails } from './detail-enrichment.mjs';
import { normalizeDouyinTimeRange } from './douyin-search-filter.mjs';
import { isStrictLeaderboardEligible, strictRejectionReason } from './metric-quality.mjs';
import { createCollectorConnection, isCollectorConnectionError } from './collector-connection.mjs';

const debuggingPort = 9333;
const debuggingUrl = `http://127.0.0.1:${debuggingPort}`;
const activeJobs = new Map();
const platformSessionCookies = {
  douyin: {
    url: 'https://www.douyin.com',
    names: ['sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt']
  },
  xiaohongshu: {
    url: 'https://www.xiaohongshu.com',
    names: ['web_session']
  },
  channels: {
    url: 'https://channels.weixin.qq.com',
    names: ['wxuin', 'wxsid', 'uin', 'sid']
  }
};
const browserConnection = createCollectorConnection({
  probe: isDebuggingReady,
  connect: () => chromium.connectOverCDP(debuggingUrl, { timeout: 10000 }),
  launch: launchCollectorEndpoint
});

function buildQueries(platform, keywordGroups, maxQueries) {
  return platform === 'douyin'
    ? buildDouyinCategoryQueries(keywordGroups, maxQueries)
    : buildProductQueries(keywordGroups, maxQueries);
}

async function isDebuggingReady() {
  try {
    const response = await fetch(`${debuggingUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function launchCollectorEndpoint() {
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw Object.assign(new Error('未找到 Chrome 或 Edge 浏览器。'), { status: 503 });
  const profilePath = path.join(projectDir, 'data', 'collector-chrome-cdp');
  const child = spawn(executablePath, [
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank'
  ], {
    cwd: projectDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  let launchError;
  child.once('error', (error) => { launchError = error; });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (launchError) throw Object.assign(new Error(`无法启动采集浏览器：${launchError.message}`, { cause: launchError }), { code: 'COLLECTOR_LAUNCH_FAILED' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await isDebuggingReady()) return;
  }
  throw Object.assign(new Error('采集浏览器启动后仍无法连接，请确认 Chrome 或 Edge 可以正常打开。'), { code: 'COLLECTOR_CONNECTION_UNAVAILABLE' });
}

async function readSessionStates(browser) {
  const context = browser.contexts()[0];
  const sessions = { douyin: false, xiaohongshu: false, channels: false };
  if (!context) return sessions;
  await Promise.all(Object.entries(platformSessionCookies).map(async ([platform, config]) => {
    const cookies = await context.cookies(config.url).catch(() => []);
    sessions[platform] = cookies.some((cookie) => config.names.includes(cookie.name) && cookie.value);
  }));
  return sessions;
}

export function hasActiveCdpJob(platform) {
  return activeJobs.has(platform);
}

export function startCdpCollection(platform, options = {}) {
  if (platform === 'douyin' && !buildCustomSearchQueries(options.keywords, 40).length) {
    const error = new Error('抖音采集只执行你加入搜索队列的关键词，请先添加至少一个词。');
    error.status = 400;
    throw error;
  }
  if (activeJobs.size > 0) {
    const current = activeJobs.values().next().value;
    const error = new Error('已有采集任务在运行，请等待当前任务结束。');
    error.status = 409;
    error.jobId = current;
    throw error;
  }
  const id = crypto.randomUUID();
  createJob({ id, platform, settings: {
    ...options,
    requireAiEvidence: options.requireAiEvidence !== false,
    timeRange: platform === 'channels'
      ? (['thirty_days', 'ninety_days', 'half_year', 'unlimited'].includes(options.timeRange) ? options.timeRange : 'half_year')
      : normalizeDouyinTimeRange(options.timeRange)
  } });
  activeJobs.set(platform, id);
  runCollection(id, platform, options).catch(() => {});
  return getJob(id);
}

async function runCollection(jobId, platform, options) {
  const maxResults = Math.min(Math.max(Number(options.maxResults) || 600, 5), 800);
  const maxQueries = Math.min(Math.max(Number(options.maxQueries) || 30, 1), 40);
  const topN = [15, 20].includes(Number(options.topN)) ? Number(options.topN) : 20;
  const requireAiEvidence = options.requireAiEvidence !== false;
  const timeRange = platform === 'channels'
    ? (['thirty_days', 'ninety_days', 'half_year', 'unlimited'].includes(options.timeRange) ? options.timeRange : 'half_year')
    : normalizeDouyinTimeRange(options.timeRange);
  let addedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;
  let searchCardCount = 0;
  let aiCandidateCount = 0;
  let collectionBrowser;
  const update = async (changes) => updateJob(jobId, changes);

  try {
    await update({
      status: 'running',
      phase: 'opening',
      progress: 2,
      startedAt: new Date().toISOString(),
      message: '正在连接已保存的账号会话并启动批量采集'
    });
    const opened = await browserConnection.openPage({
      onRetry: async () => update({
        phase: 'reconnecting',
        progress: 3,
        message: '采集浏览器连接已失效，正在清理旧连接并自动重试（1/1）；不会清除登录资料'
      })
    });
    collectionBrowser = opened.browser;
    const page = opened.page;
    const keywordGroups = getKeywordGroups();
    const queries = Array.isArray(options.keywords) && options.keywords.length
      ? buildCustomSearchQueries(options.keywords, maxQueries)
      : buildQueries(platform, keywordGroups, maxQueries);
    if (platform === 'douyin' && !queries.length) throw new Error('搜索队列为空，未执行任何内置或自动补充关键词。');

    let collected;
    if (platform === 'douyin') collected = await collectDouyin({
      page, queries, maxResults, update, timeRange, requireAiEvidence,
      onQueryFailure: async () => {
        failedCount += 1;
        return failedCount;
      }
    });
    else if (platform === 'xiaohongshu') collected = await collectXiaohongshu({ page, queries, maxResults, update });
    else if (platform === 'channels') collected = await collectChannels({ page, maxResults, update, timeRange });
    else throw new Error('暂不支持该平台。');
    if (platform === 'douyin') {
      searchCardCount = Number(collected.searchCardCount) || 0;
      aiCandidateCount = Number(collected.aiCandidateCount) || 0;
      await update({ searchCardCount, aiCandidateCount, scannedCount: collected.length, collectionDiagnostics: collected.collectionDiagnostics || {} });
      if (searchCardCount > 0 && collected.length === 0) {
        throw new Error(`搜索页已找到 ${searchCardCount} 张视频卡片，但未能解析任何有效视频链接；本次未完成采集，请检查任务中的链接解析诊断。`);
      }
      if (collected.length === 0 && collected.collectionDiagnostics?.skippedQueryCount > 0) {
        throw new Error('本次关键词未能完成抖音原生筛选，未取得有效搜索结果；请检查任务诊断中的筛选失败原因后重试。');
      }
    }
    if (platform === 'channels') {
      searchCardCount = collected.length;
      aiCandidateCount = collected.filter((candidate) => candidate.rawMetrics?.aiEvidenceVerified === true).length;
    }

    const detailCandidates = collected;
    await update({
      phase: 'processing',
      progress: 64,
      scannedCount: collected.length,
      searchCardCount,
      aiCandidateCount,
      message: platform === 'douyin'
        ? requireAiEvidence
          ? `已召回 ${collected.length} 条热门候选，正在逐条打开详情页核验“疑似AI生成”声明`
          : `已召回 ${collected.length} 条热门候选；本轮跳过AI声明核验，仅保留页面实际可见指标，缺失指标留空`
        : `已召回 ${collected.length} 条，正在筛选高相关候选`
    });
    const preliminary = detailCandidates
      .map((candidate) => analyzeCandidate(candidate, keywordGroups))
      .filter((candidate) => candidate.productGroup !== '未分类')
      .sort((a, b) => requireAiEvidence
        ? b.aiConfidence - a.aiConfidence || b.relevanceScore - a.relevanceScore || b.interactionValue - a.interactionValue
        : b.relevanceScore - a.relevanceScore || (b.likeCount || 0) - (a.likeCount || 0))
      .slice(0, platform === 'douyin' ? Math.min(topN * 8, 160) : Math.min(topN * 3, 60));
    const detailed = platform === 'douyin' && !requireAiEvidence
      ? preliminary.map((candidate) => ({
          ...candidate,
          rawMetrics: {
            ...(candidate.rawMetrics || {}),
            aiEvidenceRequired: false,
            aiVerificationSkipped: true,
            collectionScope: 'search_results_only'
          }
        }))
      : await enrichCandidateDetails({ page, platform, candidates: preliminary, update });
    if (platform === 'douyin' && requireAiEvidence) {
      aiCandidateCount = detailed.filter((candidate) => candidate.rawMetrics?.detailAiDeclarationVerified === true).length;
      await update({
        aiCandidateCount,
        message: `详情页已核验 ${detailed.length} 条，确认 ${aiCandidateCount} 条带“疑似AI生成”声明`
      });
    }
    let pendingCount = 0;
    if (platform === 'douyin' && requireAiEvidence) {
      for (const candidate of detailed) {
        if (candidate.rawMetrics?.detailAiDeclarationVerified !== true) continue;
        if (isStrictLeaderboardEligible(candidate)) resolvePendingCandidate(platform, candidate.sourceUrl);
        else {
          upsertPendingCandidate(candidate, strictRejectionReason(candidate));
          pendingCount += 1;
        }
      }
    }
    if (platform === 'channels') pendingCount = detailed.filter((candidate) => !isStrictLeaderboardEligible(candidate)).length;
    const materialCandidates = platform === 'douyin' && requireAiEvidence
      ? detailed.filter((candidate) => candidate.rawMetrics?.detailAiDeclarationVerified === true)
      : detailed;
    const analyzedMaterials = materialCandidates.map((candidate) => analyzeCandidate(candidate, keywordGroups));
    const ranked = rankCandidates(detailed, keywordGroups, topN, { requireAiEvidence });
    const rankedByUrl = new Map(ranked.map((candidate) => [candidate.sourceUrl, candidate]));
    if (ranked.length) clearPlatformRanking(platform);
    await update({ phase: 'ranking', progress: 86, message: `正在沉淀 ${analyzedMaterials.length} 条素材并生成 Top ${ranked.length} 精选榜` });
    for (const material of analyzedMaterials) {
      try {
        const rankedVersion = rankedByUrl.get(material.sourceUrl);
        const result = upsertVideo(rankedVersion ? { ...material, ...rankedVersion } : { ...material, rankPosition: null, rankingScore: null });
        if (result.added) addedCount += 1;
        else updatedCount += 1;
      } catch {
        failedCount += 1;
      }
      await update({ addedCount, updatedCount, failedCount });
    }
    if (ranked.length) recomputeSystemHeat(platform);
    await update({
      status: 'completed',
      phase: 'completed',
      progress: 100,
      scannedCount: collected.length,
      searchCardCount,
      aiCandidateCount,
      addedCount,
      updatedCount,
      failedCount,
      finishedAt: new Date().toISOString(),
      message: requireAiEvidence
        ? `AI素材库已沉淀 ${analyzedMaterials.length} 条：新增 ${addedCount} 条、更新 ${updatedCount} 条；本轮精选榜 ${ranked.length} 条，${pendingCount} 条证据或指标待补采`
        : `热门搜索素材已沉淀 ${analyzedMaterials.length} 条：新增 ${addedCount} 条、更新 ${updatedCount} 条；已跳过AI声明核验，搜索页未公开的指标留空（不影响素材展示）`
    });
    await page.bringToFront().catch(() => {});
  } catch (error) {
    const browserClosed = isCollectorConnectionError(error);
    if (browserClosed && collectionBrowser) browserConnection.invalidate(collectionBrowser);
    await update({
      status: 'failed',
      phase: 'failed',
      progress: 100,
      addedCount,
      updatedCount,
      failedCount,
      ...(error.collectionDiagnostics ? { collectionDiagnostics: error.collectionDiagnostics } : {}),
      finishedAt: new Date().toISOString(),
      message: error.code === 'COLLECTOR_STARTUP_FAILED'
        ? '采集浏览器未能启动：已清理失效连接并自动重试 1 次，仍无法创建采集页。请确认 Chrome 或 Edge 能正常打开后重试。'
        : browserClosed
        ? '采集浏览器连接已中断，旧连接已清理；已保存的素材不受影响。再次点击搜索将重新连接。'
        : error.message || '采集失败',
      errorSummary: `${error.stack || error.message || error}${error.cause ? `\n原因：${error.cause.stack || error.cause.message || error.cause}` : ''}`.slice(0, 3000)
    });
  } finally {
    activeJobs.delete(platform);
  }
}

export async function getCdpStatus() {
  try {
    const browser = await browserConnection.ensure({ allowLaunch: false });
    if (!browser) return { ready: false, connected: false, sessions: { douyin: false, xiaohongshu: false, channels: false } };
    return {
      ready: true,
      connected: browser.isConnected(),
      sessions: await readSessionStates(browser)
    };
  } catch {
    return {
      ready: false,
      connected: false,
      sessions: { douyin: false, xiaohongshu: false, channels: false }
    };
  }
}
