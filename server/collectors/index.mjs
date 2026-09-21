import crypto from 'node:crypto';
import { collectDouyin } from './douyin.mjs';
import { collectXiaohongshu } from './xiaohongshu.mjs';
import { collectChannels } from './channels.mjs';
import { launchCollectorBrowser } from './browser.mjs';
import {
  createJob,
  getJob,
  getKeywordGroups,
  recomputeSystemHeat,
  updateJob,
  upsertVideo
} from '../db.mjs';
import { enrichCollectedVideo } from '../classify.mjs';

const activeJobs = new Map();
const aiSignals = ['AI动画', 'AI数字人', 'AIGC', '3D动画'];

function buildQueries(keywordGroups, maxQueries) {
  const enabled = [];
  for (const entries of Object.values(keywordGroups)) {
    for (const entry of entries) {
      if (entry.enabled !== false) enabled.push(entry.keyword);
    }
  }
  const queries = [];
  for (let index = 0; index < enabled.length && queries.length < maxQueries; index += 1) {
    queries.push(`${enabled[index]} ${aiSignals[index % aiSignals.length]}`);
  }
  return queries;
}

export function hasActiveJob(platform) {
  return activeJobs.has(platform);
}

export function startCollection(platform, options = {}) {
  if (activeJobs.has(platform)) {
    const error = new Error('该平台已有采集任务在运行。');
    error.status = 409;
    error.jobId = activeJobs.get(platform);
    throw error;
  }
  const id = crypto.randomUUID();
  createJob({ id, platform });
  activeJobs.set(platform, id);
  runCollection(id, platform, options).catch(() => {});
  return getJob(id);
}

async function runCollection(jobId, platform, options) {
  const startedAt = new Date().toISOString();
  const maxResults = Math.min(Math.max(Number(options.maxResults) || 60, 5), 200);
  const maxQueries = Math.min(Math.max(Number(options.maxQueries) || 10, 1), 30);
  let context;
  let addedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;

  const update = async (changes) => updateJob(jobId, changes);
  try {
    await update({ status: 'running', phase: 'opening', progress: 2, startedAt, message: '正在启动安全采集窗口' });
    const keywordGroups = getKeywordGroups();
    const queries = buildQueries(keywordGroups, maxQueries);
    context = await launchCollectorBrowser(platform);
    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    let collected;
    if (platform === 'douyin') collected = await collectDouyin({ page, queries, maxResults, update });
    else if (platform === 'xiaohongshu') collected = await collectXiaohongshu({ page, queries, maxResults, update });
    else if (platform === 'channels') collected = await collectChannels({ page, maxResults, update });
    else throw new Error('暂不支持该平台。');

    await update({ phase: 'processing', progress: 84, scannedCount: collected.length, message: '正在去重、识别产品组与 AI 类型' });
    for (const candidate of collected) {
      try {
        const enriched = enrichCollectedVideo(candidate, keywordGroups);
        if (enriched.productGroup === '未分类') continue;
        const result = upsertVideo(enriched);
        if (result.added) addedCount += 1;
        else updatedCount += 1;
      } catch {
        failedCount += 1;
      }
      await update({ addedCount, updatedCount, failedCount });
    }

    recomputeSystemHeat(platform);
    await update({
      status: 'completed',
      phase: 'completed',
      progress: 100,
      addedCount,
      updatedCount,
      failedCount,
      finishedAt: new Date().toISOString(),
      message: `采集完成：新增 ${addedCount} 条，更新 ${updatedCount} 条`
    });
  } catch (error) {
    await update({
      status: 'failed',
      phase: 'failed',
      progress: 100,
      addedCount,
      updatedCount,
      failedCount,
      finishedAt: new Date().toISOString(),
      message: error.message || '采集失败',
      errorSummary: String(error.stack || error.message || error).slice(0, 3000)
    });
  } finally {
    activeJobs.delete(platform);
    if (context) await context.close().catch(() => {});
  }
}
