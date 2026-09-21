import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  clearPlatformRanking,
  createJob,
  getJob,
  getKeywordGroups,
  projectDir,
  recomputeSystemHeat,
  updateJob,
  upsertVideo
} from './db.mjs';
import { analyzeCandidate, rankCandidates } from './ranking.mjs';
import { isStrictLeaderboardEligible, strictRejectionReason } from './metric-quality.mjs';

const activeJobs = new Map();
const workerPath = path.join(projectDir, 'server', 'windows', 'wechat-channels-public.ps1');
const workerBootstrapCommand = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$source = [System.IO.File]::ReadAllText($env:MATERNAL_AI_WORKER_PATH, [System.Text.UTF8Encoding]::new($false))',
  '$script = [ScriptBlock]::Create($source)',
  '& $script -RequestPath $env:MATERNAL_AI_REQUEST_PATH -OutputPath $env:MATERNAL_AI_OUTPUT_PATH'
].join('; ');

function spawnChannelsWorker(requestPath, outputPath, stdio) {
  return spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', workerBootstrapCommand
  ], {
    cwd: projectDir,
    windowsHide: true,
    stdio,
    env: {
      ...process.env,
      MATERNAL_AI_WORKER_PATH: workerPath,
      MATERNAL_AI_REQUEST_PATH: requestPath,
      MATERNAL_AI_OUTPUT_PATH: outputPath
    }
  });
}

function parseJsonLine(line, prefix) {
  if (!line.startsWith(prefix)) return null;
  try { return JSON.parse(line.slice(prefix.length)); }
  catch { return null; }
}

function consumeLines(buffer, onLine) {
  const parts = buffer.split(/\r?\n/);
  const remainder = parts.pop() || '';
  for (const line of parts) if (line.trim()) onLine(line.trim());
  return remainder;
}

function summarizeWorkerError(value, fallback) {
  const firstLine = String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return (firstLine || fallback).slice(0, 500);
}

function normalizeKeywords(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const keyword = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!keyword || seen.has(keyword.toLowerCase()) || result.length >= 40) continue;
    seen.add(keyword.toLowerCase());
    result.push(keyword);
  }
  return result;
}

export function hasActiveChannelsDesktopJob() {
  return activeJobs.has('channels');
}

export async function getChannelsDesktopStatus() {
  const available = process.platform === 'win32' && fs.existsSync(workerPath);
  if (!available) return { available: false, wechatRunning: false, mode: 'wechat_public_search' };
  const wechatRunning = await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', "if (Get-Process WeChat -ErrorAction SilentlyContinue) { '1' } else { '0' }"], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(output.trim().endsWith('1')));
  });
  return { available, wechatRunning, mode: 'wechat_public_search' };
}

export function startChannelsDesktopCollection(options = {}) {
  if (process.platform !== 'win32' || !fs.existsSync(workerPath)) {
    const error = new Error('当前电脑不支持微信视频号公域采集助手。');
    error.status = 503;
    throw error;
  }
  if (activeJobs.has('channels')) {
    const error = new Error('已有视频号公域采集任务在运行。');
    error.status = 409;
    error.jobId = activeJobs.get('channels');
    throw error;
  }
  const keywords = normalizeKeywords(options.keywords);
  if (!keywords.length) {
    const error = new Error('请先输入至少一个视频号搜索关键词。');
    error.status = 400;
    throw error;
  }
  const topN = [15, 20].includes(Number(options.topN)) ? Number(options.topN) : 20;
  const jobId = crypto.randomUUID();
  createJob({ id: jobId, platform: 'channels', settings: { ...options, keywords, requireAiEvidence: options.requireAiEvidence !== false } });
  activeJobs.set('channels', jobId);
  runDesktopCollection(jobId, { keywords, topN }).catch(() => {});
  return getJob(jobId);
}

export async function openChannelsPublicSearch(keyword) {
  const [safeKeyword] = normalizeKeywords([keyword]);
  if (!safeKeyword) throw Object.assign(new Error('缺少可定位的视频号关键词。'), { status: 400 });
  const requestPath = path.join(projectDir, 'data', `channels-open-${crypto.randomUUID()}.request.json`);
  const outputPath = `${requestPath}.result.json`;
  fs.writeFileSync(requestPath, JSON.stringify({ keywords: [safeKeyword], topN: 15, openOnly: true }), 'utf8');
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawnChannelsWorker(requestPath, outputPath, ['ignore', 'ignore', 'pipe']);
      let errorText = '';
      child.stderr.on('data', (chunk) => { errorText += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(true) : reject(new Error(summarizeWorkerError(errorText, '未能在微信中定位该关键词。'))));
    });
    return { ok: result, keyword: safeKeyword };
  } finally {
    for (const file of [requestPath, outputPath]) fs.rmSync(file, { force: true });
  }
}

async function runDesktopCollection(jobId, request) {
  const requestPath = path.join(projectDir, 'data', `channels-${jobId}.request.json`);
  const outputPath = path.join(projectDir, 'data', `channels-${jobId}.result.json`);
  const startedAt = new Date().toISOString();
  let stderr = '';
  try {
    fs.writeFileSync(requestPath, JSON.stringify(request), 'utf8');
    updateJob(jobId, {
      status: 'running', phase: 'opening', progress: 2, startedAt,
      message: '正在打开「视频号右上角搜索」公域入口'
    });
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnChannelsWorker(requestPath, outputPath, ['ignore', 'pipe', 'pipe']);
      let stdoutBuffer = '';
      const onLine = (line) => {
        const progress = parseJsonLine(line, 'PROGRESS ');
        if (!progress) return;
        updateJob(jobId, {
          phase: String(progress.phase || 'searching').slice(0, 40),
          progress: Math.min(Math.max(Number(progress.progress) || 4, 2), 82),
          searchCardCount: Math.max(Number(progress.searchCardCount) || 0, 0),
          aiCandidateCount: Math.max(Number(progress.aiCandidateCount) || 0, 0),
          scannedCount: Math.max(Number(progress.scannedCount) || 0, 0),
          message: String(progress.message || '正在搜索视频号公域素材').slice(0, 300)
        });
      };
      child.stdout.on('data', (chunk) => { stdoutBuffer = consumeLines(stdoutBuffer + chunk.toString('utf8'), onLine); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => { if (stdoutBuffer.trim()) onLine(stdoutBuffer.trim()); resolve(code); });
    });
    if (exitCode !== 0) throw new Error(summarizeWorkerError(stderr, '视频号公域采集助手未能完成任务。'));
    if (!fs.existsSync(outputPath)) throw new Error('视频号采集助手没有返回结果。');
    const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const keywordGroups = getKeywordGroups();
    const unique = new Map();
    for (const candidate of candidates) {
      if (!candidate?.sourceUrl || !candidate?.title) continue;
      unique.set(candidate.sourceUrl, { ...candidate, platform: 'channels' });
    }
    const analyzed = [...unique.values()].map((candidate) => analyzeCandidate(candidate, keywordGroups));
    const eligible = [...unique.values()].filter(isStrictLeaderboardEligible);
    const ranked = rankCandidates(eligible, keywordGroups, request.topN);
    const rankedByUrl = new Map(ranked.map((candidate) => [candidate.sourceUrl, candidate]));
    if (ranked.length) clearPlatformRanking('channels');
    let addedCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    for (const material of analyzed) {
      try {
        const rankedVersion = rankedByUrl.get(material.sourceUrl);
        const result = upsertVideo(rankedVersion ? { ...material, ...rankedVersion } : { ...material, rankPosition: null, rankingScore: null });
        if (result.added) addedCount += 1;
        else updatedCount += 1;
      } catch { failedCount += 1; }
    }
    if (ranked.length) recomputeSystemHeat('channels');
    const rejected = [...unique.values()].filter((candidate) => !isStrictLeaderboardEligible(candidate));
    updateJob(jobId, {
      status: 'completed', phase: 'completed', progress: 100,
      searchCardCount: Number(payload.searchCardCount) || candidates.length,
      aiCandidateCount: eligible.length, scannedCount: candidates.length,
      addedCount, updatedCount, failedCount, finishedAt: new Date().toISOString(),
      message: `公域搜索完成：详情页采集 ${candidates.length} 条，明确AI证据且指标完整 ${eligible.length} 条，待补证 ${rejected.length} 条`,
      errorSummary: rejected.slice(0, 8).map((item) => strictRejectionReason(item)).filter(Boolean).join('；').slice(0, 1200)
    });
  } catch (error) {
    updateJob(jobId, {
      status: 'failed', phase: 'failed', progress: 100, finishedAt: new Date().toISOString(),
      message: error.message || '视频号公域采集失败',
      errorSummary: String(error.stack || error.message || error).slice(0, 3000)
    });
  } finally {
    activeJobs.delete('channels');
    for (const file of [requestPath, outputPath]) fs.rmSync(file, { force: true });
  }
}
