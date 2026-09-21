const PLATFORM_AI_LABEL_RULES = [
  { pattern: /疑似\s*AI\s*生成/i, label: '疑似AI生成' },
  { pattern: /(?:作者声明[：:]?\s*)?内容由\s*AI\s*生成/i, label: '内容由AI生成' },
  { pattern: /本内容(?:由|使用)\s*AI\s*生成/i, label: '内容由AI生成' }
];

export function detectPlatformAiLabel(text = '') {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const matched = PLATFORM_AI_LABEL_RULES.find((rule) => rule.pattern.test(normalized));
  return matched?.label || null;
}

export function hasPlatformAiBadge(candidate = {}) {
  return candidate.platformAiBadge === true || Boolean(candidate.platformAiLabel);
}
