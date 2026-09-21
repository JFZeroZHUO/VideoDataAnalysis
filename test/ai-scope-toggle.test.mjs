import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync(new URL('../src/ResearchWorkspace.jsx', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const helper = fs.readFileSync(new URL('../browser-helper/background.js', import.meta.url), 'utf8');

test('抖音采集面板提供仅采集AI生成视频开关', () => {
  assert.match(ui, /仅采集 AI 生成视频/);
  assert.match(ui, /type="checkbox" checked=\{requireAiEvidence\}/);
  assert.match(ui, /requireAiEvidence: platform === 'douyin' \? requireAi : true/);
});

test('关闭AI限定会绕过详情页并标记搜索结果模式', () => {
  assert.match(server, /settings\.requireAiEvidence === false/);
  assert.match(helper, /task\.requireAiEvidence === false/);
  assert.match(helper, /aiVerificationSkipped: true/);
  assert.match(helper, /collectionScope: 'search_results_only'/);
});
