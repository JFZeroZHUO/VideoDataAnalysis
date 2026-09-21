import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fallbackApiUrl = 'https://api.deepseek.com/chat/completions';
const modelsApiUrl = 'https://api.deepseek.com/models';
const supportedModels = ['deepseek-flash', 'deepseek-v4-pro'];
const fallbackModel = supportedModels[0];
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, '..');
const localWorkspaceRoot = path.resolve(projectDir, '..');
let localConfigCache = null;

function hostedMode() { return Boolean(process.env.VERCEL) || process.env.DEPLOYMENT_MODE === 'cloud'; }

function deepSeekError(message, status, code) { return Object.assign(new Error(message), { status, code }); }

function allowedModel(value, strict = false) {
  const model = String(value || fallbackModel).trim();
  if (supportedModels.includes(model)) return model;
  if (strict) throw deepSeekError('请选择 DeepSeek Flash 或 DeepSeek V4 Pro。', 400, 'DEEPSEEK_INVALID_MODEL');
  return fallbackModel;
}

export function deepSeekRequestAccess(request, { requireJson = false } = {}) {
  if (requireJson && String(request.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw deepSeekError('此接口只接受 application/json 请求。', 415, 'DEEPSEEK_JSON_REQUIRED');
  }
  const host = String(request.headers?.host || '').toLowerCase();
  const protocol = request.socket?.encrypted || hostedMode() ? 'https:' : 'http:';
  let serverUrl;
  try {
    serverUrl = new URL(`${protocol}//${host}`);
    if (!host || serverUrl.host !== host || serverUrl.username || serverUrl.password) throw new Error();
  } catch { throw deepSeekError('请求地址无效。', 400, 'DEEPSEEK_INVALID_HOST'); }
  const origin = request.headers?.origin;
  if (origin !== undefined) {
    const configuredOrigin = process.env.PUBLIC_APP_ORIGIN || '';
    let expectedOrigin;
    try { expectedOrigin = configuredOrigin ? new URL(configuredOrigin).origin : serverUrl.origin; }
    catch { throw deepSeekError('服务公开地址配置无效。', 503, 'DEEPSEEK_ORIGIN_CONFIGURATION'); }
    if (origin !== expectedOrigin) throw deepSeekError('此接口仅允许当前站点发起请求。', 403, 'DEEPSEEK_ORIGIN_REJECTED');
  }
  const remoteAddress = String(request.socket?.remoteAddress || '').toLowerCase();
  const loopbackAddress = /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(remoteAddress) || remoteAddress === '::1';
  const loopbackHost = serverUrl.hostname === 'localhost' || serverUrl.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(serverUrl.hostname);
  const forwarded = Object.keys(request.headers || {}).some((name) => name.toLowerCase() === 'forwarded' || name.toLowerCase().startsWith('x-forwarded-'));
  return { allowLocalConfig: !hostedMode() && loopbackAddress && loopbackHost && !forwarded };
}

const categoryOrder = ['核心相关词', '产品/品类词', '品牌/系列词', '需求/场景词'];
const categoryAliases = new Map([
  ['核心相关词', '核心相关词'],
  ['同义/相关主题', '核心相关词'],
  ['产品/品类词', '产品/品类词'],
  ['产品品类词', '产品/品类词'],
  ['品牌/系列词', '品牌/系列词'],
  ['品牌词', '品牌/系列词'],
  ['需求/场景词', '需求/场景词'],
  ['功能卖点词', '需求/场景词'],
  ['人群场景词', '需求/场景词']
]);

function normalizeEnvValue(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1).trim();
  return text;
}

export function parseDeepSeekEnv(text = '') {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]] = normalizeEnvValue(match[2]);
  }
  return values;
}

function usableApiKey(value) {
  const key = String(value || '').trim();
  return key.length >= 20 && !/(?:your|example|replace|placeholder|xxxx)/i.test(key);
}

function normalizeApiUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return fallbackApiUrl;
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function configFromValues(values, persistence, modifiedAt = 0) {
  if (!usableApiKey(values?.DEEPSEEK_API_KEY)) return null;
  return {
    apiKey: String(values.DEEPSEEK_API_KEY).trim(),
    model: String(values.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || fallbackModel).trim(),
    apiUrl: normalizeApiUrl(values.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL),
    persistence,
    modifiedAt
  };
}

function listEnvFiles(rootDir, maxDepth = 2) {
  const found = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (['node_modules', '.git', 'data', 'dist', 'build'].includes(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath, depth + 1);
      else if (entry.isFile() && ['.env.local', '.env'].includes(entry.name)) found.push(entryPath);
    }
  };
  visit(rootDir, 0);
  return found;
}

export function discoverDeepSeekConfigs(rootDir) {
  if (hostedMode()) return [];
  const explicitFile = !rootDir && process.env.DEEPSEEK_ENV_FILE ? path.resolve(process.env.DEEPSEEK_ENV_FILE) : null;
  const candidates = explicitFile ? [explicitFile] : [
    ...(!rootDir ? [path.join(projectDir, '.env.local'), path.join(projectDir, '.env')] : []),
    ...listEnvFiles(rootDir || localWorkspaceRoot, 2)
  ];
  const seenFiles = new Set();
  const configs = [];
  for (const filePath of candidates) {
    const normalizedPath = path.resolve(filePath).toLowerCase();
    if (seenFiles.has(normalizedPath)) continue;
    seenFiles.add(normalizedPath);
    try {
      const stat = fs.statSync(filePath);
      const values = parseDeepSeekEnv(fs.readFileSync(filePath, 'utf8'));
      const config = configFromValues(values, 'local_env', stat.mtimeMs);
      if (config) configs.push(config);
    } catch {}
  }
  const uniqueKeys = new Set();
  return configs
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .filter((config) => {
      if (uniqueKeys.has(config.apiKey)) return false;
      uniqueKeys.add(config.apiKey);
      return true;
    });
}

function getAvailableConfigs({ allowLocalConfig = false } = {}) {
  if (!allowLocalConfig || hostedMode()) return [];
  const configs = [];
  const environmentConfig = configFromValues(process.env, 'environment', Number.MAX_SAFE_INTEGER - 1);
  if (environmentConfig) configs.push(environmentConfig);
  localConfigCache ||= discoverDeepSeekConfigs();
  configs.push(...localConfigCache);
  const uniqueKeys = new Set();
  return configs.filter((config) => {
    if (uniqueKeys.has(config.apiKey)) return false;
    uniqueKeys.add(config.apiKey);
    return true;
  });
}

function cleanKeyword(value) {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/^[#\-•\d.、\s]+|[，,；;。.!！?？\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function normalizeSuggestionPayload(payload, seedKeyword = '', existingKeywords = []) {
  const excluded = new Set([seedKeyword, ...existingKeywords].map((item) => cleanKeyword(item).toLowerCase()).filter(Boolean));
  const seen = new Set(excluded);
  const sourceCategories = Array.isArray(payload?.categories) ? payload.categories : [];
  const byLabel = new Map();
  for (const category of sourceCategories) {
    const label = categoryAliases.get(String(category?.label || '').trim()) || null;
    if (!label) continue;
    const bucket = byLabel.get(label) || [];
    for (const raw of Array.isArray(category.keywords) ? category.keywords : []) {
      const keyword = cleanKeyword(raw);
      const key = keyword.toLowerCase();
      if (!keyword || keyword.length < 2 || seen.has(key)) continue;
      seen.add(key);
      bucket.push(keyword);
      if ([...byLabel.values()].reduce((sum, items) => sum + items.length, 0) + bucket.length >= 20) break;
    }
    if (bucket.length) byLabel.set(label, bucket);
  }
  let remaining = 20;
  const categories = [];
  for (const label of categoryOrder) {
    const keywords = (byLabel.get(label) || []).slice(0, remaining);
    if (!keywords.length) continue;
    categories.push({ label, keywords });
    remaining -= keywords.length;
    if (remaining <= 0) break;
  }
  return { seedKeyword: cleanKeyword(seedKeyword), categories, count: 20 - remaining };
}

function requestConfig(credentials) {
  const apiKey = String(credentials?.apiKey || '').trim();
  if (!usableApiKey(apiKey) || /\s/.test(apiKey) || apiKey.length > 512) throw deepSeekError('DeepSeek API Key 格式不正确。', 400, 'DEEPSEEK_INVALID_KEY');
  return { apiKey, model: allowedModel(credentials?.model, true), apiUrl: fallbackApiUrl, persistence: 'request' };
}

async function callDeepSeek(url, options) {
  try { return await fetch(url, { ...options, redirect: 'error' }); }
  catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw deepSeekError('DeepSeek 请求超时，请稍后重试。', 504, 'DEEPSEEK_TIMEOUT');
    throw deepSeekError('暂时无法连接 DeepSeek，请稍后重试。', 502, 'DEEPSEEK_UNAVAILABLE');
  }
}

function responseError(status) {
  if (status === 401 || status === 403) return deepSeekError('DeepSeek API Key 验证失败，请检查个人密钥。', 401, 'DEEPSEEK_UNAUTHORIZED');
  if (status === 402) return deepSeekError('DeepSeek 账户余额不足，请检查账户余额。', 402, 'DEEPSEEK_BALANCE_REQUIRED');
  if (status === 429) return deepSeekError('DeepSeek 请求过于频繁，请稍后重试。', 429, 'DEEPSEEK_RATE_LIMITED');
  return deepSeekError('DeepSeek 暂时无法完成请求，请稍后重试。', 502, 'DEEPSEEK_UPSTREAM_ERROR');
}

export async function configureDeepSeek(apiKey, model, options = {}) {
  const config = requestConfig({ apiKey, model });
  const response = await callDeepSeek(modelsApiUrl, { method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw responseError(response.status);
  const payload = await response.json().catch(() => ({}));
  const available = new Set((Array.isArray(payload.data) ? payload.data : []).map((item) => item?.id));
  const models = supportedModels.filter((item) => available.has(item));
  if (!models.includes(config.model)) throw deepSeekError('此密钥暂不可使用所选模型，请选择其他 DeepSeek 模型。', 400, 'DEEPSEEK_MODEL_UNAVAILABLE');
  return { configured: true, model: config.model, models, persistence: 'request', automatic: false, allowLocalConfig: options.allowLocalConfig === true && !hostedMode() };
}

export function getDeepSeekStatus(options = {}) {
  const allowLocalConfig = options.allowLocalConfig === true && !hostedMode();
  const config = getAvailableConfigs({ allowLocalConfig })[0] || null;
  return {
    configured: Boolean(config),
    model: config?.model || fallbackModel,
    models: [...supportedModels],
    persistence: config?.persistence || 'none',
    automatic: Boolean(config),
    allowLocalConfig
  };
}

function parseJsonContent(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('DeepSeek 没有返回可解析的关键词结构。');
    return JSON.parse(match[0]);
  }
}

export async function suggestKeywords(seedKeyword, existingKeywords = [], options = {}) {
  const keyword = cleanKeyword(seedKeyword);
  if (!keyword) throw Object.assign(new Error('请先输入一个关键词。'), { status: 400 });
  const personal = options.credentials !== undefined;
  const configs = personal ? [requestConfig(options.credentials)] : getAvailableConfigs(options);
  if (!configs.length) {
    if (options.allowLocalConfig !== true || hostedMode()) throw deepSeekError('请先连接你自己的 DeepSeek API Key。', 403, 'DEEPSEEK_PERSONAL_KEY_REQUIRED');
    throw deepSeekError('未在本机环境或本地项目配置中找到 DeepSeek API Key。', 503, 'DEEPSEEK_NOT_CONFIGURED');
  }
  const existing = [...new Set(existingKeywords.map(cleanKeyword).filter(Boolean))].slice(0, 40);
  for (const config of configs) {
    const model = config.model || fallbackModel;
    const response = await callDeepSeek(config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        temperature: 0.35,
        max_tokens: 1200,
        messages: [
          {
            role: 'system',
            content: '你是中国主流短视频平台的搜索情报研究员。用户的种子词可能属于任意行业、产品、品牌、服务或内容主题，不得默认限制为母婴行业。只输出JSON。围绕种子词生成可直接原样用于平台搜索的扩展关键词，总数不超过20个，分为核心相关词、产品/品类词、品牌/系列词、需求/场景词四类。优先真实常用搜索表达，避免空泛营销词、长句、重复词。不要擅自给关键词追加AI或AIGC，除非种子词本身包含该意图。输出格式：{"categories":[{"label":"核心相关词","keywords":[]},{"label":"产品/品类词","keywords":[]},{"label":"品牌/系列词","keywords":[]},{"label":"需求/场景词","keywords":[]}]} '
          },
          {
            role: 'user',
            content: `种子词：${keyword}\n已经加入搜索队列、请勿重复：${existing.join('、') || '无'}\n请按种子词所属的实际行业或主题给出高召回、可直接搜索的相关关键词，不要改变行业范围。`
          }
        ]
      }),
      signal: AbortSignal.timeout(45_000)
    });
    if (response.status === 401 || response.status === 403) {
      if (personal) throw responseError(response.status);
      continue;
    }
    if (!response.ok) throw responseError(response.status);
    const payload = await response.json().catch(() => ({}));
    const content = payload?.choices?.[0]?.message?.content;
    let normalized;
    try { normalized = normalizeSuggestionPayload(parseJsonContent(content), keyword, existing); }
    catch { throw deepSeekError('DeepSeek 没有返回可解析的关键词结构，请重试。', 502, 'DEEPSEEK_INVALID_RESPONSE'); }
    if (!normalized.count) throw deepSeekError('DeepSeek 本次没有返回可用的新关键词。', 502, 'DEEPSEEK_EMPTY_RESPONSE');
    return { ...normalized, source: 'deepseek', model };
  }
  throw deepSeekError('本机可用的 DeepSeek API Key 均无法通过验证。', 401, 'DEEPSEEK_LOCAL_KEYS_INVALID');
}
