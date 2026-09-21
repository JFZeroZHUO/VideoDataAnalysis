export const DOUYIN_TIME_RANGE_LABELS = {
  one_day: '一天内',
  one_week: '一周内',
  half_year: '半年内',
  unlimited: '不限'
};

export function normalizeDouyinTimeRange(value) {
  return Object.hasOwn(DOUYIN_TIME_RANGE_LABELS, value) ? value : 'half_year';
}

async function clickFilterTrigger(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const candidates = [...document.querySelectorAll('button, [role="button"], div, span')]
      .filter((element) => visible(element) && (element.innerText || element.textContent || '').trim() === '筛选');
    const target = candidates.at(-1);
    if (!target) return false;
    (target.closest('button, [role="button"]') || target).click();
    return true;
  }).catch(() => false);
}

async function selectPanelOption(page, sectionHeading, sectionOptions, targetLabel) {
  return page.evaluate(({ heading, options, target }) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const text = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    const panels = [...document.querySelectorAll('div, section, aside')]
      .filter((element) => visible(element) && /排序依据/.test(text(element)) && /发布时间/.test(text(element)) && /内容形式/.test(text(element)))
      .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    const panel = panels[0];
    if (!panel) return { clicked: false, reason: 'filter_panel_missing' };
    const headingElement = [...panel.querySelectorAll('*')]
      .find((element) => visible(element) && text(element) === heading);
    if (!headingElement) return { clicked: false, reason: `section_missing:${heading}` };
    const ancestors = [];
    for (let element = headingElement.parentElement; element && panel.contains(element); element = element.parentElement) {
      const sectionText = text(element);
      if (options.every((label) => sectionText.includes(label))) ancestors.push(element);
      if (element === panel) break;
    }
    const section = ancestors.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    if (!section) return { clicked: false, reason: `section_options_missing:${heading}` };
    const targets = [...section.querySelectorAll('*')]
      .filter((element) => visible(element) && text(element) === target)
      .sort((a, b) => a.children.length - b.children.length);
    const option = targets[0];
    if (!option) return { clicked: false, reason: `option_missing:${target}` };
    (option.closest('button, [role="button"]') || option).click();
    return { clicked: true };
  }, { heading: sectionHeading, options: sectionOptions, target: targetLabel }).catch(() => ({ clicked: false, reason: 'page_evaluation_failed' }));
}

async function verifyPanelOption(page, sectionHeading, sectionOptions, targetLabel) {
  return page.evaluate(({ heading, options, target }) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const text = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    const rgbAccent = (value) => {
      const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return false;
      const [, red, green, blue] = match.map(Number);
      return red > 150 && red > green * 1.45 && red > blue * 1.15;
    };
    const panels = [...document.querySelectorAll('div, section, aside')]
      .filter((element) => visible(element) && /排序依据/.test(text(element)) && /发布时间/.test(text(element)) && /内容形式/.test(text(element)))
      .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    const panel = panels[0];
    if (!panel) return false;
    const headingElement = [...panel.querySelectorAll('*')].find((element) => visible(element) && text(element) === heading);
    if (!headingElement) return false;
    const ancestors = [];
    for (let element = headingElement.parentElement; element && panel.contains(element); element = element.parentElement) {
      if (options.every((label) => text(element).includes(label))) ancestors.push(element);
      if (element === panel) break;
    }
    const section = ancestors.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    const option = section && [...section.querySelectorAll('*')]
      .filter((element) => visible(element) && text(element) === target)
      .sort((a, b) => a.children.length - b.children.length)[0];
    if (!option) return false;
    for (let element = option; element && section.contains(element); element = element.parentElement) {
      const style = window.getComputedStyle(element);
      const semantic = element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true' ||
        /(?:active|selected|checked|current)/i.test(`${element.className || ''} ${element.getAttribute('data-state') || ''}`);
      if (semantic || rgbAccent(style.color) || rgbAccent(style.backgroundColor)) return true;
      if (element === section) break;
    }
    return false;
  }, { heading: sectionHeading, options: sectionOptions, target: targetLabel }).catch(() => false);
}

export async function applyDouyinPopularFilters(page, timeRange = 'half_year') {
  const normalizedTimeRange = normalizeDouyinTimeRange(timeRange);
  const timeLabel = DOUYIN_TIME_RANGE_LABELS[normalizedTimeRange];
  if (!await clickFilterTrigger(page)) throw new Error('没有找到抖音搜索页右侧“筛选”按钮');
  await page.waitForTimeout(500);
  const selections = [
    ['内容形式', ['不限', '视频', '图文'], '视频'],
    ['发布时间', ['不限', '一天内', '一周内', '半年内'], timeLabel],
    ['排序依据', ['综合排序', '最新发布', '最多点赞'], '最多点赞']
  ];
  for (const [heading, options, target] of selections) {
    const result = await selectPanelOption(page, heading, options, target);
    if (!result.clicked) throw new Error(`抖音筛选失败：${heading}“${target}”不可用`);
    await page.waitForTimeout(900);
    if (!await verifyPanelOption(page, heading, options, target)) {
      throw new Error(`抖音筛选未确认生效：${heading}“${target}”`);
    }
  }
  return {
    sort: 'most_liked',
    sortLabel: '最多点赞',
    timeRange: normalizedTimeRange,
    timeLabel,
    contentType: 'video',
    contentTypeLabel: '视频',
    verified: true
  };
}
