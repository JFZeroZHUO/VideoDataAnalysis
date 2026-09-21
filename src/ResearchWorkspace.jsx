import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownUp, BarChart3, BadgeCheck, Check, ChevronRight, CircleDot,
  Database, Download, ExternalLink, Gauge, LibraryBig, LoaderCircle, Megaphone,
  KeyRound, Play, Plus, RefreshCw, ScanSearch, Search, ShieldCheck, Sparkles,
  Target, TimerReset, TrendingUp, Trophy, WandSparkles, X
} from 'lucide-react';
import { api } from './api.js';
import { EXTENSION_MODE, saveDownload } from './extension-client.js';
import { CollectionAttention, LocalExtensionPanel } from './LocalExtensionPanel.jsx';
import { DeepSeekSettings, useDeepSeekConnection } from './DeepSeekSettings.jsx';
import { PLATFORM_CONFIG, AI_TYPES, CONTENT_INTENTS } from './platforms.js';
import { defaultMaterialFilters, filtersForAiMode, materialRequestParams, normalizeSearchKeywords,
  normalizeSearchState, readStoredDouyinSearchState, storeDouyinSearchState } from './search-state.js';

const WORKSPACES = [
  { id: 'database', label: '素材数据库', description: '热门与 AI 素材持续沉淀', icon: Database },
  { id: 'rankings', label: '分主题热榜', description: '每个搜索主题独立 Top 20/50', icon: Trophy },
  { id: 'analysis', label: '投流分析', description: '钩子、形式、转化与机会', icon: BarChart3 }
];
const CLOSED_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);

function formatNumber(value) {
  if (value === null || value === undefined) return '—';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 1 : 2).replace(/\.0$/, '')}万`;
  return Number(value).toLocaleString('zh-CN');
}
function formatRatio(value) { return value === null || value === undefined ? '—' : `${Number(value).toFixed(2)}%`; }
function formatDate(value) {
  if (!value) return '尚未采集';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function MetricSort({ field, label, filters, setFilters }) {
  const active = filters.sort === field;
  return <button className={`table-sort ${active ? 'is-active' : ''}`} type="button" onClick={() => setFilters((current) => ({ ...current, sort: field, direction: current.sort === field && current.direction === 'desc' ? 'asc' : 'desc' }))}>{label}<ArrowDownUp size={12} /></button>;
}

function PlatformRail({ platform, meta, onChange }) {
  return <div className="platform-rail" aria-label="平台切换">{Object.entries(PLATFORM_CONFIG).filter(([key]) => !EXTENSION_MODE || key === 'douyin').map(([key, config]) => {
    const job = meta?.latestJobs?.[key];
    return <button key={key} type="button" className={key === platform ? 'is-active' : ''} onClick={() => onChange(key)}><span className="platform-code">{config.short}</span><span className="platform-copy"><strong>{config.name}</strong><small>{config.mode}</small></span><span className="platform-volume">{meta?.materialCounts?.[key] || 0}</span><i className={job?.status || 'idle'} /></button>;
  })}</div>;
}

function JobProgress({ job }) {
  if (!job) return null;
  const channels = job.platform === 'channels';
  const closed = CLOSED_JOB_STATES.has(job.status);
  const diagnostics = job.collectionDiagnostics;
  return <section className="job-strip" aria-live="polite">{closed ? job.status === 'failed' ? <AlertTriangle size={18} /> : <Check size={18} /> : <LoaderCircle size={18} className="spin" />}<div>
    <div className="job-line"><strong>{closed ? '最近任务：' : ''}{job.message || '正在采集'}</strong><span>{job.status === 'failed' ? '采集失败' : job.status === 'cancelled' ? '已取消' : job.status === 'completed' ? '已完成' : `${job.progress || 0}%`}</span></div>
    {!closed && <div className="job-track"><i style={{ width: `${job.progress || 0}%` }} /></div>}
    <div className="job-facts"><span>任务关键词：{job.keywords?.join('、') || '旧任务未记录'}</span><span>{job.requireAiEvidence === false ? '普通热门模式 · 跳过AI核验' : job.requireAiEvidence === true ? '仅AI模式 · 核验声明' : '旧任务模式未记录'}</span></div>
    <div className="job-facts"><span>{channels ? '公域最热详情' : '搜索卡片'} {job.searchCardCount || 0}</span><span>{channels ? '明确AI证据' : '详情AI声明'} {job.requireAiEvidence === false ? '未核验' : job.aiCandidateCount || 0}</span><span>已解析 {job.scannedCount || 0}</span><span>新增 {job.addedCount || 0}</span><span>更新 {job.updatedCount || 0}</span>{diagnostics && <span>链接失败 {diagnostics.linkFailureCount || 0}</span>}</div>
    {!!diagnostics?.failureSamples?.length && <details><summary>查看未采集原因（{diagnostics.linkFailureCount || diagnostics.failureSamples.length}）</summary>{diagnostics.failureSamples.slice(0, 5).map((item, index) => <p key={index}>{item.query} · {item.title || '搜索卡片'}：{item.message || item.reason}</p>)}</details>}
  </div></section>;
}

function FilterField({ label, value, onChange, children }) { return <label className="filter-field"><span>{label}</span><select value={value} onChange={onChange}>{children}</select></label>; }
function MaterialFilters({ filters, setFilters, facets }) {
  return <section className="material-filters"><label className="search-field"><Search size={15} /><input value={filters.search} onChange={(event) => setFilters((old) => ({ ...old, search: event.target.value }))} placeholder="搜标题、主题、产品、品牌或作者" /></label>
    <FilterField label="主题 / 品类" value={filters.productGroup} onChange={(event) => setFilters((old) => ({ ...old, productGroup: event.target.value }))}><option value="all">全部主题</option>{(facets?.products || []).map((item) => <option key={item.value} value={item.value}>{item.value}（{item.count}）</option>)}</FilterField>
    <FilterField label="品牌" value={filters.brand} onChange={(event) => setFilters((old) => ({ ...old, brand: event.target.value }))}><option value="all">全部品牌</option>{(facets?.brands || []).map((item) => <option key={item.value} value={item.value}>{item.value}（{item.count}）</option>)}</FilterField>
    <FilterField label="内容方向" value={filters.contentIntent} onChange={(event) => setFilters((old) => ({ ...old, contentIntent: event.target.value }))}><option value="all">全部方向</option>{CONTENT_INTENTS.map((item) => <option key={item} value={item}>{item}</option>)}</FilterField>
    <FilterField label="AI类型" value={filters.aiType} onChange={(event) => setFilters((old) => ({ ...old, aiType: event.target.value }))}><option value="all">全部AI类型</option>{AI_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</FilterField>
    <FilterField label="AI证据" value={filters.aiEvidence} onChange={(event) => setFilters((old) => ({ ...old, aiEvidence: event.target.value }))}><option value="verified">已有明确证据</option><option value="pending">证据待核验</option><option value="all">全部候选</option></FilterField>
    <FilterField label="数据质量" value={filters.quality} onChange={(event) => setFilters((old) => ({ ...old, quality: event.target.value }))}><option value="all">全部质量</option><option value="ready">指标完整</option><option value="metrics_partial">指标待补</option></FilterField>
  </section>;
}

function EvidencePill({ material, onOpen }) {
  return <button type="button" className={`evidence-pill ${material.aiProof?.verified ? 'verified' : 'pending'}`} onClick={() => onOpen(material)}>{material.aiProof?.verified ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}<span>{material.aiProof?.label || '证据待核验'}</span></button>;
}

function SourceAction({ material, children, iconOnly = false }) {
  if (material.rawMetrics?.sourceKind === 'wechat_public_search') {
    return <button type="button" className={`source-action ${iconOnly ? 'is-icon' : ''}`} title="在微信视频号最热结果中定位" onClick={() => api.openChannelsSearch(material.rawMetrics?.wechatSearchKeyword || material.query).catch(() => {})}>{children}</button>;
  }
  return <a href={material.sourceUrl} target="_blank" rel="noreferrer">{children}</a>;
}

function MaterialTable({ platform, materials, filters, setFilters, onEvidence, onPreview }) {
  const metrics = PLATFORM_CONFIG[platform].metrics;
  return <div className="data-table-shell"><div className="data-table-scroll"><table className="material-table"><thead><tr><th className="material-title-col">素材 / 作者</th><th>主题、产品与品牌</th><th>创意拆解</th><th>内容方向</th><th>AI证据</th>{metrics.map((metric) => <th key={metric.key}><MetricSort field={metric.key} label={metric.label.replace('量', '')} filters={filters} setFilters={setFilters} /></th>)}<th><MetricSort field="favoriteLikeRate" label="藏赞比" filters={filters} setFilters={setFilters} /></th><th><MetricSort field="shareLikeRate" label="转赞比" filters={filters} setFilters={setFilters} /></th><th><MetricSort field="marketingScore" label="投流值" filters={filters} setFilters={setFilters} /></th><th>动作</th></tr></thead>
    <tbody>{materials.map((item) => <tr key={item.id}><td><div className="material-title"><span className="thumb-wrap">{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" referrerPolicy="no-referrer" /> : <Play size={15} />}</span><div><SourceAction material={item}>{item.title}</SourceAction><small>{item.authorName || '作者未知'} · {formatDate(item.publishedAt)}</small></div></div></td><td><div className="product-stack"><strong>{item.productName || '待校准'}</strong><span>{item.brandName || '品牌未明确'}</span><small>{item.productGroup}</small></div></td><td><div className="creative-stack"><b>{item.creativeFormat}</b><span>{item.hookType}</span><small>{item.targetAudience}</small></div></td><td><div className="intent-stack"><span>{item.contentIntent}</span><small>{item.ctaType}</small></div></td><td><EvidencePill material={item} onOpen={onEvidence} /></td>{metrics.map((metric) => <td className="number-cell" key={metric.key}>{metric.key === 'likeCount' ? <strong>{formatNumber(item[metric.key])}</strong> : formatNumber(item[metric.key])}</td>)}<td className="number-cell ratio-cell">{formatRatio(item.favoriteLikeRate)}</td><td className="number-cell ratio-cell">{formatRatio(item.shareLikeRate)}</td><td><span className={`score-chip ${(item.marketingScore || 0) >= 70 ? 'high' : ''}`}>{item.marketingScore ?? '—'}</span></td><td><div className="row-actions"><SourceAction material={item} iconOnly><ExternalLink size={14} /></SourceAction>{item.mediaUrl && <button type="button" onClick={() => onPreview(item)} aria-label="预览已下载视频"><Play size={14} /></button>}</div></td></tr>)}</tbody></table></div></div>;
}

function DatabaseWorkspace({ platform, data, loading, filters, setFilters, onEvidence, onPreview, requireAiEvidence = true, resultScope = 'history', setResultScope, resultKeywords = [] }) {
  const popularOnly = platform === 'douyin' && !requireAiEvidence;
  const currentScope = platform === 'douyin' && resultScope === 'current' && resultKeywords.length > 0;
  const keywordLabel = resultKeywords.length <= 2 ? resultKeywords.join('、') : `${resultKeywords.slice(0, 2).join('、')} 等 ${resultKeywords.length} 个词`;
  return <>
    {platform === 'douyin' && <div className="result-scope-bar"><div><span>RESULT SCOPE</span><strong>当前展示口径</strong></div><div className="scope-switch"><button type="button" className={currentScope ? 'is-active' : ''} disabled={!resultKeywords.length} onClick={() => setResultScope?.('current')}>本次关键词结果{resultKeywords.length ? <b>{resultKeywords.length}</b> : null}</button><button type="button" className={!currentScope ? 'is-active' : ''} onClick={() => setResultScope?.('history')}>历史素材库</button></div><p>{currentScope ? `只展示由“${keywordLabel}”实际搜索采集的内容 · 刷新后仍保持` : '展示此前所有行业与关键词沉淀的历史内容；不会混入“本次关键词结果”'}</p></div>}
    <div className="section-heading"><div><span className="section-index">01 / MATERIAL LIBRARY</span><h2>{currentScope ? `“${keywordLabel}”爆款素材结果` : popularOnly ? '热门搜索素材数据库' : 'AI 素材数据库'}</h2><p>{currentScope ? '本区不会混入其他搜索词的历史素材；抖音结果已先按“最多点赞”排序后采集。' : popularOnly ? '本轮按关键词和最多点赞结果采集，不进入详情页核验AI声明；已有AI证据仍会保留展示。' : '默认只展示AI证据明确、互动指标完整的素材；其余候选保留在库内，但不进入热榜和投流结论。'}</p></div><span className="result-count"><strong>{data?.count || 0}</strong> 条当前结果</span></div>
    <MaterialFilters filters={filters} setFilters={setFilters} facets={data?.facets} />
    {popularOnly && <p className="filter-explanation">普通热门模式：不要求 AI 声明；收藏、评论、分享等未读取的指标显示“—”，不当作 0，也不因此隐藏视频。</p>}
    {!loading && !data?.materials?.length && data?.unfilteredCount > 0 && <div className="job-strip"><AlertTriangle size={18} /><div>该范围实际有 {data.unfilteredCount} 条素材，被当前筛选条件隐藏。<button type="button" onClick={() => setFilters(defaultMaterialFilters(false))}>显示该范围全部素材</button></div></div>}
    {loading ? <Loading label={currentScope ? '正在读取本次关键词结果' : '正在读取素材数据库'} /> : data?.materials?.length ? <MaterialTable platform={platform} materials={data.materials} filters={filters} setFilters={setFilters} onEvidence={onEvidence} onPreview={onPreview} /> : <Empty label={currentScope ? `“${keywordLabel}”尚未采集到符合当前筛选条件的素材` : '当前筛选条件下暂无素材'} />}
  </>;
}

function CategoryRankings({ platform, data, facets, category, setCategory, rankSort, setRankSort, limit, setLimit, loading, onEvidence }) {
  const boards = data?.groups || [];
  const rankMetrics = PLATFORM_CONFIG[platform].metrics.filter((item) => !item.derived).slice(0, 3);
  return <><div className="section-heading"><div><span className="section-index">02 / TOPIC LEADERBOARD</span><h2>分主题独立热榜</h2><p>每个搜索主题拥有独立样本池和排名，不让不同行业混在一个 Top 榜中。</p></div><div className="rank-controls"><FilterField label="榜单口径" value={rankSort} onChange={(event) => setRankSort(event.target.value)}><option value="marketingScore">投流价值</option>{platform === 'channels' ? <><option value="recommendCount">喜欢/推荐</option><option value="shareCount">分享量</option><option value="likeCount">点赞量</option><option value="commentCount">评论量</option></> : <><option value="likeCount">点赞量</option><option value="shareCount">分享量</option><option value="favoriteCount">收藏量</option></>}</FilterField><FilterField label="每类数量" value={limit} onChange={(event) => setLimit(Number(event.target.value))}><option value={20}>Top 20</option><option value={50}>Top 50</option></FilterField></div></div>
    <div className="category-ticker"><button type="button" className={category === 'all' ? 'is-active' : ''} onClick={() => setCategory('all')}>全部主题</button>{(facets?.products || []).filter((item) => item.value !== '未分类').map((item) => <button type="button" key={item.value} className={category === item.value ? 'is-active' : ''} onClick={() => setCategory(item.value)}>{item.value}<b>{item.count}</b></button>)}</div>
    {loading ? <Loading label="正在生成分主题榜单" /> : boards.length ? <div className="category-board-stack">{boards.map((board) => <div className="category-board" key={board.group}><header><div><span>独立主题榜</span><h3>{board.group}</h3></div><p>素材库 {board.total} 条 · 当前展示 {board.videos.length} 条</p></header><div className="rank-list">{board.videos.map((item) => <article key={item.id} className="rank-row"><span className="rank-no">{String(item.categoryRank).padStart(2, '0')}</span><div className="rank-thumb">{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" referrerPolicy="no-referrer" /> : <Play size={16} />}</div><div className="rank-main"><SourceAction material={item}>{item.title}</SourceAction><p>{item.productName || '主题待校准'} · {item.brandName || '品牌未明确'} · {item.creativeFormat}</p></div><EvidencePill material={item} onOpen={onEvidence} /><div className="rank-metrics">{rankMetrics.map((metric) => <span key={metric.key}><small>{metric.label.replace('量', '')}</small>{formatNumber(item[metric.key])}</span>)}</div><span className="rank-score"><small>投流值</small>{item.marketingScore ?? '—'}</span></article>)}</div></div>)}</div> : <Empty label="该主题尚未积累到可排名素材" />}</>;
}

function AnalysisBar({ label, value, max, secondary }) { return <div className="analysis-bar"><div><span>{label}</span><b>{value}</b></div><i><em style={{ width: `${max ? Math.max((value / max) * 100, 3) : 0}%` }} /></i>{secondary && <small>{secondary}</small>}</div>; }
function AnalysisWorkspace({ platform, analysis, loading, onEvidence }) {
  if (loading) return <Loading label="正在计算投流洞察" />;
  if (!analysis?.summary?.materials) return <Empty label="素材积累后将在这里生成投流洞察" />;
  const maxCategory = Math.max(...analysis.categories.map((item) => item.count), 1);
  const maxFormat = Math.max(...analysis.formats.map((item) => item.count), 1);
  return <><div className="section-heading"><div><span className="section-index">03 / MEDIA BUYING INTELLIGENCE</span><h2>投流分析面板</h2><p>从素材量、深互动、创意钩子和内容形式判断可复用的投放机会。</p></div><span className="analysis-stamp"><CircleDot size={13} />基于当前素材库实时计算</span></div>
    <section className="kpi-grid"><article className="kpi-primary"><span>素材规模</span><strong>{analysis.summary.materials}</strong><small>{analysis.summary.categories} 个主题/品类 · {analysis.summary.brands} 个明确品牌</small></article><article><ShieldCheck /><span>AI证据验证</span><strong>{analysis.summary.aiVerified}</strong><small>{platform === 'channels' ? '平台或作者明确声明' : '详情页原生证据'}</small></article><article><BadgeCheck /><span>指标完整</span><strong>{analysis.summary.metricsReady}</strong><small>{platform === 'channels' ? '公域喜欢、分享、点赞、评论均有证据' : '赞藏评转均有证据'}</small></article><article><Target /><span>平均投流值</span><strong>{analysis.summary.avgMarketingScore ?? '—'}</strong><small>钩子×形式×深互动</small></article><article><TrendingUp /><span>平均藏赞比</span><strong>{formatRatio(analysis.summary.avgFavoriteLikeRate)}</strong><small>内容决策价值</small></article><article><Megaphone /><span>平均转赞比</span><strong>{formatRatio(analysis.summary.avgShareLikeRate)}</strong><small>传播驱动力</small></article></section>
    <section className="analysis-grid"><article className="analysis-panel funnel-panel"><header><span>采集漏斗</span><small>最近一轮 → 素材沉淀</small></header><div className="funnel"><div><strong>{analysis.funnel.searchCards}</strong><span>{platform === 'channels' ? '账号作品' : '搜索卡片'}</span></div><ChevronRight /><div><strong>{analysis.funnel.detailAiVerified}</strong><span>{platform === 'channels' ? '明确AI证据' : '详情AI声明'}</span></div><ChevronRight /><div><strong>{analysis.funnel.storedMaterials}</strong><span>可分析素材</span></div><ChevronRight /><div><strong>{analysis.funnel.metricsReady}</strong><span>指标完整</span></div></div></article><article className="analysis-panel"><header><span>主题覆盖</span><small>数量 / 平均投流值</small></header><div className="bar-list">{analysis.categories.slice(0, 8).map((item) => <AnalysisBar key={item.label} label={item.label} value={item.count} max={maxCategory} secondary={`投流值 ${item.avgMarketingScore ?? '—'} · 均赞 ${formatNumber(item.avgLikes)}`} />)}</div></article><article className="analysis-panel"><header><span>创意形式分布</span><small>寻找规模与效率交集</small></header><div className="bar-list">{analysis.formats.slice(0, 8).map((item) => <AnalysisBar key={item.label} label={item.label} value={item.count} max={maxFormat} secondary={`藏赞比 ${formatRatio(item.avgFavoriteLikeRate)} · 投流值 ${item.avgMarketingScore ?? '—'}`} />)}</div></article><article className="analysis-panel matrix-panel"><header><span>钩子效率矩阵</span><small>样本数 / 深互动</small></header><div className="signal-table">{analysis.hooks.slice(0, 8).map((item) => <div key={item.label}><strong>{item.label}</strong><span>{item.count} 条</span><b>{formatRatio(item.avgFavoriteLikeRate)}</b><small>平均投流值 {item.avgMarketingScore ?? '—'}</small></div>)}</div></article></section>
    <section className="opportunity-panel"><header><div><span>优先拆解池</span><h3>值得营销团队进一步复盘的素材</h3></div><small>按投流价值分优先</small></header><div className="opportunity-grid">{analysis.opportunities.slice(0, 6).map((item) => <article key={item.id}><div className="opportunity-top"><span>{item.marketingScore ?? '—'}</span><EvidencePill material={item} onOpen={onEvidence} /></div><SourceAction material={item}>{item.title}</SourceAction><p>{item.hookType} · {item.creativeFormat} · {item.ctaType}</p><div>{item.sellingPoints.slice(0, 3).map((point) => <b key={point}>{point}</b>)}</div></article>)}</div></section></>;
}

function EvidenceModal({ material, onClose, onPreview }) {
  if (!material) return null;
  const metrics = material.rawMetrics?.metricEvidence || {};
  const proofTitle = material.aiProof?.sourceType === 'author_disclosure' ? '作者文案AI声明' : material.aiProof?.sourceType === 'platform_declaration' ? '平台原生AI声明' : 'AI证据';
  const metricList = PLATFORM_CONFIG[material.platform]?.metrics.filter((item) => !item.derived) || [];
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="evidence-modal" role="dialog" aria-modal="true"><header><div><span>AI EVIDENCE DOSSIER</span><h2>证据与指标审计</h2><p>{material.title}</p></div><button type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="evidence-body"><article className="proof-card"><ShieldCheck size={24} /><div><span>{proofTitle}</span><strong>{material.aiProof?.label || '未捕获声明原文'}</strong><small>检查时间 {formatDate(material.aiProof?.checkedAt)} · 证据范围 {material.aiProof?.scope || '未知'}</small></div></article><div className="evidence-grid"><article><span>采集来源</span><strong>{material.rawMetrics?.sourceKind === 'wechat_public_search' ? '微信搜一搜 · 视频号公域最热' : material.rawMetrics?.sourceKind === 'owned_account_analytics' ? '历史记录 · 自有账号数据' : `${material.rawMetrics?.searchFilter?.sortLabel || '公开页面'} · ${material.rawMetrics?.searchFilter?.timeLabel || '—'}`}</strong><small>指标验证：{material.rawMetrics?.metricsVerified ? '完整' : '待补采'}</small></article><article><span>主题归类</span><strong>{material.productGroup} / {material.productName || '待校准'}</strong><small>{material.aiEvidence}</small></article></div><section className="metric-audit"><h3>互动指标原始证据</h3>{metricList.map(({ key, label }) => <div key={key}><span>{label}</span><strong>{formatNumber(material[key])}</strong><code>{metrics[key]?.selector || '未记录选择器'}</code><small>页面原文：{metrics[key]?.text ?? '—'}</small></div>)}</section><section className="marketing-dossier"><h3>投流拆解</h3><div><span>创意形式<strong>{material.creativeFormat}</strong></span><span>前三秒钩子<strong>{material.hookType}</strong></span><span>CTA<strong>{material.ctaType}</strong></span><span>目标人群<strong>{material.targetAudience}</strong></span></div><p>{material.sellingPoints.length ? material.sellingPoints.join(' · ') : '卖点仍待人工补充'}</p></section></div><footer><a href={material.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开原视频</a>{material.mediaUrl && <button type="button" onClick={() => onPreview(material)}><Play size={14} />预览已下载视频</button>}</footer></section></div>;
}
function VideoModal({ video, onClose }) { return video ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="video-modal"><header><div><span>LOCAL MEDIA PREVIEW</span><h2>{video.title}</h2></div><button type="button" onClick={onClose}><X size={18} /></button></header><video src={video.mediaUrl} controls /><footer>仅预览已取得授权并保存到本机的视频文件</footer></section></div> : null; }
function Loading({ label }) { return <div className="state-box"><LoaderCircle className="spin" /><span>{label}</span></div>; }
function Empty({ label }) { return <div className="state-box empty"><LibraryBig /><strong>{label}</strong><span>可调整筛选条件，或继续采集扩大样本库。</span></div>; }

function KeywordWorkbench({ platform = 'douyin', keywords, setKeywords, timeRange, setTimeRange, topN = 20, setTopN, requireAiEvidence = true, setRequireAiEvidence, collecting, collectorAvailable, onSearch, notify, deepSeek }) {
  const isChannels = platform === 'channels';
  const inputId = `${platform}-keyword-input`;
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deepSeekStatus = deepSeek.status;
  const suggestionVersion = useRef(0);
  useEffect(() => {
    suggestionVersion.current += 1;
    setSuggestions(null); setPopoverOpen(false); setSuggesting(false);
    return () => { suggestionVersion.current += 1; };
  }, [deepSeek.revision]);

  const appendKeywords = useCallback((items) => {
    setKeywords((current) => {
      const seen = new Set(current.map((item) => item.toLowerCase()));
      const next = [...current];
      for (const raw of items) {
        const keyword = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!keyword || seen.has(keyword.toLowerCase()) || next.length >= 40) continue;
        seen.add(keyword.toLowerCase());
        next.push(keyword);
      }
      return next;
    });
  }, [setKeywords]);

  const requestSuggestions = useCallback(async (seedKeyword, nextKeywords) => {
    const version = ++suggestionVersion.current;
    setPopoverOpen(true);
    setSuggestions({ seedKeyword, categories: [], count: 0 });
    if (!deepSeekStatus.configured) { setSettingsOpen(true); return; }
    setSuggesting(true);
    try {
      const result = await deepSeek.suggest(seedKeyword, nextKeywords);
      if (version === suggestionVersion.current && result) setSuggestions(result);
    } catch (error) {
      if (version !== suggestionVersion.current) return;
      notify(`DeepSeek扩词失败：${error.message}`, 'error');
      if ([401, 403, 503].includes(error.status)) setSettingsOpen(true);
    } finally { if (version === suggestionVersion.current) setSuggesting(false); }
  }, [deepSeek, deepSeekStatus.configured, notify]);

  const commitDraft = useCallback(() => {
    const entries = draft.split(/[，,；;\n]+/).map((item) => item.trim()).filter(Boolean);
    if (!entries.length) return;
    const room = Math.max(40 - keywords.length, 0);
    const accepted = entries.slice(0, room);
    appendKeywords(accepted);
    setDraft('');
    setPopoverOpen(false);
  }, [draft, keywords.length, appendKeywords]);

  const openOptionalSuggestions = useCallback(() => {
    const seedKeyword = keywords.at(-1);
    if (seedKeyword) requestSuggestions(seedKeyword, keywords);
  }, [keywords, requestSuggestions]);

  const toggleSuggestion = (keyword) => {
    const exists = keywords.some((item) => item.toLowerCase() === keyword.toLowerCase());
    if (exists) setKeywords((current) => current.filter((item) => item.toLowerCase() !== keyword.toLowerCase()));
    else appendKeywords([keyword]);
  };

  return <section className="keyword-studio">
    <header><div><span>SEARCH QUEUE / {isChannels ? '视频号公域关键词工作台' : '抖音关键词工作台'}</span><h3>{isChannels ? '按你的关键词搜索全网视频号' : '一个词，抓取它自己的爆款结果'}</h3><p>回车只会把原词加入搜索队列，不自动扩词；需要相关词时再点击“可选AI扩词”。</p></div><button type="button" className={`deepseek-state deepseek-settings-toggle ${deepSeekStatus.configured ? 'is-ready' : ''}`} aria-expanded={settingsOpen} aria-controls={`${platform}-deepseek-settings`} onClick={() => setSettingsOpen((open) => !open)}><KeyRound size={13} />{deepSeekStatus.configured ? `DeepSeek · ${deepSeek.source === 'personal' ? '个人 Key' : '本机配置'} · ${deepSeekStatus.model}` : 'DeepSeek · 未配置'}<b>{settingsOpen ? '收起设置' : '设置 / 切换 Key'}</b></button></header>
    {settingsOpen && <DeepSeekSettings connection={deepSeek} id={`${platform}-deepseek-settings`} />}
    <div className={`keyword-control-row ${isChannels ? 'is-channels' : ''}`}>
      <div className="keyword-input-shell" onClick={() => document.getElementById(inputId)?.focus()}><div className="keyword-chips">{keywords.map((keyword) => <span key={keyword}>{keyword}<button type="button" onClick={(event) => { event.stopPropagation(); setKeywords((current) => current.filter((item) => item !== keyword)); }} aria-label={`移除${keyword}`}><X size={11} /></button></span>)}<input id={inputId} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); commitDraft(); } }} placeholder={keywords.length ? '继续输入，回车添加…' : '例如：咖啡机、汽车座椅、纸尿裤或任意主题'} /></div><button type="button" className="keyword-add" onClick={(event) => { event.stopPropagation(); commitDraft(); }} disabled={!draft.trim()}><Plus size={14} />添加</button></div>
      {!isChannels && <label className={`ai-scope-toggle ${requireAiEvidence ? 'is-active' : ''}`}><input type="checkbox" checked={requireAiEvidence} disabled={collecting} onChange={(event) => setRequireAiEvidence?.(event.target.checked)} /><span className="toggle-track"><i /></span><span><strong>仅采集 AI 生成视频</strong><small>{requireAiEvidence ? '进入详情页核验AI声明' : '采集热门结果，跳过AI核验'}</small></span></label>}
      {isChannels ? <FilterField label="每词最热" value={topN} onChange={(event) => setTopN(Number(event.target.value))}><option value={15}>Top 15</option><option value={20}>Top 20</option></FilterField> : <FilterField label="发布时间" value={timeRange} onChange={(event) => setTimeRange(event.target.value)}><option value="one_day">一天内</option><option value="one_week">一周内</option><option value="half_year">半年内</option><option value="unlimited">不限</option></FilterField>}
      <button className="keyword-search-action" type="button" onClick={onSearch} disabled={collecting || !collectorAvailable || keywords.length === 0}>{collecting ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}{collecting ? '正在深度抓取爆款' : `抓取 ${keywords.length} 个词的爆款`}</button>
    </div>
    <footer><span>搜索队列 <b>{keywords.length}</b>/40</span><span className="queue-contract">仅执行队列原词 · 不追加 · 不替换</span><span>{isChannels ? '执行方式：微信视频号 → 最热 → 逐条详情AI与互动核验' : requireAiEvidence ? '执行方式：逐词搜索 → 最多点赞 → 深度加载 → 详情页AI核验' : '执行方式：逐词搜索 → 最多点赞 → 深度加载热门结果'}</span>{keywords.length > 0 && <div className="keyword-footer-actions"><button type="button" className="suggestion-trigger" onClick={openOptionalSuggestions}><WandSparkles size={12} />可选AI扩词</button><button type="button" onClick={() => setKeywords([])}>清空队列</button></div>}</footer>
    {popoverOpen && <div className="keyword-popover"><div className="popover-head"><div><WandSparkles size={18} /><span><strong>围绕“{suggestions?.seedKeyword || '当前词'}”扩展</strong><small>适用于任意行业；只有你点选的推荐词才会加入搜索队列</small></span></div><button type="button" onClick={() => setPopoverOpen(false)} aria-label="关闭推荐"><X size={16} /></button></div>{suggesting ? <div className="suggestion-loading"><LoaderCircle className="spin" /><span>DeepSeek正在识别行业并整理相关主题、产品、品牌与场景词…</span></div> : !deepSeekStatus.configured ? <div className="deepseek-local-note"><KeyRound size={20} /><div><strong>先设置 DeepSeek API Key</strong><p>请在上方设置区输入个人 Key；不使用AI扩词也可以直接采集队列中的原词。</p></div></div> : <div className="suggestion-groups">{(suggestions?.categories || []).map((group) => <section key={group.label}><header><span>{group.label}</span><b>{group.keywords.length}</b></header><div>{group.keywords.map((keyword) => { const selected = keywords.some((item) => item.toLowerCase() === keyword.toLowerCase()); return <button key={keyword} type="button" className={selected ? 'is-selected' : ''} onClick={() => toggleSuggestion(keyword)}>{selected ? <Check size={12} /> : <Plus size={12} />}{keyword}</button>; })}</div></section>)}</div>}</div>}
  </section>;
}

function ChannelsWorkbench({ keywords, setKeywords, topN, setTopN, collecting, desktop, onCollect, notify, deepSeek }) {
  return <><section className="channels-studio channels-public-studio">
    <div className="channels-studio-copy"><span>PUBLIC SEARCH / 视频号公域采集</span><h3>搜全网视频号，不读你自己的作品</h3><p>复用当前微信电脑版的登录状态，自动进入「搜一搜 · 视频号」，每个关键词选「最热」后打开详情采集。</p></div>
    <div className="channels-source-card"><div><ScanSearch size={17} /><span><small>当前数据源</small><strong>微信搜一搜 · 视频号公域</strong></span></div><b className={desktop?.wechatRunning ? 'is-ready' : ''}><CircleDot size={10} />{desktop?.wechatRunning ? '微信已登录，可直接搜索' : '请先打开并登录微信'}</b></div>
    <div className="channels-rule-grid"><article><TrendingUp size={16} /><span><strong>每词独立最热</strong><small>每个词采集 Top 15/20</small></span></article><article><BadgeCheck size={16} /><span><strong>详情页AI核验</strong><small>平台标识 / 作者AI文案</small></span></article><article><ShieldCheck size={16} /><span><strong>只用公开互动</strong><small>喜欢、分享、点赞、评论</small></span></article></div>
    <footer><span>公域页不公开播放量与收藏量，这两列不参与视频号爆款排序。</span></footer>
  </section><KeywordWorkbench platform="channels" keywords={keywords} setKeywords={setKeywords} topN={topN} setTopN={setTopN} collecting={collecting} collectorAvailable={desktop?.available && desktop?.wechatRunning} onSearch={onCollect} notify={notify} deepSeek={deepSeek} /></>;
}

export default function ResearchWorkspace() {
  const deepSeek = useDeepSeekConnection();
  const [initialDouyinSearchState] = useState(() => readStoredDouyinSearchState(EXTENSION_MODE || typeof window === 'undefined' ? undefined : window.localStorage));
  const [platform, setPlatform] = useState('douyin');
  const [workspace, setWorkspace] = useState('database');
  const [meta, setMeta] = useState(null);
  const [materials, setMaterials] = useState({ materials: [], facets: {}, count: 0 });
  const [rankings, setRankings] = useState({ groups: [] });
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [collectionError, setCollectionError] = useState('');
  const submittingRef = useRef(false);
  const requestVersion = useRef(0);
  const [evidence, setEvidence] = useState(null);
  const [preview, setPreview] = useState(null);
  const [toast, setToast] = useState(null);
  const [category, setCategory] = useState('all');
  const [rankSort, setRankSort] = useState('marketingScore');
  const [rankLimit, setRankLimit] = useState(20);
  const [timeRange, setTimeRange] = useState(initialDouyinSearchState.timeRange);
  const [channelsKeywords, setChannelsKeywords] = useState([]);
  const [channelsTopN, setChannelsTopN] = useState(20);
  const [searchKeywords, updateSearchKeywords] = useState(initialDouyinSearchState.keywords);
  const [resultScope, setResultScope] = useState(initialDouyinSearchState.resultScope);
  const [searchStateReady, setSearchStateReady] = useState(initialDouyinSearchState.exists);
  const [requireAiEvidence, updateRequireAiEvidence] = useState(initialDouyinSearchState.requireAiEvidence);
  const [douyinFilters, setDouyinFilters] = useState(initialDouyinSearchState.filters);
  const [otherFilters, setOtherFilters] = useState(() => ({ ...defaultMaterialFilters(true), quality: 'ready' }));
  const filters = platform === 'douyin' ? douyinFilters : otherFilters;
  const setFilters = platform === 'douyin' ? setDouyinFilters : setOtherFilters;
  const setRequireAiEvidence = useCallback((enabled) => {
    updateRequireAiEvidence(enabled);
    setDouyinFilters((current) => filtersForAiMode(current, enabled));
  }, []);
  const setSearchKeywords = useCallback((value) => {
    updateSearchKeywords((current) => typeof value === 'function' ? value(current) : value);
    setResultScope('current');
    setDouyinFilters((current) => ({ ...current, productGroup: 'all', brand: 'all', search: '' }));
  }, []);
  const notify = useCallback((message, type = 'success') => { setToast({ message, type }); window.setTimeout(() => setToast(null), 4200); }, []);
  const loadMeta = useCallback(async () => {
    try { const next = await api.getMeta(); setMeta(next); return next; }
    catch (error) { if (EXTENSION_MODE) setMeta(null); throw error; }
  }, []);
  const loadWorkspace = useCallback(async () => {
    const version = ++requestVersion.current;
    const isCurrent = () => version === requestVersion.current;
    setLoading(true);
    try {
      const nextMeta = await loadMeta();
      if (!isCurrent()) return;
      if (platform === 'douyin' && !searchStateReady) {
        const serverState = nextMeta.searchStates?.douyin;
        const recentTerm = nextMeta.recentSearchTerms?.douyin?.[0]?.term;
        const restored = normalizeSearchState(serverState || { keywords: recentTerm ? [recentTerm] : [] });
        updateSearchKeywords(restored.keywords);
        setResultScope(restored.resultScope);
        updateRequireAiEvidence(restored.requireAiEvidence);
        setTimeRange(restored.timeRange);
        setDouyinFilters(restored.filters);
        setSearchStateReady(true);
        return;
      }
      const materialParams = materialRequestParams(platform, filters, searchKeywords, resultScope);
      const nextMaterials = await api.getMaterials(materialParams);
      if (!isCurrent()) return;
      if (!nextMaterials.count) {
        const unfiltered = await api.getMaterials({ ...materialRequestParams(platform, defaultMaterialFilters(false), searchKeywords, resultScope), limit: 1 });
        if (!isCurrent()) return;
        nextMaterials.unfilteredCount = unfiltered.count;
      }
      setMaterials(nextMaterials);
      if (workspace === 'rankings') {
        const nextRankings = await api.getCategoryRankings({ platform, productGroup: category, limitPerGroup: rankLimit, sort: rankSort });
        if (!isCurrent()) return;
        setRankings(nextRankings);
      }
      if (workspace === 'analysis') {
        const nextAnalysis = await api.getAnalysis(platform);
        if (!isCurrent()) return;
        setAnalysis(nextAnalysis);
      }
      setJob(nextMeta.latestJobs?.[platform] || null);
    } catch (error) { if (isCurrent()) notify(error.message, 'error'); } finally { if (isCurrent()) setLoading(false); }
  }, [platform, filters, workspace, category, rankLimit, rankSort, resultScope, searchKeywords, searchStateReady, loadMeta, notify]);
  useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(loadWorkspace, 180);
    return () => { window.clearTimeout(timer); requestVersion.current += 1; };
  }, [loadWorkspace]);
  useEffect(() => {
    if (!searchStateReady) return;
    const state = { keywords: searchKeywords, resultScope, requireAiEvidence, timeRange, filters: douyinFilters };
    if (EXTENSION_MODE) {
      if (!meta?.localExtension?.connected) return;
      const timer = setTimeout(() => api.saveSearchState(state).catch((error) => notify(error.message, 'error')), 400);
      return () => clearTimeout(timer);
    }
    storeDouyinSearchState(window.localStorage, state);
  }, [searchKeywords, resultScope, requireAiEvidence, timeRange, douyinFilters, searchStateReady, meta?.localExtension?.connected, notify]);
  useEffect(() => {
    if (!job || CLOSED_JOB_STATES.has(job.status)) return undefined;
    const timer = window.setInterval(async () => {
      const next = await api.getJob(job.id).catch(() => null);
      if (!next) return;
      setJob(next);
      if (CLOSED_JOB_STATES.has(next.status)) { await loadWorkspace(); notify(next.status === 'completed' ? next.message : `采集未完成：${next.message}`, next.status === 'completed' ? 'success' : 'error'); }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [job, loadWorkspace, notify]);
  const collecting = submitting || Boolean(job && job.platform === platform && !CLOSED_JOB_STATES.has(job.status));
  const startCollection = async (customKeywords = [], overrides = {}) => {
    if (submittingRef.current) return;
    const keywords = normalizeSearchKeywords(customKeywords);
    const requireAi = overrides.requireAiEvidence !== false;
    if (platform === 'douyin' && !keywords.length) { notify('请先输入至少一个抖音搜索关键词。', 'error'); return; }
    if (platform === 'channels' && !keywords.length) { notify('请先输入至少一个视频号公域搜索关键词。', 'error'); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setCollectionError('');
    try {
      const next = await api.startCollection(platform, {
        topN: platform === 'channels' ? channelsTopN : 20,
        maxResults: overrides.maxResults || 800,
        maxQueries: ['douyin', 'channels'].includes(platform) ? keywords.length : 30,
        keywords: ['douyin', 'channels'].includes(platform) ? keywords : undefined,
        timeRange: platform === 'douyin' ? timeRange : undefined,
        requireAiEvidence: platform === 'douyin' ? requireAi : true
      });
      requestVersion.current += 1;
      if (platform === 'douyin') {
        setResultScope('current');
        setDouyinFilters((current) => filtersForAiMode(current, requireAi));
      }
      setJob(next);
      notify(platform === 'douyin'
        ? requireAi
          ? `已开始搜索 ${keywords.length} 个关键词，并核验详情页AI声明。`
          : `已开始搜索 ${keywords.length} 个关键词；本轮不进入详情页核验AI声明。`
        : platform === 'channels' ? `已打开微信，将逐个搜索 ${keywords.length} 个视频号公域关键词。` : '采集已开始；合格素材会进入数据库。');
    }
    catch (error) {
      setCollectionError(error.message);
      if (error.details?.jobId) {
        const active = await api.getJob(error.details.jobId).catch(() => null);
        if (active) setJob(active);
      }
      notify(error.message, 'error');
    } finally { submittingRef.current = false; setSubmitting(false); }
  };
  const activeWorkspace = WORKSPACES.find((item) => item.id === workspace);
  const config = PLATFORM_CONFIG[platform];
  const browserReady = meta?.browserHelper?.connected || meta?.collectorBrowser?.connected;
  const connectionReady = platform === 'channels' ? meta?.channelsDesktop?.wechatRunning : browserReady;
  const connectionLabel = platform === 'channels'
    ? (meta?.channelsDesktop?.wechatRunning ? '微信公域搜索已就绪' : '等待微信电脑版')
    : meta?.browserHelper?.connected ? `浏览器助手 ${meta.browserHelper.version}`
      : meta?.collectorBrowser?.connected ? '采集浏览器已连接' : EXTENSION_MODE ? '本机助手未连接' : '等待采集浏览器';
  const exportCsv = async () => {
    try { const result = await api.localExportCsv(platform); saveDownload(result.csv, '抖音素材.csv', 'text/csv;charset=utf-8'); }
    catch (error) { notify(error.message, 'error'); }
  };
  return <div className="research-app" data-platform={platform} data-storage-mode={EXTENSION_MODE ? 'extension' : 'server'}>
    <div className="ambient-grid" aria-hidden="true" />
    <header className="command-header">
      <div className="brand-lockup"><span className="brand-mark"><ScanSearch size={21} /></span><div><small>CROSS-INDUSTRY / MEDIA INTELLIGENCE</small><h1>全域短视频投流情报台</h1></div></div>
      <div className="header-status"><span className={connectionReady ? 'connected' : ''}><CircleDot size={12} />{connectionLabel}</span><button type="button" onClick={loadWorkspace}><RefreshCw size={14} />刷新</button></div>
    </header>
    <main className="command-layout">
      <aside className="left-rail">
        <div className="rail-label">PLATFORMS</div>
        <PlatformRail platform={platform} meta={meta} onChange={(next) => { if (next === platform) return; setPlatform(next); setCategory('all'); setCollectionError(''); }} />
        <div className="rail-label workspace-label">WORKSPACES</div>
        <nav className="workspace-nav">{WORKSPACES.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={workspace === item.id ? 'is-active' : ''} onClick={() => setWorkspace(item.id)}><Icon size={17} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight size={14} /></button>; })}</nav>
        <div className="rail-research-note"><Gauge size={18} /><strong>专业采集口径</strong><p>关键词由你决定；素材跨行业沉淀；热榜按搜索主题独立；指标不跨平台硬比较。</p></div>
      </aside>
      <section className="workspace-canvas">
        <header className="canvas-command">
          <div><span>{config.short} / {activeWorkspace.label}</span><h2>{config.name} · {activeWorkspace.description}</h2><p>{config.description}</p></div>
          <div className="collect-cluster">{EXTENSION_MODE ? <button type="button" className="export-action" disabled={!browserReady} onClick={exportCsv}><Download size={15} />导出素材CSV</button> : <a className="export-action" href={api.exportMaterialsUrl(platform)}><Download size={15} />导出素材CSV</a>}{platform === 'xiaohongshu' && <button className="collect-action" type="button" onClick={() => startCollection([])} disabled={collecting || !meta?.collectorAvailable}>{collecting ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{collecting ? '采集中' : `采集${config.name}`}</button>}</div>
        </header>
        {EXTENSION_MODE && <LocalExtensionPanel connected={Boolean(meta?.localExtension?.connected)} version={meta?.localExtension?.version} onRefresh={loadWorkspace} onRestored={async () => { setSearchStateReady(false); }} notify={notify} />}
        {platform === 'douyin' && <KeywordWorkbench keywords={searchKeywords} setKeywords={setSearchKeywords} timeRange={timeRange} setTimeRange={setTimeRange} requireAiEvidence={requireAiEvidence} setRequireAiEvidence={setRequireAiEvidence} collecting={collecting} collectorAvailable={meta?.collectorAvailable} onSearch={() => startCollection(searchKeywords, { requireAiEvidence })} notify={notify} deepSeek={deepSeek} />}
        {platform === 'channels' && <ChannelsWorkbench keywords={channelsKeywords} setKeywords={setChannelsKeywords} topN={channelsTopN} setTopN={setChannelsTopN} collecting={collecting} desktop={meta?.channelsDesktop} onCollect={() => startCollection(channelsKeywords)} notify={notify} deepSeek={deepSeek} />}
        <div className="canvas-meta"><span><Database size={13} />素材库 {meta?.materialCounts?.[platform] || 0}</span><span><Trophy size={13} />精选榜 {meta?.counts?.[platform] || 0}</span><span><TimerReset size={13} />最近任务 {formatDate(meta?.latestJobs?.[platform]?.finishedAt || meta?.latestJobs?.[platform]?.createdAt)}</span><span className={`evidence-standard ${platform === 'douyin' && !requireAiEvidence ? 'is-optional' : ''}`}><ShieldCheck size={13} />{platform === 'channels' ? 'AI证据区分平台声明与作者声明' : requireAiEvidence ? 'AI声明只认详情页证据' : '本轮不限定AI声明，仅采热门搜索结果'}</span></div>
        {collectionError && <div className="job-strip" role="alert"><AlertTriangle size={18} /><div>未启动新任务：{collectionError}</div></div>}
        <JobProgress job={job?.platform === platform ? job : null} />
        {EXTENSION_MODE && <CollectionAttention job={job} notify={notify} />}
        <div className="workspace-content">{workspace === 'database' && <DatabaseWorkspace platform={platform} data={materials} loading={loading} filters={filters} setFilters={setFilters} onEvidence={setEvidence} onPreview={setPreview} requireAiEvidence={requireAiEvidence} resultScope={resultScope} setResultScope={setResultScope} resultKeywords={searchKeywords} />}{workspace === 'rankings' && <CategoryRankings platform={platform} data={rankings} facets={materials.facets} category={category} setCategory={setCategory} rankSort={rankSort} setRankSort={setRankSort} limit={rankLimit} setLimit={setRankLimit} loading={loading} onEvidence={setEvidence} />}{workspace === 'analysis' && <AnalysisWorkspace platform={platform} analysis={analysis} loading={loading} onEvidence={setEvidence} />}</div>
      </section>
    </main>
    <EvidenceModal material={evidence} onClose={() => setEvidence(null)} onPreview={setPreview} />
    <VideoModal video={preview} onClose={() => setPreview(null)} />
    {toast && <div className={`toast ${toast.type}`}><span>{toast.message}</span></div>}
  </div>;
}
