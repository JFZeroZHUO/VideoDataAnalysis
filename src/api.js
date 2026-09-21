import { EXTENSION_MODE, extensionRequest } from './extension-client.js';
const jsonHeaders = { 'Content-Type': 'application/json' };

async function request(url, options = {}) {
  if (EXTENSION_MODE && !url.startsWith('/api/deepseek/')) return extensionRequest(url, options);
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.details = payload;
    throw error;
  }
  return payload;
}

export const api = {
  localBackup: () => request('/api/local/backup'),
  localRestore: (backup) => request('/api/local/restore', { method: 'POST', body: JSON.stringify({ backup }) }),
  saveSearchState: (state) => request('/api/local/search-state', { method: 'POST', body: JSON.stringify(state) }),
  openDouyin: () => request('/api/local/open-douyin', { method: 'POST' }),
  localExportCsv: (platform) => request(`/api/export/materials.csv?${new URLSearchParams({ platform })}`),
  getMeta: () => request('/api/meta'),
  getVideos: (params) => request(`/api/videos?${new URLSearchParams(params)}`),
  getMaterials: (params) => request(`/api/materials?${new URLSearchParams(params)}`),
  getCategoryRankings: (params) => request(`/api/category-rankings?${new URLSearchParams(params)}`),
  getAnalysis: (platform) => request(`/api/analysis?${new URLSearchParams({ platform })}`),
  exportMaterialsUrl: (platform) => `/api/export/materials.csv?${new URLSearchParams({ platform })}`,
  getJob: (id) => request(`/api/jobs/${id}`),
  getRecentJobs: () => request('/api/jobs?limit=12'),
  getDeepSeekStatus: () => request('/api/deepseek/status'),
  configureDeepSeek: (apiKey, model) => request('/api/deepseek/configure', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ apiKey, model })
  }),
  suggestKeywords: (keyword, existingKeywords, credentials) => request('/api/deepseek/keyword-suggestions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ keyword, existingKeywords, ...(credentials ? { credentials } : {}) })
  }),
  startCollection: (platform, settings) => request(`/api/collect/${platform}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(settings)
  }),
  openChannelsSearch: (keyword) => request('/api/channels/open-search', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ keyword })
  }),
  setupBrowserHelper: () => request('/api/browser-helper/setup', { method: 'POST' }),
  updateVideoRights: (id, rightsStatus) => request(`/api/videos/${id}/rights`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ rightsStatus })
  }),
  downloadVideo: (id) => request(`/api/videos/${id}/download`, { method: 'POST' }),
  getKeywords: () => request('/api/keywords'),
  getRules: () => request('/api/rules'),
  saveKeywords: (groups) => request('/api/keywords', {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ groups })
  })
};
