import { configureDeepSeek, getDeepSeekStatus, suggestKeywords } from '../../server/deepseek-keywords.mjs';

export const config = { maxDuration: 60 };
const MAX_BODY = 16 * 1024;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) throw fail('请求内容过大。', 413, 'REQUEST_TOO_LARGE');
  let body = req.body;
  if (body === undefined) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY) throw fail('请求内容过大。', 413, 'REQUEST_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  try {
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BODY) throw fail('请求内容过大。', 413, 'REQUEST_TOO_LARGE');
      body = JSON.parse(body);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) throw fail('请求内容过大。', 413, 'REQUEST_TOO_LARGE');
    return body;
  } catch (error) {
    if (error.code === 'REQUEST_TOO_LARGE') throw error;
    throw fail('请求格式无效，请重新提交。', 400, 'INVALID_JSON');
  }
}

export function createHandler(dependencies = { configureDeepSeek, getDeepSeekStatus, suggestKeywords }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
    try {
      const action = new URL(req.url, 'https://internal.invalid').pathname.split('/').at(-1);
      if (!['status', 'configure', 'keyword-suggestions'].includes(action)) return reply(404, { message: '接口不存在。' });
      const expectedMethod = action === 'status' ? 'GET' : 'POST';
      if (req.method !== expectedMethod) {
        res.setHeader('Allow', expectedMethod);
        return reply(405, { message: '不支持此请求方式。' });
      }
      const host = String(req.headers.host || '');
      let origin;
      try {
        const parsed = new URL(`https://${host}`);
        if (!host || parsed.host !== host || parsed.username || parsed.password) throw new Error();
        origin = parsed.origin;
      } catch { throw fail('请求地址无效。', 400, 'INVALID_HOST'); }
      if (req.headers.origin && req.headers.origin !== origin) throw fail('仅允许当前网站访问。', 403, 'ORIGIN_REJECTED');
      // Never enable owner environment-key discovery, including tests and local emulation.
      const options = { allowLocalConfig: false };
      if (action === 'status') return reply(200, dependencies.getDeepSeekStatus(options));
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw fail('只接受 JSON 请求。', 415, 'JSON_REQUIRED');
      }
      const body = await readBody(req);
      if (action === 'configure') return reply(200, await dependencies.configureDeepSeek(body.apiKey, body.model, options));
      if (typeof body.keyword !== 'string' || !body.keyword.trim() || body.keyword.length > 120 ||
          !Array.isArray(body.existingKeywords || []) || (body.existingKeywords || []).length > 40 ||
          (body.existingKeywords || []).some((item) => typeof item !== 'string' || item.length > 120)) {
        throw fail('关键词格式无效；队列最多 40 个词。', 400, 'INVALID_KEYWORDS');
      }
      if (!body.credentials || typeof body.credentials !== 'object') {
        throw fail('请先输入你自己的 DeepSeek API Key。', 403, 'DEEPSEEK_PERSONAL_KEY_REQUIRED');
      }
      return reply(200, await dependencies.suggestKeywords(body.keyword, body.existingKeywords || [], { ...options, credentials: body.credentials }));
    } catch (error) {
      // Never log request bodies or return arbitrary provider/JSON-parser exceptions.
      const safe = /^(DEEPSEEK_|REQUEST_TOO_LARGE$|INVALID_JSON$|INVALID_HOST$|ORIGIN_REJECTED$|JSON_REQUIRED$|INVALID_KEYWORDS$)/.test(error?.code || '');
      reply(safe ? error.status || 500 : 500, { message: safe ? error.message : '服务暂时无法处理请求，请稍后重试。', code: safe ? error.code : 'SERVICE_ERROR' });
    }
  };
}

export default createHandler();
