import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { DOUYIN_SEARCH_STATE_KEY } from '../src/search-state.js';

// Read-only live API + real React component check. No browser or remote media is opened.
const base = 'http://127.0.0.1:4318';
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = (input, options) => {
  const url = new URL(input, base);
  assert.equal(url.origin, base, 'Verification only accesses the local application API');
  assert.ok(!options?.method || options.method === 'GET', 'Read-only verification');
  requests.push(url);
  return originalFetch(url, options);
};
const values = new Map([[DOUYIN_SEARCH_STATE_KEY, JSON.stringify({ keywords: ['舞蹈'], resultScope: 'current' })]]);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = {
  localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout,
  setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval
};
const built = await build({ entryPoints: [fileURLToPath(new URL('../src/ResearchWorkspace.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const Workspace = loaded.exports.default;
let app;
try {
  const baseline = await (await fetch(`${base}/api/materials?${new URLSearchParams({ platform: 'douyin', aiEvidence: 'all', quality: 'all', queryTerms: '["舞蹈"]', limit: '500' })}`)).json();
  assert.ok(baseline.count > 0, 'Live database must contain dance results');
  for (const round of ['initial', 'refresh']) {
    await act(async () => { app = create(React.createElement(Workspace)); });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
      if (app.root.findAllByType('tbody').length) break;
    }
    assert.equal(app.root.findByProps({ type: 'checkbox' }).props.checked, false);
    const rows = app.root.findByType('tbody').findAllByType('tr');
    assert.equal(rows.length, baseline.materials.length, `${round}: all dance rows must render`);
    const titles = rows.map((row) => row.findAllByType('a')[0].props.children);
    for (const record of baseline.materials) assert.ok(titles.includes(record.title));
    const query = requests.filter((url) => url.pathname === '/api/materials').at(-1).searchParams;
    assert.equal(query.get('aiEvidence'), 'all');
    assert.equal(query.get('quality'), 'all');
    assert.equal(query.get('queryTerms'), '["舞蹈"]');
    console.log(JSON.stringify({ round, renderedDanceRows: rows.length, aiOnly: false, evidenceFilter: 'all', qualityFilter: 'all' }));
    await act(async () => app.unmount());
    app = null;
  }
  console.log('PASS: live dance records render before and after refresh without AI or completeness gating.');
} finally {
  if (app) await act(async () => app.unmount());
  globalThis.fetch = originalFetch;
}
