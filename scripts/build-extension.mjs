import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) !== -1) throw new Error(`抖音共享函数结构已变化：${start}`);
  return source.slice(from, to);
}

// Reuse proven DOM readers/resolver without importing the Node/Playwright runtime.
// The legacy extension and local collector remain unchanged.
export async function sharedDouyinSource() {
  const collector = await readFile(join(root, 'server/collectors/douyin.mjs'), 'utf8');
  const helper = await readFile(join(root, 'browser-helper/background.js'), 'utf8');
  const functions = section(collector, 'function createCollectionDiagnostics()', 'export async function collectDouyin(options)');
  const extraction = section(collector, 'const extraction = await page.evaluate((markerPrefix) => {', '}, `collector-${Date.now()}-${index}`);')
    .replace('const extraction = await page.evaluate(', 'export const extractSearchCards = ');
  const detail = section(helper, 'function extractDouyinDetail(candidate)', 'function extractXiaohongshuDetail(candidate)');
  return `import { extractLabeledMetric, parseCompactNumber } from './number-utils.mjs';\nimport { detectPlatformAiLabel } from './ai-badge.mjs';\nimport { DOUYIN_SEARCH_RESULT_SELECTOR, sourceUrlFromDouyinModalUrl } from './douyin-card-schema.mjs';\nconst resultSelector = DOUYIN_SEARCH_RESULT_SELECTOR;\n${functions}\n${extraction}};\n${detail}\nexport { createCollectionDiagnostics, normalizeDouyinRows, extractDouyinDetail };`;
}

export function sharedDouyinPlugin() {
  return { name: 'douyin-dom-core', setup(builder) {
    builder.onResolve({ filter: /^douyin-dom-core$/ }, () => ({ path: 'douyin-dom-core', namespace: 'shared-dom' }));
    builder.onLoad({ filter: /.*/, namespace: 'shared-dom' }, async () => ({ contents: await sharedDouyinSource(), loader: 'js', resolveDir: join(root, 'server') }));
  } };
}

export async function buildExtension({ outputDirectory = join(root, 'build/local-extension'), zipPath = join(root, 'public/downloads/douyin-helper.zip') } = {}) {
  await mkdir(outputDirectory, { recursive: true });
  await build({ entryPoints: [join(root, 'local-extension/background.js')], outfile: join(outputDirectory, 'background.js'), bundle: true,
    platform: 'browser', format: 'esm', target: ['chrome120'], plugins: [sharedDouyinPlugin()], legalComments: 'none' });
  const files = ['manifest.json', 'bridge.js', 'popup.html', 'popup.js', 'popup.css'];
  for (const file of files) await copyFile(join(root, 'local-extension', file), join(outputDirectory, file));
  const { zipSync } = await import('fflate');
  const archive = {};
  for (const file of ['background.js', ...files]) archive[file] = new Uint8Array(await readFile(join(outputDirectory, file)));
  await mkdir(dirname(zipPath), { recursive: true });
  await writeFile(zipPath, zipSync(archive, { level: 6 }));
  return { outputDirectory, zipPath, files: Object.keys(archive) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildExtension();
  console.log(`抖音本机助手 3.0.2 已打包：${result.zipPath}`);
}
