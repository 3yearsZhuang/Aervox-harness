---
id: CR-054
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 1.0.0
updated_at: 2026-09-17
reviewed_at: 2026-09-17
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/ARCHITECTURE.md
---

# CR-054 本地模型运行时管理：GGUF 下载与 llama-server 进程生命周期

- 提出人：3yearszhuang · 2026-09-17
- 修改人：3yearszhuang · 2026-09-17

关联：[PRD](../PRD.md) · [需求追踪基线](../REQUIREMENTS_TRACEABILITY.md) · [CR-053](CR-053-llamacpp-provider-and-local-model-support.md)

- 状态：Accepted（已评审）/ Implemented（已实现）
- 提出人 / 日期：3yearszhuang / 2026-09-17
- 目标版本：R 迭代（本地模型能力补充）
- 关联能力：`CAP-002` / `CAP-020` / `CAP-033` / 基础设施（LLM 运行时）

## 1. 变更原因与证据

CR-053 已将 llama.cpp 作为**底层能力**（`llamacpp` providerType）接入推理通道与降级阶梯，
但本地模型从"可用"到"真正跑起来"仍缺最后一公里的运维环节：

- **下载**：无 GGUF 模型下载设施（多 GB 文件、进度、完整性校验、.part 原子落盘）；
- **进程**：无 llama-server 生命周期管理（spawn、健康探测、停止、崩溃留痕）；
- **联动**：启动成功与 LLM 预设（baseUrl/modelId/上下文窗口）无衔接，仍需手工配置；
- 现状要求用户自备模型文件与手动起服务，本地优先（CAP-033）体验不闭环。

## 2. 当前行为 vs 目标行为

| 维度 | 当前行为 | 目标行为（本 CR） |
| :--- | :--- | :--- |
| 模型文件获取 | 用户手工下载放入 `data/models/` | 「本地模型」设置页 URL 下载，流式进度、可选 SHA-256 校验、`.part` 原子落盘、失败/取消清理 |
| 模型注册表 | 无 | 扫描 `data/models/*.gguf` + 同名 `.json` 侧车元数据（url/sha256/downloadedAt）动态重建 |
| llama-server 进程 | 无 | 单例管理器：spawn（`-m/--port/-c/-ngl/-t/--jinja`）、`/health` 轮询就绪、SIGTERM→SIGKILL 停止、异常退出留痕纠错 |
| 二进制解析 | 用户手工 | `AERVOX_LLAMA_SERVER_PATH` 环境变量优先，否则探测 PATH 中 `llama-server` |
| 启动联动 | 无 | 启动成功自动切换 `llamacpp` 预设并回写 baseUrl / modelId / 上下文窗口（CR-053 `capabilities`） |
| 状态可视化 | 无 | `GET /v1/model-runtime/state` 全量快照；下载中/运行时 UI 轮询 |

未变更：下载语义为单任务串行队列（并发 409）；任意 URL 可下载但目标固定收敛于 `data/models/`
（已 `.gitignore`）；不做模型运行时的多租户/远程分发扩展。

## 3. 受影响范围与契约

- `packages/contracts`：新增 `model-runtime-schemas.ts`（运行时状态 / 本地模型 / 启动参数 / 下载与启动请求），
  `openapi.json` 经 `generate:openapi` 同步；
- `apps/api`：
  - `modules/ecosystem/model-runtime/`：`downloader.ts`（流式下载+校验）、`llama-server.ts`（进程管理器）、
    `service.ts`（模型扫描/下载队列/启停编排）、`routes.ts`（state/downloads/start/stop）、`index.ts`；
  - `app.ts` / `modules/context.ts`：`modelRuntimeOptions` 注入与 `ctx.modelRuntimeService` 接线，
    `onClose` 钩子终止子进程；
- `packages/api-client`：`useAervoxModelRuntime` composable 与 DTO；
- `packages/ui`：`ModelRuntimePanel.vue`（下载进度/模型选择/启动参数/启停/联动 LLM 预设），
  挂载于设置弹窗新增「本地模型」分类（`local-models`），`settingCategories` 扩展；
- 无数据库表变更（模型注册以磁盘文件 + 侧车 JSON 为真源；进程状态为内存态）。

OpenAPI（v2）：`GET /v1/model-runtime/state`（`downloads[]` / `runtime.metrics` / `llamaServer.maxConcurrentDownloads`）、
`GET /v1/model-runtime/catalog`、`GET /v1/model-runtime/events`（SSE，`event: snapshot`）、
`POST /v1/model-runtime/downloads`（多任务入队，含 `autoStart` / `rateLimitBps`）、
`POST /v1/model-runtime/downloads/{taskId}/pause|resume|cancel`、`POST /v1/model-runtime/start`、
`POST /v1/model-runtime/stop`、`DELETE /v1/model-runtime/models/{modelId}`。

## 4. CR-054 迭代增量

面向真实使用场景补足运维闭环：

- **模型删除**：`DELETE /v1/model-runtime/models/{modelId}`（运行中 409 / 不存在 404），清理 `.gguf`、侧车与 `.part`；
- **运行日志**：llama-server stderr 按行进入环形缓冲（60 条 × 800 字），`state.runtime.logs` 直出，UI 折叠查看；
- **断点续传**：`.part` 存在时携带 `Range` 从既有字节继续；206 追加写并预计算存量 SHA-256 前缀做全文件校验，
  200/416/405 回退整量覆盖；校验失败删除残片防止损坏数据续传；`download.resumableFrom` 透出续传起点；
- **下载后自动连接**：`ModelDownloadRequest.autoStart` 完成后自动拉起 llama-server 并联动 LLM 预设（无缝连接）。

### 4.2 迭代 v2（本批次，CR-054 v2）

承接 v1 补齐「多任务 + 实时」运维能力：

- **多任务下载队列**：`state.downloads[]` 取代单例下载；服务端 `maxConcurrentDownloads`（缺省 2）并发泵，
  `queued → running → done|error|cancelled|paused` 状态机；排队任务随并发释放自动推进；
- **暂停 / 恢复 / 取消（按任务）**：`POST /v1/model-runtime/downloads/{taskId}/pause|resume|cancel`；
  暂停保留 `.part` 断点、恢复经 `Range` 续传、取消清理残片；错误状态透出 `resumableFrom` / `error`；
- **限速**：`ModelDownloadRequest.rateLimitBps` 滑动窗口限速（bytes/sec）；
- **量化档位清单**：`GET /v1/model-runtime/catalog` 内置精选 GGUF 目录（Qwen2.5-7B Q4_K_M/Q8_0、
  Llama3.1-8B、Qwen3-4B，含 `quant` / `sizeLabel` / 推荐启动参数）；任意 URL 下载入口保留；
- **运行指标监控**：llama-server `/metrics` 采样 `llama_tokens_per_second` / `prompt_tokens_per_second`
  （`state.runtime.metrics` 最近 8 条，采样失败静默）；
- **SSE 实时推送**：`GET /v1/model-runtime/events`（`event: snapshot` + 心跳 + 建连即推快照；
  客户端断线回退轮询 `state`）。

「本地模型」面板（`ModelRuntimePanel.vue`）同步升级：多任务进度卡（状态徽章 / 进度条 / 暂停恢复取消）、
运行指标 chip、精选模型一键下载（预填推荐启动参数）、下载限速输入；`@aervox/api-client`
`useAervoxModelRuntime` 暴露 `getCatalog` / `pauseDownload` / `resumeDownload` / `cancelDownload(taskId)` /
`subscribeState`（fetch 流式 SSE，失败回退轮询）。

## 5. 验证与测试标准

- `apps/api/test/model-runtime-downloader.test.ts`（真实 Node http 服务）：流式进度、SHA-256 匹配/不匹配清理、
  HTTP 404 归类、网络不可达归类；
- `apps/api/test/model-runtime-llama-server.test.ts`（注入 fake spawn/fetch）：resolveBin、启动成功 running、
  健康探测超时抛错、二进制缺失、stop 幂等、进程意外退出留痕；
- `apps/api/test/model-runtime-api.test.ts`（buildApp 集成）：下载→注册→启动→停止全链路、重复下载/运行中启动的
  409 语义、模型缺失 400；v2 新增多任务并发（缺省 2＋排队）、暂停/恢复/取消 `.part` 语义、限速参数闭环、
  精选目录、SSE 实时推送（真实端口监听 + 帧断言）共 9 项；
- `packages/api-client/test/model-runtime.test.ts`：端点映射与 DTO 透传；
- `packages/ui`：既有 71 项全量通过（SettingsModal 挂载新面板无回归）；
- 门禁：`./aervox ci all` 全量终审（code + docs）。

## 6. 回滚条件与应急方案

- 配置维：不进入「本地模型」设置页 / 不发起下载即零影响；环境开关 `AERVOX_LLAMA_SERVER_PATH` 可随时指向
  其它 llama-server 实现；
- 进程异常：管理器统一 `status=error` 留痕，`stop()` 幂等收尾（SIGTERM→宽限→SIGKILL），应用关闭自动释放；
- 下载失败：`.part` 与侧车清理，下次下载重新覆盖；校验失败不落正式路径；
- 无迁移脚本与 schema 变更，删除本 CR 相关改动即可整体回滚（模型文件保留于磁盘）。
