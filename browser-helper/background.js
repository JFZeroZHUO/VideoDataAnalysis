const apiBase = 'http://127.0.0.1:4318/api/browser-helper';
const helperVersion = '2.2.0';
let polling = false;
let activeTask = null;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function postJson(path, body = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || `请求失败：${response.status}`);
  return response.json().catch(() => ({}));
}

function waitForTab(tabId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('平台页面打开超时'));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openOrNavigate(tabId, url) {
  if (!tabId) {
    const tab = await chrome.tabs.create({ url, active: false });
    await waitForTab(tab.id).catch(() => {});
    return tab.id;
  }
  const waiting = waitForTab(tabId).catch(() => {});
  await chrome.tabs.update(tabId, { url, active: false });
  await waiting;
  return tabId;
}

async function runInTab(tabId, func, args = [], options = {}) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: options.world || 'ISOLATED' });
  return results[0]?.result;
}

async function waitForResultsOrAttention(tabId, platform, taskId, options = {}) {
  const selector = options.selector || (platform === 'douyin'
    ? '.search-result-card, a[href*="/video/"]'
    : platform === 'xiaohongshu'
      ? 'a[href*="/explore/"], a[href*="/search_result/"]'
      : 'tbody tr, [class*="post-list"] [class*="post-item"], [class*="feed-list"] [class*="feed-item"], [class*="table-row"]');
  let attentionSeen = false;
  let lastAttentionAttempt = -1;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await runInTab(tabId, (resultSelector) => {
      const captchaSelector = 'iframe[src*="captcha"], iframe[src*="verify"], [id*="captcha"], [class*="captcha"]';
      const hasVisibleCaptcha = [...document.querySelectorAll(captchaSelector)].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      return {
        count: document.querySelectorAll(resultSelector).length,
        text: (document.body?.innerText || '').slice(0, 12000),
        hasVisibleCaptcha
      };
    }, [selector]).catch(() => ({ count: 0, text: '', hasVisibleCaptcha: false }));
    const isVerification = state.hasVisibleCaptcha || /(请选择所有符合上文描述的图片|并拖拽到下方|拖拽到这里|滑动(?:滑块)?完成验证|点击按钮进行验证|图形验证码|安全验证|完成验证|访问过于频繁|IP\s*存在风险)/i.test(state.text);
    const isLogin = /(登录后即可|扫码登录|请先登录|登录后查看)/i.test(state.text);
    const requiresAttention = isVerification || isLogin;
    if (!requiresAttention && state.count > 0) return true;
    if (requiresAttention) {
      lastAttentionAttempt = attempt;
      attentionSeen = true;
    }
    if (requiresAttention && (attempt === 0 || attempt % 5 === 0)) {
      await chrome.tabs.update(tabId, { active: true });
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await postJson(`/tasks/${taskId}/progress`, {
        phase: isVerification ? 'waiting_verification' : 'waiting_login',
        progress: options.progress ?? 4,
        scannedCount: options.scannedCount,
        message: isVerification
          ? `${options.context || '采集'}已暂停：请在当前平台页完成图片/滑块验证，完成后会自动继续（已等待 ${attempt * 3} 秒）`
          : `${options.context || '采集'}已暂停：请先完成账号登录，完成后会自动继续（已等待 ${attempt * 3} 秒）`
      });
    }
    if (!requiresAttention && attempt > 5 && (!attentionSeen || attempt - lastAttentionAttempt > 10)) return false;
    await sleep(3000);
  }
  if (attentionSeen) throw new Error('等待平台登录或安全验证超过 10 分钟，请完成验证后重新采集。');
  return false;
}

async function gentlyScroll(tabId) {
  await runInTab(tabId, async () => {
    for (let index = 0; index < 4; index += 1) {
      window.scrollBy({ top: 900, behavior: 'smooth' });
      await new Promise((resolve) => setTimeout(resolve, 1200 + index * 180));
    }
  });
}

async function applyDouyinPopularFilters(tabId, timeRange = 'half_year') {
  const timeLabels = { one_day: '一天内', one_week: '一周内', half_year: '半年内', unlimited: '不限' };
  const timeLabel = timeLabels[timeRange] || '半年内';
  const triggerOpened = await runInTab(tabId, () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const trigger = [...document.querySelectorAll('button, [role="button"], div, span')]
      .filter((element) => visible(element) && (element.innerText || element.textContent || '').trim() === '筛选').at(-1);
    if (!trigger) return false;
    (trigger.closest('button, [role="button"]') || trigger).click();
    return true;
  }).catch(() => false);
  if (!triggerOpened) throw new Error('没有找到抖音搜索页右侧“筛选”按钮');
  await sleep(500);

  const selections = [
    ['内容形式', ['不限', '视频', '图文'], '视频'],
    ['发布时间', ['不限', '一天内', '一周内', '半年内'], timeLabel],
    ['排序依据', ['综合排序', '最新发布', '最多点赞'], '最多点赞']
  ];
  for (const [heading, optionLabels, targetLabel] of selections) {
    const clicked = await runInTab(tabId, ({ headingText, labels, targetText }) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const text = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
      const panel = [...document.querySelectorAll('div, section, aside')]
        .filter((element) => visible(element) && /排序依据/.test(text(element)) && /发布时间/.test(text(element)) && /内容形式/.test(text(element)))
        .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
      const headingNode = panel && [...panel.querySelectorAll('*')].find((element) => visible(element) && text(element) === headingText);
      if (!headingNode) return false;
      const sections = [];
      for (let element = headingNode.parentElement; element && panel.contains(element); element = element.parentElement) {
        if (labels.every((label) => text(element).includes(label))) sections.push(element);
        if (element === panel) break;
      }
      const section = sections.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
      const target = section && [...section.querySelectorAll('*')]
        .filter((element) => visible(element) && text(element) === targetText)
        .sort((a, b) => a.children.length - b.children.length)[0];
      if (!target) return false;
      (target.closest('button, [role="button"]') || target).click();
      return true;
    }, [{ headingText: heading, labels: optionLabels, targetText: targetLabel }]).catch(() => false);
    if (!clicked) throw new Error(`抖音筛选失败：${heading}“${targetLabel}”不可用`);
    await sleep(900);
    const verified = await runInTab(tabId, ({ headingText, labels, targetText }) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const text = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
      const accent = (value) => {
        const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!match) return false;
        const red = Number(match[1]); const green = Number(match[2]); const blue = Number(match[3]);
        return red > 150 && red > green * 1.45 && red > blue * 1.15;
      };
      const panel = [...document.querySelectorAll('div, section, aside')]
        .filter((element) => visible(element) && /排序依据/.test(text(element)) && /发布时间/.test(text(element)) && /内容形式/.test(text(element)))
        .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
      const headingNode = panel && [...panel.querySelectorAll('*')].find((element) => visible(element) && text(element) === headingText);
      if (!headingNode) return false;
      const sections = [];
      for (let element = headingNode.parentElement; element && panel.contains(element); element = element.parentElement) {
        if (labels.every((label) => text(element).includes(label))) sections.push(element);
        if (element === panel) break;
      }
      const section = sections.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
      const option = section && [...section.querySelectorAll('*')]
        .filter((element) => visible(element) && text(element) === targetText)
        .sort((a, b) => a.children.length - b.children.length)[0];
      if (!option) return false;
      for (let element = option; element && section.contains(element); element = element.parentElement) {
        const style = getComputedStyle(element);
        if (element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true' ||
          /(?:active|selected|checked|current)/i.test(`${element.className || ''} ${element.getAttribute('data-state') || ''}`) ||
          accent(style.color) || accent(style.backgroundColor)) return true;
        if (element === section) break;
      }
      return false;
    }, [{ headingText: heading, labels: optionLabels, targetText: targetLabel }]).catch(() => false);
    if (!verified) throw new Error(`抖音筛选未确认生效：${heading}“${targetLabel}”`);
  }
  return { sort: 'most_liked', sortLabel: '最多点赞', timeRange, timeLabel, contentType: 'video', contentTypeLabel: '视频', verified: true };
}

function extractDouyin(query, queryKeyword, queryGroup, queryBrand, queryLane, queryAiTargeted, filterState, limit) {
  const parseNumber = (value) => {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(万|亿|w|W)?$/);
    if (!match) return null;
    const multiplier = /万|w/i.test(match[2] || '') ? 10_000 : match[2] === '亿' ? 100_000_000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const modernCards = [...document.querySelectorAll('.search-result-card')];
  const anchors = [...document.querySelectorAll('a[href*="/video/"]')];
  const entries = modernCards.length
    ? modernCards.map((card, cardIndex) => ({ card, cardIndex, anchor: card.querySelector('a[href*="/video/"]') }))
    : anchors.map((anchor) => ({
        anchor,
        cardIndex: null,
        card: anchor.closest('li, article, [data-e2e="search-video-item"]') || anchor.parentElement
      }));
  const unique = new Map();
  for (const entry of entries) {
    const anchor = entry.anchor;
    const sourceUrl = anchor?.href?.includes('/video/') ? anchor.href.split('?')[0] : null;
    const card = entry.card;
    const rawText = (card?.innerText || anchor?.innerText || '').trim();
    if (!rawText) continue;
    const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
    const durationPattern = /^\d{1,2}:\d{2}(?::\d{2})?$/;
    const numberPattern = /^\d+(?:\.\d+)?(?:万|亿|w|W)?$/;
    const publishedPattern = /^(?:刚刚|\d+(?:秒|分钟|小时|天|周|月|年)前|\d{4}[-./年]\d{1,2})/;
    const title = anchor?.getAttribute('aria-label') || anchor?.getAttribute('title') ||
      lines.find((line) => line.length > 4 && line !== '合集' && !durationPattern.test(line) &&
        !numberPattern.test(line) && !publishedPattern.test(line) && !line.startsWith('@') &&
        !/(?:疑似\s*AI\s*生成|内容由\s*AI\s*生成)/i.test(line)) || '未命名抖音视频';
    const durationIndex = lines.findIndex((line) => durationPattern.test(line));
    const likeText = durationIndex >= 0 ? lines.slice(durationIndex + 1).find((line) => numberPattern.test(line)) : null;
    const image = card?.querySelector('img');
    const author = lines.find((line) => line.startsWith('@'));
    const platformAiLabel = [...(card?.querySelectorAll('*') || [])]
      .map((element) => (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').trim())
      .find((text) => text.length <= 32 && /(?:疑似\s*AI\s*生成|内容由\s*AI\s*生成)/i.test(text)) ||
      rawText.match(/(?:疑似\s*AI\s*生成|内容由\s*AI\s*生成)/i)?.[0] || null;
    const key = sourceUrl || `${entry.cardIndex}:${title}:${image?.currentSrc || image?.src || ''}`;
    if (unique.has(key)) continue;
    unique.set(key, {
      platform: 'douyin',
      platformItemId: sourceUrl?.match(/\/video\/(\d+)/)?.[1] || null,
      sourceUrl,
      cardIndex: entry.cardIndex,
      title: title.slice(0, 500),
      authorName: author ? author.slice(1) : null,
      publishedAt: lines.find((line) => publishedPattern.test(line)) || null,
      thumbnailUrl: image?.currentSrc || image?.src || null,
      viewCount: null,
      likeCount: parseNumber(likeText),
      favoriteCount: null,
      commentCount: null,
      shareCount: null,
      recommendCount: null,
      platformAiBadge: Boolean(platformAiLabel),
      platformAiLabel,
      rawMetrics: {
        sourceText: rawText.slice(0, 1500),
        queryGroup,
        queryKeyword,
        queryBrand,
        queryLane,
        querySearchTerm: query,
        queryAiTargeted,
        searchFilter: filterState,
        searchFilterVerified: Boolean(filterState?.verified),
        platformAiBadgeVerified: Boolean(platformAiLabel),
        platformAiLabel
      },
      rawText: rawText.slice(0, 1500),
      query,
      queryKeyword,
      queryGroup,
      queryBrand,
      queryLane,
      queryAiTargeted
    });
    if (unique.size >= limit) break;
  }
  const rows = [...unique.values()];
  return { cardCount: entries.length, aiCandidateCount: rows.filter((row) => row.platformAiBadge).length, rows };
}

async function resolveDouyinCardUrl(tabId, cardIndex) {
  if (!Number.isInteger(cardIndex)) return { sourceUrl: null, modalClosed: true };
  const clicked = await runInTab(tabId, (index) => {
    const card = document.querySelectorAll('.search-result-card')[index];
    if (!card) return false;
    card.scrollIntoView({ block: 'center', behavior: 'auto' });
    (card.querySelector('img') || card).click();
    return true;
  }, [cardIndex]).catch(() => false);
  if (!clicked) return { sourceUrl: null, modalClosed: true };

  let sourceUrl = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(150);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    try {
      const modalId = new URL(tab?.url || '').searchParams.get('modal_id');
      if (/^\d{8,}$/.test(modalId || '')) {
        sourceUrl = `https://www.douyin.com/video/${modalId}`;
        break;
      }
    } catch {}
  }

  await runInTab(tabId, () => {
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    document.dispatchEvent(new KeyboardEvent('keyup', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }, [], { world: 'MAIN' }).catch(() => {});
  await sleep(350);
  const current = await chrome.tabs.get(tabId).catch(() => null);
  const modalClosed = !/[?&]modal_id=/.test(current?.url || '');
  return { sourceUrl, modalClosed };
}

function extractXiaohongshu(query, queryKeyword, queryGroup, queryBrand, queryLane, queryAiTargeted, limit) {
  const parseNumber = (value) => {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(万|w|W)?$/);
    return match ? Math.round(Number(match[1]) * (/万|w/i.test(match[2] || '') ? 10_000 : 1)) : null;
  };
  const anchors = [...document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]')];
  const unique = new Map();
  for (const anchor of anchors) {
    const sourceUrl = anchor.href.split('?')[0];
    if (!sourceUrl || unique.has(sourceUrl)) continue;
    const card = anchor.closest('section, article, [class*="note-item"]') || anchor.parentElement?.parentElement;
    const rawText = (card?.innerText || anchor.innerText || '').trim();
    const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
    const numberPattern = /^\d+(?:\.\d+)?(?:万|w|W)?$/;
    const publishedPattern = /^(?:刚刚|\d+(?:秒|分钟|小时|天|周|月|年)前|\d{4}[-./年]\d{1,2})/;
    const title = anchor.getAttribute('title') || anchor.getAttribute('aria-label') ||
      lines.find((line) => line.length > 4 && !numberPattern.test(line) && !publishedPattern.test(line) && !line.startsWith('@')) || '未命名小红书视频';
    const numeric = [...lines].reverse().find((line) => numberPattern.test(line));
    const image = card?.querySelector('img');
    unique.set(sourceUrl, {
      platform: 'xiaohongshu',
      platformItemId: sourceUrl.match(/\/(?:explore|search_result)\/([^/?]+)/)?.[1] || null,
      sourceUrl,
      title: title.slice(0, 500),
      authorName: null,
      publishedAt: lines.find((line) => publishedPattern.test(line)) || null,
      thumbnailUrl: image?.currentSrc || image?.src || null,
      viewCount: null,
      likeCount: parseNumber(numeric),
      favoriteCount: null,
      commentCount: null,
      shareCount: null,
      recommendCount: null,
      rawMetrics: { sourceText: rawText.slice(0, 1500), queryGroup, queryBrand, queryLane },
      rawText: rawText.slice(0, 1500),
      query,
      queryKeyword,
      queryGroup,
      queryBrand,
      queryLane,
      queryAiTargeted
    });
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

function extractDouyinDetail(candidate) {
  if (!document.querySelector('[data-e2e="video-detail"]')) return candidate;
  const parseNumber = (value) => {
    const match = String(value || '').replace(/[,，\s]/g, '').match(/(\d+(?:\.\d+)?)(万|亿|w|W|k|K)?/);
    if (!match) return null;
    const unit = match[2] || '';
    const multiplier = /万|w/i.test(unit) ? 10_000 : unit === '亿' ? 100_000_000 : /k/i.test(unit) ? 1000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const metric = (selector) => {
    const element = document.querySelector(selector);
    const text = element?.innerText || element?.getAttribute('aria-label') || element?.getAttribute('title') || '';
    const value = parseNumber(text);
    return { value, selector: element && value !== null ? selector : null, text: text.slice(0, 100), verified: Boolean(element && value !== null) };
  };
  const detail = document.querySelector('[data-e2e="video-detail"]')?.innerText || '';
  const authorText = document.querySelector('[data-e2e="user-info"]')?.innerText || '';
  const pageTitle = document.title.replace(/\s*-\s*抖音\s*$/, '');
  const videoUrl = document.querySelector('video')?.currentSrc || null;
  const metricEntries = {
    likeCount: metric('[data-e2e="video-player-digg"]'),
    favoriteCount: metric('[data-e2e="video-player-collect"]'),
    commentCount: metric('[data-e2e="feed-comment-icon"]'),
    shareCount: metric('[data-e2e="video-player-share"]')
  };
  const metricMissing = Object.entries(metricEntries).filter(([, entry]) => !entry.verified).map(([key]) => key);
  const metricsVerified = metricMissing.length === 0;
  const platformAiLabel = detail.match(/疑似\s*AI\s*生成|(?:作者声明[：:]?\s*)?内容由\s*AI\s*生成|本内容(?:由|使用)\s*AI\s*生成/i)?.[0] || null;
  return {
    ...candidate,
    title: pageTitle || candidate.title,
    authorName: candidate.authorName || authorText.split('\n').map((line) => line.trim()).find(Boolean) || null,
    publishedAt: detail.match(/发布时间[：:]\s*([^\n]+)/)?.[1] || candidate.publishedAt,
    likeCount: metricEntries.likeCount.value ?? candidate.likeCount,
    commentCount: metricEntries.commentCount.value,
    favoriteCount: metricEntries.favoriteCount.value,
    shareCount: metricEntries.shareCount.value,
    platformAiBadge: Boolean(platformAiLabel),
    platformAiLabel,
    aiDeclared: Boolean(platformAiLabel),
    rawText: `${candidate.rawText || ''}\n${detail.slice(0, 1200)}`.slice(0, 2200),
    rawMetrics: {
      ...(candidate.rawMetrics || {}),
      mediaUrl: videoUrl?.startsWith('http') ? videoUrl : candidate.rawMetrics?.mediaUrl || null,
      detailCollectedAt: new Date().toISOString(),
      metricScope: metricsVerified ? 'detail_verified' : 'detail_partial',
      metricsVerified,
      detailAiDeclarationChecked: true,
      detailAiDeclarationVerified: Boolean(platformAiLabel),
      aiDeclarationScope: 'detail',
      platformAiBadgeVerified: Boolean(platformAiLabel),
      platformAiLabel,
      metricCoverage: Object.values(metricEntries).filter((entry) => entry.verified).length,
      metricMissing,
      metricEvidence: metricEntries
    }
  };
}

function extractXiaohongshuDetail(candidate) {
  if (!document.querySelector('#noteContainer, [class*="note-detail"], [class*="interaction-container"]')) return candidate;
  const parseNumber = (value) => {
    const match = String(value || '').replace(/[,，\s]/g, '').match(/(\d+(?:\.\d+)?)(万|亿|w|W|k|K)?/);
    if (!match) return null;
    const unit = match[2] || '';
    const multiplier = /万|w/i.test(unit) ? 10_000 : unit === '亿' ? 100_000_000 : /k/i.test(unit) ? 1000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const firstMetric = (selectors) => {
    for (const selector of selectors) {
      const value = parseNumber(document.querySelector(selector)?.innerText);
      if (value !== null) return value;
    }
    return null;
  };
  const detail = document.querySelector('#noteContainer')?.innerText || document.body?.innerText || '';
  return {
    ...candidate,
    likeCount: firstMetric(['[class*="like-wrapper"] [class*="count"]', '[class*="like"] [class*="count"]']) ?? candidate.likeCount,
    favoriteCount: firstMetric(['[class*="collect-wrapper"] [class*="count"]', '[class*="collect"] [class*="count"]']),
    commentCount: firstMetric(['[class*="chat-wrapper"] [class*="count"]', '[class*="comment"] [class*="count"]']),
    shareCount: firstMetric(['[class*="share-wrapper"] [class*="count"]', '[class*="share"] [class*="count"]']),
    rawText: `${candidate.rawText || ''}\n${detail.slice(0, 1200)}`.slice(0, 2200),
    rawMetrics: { ...(candidate.rawMetrics || {}), detailCollectedAt: new Date().toISOString(), metricScope: 'detail' }
  };
}

function extractChannels(limit) {
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
    const platformItemId = card.getAttribute('data-id') || card.getAttribute('data-feed-id') || href?.match(/[?&](?:feedId|objectId|id)=([^&#]+)/i)?.[1] || hash(`${title}|${dateText || ''}`);
    const sourceUrl = href || `${location.origin}/platform/post/list#material-${platformItemId}`;
    const metrics = Object.fromEntries(Object.entries(metricDefinitions).map(([key, labels]) => [key, metricFrom(pairs, rawText, labels)]));
    const required = ['viewCount', 'likeCount', 'commentCount', 'shareCount'];
    const metricMissing = required.filter((key) => !metrics[key].verified);
    const nativeAiLabel = rawText.match(/疑似\s*AI\s*生成|(?:作者声明[：:]?\s*)?内容由\s*AI\s*生成|本内容(?:由|使用)\s*AI\s*生成/i)?.[0] || null;
    const authorAiLabel = nativeAiLabel || rawText.match(/AIGC|由\s*AI\s*(?:生成|创作|制作)|使用\s*AI\s*(?:生成|创作|制作)|AI\s*(?:生成|创作|制作|广告|动画|数字人|短片)|数字人(?:生成|制作)?/i)?.[0] || null;
    const evidenceType = nativeAiLabel ? 'platform_declaration' : authorAiLabel ? 'author_disclosure' : null;
    const image = [...card.querySelectorAll('img')].find((item) => (item.naturalWidth || item.width) >= 80) || card.querySelector('img');
    const video = card.querySelector('video');
    unique.set(sourceUrl, {
      platform: 'channels', platformItemId, sourceUrl, title: title.slice(0, 500), authorName: accountName || null,
      publishedAt: dateText, thumbnailUrl: image?.currentSrc || image?.src || null,
      viewCount: metrics.viewCount.value, likeCount: metrics.likeCount.value, favoriteCount: metrics.favoriteCount.value,
      commentCount: metrics.commentCount.value, shareCount: metrics.shareCount.value, recommendCount: metrics.recommendCount.value,
      platformAiBadge: Boolean(nativeAiLabel), platformAiLabel: authorAiLabel, aiDeclared: Boolean(authorAiLabel),
      rawMetrics: {
        sourceKind: 'owned_account_analytics', sourceText: rawText.slice(0, 2400), mediaUrl: video?.currentSrc || video?.src || null,
        detailCollectedAt: new Date().toISOString(), metricScope: metricMissing.length ? 'account_analytics_partial' : 'account_analytics_verified',
        metricsVerified: metricMissing.length === 0, metricCoverage: required.length - metricMissing.length, metricMissing,
        metricEvidence: metrics, aiEvidenceVerified: Boolean(authorAiLabel), aiEvidenceType: evidenceType,
        aiDeclarationScope: 'account_analytics_row', platformAiLabel: authorAiLabel
      },
      rawText: rawText.slice(0, 2400), query: '视频号助手 · 自有账号作品'
    });
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

function clickNextChannelsPage() {
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
}

function withinChannelsRange(value, timeRange) {
  const days = { thirty_days: 30, ninety_days: 90, half_year: 183 }[timeRange];
  if (!days || !value) return true;
  const text = String(value).trim();
  const relative = text.match(/(\d+)\s*(分钟|小时|天)前/);
  let timestamp = null;
  if (relative) timestamp = Date.now() - Number(relative[1]) * ({ 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000 }[relative[2]]);
  else {
    const normalized = text.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/[./]/g, '-');
    timestamp = new Date(/^\d{4}-/.test(normalized) ? normalized : `${new Date().getFullYear()}-${normalized}`).getTime();
  }
  return Number.isNaN(timestamp) || timestamp >= Date.now() - days * 86_400_000;
}

async function executeTask(task) {
  const collected = new Map();
  let keywordFailedCount = 0;
  let searchCardCount = 0;
  let aiCandidateCount = 0;
  let tabId = null;
  try {
    if (task.platform === 'channels') {
      tabId = await openOrNavigate(null, 'https://channels.weixin.qq.com/platform/statistic/post');
      await sleep(3500);
      if (!await waitForResultsOrAttention(tabId, task.platform, task.id)) {
        tabId = await openOrNavigate(tabId, 'https://channels.weixin.qq.com/platform/post/list');
        await sleep(2500);
        if (!await waitForResultsOrAttention(tabId, task.platform, task.id)) throw new Error('没有发现视频号作品数据，请确认账号有内容管理或数据中心权限后重试。');
      }
      const maxPages = Math.min(Math.max(Math.ceil(task.maxResults / 10), 1), 20);
      for (let pageIndex = 0; pageIndex < maxPages && collected.size < task.maxResults; pageIndex += 1) {
        await gentlyScroll(tabId);
        const rows = await runInTab(tabId, extractChannels, [Math.max(task.maxResults - collected.size, 1)]);
        for (const row of rows || []) {
          if (!withinChannelsRange(row.publishedAt, task.timeRange)) continue;
          collected.set(row.sourceUrl, row);
          if (collected.size >= task.maxResults) break;
        }
        searchCardCount = collected.size;
        aiCandidateCount = [...collected.values()].filter((row) => row.rawMetrics?.aiEvidenceVerified === true).length;
        await postJson(`/tasks/${task.id}/progress`, {
          phase: 'reading', progress: Math.min(80, 12 + Math.round(((pageIndex + 1) / maxPages) * 66)),
          scannedCount: collected.size, searchCardCount, aiCandidateCount,
          message: `已读取视频号账号作品 ${collected.size} 条，其中 ${aiCandidateCount} 条包含明确AI证据`
        });
        if (collected.size >= task.maxResults || !await runInTab(tabId, clickNextChannelsPage)) break;
        await sleep(1800);
      }
    } else {
      for (let index = 0; index < task.queries.length; index += 1) {
        const querySpec = task.queries[index];
        const query = typeof querySpec === 'string' ? querySpec : querySpec.query;
        const queryKeyword = typeof querySpec === 'string' ? querySpec.split(/\s+/)[0] : querySpec.keyword;
        const queryGroup = typeof querySpec === 'string' ? null : querySpec.groupName;
        const queryBrand = typeof querySpec === 'string' ? null : querySpec.brandName;
        const queryLane = typeof querySpec === 'string' ? null : querySpec.lane;
        const queryAiTargeted = typeof querySpec === 'string' ? /AI/i.test(query) : Boolean(querySpec.aiTargeted);
        const url = task.platform === 'douyin'
          ? `https://www.douyin.com/search/${encodeURIComponent(query)}?type=general`
          : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes&type=51`;
        tabId = await openOrNavigate(tabId, url);
        await sleep(3500);
        const progress = Math.min(80, Math.round(((index + 1) / task.queries.length) * 78));
        const ready = await waitForResultsOrAttention(tabId, task.platform, task.id, {
          progress,
          scannedCount: collected.size,
          context: `关键词“${query}”`
        });
        if (!ready) continue;
        let filterState = null;
        if (task.platform === 'douyin') {
          await postJson(`/tasks/${task.id}/progress`, {
            phase: 'filtering',
            progress,
            scannedCount: collected.size,
            message: `正在应用抖音原生筛选：最多点赞 · ${{ one_day: '一天内', one_week: '一周内', half_year: '半年内', unlimited: '不限' }[task.timeRange] || '半年内'} · 视频`
          });
          try {
            filterState = await applyDouyinPopularFilters(tabId, task.timeRange);
          } catch {
            keywordFailedCount += 1;
            await postJson(`/tasks/${task.id}/progress`, {
              phase: 'search_skipped',
              progress,
              scannedCount: collected.size,
              failedCount: keywordFailedCount,
              message: `已跳过“${query}”：未确认原生热门筛选生效，继续下一组关键词`
            });
            continue;
          }
          await sleep(1800);
        }
        for (let depthRound = 0; depthRound < 3; depthRound += 1) {
          await gentlyScroll(tabId);
          await postJson(`/tasks/${task.id}/progress`, {
            phase: 'deep_loading',
            progress: Math.min(78, progress + depthRound + 1),
            scannedCount: collected.size,
            message: `正在深度加载“${query}”的最多点赞结果 ${depthRound + 1}/3`
          });
        }
        const extraction = await runInTab(tabId, task.platform === 'douyin' ? extractDouyin : extractXiaohongshu,
          task.platform === 'douyin'
            ? [query, queryKeyword, queryGroup, queryBrand, queryLane, queryAiTargeted, filterState, 160]
            : [query, queryKeyword, queryGroup, queryBrand, queryLane, queryAiTargeted, 16]);
        const rows = task.platform === 'douyin' ? (extraction?.rows || []) : (extraction || []);
        const candidateRows = task.platform === 'douyin' ? rows.slice(0, 160) : rows;
        if (task.platform === 'douyin') {
          searchCardCount += Number(extraction?.cardCount) || 0;
        }
        for (const row of candidateRows || []) {
          if (task.platform === 'douyin' && !row.sourceUrl) {
            const resolved = await resolveDouyinCardUrl(tabId, row.cardIndex);
            if (resolved.sourceUrl) {
              row.sourceUrl = resolved.sourceUrl;
              row.platformItemId = resolved.sourceUrl.match(/\/video\/(\d+)/)?.[1] || null;
            }
            if (!resolved.modalClosed) {
              tabId = await openOrNavigate(tabId, url);
              await sleep(2500);
              const restored = await waitForResultsOrAttention(tabId, task.platform, task.id, {
                progress,
                scannedCount: collected.size,
                context: `恢复关键词“${query}”`
              });
              if (restored) {
                filterState = await applyDouyinPopularFilters(tabId, task.timeRange).catch(() => null);
                await sleep(1200);
                await gentlyScroll(tabId);
              }
            }
          }
          if (!row.sourceUrl) continue;
          if (collected.has(row.sourceUrl) || collected.size < task.maxResults) collected.set(row.sourceUrl, row);
        }
        await postJson(`/tasks/${task.id}/progress`, {
            phase: 'searching',
            progress: Math.min(80, Math.round(((index + 1) / task.queries.length) * 78)),
            scannedCount: collected.size,
            searchCardCount,
            aiCandidateCount,
            message: task.platform === 'douyin'
              ? task.requireAiEvidence === false
                ? `已读取 ${searchCardCount} 张搜索卡片，已关闭AI声明核验，将直接沉淀热门结果`
                : `已读取 ${searchCardCount} 张搜索卡片，${collected.size} 条热门候选已取得详情链接，稍后逐条核验AI声明`
              : `日常 Chrome 已读取 ${collected.size} 条候选内容`
        });
        if ((index + 1) % 6 === 0 && index < task.queries.length - 1) {
          const cooldownMs = 25000 + Math.floor(Math.random() * 15000);
          await postJson(`/tasks/${task.id}/progress`, {
            phase: 'cooldown',
            progress,
            scannedCount: collected.size,
            message: `已完成 ${index + 1} 组关键词，暂停 ${Math.round(cooldownMs / 1000)} 秒以降低平台风控`
          });
          await sleep(cooldownMs);
        } else {
          await sleep(5500 + Math.floor(Math.random() * 3500));
        }
      }
      const explicitAi = /(AIGC|AI\s*(?:生成|创作|广告|动画|数字人|剪辑|特效|制作)|数字人|即梦|可灵|Sora|Runway|海螺|Seedance|剪映\s*AI)/i;
      const narrative = /(漫剧|短剧|小说|穿越|求生|第\s*\d+\s*集|剧情|团宠|霸总|重生)/i;
      const shortlist = [...collected.values()]
        .filter((candidate) => {
          const text = `${candidate.title || ''} ${candidate.rawText || ''}`;
          const productMatch = !candidate.queryKeyword || text.includes(candidate.queryKeyword) ||
            (candidate.queryBrand && text.toLowerCase().includes(candidate.queryBrand.toLowerCase()));
          const aiQualified = task.platform === 'douyin' ? true : explicitAi.test(text);
          return productMatch && aiQualified && !narrative.test(text);
        })
        .sort((a, b) => {
          const aExplicit = a.platformAiBadge || explicitAi.test(`${a.title || ''} ${a.rawText || ''}`) ? 1 : 0;
          const bExplicit = b.platformAiBadge || explicitAi.test(`${b.title || ''} ${b.rawText || ''}`) ? 1 : 0;
          return bExplicit - aExplicit || (b.likeCount || 0) - (a.likeCount || 0);
        })
        .slice(0, task.platform === 'douyin' ? Math.min((task.topN || 20) * 8, 160) : Math.min((task.topN || 20) * 3, 60));
      if (task.platform === 'douyin' && task.requireAiEvidence === false) {
        collected.clear();
        for (const candidate of shortlist) {
          collected.set(candidate.sourceUrl, {
            ...candidate,
            rawMetrics: {
              ...(candidate.rawMetrics || {}),
              aiEvidenceRequired: false,
              aiVerificationSkipped: true,
              collectionScope: 'search_results_only'
            }
          });
        }
        await postJson(`/tasks/${task.id}/progress`, {
          phase: 'search_results_ready', progress: 84, scannedCount: collected.size,
          searchCardCount, aiCandidateCount: 0,
          message: `已关闭AI限定：保留 ${collected.size} 条热门搜索结果，不进入详情页`
        });
      } else {
        const detailed = [];
        for (let index = 0; index < shortlist.length; index += 1) {
        const candidate = shortlist[index];
        tabId = await openOrNavigate(tabId, candidate.sourceUrl);
        await sleep(2600);
        const detailSelector = task.platform === 'douyin'
          ? '[data-e2e="video-detail"]'
          : '#noteContainer, [class*="note-detail"], [class*="interaction-container"]';
        await waitForResultsOrAttention(tabId, task.platform, task.id, {
          selector: detailSelector,
          progress: 66 + Math.round(((index + 1) / Math.max(shortlist.length, 1)) * 18),
          scannedCount: collected.size,
          context: `详情采集 ${index + 1}/${shortlist.length}`
        });
        let enriched = await runInTab(tabId, task.platform === 'douyin' ? extractDouyinDetail : extractXiaohongshuDetail, [candidate]).catch(() => candidate);
        if (task.platform === 'douyin' && enriched?.rawMetrics?.metricsVerified !== true) {
          await postJson(`/tasks/${task.id}/progress`, {
            phase: 'details_retry',
            progress: 66 + Math.round(((index + 1) / Math.max(shortlist.length, 1)) * 18),
            scannedCount: collected.size,
            message: `指标不完整，正在自动重试 ${index + 1}/${shortlist.length}`
          });
          const waitingReload = waitForTab(tabId).catch(() => {});
          await chrome.tabs.reload(tabId);
          await waitingReload;
          await sleep(2800);
          enriched = await runInTab(tabId, extractDouyinDetail, [enriched]).catch(() => enriched);
        }
        detailed.push(enriched || candidate);
        if (task.platform === 'douyin' && enriched?.rawMetrics?.detailAiDeclarationVerified === true) {
          aiCandidateCount += 1;
        }
        await postJson(`/tasks/${task.id}/progress`, {
          phase: 'details',
          progress: 66 + Math.round(((index + 1) / Math.max(shortlist.length, 1)) * 18),
          scannedCount: collected.size,
          aiCandidateCount,
          message: task.platform === 'douyin'
            ? `正在详情页核验AI声明 ${index + 1}/${shortlist.length}，已确认 ${aiCandidateCount} 条`
            : `正在补采详情指标 ${index + 1}/${shortlist.length}`
        });
        if ((index + 1) % 8 === 0 && index < shortlist.length - 1) {
          const cooldownMs = 15000 + Math.floor(Math.random() * 10000);
          await postJson(`/tasks/${task.id}/progress`, {
            phase: 'cooldown',
            progress: 66 + Math.round(((index + 1) / Math.max(shortlist.length, 1)) * 18),
            scannedCount: collected.size,
            message: `详情指标已读取 ${index + 1}/${shortlist.length}，暂停 ${Math.round(cooldownMs / 1000)} 秒`
          });
          await sleep(cooldownMs);
        } else {
          await sleep(1800 + Math.floor(Math.random() * 1700));
        }
        }
        collected.clear();
        for (const candidate of detailed) {
          if (task.platform === 'douyin' && candidate.rawMetrics?.detailAiDeclarationVerified !== true) continue;
          collected.set(candidate.sourceUrl, candidate);
        }
      }
    }
    await postJson(`/tasks/${task.id}/complete`, { candidates: [...collected.values()] });
  } catch (error) {
    await postJson(`/tasks/${task.id}/fail`, { message: error.message || String(error) }).catch(() => {});
  } finally {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await postJson('/heartbeat', { version: helperVersion });
    if (activeTask) return;
    const response = await fetch(`${apiBase}/next-task`);
    if (response.status === 204) return;
    if (!response.ok) return;
    activeTask = await response.json();
    await executeTask(activeTask);
    activeTask = null;
  } catch {
    activeTask = null;
  } finally {
    polling = false;
  }
}

chrome.runtime.onInstalled.addListener(() => poll());
chrome.runtime.onStartup.addListener(() => poll());
chrome.alarms.create('maternal-radar-poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => poll());
setInterval(poll, 5000);
poll();
