import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomSearchQueries, buildDouyinCategoryQueries, buildProductQueries } from '../server/query-builder.mjs';

const groups = {
  '奶瓶与母乳喂养': [{ keyword: '奶瓶', enabled: true }, { keyword: '吸奶器', enabled: true }],
  '纸尿裤与日常护理': [{ keyword: '纸尿裤', enabled: true }, { keyword: '隔尿垫', enabled: true }],
  '童车与出行安全': [{ keyword: '婴儿车', enabled: true }, { keyword: '儿童安全座椅', enabled: true }]
};

test('搜索矩阵同时覆盖品类词和品牌词', () => {
  const queries = buildProductQueries(groups, 20, { rotationSeed: 2 });
  assert.ok(queries.some((item) => item.groupName === '奶瓶与母乳喂养' && item.keyword));
  assert.ok(queries.some((item) => item.lane === 'brand_product' && item.brandName));
  assert.ok(queries.every((item) => item.aiTargeted === false && item.aiCue === null));
  assert.ok(queries.every((item) => !/(?:AI|AIGC|广告|宣传片|数字人)/i.test(item.query)));
});

test('搜索矩阵按轮换种子切换具体产品', () => {
  const first = buildProductQueries(groups, 8, { rotationSeed: 1 });
  const second = buildProductQueries(groups, 8, { rotationSeed: 2 });
  const firstProduct = first.find((item) => item.groupName === '奶瓶与母乳喂养' && item.lane === 'product');
  const secondProduct = second.find((item) => item.groupName === '奶瓶与母乳喂养' && item.lane === 'product');
  assert.notEqual(firstProduct.keyword, secondProduct.keyword);
});

test('产品搜索词保持原样，不追加AI宣传描述', () => {
  const queries = buildProductQueries({ '孕产与产后护理': ['防溢乳垫'] }, 10, { rotationSeed: 0 });
  assert.equal(queries.find((item) => item.lane === 'product')?.query, '防溢乳垫');
});

test('抖音只搜索宽品类词加AI，不再生成品牌或细分产品矩阵', () => {
  const queries = buildDouyinCategoryQueries(groups, 30);
  assert.deepEqual(queries.map((item) => item.query), ['奶瓶AI', '纸尿裤AI', '婴儿车AI']);
  assert.ok(queries.every((item) => item.lane === 'category_ai' && item.aiTargeted === true && item.aiCue === 'AI'));
  assert.ok(queries.every((item) => !item.brandName && !/吸奶器|隔尿垫|儿童安全座椅/.test(item.query)));
});

test('抖音宽品类矩阵不随日期轮换', () => {
  const first = buildDouyinCategoryQueries(groups, 30, { rotationSeed: 1 });
  const second = buildDouyinCategoryQueries(groups, 30, { rotationSeed: 99 });
  assert.deepEqual(first, second);
});

test('用户关键词保持输入顺序并去重，AI后缀不参与产品词匹配', () => {
  const queries = buildCustomSearchQueries(['纸尿裤AI', '贝亲奶瓶', '纸尿裤AI', '  新生儿用品  '], 40);
  assert.deepEqual(queries.map((item) => item.query), ['纸尿裤AI', '贝亲奶瓶', '新生儿用品']);
  assert.equal(queries[0].keyword, '纸尿裤');
  assert.equal(queries[0].groupName, '搜索主题 · 纸尿裤');
  assert.equal(queries[0].aiTargeted, true);
  assert.equal(queries[1].lane, 'user_keyword');
});

test('任意行业关键词均原样进入搜索队列，不追加母婴词或AI后缀', () => {
  const queries = buildCustomSearchQueries(['咖啡机', '新能源汽车', '婚礼摄影'], 40);
  assert.deepEqual(queries.map((item) => item.query), ['咖啡机', '新能源汽车', '婚礼摄影']);
  assert.ok(queries.every((item) => item.lane === 'user_keyword'));
  assert.ok(queries.every((item) => !item.query.includes('母婴')));
});
