# 在线界面与本机扩展协议（版本 1）

网站只发布静态界面及请求级 DeepSeek 转发接口。所有素材、任务、搜索状态均存于扩展 IndexedDB；不设云数据库。保留旧的本机 Node 版本，不将其无鉴权 API 暴露到公网。

## 网页桥接

网站通过当前页面 postMessage 发送 `{channel:'video-data-analysis', direction:'request', id, action:'request', url, method, body}`。
安装扩展后，用户在扩展弹出页明确授权当前 HTTPS 网站（本地测试可为 http://127.0.0.1:4318）。只有被授权的精确 origin 可注入 bridge.js；bridge 核对 source===window 和 origin，通过 runtime.sendMessage 将请求交给扩展。
扩展再次核验 sender.url 的 origin 是否已授权。响应为 `{channel:'video-data-analysis',direction:'response',id,ok,data}` 或 `{...,ok:false,error:{message,status,code}}`。网页超时应显示安装/授权提示，不能悄悄访问 localhost。

## 本地服务接口

保留现有 UI 路径：GET /api/meta、/api/materials、/api/category-rankings、/api/analysis、/api/jobs、/api/jobs/:id；POST /api/collect/douyin。
数据形状兼容当前 ResearchWorkspace。普通模式 requireAiEvidence=false 不强制AI或完整指标；不自动加词，不限定母婴。
扩展 service 模块导出 `createLocalService({store,runTask,version})`，返回 `request(url,{method,body})`。
store 模块导出 `createLocalStore()`；接口为 `get(key),set(key,value),remove(key)`，原子保存每个键；业务状态由 service 串行写入。
`runTask(task,hooks)` 在接受任务后异步运行；task 含 id,jobId,platform:'douyin',keywords,queries,maxResults,topN,timeRange,requireAiEvidence；queries 为 {query,keyword} 原词数组。
hooks: `progress(patch)` 更新任务；`batch(candidates)` 验证、去重并增量入库；`complete()`；`fail(message)`。
worker 重启：旧 running 任务标记 interrupted/failed，保留已入库素材，用户可原词重试；不声称能在任意 DOM 步骤自动恢复。

补充：GET /api/local/backup => 仅素材与搜索设置的 schemaVersion:1 备份（不含密钥、Cookie、运行任务）；POST /api/local/restore body {backup} => 校验并合并；GET /api/export/materials.csv => {csv}。
GET /api/local/attention => 当前等待登录/验证码任务；POST /api/local/open-douyin => 激活当前任务的抖音标签或打开官方首页。
不支持的路由明确返回 404/501；没有公开指标保持 null，不编造零。

## 边界

DeepSeek /api/deepseek/* 由 Vercel 转发，仅使用本次页面提供的个人 Key，不从云端环境读取站主 Key。素材备份不含 DeepSeek Key。
扩展只授权抖音和用户手动授权的网站，不申请 Cookie、所有站点、debugger 权限。任何网页消息都不能任意执行脚本、读文件或发起任意 URL 请求。
首版在线模式只支持抖音公开素材记录；本地视频通过用户手动选择文件预览，不提供绕过平台限制的下载。
