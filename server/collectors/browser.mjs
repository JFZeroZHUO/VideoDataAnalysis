import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { projectDir } from '../db.mjs';
import { detectPageAttentionText } from '../verification.mjs';

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

export function findBrowserExecutable() {
  return chromeCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export async function launchCollectorBrowser(platform) {
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error('未找到 Chrome 或 Edge，请先安装浏览器，或通过 CHROME_PATH 指定位置。');
  }
  const profilePath = path.join(projectDir, 'data', 'browser-profiles', platform);
  fs.mkdirSync(profilePath, { recursive: true });
  return chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: false,
    viewport: null,
    locale: 'zh-CN',
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
}

export async function gentlyScroll(page, rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(1100 + index * 250);
  }
}

export async function inspectPageReadiness(page, selector) {
  const count = await page.locator(selector).count().catch(() => 0);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const captchaSelector = [
    'iframe[src*="captcha"]',
    'iframe[src*="verify"]',
    '[id*="captcha"]',
    '[class*="captcha"]'
  ].join(',');
  const hasVisibleCaptcha = await page.locator(captchaSelector).evaluateAll((elements) => elements.some((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  })).catch(() => false);
  return { count, attention: detectPageAttentionText(bodyText, hasVisibleCaptcha) };
}

export async function waitForLoginResults({ page, selector, onWaiting, timeoutMs = 600000 }) {
  const startedAt = Date.now();
  let broughtToFront = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (page.isClosed()) throw new Error('浏览器窗口已关闭，采集任务已停止。');
    const state = await inspectPageReadiness(page, selector);
    if (!state.attention.requiresAttention && state.count > 0) return true;
    if (state.attention.requiresAttention && !broughtToFront) {
      await page.bringToFront().catch(() => {});
      broughtToFront = true;
    }
    await onWaiting?.(Math.round((Date.now() - startedAt) / 1000), state);
    await page.waitForTimeout(3000);
  }
  return false;
}
