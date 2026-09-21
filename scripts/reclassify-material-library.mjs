import { db, getKeywordGroups, upsertVideo } from '../server/db.mjs';
import { analyzeCandidate } from '../server/ranking.mjs';

const groups = getKeywordGroups();
const rows = db.prepare('SELECT * FROM videos ORDER BY id').all();
let updated = 0;

for (const row of rows) {
  const rawMetrics = JSON.parse(row.raw_metrics_json || '{}');
  const candidate = {
    platform: row.platform,
    platformItemId: row.platform_item_id,
    sourceUrl: row.source_url,
    title: row.title,
    authorName: row.author_name,
    publishedAt: row.published_at,
    thumbnailUrl: row.thumbnail_url,
    viewCount: row.view_count,
    likeCount: row.like_count,
    favoriteCount: row.favorite_count,
    commentCount: row.comment_count,
    shareCount: row.share_count,
    recommendCount: row.recommend_count,
    platformAiBadge: rawMetrics.detailAiDeclarationVerified === true,
    platformAiLabel: rawMetrics.platformAiLabel || null,
    aiDeclared: rawMetrics.detailAiDeclarationVerified === true,
    rawText: rawMetrics.sourceText || '',
    rawMetrics,
    queryKeyword: rawMetrics.queryKeyword || null,
    queryGroup: rawMetrics.queryGroup || null,
    rankPosition: row.rank_position,
    rankingScore: row.ranking_score,
    popularityScore: row.popularity_score,
    performanceLabel: row.performance_label
  };
  const analyzed = analyzeCandidate(candidate, groups);
  upsertVideo({
    ...analyzed,
    rankPosition: row.rank_position,
    rankingScore: row.ranking_score,
    popularityScore: row.popularity_score,
    performanceLabel: row.performance_label
  });
  updated += 1;
}

console.log(`已重新校准 ${updated} 条素材。`);
