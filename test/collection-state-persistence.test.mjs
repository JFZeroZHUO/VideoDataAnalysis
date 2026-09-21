import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('普通舞蹈素材不因缺少AI声明或详情指标被默认全部筛选隐藏，任务设置可持久化', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-state-test-'));
  const previousDb = process.env.MATERNAL_RADAR_DB;
  process.env.MATERNAL_RADAR_DB = path.join(tempDir, 'test.db');
  const database = await import(`../server/db.mjs?collection-state=${Date.now()}`);
  t.after(() => {
    database.db.close();
    if (previousDb === undefined) delete process.env.MATERNAL_RADAR_DB;
    else process.env.MATERNAL_RADAR_DB = previousDb;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  database.upsertVideo({
    platform: 'douyin',
    platformItemId: '7600000000000000001',
    sourceUrl: 'https://www.douyin.com/video/7600000000000000001',
    title: '舞蹈热门表演',
    aiType: '未核验', aiConfidence: 0,
    productGroup: '搜索主题 · 舞蹈',
    materialStatus: 'metrics_partial',
    likeCount: 5044000,
    rawMetrics: {
      querySearchTerm: '舞蹈', aiVerificationSkipped: true,
      aiEvidenceRequired: false, collectionScope: 'search_results_only'
    }
  });
  database.upsertVideo({
    platform: 'douyin',
    sourceUrl: 'https://www.douyin.com/video/7600000000000000002',
    title: '旧的纸尿裤素材', productGroup: '纸尿裤',
    aiType: 'AI产品动画', aiConfidence: 0.9,
    rawMetrics: { querySearchTerm: '纸尿裤', detailAiDeclarationVerified: true }
  });
  const filters = { platform: 'douyin', queryTerms: ['舞蹈'], aiEvidence: 'all', quality: 'all' };
  const materials = database.getMaterials(filters);
  assert.equal(materials.length, 1);
  assert.equal(materials[0].title, '舞蹈热门表演');
  assert.equal(materials[0].aiProof.verified, false);
  assert.equal(materials[0].likeCount, 5044000);
  assert.equal(materials[0].favoriteCount, null);
  assert.equal(materials[0].materialStatus, 'metrics_partial');
  assert.equal(database.getMaterials({ ...filters, aiEvidence: 'verified' }).length, 0);
  assert.equal(database.getMaterials({ ...filters, quality: 'ready' }).length, 0);

  const settings = { keywords: [' 舞蹈 ', '舞蹈'], requireAiEvidence: false, timeRange: 'half_year' };
  const job = database.createJob({ id: 'ordinary-dance', platform: 'douyin', settings });
  settings.keywords.push('不会混入已创建任务');
  assert.deepEqual(job.keywords, ['舞蹈']);
  assert.equal(job.requireAiEvidence, false);
  assert.equal(job.timeRange, 'half_year');
  const diagnostics = { searchCardCount: 127, extractedCardCount: 127, linkFailureCount: 3, collectedCount: 124, failureReasons: { missing_link: 3 } };
  database.updateJob(job.id, { status: 'completed', searchCardCount: 127, scannedCount: 124, collectionDiagnostics: diagnostics });
  assert.deepEqual(database.getJob(job.id).collectionDiagnostics, diagnostics);
  assert.deepEqual(database.getJob(job.id).keywords, ['舞蹈']);
  assert.equal(database.getJob(job.id).requireAiEvidence, false);
  assert.equal(database.createJob({ id: 'legacy-job', platform: 'douyin' }).requireAiEvidence, null);

  database.savePlatformSearchState('douyin', ['舞蹈'], 'current', { requireAiEvidence: false, timeRange: 'half_year', jobId: job.id });
  const state = database.getPlatformSearchState('douyin');
  assert.deepEqual(state.keywords, ['舞蹈']);
  assert.equal(state.requireAiEvidence, false);
  assert.equal(state.timeRange, 'half_year');
  assert.equal(state.jobId, job.id);
});
