export function parseCompactNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replace(/[,，\s]/g, '').trim();
  const match = normalized.match(/(-?\d+(?:\.\d+)?)(万|w|W|亿|k|K)?/);
  if (!match) return null;
  let number = Number(match[1]);
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') number *= 10000;
  if (unit === '亿') number *= 100000000;
  if (unit === 'k' || unit === 'K') number *= 1000;
  return Number.isFinite(number) ? Math.round(number) : null;
}

export function extractLabeledMetric(text, labels) {
  const source = String(text || '');
  for (const label of labels) {
    const before = new RegExp(`(\\d+(?:\\.\\d+)?(?:万|亿|w|W|k|K)?)\\s*${label}`, 'i').exec(source);
    if (before) return parseCompactNumber(before[1]);
    const after = new RegExp(`${label}\\s*[：:]?\\s*(\\d+(?:\\.\\d+)?(?:万|亿|w|W|k|K)?)`, 'i').exec(source);
    if (after) return parseCompactNumber(after[1]);
  }
  return null;
}
