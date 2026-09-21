import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taxonomyKeywordGroups } from './domain-rules.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(serverDir, '..');
const dataDir = path.join(projectDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const databasePath = process.env.MATERNAL_RADAR_DB || path.join(dataDir, 'maternal-ai-radar.db');
export const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    platform_item_id TEXT,
    source_url TEXT NOT NULL,
    title TEXT NOT NULL,
    author_name TEXT,
    published_at TEXT,
    product_group TEXT NOT NULL DEFAULT '未分类',
    ai_type TEXT NOT NULL DEFAULT '疑似 AI',
    ai_confidence REAL NOT NULL DEFAULT 0.45,
    ai_evidence TEXT,
    thumbnail_url TEXT,
    media_status TEXT NOT NULL DEFAULT 'source_only',
    media_path TEXT,
    rights_status TEXT NOT NULL DEFAULT 'unknown',
    view_count INTEGER,
    like_count INTEGER,
    favorite_count INTEGER,
    comment_count INTEGER,
    share_count INTEGER,
    recommend_count INTEGER,
    system_heat REAL,
    raw_metrics_json TEXT NOT NULL DEFAULT '{}',
    first_collected_at TEXT NOT NULL,
    last_collected_at TEXT NOT NULL,
    UNIQUE(platform, source_url)
  );

  CREATE INDEX IF NOT EXISTS idx_videos_platform ON videos(platform);
  CREATE INDEX IF NOT EXISTS idx_videos_product ON videos(product_group);
  CREATE INDEX IF NOT EXISTS idx_videos_ai_type ON videos(ai_type);

  CREATE TABLE IF NOT EXISTS metric_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    captured_at TEXT NOT NULL,
    view_count INTEGER,
    like_count INTEGER,
    favorite_count INTEGER,
    comment_count INTEGER,
    share_count INTEGER,
    recommend_count INTEGER,
    system_heat REAL,
    raw_metrics_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_video ON metric_snapshots(video_id, captured_at DESC);

  CREATE TABLE IF NOT EXISTS collection_jobs (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'queued',
    message TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    search_card_count INTEGER NOT NULL DEFAULT 0,
    ai_candidate_count INTEGER NOT NULL DEFAULT 0,
    added_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    error_summary TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_platform ON collection_jobs(platform, created_at DESC);

  CREATE TABLE IF NOT EXISTS pending_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    source_url TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(platform, source_url)
  );

  CREATE INDEX IF NOT EXISTS idx_pending_platform ON pending_candidates(platform, last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS keyword_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    keyword TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(group_name, keyword)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL
  );
`);

const videoColumns = new Set(db.prepare('PRAGMA table_info(videos)').all().map((column) => column.name));
const rankingColumns = {
  product_name: 'TEXT',
  brand_name: 'TEXT',
  content_intent: "TEXT NOT NULL DEFAULT '待判定'",
  intent_confidence: 'REAL NOT NULL DEFAULT 0.45',
  intent_evidence: 'TEXT',
  performance_label: 'TEXT',
  relevance_score: 'REAL',
  popularity_score: 'REAL',
  ranking_score: 'REAL',
  rank_position: 'INTEGER',
  material_status: "TEXT NOT NULL DEFAULT 'ready'",
  creative_format: 'TEXT',
  hook_type: 'TEXT',
  cta_type: 'TEXT',
  target_audience: 'TEXT',
  selling_points: 'TEXT',
  marketing_score: 'REAL'
};
for (const [name, type] of Object.entries(rankingColumns)) {
  if (!videoColumns.has(name)) db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_videos_ranking ON videos(platform, rank_position)');

const jobColumns = new Set(db.prepare('PRAGMA table_info(collection_jobs)').all().map((column) => column.name));
if (!jobColumns.has('search_card_count')) db.exec('ALTER TABLE collection_jobs ADD COLUMN search_card_count INTEGER NOT NULL DEFAULT 0');
if (!jobColumns.has('ai_candidate_count')) db.exec('ALTER TABLE collection_jobs ADD COLUMN ai_candidate_count INTEGER NOT NULL DEFAULT 0');
if (!jobColumns.has('settings_json')) db.exec("ALTER TABLE collection_jobs ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
if (!jobColumns.has('diagnostics_json')) db.exec("ALTER TABLE collection_jobs ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");

const taxonomyVersion = Number(db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'taxonomy_version'").get()?.setting_value || 0);
if (taxonomyVersion < 2) {
  const legacyGroups = ['喂养', '尿裤与护理', '洗护与清洁', '出行与睡眠', '孕产', '早教与玩具'];
  const placeholders = legacyGroups.map(() => '?').join(',');
  db.prepare(`DELETE FROM keyword_groups WHERE group_name IN (${placeholders})`).run(...legacyGroups);
  const insert = db.prepare('INSERT OR IGNORE INTO keyword_groups(group_name, keyword, enabled) VALUES (?, ?, 1)');
  for (const [groupName, keywords] of Object.entries(taxonomyKeywordGroups())) {
    for (const keyword of keywords) insert.run(groupName, keyword);
  }
  db.prepare(`
    INSERT INTO app_settings(setting_key, setting_value) VALUES ('taxonomy_version', '2')
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `).run();
}

const sortColumns = {
  publishedAt: 'published_at',
  firstCollectedAt: 'first_collected_at',
  viewCount: 'view_count',
  likeCount: 'like_count',
  favoriteCount: 'favorite_count',
  commentCount: 'comment_count',
  shareCount: 'share_count',
  recommendCount: 'recommend_count',
  systemHeat: 'system_heat'
  ,relevanceScore: 'relevance_score'
  ,rankingScore: 'ranking_score'
  ,rankPosition: 'rank_position'
  ,marketingScore: 'marketing_score'
  ,lastCollectedAt: 'last_collected_at'
};

function mapVideo(row) {
  if (!row) return null;
  const rawMetrics = JSON.parse(row.raw_metrics_json || '{}');
  const likes = Number(row.like_count) || 0;
  const ratio = (value) => likes > 0 && Number.isFinite(Number(value)) ? Math.round((Number(value) / likes) * 10000) / 100 : null;
  return {
    id: row.id,
    platform: row.platform,
    platformItemId: row.platform_item_id,
    sourceUrl: row.source_url,
    title: row.title,
    authorName: row.author_name,
    publishedAt: row.published_at,
    productGroup: row.product_group,
    productName: row.product_name,
    brandName: row.brand_name,
    contentIntent: row.content_intent,
    intentConfidence: row.intent_confidence,
    intentEvidence: row.intent_evidence,
    performanceLabel: row.performance_label,
    materialStatus: row.material_status || (rawMetrics.metricsVerified === true ? 'ready' : 'metrics_partial'),
    creativeFormat: row.creative_format || '待分析',
    hookType: row.hook_type || '待分析',
    ctaType: row.cta_type || '待分析',
    targetAudience: row.target_audience || '待分析',
    sellingPoints: String(row.selling_points || '').split('|').filter(Boolean),
    marketingScore: row.marketing_score,
    aiType: row.ai_type,
    aiConfidence: row.ai_confidence,
    aiEvidence: row.ai_evidence,
    thumbnailUrl: row.thumbnail_url,
    mediaStatus: row.media_status,
    mediaPath: row.media_path,
    mediaUrl: row.media_path ? `/media/${encodeURIComponent(path.basename(row.media_path))}` : null,
    rightsStatus: row.rights_status,
    viewCount: row.view_count,
    likeCount: row.like_count,
    favoriteCount: row.favorite_count,
    commentCount: row.comment_count,
    shareCount: row.share_count,
    recommendCount: row.recommend_count,
    systemHeat: row.system_heat,
    relevanceScore: row.relevance_score,
    popularityScore: row.popularity_score,
    rankingScore: row.ranking_score,
    rankPosition: row.rank_position,
    favoriteLikeRate: ratio(row.favorite_count),
    commentLikeRate: ratio(row.comment_count),
    shareLikeRate: ratio(row.share_count),
    aiProof: {
      verified: rawMetrics.aiEvidenceVerified === true || rawMetrics.detailAiDeclarationVerified === true,
      label: rawMetrics.platformAiLabel || null,
      checkedAt: rawMetrics.detailCollectedAt || null,
      scope: rawMetrics.aiDeclarationScope || null,
      sourceType: rawMetrics.aiEvidenceType || (rawMetrics.detailAiDeclarationVerified === true ? 'platform_declaration' : null)
    },
    metricQuality: {
      verified: rawMetrics.metricsVerified === true,
      coverage: rawMetrics.metricCoverage ?? null,
      missing: rawMetrics.metricMissing || []
    },
    rawMetrics,
    firstCollectedAt: row.first_collected_at,
    lastCollectedAt: row.last_collected_at
  };
}

export function getVideos({ platform, productGroup = 'all', aiType = 'all', contentIntent = 'all', sort = 'systemHeat', direction = 'desc', limit = 200 }) {
  const clauses = ['platform = ?', "product_group != '未分类'", 'rank_position IS NOT NULL'];
  const params = [platform];
  if (productGroup !== 'all') {
    clauses.push('product_group = ?');
    params.push(productGroup);
  }
  if (aiType !== 'all') {
    clauses.push('ai_type = ?');
    params.push(aiType);
  }
  if (contentIntent !== 'all') {
    clauses.push('content_intent = ?');
    params.push(contentIntent);
  }
  const sortColumn = sortColumns[sort] || 'last_collected_at';
  const sortDirection = direction === 'asc' ? 'ASC' : 'DESC';
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const rows = db.prepare(`
    SELECT * FROM videos
    WHERE ${clauses.join(' AND ')}
    ORDER BY ${sortColumn} IS NULL ASC, ${sortColumn} ${sortDirection}, id DESC
    LIMIT ?
  `).all(...params, safeLimit);
  return rows.map(mapVideo);
}

function attachSnapshotGrowth(video) {
  const snapshots = db.prepare(`
    SELECT captured_at, like_count, favorite_count, comment_count, share_count
    FROM metric_snapshots WHERE video_id = ? ORDER BY captured_at DESC LIMIT 2
  `).all(video.id);
  if (snapshots.length < 2) return { ...video, snapshotCount: snapshots.length, growth: null };
  const [latest, previous] = snapshots;
  return {
    ...video,
    snapshotCount: snapshots.length,
    growth: {
      from: previous.captured_at,
      to: latest.captured_at,
      likes: (latest.like_count ?? 0) - (previous.like_count ?? 0),
      favorites: (latest.favorite_count ?? 0) - (previous.favorite_count ?? 0),
      comments: (latest.comment_count ?? 0) - (previous.comment_count ?? 0),
      shares: (latest.share_count ?? 0) - (previous.share_count ?? 0)
    }
  };
}

export function getMaterials({
  platform,
  productGroup = 'all',
  aiType = 'all',
  contentIntent = 'all',
  brand = 'all',
  aiEvidence = 'all',
  quality = 'all',
  queryTerms = [],
  search = '',
  sort = 'lastCollectedAt',
  direction = 'desc',
  limit = 500
}) {
  const clauses = ['platform = ?'];
  const params = [platform];
  if (productGroup !== 'all') { clauses.push('product_group = ?'); params.push(productGroup); }
  if (aiType !== 'all') { clauses.push('ai_type = ?'); params.push(aiType); }
  if (contentIntent !== 'all') { clauses.push('content_intent = ?'); params.push(contentIntent); }
  if (brand !== 'all') { clauses.push('brand_name = ?'); params.push(brand); }
  if (aiEvidence === 'verified') clauses.push("COALESCE(json_extract(raw_metrics_json, '$.aiEvidenceVerified'), json_extract(raw_metrics_json, '$.detailAiDeclarationVerified'), 0) = 1");
  if (aiEvidence === 'pending') clauses.push("COALESCE(json_extract(raw_metrics_json, '$.aiEvidenceVerified'), json_extract(raw_metrics_json, '$.detailAiDeclarationVerified'), 0) != 1");
  if (quality !== 'all') { clauses.push('material_status = ?'); params.push(quality); }
  const scopedTerms = [...new Set((Array.isArray(queryTerms) ? queryTerms : [])
    .map((term) => String(term || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))].slice(0, 40);
  if (scopedTerms.length) {
    const placeholders = scopedTerms.map(() => '?').join(', ');
    clauses.push(`(
      json_extract(raw_metrics_json, '$.querySearchTerm') IN (${placeholders})
      OR EXISTS (
        SELECT 1 FROM json_each(COALESCE(json_extract(raw_metrics_json, '$.querySearchTerms'), '[]')) AS search_term
        WHERE search_term.value IN (${placeholders})
      )
    )`);
    params.push(...scopedTerms, ...scopedTerms);
  }
  if (String(search).trim()) {
    const keyword = `%${String(search).trim()}%`;
    clauses.push('(title LIKE ? OR author_name LIKE ? OR product_name LIKE ? OR brand_name LIKE ?)');
    params.push(keyword, keyword, keyword, keyword);
  }
  const sortColumn = sortColumns[sort] || 'last_collected_at';
  const sortDirection = direction === 'asc' ? 'ASC' : 'DESC';
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const rows = db.prepare(`
    SELECT * FROM videos
    WHERE ${clauses.join(' AND ')}
    ORDER BY ${sortColumn} IS NULL ASC, ${sortColumn} ${sortDirection}, id DESC
    LIMIT ?
  `).all(...params, safeLimit);
  let materials = rows.map(mapVideo).map(attachSnapshotGrowth);
  if (['favoriteLikeRate', 'commentLikeRate', 'shareLikeRate'].includes(sort)) {
    const factor = direction === 'asc' ? 1 : -1;
    materials = materials.sort((a, b) => factor * ((a[sort] ?? -1) - (b[sort] ?? -1)));
  }
  return materials;
}

export function getMaterialFacets(platform, aiEvidence = 'all', queryTerms = []) {
  const proofClause = aiEvidence === 'verified'
    ? "AND COALESCE(json_extract(raw_metrics_json, '$.aiEvidenceVerified'), json_extract(raw_metrics_json, '$.detailAiDeclarationVerified'), 0) = 1"
    : aiEvidence === 'pending'
      ? "AND COALESCE(json_extract(raw_metrics_json, '$.aiEvidenceVerified'), json_extract(raw_metrics_json, '$.detailAiDeclarationVerified'), 0) != 1"
      : '';
  const scopedTerms = [...new Set((Array.isArray(queryTerms) ? queryTerms : [])
    .map((term) => String(term || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))].slice(0, 40);
  const placeholders = scopedTerms.map(() => '?').join(', ');
  const scopeClause = scopedTerms.length ? `AND (
    json_extract(raw_metrics_json, '$.querySearchTerm') IN (${placeholders})
    OR EXISTS (
      SELECT 1 FROM json_each(COALESCE(json_extract(raw_metrics_json, '$.querySearchTerms'), '[]')) AS search_term
      WHERE search_term.value IN (${placeholders})
    )
  )` : '';
  const scopeParams = scopedTerms.length ? [...scopedTerms, ...scopedTerms] : [];
  const facet = (column, extra = '') => db.prepare(`
    SELECT ${column} AS value, COUNT(*) AS count
    FROM videos WHERE platform = ? ${proofClause} ${scopeClause} ${extra}
    GROUP BY ${column} ORDER BY count DESC, value ASC
  `).all(platform, ...scopeParams);
  return {
    products: facet('product_group'),
    aiTypes: facet('ai_type'),
    contentIntents: facet('content_intent'),
    brands: facet('brand_name', 'AND brand_name IS NOT NULL'),
    formats: facet('creative_format', 'AND creative_format IS NOT NULL'),
    hooks: facet('hook_type', 'AND hook_type IS NOT NULL')
  };
}

export function getRecentSearchTerms(platform, limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 40);
  return db.prepare(`
    SELECT
      TRIM(json_extract(raw_metrics_json, '$.querySearchTerm')) AS term,
      MAX(last_collected_at) AS lastCollectedAt,
      COUNT(*) AS materialCount
    FROM videos
    WHERE platform = ?
      AND json_extract(raw_metrics_json, '$.querySearchTerm') IS NOT NULL
      AND TRIM(json_extract(raw_metrics_json, '$.querySearchTerm')) != ''
    GROUP BY term
    ORDER BY lastCollectedAt DESC, materialCount DESC, term ASC
    LIMIT ?
  `).all(platform, safeLimit);
}

export function savePlatformSearchState(platform, keywords, resultScope = 'current', options = {}) {
  const normalizedKeywords = [...new Set((Array.isArray(keywords) ? keywords : [])
    .map((keyword) => String(keyword || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))].slice(0, 40);
  const state = {
    keywords: normalizedKeywords,
    resultScope: resultScope === 'history' ? 'history' : 'current',
    ...(typeof options.requireAiEvidence === 'boolean' ? { requireAiEvidence: options.requireAiEvidence } : {}),
    ...(typeof options.timeRange === 'string' ? { timeRange: options.timeRange } : {}),
    ...(typeof options.jobId === 'string' ? { jobId: options.jobId } : {}),
    updatedAt: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `).run(`search_state:${platform}`, JSON.stringify(state));
  return state;
}

export function getPlatformSearchState(platform) {
  const value = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(`search_state:${platform}`)?.setting_value;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const keywords = [...new Set((Array.isArray(parsed?.keywords) ? parsed.keywords : [])
      .map((keyword) => String(keyword || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean))].slice(0, 40);
    return {
      keywords,
      resultScope: parsed?.resultScope === 'history' ? 'history' : 'current',
      ...(typeof parsed?.requireAiEvidence === 'boolean' ? { requireAiEvidence: parsed.requireAiEvidence } : {}),
      ...(typeof parsed?.timeRange === 'string' ? { timeRange: parsed.timeRange } : {}),
      ...(typeof parsed?.jobId === 'string' ? { jobId: parsed.jobId } : {}),
      updatedAt: parsed?.updatedAt || null
    };
  } catch {
    return null;
  }
}

export function getCategoryRankings({ platform, productGroup = 'all', limitPerGroup = 20, sort = 'marketingScore' }) {
  const groups = new Map();
  const materials = getMaterials({ platform, productGroup, aiEvidence: 'verified', quality: 'ready', sort, direction: 'desc', limit: 2000 })
    .filter((material) => material.productGroup !== '未分类');
  for (const material of materials) {
    groups.set(material.productGroup, [...(groups.get(material.productGroup) || []), material]);
  }
  const safeLimit = Math.min(Math.max(Number(limitPerGroup) || 20, 5), 50);
  return [...groups.entries()].map(([group, items]) => ({
    group,
    total: items.length,
    videos: items.slice(0, safeLimit).map((video, index) => ({ ...video, categoryRank: index + 1 }))
  })).sort((a, b) => b.total - a.total || a.group.localeCompare(b.group, 'zh-CN'));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? Math.round((valid.reduce((sum, value) => sum + value, 0) / valid.length) * 10) / 10 : null;
}

export function getMarketingAnalysis(platform) {
  const candidates = getMaterials({ platform, limit: 2000, sort: 'marketingScore', direction: 'desc' });
  const materials = candidates.filter((item) => item.aiProof.verified && item.metricQuality.verified && item.productGroup !== '未分类');
  const grouped = (key) => {
    const map = new Map();
    for (const item of materials) {
      const label = item[key] || '未识别';
      const bucket = map.get(label) || [];
      bucket.push(item);
      map.set(label, bucket);
    }
    return [...map.entries()].map(([label, items]) => ({
      label,
      count: items.length,
      avgLikes: Math.round(average(items.map((item) => item.likeCount)) || 0),
      avgMarketingScore: average(items.map((item) => item.marketingScore)),
      avgFavoriteLikeRate: average(items.map((item) => item.favoriteLikeRate)),
      avgShareLikeRate: average(items.map((item) => item.shareLikeRate))
    })).sort((a, b) => b.count - a.count || (b.avgMarketingScore || 0) - (a.avgMarketingScore || 0));
  };
  const latestJob = db.prepare('SELECT * FROM collection_jobs WHERE platform = ? ORDER BY created_at DESC LIMIT 1').get(platform);
  return {
    summary: {
      materials: materials.length,
      aiVerified: materials.filter((item) => item.aiProof.verified).length,
      metricsReady: materials.filter((item) => item.metricQuality.verified).length,
      brands: new Set(materials.map((item) => item.brandName).filter(Boolean)).size,
      categories: new Set(materials.map((item) => item.productGroup).filter(Boolean)).size,
      avgMarketingScore: average(materials.map((item) => item.marketingScore)),
      avgFavoriteLikeRate: average(materials.map((item) => item.favoriteLikeRate)),
      avgShareLikeRate: average(materials.map((item) => item.shareLikeRate))
    },
    funnel: {
      searchCards: latestJob?.search_card_count || 0,
      detailAiVerified: latestJob?.ai_candidate_count || 0,
      storedCandidates: candidates.length,
      storedMaterials: materials.length,
      metricsReady: materials.filter((item) => item.metricQuality.verified).length
    },
    categories: grouped('productGroup'),
    intents: grouped('contentIntent'),
    formats: grouped('creativeFormat'),
    hooks: grouped('hookType'),
    audiences: grouped('targetAudience'),
    opportunities: materials.slice(0, 12)
  };
}

export function getMaterialCounts() {
  const result = { douyin: 0, xiaohongshu: 0, channels: 0 };
  for (const row of db.prepare("SELECT platform, COUNT(*) AS count FROM videos WHERE COALESCE(json_extract(raw_metrics_json, '$.aiEvidenceVerified'), json_extract(raw_metrics_json, '$.detailAiDeclarationVerified'), 0) = 1 GROUP BY platform").all()) {
    result[row.platform] = row.count;
  }
  return result;
}

export function getCandidateCounts() {
  const result = { douyin: 0, xiaohongshu: 0, channels: 0 };
  for (const row of db.prepare('SELECT platform, COUNT(*) AS count FROM videos GROUP BY platform').all()) {
    result[row.platform] = row.count;
  }
  return result;
}

export function getVideoById(id) {
  return mapVideo(db.prepare('SELECT * FROM videos WHERE id = ?').get(id));
}

export function getFacets(platform) {
  const products = db.prepare(`
    SELECT product_group AS value, COUNT(*) AS count
    FROM videos WHERE platform = ? AND product_group != '未分类' AND rank_position IS NOT NULL GROUP BY product_group ORDER BY count DESC, value ASC
  `).all(platform);
  const aiTypes = db.prepare(`
    SELECT ai_type AS value, COUNT(*) AS count
    FROM videos WHERE platform = ? AND product_group != '未分类' AND rank_position IS NOT NULL GROUP BY ai_type ORDER BY count DESC, value ASC
  `).all(platform);
  const contentIntents = db.prepare(`
    SELECT content_intent AS value, COUNT(*) AS count
    FROM videos WHERE platform = ? AND product_group != '未分类' AND rank_position IS NOT NULL GROUP BY content_intent ORDER BY count DESC, value ASC
  `).all(platform);
  const brands = db.prepare(`
    SELECT brand_name AS value, COUNT(*) AS count
    FROM videos WHERE platform = ? AND brand_name IS NOT NULL AND rank_position IS NOT NULL GROUP BY brand_name ORDER BY count DESC, value ASC
  `).all(platform);
  return { products, aiTypes, contentIntents, brands };
}

export function getPlatformCounts() {
  const result = { douyin: 0, xiaohongshu: 0, channels: 0 };
  for (const row of db.prepare("SELECT platform, COUNT(*) AS count FROM videos WHERE product_group != '未分类' AND rank_position IS NOT NULL GROUP BY platform").all()) {
    result[row.platform] = row.count;
  }
  return result;
}

export function getPendingCounts() {
  const result = { douyin: 0, xiaohongshu: 0, channels: 0 };
  for (const row of db.prepare('SELECT platform, COUNT(*) AS count FROM pending_candidates GROUP BY platform').all()) {
    result[row.platform] = row.count;
  }
  return result;
}

export function upsertPendingCandidate(candidate, reason) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pending_candidates(platform, source_url, title, reason, payload_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, source_url) DO UPDATE SET
      title = excluded.title,
      reason = excluded.reason,
      payload_json = excluded.payload_json,
      retry_count = pending_candidates.retry_count + 1,
      last_seen_at = excluded.last_seen_at
  `).run(
    candidate.platform,
    candidate.sourceUrl,
    String(candidate.title || '未命名视频').slice(0, 500),
    String(reason || '指标待补采').slice(0, 500),
    JSON.stringify(candidate),
    now,
    now
  );
}

export function resolvePendingCandidate(platform, sourceUrl) {
  db.prepare('DELETE FROM pending_candidates WHERE platform = ? AND source_url = ?').run(platform, sourceUrl);
}

export function quarantineInvalidDouyinLeaderboard() {
  const rows = db.prepare(`
    SELECT id, source_url, title, like_count, favorite_count, comment_count, share_count, raw_metrics_json
    FROM videos WHERE platform = 'douyin' AND rank_position IS NOT NULL
  `).all();
  const clear = db.prepare('UPDATE videos SET rank_position = NULL, ranking_score = NULL, popularity_score = NULL, system_heat = NULL WHERE id = ?');
  let quarantined = 0;
  for (const row of rows) {
    const rawMetrics = JSON.parse(row.raw_metrics_json || '{}');
    const valid = rawMetrics.searchFilterVerified === true && rawMetrics.metricsVerified === true &&
      row.like_count > 0 && [row.favorite_count, row.comment_count, row.share_count].every((value) => Number.isFinite(value) && value >= 0);
    if (valid) continue;
    upsertPendingCandidate({
      platform: 'douyin', sourceUrl: row.source_url, title: row.title,
      likeCount: row.like_count, favoriteCount: row.favorite_count,
      commentCount: row.comment_count, shareCount: row.share_count, rawMetrics
    }, '历史榜单不符合严格热榜指标门槛');
    clear.run(row.id);
    quarantined += 1;
  }
  return quarantined;
}

export function upsertVideo(video) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id, raw_metrics_json FROM videos WHERE platform = ? AND source_url = ?').get(video.platform, video.sourceUrl);
  const previousRawMetrics = existing ? JSON.parse(existing.raw_metrics_json || '{}') : {};
  const mergedRawMetrics = {
    ...previousRawMetrics,
    ...(video.rawMetrics || {})
  };
  const searchTerms = [...new Set([
    ...(Array.isArray(previousRawMetrics.querySearchTerms) ? previousRawMetrics.querySearchTerms : []),
    previousRawMetrics.querySearchTerm,
    ...(Array.isArray(video.rawMetrics?.querySearchTerms) ? video.rawMetrics.querySearchTerms : []),
    video.rawMetrics?.querySearchTerm
  ].map((term) => String(term || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (searchTerms.length) mergedRawMetrics.querySearchTerms = searchTerms.slice(-80);
  if (!mergedRawMetrics.mediaUrl && previousRawMetrics.mediaUrl) mergedRawMetrics.mediaUrl = previousRawMetrics.mediaUrl;
  const values = {
    ...video,
    title: String(video.title || '未命名视频').slice(0, 500),
    authorName: video.authorName ? String(video.authorName).slice(0, 200) : null,
    rawMetricsJson: JSON.stringify(mergedRawMetrics)
  };

  let id;
  let added = false;
  if (existing) {
    id = existing.id;
    db.prepare(`
      UPDATE videos SET
        platform_item_id = COALESCE(?, platform_item_id),
        title = ?, author_name = COALESCE(?, author_name), published_at = COALESCE(?, published_at),
        product_group = ?, product_name = ?, brand_name = ?, content_intent = ?, intent_confidence = ?, intent_evidence = ?,
        performance_label = ?, material_status = ?, creative_format = ?, hook_type = ?, cta_type = ?,
        target_audience = ?, selling_points = ?, marketing_score = ?,
        ai_type = ?, ai_confidence = ?, ai_evidence = ?,
        relevance_score = ?, popularity_score = ?, ranking_score = ?, rank_position = ?,
        thumbnail_url = COALESCE(?, thumbnail_url),
        view_count = COALESCE(?, view_count), like_count = COALESCE(?, like_count),
        favorite_count = COALESCE(?, favorite_count), comment_count = COALESCE(?, comment_count),
        share_count = COALESCE(?, share_count), recommend_count = COALESCE(?, recommend_count),
        raw_metrics_json = ?, last_collected_at = ?
      WHERE id = ?
    `).run(
      values.platformItemId || null, values.title, values.authorName, values.publishedAt || null,
      values.productGroup, values.productName || null, values.brandName || null,
      values.contentIntent || '待判定', values.intentConfidence ?? 0.45, values.intentEvidence || null,
      values.performanceLabel || null,
      values.materialStatus || 'ready', values.creativeFormat || null, values.hookType || null, values.ctaType || null,
      values.targetAudience || null, Array.isArray(values.sellingPoints) ? values.sellingPoints.join('|') : values.sellingPoints || null,
      values.marketingScore ?? null,
      values.aiType, values.aiConfidence, values.aiEvidence || null,
      values.relevanceScore ?? null, values.popularityScore ?? null, values.rankingScore ?? null, values.rankPosition ?? null,
      values.thumbnailUrl || null,
      values.viewCount ?? null, values.likeCount ?? null, values.favoriteCount ?? null,
      values.commentCount ?? null, values.shareCount ?? null, values.recommendCount ?? null,
      values.rawMetricsJson, now, id
    );
  } else {
    const result = db.prepare(`
      INSERT INTO videos (
        platform, platform_item_id, source_url, title, author_name, published_at,
        product_group, product_name, brand_name, content_intent, intent_confidence, intent_evidence,
        performance_label, material_status, creative_format, hook_type, cta_type,
        target_audience, selling_points, marketing_score, ai_type, ai_confidence, ai_evidence,
        relevance_score, popularity_score, ranking_score, rank_position, thumbnail_url,
        view_count, like_count, favorite_count, comment_count, share_count, recommend_count,
        raw_metrics_json, first_collected_at, last_collected_at
      ) VALUES (${Array.from({ length: 37 }, () => '?').join(', ')})
    `).run(
      values.platform, values.platformItemId || null, values.sourceUrl, values.title, values.authorName,
      values.publishedAt || null, values.productGroup, values.productName || null, values.brandName || null,
      values.contentIntent || '待判定', values.intentConfidence ?? 0.45, values.intentEvidence || null,
      values.performanceLabel || null,
      values.materialStatus || 'ready', values.creativeFormat || null, values.hookType || null, values.ctaType || null,
      values.targetAudience || null, Array.isArray(values.sellingPoints) ? values.sellingPoints.join('|') : values.sellingPoints || null,
      values.marketingScore ?? null,
      values.aiType, values.aiConfidence, values.aiEvidence || null,
      values.relevanceScore ?? null, values.popularityScore ?? null, values.rankingScore ?? null, values.rankPosition ?? null,
      values.thumbnailUrl || null,
      values.viewCount ?? null, values.likeCount ?? null, values.favoriteCount ?? null,
      values.commentCount ?? null, values.shareCount ?? null, values.recommendCount ?? null,
      values.rawMetricsJson, now, now
    );
    id = Number(result.lastInsertRowid);
    added = true;
  }

  db.prepare(`
    INSERT INTO metric_snapshots (
      video_id, captured_at, view_count, like_count, favorite_count,
      comment_count, share_count, recommend_count, raw_metrics_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, values.viewCount ?? null, values.likeCount ?? null, values.favoriteCount ?? null,
    values.commentCount ?? null, values.shareCount ?? null, values.recommendCount ?? null,
    values.rawMetricsJson
  );
  return { id, added };
}

export function clearPlatformRanking(platform) {
  db.prepare('UPDATE videos SET rank_position = NULL, ranking_score = NULL WHERE platform = ?').run(platform);
}

function percentile(value, values) {
  if (value === null || value === undefined || values.length <= 1) return values.length === 1 ? 100 : null;
  const lower = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return ((lower + Math.max(equal - 1, 0) / 2) / (values.length - 1)) * 100;
}

export function recomputeSystemHeat(platform) {
  if (platform === 'channels') return;
  const rows = db.prepare(`
    SELECT id, view_count, like_count, favorite_count, comment_count, share_count
    FROM videos WHERE platform = ? AND rank_position IS NOT NULL
  `).all(platform);
  const weights = platform === 'xiaohongshu'
    ? { like_count: 0.30, favorite_count: 0.40, comment_count: 0.15, share_count: 0.15 }
    : { like_count: 0.45, favorite_count: 0.25, comment_count: 0.15, share_count: 0.15 };
  const distributions = {};
  for (const key of Object.keys(weights)) {
    distributions[key] = rows.map((row) => row[key]).filter((value) => value !== null && value !== undefined);
  }
  const update = db.prepare('UPDATE videos SET system_heat = ? WHERE id = ?');
  for (const row of rows) {
    let weightedScore = 0;
    let usedWeight = 0;
    for (const [key, weight] of Object.entries(weights)) {
      const score = percentile(row[key], distributions[key]);
      if (score !== null) {
        weightedScore += score * weight;
        usedWeight += weight;
      }
    }
    const heat = usedWeight ? Math.round((weightedScore / usedWeight) * 10) / 10 : null;
    update.run(heat, row.id);
  }
}

export function createJob(job) {
  const now = new Date().toISOString();
  const settings = {
    keywords: [...new Set((Array.isArray(job.settings?.keywords) ? job.settings.keywords : []).map((keyword) => String(keyword || '').trim()).filter(Boolean))].slice(0, 40),
    requireAiEvidence: typeof job.settings?.requireAiEvidence === 'boolean' ? job.settings.requireAiEvidence : null,
    timeRange: typeof job.settings?.timeRange === 'string' ? job.settings.timeRange : null
  };
  db.prepare(`
    INSERT INTO collection_jobs(id, platform, status, phase, message, progress, created_at, settings_json)
    VALUES (?, ?, 'queued', 'queued', '任务已排队', 0, ?, ?)
  `).run(job.id, job.platform, now, JSON.stringify(settings));
  return getJob(job.id);
}

export function updateJob(id, changes) {
  const allowed = {
    status: 'status', phase: 'phase', message: 'message', progress: 'progress',
    scannedCount: 'scanned_count', searchCardCount: 'search_card_count', aiCandidateCount: 'ai_candidate_count',
    addedCount: 'added_count', updatedCount: 'updated_count',
    failedCount: 'failed_count', startedAt: 'started_at', finishedAt: 'finished_at',
    errorSummary: 'error_summary', collectionDiagnostics: 'diagnostics_json'
  };
  const entries = Object.entries(changes).filter(([key]) => allowed[key]);
  if (!entries.length) return getJob(id);
  const setClause = entries.map(([key]) => `${allowed[key]} = ?`).join(', ');
  db.prepare(`UPDATE collection_jobs SET ${setClause} WHERE id = ?`).run(...entries.map(([key, value]) => key === 'collectionDiagnostics' ? JSON.stringify(value || {}) : value), id);
  return getJob(id);
}

export function getJob(id) {
  const row = db.prepare('SELECT * FROM collection_jobs WHERE id = ?').get(id);
  return row ? mapJob(row) : null;
}

export function getRecentJobs(limit = 20) {
  return db.prepare('SELECT * FROM collection_jobs ORDER BY created_at DESC LIMIT ?').all(Math.min(Number(limit) || 20, 100)).map(mapJob);
}

export function failInterruptedJobs() {
  const now = new Date().toISOString();
  return db.prepare(`
    UPDATE collection_jobs
    SET status = 'failed',
        phase = 'failed',
        message = '上次采集因服务重启而中断，请重新点击采集。',
        finished_at = ?,
        error_summary = '服务重启导致任务中断'
    WHERE status IN ('queued', 'running')
  `).run(now).changes;
}

function mapJob(row) {
  const settings = JSON.parse(row.settings_json || '{}');
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    phase: row.phase,
    message: row.message,
    progress: row.progress,
    scannedCount: row.scanned_count,
    searchCardCount: row.search_card_count,
    aiCandidateCount: row.ai_candidate_count,
    addedCount: row.added_count,
    updatedCount: row.updated_count,
    failedCount: row.failed_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    errorSummary: row.error_summary,
    keywords: Array.isArray(settings.keywords) ? settings.keywords : [],
    requireAiEvidence: typeof settings.requireAiEvidence === 'boolean' ? settings.requireAiEvidence : null,
    timeRange: typeof settings.timeRange === 'string' ? settings.timeRange : null,
    collectionDiagnostics: JSON.parse(row.diagnostics_json || '{}')
  };
}

export function getKeywordGroups() {
  const rows = db.prepare('SELECT group_name, keyword, enabled FROM keyword_groups ORDER BY group_name, id').all();
  const groups = {};
  for (const row of rows) {
    groups[row.group_name] ||= [];
    groups[row.group_name].push({ keyword: row.keyword, enabled: Boolean(row.enabled) });
  }
  return groups;
}

export function replaceKeywordGroups(groups) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM keyword_groups');
    const insert = db.prepare('INSERT INTO keyword_groups(group_name, keyword, enabled) VALUES (?, ?, ?)');
    for (const [groupName, keywords] of Object.entries(groups)) {
      for (const entry of keywords) {
        const keyword = typeof entry === 'string' ? entry : entry.keyword;
        const enabled = typeof entry === 'string' ? true : entry.enabled !== false;
        if (keyword?.trim()) insert.run(groupName.trim(), keyword.trim(), enabled ? 1 : 0);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getKeywordGroups();
}

export function updateRightsStatus(id, rightsStatus) {
  db.prepare('UPDATE videos SET rights_status = ? WHERE id = ?').run(rightsStatus, id);
  return getVideoById(id);
}

export function updateMediaStatus(id, { mediaStatus, mediaPath = null }) {
  db.prepare('UPDATE videos SET media_status = ?, media_path = ? WHERE id = ?').run(mediaStatus, mediaPath, id);
  return getVideoById(id);
}

export { databasePath, projectDir };
