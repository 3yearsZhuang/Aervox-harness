---
id: AVX-EXPL-016
---

# dsh-Go 移植路线：验证记录

本目录记录一条**已验证但未采纳**的路线：以 [dsh-Go](https://github.com/ccch1mneyyy/dsh-go) 的 Android 运行时骨架为基座，让 Aervox 的 Vue 前端与完整 API 在手机本机运行。

产物来自独立验证仓 `Aervox-agent/aervox-go`（已归档），共 18 份带真机证据的记录。**本文不构成实施授权**，也不改变任何现行合同。

## 先读什么

| 目的 | 入口 |
|---|---|
| 一次看懂结论、代价与剩余风险 | [结项说明](CLOSING.md) |
| 为什么不做整体移植（量化依据） | [差距矩阵](gap-matrix.md) |
| 作为架构决定的依据 | [ADR-001 提案](adr/ADR-001-proot-runtime.md) |

## 两个阶段的结论并不冲突

本目录与[移动端迭代建议](../../proposals/mobile-iteration-2026/README.md)是同一问题的前后两段，结论互补：

| | 移动端迭代建议 | 本目录 |
|---|---|---|
| 时间 | 移植前 | 移植后 |
| 问题 | dsh-Go 有哪些**做法**值得借 | 直接**移植**其客户端骨架是否可行 |
| 结论 | 不建议整体移植：101 个端点只有 23 个可与 Aervox 对齐 | 移植**可行**，且已跑通；但代价是 `targetSdk 28` |
| 产出 | 分三批的改进建议 | 18 份真机验证记录 + 可运行 APK |

前者回答了「该不该搬它的界面」，后者回答了「搬了会怎样」。**两者共同指向：借做法、别搬界面。**

## 验证记录

按时间顺序，每份都含真机证据、失败过程与未验证项。

### 可行性（第 0–5 批）

| 批次 | 主题 | 结论 |
|---|---|---|
| [第 0 批](runtime-feasibility.md) | PRoot + Node 在 shell 内 | ✅ 通过 |
| [第 1 批](app-domain-exec.md) | 应用进程内 exec 限制 | ❌ 失败（后被第 2 批修正） |
| [第 2 批](targetsdk28-node.md) | `targetSdk 28` 下应用进程内跑通 Node | ✅ 通过 |
| [第 3 批](native-modules.md) | `libsql` / `sharp` / `ripgrep` 原生模块 | ✅ 全部可用 |
| [第 4 批](api-running.md) | Aervox API 完整运行并写库 | ✅ 通过 |
| [第 5 批](webview-connectivity.md) | WebView 直连本机 API + SSE | ✅ 通过 |

### 集成（第 6–9 批）

| 批次 | 主题 | 结论 |
|---|---|---|
| [第 6 批](dshgo-skeleton-port.md) | 以 dsh-Go 骨架移植 | ✅ App 内完整运行 |
| [第 7 批](webview-ui.md) | Vue 前端接入，界面完整 | ✅ 含离线验证 |
| [第 8 批](fixed-asset-alignment.md) | 对齐主仓固定资产策略 | ✅ 外部请求零放行 |
| [第 9 批](apk-slimming-and-timing.md) | APK 瘦身与启动耗时 | ✅ 422→146 MB |

### 缺陷修复（第 10–16 批）

| 批次 | 主题 | 结论 |
|---|---|---|
| [第 10 批](foreground-service-anr-fix.md) | 前台服务 ANR（必现崩溃） | ✅ 已修 |
| [第 11 批](first-launch-race-fix.md) | 首装竞态 | ✅ 已修，一次启动即可用 |
| [第 12 批](plugin-layout-fix.md) | 插件目录层级错误 | ✅ 已修，10 个插件全装配 |
| [第 13 批](plugin-tool-availability.md) | 插件工具可用性边界 | ✅ 查明为设计行为 |
| [第 14 批](runtime-upgrade-data-safety.md) | 升级保留用户数据 | ✅ 通过 |
| [第 15 批](upgrade-interruption-recovery.md) | 升级中断恢复 | ✅ 通过 + 可见失败页 |
| [第 16 批](runtime-repair.md) | 重置运行环境（保留数据） | ✅ 已实现 |

## 三条必须记住的结论

**1. `targetSdk = 28` 是硬前提。** `≥ 29` 时 Android 禁止在应用私有目录 exec，PRoot 无法引导 glibc 二进制。代价是不可上架 Play、不享受 Android 10+ 安全加固。

**2. 真实对话一次都没验证过。** 全部记录止于「引擎就绪、界面可交互」，模型返回、SSE 渲染、工具调用均未验证。这是唯一的功能空白。

**3. 移植过程发现 4 个必现缺陷**，共同点是：上游的 Flutter 时序不会触发，换成 WebView 入口才暴露。

## 与现行合同的关系

采纳本路线需主仓同步修订三处（见 [ADR-001](adr/ADR-001-proot-runtime.md) 的「须一并修订的主仓合同」）：

- ADR-022 P3「不提供任意 shell、第二执行器」
- 「手机 = 本机 SQLite 唯一真源，App 私有目录」
- `native-runtime.ts` 的「No local HTTP server」

**本目录只提供证据，不改变这些合同。**

## 代码去向

验证用的 51 个 Kotlin 类与 441 行适配代码**未并入主仓**：它们依赖 dsh-Go 的 AGPL 实现，属衍生工作，且只在临时目录维护。若将来确定采纳，应作为完整工程决定处理许可证与 `apps/mobile` 归属，而不是以验证材料的形式混入。
