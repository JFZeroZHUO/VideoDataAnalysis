import { gentlyScroll, waitForLoginResults } from './browser.mjs';

const analyticsUrl = 'https://channels.weixin.qq.com/platform/statistic/post';
const contentUrl = 'https://channels.weixin.qq.com/platform/post/list';
const contentSelector = 'tbody tr, [class*="post-list"] [class*="post-item"], [class*="feed-list"] [class*="feed-item"], [class*="table-row"]';

function rangeCutoff(timeRange, now = Date.now()) {
  const days = { thirty_days: 30, ninety_days: 90, half_year: 183 }[timeRange];
  return days ? now - days * 86_400_000 : null;
}

function parsePublishedAt(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!text) return null;
  const relative = text.match(/(\d+)\s*(分钟|小时|天)前/);
  if (relative) {
    const unit = { 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000 }[relative[2]];
    return now.getTime() - Number(relative[1]) * unit;
  }
  const normalized = text.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/[./]/g, '-');
  const withYear = /^\d{4}-/.test(normalized) ? normalized : `${now.getFullYear()}-${normalized}`;
  const timestamp = new Date(withYear).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function withinRange(value, timeRange) {
  const cutoff = rangeCutoff(timeRange);
  if (!cutoff) return true;
  const timestamp = parsePublishedAt(value);
  return timestamp === null || timestamp >= cutoff;
}

async function extractPage(page, limit) {
  return page.evaluate((pageLimit) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const parseNumber = (value) => {
      const match = clean(value).replace(/[,，]/g, '').match(/(-?\d+(?:\.\d+)?)\s*(亿|万|w|W|k|K)?/);
      if (!match) return null;
      const unit = match[2] || '';
      const multiplier = unit === '亿' ? 100_000_000 : /万|w/i.test(unit) ? 10_000 : /k/i.test(unit) ? 1000 : 1;
      return Math.round(Number(match[1]) * multiplier);
    };
    const hash = (value) => {
      let result = 0;
      for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
      return Math.abs(result).toString(36);
    };
    const metricDefinitions = {
      viewCount: ['播放', '观看', '曝光'], likeCount: ['点赞', '赞'], favoriteCount: ['收藏'],
      commentCount: ['评论'], shareCount: ['转发', '分享'], recommendCount: ['推荐']
    };
    const metricFrom = (pairs, rawText, labels) => {
      const pair = pairs.find((item) => labels.some((label) => item.label.includes(label)));
      if (pair) return { value: parseNumber(pair.value), text: pair.value, selector: `账号后台表格列：${pair.label}`, verified: parseNumber(pair.value) !== null };
      for (const label of labels) {
        const match = rawText.match(new RegExp(`${label}(?:量|数|次数)?\\s*[：:]?\\s*(-?\\d+(?:\\.\\d+)?)\\s*(亿|万|w|W|k|K)?`, 'i'));
        if (!match) continue;
        const text = `${match[1]}${match[2] || ''}`;
        return { value: parseNumber(text), text, selector: `账号后台行文本：${label}`, verified: true };
      }
      return { value: null, text: null, selector: null, verified: false };
    };
    const accountName = clean(document.querySelector('[class*="finder-name"], [class*="nickname"], [class*="account-name"]')?.textContent);
    const containers = [];
    for (const table of document.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('thead th')].map((cell) => clean(cell.textContent));
      for (const row of table.querySelectorAll('tbody tr')) containers.push({ element: row, headers });
    }
    if (!containers.length) {
      for (const element of document.querySelectorAll('[class*="post-item"], [class*="feed-item"], [class*="dynamic-item"], [class*="table-row"]')) containers.push({ element, headers: [] });
    }
    const unique = new Map();
    for (const { element: card, headers } of containers) {
      if (!visible(card)) continue;
      const cells = [...card.querySelectorAll(':scope > td')];
      const pairs = cells.map((cell, index) => ({ label: headers[index] || '', value: clean(cell.innerText) }));
      const rawText = clean([card.innerText, ...pairs.map((pair) => `${pair.label}：${pair.value}`)].filter(Boolean).join(' '));
      if (rawText.length < 5 || !Object.values(metricDefinitions).flat().some((label) => rawText.includes(label))) continue;
      const lines = String(card.innerText || '').split('\n').map(clean).filter(Boolean);
      const titleAnchor = [...card.querySelectorAll('a[href]')].find((anchor) => {
        const text = clean(anchor.innerText || anchor.title);
        return text.length >= 4 && !/(详情|分析|查看|编辑|删除|复制|数据)/.test(text);
      });
      const titleCell = cells.find((cell, index) => /作品|视频|标题|内容/.test(headers[index] || ''));
      const title = clean(titleAnchor?.innerText || titleAnchor?.title || titleCell?.innerText || card.querySelector('img[alt]')?.alt ||
        lines.find((line) => line.length >= 4 && !/(播放|观看|曝光|点赞|评论|转发|分享|收藏|推荐|发布时间|数据详情|查看分析)/.test(line)));
      if (!title) continue;
      const dateText = lines.find((line) => /(刚刚|分钟前|小时前|天前|\d{4}[-./年]\d{1,2}|\d{1,2}[-./月]\d{1,2})/.test(line)) || null;
      const href = titleAnchor?.href || [...card.querySelectorAll('a[href]')].map((anchor) => anchor.href).find((url) => /post|feed|statistic/i.test(url));
      const identityText = `${title}|${dateText || ''}`;
      const platformItemId = card.getAttribute('data-id') || card.getAttribute('data-feed-id') || href?.match(/[?&](?:feedId|objectId|id)=([^&#]+)/i)?.[1] || hash(identityText);
      const sourceUrl = href || `${location.origin}/platform/post/list#material-${platformItemId}`;
      const metrics = Object.fromEntries(Object.entries(metricDefinitions).map(([key, labels]) => [key, metricFrom(pairs, rawText, labels)]));
      const required = ['viewCount', 'likeCount', 'commentCount', 'shareCount'];
      const metricMissing = required.filter((key) => !metrics[key].verified);
      const nativeAiLabel = rawText.match(/疑似\s*AI\s*生成|(?:作者声明[：:]?\s*)?内容由\s*AI\s*生成|本内容(?:由|使用)\s*AI\s*生成/i)?.[0] || null;
      const authorAiLabel = nativeAiLabel || rawText.match(/AIGC|由\s*AI\s*(?:生成|创作|制作)|使用\s*AI\s*(?:生成|创作|制作)|AI\s*(?:生成|创作|制作|广告|动画|数字人|短片)|数字人(?:生成|制作)?/i)?.[0] || null;
      const image = [...card.querySelectorAll('img')].find((item) => (item.naturalWidth || item.width) >= 80) || card.querySelector('img');
      const media = card.querySelector('video');
      const evidenceType = nativeAiLabel ? 'platform_declaration' : authorAiLabel ? 'author_disclosure' : null;
      unique.set(sourceUrl, {
        platform: 'channels', platformItemId, sourceUrl, title: title.slice(0, 500), authorName: accountName || null,
        publishedAt: dateText, thumbnailUrl: image?.currentSrc || image?.src || null, mediaUrl: media?.currentSrc || media?.src || null,
        viewCount: metrics.viewCount.value, likeCount: metrics.likeCount.value, favoriteCount: metrics.favoriteCount.value,
        commentCount: metrics.commentCount.value, shareCount: metrics.shareCount.value, recommendCount: metrics.recommendCount.value,
        platformAiBadge: Boolean(nativeAiLabel), platformAiLabel: authorAiLabel, aiDeclared: Boolean(authorAiLabel),
        rawMetrics: {
          sourceKind: 'owned_account_analytics', sourceText: rawText.slice(0, 2400), mediaUrl: media?.currentSrc || media?.src || null,
          detailCollectedAt: new Date().toISOString(), metricScope: metricMissing.length ? 'account_analytics_partial' : 'account_analytics_verified',
          metricsVerified: metricMissing.length === 0, metricCoverage: required.length - metricMissing.length, metricMissing,
          metricEvidence: metrics, aiEvidenceVerified: Boolean(authorAiLabel), aiEvidenceType: evidenceType,
          aiDeclarationScope: 'account_analytics_row', platformAiLabel: authorAiLabel
        },
        rawText: rawText.slice(0, 2400), query: '视频号助手 · 自有账号作品'
      });
      if (unique.size >= pageLimit) break;
    }
    return [...unique.values()];
  }, limit);
}

async function goToNextPage(page) {
  const clicked = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const next = [...document.querySelectorAll('button, [role="button"], a')].filter(visible).find((element) => {
      const text = (element.innerText || element.getAttribute('aria-label') || element.title || '').trim();
      return /^(下一页|下页|Next)$/i.test(text) || /next/i.test(element.className || '');
    });
    if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true' || /disabled/.test(next.className || '')) return false;
    next.click();
    return true;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(1800);
  return clicked;
}

export async function collectChannels({ page, maxResults, update, timeRange = 'half_year' }) {
  await update({ phase: 'opening', progress: 5, message: '正在打开视频号助手「数据中心 · 内容分析」' });
  await page.goto(analyticsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  let ready = await waitForLoginResults({
    page, selector: contentSelector, timeoutMs: 300000,
    onWaiting: async (seconds) => update({ phase: 'waiting_login', progress: 4, message: `请扫码登录视频号助手；登录后会自动读取账号作品数据（已等待 ${seconds} 秒）` })
  });
  if (!ready) {
    await page.goto(contentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    ready = await waitForLoginResults({ page, selector: contentSelector, timeoutMs: 30000 });
  }
  if (!ready) throw new Error('没有在视频号助手中发现作品数据。请确认当前账号有内容管理或数据中心权限后重试。');

  const unique = new Map();
  const maxPages = Math.min(Math.max(Math.ceil(maxResults / 10), 1), 20);
  for (let pageIndex = 0; pageIndex < maxPages && unique.size < maxResults; pageIndex += 1) {
    await update({ phase: 'reading', progress: Math.min(58, 12 + Math.round((pageIndex / maxPages) * 46)), scannedCount: unique.size, message: `正在读取视频号账号作品第 ${pageIndex + 1} 页，逐项核对播放、赞、评论与转发` });
    await gentlyScroll(page, 2);
    const rows = await extractPage(page, Math.max(maxResults - unique.size, 1));
    for (const row of rows) {
      if (!withinRange(row.publishedAt, timeRange)) continue;
      unique.set(row.sourceUrl, row);
      if (unique.size >= maxResults) break;
    }
    if (unique.size >= maxResults || !await goToNextPage(page)) break;
  }

  const results = [...unique.values()];
  const verifiedMetrics = results.filter((row) => row.rawMetrics?.metricsVerified === true).length;
  const verifiedAi = results.filter((row) => row.rawMetrics?.aiEvidenceVerified === true).length;
  await update({ phase: 'processing', progress: 62, scannedCount: results.length, searchCardCount: results.length, aiCandidateCount: verifiedAi, message: `已读取 ${results.length} 条账号作品：${verifiedMetrics} 条指标完整，${verifiedAi} 条包含明确AI证据` });
  return results;
}
