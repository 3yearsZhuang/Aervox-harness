# 第 4 批验证记录：Aervox API 在真机完整运行

**结论：Aervox API 在真机 PRoot 内完整启动、监听、响应请求并持久化数据。** 这是本仓库第 0 批目标的达成。

## 实测证据

环境：OPPO PMA110 / Android 17 / arm64 / Ubuntu 24.04 rootfs / Node v22.19.0 / PRoot 5.1.107.102

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | API 启动并监听 | ✅ | `netstat` 显示 `127.0.0.1:3000 LISTEN`，PID 9023 `/opt/node /app5/dist/index.js` |
| 2 | 读取会话列表 | ✅ | `GET /v1/sessions` → `{"items":[]}` |
| 3 | **创建会话（写库）** | ✅ | `POST /v1/sessions` → `{"id":"ses_mwwhhymu_jaib78","title":"真机 PRoot 会话",...}` |
| 4 | **回读验证（持久化）** | ✅ | `GET /v1/sessions` → 返回刚创建的会话 |
| 5 | 数据库文件落盘 | ✅ | `node_modules/data/aervox.db`、`proactive-vault.db` |
| 6 | 内存占用 | ✅ 145 MB RSS | `/proc/9023/status` VmRSS = 145812 kB |
| 7 | 进程树 | ✅ 正常 | sh → proot(4 MB) → node(145 MB) |

第 3、4 项是完整闭环：HTTP 请求 → Fastify → 仓储 → libsql 原生模块 → SQLite 写入 → 回读。

## 部署包的真实体积

这是本轮最有价值的数据之一。初始 pnpm 部署包 **569 MB**，经三步精简后：

| 阶段 | 体积 | 说明 |
|---|---|---|
| pnpm deploy 全量 | 569 MB | 含前端包（element-plus、lucide、pixi）、darwin 二进制 |
| 换成扁平 npm 依赖 | 145 MB | 关键：**不用 pnpm 的 `.pnpm` 隔离结构** |
| 剥离 workspace 源码与插件 node_modules | 155 MB | 只留 `dist` + `package.json` |
| 压缩后 | **37 MB** | 可分发体积 |

## 五个必须记录的坑

### 1. pnpm 的 `.pnpm` 结构无法跨平台打包

`pnpm deploy` 产出的 `node_modules/@aervox/*` 是指向 `.pnpm` 的符号链接，`tar` 打包后链接断裂，或 `cp -aL` 因目标已存在同名链接而不覆盖，导致包目录为空。

**解法：** 用 `rm -rf` 再 `cp -RL` 强制解引用；或用扁平 npm 依赖树（推荐）。

### 2. 必须用 `tar --dereference`

macOS 打包会把符号链接原样存入，解到 Android 后成为 `-> ././@LongSymLink` 的坏链。

### 3. npm 会拒绝 `workspace:` 协议

从 workspace 的 `package.json` 复制依赖清单再 `npm install` 会报 `EUNSUPPORTEDPROTOCOL`。必须先剔除 `@aervox/*` 与 `workspace:*`。

### 4. `@aervox/core` 是 git submodule，需单独构建

它在主仓中是子模块，`dist` 可能缺失或过期。部署前必须 `pnpm --filter @aervox/core build`。

### 5. 插件目录结构是 `plugins/plugins/<类别>/<id>`

运行时按 `node_modules/plugins` 查找。剥离源码时若删掉过多文件，会导致 `plugin_runtime_identity_unavailable`。

## 当前可接受的缺陷

| 缺陷 | 影响 | 状态 |
|---|---|---|
| 两个插件装配失败（`ap-tool-anki-sync`、`ap-workflow-diary-distillers`） | 日志报 `plugin_runtime_identity_unavailable`，其余功能正常 | 待修，不阻塞启动 |
| `onnxruntime` 警告「Unknown CPU vendor」 | 可能影响语音推理性能，不影响核心功能 | 可接受 |
| `/v1/health` 不存在 | 该路由本就不存在，不是缺陷 | — |

## 未验证项

| 项 | 说明 |
|---|---|
| WebView → 127.0.0.1:3000 联通 | 未测。这是下一步的关键：WebView 与 API 是否同网络命名空间 |
| SSE 流式对话 | 未测 |
| 真实模型调用 | 未测（需配置 API Key） |
| 应用进程内运行（非 adb shell） | 第 2 批已验证 Node，本批未重复 |
| 前台服务保活 | 未测 |
| 冷启动耗时 | 未精确测量 |
| 升级保留数据 | 未测 |

## 里程碑判断

**第 0 批目标达成**：有可运行的 Aervox API，在真机上监听并完成数据写入。

剩余工作从「能不能跑」转为「接进 App」：

1. WebView 接入本机 API
2. 应用进程内启动（而非 adb shell）
3. 前台服务保活
4. 打包进 APK 与首次安装流程
