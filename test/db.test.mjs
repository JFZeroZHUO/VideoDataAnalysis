import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('数据库完成去重、筛选和平台内热度计算', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maternal-radar-'));
  const databasePath = path.join(tempDir, 'test.db');
  process.env.MATERNAL_RADAR_DB = databasePath;
  const database = await import(`../server/db.mjs?test=${Date.now()}`);

  const common = {
    platform: 'douyin',
    authorName: '测试作者',
    productGroup: '喂养',
    aiType: 'AI 产品动画',
    aiConfidence: 0.9,
    rawMetrics: {}
  };
  const first = database.upsertVideo({
    ...common,
    sourceUrl: 'https://example.com/video/1',
    title: '奶瓶动画一',
    viewCount: 1000,
    likeCount: 100,
    commentCount: 10,
    shareCount: 5
    ,rankPosition: 2
  });
  database.upsertVideo({
    ...common,
    rawMetrics: { detailAiDeclarationVerified: true, metricsVerified: true },
    sourceUrl: 'https://example.com/video/2',
    title: '奶瓶动画二',
    viewCount: 5000,
    likeCount: 800,
    commentCount: 60,
    shareCount: 35
    ,rankPosition: 1
  });
  const duplicate = database.upsertVideo({
    ...common,
    sourceUrl: 'https://example.com/video/1',
    title: '奶瓶动画一（更新）',
    viewCount: 1500,
    likeCount: 150,
    commentCount: 15,
    shareCount: 8
    ,rankPosition: 2
  });

  assert.equal(first.added, true);
  assert.equal(duplicate.added, false);
  database.recomputeSystemHeat('douyin');
  const videos = database.getVideos({ platform: 'douyin', sort: 'systemHeat', direction: 'desc' });
  assert.equal(videos.length, 2);
  assert.equal(videos[0].title, '奶瓶动画二');
  assert.ok(videos[0].systemHeat > videos[1].systemHeat);
  assert.equal(database.getFacets('douyin').products[0].value, '喂养');
  assert.equal(database.getMaterials({ platform: 'douyin', aiEvidence: 'verified' }).length, 1);
  assert.equal(database.getMaterials({ platform: 'douyin', aiEvidence: 'pending' }).length, 1);
  assert.equal(database.getMaterialCounts().douyin, 1);
  assert.equal(database.getCategoryRankings({ platform: 'douyin', limitPerGroup: 20 }).length, 1);

  const scopedVideo = {
    ...common,
    sourceUrl: 'https://example.com/video/scoped',
    title: 'AI视频工作流爆款案例',
    rawMetrics: { detailAiDeclarationVerified: true, metricsVerified: true, querySearchTerm: 'AI视频' },
    likeCount: 2600,
    favoriteCount: 140,
    commentCount: 38,
    shareCount: 66
  };
  database.upsertVideo(scopedVideo);
  database.upsertVideo({ ...scopedVideo, rawMetrics: { ...scopedVideo.rawMetrics, querySearchTerm: 'AIGC短片' } });
  database.upsertVideo({
    ...common,
    sourceUrl: 'https://example.com/video/diaper-history',
    title: '纸尿裤历史素材',
    rawMetrics: { detailAiDeclarationVerified: true, metricsVerified: true, querySearchTerm: '纸尿裤' },
    likeCount: 900
  });
  const currentKeywordMaterials = database.getMaterials({ platform: 'douyin', aiEvidence: 'verified', queryTerms: ['AI视频'] });
  assert.deepEqual(currentKeywordMaterials.map((item) => item.sourceUrl), ['https://example.com/video/scoped']);
  assert.ok(!currentKeywordMaterials.some((item) => item.title.includes('纸尿裤')));
  assert.deepEqual(
    database.getMaterialFacets('douyin', 'verified', ['AI视频']).products.map(({ value, count }) => ({ value, count })),
    [{ value: '喂养', count: 1 }]
  );
  assert.deepEqual(
    new Set(database.getRecentSearchTerms('douyin', 2).map((item) => item.term)),
    new Set(['AIGC短片', '纸尿裤'])
  );
  assert.deepEqual(
    database.savePlatformSearchState('douyin', ['AI视频', 'AI视频', ' AIGC短片 ']),
    {
      keywords: ['AI视频', 'AIGC短片'],
      resultScope: 'current',
      updatedAt: database.getPlatformSearchState('douyin').updatedAt
    }
  );
  assert.deepEqual(database.getPlatformSearchState('douyin').keywords, ['AI视频', 'AIGC短片']);

  database.upsertVideo({
    platform: 'channels',
    sourceUrl: 'https://channels.weixin.qq.com/platform/post/list#material-test',
    title: '奶瓶 AI 产品动画，由 AI 生成',
    productGroup: '喂养',
    productName: '奶瓶',
    aiType: '全 AI 生成',
    aiConfidence: 0.96,
    viewCount: 12000,
    likeCount: 580,
    commentCount: 46,
    shareCount: 92,
    rawMetrics: {
      aiEvidenceVerified: true,
      aiEvidenceType: 'author_disclosure',
      platformAiLabel: '由 AI 生成',
      metricsVerified: true
    }
  });
  const channelsMaterials = database.getMaterials({ platform: 'channels', aiEvidence: 'verified' });
  assert.equal(channelsMaterials.length, 1);
  assert.equal(channelsMaterials[0].aiProof.sourceType, 'author_disclosure');
  assert.equal(database.getMaterialCounts().channels, 1);

  const job = database.createJob({ id: 'job-with-stage-counts', platform: 'douyin' });
  database.updateJob(job.id, { searchCardCount: 120, aiCandidateCount: 7, scannedCount: 5 });
  const updatedJob = database.getJob(job.id);
  assert.equal(updatedJob.searchCardCount, 120);
  assert.equal(updatedJob.aiCandidateCount, 7);
  assert.equal(updatedJob.scannedCount, 5);

  database.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
