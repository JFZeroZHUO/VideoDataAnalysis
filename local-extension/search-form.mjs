// Self-contained DOM interaction for chrome.scripting.executeScript. Submit via
// Douyin's visible search UI so its own router supplies the destination/parameters.
export function interactDouyinSearch({ action = 'inspect', keyword = '' } = {}) {
  const visible = (element) => {
    const box = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const inputs = [...document.querySelectorAll('input')].filter((input) => {
    if (input.disabled || input.readOnly || !visible(input) || /password|tel|email|hidden/.test(input.type)) return false;
    return input.getAttribute('data-e2e') === 'searchbar-input' || input.type === 'search' || input.getAttribute('role') === 'searchbox' ||
      /搜索/.test(`${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`);
  });
  const input = inputs.length === 1 ? inputs[0] : null;
  if (!input) return { ready: false, reason: inputs.length ? '搜索框不唯一，未代填其它输入框。' : '未找到可见的抖音搜索框。' };
  if (action === 'inspect') return { ready: true, value: input.value };
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 120) return { ready: false, reason: '搜索词格式无效。' };
  if (action === 'fill') {
    input.focus();
    // Native setter + input event works with React controlled inputs. Submission
    // happens in a separate injection after React has committed the entered word.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, keyword);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ready: true, value: input.value };
  }
  if (action !== 'submit' || input.value !== keyword) return { ready: false, reason: '搜索框中的内容与队列原词不同，未提交。' };
  const namedSearch = (element) => visible(element) && !element.disabled && !element.contains(input) &&
    (element.getAttribute('data-e2e') === 'searchbar-button' ||
      /^(?:搜索|立即搜索)$/.test((element.getAttribute('aria-label') || element.innerText || element.value || '').trim()));
  for (let container = input.parentElement, level = 0; container && container !== document.body && level < 6; container = container.parentElement, level += 1) {
    const buttons = [...container.querySelectorAll('[data-e2e="searchbar-button"], button, [role="button"], input[type="submit"], span, div')].filter(namedSearch);
    // Avoid clicking a decorative child and its button parent as separate matches.
    const outer = buttons.filter((button) => !buttons.some((other) => other !== button && other.contains(button)));
    if (outer.length > 1) return { ready: false, reason: '搜索按钮不唯一，未点击其它入口。' };
    if (outer.length === 1) { outer[0].click(); return { ready: true, submitted: true, method: 'button' }; }
  }
  const form = input.closest('form');
  if (form) { form.requestSubmit(); return { ready: true, submitted: true, method: 'form' }; }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return { ready: true, submitted: true, method: 'enter' };
}
