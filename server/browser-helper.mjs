import crypto from 'node:crypto';
import {
  clearPlatformRanking,
  createJob,
  getJob,
  getKeywordGroups,
  recomputeSystemHeat,
  resolvePendingCandidate,
  updateJob,
  upsertPendingCandidate,
  upsertVideo
} from './db.mjs';
import { buildCustomSearchQueries, buildDouyinCategoryQueries, buildProductQueries } from './query-builder.mjs';
import { analyzeCandidate, rankCandidates } from './ranking.mjs';
import { normalizeDouyinTimeRange } from './douyin-search-filter.mjs';
import { isStrictLeaderboardEligible, strictRejectionReason } from './metric-quality.mjs';

const heartbeatTtlMs = 45_000;
const taskTimeoutMs = 40 * 60_000;
const tasks = new Map();
const queue = [];
const activeJobs = new Map();
let helperState = { lastSeenAt: 0, version: null };

function versionAtLeast(version, minimum) {
  const current = String(version || '').split('.').map((part) => Number(part) || 0);
  const required = String(minimum).split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    if ((current[index] || 0) > (required[index] || 0)) return true;
    if ((current[index] || 0) < (required[index] || 0)) return false;
  }
  return true;
}

function buildQueries(platform, keywordGroups, maxQueries) {
  return platform === 'douyin'
    ? buildDouyinCategoryQueries(keywordGroups, maxQueries)
    : buildProductQueries(keywordGroups, maxQueries);
}

function finishAsFailed(task, message) {
  if (!task || ['completed', 'failed'].includes(task.status)) return;
  task.status = 'failed';
  task.finishedAt = new Date().toISOString();
  updateJob(task.jobId, {
    status: 'failed',
    phase: 'failed',
    progress: 100,
    finishedAt: task.finishedAt,
    message,
    errorSummary: message
  });
  activeJobs.delete(task.platform);
}

function cleanupExpiredTasks() {
  const now = Date.now();
  for (const task of tasks.values()) {
    if (task.status === 'claimed' && task.claimedAt && now - task.claimedAt > taskTimeoutMs) {
      finishAsFailed(task, '日常浏览器助手长时间没有响应，请确认 Chrome 仍在运行后重试。');
    }
  }
}

export function registerBrowserHelper(payload = {}) {
  helperState = {
    lastSeenAt: Date.now(),
    version: String(payload.version || '1.0.0').slice(0, 30)
  };
  return getBrowserHelperStatus();
}

export function getBrowserHelperStatus() {
  cleanupExpiredTasks();
  const ageMs = helperState.lastSeenAt ? Date.now() - helperState.lastSeenAt : null;
  const heartbeatAlive = ageMs !== null && ageMs < heartbeatTtlMs;
  const compatible = versionAtLeast(helperState.version, '2.2.0');
  return {
    connected: heartbeatAlive && compatible,
    heartbeatAlive,
    compatible,
    upgradeRequired: heartbeatAlive && !compatible,
    lastSeenAt: helperState.lastSeenAt ? new Date(helperState.lastSeenAt).toISOString() : null,
    version: helperState.version
  };
}

export function isBrowserHelperConnected() {
  return getBrowserHelperStatus().connected;
}

export function hasActiveBrowserHelperJob(platform) {
  cleanupExpiredTasks();
  return activeJobs.has(platform);
}

export function startBrowserHelperCollection(platform, options = {}) {
  if (platform === 'douyin' && !buildCustomSearchQueries(options.keywords, 40).length) {
    const error = new Error('抖音采集只执行你加入搜索队列的关键词，请先添加至少一个词。');
    error.status = 400;
    throw error;
  }
  if (!isBrowserHelperConnected()) {
    const error = new Error('日常浏览器助手尚未连接，将改用专用采集窗口。');
    error.status = 503;
    throw error;
  }
  if (activeJobs.size > 0) {
    const currentJobId = activeJobs.values().next().value;
    const error = new Error('已有采集任务在运行，请等待当前任务结束。');
    error.status = 409;
    error.jobId = currentJobId;
    throw error;
  }
  const maxResults = Math.min(Math.max(Number(options.maxResults) || 600, 5), 800);
  const maxQueries = Math.min(Math.max(Number(options.maxQueries) || 30, 1), 40);
  const topN = [15, 20].includes(Number(options.topN)) ? Number(options.topN) : 20;
  const jobId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  createJob({ id: jobId, platform, settings: {
    ...options,
    requireAiEvidence: options.requireAiEvidence !== false,
    timeRange: platform === 'channels'
      ? (['thirty_days', 'ninety_days', 'half_year', 'unlimited'].includes(options.timeRange) ? options.timeRange : 'half_year')
      : normalizeDouyinTimeRange(options.timeRange)
  } });
  updateJob(jobId, {
    status: 'running',
    phase: 'queued',
    progress: 2,
    startedAt: new Date().toISOString(),
    message: '任务已发送到日常 Chrome，正在复用现有账号会话'
  });
  const task = {
    id: taskId,
    jobId,
    platform,
    maxResults,
    topN,
    requireAiEvidence: options.requireAiEvidence !== false,
    timeRange: platform === 'channels'
      ? (['thirty_days', 'ninety_days', 'half_year', 'unlimited'].includes(options.timeRange) ? options.timeRange : 'half_year')
      : normalizeDouyinTimeRange(options.timeRange),
    queries: Array.isArray(options.keywords) && options.keywords.length
      ? buildCustomSearchQueries(options.keywords, maxQueries)
      : buildQueries(platform, getKeywordGroups(), maxQueries),
    status: 'queued',
    createdAt: Date.now(),
    claimedAt: null
  };
  tasks.set(taskId, task);
  queue.push(taskId);
  activeJobs.set(platform, jobId);
  return getJob(jobId);
}

export function claimBrowserHelperTask() {
  registerBrowserHelper({ version: helperState.version });
  cleanupExpiredTasks();
  while (queue.length) {
    const task = tasks.get(queue.shift());
    if (!task || task.status !== 'queued') continue;
    task.status = 'claimed';
    task.claimedAt = Date.now();
    updateJob(task.jobId, {
      phase: 'opening',
      progress: 4,
      message: '日常 Chrome 已接收任务，正在打开平台搜索页'
    });
    return {
      id: task.id,
      jobId: task.jobId,
      platform: task.platform,
      maxResults: task.maxResults,
      topN: task.topN,
      requireAiEvidence: task.requireAiEvidence,
      timeRange: task.timeRange,
      queries: task.queries
    };
  }
  return null;
}

export function updateBrowserHelperTask(taskId, progress = {}) {
  registerBrowserHelper({ version: helperState.version });
  const task = tasks.get(taskId);
  if (!task || !['queued', 'claimed'].includes(task.status)) return null;
  task.claimedAt = Date.now();
  const safeProgress = Math.min(Math.max(Number(progress.progress) || 4, 2), 82);
  const changes = {
    phase: String(progress.phase || 'searching').slice(0, 50),
    progress: safeProgress,
    scannedCount: Math.max(Number(progress.scannedCount) || 0, 0),
    message: String(progress.message || '正在通过日常 Chrome 批量采集').slice(0, 300)
  };
  if (Number.isFinite(Number(progress.searchCardCount))) changes.searchCardCount = Math.max(Number(progress.searchCardCount), 0);
  if (Number.isFinite(Number(progress.aiCandidateCount))) changes.aiCandidateCount = Math.max(Number(progress.aiCandidateCount), 0);
  if (Number.isFinite(Number(progress.failedCount))) changes.failedCount = Math.max(Number(progress.failedCount), 0);
  updateJob(task.jobId, changes);
  return getJob(task.jobId);
}

function normalizeCandidate(candidate, platform) {
  if (!candidate || typeof candidate !== 'object') return null;
  const sourceUrl = String(candidate.sourceUrl || '').slice(0, 2000);
  if (!sourceUrl.startsWith('https://')) return null;
  return {
    ...candidate,
    platform,
    sourceUrl,
    platformItemId: candidate.platformItemId ? String(candidate.platformItemId).slice(0, 200) : null,
    title: String(candidate.title || '未命名视频').slice(0, 500),
    rawMetrics: candidate.rawMetrics && typeof candidate.rawMetrics === 'object' ? candidate.rawMetrics : {},
    rawText: String(candidate.rawText || '').slice(0, 2000)
  };
}

export function completeBrowserHelperTask(taskId, candidates = []) {
  registerBrowserHelper({ version: helperState.version });
  const task = tasks.get(taskId);
  if (!task || task.status !== 'claimed') return null;
  const keywordGroups = getKeywordGroups();
  const unique = new Map();
  for (const rawCandidate of Array.isArray(candidates) ? candidates.slice(0, 800) : []) {
    const candidate = normalizeCandidate(rawCandidate, task.platform);
    if (candidate) unique.set(candidate.sourceUrl, candidate);
  }
  let pendingCount = 0;
  if (task.platform === 'douyin' && task.requireAiEvidence) {
    for (const candidate of unique.values()) {
      if (isStrictLeaderboardEligible(candidate)) resolvePendingCandidate(task.platform, candidate.sourceUrl);
      else {
        upsertPendingCandidate(candidate, strictRejectionReason(candidate));
        pendingCount += 1;
      }
    }
  }
  if (task.platform === 'channels') {
    for (const candidate of unique.values()) {
      if (!isStrictLeaderboardEligible(candidate)) pendingCount += 1;
    }
  }
  const analyzedMaterials = [...unique.values()].map((candidate) => analyzeCandidate(candidate, keywordGroups));
  const ranked = rankCandidates([...unique.values()], keywordGroups, task.topN, { requireAiEvidence: task.requireAiEvidence });
  const rankedByUrl = new Map(ranked.map((candidate) => [candidate.sourceUrl, candidate]));
  if (ranked.length) clearPlatformRanking(task.platform);
  let addedCount = 0;
  let updatedCount = 0;
  let failedCount = getJob(task.jobId)?.failedCount || 0;
  for (const material of analyzedMaterials) {
    try {
      const rankedVersion = rankedByUrl.get(material.sourceUrl);
      const result = upsertVideo(rankedVersion ? { ...material, ...rankedVersion } : { ...material, rankPosition: null, rankingScore: null });
      if (result.added) addedCount += 1;
      else updatedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  if (ranked.length) recomputeSystemHeat(task.platform);
  task.status = 'completed';
  task.finishedAt = new Date().toISOString();
  updateJob(task.jobId, {
    status: 'completed',
    phase: 'completed',
    progress: 100,
    scannedCount: unique.size,
    addedCount,
    updatedCount,
    failedCount,
    finishedAt: task.finishedAt,
    message: task.requireAiEvidence
      ? `AI素材库已沉淀 ${analyzedMaterials.length} 条：新增 ${addedCount} 条、更新 ${updatedCount} 条；本轮精选榜 ${ranked.length} 条，${pendingCount} 条证据或指标待补采`
      : `热门搜索素材已沉淀 ${analyzedMaterials.length} 条：新增 ${addedCount} 条、更新 ${updatedCount} 条；未进入详情页核验AI声明`
  });
  activeJobs.delete(task.platform);
  return getJob(task.jobId);
}

export function failBrowserHelperTask(taskId, message) {
  registerBrowserHelper({ version: helperState.version });
  const task = tasks.get(taskId);
  if (!task) return null;
  finishAsFailed(task, String(message || '日常浏览器采集未完成').slice(0, 1000));
  return getJob(task.jobId);
}
