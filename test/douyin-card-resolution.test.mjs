import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MATERNAL_RADAR_DB = ':memory:';
const { collectDouyin, resolveModernCardUrls } = await import('../server/collectors/douyin.mjs');

const SEARCH_URL = 'https://www.douyin.com/search/dance?type=general';
const VIDEO_URL = 'https://www.douyin.com/video/7382727182054853898';
const MODAL_URL = `${SEARCH_URL}&modal_id=7382727182054853898`;
const fastOptions = { timeoutMs: 25, pollIntervalMs: 5, restoreTimeoutMs: 15, query: 'dance' };

test('采集中断时错误携带阶段诊断，不访问生产页面或数据库', async () => {
  const failure = new Error('模拟搜索页导航中断');
  await assert.rejects(collectDouyin({
    page: { goto: async () => { throw failure; } },
    queries: ['舞蹈'], maxResults: 20, update: async () => {}
  }), (error) => {
    assert.equal(error, failure);
    assert.equal(error.collectionDiagnostics.searchCardCount, 0);
    assert.equal(error.collectionDiagnostics.collectedCount, 0);
    assert.deepEqual(error.collectionDiagnostics.failureReasons, {});
    return true;
  });
});

function makeCollectionPage({ filterAvailable = true, rows = [] } = {}) {
  const page = {
    currentUrl: SEARCH_URL, navigated: [],
    url: () => page.currentUrl,
    goto: async (url) => { page.currentUrl = url; page.navigated.push(url); },
    waitForTimeout: async () => {},
    mouse: { wheel: async () => {} },
    locator: () => ({ count: async () => 1, innerText: async () => '正常视频列表', evaluateAll: async () => false }),
    evaluate: async (_callback, argument) => {
      if (typeof argument === 'string') return { cardCount: rows.length, rows, emptyTextCount: 0, duplicateCount: 0, limitCount: 0 };
      if (argument?.heading) return { clicked: true };
      return filterAvailable;
    }
  };
  return page;
}

test('每个关键词筛选失败都有原因和进度诊断，不能伪装成无匹配结果', async () => {
  const page = makeCollectionPage({ filterAvailable: false });
  const updates = [];
  let failures = 0;
  const candidates = await collectDouyin({
    page, queries: ['舞蹈', '街舞'], maxResults: 5,
    update: async (value) => updates.push(structuredClone(value)),
    onQueryFailure: async () => ++failures
  });
  assert.equal(candidates.length, 0);
  assert.equal(candidates.collectionDiagnostics.skippedQueryCount, 2);
  assert.equal(candidates.collectionDiagnostics.failureReasons.native_filter_failed, 2);
  assert.deepEqual(candidates.collectionDiagnostics.failureSamples.map((sample) => sample.query), ['舞蹈', '街舞']);
  assert.equal(updates.filter((update) => update.phase === 'search_skipped').length, 2);
  assert.equal(updates.at(-1).collectionDiagnostics.skippedQueryCount, 2);
  assert.equal(updates.at(-1).failedCount, 2);
});

test('collectDouyin传递剩余额度，达到显式上限后不再搜索下一关键词', async () => {
  const rows = [1, 2, 3].map((id) => ({
    sourceUrl: `https://www.douyin.com/video/738272718205485389${id}`, title: `舞蹈视频${id}`, rawText: '舞蹈视频'
  }));
  const page = makeCollectionPage({ rows });
  const candidates = await collectDouyin({ page, queries: ['舞蹈', '街舞'], maxResults: 2, update: async () => {} });
  assert.equal(candidates.length, 2);
  assert.equal(page.navigated.length, 1);
  assert.equal(candidates.searchCardCount, 3);
  assert.equal(candidates.collectionDiagnostics.directUrlCount, 2);
  assert.equal(candidates.collectionDiagnostics.resultLimitCount, 1);
  assert.equal(candidates.collectionDiagnostics.collectedCount, 2);
});

function makeRow(name = 'a') {
  return {
    cardKey: `card-${name}`,
    cardText: `视频 ${name} 的原始卡片正文`,
    title: `视频 ${name}`,
    thumbnailUrl: `https://images.example/${name}.jpg`
  };
}

function makeCard(row, action = () => {}, marker = row.cardKey) {
  const attributes = new Map(marker ? [['data-collector-card-key', marker]] : []);
  const image = { currentSrc: row.thumbnailUrl, src: row.thumbnailUrl };
  return {
    name: row.title,
    innerText: row.cardText,
    textContent: row.cardText,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    querySelector: (selector) => selector === 'img' ? image : null,
    action
  };
}

function makePage(cards, { initialUrl = SEARCH_URL, escapeRestores = true, backRestores = true } = {}) {
  const listeners = new Map();
  const scheduled = [];
  const page = {
    cards,
    currentUrl: initialUrl,
    elapsedMs: 0,
    clicked: [],
    escapes: 0,
    backCalls: 0,
    gotoCalls: [],
    popups: [],
    url: () => page.currentUrl,
    isClosed: () => false,
    on: (event, handler) => { listeners.set(event, [...(listeners.get(event) || []), handler]); return page; },
    off: (event, handler) => { listeners.set(event, (listeners.get(event) || []).filter((item) => item !== handler)); return page; },
    listenerCount: (event) => (listeners.get(event) || []).length,
    schedule: (delay, action) => scheduled.push({ due: page.elapsedMs + delay, action }),
    waitForTimeout: async (milliseconds) => {
      page.elapsedMs += milliseconds;
      for (const item of [...scheduled]) {
        if (item.due <= page.elapsedMs) {
          scheduled.splice(scheduled.indexOf(item), 1);
          item.action();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    evaluate: async (callback, identity) => {
      const previousDocument = globalThis.document;
      globalThis.document = {
        querySelectorAll: (selector) => {
          assert.equal(selector, '.search-result-card');
          return page.cards;
        }
      };
      try {
        return callback(identity);
      } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
      }
    },
    locator: (selector) => ({
      count: async () => new URL(page.currentUrl).pathname.startsWith('/search/') ? page.cards.length : 0,
      click: async () => {
        const key = selector.match(/^\[data-collector-card-key="([^"]+)"\]$/)?.[1];
        assert.ok(key, `应按稳定卡片标记点击，而非序号：${selector}`);
        const matches = page.cards.filter((card) => card.getAttribute('data-collector-card-key') === key);
        assert.equal(matches.length, 1, '点击标记必须唯一');
        page.clicked.push(matches[0].name);
        await matches[0].action(page);
      }
    }),
    keyboard: {
      press: async (key) => {
        assert.equal(key, 'Escape');
        page.escapes += 1;
        if (escapeRestores && new URL(page.currentUrl).searchParams.has('modal_id')) page.currentUrl = SEARCH_URL;
      }
    },
    goBack: async () => { page.backCalls += 1; if (backRestores) page.currentUrl = SEARCH_URL; },
    goto: async (url) => { page.gotoCalls.push(url); page.currentUrl = url; },
    openPopup: () => {
      const popup = {
        currentUrl: 'about:blank',
        closed: false,
        url: () => popup.currentUrl,
        isClosed: () => popup.closed,
        close: async () => { popup.closed = true; }
      };
      page.popups.push(popup);
      for (const handler of listeners.get('popup') || []) handler(popup);
      return popup;
    }
  };
  return page;
}

test('已有合法详情链接无需点击，返回结构包含诊断统计', async () => {
  const row = { ...makeRow(), sourceUrl: VIDEO_URL };
  const page = makePage([]);
  const result = await resolveModernCardUrls(page, [row], fastOptions);
  assert.deepEqual(result.rows, [row]);
  assert.equal(result.diagnostics.directUrlCount, 1);
  assert.equal(result.diagnostics.linkFailureCount, 0);
  assert.deepEqual(page.clicked, []);
  const nextResult = await resolveModernCardUrls(page, [row], { ...fastOptions, diagnostics: result.diagnostics });
  assert.equal(nextResult.diagnostics, result.diagnostics);
  assert.equal(nextResult.diagnostics.directUrlCount, 2);
});

test('显式结果上限达到后不再点击余下卡片，并记录未处理行数量', async () => {
  const rows = [makeRow('first'), makeRow('second'), makeRow('third')];
  const page = makePage(rows.map((row) => makeCard(row, (current) => { current.currentUrl = MODAL_URL; })));
  const result = await resolveModernCardUrls(page, rows, { ...fastOptions, maxResults: 1 });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(page.clicked, [rows[0].title]);
  assert.equal(result.diagnostics.clickAttemptCount, 1);
  assert.equal(result.diagnostics.resultLimitCount, 2);
  assert.equal(result.diagnostics.linkFailureCount, 0);
  assert.equal(page.currentUrl, SEARCH_URL);
});

test('解析失败不占用成功结果上限，零剩余额度不会点击卡片', async () => {
  const missing = makeRow('missing');
  const valid = makeRow('valid');
  const remaining = makeRow('remaining');
  const page = makePage([valid, remaining].map((row) => makeCard(row, (current) => { current.currentUrl = MODAL_URL; })));
  const result = await resolveModernCardUrls(page, [missing, valid, remaining], { ...fastOptions, maxResults: 1 });
  assert.deepEqual(result.rows.map((row) => row.title), [valid.title]);
  assert.equal(result.diagnostics.linkFailureCount, 1);
  assert.equal(result.diagnostics.resultLimitCount, 1);
  const capped = await resolveModernCardUrls(page, [remaining], { ...fastOptions, maxResults: 0 });
  assert.deepEqual(capped.rows, []);
  assert.deepEqual(page.clicked, [valid.title]);
  assert.equal(capped.diagnostics.resultLimitCount, 1);
});

test('弹窗链接晚于450毫秒出现仍能轮询取得并恢复搜索页', async () => {
  const row = makeRow();
  const page = makePage([makeCard(row, (current) => current.schedule(600, () => { current.currentUrl = MODAL_URL; }))]);
  const result = await resolveModernCardUrls(page, [row], { ...fastOptions, timeoutMs: 1000, pollIntervalMs: 100 });
  assert.equal(result.rows[0]?.sourceUrl, VIDEO_URL);
  assert.ok(page.elapsedMs >= 600);
  assert.equal(result.diagnostics.clickResolvedCount, 1);
  assert.equal(page.currentUrl, SEARCH_URL);
  assert.equal(page.listenerCount('popup'), 0);
});

test('直接跳转视频详情时读取路径ID并通过返回恢复搜索页', async () => {
  const row = makeRow();
  const page = makePage([makeCard(row, (current) => { current.currentUrl = VIDEO_URL; })]);
  const result = await resolveModernCardUrls(page, [row], fastOptions);
  assert.equal(result.rows[0]?.sourceUrl, VIDEO_URL);
  assert.ok(page.backCalls > 0);
  assert.equal(page.currentUrl, SEARCH_URL);
});

test('新标签先about:blank后出现视频地址时继续等待并关闭标签', async () => {
  const row = makeRow();
  const page = makePage([makeCard(row, (current) => {
    const popup = current.openPopup();
    current.schedule(15, () => { popup.currentUrl = VIDEO_URL; });
  })]);
  const result = await resolveModernCardUrls(page, [row], fastOptions);
  assert.equal(result.rows[0]?.sourceUrl, VIDEO_URL);
  assert.equal(result.diagnostics.popupResolvedCount, 1);
  assert.equal(page.popups[0].closed, true);
  assert.equal(page.listenerCount('popup'), 0);
  assert.equal(page.currentUrl, SEARCH_URL);
});

test('一次点击失败后恢复页面并继续下一卡片，失败原因可追溯', async () => {
  const failed = makeRow('failed');
  const next = makeRow('next');
  const page = makePage([
    makeCard(failed, (current) => { current.currentUrl = MODAL_URL; throw new Error('模拟点击中断'); }),
    makeCard(next, (current) => { current.currentUrl = MODAL_URL; })
  ]);
  const result = await resolveModernCardUrls(page, [failed, next], fastOptions);
  assert.deepEqual(result.rows.map((row) => row.title), [next.title]);
  assert.deepEqual(page.clicked, [failed.title, next.title]);
  assert.equal(result.diagnostics.linkFailureCount, 1);
  assert.equal(result.diagnostics.failureReasons.click_failed, 1);
  assert.equal(result.diagnostics.failureSamples[0].query, 'dance');
  assert.equal(result.diagnostics.failureSamples[0].title, failed.title);
  assert.equal(page.currentUrl, SEARCH_URL);
  assert.equal(page.listenerCount('popup'), 0);
});

test('Escape未关闭弹窗时重新打开原搜索页后继续', async () => {
  const first = makeRow('first');
  const second = makeRow('second');
  const page = makePage([
    makeCard(first, (current) => { current.currentUrl = MODAL_URL; }),
    makeCard(second, (current) => { current.currentUrl = `${SEARCH_URL}&modal_id=12345678`; })
  ], { escapeRestores: false, backRestores: false });
  const result = await resolveModernCardUrls(page, [first, second], fastOptions);
  assert.equal(result.rows.length, 2);
  assert.ok(page.gotoCalls.includes(SEARCH_URL));
  assert.equal(page.currentUrl, SEARCH_URL);
  assert.equal(result.diagnostics.restoreFailureCount, 0);
});

test('卡片位置改变且旧标记被复用时用正文和缩略图重新定位，不误点', async () => {
  const desired = makeRow('desired');
  const other = makeRow('other');
  const page = makePage([
    makeCard(other, () => { throw new Error('误点了位置变化后的其他卡片'); }, desired.cardKey),
    makeCard(desired, (current) => { current.currentUrl = MODAL_URL; }, null)
  ]);
  const result = await resolveModernCardUrls(page, [desired], fastOptions);
  assert.deepEqual(page.clicked, [desired.title]);
  assert.equal(result.rows[0]?.sourceUrl, VIDEO_URL);
  assert.equal(result.diagnostics.linkFailureCount, 0);
});

test('卡片消失或正文缩略图匹配不唯一时不点击并分别记录失败', async () => {
  const missing = makeRow('missing');
  const ambiguous = makeRow('ambiguous');
  const page = makePage([makeCard(ambiguous, () => {}, null), makeCard(ambiguous, () => {}, null)]);
  const result = await resolveModernCardUrls(page, [missing, ambiguous], fastOptions);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(page.clicked, []);
  assert.equal(result.diagnostics.linkFailureCount, 2);
  assert.equal(result.diagnostics.failureReasons.card_missing, 1);
  assert.equal(result.diagnostics.failureReasons.card_ambiguous, 1);
});

test('点击前已存在的modal_id不能当成此次卡片的新链接', async () => {
  const row = makeRow();
  const page = makePage([makeCard(row)], { initialUrl: MODAL_URL });
  const result = await resolveModernCardUrls(page, [row], fastOptions);
  assert.deepEqual(result.rows, []);
  assert.equal(result.diagnostics.linkFailureCount, 1);
  assert.equal(result.diagnostics.failureReasons.url_unresolved, 1);
  assert.equal(page.listenerCount('popup'), 0);
});

test('所有恢复手段均失败时记录恢复失败并停止点击后续卡片', async () => {
  const first = makeRow('first');
  const second = makeRow('second');
  const page = makePage([
    makeCard(first, (current) => { current.currentUrl = MODAL_URL; }),
    makeCard(second, () => { throw new Error('搜索页未恢复时不应点击下一张卡片'); })
  ], { escapeRestores: false, backRestores: false });
  page.goto = async (url) => { page.gotoCalls.push(url); throw new Error('模拟恢复导航失败'); };
  const result = await resolveModernCardUrls(page, [first, second], fastOptions);
  assert.deepEqual(result.rows.map((row) => row.title), [first.title]);
  assert.deepEqual(page.clicked, [first.title]);
  assert.equal(result.diagnostics.restoreFailureCount, 1);
  assert.equal(result.diagnostics.linkFailureCount, 1);
  assert.equal(result.diagnostics.failureReasons.search_restore_failed, 2);
  assert.equal(result.diagnostics.failureSamples.length, 2);
  assert.deepEqual(result.diagnostics.failureSamples.map((sample) => sample.title), [first.title, second.title]);
  assert.equal(page.listenerCount('popup'), 0);
});

test('新标签关闭失败单独计入恢复诊断，已解析视频仍保留', async () => {
  const row = makeRow();
  const page = makePage([makeCard(row, (current) => {
    const popup = current.openPopup();
    popup.currentUrl = VIDEO_URL;
    popup.close = async () => { throw new Error('模拟新标签关闭失败'); };
  })]);
  const result = await resolveModernCardUrls(page, [row], fastOptions);
  assert.equal(result.rows[0]?.sourceUrl, VIDEO_URL);
  assert.equal(result.diagnostics.popupResolvedCount, 1);
  assert.equal(result.diagnostics.restoreFailureCount, 1);
  assert.equal(result.diagnostics.linkFailureCount, 0);
  assert.equal(result.diagnostics.failureReasons.popup_close_failed, 1);
  assert.equal(result.diagnostics.failureSamples[0].title, row.title);
  assert.match(result.diagnostics.failureSamples[0].message, /模拟新标签关闭失败/);
  assert.equal(page.currentUrl, SEARCH_URL);
  assert.equal(page.listenerCount('popup'), 0);
});
