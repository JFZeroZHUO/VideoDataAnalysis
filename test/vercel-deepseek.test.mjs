import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/deepseek/[action].mjs';

async function call(handler, action, { body, method = action === 'status' ? 'GET' : 'POST', headers = {} } = {}) {
  const request = { url: `/api/deepseek/${action}`, method, body,
    headers: { host: 'app.example', origin: 'https://app.example', 'content-type': 'application/json', ...headers } };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = JSON.parse(value); } };
  await handler(request, response);
  return response;
}

test('Vercel status and suggestions never use the owner local/environment key', async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-private-owner-never-shared-1234567890';
  try {
    const status = await call(createHandler(), 'status');
    assert.equal(status.body.configured, false);
    assert.equal(status.body.allowLocalConfig, false);
    assert.equal(status.headers['Cache-Control'], 'no-store');
    const suggestion = await call(createHandler(), 'keyword-suggestions', { body: { keyword: '舞蹈' } });
    assert.equal(suggestion.statusCode, 403);
    assert.equal(JSON.stringify(suggestion).includes(process.env.DEEPSEEK_API_KEY), false);
  } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});

test('request credentials stay request-scoped and origin/content-type/body guards run first', async () => {
  const calls = [];
  const handler = createHandler({
    configureDeepSeek: async (key, model, options) => { calls.push({ key, options }); return { configured: true, model }; },
    suggestKeywords: async (keyword, existing, options) => { calls.push({ keyword, options }); return { categories: [] }; }
  });
  for (const apiKey of ['key-a', 'key-b']) await call(handler, 'configure', { body: { apiKey, model: 'deepseek-flash' } });
  assert.deepEqual(calls.map((item) => item.key), ['key-a', 'key-b']);
  assert.ok(calls.every((item) => item.options.allowLocalConfig === false));
  assert.equal((await call(handler, 'configure', { body: {}, headers: { origin: 'https://bad.example' } })).statusCode, 403);
  assert.equal((await call(handler, 'configure', { body: {}, headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal((await call(handler, 'configure', { body: 'malformed secret key raw text' })).statusCode, 400);
  assert.equal((await call(handler, 'configure', { body: { apiKey: 'a'.repeat(17 * 1024) } })).statusCode, 413);
  assert.equal((await call(handler, 'keyword-suggestions', { body: { keyword: 'x', existingKeywords: {}, credentials: {} } })).statusCode, 400);
  assert.equal(calls.length, 2);
});

test('unexpected provider exceptions and malformed JSON never echo secrets', async () => {
  const handler = createHandler({ configureDeepSeek: async () => { throw new Error('secret-input-123'); } });
  const failure = await call(handler, 'configure', { body: { apiKey: 'secret-input-123' } });
  assert.equal(failure.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(failure), /secret-input/);
  assert.equal((await call(handler, 'configure', { method: 'GET' })).statusCode, 405);
  assert.equal((await call(handler, 'no-such-action')).statusCode, 404);
});
