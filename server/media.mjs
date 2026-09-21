import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getVideoById, projectDir, updateMediaStatus } from './db.mjs';

const mediaDir = path.join(projectDir, 'storage', 'videos');
fs.mkdirSync(mediaDir, { recursive: true });

export async function downloadAuthorizedMedia(id) {
  const video = getVideoById(id);
  if (!video) {
    const error = new Error('视频记录不存在。');
    error.status = 404;
    throw error;
  }
  if (video.rightsStatus !== 'authorized') {
    const error = new Error('请先确认你拥有下载或保存该视频的权限。');
    error.status = 403;
    throw error;
  }
  if (video.mediaPath && fs.existsSync(video.mediaPath)) return video;
  const mediaUrl = video.rawMetrics?.mediaUrl;
  if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
    const error = new Error('本次采集没有识别到可下载的媒体地址，请使用原视频链接或重新采集。');
    error.status = 422;
    throw error;
  }

  updateMediaStatus(id, { mediaStatus: 'downloading' });
  const response = await fetch(mediaUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      Referer: video.sourceUrl
    },
    redirect: 'follow'
  });
  if (!response.ok || !response.body) {
    updateMediaStatus(id, { mediaStatus: 'failed' });
    const error = new Error(`媒体下载失败（${response.status}），地址可能已经过期。`);
    error.status = 502;
    throw error;
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('video') && !contentType.includes('octet-stream')) {
    updateMediaStatus(id, { mediaStatus: 'failed' });
    const error = new Error('媒体地址返回的不是视频文件。');
    error.status = 422;
    throw error;
  }
  const maxBytes = 250 * 1024 * 1024;
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) {
    updateMediaStatus(id, { mediaStatus: 'failed' });
    const error = new Error('视频超过 250MB 的本地保存上限。');
    error.status = 413;
    throw error;
  }

  const filename = `${video.platform}-${crypto.createHash('sha1').update(video.sourceUrl).digest('hex').slice(0, 18)}.mp4`;
  const targetPath = path.join(mediaDir, filename);
  const tempPath = `${targetPath}.part`;
  const file = fs.createWriteStream(tempPath, { flags: 'w' });
  let written = 0;
  try {
    for await (const chunk of response.body) {
      written += chunk.length;
      if (written > maxBytes) throw new Error('视频超过 250MB 的本地保存上限。');
      if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve));
    }
    await new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve()));
    fs.renameSync(tempPath, targetPath);
    return updateMediaStatus(id, { mediaStatus: 'downloaded', mediaPath: targetPath });
  } catch (error) {
    file.destroy();
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    updateMediaStatus(id, { mediaStatus: 'failed' });
    throw error;
  }
}
