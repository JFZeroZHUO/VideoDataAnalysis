import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, LoaderCircle } from 'lucide-react';
import { api } from './api.js';

const EMPTY_STATUS = { configured: false, allowLocalConfig: false };

// Personal credentials live only in this page's React state, never browser storage.
export function useDeepSeekConnection() {
  const [localStatus, setLocalStatus] = useState(EMPTY_STATUS);
  const [personal, setPersonal] = useState(null);
  const [source, setSource] = useState('local');
  const [revision, setRevision] = useState(0);
  const version = useRef(0);

  useEffect(() => {
    let mounted = true;
    api.getDeepSeekStatus().then((status) => { if (mounted) setLocalStatus(status); }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  const changeSource = (next) => {
    version.current += 1;
    setRevision(version.current);
    setSource(next);
  };
  const status = source === 'personal' ? personal?.status || EMPTY_STATUS
    : source === 'local' ? localStatus : EMPTY_STATUS;

  return {
    status, source, revision,
    hasPersonalKey: Boolean(personal),
    localAvailable: Boolean(localStatus.configured && localStatus.allowLocalConfig),
    async usePersonalKey(apiKey, model) {
      const normalized = apiKey.trim();
      const attempt = ++version.current;
      setRevision(attempt);
      let verified;
      try { verified = await api.configureDeepSeek(normalized, model); }
      catch (error) { if (attempt !== version.current) return false; throw error; }
      if (attempt !== version.current) return false;
      setPersonal({ credentials: { apiKey: normalized, model: verified.model }, status: verified });
      changeSource('personal');
      return true;
    },
    clearPersonalKey() { setPersonal(null); changeSource('none'); },
    useLocalConfig() { setPersonal(null); changeSource('local'); },
    async suggest(keyword, existingKeywords) {
      if (!status.configured) throw new Error('请先设置可用的 DeepSeek Key。');
      const startedAt = version.current;
      const result = await api.suggestKeywords(keyword, existingKeywords,
        source === 'personal' ? personal.credentials : undefined);
      // Do not display a previous account's response after changing credentials.
      return startedAt === version.current ? result : null;
    }
  };
}

export function DeepSeekSettings({ connection, id }) {
  const [draftKey, setDraftKey] = useState('');
  const [model, setModel] = useState('deepseek-flash');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    if (saving || !draftKey.trim()) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const activated = await connection.usePersonalKey(draftKey, model);
      setDraftKey('');
      setMessage(activated === false ? '设置已发生变化，本次旧验证结果已忽略。' : '已切换到个人 Key；只用于当前页面会话。');
    } catch (failure) {
      setError(failure.message || '验证失败，请检查 Key 后重试。');
    } finally { setSaving(false); }
  };
  return <section id={id} className="deepseek-settings" aria-label="DeepSeek API 设置">
    <div className="deepseek-settings-heading"><KeyRound size={18} /><div>
      <h4>使用自己的 DeepSeek</h4>
      <p>只辅助整理关键词，不影响原词搜索或视频采集。费用由所用 Key 的账户承担。</p>
    </div></div>
    <form onSubmit={submit}>
      <label className="deepseek-key-field"><span>个人 API Key</span>
        <input type="password" name="deepseek-personal-key" value={draftKey} onChange={(event) => setDraftKey(event.target.value)}
          autoComplete="off" spellCheck={false} placeholder={connection.hasPersonalKey ? '输入新 Key 进行更换' : '粘贴你的 DeepSeek API Key'}
          disabled={saving} required aria-describedby={`${id}-privacy`} />
      </label>
      <label className="deepseek-model-field"><span>扩词模型</span>
        <select value={model} onChange={(event) => setModel(event.target.value)} disabled={saving}>
          <option value="deepseek-flash">DeepSeek Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
        </select>
      </label>
      <button type="submit" className="deepseek-verify" disabled={saving || !draftKey.trim()}>
        {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{saving ? '正在验证…' : '验证并使用此 Key'}
      </button>
    </form>
    <p id={`${id}-privacy`} className="deepseek-privacy">Key 经当前服务转发到 DeepSeek 官方接口，不写入数据库或浏览器存储；刷新或关闭页面后清除。验证只查询模型列表，不生成内容。</p>
    <div className="deepseek-settings-footer">
      <span>当前来源：{connection.status.configured ? connection.source === 'personal' ? '个人 Key（当前页面）' : '本机自动配置' : '未启用'}</span>
      {connection.hasPersonalKey && <button type="button" disabled={saving} onClick={() => { connection.clearPersonalKey(); setMessage('个人 Key 已清除，扩词已停用。'); setError(''); setDraftKey(''); }}>清除个人 Key</button>}
      {connection.localAvailable && connection.source !== 'local' && <button type="button" disabled={saving} onClick={() => { connection.useLocalConfig(); setMessage('已清除个人 Key，切回本机自动配置。'); setError(''); setDraftKey(''); }}>切回本机配置</button>}
    </div>
    {error && <p className="deepseek-settings-error" role="alert">{error}</p>}
    {message && <p className="deepseek-settings-success" role="status">{message}</p>}
  </section>;
}
