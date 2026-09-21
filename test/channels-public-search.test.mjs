import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workerSource = fs.readFileSync(
  new URL('../server/windows/wechat-channels-public.ps1', import.meta.url),
  'utf8'
);

test('视频号公域采集从视频号页面右上角搜索入口开始', () => {
  assert.match(workerSource, /function Open-ChannelsKeywordSearch/);
  assert.match(workerSource, /\$channels = Get-ChannelsHomeWindow/);
  assert.match(workerSource, /\$documentRect = \$channels\.Document\.Current\.BoundingRectangle/);
  assert.match(workerSource, /Click-Point \(\$documentRect\.Right - \$iconOffset\)/);
  assert.match(workerSource, /Open-ChannelsKeywordSearch \$keyword/);
});

test('视频号右上角搜索会直接等待视频或视频号结果页', () => {
  assert.match(workerSource, /视频\(\?:号\)\?/);
  assert.match(workerSource, /Wait-SearchResults \$root \$keyword/);
  assert.doesNotMatch(workerSource, /Select-VideoSearchTab/);
});

test('进入视频结果页后会先点击最热再采集详情', () => {
  const waitIndex = workerSource.indexOf('Wait-SearchResults $root $keyword');
  const hotIndex = workerSource.indexOf('Select-HottestSearchFilter $root $resultsDocument', waitIndex);
  const detailIndex = workerSource.indexOf('for ($rankIndex = 0;', hotIndex);

  assert.notEqual(waitIndex, -1);
  assert.notEqual(hotIndex, -1);
  assert.notEqual(detailIndex, -1);
  assert.ok(waitIndex < hotIndex);
  assert.ok(hotIndex < detailIndex);
  assert.match(workerSource, /Find-One \$WindowRoot \$null '最热' ''/);
});

test('最热筛选结果会写入素材证据字段', () => {
  assert.match(workerSource, /searchFilterVerified = \$SearchFilterVerified/);
  assert.match(workerSource, /sortLabel = '视频号·最热'/);
  assert.match(workerSource, /hotFilterMethod = \$hotFilter\.Method/);
});

test('视频号窗口使用已验证的 WeChatAppEx 顶层窗口句柄', () => {
  assert.doesNotMatch(workerSource, /\.MainWindowHandle/);
  assert.match(workerSource, /Get-Process WeChatAppEx/);
  assert.match(workerSource, /\$handle = \$channels\.Handle/);
  assert.match(workerSource, /FindTopLevelWindow\(\$process\.Id, '微信'\)/);
});
