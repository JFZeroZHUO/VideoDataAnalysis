import { extractLabeledMetric, parseCompactNumber } from '../number-utils.mjs';
import { applyDouyinPopularFilters } from '../douyin-search-filter.mjs';
import { detectPlatformAiLabel } from '../ai-badge.mjs';
import { DOUYIN_SEARCH_RESULT_SELECTOR, sourceUrlFromDouyinModalUrl } from '../douyin-card-schema.mjs';
import { gentlyScroll, inspectPageReadiness, waitForLoginResults } from './browser.mjs';

const resultSelector = DOUYIN_SEARCH_RESULT_SELECTOR;

function createCollectionDiagnostics() {
  return {
    searchCardCount: 0, extractedCardCount: 0, emptyTextCount: 0,
    extractionDuplicateCount: 0, extractionLimitCount: 0, directUrlCount: 0,
    clickAttemptCount: 0, clickResolvedCount: 0, popupResolvedCount: 0,
    linkFailureCount: 0, restoreFailureCount: 0, sourceDuplicateCount: 0,
    resultLimitCount: 0, collectedCount: 0, skippedQueryCount: 0,
    failureReasons: {}, failureSamples: []
  };
}

async function waitForSearchPage(page, searchUrl, timeoutMs, pollIntervalMs) {
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += pollIntervalMs) {
    if (page.url() === searchUrl && await page.locator(resultSelector).count().catch(() => 0)) return true;
    if (elapsed < timeoutMs) await page.waitForTimeout(pollIntervalMs);
  }
  return false;
}

async function restoreSearchPage(page, searchUrl, timeoutMs, pollIntervalMs) {
  if (await waitForSearchPage(page, searchUrl, 0, pollIntervalMs)) return true;
  await page.keyboard.press('Escape').catch(() => {});
  if (await waitForSearchPage(page, searchUrl, timeoutMs, pollIntervalMs)) return true;
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  if (await waitForSearchPage(page, searchUrl, timeoutMs, pollIntervalMs)) return true;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  return waitForSearchPage(page, searchUrl, timeoutMs, pollIntervalMs);
}

export async function resolveModernCardUrls(page, rows = [], options = {}) {
  const resolved = [];
  const diagnostics = options.diagnostics || createCollectionDiagnostics();
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
  const restoreTimeoutMs = options.restoreTimeoutMs ?? 1500;
  const maxResolved = options.maxResults === undefined ? Infinity : Math.max(0, Number(options.maxResults) || 0);
  const initialUrl = new URL(page.url());
  initialUrl.searchParams.delete('modal_id');
  const searchUrl = initialUrl.href;
  let searchReady = true;
  const failureMessages = {
    card_missing: '原卡片已移除或内容变化，未用其他卡片代替',
    card_ambiguous: '发现多张匹配卡片，无法唯一确认视频',
    card_lookup_failed: '重新定位搜索卡片失败',
    click_failed: '打开搜索卡片失败',
    url_unresolved: '等待后仍未取得有效视频链接，未复用上一条链接',
    url_resolution_failed: '等待视频链接时页面出现异常',
    search_restore_failed: '无法恢复搜索结果页，已停止点击后续卡片',
    popup_close_failed: '视频链接已取得，但新打开的窗口未能关闭'
  };
  const fail = (row, reason, error, linkFailure = true) => {
    if (linkFailure) diagnostics.linkFailureCount += 1;
    diagnostics.failureReasons[reason] = (diagnostics.failureReasons[reason] || 0) + 1;
    if (diagnostics.failureSamples.length < 20) diagnostics.failureSamples.push({
      query: options.query || '', title: row.title || '', reason,
      message: [failureMessages[reason] || reason, error?.message || error].filter(Boolean).join('：').slice(0, 240)
    });
  };
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (resolved.length >= maxResolved) {
      diagnostics.resultLimitCount += rows.length - rowIndex;
      break;
    }
    const row = rows[rowIndex];
    const directUrl = sourceUrlFromDouyinModalUrl(row.sourceUrl);
    if (directUrl) {
      diagnostics.directUrlCount += 1;
      resolved.push({ ...row, sourceUrl: directUrl });
      continue;
    }
    if (!searchReady) { fail(row, 'search_restore_failed'); continue; }
    const popups = [];
    const onPopup = (popup) => popups.push(popup);
    let clicked = false;
    let failureReason = 'search_restore_failed';
    try {
      searchReady = await restoreSearchPage(page, searchUrl, restoreTimeoutMs, pollIntervalMs);
      if (!searchReady) { diagnostics.restoreFailureCount += 1; fail(row, 'search_restore_failed'); continue; }
      // Markers survive index shifts. On a rerender/back navigation, only reidentify
      // a unique matching card; never substitute another card at the old index.
      failureReason = 'card_lookup_failed';
      const identity = await page.evaluate(({ cardKey, cardText, title, thumbnailUrl }) => {
        if (!cardKey || !/^[a-zA-Z0-9_-]+$/.test(cardKey)) return { found: false, reason: 'card_missing' };
        const cards = [...document.querySelectorAll('.search-result-card')];
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const matches = (card) => {
          const text = normalize(card.innerText).slice(0, 2000);
          if (cardText && text === cardText) return true;
          const image = card.querySelector('img');
          return Boolean(thumbnailUrl && title && text.includes(normalize(title)) &&
            (image?.currentSrc || image?.src) === thumbnailUrl);
        };
        const marked = cards.find((card) => card.getAttribute('data-collector-card-key') === cardKey && matches(card));
        const matching = marked ? [marked] : cards.filter(matches);
        if (matching.length !== 1) return { found: false, reason: matching.length ? 'card_ambiguous' : 'card_missing' };
        for (const card of cards) {
          if (card !== matching[0] && card.getAttribute('data-collector-card-key') === cardKey) card.removeAttribute('data-collector-card-key');
        }
        matching[0].setAttribute('data-collector-card-key', cardKey);
        return { found: true };
      }, row);
      if (!identity.found) { fail(row, identity.reason); continue; }
      const beforeUrl = page.url();
      page.on('popup', onPopup);
      const card = page.locator(`[data-collector-card-key="${row.cardKey}"]`);
      diagnostics.clickAttemptCount += 1;
      clicked = true;
      failureReason = 'click_failed';
      await card.click({ timeout: 5000 });
      failureReason = 'url_resolution_failed';
      let sourceUrl = null;
      let fromPopup = false;
      for (let elapsed = 0; elapsed <= timeoutMs; elapsed += pollIntervalMs) {
        sourceUrl = popups.filter((popup) => !popup.isClosed()).map((popup) => sourceUrlFromDouyinModalUrl(popup.url())).find(Boolean);
        fromPopup = Boolean(sourceUrl);
        if (!sourceUrl && page.url() !== beforeUrl) sourceUrl = sourceUrlFromDouyinModalUrl(page.url());
        if (sourceUrl) break;
        if (elapsed < timeoutMs) await page.waitForTimeout(pollIntervalMs);
      }
      if (sourceUrl) {
        diagnostics.clickResolvedCount += 1;
        if (fromPopup) diagnostics.popupResolvedCount += 1;
        resolved.push({ ...row, sourceUrl });
      } else fail(row, 'url_unresolved');
    } catch (error) {
      fail(row, failureReason, error);
    } finally {
      if (clicked) {
        for (const popup of popups) await popup.close().catch((error) => {
          diagnostics.restoreFailureCount += 1;
          fail(row, 'popup_close_failed', error, false);
        });
        searchReady = await restoreSearchPage(page, searchUrl, restoreTimeoutMs, pollIntervalMs).catch(() => false);
        if (!searchReady) {
          diagnostics.restoreFailureCount += 1;
          fail(row, 'search_restore_failed', undefined, false);
        }
      }
      page.off('popup', onPopup);
    }
  }
  return { rows: resolved, diagnostics };
}

function normalizeDouyinRows(rows, querySpec, filterState) {
  const query = typeof querySpec === 'string' ? querySpec : querySpec.query;
  return rows.map((row) => {
    const platformAiLabel = row.platformAiLabel || detectPlatformAiLabel(row.rawText);
    return {
      platform: 'douyin',
      platformItemId: row.sourceUrl.match(/\/video\/(\d+)/)?.[1] || null,
      sourceUrl: row.sourceUrl.split('?')[0],
      title: row.title,
      authorName: row.authorName,
      publishedAt: row.publishedAt,
      thumbnailUrl: row.thumbnailUrl,
      viewCount: extractLabeledMetric(row.rawText, ['播放', '观看']),
      likeCount: row.visibleLikeCount ?? extractLabeledMetric(row.rawText, ['点赞', '获赞', '赞']),
      favoriteCount: extractLabeledMetric(row.rawText, ['收藏']),
      commentCount: extractLabeledMetric(row.rawText, ['评论']),
      shareCount: extractLabeledMetric(row.rawText, ['分享', '转发']),
      recommendCount: null,
      platformAiBadge: Boolean(platformAiLabel),
      platformAiLabel,
      rawMetrics: {
        sourceText: row.rawText,
        mediaUrl: row.mediaUrl || null,
        queryLane: querySpec?.lane || null,
        queryGroup: querySpec?.groupName || null,
        queryKeyword: querySpec?.keyword || null,
        queryBrand: querySpec?.brandName || null,
        querySearchTerm: query,
        queryAiTargeted: Boolean(querySpec?.aiTargeted),
        searchFilter: filterState,
        searchFilterVerified: Boolean(filterState?.verified),
        platformAiBadgeVerified: Boolean(platformAiLabel),
        platformAiLabel
      },
      rawText: row.rawText,
      query,
      queryKeyword: querySpec?.keyword || null,
      queryGroup: querySpec?.groupName || null,
      queryBrand: querySpec?.brandName || null,
      queryLane: querySpec?.lane || null,
      queryAiTargeted: Boolean(querySpec?.aiTargeted)
    };
  });
}

export async function collectDouyin(options) {
  const collectionDiagnostics = createCollectionDiagnostics();
  try {
    return await collectDouyinQueries(options, collectionDiagnostics);
  } catch (error) {
    error.collectionDiagnostics = collectionDiagnostics;
    throw error;
  }
}

async function collectDouyinQueries({ page, queries, maxResults, update, timeRange = 'half_year', onQueryFailure }, collectionDiagnostics) {
  const collected = new Map();
  maxResults = Number.isFinite(Number(maxResults)) ? Math.max(0, Number(maxResults)) : Infinity;
  let searchCardCount = 0;
  let aiCandidateCount = 0;
  for (let index = 0; index < queries.length; index += 1) {
    if (collected.size >= maxResults) break;
    const querySpec = queries[index];
    const query = typeof querySpec === 'string' ? querySpec : querySpec.query;
    await update({
      phase: 'searching',
      progress: Math.max(6, Math.round((index / queries.length) * 78)),
      message: `正在搜索抖音：${query}`
    });
    const url = `https://www.douyin.com/search/${encodeURIComponent(query)}?type=general`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    const readiness = await inspectPageReadiness(page, resultSelector);
    if (readiness.attention.requiresAttention || (readiness.count === 0 && index === 0)) {
      const currentProgress = Math.max(6, Math.round((index / queries.length) * 78));
      const ready = await waitForLoginResults({
        page,
        selector: resultSelector,
        onWaiting: async (seconds, state) => update({
          phase: state.attention.kind === 'verification' ? 'waiting_verification' : 'waiting_login',
          progress: currentProgress,
          message: state.attention.kind === 'verification'
            ? `采集已暂停：请在已置前的抖音窗口完成图片/滑块验证，完成后会从当前关键词自动继续（已等待 ${seconds} 秒）`
            : `抖音账号需要登录；完成后会从当前关键词自动继续（已等待 ${seconds} 秒）`
        })
      });
      if (!ready) throw new Error('等待抖音登录或安全验证超时。完成后可以再次点击采集。');
    }

    await update({
      phase: 'filtering',
      progress: Math.max(6, Math.round((index / queries.length) * 78)),
      scannedCount: collected.size,
      message: `正在应用抖音原生筛选：最多点赞 · ${timeRange === 'one_day' ? '一天内' : timeRange === 'one_week' ? '一周内' : timeRange === 'unlimited' ? '不限' : '半年内'} · 视频`
    });
    let filterState;
    try {
      filterState = await applyDouyinPopularFilters(page, timeRange);
    } catch (error) {
      collectionDiagnostics.skippedQueryCount += 1;
      collectionDiagnostics.failureReasons.native_filter_failed = (collectionDiagnostics.failureReasons.native_filter_failed || 0) + 1;
      if (collectionDiagnostics.failureSamples.length < 20) collectionDiagnostics.failureSamples.push({
        query, title: '', reason: 'native_filter_failed',
        message: `未确认抖音原生热门筛选生效：${String(error.message || error)}`.slice(0, 240)
      });
      const failedCount = await onQueryFailure?.({ query, reason: error.message }) || undefined;
      await update({
        phase: 'search_skipped',
        progress: Math.max(6, Math.round(((index + 1) / queries.length) * 78)),
        scannedCount: collected.size,
        failedCount,
        collectionDiagnostics,
        message: `已跳过“${query}”：未确认原生热门筛选生效，继续下一组关键词`
      });
      continue;
    }
    await page.waitForTimeout(1800);
    const filteredReadiness = await inspectPageReadiness(page, resultSelector);
    if (filteredReadiness.attention.requiresAttention) {
      const currentProgress = Math.max(6, Math.round((index / queries.length) * 78));
      const ready = await waitForLoginResults({
        page,
        selector: resultSelector,
        onWaiting: async (seconds, state) => update({
          phase: state.attention.kind === 'verification' ? 'waiting_verification' : 'waiting_login',
          progress: currentProgress,
          scannedCount: collected.size,
          message: `筛选后采集已暂停：请完成平台${state.attention.kind === 'verification' ? '验证' : '登录'}，之后自动继续（已等待 ${seconds} 秒）`
        })
      });
      if (!ready) throw new Error('等待抖音筛选结果验证超时');
    }

    // The native search is already ordered by most likes. Load a much deeper slice so one
    // exact keyword yields a usable breakout-video pool instead of only the first screen.
    await gentlyScroll(page, 12);
    const extraction = await page.evaluate((markerPrefix) => {
      const modernCards = [...document.querySelectorAll('.search-result-card')];
      const anchors = [...document.querySelectorAll('a[href*="/video/"], a[href*="modal_id="]')];
      const entries = modernCards.length
        ? modernCards.map((card, cardIndex) => ({ card, cardIndex, anchor: card.querySelector('a[href*="/video/"], a[href*="modal_id="]') }))
        : anchors.map((anchor) => ({
            anchor,
            cardIndex: null,
            card: anchor.closest('li, article, [data-e2e="search-video-item"]') || anchor.parentElement
          }));
      const unique = new Map();
      let emptyTextCount = 0;
      let duplicateCount = 0;
      const sourceFromDom = (card, anchor) => {
        for (const link of [anchor, ...(card?.querySelectorAll('a[href]') || [])]) {
          if (!link?.href) continue;
          try {
            const url = new URL(link.href, location.href);
            if (!['http:', 'https:'].includes(url.protocol) || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) continue;
            const id = url.pathname.match(/^\/video\/(\d{8,})\/?$/)?.[1] || url.searchParams.get('modal_id');
            if (/^\d{8,}$/.test(id || '')) return `https://www.douyin.com/video/${id}`;
          } catch {}
        }
        for (const element of [card, ...(card?.querySelectorAll('[data-video-id], [data-aweme-id], [data-item-id]') || [])]) {
          // Generic data-id on descendants may identify the author rather than a video.
          for (const attribute of element === card ? ['data-video-id', 'data-aweme-id', 'data-item-id', 'data-id'] : ['data-video-id', 'data-aweme-id', 'data-item-id']) {
            const id = element?.getAttribute(attribute);
            if (/^\d{8,}$/.test(id || '')) return `https://www.douyin.com/video/${id}`;
          }
        }
        return null;
      };
      for (const entry of entries) {
        const anchor = entry.anchor;
        const href = sourceFromDom(entry.card, anchor);
        const cardKey = Number.isInteger(entry.cardIndex) ? `${markerPrefix}-${entry.cardIndex}` : null;
        if (cardKey) entry.card.setAttribute('data-collector-card-key', cardKey);
        const cardText = (entry.card?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        let card = entry.card;
        for (let level = 0; level < 3 && card && (card.innerText || '').trim().length < 10; level += 1) card = card.parentElement;
        const rawText = (card?.innerText || anchor?.innerText || '').trim();
        if (!rawText) { emptyTextCount += 1; continue; }
        const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
        const durationPattern = /^\d{1,2}:\d{2}(?::\d{2})?$/;
        const compactNumberPattern = /^\d+(?:\.\d+)?(?:万|亿|w|W)?$/;
        const publishedPattern = /^(?:刚刚|\d+(?:秒|分钟|小时|天|周|月|年)前|\d{4}[-./年]\d{1,2})/;
        const title = anchor?.getAttribute('aria-label') || anchor?.getAttribute('title') ||
          lines.find((line) => line.length > 4 && line !== '合集' && !durationPattern.test(line) &&
            !compactNumberPattern.test(line) && !publishedPattern.test(line) && !line.startsWith('@') &&
            !/(?:疑似\s*AI\s*生成|内容由\s*AI\s*生成)/i.test(line)) || '未命名抖音视频';
        const durationIndex = lines.findIndex((line) => durationPattern.test(line));
        const visibleLikeText = durationIndex >= 0 ? lines.slice(durationIndex + 1).find((line) => compactNumberPattern.test(line)) : null;
        const authorAnchor = card?.querySelector('a[href*="/user/"]');
        const authorLine = lines.find((line) => line.startsWith('@'));
        const image = card?.querySelector('img');
        const video = card?.querySelector('video');
        const platformAiLabel = [...(card?.querySelectorAll('*') || [])]
          .map((element) => (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').trim())
          .find((text) => text.length <= 32 && /(?:疑似\s*AI\s*生成|内容由\s*AI\s*生成)/i.test(text)) ||
          rawText.match(/(?:疑似\s*AI\s*生成|内容由\s*AI\s*生成)/i)?.[0] || null;
        const key = href || `${entry.cardIndex}:${title}:${image?.currentSrc || image?.src || ''}`;
        if (unique.has(key)) { duplicateCount += 1; continue; }
        unique.set(key, {
          sourceUrl: href,
          cardIndex: entry.cardIndex,
          cardKey,
          cardText,
          title: title.slice(0, 300),
          authorName: authorAnchor?.innerText?.trim()?.replace(/^@/, '') || authorLine?.slice(1) || null,
          publishedAt: lines.find((line) => /(刚刚|小时前|分钟前|天前|\d{4}[-./年]\d{1,2})/.test(line)) || null,
          thumbnailUrl: image?.currentSrc || image?.src || null,
          mediaUrl: video?.currentSrc || video?.src || null,
          visibleLikeText,
          platformAiLabel,
          rawText: rawText.slice(0, 1500)
        });
      }
      return { cardCount: entries.length, emptyTextCount, duplicateCount, limitCount: Math.max(0, unique.size - 160), rows: [...unique.values()].slice(0, 160) };
    }, `collector-${Date.now()}-${index}`);

    searchCardCount += Number(extraction?.cardCount) || 0;
    collectionDiagnostics.searchCardCount = searchCardCount;
    collectionDiagnostics.emptyTextCount += extraction.emptyTextCount;
    collectionDiagnostics.extractionDuplicateCount += extraction.duplicateCount;
    collectionDiagnostics.extractionLimitCount += extraction.limitCount;
    const detailCandidates = (extraction?.rows || []).slice(0, 160);
    collectionDiagnostics.extractedCardCount += detailCandidates.length;
    const { rows } = await resolveModernCardUrls(page, detailCandidates, {
      diagnostics: collectionDiagnostics, query, maxResults: maxResults - collected.size
    });
    for (const row of normalizeDouyinRows(rows.map((item) => ({
      ...item,
      visibleLikeCount: item.visibleLikeText ? parseCompactNumber(item.visibleLikeText) : null
    })), querySpec, filterState)) {
      if (collected.has(row.sourceUrl)) {
        collectionDiagnostics.sourceDuplicateCount += 1;
        collected.set(row.sourceUrl, row);
      } else if (collected.size < maxResults) collected.set(row.sourceUrl, row);
      else collectionDiagnostics.resultLimitCount += 1;
    }
    collectionDiagnostics.collectedCount = collected.size;
    await update({
      scannedCount: collected.size,
      searchCardCount,
      aiCandidateCount,
      collectionDiagnostics,
      message: `已读取 ${searchCardCount} 张搜索卡片，${collected.size} 条热门候选已取得视频链接；${collectionDiagnostics.linkFailureCount} 条链接未解析`
    });
    if (collected.size >= maxResults) break;
    if (index < queries.length - 1) {
      if ((index + 1) % 6 === 0) {
        const cooldownMs = 25000 + Math.floor(Math.random() * 15000);
        await update({
          phase: 'cooldown',
          progress: Math.max(6, Math.round(((index + 1) / queries.length) * 78)),
          scannedCount: collected.size,
          message: `已完成 ${index + 1} 组关键词，暂停 ${Math.round(cooldownMs / 1000)} 秒以降低平台风控`
        });
        await page.waitForTimeout(cooldownMs);
      } else {
        await page.waitForTimeout(5500 + Math.floor(Math.random() * 3500));
      }
    }
  }
  const candidates = [...collected.values()];
  candidates.searchCardCount = searchCardCount;
  candidates.aiCandidateCount = aiCandidateCount;
  candidates.collectionDiagnostics = collectionDiagnostics;
  return candidates;
}
