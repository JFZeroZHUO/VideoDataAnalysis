export const DOUYIN_SEARCH_RESULT_SELECTOR = '.search-result-card, a[href*="/video/"]';

export function sourceUrlFromDouyinModalUrl(value = '') {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) ||
        !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return null;
    const videoId = url.pathname.match(/^\/video\/(\d{8,})\/?$/)?.[1] || url.searchParams.get('modal_id');
    return /^\d{8,}$/.test(videoId || '') ? `https://www.douyin.com/video/${videoId}` : null;
  } catch {
    return null;
  }
}
