---
id: AGO-ADR-001
decision_status: proposed
---

# AGO-ADR-001：Android 端引入 PRoot Linux 运行时，数据真源迁入 rootfs

> 这是**移植路线的提案**，属 `AGO-ADR-` 命名空间，与本仓库的 [ADR-001](../../../reference/adr/ADR-001-modular-monolith.md)（模块化单体）无关，也不受 [ADR 索引](../../../reference/adr/README.md) 的编号约束。

## 状态

**提案，未生效。** 这是 aervox-go 试验仓的路线记录。若采纳，须在 Aervox 主仓以正式 ADR 重新发布；本仓不改变主仓任何合同。

可行性已在真机验证，见[运行时验证记录](../runtime-feasibility.md)。

## 背景

Aervox 手机端当前是「WebView + App 私有目录 SQLite + 原生 Java 持有模型凭据」，`apps/web/src/mobile/native-runtime.ts` 开头即写明：

> No local HTTP server, browser database, alternate ledger or privileged shell.

该形态无法承载维护者要求的能力集：

| 需求 | 阻塞原因 |
|---|---|
| 终端 | 无 shell、无 PTY；桌面端同样没有 |
| 工作区文件 | 无文件系统工作区，仅 SAF 单文件 |
| 自有插件体系跑在手机 | 无插件宿主进程 |
| `apps/api` 完整能力 | 依赖 `@libsql/client`、`sharp`、`sqlite-vec`、`@vscode/ripgrep` 等原生模块，需要真实 Node |
| 学习/日记/人格全部路由 | 这些路由只在 API 进程内，手机端仅实现子集 |

## 决定

### 一、引入 PRoot + Ubuntu rootfs + Node 22

```text
Android App 进程
  └─ PRoot (arm64, Termux 5.1.107.102)
       └─ Ubuntu 24.04 rootfs (App 私有目录)
            └─ Node 22 + Aervox API (127.0.0.1:<port>)
WebView ── HTTP/SSE ──> 127.0.0.1:<port>
```

选 PRoot 而非 bionic Node 的理由：glibc 环境能直接使用预编译原生模块，无需逐个交叉编译。

### 二、数据真源迁入 rootfs

维护者已确认接受。

| 项 | 变更前 | 变更后 |
|---|---|---|
| SQLite 位置 | App 私有 `aervox-m0/main.db` | rootfs 内 `~/.aervox/main.db` |
| 持有者 | 原生 Java 单线程写者 | Node 进程内的仓储 |
| 备份范围 | App 私有目录 | 须覆盖 rootfs |
| 卸载 App | 数据随 App 删除 | rootfs 在私有目录内，同样删除 |
| 重置运行时 | 不涉及 | **必须保留 `/root`**（迁移而非重建） |

最后一行是最大风险：dsh-Go 的 `RuntimeInstaller` 只替换固定引擎路径、保留 `/root`。Aervox 必须实现同等保证，否则一次升级就抹掉全部学习与对话记录。

### 三、前端保持 Vue，不引入 Flutter

维护者选择「A 能力集，观感学习」：

- 保留 Vue + Material 3（一套代码覆盖 Android/iOS/鸿蒙 WebView，多端最简路径）
- 从 dsh-Go 吸收交互做法（流式 Markdown 尾部修补、行模型、轮摘要折叠、设置索引），不搬 Flutter 代码

这排除了 dsh-Go 的多端负担：其 iOS 需 72 个 Swift 文件、鸿蒙需 105 个 ArkTS 文件并绑定 oh-flutter fork，本方案均不需要。

## 后果

### 须一并修订的主仓合同

与 ADR-022 三处冲突，采纳时必须同步修订：

1. **P3「不提供任意 shell、第二执行器」** —— 终端需求要求受限执行环境。建议改为「白名单命令 + 沙箱目录 + 逐次审批」。
2. **「手机 = 本机 SQLite 唯一真源，App 私有目录」** —— 真源位置与备份/升级责任需重写。
3. **`native-runtime.ts` 的「No local HTTP server」** —— 该模块在 PRoot 模式下的角色需重新定义。

### 不采用

| 方案 | 理由 |
|---|---|
| bionic Node（Termux 风格） | 原生模块需逐个交叉编译，风险高 |
| 引入 Flutter | 三端各自原生层，与本仓目标无关 |
| rootfs 只做执行、SQLite 留在 App 私有 | 两进程访问同库，锁与一致性复杂 |
| Cordis / dsh-Go 插件协议 | 改用 Aervox 自有 `plugin.manifest.json` |

### 风险

| 风险 | 缓解 | 状态 |
|---|---|---|
| 首次安装 40s–2min、约 1 GB | 解压与 UI 并行，进度胶囊常驻 | 未实现 |
| 运行时升级抹数据 | 升级只替换引擎路径，`/root` 保留 + 回归测试 | ✅ 已验证，见[第 14 批](../runtime-upgrade-data-safety.md) |
| 应用进程内的系统限制 | 与 shell 进程不同，需单独验证 | **未验证** |
| 第三方原生模块兼容 | 逐个验证 | **未验证** |
| 进程被系统回收 | 前台服务 + 唤醒锁 | 未实现 |

**注：** 曾误判需要降低 `targetSdk` 到 28。真机验证表明不需要——初测失败的真实原因是 `PROOT_LOADER` 未显式设置。详见验证记录。

## 退出条件

任一下述情况发生时应放弃本路线并记录：

1. **应用进程内**无法启动 Node（shell 内已通过，应用内未验证）
2. `sharp`、`sqlite-vec` 等关键原生模块在 rootfs 内不可用且无替代
3. 运行时升级无法可靠保留用户数据

## 验证状态

- **已通过（shell 进程）**：PRoot 执行、rootfs 挂载、Node 22 启动、crypto/zlib/node:SQLite 内置模块、HTTP 监听与回环 fetch、事件循环、约 120 ms 启动
- **未验证**：应用进程内运行、第三方原生模块、Aervox API 实际启动、升级保留数据、功耗
