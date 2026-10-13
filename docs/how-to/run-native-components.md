---
id: AVX-GUIDE-008
type: how-to
scope: guide
owner: platform
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.1
updated_at: 2026-10-13
reviewed_at: 2026-10-13
review_interval_days: 90
sources:
  - docs/reference/changes/CR-063-native-runtime-components.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/DATABASE.md
---

# 构建与运行原生组件

本指南用于开发者构建、对照和显式启用 [CR-063](../reference/changes/CR-063-native-runtime-components.md) 的组件。授权、缓存一致性和回滚合同见 CR；生产发行须具备签名、公证和真实桌面权限验证证据。

## 1. 构建和验证

在仓库根运行，工具版本统一由 `mise.toml` 管理。普通 `pnpm build` 只构建 TypeScript；显式启用原生能力前执行原生构建：

```sh
mise install
mise tasks run native-toolchain-setup
mise tasks run native-runtime-build
mise tasks run native-runtime-check
mise tasks run native-runtime -- info
mise tasks run native-runtime -- probe
```

构建生成 `packages/native-runtime/dist/bin/<platform>-<arch>/` 内的可执行文件与摘要清单；该目录是派生制品，不提交 Git。工具先检查制品摘要，协议、输出、排队数量与时长均受限。系统探测报告真实 OS 状态，探测本身不会创建应用活动租约。

`native-runtime-check` 校验生成物和构建拓扑，执行 Rust 格式、单元测试、Clippy 与可执行合同，并构建 API/Worker 后运行真实主管启停演练。三平台构建/合同由 Native runtime 工作流验证；跨目标类型检查不代替目标 OS 上的实际执行。

修改内部协议时，先编辑 `native/protocol/runtime.json` 与共用夹具 `native/protocol/fixtures.json`，再生成 TypeScript 类型：

```sh
mise tasks run native-protocol-generate
mise tasks run native-runtime-check
```

生成器只接受已实现的 JSON Schema 关键字；新增关键字须同时更新双端校验器和共用正反夹具。手写业务 DTO 不放入该内部协议。只验证合成试验时运行 `mise tasks run native-search-check`；工作区默认成员为生产 runtime，试验须显式指定。

桌面发行入口 `pnpm dist:desktop` 会先构建原生制品，再生成安装包；直接运行 Electron Builder 前也须先运行 `native-runtime-build`。制品签名和系统签名仍按下文发行要求执行。

## 2. 对照向量、音频与插件计算

```sh
mise tasks run native-runtime-benchmark
```

默认在临时文件 SQLite 上比较 1 千、1 万、10 万条 256 维向量，报告写入 `artifacts/native-search/runtime-benchmark.json`，完成后删除夹具。基准覆盖真实仓储扫描、连续数组 Worker、Rust 进程冷/热查询及 `sqlite-vec`；参考结果检查在计时区外。内存数字是父进程采样，不能作为整个进程树的峰值。

API 的选择通过 `AERVOX_MEMORY_VECTOR_ENGINE=typed` 或 `rust` 显式设置。Rust 默认使用当前平台的构建制品，也可使用绝对路径 `AERVOX_NATIVE_BINARY` 与对应 `AERVOX_NATIVE_SHA256`。数据库路径从当前写者的 `PRAGMA database_list` 推导，不能选择另一份库。两种缓存均使用独立只读连接，任何 SQLite 提交都可能使缓存重建；普通对话写入造成的失效成本须计入生产评估。

关闭选择后使用既有 SQLite 仓储；组件失败时从真源重新读取，不返回旧缓存。业务写入、删除和最终召回资格仍在 TypeScript。原生索引扩展只用于隔离基准，不改业务 Schema。

`AERVOX_AUDIO_PREPROCESSOR=rust` 提供可选预处理进程，支持 16 位 PCM 与 32 位 Float WAV、最多八声道、20 MiB 输入和十分钟音频上限；识别仍使用已有 Provider。音频 IPC 成本计入报告，默认继续使用 TypeScript。插件压缩使用有界 Worker 与现有压缩库，原有路径、重复条目和展开配额保留。

## 3. 验证应用活动 Helper

开发态 Helper 随当前平台制品加载，经现有应用活动 Provider 接入。先在主动智能设置中确认原有授权和来源范围；每次采集前后均核对设备、revision、epoch、来源 Grant 和有效期。暂停、撤权与退出停止原生进程，重启须获取新租约。窗口关闭是否继续由现有后台 persistence grant 决定。

- macOS：Accessibility 状态来自实际 OS 探测；请求权限只由显式用户操作触发。数据限于前台应用标识、名称、PID 和本次观察到的活动时间，不读取窗口标题。
- Windows：只使用前台窗口与受限进程查询，不提升权限；受保护进程或非交互会话报告不可用。
- Linux：支持本机 X11/EWMH；Wayland 和远端 Display 报告具体缺口，不用全进程列表代替前台活动。

打包态要求 Ed25519 制品签名，信任公钥由构建时的 `AERVOX_NATIVE_RELEASE_PUBLIC_KEY` 嵌入桌面主进程。使用发行私钥路径对制品清单签名：

```sh
mise tasks run native-runtime -- sign --key=/private/release-key.pem --manifest=/absolute/artifact.json
```

签名命令不生成或导出私钥。macOS Developer ID、公证和 Windows 发行签名仍按安装包发布流程执行；缺少受信公钥或签名时打包态 Helper 不可用。开发态验证结果不能替代这一门槛。

## 4. 初始化与运行声明主管

先完成 API 与 Worker 构建，再明确选定数据目录。现有业务库迁入新目录须执行[迁移演练](run-database-migration-drill.md)，初始化命令不迁移或合并旧数据：

```sh
mise exec -- pnpm exec turbo run build --filter=@aervox/api --filter=@aervox/worker
mise tasks run native-runtime -- init-supervisor --data-dir=/absolute/selected-data --port=3000
mise tasks run native-runtime -- supervise /absolute/selected-data/native-supervisor.json
```

初始化使用私有 Token 和清单，已有清单不覆盖；选择的目录承载主库、Vault、私密 Key、控制面 Token 与模型目录。清单指定当前 Node 制品摘要、API/Worker 参数、就绪端口、版本和工作目录；不经 Shell。Worker 的可选 loopback `/health` 只在显式配置健康端口时启用，不暴露数据或控制操作。

同一目录只允许一个主管。端口占用、摘要不符、就绪超时或进程异常均返回具体失败；停止清理自己创建的 Unix 进程组/守护通道或 Windows Job，保留数据目录。可信被管程序须保持进程归属；需要独立后台化的模型声明为独立角色。模型作为清单角色启动时，API 模型 Driver 拒绝重复启动；普通配置仍由 API 拥有模型进程。

升级时停止主管、保留原清单与旧制品、验证新版本再切换；失败用旧清单与制品重启。删除应用制品和清单不会删除业务库，数据删除仍走现有数据权利入口。当前命令不自动注册 OS 系统服务或执行生产升级。
