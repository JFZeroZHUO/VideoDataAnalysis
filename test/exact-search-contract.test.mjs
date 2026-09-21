import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const apiSource = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const cdpSource = fs.readFileSync(new URL('../server/cdp-collector.mjs', import.meta.url), 'utf8');
const helperSource = fs.readFileSync(new URL('../server/browser-helper.mjs', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../src/ResearchWorkspace.jsx', import.meta.url), 'utf8');

test('抖音队列为空时服务端拒绝采集，不回退到内置母婴矩阵', () => {
  assert.match(apiSource, /\['douyin', 'channels'\]\.includes\(platform\) && !settings\.keywords\.length/);
  assert.match(cdpSource, /抖音采集只执行你加入搜索队列的关键词/);
  assert.match(helperSource, /抖音采集只执行你加入搜索队列的关键词/);
});

test('界面明确告知只搜索用户队列原词', () => {
  assert.match(uiSource, /一个词，抓取它自己的爆款结果/);
  assert.match(uiSource, /仅执行队列原词 · 不追加 · 不替换/);
});

test('回车只加入原词，DeepSeek扩词改为用户主动触发', () => {
  assert.match(uiSource, /可选AI扩词/);
  assert.match(uiSource, /openOptionalSuggestions/);
  assert.doesNotMatch(uiSource, /if \(seedKeyword\) await requestSuggestions/);
});

test('刷新后仍保持本次关键词结果，不自动回到历史素材库', () => {
  assert.match(uiSource, /readStoredDouyinSearchState/);
  assert.match(uiSource, /storeDouyinSearchState\(window\.localStorage/);
  assert.match(uiSource, /nextMeta\.searchStates\?\.douyin/);
  assert.match(uiSource, /recentSearchTerms\?\.douyin/);
  assert.match(uiSource, /刷新后仍保持/);
});
