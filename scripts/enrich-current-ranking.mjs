import { chromium } from 'playwright';
import { clearPlatformRanking, db, getKeywordGroups, recomputeSystemHeat, upsertVideo } from '../server/db.mjs';
import { enrichCandidateDetails } from '../server/detail-enrichment.mjs';
import { rankCandidates } from '../server/ranking.mjs';

const rows = db.prepare("SELECT * FROM videos WHERE platform = 'douyin' AND rank_position IS NOT NULL ORDER BY rank_position").all();
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

if (candidates.length) {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const detailed = await enrichCandidateDetails({ page, platform: 'douyin', candidates });
  const ranked = rankCandidates(detailed, getKeywordGroups(), 20);
  clearPlatformRanking('douyin');
  for (const candidate of ranked) upsertVideo(candidate);
  recomputeSystemHeat('douyin');
  await page.close();
  await browser.close();
  console.log(JSON.stringify({ enriched: detailed.length, qualified: ranked.length }));
} else {
  console.log(JSON.stringify({ enriched: 0, qualified: 0 }));
}
