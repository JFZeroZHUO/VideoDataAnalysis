import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionRequest } from '../src/extension-client.js';

function fakeWindow() {
  const listeners = new Set();
  return { location: { origin: 'https://ours.example' }, sent: [], listeners,
    addEventListener(name, listener) { listeners.add(listener); }, removeEventListener(name, listener) { listeners.delete(listener); },
    postMessage(data, origin) { this.sent.push({ data, origin }); },
    emit(data, overrides = {}) { for (const listener of listeners) listener({ data, source: this, origin: this.location.origin, ...overrides }); }
  };
}
test('online bridge matches only exact window, origin and request ID, and sends parsed body', async () => {
  const target = fakeWindow();
  const request = extensionRequest('/api/collect/douyin', { method: 'POST', body: JSON.stringify({ keywords: ['舞蹈'], requireAiEvidence: false }) }, target);
  const message = target.sent[0].data;
  assert.deepEqual(message.body, { keywords: ['舞蹈'], requireAiEvidence: false });
  assert.equal(target.sent[0].origin, target.location.origin);
  const reply = { ...message, direction: 'response', ok: true, data: { id: 'new-job' } };
  target.emit(reply, { origin: 'https://attacker.example' });
  target.emit(reply, { source: {} });
  target.emit({ ...reply, id: 'wrong' });
  assert.equal(target.listeners.size, 1);
  target.emit(reply);
  assert.deepEqual(await request, { id: 'new-job' });
  assert.equal(target.listeners.size, 0);
});
test('missing extension fails explicitly, no localhost fallback, error codes propagated', async () => {
  const target = fakeWindow();
  await assert.rejects(extensionRequest('/api/meta', {}, target, 5), { code: 'EXTENSION_NOT_CONNECTED' });
  assert.equal(target.listeners.size, 0);
  const failed = extensionRequest('/api/meta', {}, target);
  target.emit({ ...target.sent.at(-1).data, direction: 'response', ok: false, error: { message: '未授权', code: 'NOT_AUTHORIZED', status: 403 } });
  await assert.rejects(failed, { code: 'NOT_AUTHORIZED', status: 403 });
});
