const $ = (id) => document.getElementById(id);
let currentTab = null;
let currentOrigin = null;
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error?.message || '本机助手暂时不可用，请重新加载扩展。');
  return response.data;
}
function originFor(value) {
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === 'https:' || url.origin === 'http://127.0.0.1:4318') ? url.origin : null; }
  catch { return null; }
}
function patternFor(origin) { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }
async function refresh() {
  const state = await request({ action: 'status' });
  $('origins').replaceChildren();
  for (const origin of state.origins) {
    const item = document.createElement('li'); const label = document.createElement('span'); label.textContent = origin;
    const revoke = document.createElement('button'); revoke.textContent = '撤销'; revoke.setAttribute('aria-label', `撤销 ${origin} 授权`);
    revoke.addEventListener('click', async () => { try { await request({ action: 'revoke', origin }); await refresh(); status('已撤销，该网站无法再读取本机素材。'); } catch (error) { status(error.message, true); } });
    item.append(label, revoke); $('origins').append(item);
  }
  if (!state.origins.length) { const item = document.createElement('li'); item.textContent = '尚未授权网站'; $('origins').append(item); }
  const approved = state.origins.includes(currentOrigin);
  $('authorize').disabled = !currentOrigin || approved;
  $('authorize').textContent = approved ? '当前网站已授权' : '授权当前网站';
  $('attention').textContent = state.attention?.job?.message || '采集使用当前 Chrome 的抖音登录状态。';
}
$('authorize').addEventListener('click', async () => {
  if (!currentOrigin || !currentTab?.id) return;
  try {
    // permissions.request must be the first asynchronous action of the user's click.
    const granted = await chrome.permissions.request({ origins: [patternFor(currentOrigin)] });
    if (!granted) { status('未授权，网站尚不能访问本机素材。'); return; }
    await request({ action: 'authorize', tabId: currentTab.id, origin: currentOrigin });
    await refresh(); status('连接成功。回到情报台点击“检测连接”或刷新网页即可。');
  } catch (error) { status(error.message, true); }
});
$('open-douyin').addEventListener('click', async () => { try { await request({ action: 'open-douyin' }); } catch (error) { status(error.message, true); } });
try {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentOrigin = originFor(currentTab?.url);
  $('current-origin').textContent = currentOrigin || '请先切换到 HTTPS 情报台网页，再打开此弹窗。';
  await refresh();
} catch (error) { status(error.message, true); }
