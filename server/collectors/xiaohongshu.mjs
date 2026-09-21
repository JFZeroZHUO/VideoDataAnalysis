import { extractLabeledMetric, parseCompactNumber } from '../number-utils.mjs';
import { gentlyScroll, waitForLoginResults } from './browser.mjs';

const resultSelector = 'a[href*="/explore/"], a[href*="/search_result/"]';

function inferVisibleLikeCount(rawText) {
  const labeled = extractLabeledMetric(rawText, ['点赞', '获赞', '赞']);
  if (labeled !== null) return labeled;
  const lines = String(rawText).split('\n').map((line) => line.trim()).filter(Boolean);
  const numeric = [...lines].reverse().find((line) => /^\d+(?:\.\d+)?(?:万|w|W)?$/.test(line));
  return numeric ? parseCompactNumber(numeric) : null;
}

function normalizeRows(rows, querySpec) {
  const query = typeof querySpec === 'string' ? querySpec : querySpec.query;
  return rows.map((row) => ({
    platform: 'xiaohongshu',
    platformItemId: row.sourceUrl.match(/\/(?:explore|search_result)\/([^/?]+)/)?.[1] || null,
    sourceUrl: row.sourceUrl.split('?')[0],
    title: row.title,
    authorName: row.authorName,
    publishedAt: row.publishedAt,
    thumbnailUrl: row.thumbnailUrl,
    viewCount: null,
    likeCount: inferVisibleLikeCount(row.rawText),
    favoriteCount: extractLabeledMetric(row.rawText, ['收藏']),
    commentCount: extractLabeledMetric(row.rawText, ['评论']),
    shareCount: extractLabeledMetric(row.rawText, ['分享', '转发']),
    recommendCount: null,
    rawMetrics: {
      sourceText: row.rawText,
      mediaUrl: row.mediaUrl || null,
      queryLane: querySpec?.lane || null,
      queryGroup: querySpec?.groupName || null,
      queryBrand: querySpec?.brandName || null
    },
    rawText: row.rawText,
    query,
    queryKeyword: querySpec?.keyword || null,
    queryGroup: querySpec?.groupName || null,
    queryBrand: querySpec?.brandName || null,
    queryLane: querySpec?.lane || null,
    queryAiTargeted: Boolean(querySpec?.aiTargeted)
  }));
}

export async function collectXiaohongshu({ page, queries, maxResults, update }) {
  const collected = new Map();
  for (let index = 0; index < queries.length && collected.size < maxResults; index += 1) {
    const querySpec = queries[index];
    const query = typeof querySpec === 'string' ? querySpec : querySpec.query;
    await update({
      phase: 'searching',
      progress: Math.max(6, Math.round((index / queries.length) * 78)),
      message: `正在搜索小红书：${query}`
    });
    const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes&type=51`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    if (index === 0 && await page.locator(resultSelector).count().catch(() => 0) === 0) {
      const ready = await waitForLoginResults({
        page,
        selector: resultSelector,
        onWaiting: async (seconds) => update({
          phase: 'waiting_login',
          progress: 4,
          message: `请在弹出的小红书窗口完成登录；已等待 ${seconds} 秒`
        })
      });
      if (!ready) throw new Error('等待小红书登录超时。完成登录后可以再次点击采集。');
    }

    await gentlyScroll(page, 3);
    const rows = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]')];
      const unique = new Map();
      for (const anchor of anchors) {
        const href = anchor.href;
        if (!href || unique.has(href)) continue;
        let card = anchor.closest('section, article, [class*="note-item"], [class*="feeds-page"]') || anchor.parentElement;
        for (let level = 0; level < 4 && card && (card.innerText || '').trim().length < 8; level += 1) card = card.parentElement;
        const rawText = (card?.innerText || anchor.innerText || '').trim();
        const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
        const title = anchor.getAttribute('title') || anchor.getAttribute('aria-label') ||
          lines.find((line) => line.length > 4 && !/^\d+(?:\.\d+)?(?:万|w)?$/.test(line)) || '未命名小红书视频';
        const image = card?.querySelector('img');
        const author = card?.querySelector('[class*="author"], [class*="name"], a[href*="/user/profile/"]');
        const video = card?.querySelector('video');
        unique.set(href, {
          sourceUrl: href,
          title: title.slice(0, 300),
          authorName: author?.innerText?.trim() || null,
          publishedAt: lines.find((line) => /(刚刚|小时前|分钟前|天前|\d{4}[-./年]\d{1,2})/.test(line)) || null,
          thumbnailUrl: image?.currentSrc || image?.src || null,
          mediaUrl: video?.currentSrc || video?.src || null,
          rawText: rawText.slice(0, 1500)
        });
      }
      return [...unique.values()].slice(0, 10);
    });

    for (const row of normalizeRows(rows, querySpec)) {
      collected.set(row.sourceUrl, row);
      if (collected.size >= maxResults) break;
    }
    await update({ scannedCount: collected.size, message: `小红书已读取 ${collected.size} 条候选内容` });
  }
  return [...collected.values()];
}
