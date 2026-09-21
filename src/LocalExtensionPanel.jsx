import { useEffect, useRef, useState } from 'react';
import { Download, HardDrive, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';
import { api } from './api.js';
import { saveDownload } from './extension-client.js';

export function LocalExtensionPanel({ connected, version, onRefresh, onRestored, notify }) {
  const installedVersion = /^\d+\.\d+\.\d+$/.test(version || '') ? version.split('.').map(Number) : null;
  const needsUpdate = connected && installedVersion && (installedVersion[0] < 3 ||
    (installedVersion[0] === 3 && installedVersion[1] === 0 && installedVersion[2] < 1));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const fileInput = useRef(null);
  const videoInput = useRef(null);
  const videoDialog = useRef(null);
  useEffect(() => {
    if (!preview) return;
    videoDialog.current?.showModal();
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);
  const backup = async () => {
    setBusy(true);
    try { saveDownload(JSON.stringify(await api.localBackup()), `短视频素材备份-${new Date().toISOString().slice(0, 10)}.json`); }
    catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const restore = async (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { notify('备份文件不能超过 50 MB。', 'error'); return; }
    setBusy(true);
    try {
      await api.localRestore(JSON.parse(await file.text()));
      notify('备份已校验并合并；已有素材不会被整库清空。');
      await onRestored();
    } catch (error) { notify(error instanceof SyntaxError ? '这不是有效的 JSON 备份。' : error.message, 'error'); }
    finally { setBusy(false); }
  };
  return <section className="local-extension-panel" aria-label="本机助手与数据">
    <div className="local-extension-status"><HardDrive size={18} /><div><strong>{connected ? '本机素材库已连接' : '先连接抖音本机助手'}</strong>
      <p>{connected ? '素材和任务保存在此浏览器，不上传云数据库。' : '网页需要扩展才能操作你的抖音标签页；无需安装本地服务器。'}</p></div>
      <button type="button" onClick={onRefresh}><RefreshCw size={14} />检测连接</button></div>
    {needsUpdate && <p className="local-extension-upgrade" role="status"><strong>当前助手 {version} 需要更新</strong>：旧版会跳过没有直接链接的抖音卡片。
      <a href="/downloads/douyin-helper.zip?v=3.0.1" download>下载 3.0.1 修复版</a>，覆盖原扩展文件夹后，在扩展管理页点击“重新加载”，再刷新本站。请勿卸载，以免丢失本机素材。</p>}
    <details open={!connected || needsUpdate ? true : undefined}><summary>一次安装 · 数据管理 · 使用边界</summary>
      <ol><li><a href="/downloads/douyin-helper.zip?v=3.0.1" download>下载抖音本机助手 3.0.1</a>，先解压到固定文件夹。当前为手动安装版，尚未上架扩展商店。</li>
        <li>在桌面 Chrome / Edge 的扩展管理中开启“开发者模式”，点击“加载已解压的扩展”，选择解压后的文件夹。</li>
        <li>回到本站，点击浏览器工具栏的助手图标，选择“授权当前网站”，同意后刷新本页。</li>
        <li>输入关键词再采集；需要登录或验证码时，在抖音页面手动完成。采集期间请保持浏览器和任务标签页打开。</li></ol>
      <p className="local-privacy-note"><ShieldCheck size={14} />仅支持抖音可公开访问的搜索内容，不能保证穷尽全网或绕过平台限制。未知指标保持“—”。清除扩展数据、卸载扩展或更换电脑前，请先导出备份。</p>
      <p className="local-privacy-note">普通模式不核验 AI 声明。若搜索卡片未提供直接链接，助手会打开该卡片取得真实视频地址，再返回原搜索页继续；不会把别的视频链接填进来。</p>
      <div className="local-data-actions"><button type="button" disabled={!connected || busy} onClick={backup}><Download size={14} />导出本机备份</button>
        <button type="button" disabled={!connected || busy} onClick={() => fileInput.current?.click()}><Upload size={14} />合并备份</button>
        <button type="button" onClick={() => videoInput.current?.click()}>预览本地视频</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={restore} />
        <input ref={videoInput} type="file" accept="video/*" hidden onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) setPreview({ title: file.name, url: URL.createObjectURL(file) });
        }} /></div>
      <p className="local-privacy-note">视频文件由你自行合法保存后选择预览，不上传；本在线版本不自动下载视频。不同电脑与不同浏览器不会自动同步素材。</p>
    </details>
    <dialog ref={videoDialog} className="local-media-dialog" onCancel={() => setPreview(null)} onClose={() => setPreview(null)}>
      <header><strong>{preview?.title}</strong><button type="button" aria-label="关闭本地视频" onClick={() => { videoDialog.current?.close(); setPreview(null); }}><X size={18} /></button></header>
      {preview && <video controls src={preview.url} />}<p>文件只在当前页面播放，不会上传。</p>
    </dialog>
  </section>;
}

export function CollectionAttention({ job, notify }) {
  const dialog = useRef(null);
  const [dismissed, setDismissed] = useState('');
  const waiting = /waiting_(login|verification)|waiting_user/.test(`${job?.phase || ''} ${job?.status || ''}`);
  const marker = waiting ? `${job.id}:${job.phase || job.status}` : '';
  useEffect(() => {
    if (marker && marker !== dismissed) dialog.current?.showModal();
    else dialog.current?.close();
  }, [marker, dismissed]);
  if (!waiting) return null;
  return <><div className="local-attention-bar"><span>采集已暂停，等待你在抖音完成登录或安全验证。</span><button type="button" onClick={() => setDismissed('')}>查看提醒</button></div>
    <dialog ref={dialog} className="local-attention-dialog" onCancel={() => setDismissed(marker)}>
      <h2>请在抖音页面完成验证</h2><p>{job.message || '平台需要你登录或完成安全验证。助手不会代填账号、密码或验证码。'}</p>
      <p>完成后回到本页查看任务状态；若等待超时，可以重新开始采集，已保存的数据会保留。</p>
      <div><button type="button" onClick={() => api.openDouyin().catch((error) => notify(error.message, 'error'))}>打开抖音任务页</button>
        <button type="button" onClick={() => setDismissed(marker)}>稍后处理</button></div>
    </dialog></>;
}
