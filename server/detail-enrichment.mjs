import { parseCompactNumber } from './number-utils.mjs';
import { inspectPageReadiness, waitForLoginResults } from './collectors/browser.mjs';

async function textMetric(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const found = await locator.count().then((count) => count > 0).catch(() => false);
    if (!found) continue;
    const text = await locator.innerText().catch(() => '');
    const value = parseCompactNumber(text);
    if (value !== null) return { value, selector, text: text.slice(0, 100), verified: true };
  }
  return { value: null, selector: null, text: null, verified: false };
}

async function enrichDouyin(page, candidate) {
  const detailText = await page.locator('[data-e2e="video-detail"]').first().innerText().catch(() => '');
  if (!detailText) throw new Error('抖音详情页当前不可用');
  const title = await page.title().catch(() => '');
  const authorText = await page.locator('[data-e2e="user-info"]').first().innerText().catch(() => '');
  const mediaUrl = await page.locator('video').first().evaluate((video) => {
    const url = video.currentSrc || video.src || null;
    return url?.startsWith('http') ? url : null;
  }).catch(() => null);
  const metricEntries = {
    likeCount: await textMetric(page, ['[data-e2e="video-player-digg"]']),
    favoriteCount: await textMetric(page, ['[data-e2e="video-player-collect"]']),
    commentCount: await textMetric(page, ['[data-e2e="feed-comment-icon"]']),
    shareCount: await textMetric(page, ['[data-e2e="video-player-share"]'])
  };
  const metricMissing = Object.entries(metricEntries).filter(([, entry]) => !entry.verified).map(([key]) => key);
  const metricsVerified = metricMissing.length === 0;
  const platformAiLabel = detailText.match(/疑似\s*AI\s*生成|(?:作者声明[：:]?\s*)?内容由\s*AI\s*生成|本内容(?:由|使用)\s*AI\s*生成/i)?.[0] || null;
  return {
    ...candidate,
    title: title ? title.replace(/\s*-\s*抖音\s*$/, '').slice(0, 500) : candidate.title,
    authorName: candidate.authorName || authorText.split('\n').map((line) => line.trim()).find(Boolean) || null,
    publishedAt: detailText.match(/发布时间[：:]\s*([^\n]+)/)?.[1] || candidate.publishedAt,
    likeCount: metricEntries.likeCount.value ?? candidate.likeCount,
    commentCount: metricEntries.commentCount.value ?? candidate.commentCount,
    favoriteCount: metricEntries.favoriteCount.value ?? candidate.favoriteCount,
    shareCount: metricEntries.shareCount.value ?? candidate.shareCount,
    platformAiBadge: Boolean(platformAiLabel),
    platformAiLabel,
    aiDeclared: Boolean(platformAiLabel),
    rawText: `${candidate.rawText || ''}\n${detailText.slice(0, 1200)}`.slice(0, 2200),
    rawMetrics: {
      ...(candidate.rawMetrics || {}),
      mediaUrl: mediaUrl || candidate.rawMetrics?.mediaUrl || null,
      detailCollectedAt: new Date().toISOString(),
      metricScope: metricsVerified ? 'detail_verified' : 'detail_partial',
      metricsVerified,
      detailAiDeclarationChecked: true,
      detailAiDeclarationVerified: Boolean(platformAiLabel),
      aiEvidenceVerified: Boolean(platformAiLabel),
      aiEvidenceType: platformAiLabel ? 'platform_declaration' : null,
      aiDeclarationScope: 'detail',
      platformAiBadgeVerified: Boolean(platformAiLabel),
      platformAiLabel,
      metricCoverage: Object.values(metricEntries).filter((entry) => entry.verified).length,
      metricMissing,
      metricEvidence: metricEntries
    }
  };
}

async function enrichXiaohongshu(page, candidate) {
  const hasDetail = await page.locator('#noteContainer, [class*="note-detail"], [class*="interaction-container"]').count().catch(() => 0);
  if (!hasDetail) throw new Error('小红书详情页当前不可用');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return {
    ...candidate,
    likeCount: (await textMetric(page, ['[class*="like-wrapper"] [class*="count"]', '[class*="like"] [class*="count"]'])).value ?? candidate.likeCount,
    favoriteCount: (await textMetric(page, ['[class*="collect-wrapper"] [class*="count"]', '[class*="collect"] [class*="count"]'])).value ?? candidate.favoriteCount,
    commentCount: (await textMetric(page, ['[class*="chat-wrapper"] [class*="count"]', '[class*="comment"] [class*="count"]'])).value ?? candidate.commentCount,
    shareCount: (await textMetric(page, ['[class*="share-wrapper"] [class*="count"]', '[class*="share"] [class*="count"]'])).value ?? candidate.shareCount,
    rawText: `${candidate.rawText || ''}\n${bodyText.slice(0, 1200)}`.slice(0, 2200),
    rawMetrics: { ...(candidate.rawMetrics || {}), detailCollectedAt: new Date().toISOString(), metricScope: 'detail' }
  };
}

export async function enrichCandidateDetails({ page, platform, candidates, update }) {
  if (platform === 'channels') return candidates;
  const enriched = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    await update?.({
      phase: 'details',
      progress: 66 + Math.round((index / Math.max(candidates.length, 1)) * 18),
      message: `正在补采详情指标 ${index + 1}/${candidates.length}`
    });
    try {
      await page.goto(candidate.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2600);
      const detailSelector = platform === 'douyin'
        ? '[data-e2e="video-detail"]'
        : '#noteContainer, [class*="note-detail"], [class*="interaction-container"]';
      const readiness = await inspectPageReadiness(page, detailSelector);
      if (readiness.attention.requiresAttention) {
        const currentProgress = 66 + Math.round((index / Math.max(candidates.length, 1)) * 18);
        const ready = await waitForLoginResults({
          page,
          selector: detailSelector,
          onWaiting: async (seconds, state) => update?.({
            phase: state.attention.kind === 'verification' ? 'waiting_verification' : 'waiting_login',
            progress: currentProgress,
            message: state.attention.kind === 'verification'
              ? `详情采集已暂停：请在浏览器完成验证，之后将自动继续 ${index + 1}/${candidates.length}（已等待 ${seconds} 秒）`
              : `请在浏览器完成登录，之后将自动继续 ${index + 1}/${candidates.length}（已等待 ${seconds} 秒）`
          })
        });
        if (!ready) {
          const error = new Error('等待详情页登录或安全验证超时');
          error.code = 'ATTENTION_TIMEOUT';
          throw error;
        }
      }
      let result = platform === 'douyin' ? await enrichDouyin(page, candidate) : await enrichXiaohongshu(page, candidate);
      if (platform === 'douyin' && result.rawMetrics?.metricsVerified !== true) {
        await update?.({
          phase: 'details_retry',
          progress: 66 + Math.round((index / Math.max(candidates.length, 1)) * 18),
          message: `指标不完整，正在自动重试 ${index + 1}/${candidates.length}`
        });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2800);
        result = await enrichDouyin(page, result);
      }
      enriched.push(result);
    } catch (error) {
      if (error?.code === 'ATTENTION_TIMEOUT') throw error;
      enriched.push(candidate);
    }
    if ((index + 1) % 8 === 0 && index < candidates.length - 1) {
      const cooldownMs = 15000 + Math.floor(Math.random() * 10000);
      await update?.({
        phase: 'cooldown',
        progress: 66 + Math.round(((index + 1) / Math.max(candidates.length, 1)) * 18),
        message: `详情指标已读取 ${index + 1}/${candidates.length}，暂停 ${Math.round(cooldownMs / 1000)} 秒`
      });
      await page.waitForTimeout(cooldownMs);
    } else {
      await page.waitForTimeout(1800 + Math.floor(Math.random() * 1700));
    }
  }
  return enriched;
}
