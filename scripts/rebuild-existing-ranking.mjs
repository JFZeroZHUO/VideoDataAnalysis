import {
  clearPlatformRanking,
  db,
  getKeywordGroups,
  recomputeSystemHeat,
  upsertVideo
} from '../server/db.mjs';
import { rankCandidates } from '../server/ranking.mjs';

const keywordGroups = getKeywordGroups();
const platforms = ['douyin', 'xiaohongshu', 'channels'];
const summary = {};

for (const platform of platforms) {
  const rows = db.prepare('SELECT * FROM videos WHERE platform = ?').all(platform);
  const candidates = rows.map((row) => {
    const rawMetrics = JSON.parse(row.raw_metrics_json || '{}');
    return {
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
      rawMetrics,
      rawText: rawMetrics.sourceText || ''
    };
  });
  const ranked = rankCandidates(candidates, keywordGroups, 20);
  clearPlatformRanking(platform);
  for (const candidate of ranked) upsertVideo(candidate);
  recomputeSystemHeat(platform);
  summary[platform] = { candidates: candidates.length, qualified: ranked.length };
}

console.log(JSON.stringify(summary));
