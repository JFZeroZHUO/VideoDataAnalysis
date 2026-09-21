import { classifyAi, classifyProduct } from '../server/classify.mjs';
import { db, getKeywordGroups, recomputeSystemHeat } from '../server/db.mjs';
import { parseCompactNumber } from '../server/number-utils.mjs';

const keywordGroups = getKeywordGroups();
const rows = db.prepare("SELECT id, platform, title, raw_metrics_json FROM videos WHERE platform = 'douyin'").all();
const update = db.prepare(`
  UPDATE videos SET
    title = ?, author_name = COALESCE(?, author_name), published_at = COALESCE(?, published_at),
    like_count = COALESCE(?, like_count), product_group = ?, ai_type = ?, ai_confidence = ?, ai_evidence = ?
  WHERE id = ?
`);

const durationPattern = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const compactNumberPattern = /^\d+(?:\.\d+)?(?:万|亿|w|W)?$/;
const publishedPattern = /^(?:刚刚|\d+(?:秒|分钟|小时|天|周|月|年)前|\d{4}[-./年]\d{1,2})/;
let repaired = 0;
let visible = 0;

for (const row of rows) {
  const rawMetrics = JSON.parse(row.raw_metrics_json || '{}');
  const rawText = String(rawMetrics.sourceText || '');
  const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
  const inferredTitle = lines.find((line) => line.length > 4 && line !== '合集' && !durationPattern.test(line) &&
    !compactNumberPattern.test(line) && !publishedPattern.test(line) && !line.startsWith('@'));
  const title = durationPattern.test(row.title || '') && inferredTitle ? inferredTitle.slice(0, 500) : row.title;
  const author = lines.find((line) => line.startsWith('@'))?.slice(1) || null;
  const publishedAt = lines.find((line) => publishedPattern.test(line)) || null;
  const durationIndex = lines.findIndex((line) => durationPattern.test(line));
  const likeText = durationIndex >= 0 ? lines.slice(durationIndex + 1).find((line) => compactNumberPattern.test(line)) : null;
  const likeCount = likeText ? parseCompactNumber(likeText) : null;
  const contentText = [title, author, rawText].filter(Boolean).join(' ');
  const product = classifyProduct(contentText, keywordGroups);
  const ai = classifyAi(contentText);
  update.run(
    title || '未命名视频', author, publishedAt, likeCount,
    product.group, ai.type, ai.confidence, `${ai.evidence}；${product.evidence}`,
    row.id
  );
  repaired += 1;
  if (product.group !== '未分类') visible += 1;
}

recomputeSystemHeat('douyin');
console.log(JSON.stringify({ repaired, visible, hiddenAsUnclassified: repaired - visible }));
