import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOUYIN_SEARCH_RESULT_SELECTOR, sourceUrlFromDouyinModalUrl } from '../server/douyin-card-schema.mjs';

test('新版抖音搜索卡片与旧链接结构都可进入就绪判断', () => {
  assert.match(DOUYIN_SEARCH_RESULT_SELECTOR, /search-result-card/);
  assert.match(DOUYIN_SEARCH_RESULT_SELECTOR, /video/);
});

test('从新版搜索弹窗地址还原公开视频详情链接', () => {
  assert.equal(
    sourceUrlFromDouyinModalUrl('https://www.douyin.com/search/防溢乳垫?modal_id=7382727182054853898&type=general'),
    'https://www.douyin.com/video/7382727182054853898'
  );
  assert.equal(sourceUrlFromDouyinModalUrl('https://www.douyin.com/search/防溢乳垫?type=general'), null);
});

test('直接视频地址支持抖音主域和子域并统一为规范链接', () => {
  for (const url of [
    'https://www.douyin.com/video/7382727182054853898',
    'http://douyin.com/video/7382727182054853898?from=search#detail',
    'https://m.douyin.com/video/7382727182054853898/'
  ]) {
    assert.equal(sourceUrlFromDouyinModalUrl(url), 'https://www.douyin.com/video/7382727182054853898', url);
  }
  assert.equal(sourceUrlFromDouyinModalUrl('https://douyin.com/video/12345678'), 'https://www.douyin.com/video/12345678');
});

test('直接视频路径ID优先于弹窗参数，非视频路径仍支持弹窗ID', () => {
  assert.equal(
    sourceUrlFromDouyinModalUrl('https://www.douyin.com/video/7382727182054853898?modal_id=12345678'),
    'https://www.douyin.com/video/7382727182054853898'
  );
  assert.equal(sourceUrlFromDouyinModalUrl('http://m.douyin.com/search/test?modal_id=12345678'), 'https://www.douyin.com/video/12345678');
});

test('拒绝外站、相似域名和非HTTP协议', () => {
  for (const url of [
    'https://example.com/video/12345678?modal_id=12345678',
    'https://douyin.com.example.com/search/test?modal_id=12345678',
    'https://notdouyin.com/search/test?modal_id=12345678',
    'https://douyin.com@example.com/video/12345678',
    'ftp://www.douyin.com/video/12345678?modal_id=12345678',
    'javascript:alert(1)?modal_id=12345678',
    'file:///video/12345678?modal_id=12345678'
  ]) {
    assert.equal(sourceUrlFromDouyinModalUrl(url), null, url);
  }
});

test('拒绝无效视频ID、非详情路径、相对地址和无法解析的输入', () => {
  for (const url of [
    'https://www.douyin.com/video/1234567',
    'https://www.douyin.com/video/12345678abc',
    'https://www.douyin.com/video/12345678/extra',
    'https://www.douyin.com/user/12345678',
    'https://www.douyin.com/search/test?modal_id=1234567',
    'https://www.douyin.com/search/test?modal_id=12345678abc',
    'https://www.douyin.com/search/test?modal_id=-12345678',
    'https://www.douyin.com/search/test#modal_id=12345678',
    '/video/12345678',
    'not-a-url',
    '',
    null,
    undefined
  ]) {
    assert.equal(sourceUrlFromDouyinModalUrl(url), null, String(url));
  }
});

test('浏览器助手包含新版卡片选择器和弹窗ID解析', () => {
  const source = fs.readFileSync(new URL('../browser-helper/background.js', import.meta.url), 'utf8');
  assert.match(source, /\.search-result-card/);
  assert.match(source, /modal_id/);
  assert.match(source, /helperVersion = '2\.2\.0'/);
  assert.match(source, /Boolean\(querySpec\.aiTargeted\)/);
});

test('抖音关键词会深度加载最多点赞结果而不是只取首屏12条', () => {
  const helperSource = fs.readFileSync(new URL('../browser-helper/background.js', import.meta.url), 'utf8');
  const cdpSource = fs.readFileSync(new URL('../server/collectors/douyin.mjs', import.meta.url), 'utf8');
  assert.match(helperSource, /filterState, 160/);
  assert.match(helperSource, /rows\.slice\(0, 160\)/);
  assert.match(cdpSource, /gentlyScroll\(page, 12\)/);
  assert.match(cdpSource, /rows: \[\.\.\.unique\.values\(\)\]\.slice\(0, 160\)/);
});

test('浏览器助手2.0会从视频号内容分析页逐页读取账号指标', () => {
  const source = fs.readFileSync(new URL('../browser-helper/background.js', import.meta.url), 'utf8');
  assert.match(source, /platform\/statistic\/post/);
  assert.match(source, /clickNextChannelsPage/);
  assert.match(source, /owned_account_analytics/);
  assert.match(source, /aiEvidenceVerified/);
});
