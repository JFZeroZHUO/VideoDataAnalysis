import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { interactDouyinSearch } from '../local-extension/search-form.mjs';
import { sharedDouyinPlugin } from '../scripts/build-extension.mjs';

const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const source = await build({ entryPoints: ['local-extension/collector.mjs'], bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [sharedDouyinPlugin()] });
const { inspectDouyinPage } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
const reactFixture = await build({ stdin: { resolveDir: process.cwd(), contents: `
  import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
  function Search() {
    const [word, setWord] = useState('旧关键词');
    return React.createElement('header', null, React.createElement('div', { role: 'search' },
      React.createElement('input', { placeholder: '搜索你感兴趣的内容', value: word, onChange: event => setWord(event.target.value) }),
      React.createElement('button', { onClick: () => { window.submitted = word; history.pushState({}, '', '/root/search/' + encodeURIComponent(word) + '?aid=native-router'); } }, '搜索')));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Search));
` }, bundle: true, platform: 'browser', format: 'iife', write: false });

test('真实Chrome和React受控搜索框：提交原词并由页面路由产生网址，不点击页面外其它搜索', { skip: !executablePath, timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div id="root"></div><div style="display:none"><input placeholder="搜索" /></div><button onclick="window.wrong=true">搜索</button>' }));
    await page.goto('https://www.douyin.com/');
    await page.addScriptTag({ content: reactFixture.outputFiles[0].text });
    await page.getByPlaceholder('搜索你感兴趣的内容').waitFor();
    for (const keyword of ['奶瓶', 'AI舞蹈 + Sora#品牌']) {
      assert.equal((await page.evaluate(interactDouyinSearch, { action: 'inspect' })).ready, true);
      assert.equal((await page.evaluate(interactDouyinSearch, { action: 'fill', keyword })).value, keyword);
      await page.waitForTimeout(300);
      assert.equal((await page.evaluate(interactDouyinSearch, { action: 'submit', keyword })).method, 'button');
      assert.equal(await page.evaluate(() => window.submitted), keyword);
      assert.equal(decodeURIComponent(new URL(page.url()).pathname), '/root/search/' + keyword);
      assert.equal(await page.evaluate(() => window.wrong), undefined);
    }
    await page.locator('header').evaluate(element => element.appendChild(element.querySelector('input').cloneNode()));
    assert.equal((await page.evaluate(interactDouyinSearch, { action: 'fill', keyword: '不应写入' })).ready, false);
  } finally { await browser.close(); }
});

test('识别中英文502整页网关错误，不把视频标题中的502当成故障', { skip: !executablePath, timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const heading of ['502 Bad Gateway', '502错误的网关', '502 网关错误']) {
      await page.setContent(`<title>${heading}</title><h1>${heading}</h1><hr>kngx/1.10.2`);
      assert.equal((await page.evaluate(inspectDouyinPage)).gatewayError, true);
    }
    await page.setContent('<title>502 Bad Gateway 教程</title><article class="search-result-card">502 Bad Gateway 教程</article>');
    assert.equal((await page.evaluate(inspectDouyinPage)).gatewayError, false);
  } finally { await browser.close(); }
});

test('原生form、回车和无固定class的搜索入口均保留原词，改词拒绝提交', { skip: !executablePath, timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const method of ['form', 'enter', 'button']) {
      await page.setContent(`<${method === 'form' ? 'form' : 'header'}><input type="search" aria-label="搜索">${method === 'button' ? '<div class="random-hash"><span>搜索</span></div>' : ''}</${method === 'form' ? 'form' : 'header'}>`);
      await page.evaluate((method) => {
        const input = document.querySelector('input'); window.received = null;
        if (method === 'form') document.querySelector('form').onsubmit = event => { event.preventDefault(); window.received = input.value; };
        else if (method === 'button') document.querySelector('.random-hash').onclick = () => { window.received = input.value; };
        else input.onkeydown = event => { if (event.key === 'Enter') window.received = input.value; };
      }, method);
      await page.evaluate(interactDouyinSearch, { action: 'fill', keyword: '奶瓶' });
      assert.equal((await page.evaluate(interactDouyinSearch, { action: 'submit', keyword: '错误词' })).submitted, undefined);
      assert.equal((await page.evaluate(interactDouyinSearch, { action: 'submit', keyword: '奶瓶' })).method, method);
      assert.equal(await page.evaluate(() => window.received), '奶瓶');
    }
  } finally { await browser.close(); }
});
