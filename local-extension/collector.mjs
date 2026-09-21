import { extractSearchCards, extractDouyinDetail, normalizeDouyinRows } from 'douyin-dom-core';
import { applyDouyinPopularFilters } from '../server/douyin-search-filter.mjs';
import { sourceUrlFromDouyinModalUrl } from '../server/douyin-card-schema.mjs';
import { parseCompactNumber } from '../server/number-utils.mjs';

// These functions are injected as functions, never as page-provided source strings.
export function inspectDouyinPage() {
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const captcha = [...document.querySelectorAll('iframe[src*="captcha"], iframe[src*="verify"], [id*="captcha"], [class*="captcha"]')].some(visible);
  const dialogs = [...document.querySelectorAll('[role="dialog"], [class*="login-panel"], [class*="login-modal"], [data-e2e="login-dialog"]')].filter(visible);
  const dialogText = dialogs.map((item) => item.innerText || '').join('\n');
  const verification = captcha || /请完成.{0,12}验证|拖动滑块|请选择所有符合|请依次点击/.test(dialogText);
  const login = !verification && /扫码登录|验证码登录|登录后.{0,12}(?:查看|搜索)|手机号登录/.test(dialogText);
  return { verification, login, count: document.querySelectorAll('.search-result-card, a[href*="/video/"], a[href*="modal_id="]').length,
    detail: Boolean(document.querySelector('[data-e2e="video-detail"]')),
    noResults: /暂无搜索结果|没有找到相关结果|未找到相关视频/.test(document.body?.innerText || '') };
}

export function scrollDouyinResults() {
  const cards = [...document.querySelectorAll('.search-result-card, [data-e2e="search-video-item"]')];
  const last = cards.at(-1);
  if (last) last.scrollIntoView({ block: 'end', behavior: 'instant' });
  else window.scrollBy(0, 800);
  // Search results can live in a scrolling container instead of the document.
  for (let element = last?.parentElement; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 50) {
      element.scrollBy(0, 800); break;
    }
  }
}

export function normalizeSearchCandidate(row, querySpec, filterState) {
  const sourceUrl = sourceUrlFromDouyinModalUrl(row.sourceUrl);
  if (!sourceUrl) return null;
  const likeCount = row.visibleLikeText ? parseCompactNumber(row.visibleLikeText) : null;
  const candidate = normalizeDouyinRows([{ ...row, sourceUrl, visibleLikeCount: likeCount }], querySpec, filterState)[0];
  // Claims in titles (e.g. "300万播放教程") are not measured public metrics.
  Object.assign(candidate, { viewCount: null, likeCount, favoriteCount: null, commentCount: null, shareCount: null,
    recommendCount: null, platformAiBadge: false, platformAiLabel: null, aiDeclared: false });
  candidate.rawMetrics = { ...candidate.rawMetrics, mediaUrl: null, platformAiBadgeVerified: false, platformAiLabel: null,
    metricScope: 'search_card', metricsVerified: false, metricCoverage: likeCount === null ? 0 : 1,
    metricMissing: ['likeCount', 'favoriteCount', 'commentCount', 'shareCount'].filter((key) => key !== 'likeCount' || likeCount === null),
    metricEvidence: { likeCount: { value: likeCount, text: row.visibleLikeText || null,
      selector: likeCount === null ? null : '搜索卡片时长后的可见点赞数', verified: likeCount !== null } },
    detailAiDeclarationChecked: false, detailAiDeclarationVerified: false, aiDeclarationScope: 'search_card' };
  return candidate;
}

export function matchesDouyinDestination(value, expected) {
  try {
    const actual = new URL(value); const target = new URL(expected);
    if (actual.origin !== 'https://www.douyin.com' || target.origin !== actual.origin) return false;
    const video = sourceUrlFromDouyinModalUrl(target.href);
    if (video) return sourceUrlFromDouyinModalUrl(actual.href) === video;
    const actualWord = actual.pathname.match(/^\/(?:root\/)?search\/(.+)$/)?.[1];
    const targetWord = target.pathname.match(/^\/(?:root\/)?search\/(.+)$/)?.[1];
    if (targetWord) return Boolean(actualWord && decodeURIComponent(actualWord) === decodeURIComponent(targetWord));
    return actual.pathname === target.pathname;
  } catch { return false; }
}

export function createCollector(chromeApi, options = {}) {
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const filters = options.applyFilters || applyDouyinPopularFilters;
  const maxScrollRounds = options.maxScrollRounds ?? 12;
  const attentionPolls = options.attentionPolls ?? 200;
  let activeTabId = null;
  let running = false;

  async function tab(tabId) {
    const current = await chromeApi.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error('采集标签页已关闭；已入库素材保留，请重新开始搜索并保持抖音标签页打开。');
    const url = new URL(current.url || current.pendingUrl || 'about:blank');
    if (url.origin !== 'https://www.douyin.com') throw new Error('采集标签页已离开抖音，任务已停止。');
    return current;
  }
  async function evaluate(tabId, func, argument) {
    await tab(tabId);
    const results = await chromeApi.scripting.executeScript({ target: { tabId }, func, args: argument === undefined ? [] : [argument] });
    if (!results?.length || results[0].error) throw new Error('读取抖音页面失败，请确认页面已加载后重试。');
    return results[0].result;
  }
  async function navigate(tabId, url) {
    await chromeApi.tabs.update(tabId, { url });
    for (let index = 0; index < 60; index += 1) {
      const current = await chromeApi.tabs.get(tabId).catch(() => null);
      if (!current) throw new Error('采集标签页已关闭，请重新开始搜索。');
      if (matchesDouyinDestination(current.url, url) && current.status === 'complete') { await wait(1300); return; }
      await wait(500);
    }
    throw new Error('抖音页面加载超时，请检查网络后重新搜索。');
  }
  async function ready(tabId, hooks, { detail = false } = {}) {
    let awaitingUser = false;
    for (let index = 0; index < attentionPolls; index += 1) {
      const state = await evaluate(tabId, inspectDouyinPage);
      if (state.verification || state.login) {
        if (!awaitingUser) { await chromeApi.tabs.update(tabId, { active: true }); awaitingUser = true; }
        await hooks.progress({ phase: state.verification ? 'waiting_verification' : 'waiting_login',
          message: state.verification ? '已暂停：请在抖音标签页手动完成安全验证，完成后自动继续。' : '已暂停：请在抖音标签页登录自己的账号，完成后自动继续。' });
      } else if ((detail ? state.detail : state.count > 0 || state.noResults)) return state;
      else if (!awaitingUser && index >= 10) throw new Error(detail ? '视频详情没有加载或不可访问，不能核验 AI 声明。' : '搜索页没有加载出可识别的视频卡片；请在抖音确认关键词结果后重试。');
      await wait(3000);
    }
    throw new Error('等待登录或安全验证超时；已入库素材保留，完成验证后请重新搜索。');
  }

  async function openDouyin() {
    const current = activeTabId ? await chromeApi.tabs.get(activeTabId).catch(() => null) : null;
    if (current && new URL(current.url || 'about:blank').origin === 'https://www.douyin.com') {
      await chromeApi.tabs.update(current.id, { active: true });
      if (chromeApi.windows?.update) await chromeApi.windows.update(current.windowId, { focused: true });
      return { opened: true, tabId: current.id };
    }
    const created = await chromeApi.tabs.create({ url: 'https://www.douyin.com/', active: true });
    activeTabId = created.id;
    return { opened: true, tabId: created.id };
  }

  async function runTask(task, hooks) {
    if (running) throw new Error('已有采集任务正在运行，请等待当前任务完成。');
    const keywords = (task.keywords || []).filter((value) => typeof value === 'string' && value.trim());
    if (!keywords.length) throw new Error('请先添加要搜索的关键词。');
    // Rebuild from user-confirmed keywords: never accept a hidden expanded query list.
    const queries = [...new Set(keywords.map((value) => value.trim()))].map((keyword) => ({ query: keyword, keyword }));
    if (queries.length > 40) throw new Error('一次最多搜索40个关键词，请分批执行。');
    const requestedLimit = Number(task.maxResults);
    const limit = Math.max(queries.length, Math.min(2000, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 200)));
    const queryBudget = (index) => Math.floor(limit / queries.length) + (index < limit % queries.length ? 1 : 0);
    const diagnostics = { searchCardCount: 0, extractedCardCount: 0, collectedCount: 0, linkFailureCount: 0,
      skippedQueryCount: 0, failureReasons: {}, failureSamples: [] };
    const stored = new Set();
    let detailTabId = null;
    let successfulQueries = 0;
    let acceptedTotal = 0;
    let budgetReachedQueries = 0;
    running = true;
    const warn = (query, reason, message) => {
      diagnostics.failureReasons[reason] = (diagnostics.failureReasons[reason] || 0) + 1;
      if (diagnostics.failureSamples.length < 20) diagnostics.failureSamples.push({ query, reason, message: String(message).slice(0, 240) });
    };
    try {
      const created = await chromeApi.tabs.create({ url: 'https://www.douyin.com/', active: true });
      const searchTabId = created.id;
      activeTabId = searchTabId;
      for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
        const query = queries[queryIndex];
        const budget = queryBudget(queryIndex);
        const accepted = new Set();
        const baseProgress = Math.round(5 + queryIndex / queries.length * 85);
        await hooks.progress({ phase: 'searching', progress: baseProgress, message: `正在按原词搜索：${query.query}` });
        await navigate(searchTabId, `https://www.douyin.com/search/${encodeURIComponent(query.query)}?type=general`);
        await ready(searchTabId, hooks);
        await hooks.progress({ phase: 'filtering', message: `“${query.query}”：正在确认最多点赞、发布时间和视频筛选。` });
        let filterState;
        try {
          filterState = await filters({ evaluate: (func, arg) => evaluate(searchTabId, func, arg), waitForTimeout: wait }, task.timeRange);
          if (!filterState?.verified) throw new Error('原生热门筛选未确认生效');
        } catch (error) {
          diagnostics.skippedQueryCount += 1;
          warn(query.query, 'native_filter_failed', error.message);
          await hooks.progress({ phase: 'search_skipped', collectionDiagnostics: diagnostics,
            message: `跳过“${query.query}”：${error.message}。没有把默认推荐结果当作热门榜。` });
          continue;
        }
        await wait(1500);
        await ready(searchTabId, hooks);
        const seen = new Set();
        let unchangedRounds = 0;
        for (let round = 0; round <= maxScrollRounds && accepted.size < budget; round += 1) {
          await ready(searchTabId, hooks);
          const extraction = await evaluate(searchTabId, extractSearchCards, `local-${Date.now()}-${queryIndex}-${round}`);
          const rows = Array.isArray(extraction?.rows) ? extraction.rows : [];
          let fresh = 0;
          for (const row of rows) {
            const identity = row.sourceUrl || `${row.title}|${row.thumbnailUrl}|${row.cardText}`;
            if (seen.has(identity)) continue;
            seen.add(identity); fresh += 1; diagnostics.searchCardCount += 1;
            let candidate = normalizeSearchCandidate(row, query, filterState);
            if (!candidate) { diagnostics.linkFailureCount += 1; warn(query.query, 'link_missing', '卡片未公开可确认的视频链接，未猜测链接或用其它卡片代替。'); continue; }
            if (accepted.has(candidate.sourceUrl)) continue;
            diagnostics.extractedCardCount += 1;
            if (task.requireAiEvidence === true) {
              await hooks.progress({ phase: 'detail_check', message: `核验视频详情 AI 声明：${candidate.title.slice(0, 60)}` });
              if (!detailTabId) detailTabId = (await chromeApi.tabs.create({ url: candidate.sourceUrl, active: false })).id;
              activeTabId = detailTabId;
              await navigate(detailTabId, candidate.sourceUrl);
              await ready(detailTabId, hooks, { detail: true });
              if (sourceUrlFromDouyinModalUrl((await tab(detailTabId)).url) !== candidate.sourceUrl) throw new Error('详情页对应视频发生变化，已停止以避免数据串条。');
              candidate = await evaluate(detailTabId, extractDouyinDetail, candidate);
              if (!candidate.rawMetrics?.detailAiDeclarationChecked) throw new Error('未能读取视频详情 AI 声明区域。');
              if (!candidate.rawMetrics?.detailAiDeclarationVerified) continue;
            }
            await hooks.batch([candidate]);
            accepted.add(candidate.sourceUrl);
            acceptedTotal += 1;
            stored.add(candidate.sourceUrl);
            diagnostics.collectedCount = stored.size;
            if (accepted.size >= budget) break;
          }
          await hooks.progress({ phase: 'collecting', progress: Math.min(95, baseProgress + 5), scannedCount: diagnostics.extractedCardCount,
            aiCandidateCount: task.requireAiEvidence === true ? stored.size : 0,
            searchCardCount: diagnostics.searchCardCount, collectionDiagnostics: diagnostics,
            message: `“${query.query}”：本词已保存 ${accepted.size}/${budget} 条，累计 ${stored.size} 条唯一素材；缺少可靠链接 ${diagnostics.linkFailureCount} 条。${accepted.size >= budget ? '已达本词预算，后续结果未继续抓取；继续队列中的下一词。' : '范围以当前搜索实际可见结果为准。'}` });
          unchangedRounds = fresh ? 0 : unchangedRounds + 1;
          if (unchangedRounds >= 2 || round === maxScrollRounds) break;
          await evaluate(searchTabId, scrollDouyinResults);
          await wait(1800);
        }
        if (accepted.size >= budget) budgetReachedQueries += 1;
        successfulQueries += 1;
        activeTabId = searchTabId;
      }
      if (!successfulQueries && diagnostics.skippedQueryCount) throw new Error('所有关键词的抖音原生热门筛选均未确认生效；请检查页面筛选是否可用后重试。');
      if (!stored.size && diagnostics.linkFailureCount) throw new Error(`读取到搜索卡片，但 ${diagnostics.linkFailureCount} 条没有可靠视频链接；未填入错误链接。请保留当前抖音页面反馈此提示。`);
      await hooks.progress({ progress: 98, collectionDiagnostics: diagnostics,
        message: `已尝试 ${queries.length} 个关键词，保存 ${stored.size} 条唯一素材（各词累计 ${acceptedTotal}/${limit} 条）；${budgetReachedQueries ? `${budgetReachedQueries} 个词已达分配预算，后续结果未继续抓取。` : ''}并非全网完整排名，未公开的指标保持空值。` });
    } finally {
      running = false;
      // Keep the user's collection tabs open for inspection and manual verification.
    }
  }
  return { runTask, openDouyin };
}
