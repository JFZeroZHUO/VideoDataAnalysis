const VERIFICATION_PATTERNS = [
  /请选择所有符合上文描述的图片/i,
  /并拖拽到下方/i,
  /拖拽到这里/i,
  /滑动(?:滑块)?完成验证/i,
  /点击按钮进行验证/i,
  /图形验证码/i,
  /安全验证/i,
  /完成验证/i,
  /访问过于频繁/i,
  /IP\s*存在风险/i
];

const LOGIN_PATTERNS = [
  /登录后即可/i,
  /扫码登录/i,
  /请先登录/i,
  /登录后查看/i
];

export function detectPageAttentionText(text = '', hasVisibleCaptcha = false) {
  const normalized = String(text).replace(/\s+/g, ' ').slice(0, 20000);
  if (hasVisibleCaptcha || VERIFICATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { requiresAttention: true, kind: 'verification', label: '安全验证' };
  }
  if (LOGIN_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { requiresAttention: true, kind: 'login', label: '账号登录' };
  }
  return { requiresAttention: false, kind: null, label: null };
}
