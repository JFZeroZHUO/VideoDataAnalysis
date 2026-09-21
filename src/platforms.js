export const PLATFORM_CONFIG = {
  douyin: {
    name: '抖音',
    short: 'DY',
    mode: '公开搜索',
    description: '严格按搜索队列中的原始关键词逐词召回，不自动补词或改词；再按最多点赞筛选，可选详情页AI声明核验。',
    unavailableMetrics: ['viewCount'],
    metrics: [
      { key: 'viewCount', label: '播放量' },
      { key: 'likeCount', label: '点赞量' },
      { key: 'favoriteCount', label: '收藏量' },
      { key: 'commentCount', label: '评论量' },
      { key: 'shareCount', label: '分享量' },
      { key: 'systemHeat', label: '系统热度分', derived: true }
    ],
    defaultSort: 'rankingScore',
    accent: 'carmine'
  },
  xiaohongshu: {
    name: '小红书',
    short: 'RED',
    mode: '公开搜索',
    description: '点赞、收藏、评论、分享；没有稳定浏览量时不显示浏览列。',
    metrics: [
      { key: 'likeCount', label: '点赞量' },
      { key: 'favoriteCount', label: '收藏量' },
      { key: 'commentCount', label: '评论量' },
      { key: 'shareCount', label: '分享量' },
      { key: 'systemHeat', label: '系统热度分', derived: true }
    ],
    defaultSort: 'rankingScore',
    accent: 'vermilion'
  },
  channels: {
    name: '视频号',
    short: 'WX',
    mode: '公域最热搜索',
    description: '从微信搜一搜的全网视频号结果中，按多关键词选「最热」并逐条打开详情；不再读取自有账号作品。',
    metrics: [
      { key: 'recommendCount', label: '喜欢/推荐' },
      { key: 'shareCount', label: '分享量' },
      { key: 'likeCount', label: '点赞量' },
      { key: 'commentCount', label: '评论量' },
      { key: 'systemHeat', label: '公域热度分', derived: true }
    ],
    defaultSort: 'rankingScore',
    accent: 'jade'
  }
};

export const AI_TYPES = [
  '全 AI 生成',
  'AI 数字人',
  'AI 产品动画',
  'AI 配音',
  'AI 辅助剪辑',
  '疑似 AI'
];

export const CONTENT_INTENTS = [
  '带货转化',
  '种草测评',
  '品牌AI宣传',
  'AI引流宣传',
  '产品功能演示',
  'AI概念创意',
  '待判定'
];
