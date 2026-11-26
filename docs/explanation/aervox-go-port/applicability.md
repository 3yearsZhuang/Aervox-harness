---
id: AVX-EXPL-017
---

# 对主仓的适用性结论

本目录收有 18 份 dsh-Go 移植路线的真机验证记录。**这些记录里的代码没有并入主仓**，本文说明为什么，以及哪些经验仍值得保留。

## 一、代码不可直接复用的原因

移植验证构建在**一个主仓不存在的前提**上：`targetSdk 28` + PRoot glibc 运行时 + 前台服务。

主仓的现状（2026-11-26 核对 `217c6a04`）：

| 项 | 主仓 | 移植验证 |
|---|---|---|
| `targetSdk` | **36** | 28 |
| 本机运行时 | 无（数据库用平台 SQLite，模型请求由原生 Java 发起） | PRoot + Ubuntu + Node 22 |
| 前台服务 | 无（清单只有 TTS/语音的 `<queries>`，无 `<service>`） | `DshService` |
| 前端加载 | `https://localhost/m0/` + CSP | `http://127.0.0.1:3000` 同源 |

在这个前提下，逐项对照：

| 验证产出的代码 | 主仓是否有对应位置 | 结论 |
|---|---|---|
| `WebAssetHandler`（asset 静态服务 + 同源策略） | 已有 `NativeAssetPolicy` + `NativeAssetWebViewHost`，且更严格（CSP、路径白名单、MIME 校验） | **重复且更简陋**，不采用 |
| 同源以避免 CORS 的做法 | 主仓用 `connect-src 'self'` + 固定 `https://localhost` 源，不需要该方案 | **前提不同**，不适用 |
| `DshService` 的 ANR 修复 | 主仓无前台服务 | **无处应用** |
| 首装竞态修复 | 同上，无服务可竞争 | **无处应用** |
| 插件目录层级修复 | 主仓插件装配路径不同，无此缺陷 | **不适用** |

**结论：没有可以原样并入的代码。** 强行并入只会得到死代码，并引入 dsh-Go 的 AGPL 衍生责任。

## 二、两条值得保留的经验

### 1. `targetSdk ≥ 29` 与私有目录 exec 的关系

Android 10（API 29）起，应用私有目录内的文件**不可执行**。只有 `nativeLibraryDir`（安装时由系统解压）可执行。

这条对主仓**当前没有影响**，因为：

- 主仓执行的 `su` 位于 `/system/bin`，属系统路径
- `NativeShizukuShell` 通过 Binder 调用，不在本进程 exec

但若将来引入任何**随包分发的本机可执行文件**（终端、Python、Node、ffmpeg 等），会遇到这条限制。可选路径：

| 方案 | 前提 | 代价 |
|---|---|---|
| 降 `targetSdk` 到 28 | 无 | 不可上架 Play；不享受 Android 10+ 安全加固 |
| 可执行件放 `jniLibs`（`lib*.so`）+ `useLegacyPackaging` | 满足文件命名与解压要求 | glibc 动态加载器路径仍需处理 |
| 改用 bionic 编译 | 无 | 原生模块需逐个重编译 |

移植验证中选择的是第一条，并在真机上确认了它的代价与可行性（[第 2 批](targetsdk28-node.md)、[第 14 批](runtime-upgrade-data-safety.md)）。

### 2. 前台服务的 `startForeground` 义务

这是移植过程中发现的**必现崩溃**（[第 10 批](foreground-service-anr-fix.md)），根因值得记住：

```kotlin
// 错误：startForeground 被包在条件块里
ACTION_START -> if (controller.prepareServiceStart(...)) {
    foreground(notification)   // 条件不成立时不会执行
    ...
}
```

`startForegroundService()` 之后，系统要求 **5 秒内**必须调用 `startForeground()`。若该调用被任何条件包裹，条件不成立时义务即无人履行，系统按 ANR 终止进程。

**正确写法：履行义务无条件在前，业务判断在后；失败路径要主动 `stopForeground()` + `stopSelf()`，否则会留下永不消失的通知。**

主仓当前没有前台服务。若将来为「后台续跑」引入，这条必须遵守。

## 三、另一个发现：安装与启动共用同一 service 会竞争

[第 11 批](first-launch-race-fix.md)记录了首次安装后必须点两次才能用的问题：

安装结束时的 `stopSelf(startId)` 与紧接着的 `startForegroundService(ACTION_START)` 竞争，系统在「等待 start foreground」状态下把服务带下来，5 秒后判 ANR。

规避方式是安装完成后延迟 2.5 秒再请求启动。**这只是绕过，不是解决**——彻底修需要让安装与启动使用不同的 service action，且不互相 `stopSelf`。

若主仓将来引入带安装步骤的前台服务，这条要一并考虑。

## 四、与现行合同的关系

移植路线与 ADR-022 有三处冲突，**主仓当前不需要修改它们**，因为该路线未被采纳：

- P3「不提供任意 shell、第二执行器」
- 「手机 = 本机 SQLite 唯一真源，App 私有目录」
- `native-runtime.ts` 的「No local HTTP server」

这些冲突只在**决定采纳移植路线时**才需要处理，详见 [ADR-001](adr/ADR-001-proot-runtime.md)。

## 五、何时这份材料会重新有用

| 触发条件 | 可复用的部分 |
|---|---|
| 决定为手机端引入本机可执行运行时 | 第 2 批（`targetSdk` 取舍）、第 14/15 批（升级保全与中断恢复） |
| 决定引入前台服务做后台续跑 | 第 10 批（ANR 修复思路）、第 11 批（竞态） |
| 决定移植 dsh-Go 界面 | [差距矩阵](gap-matrix.md)：101 个端点仅 23 个可对齐 |
| 需要评估 `targetSdk 28` 的真实代价 | [结项说明](CLOSING.md) 第二节 |

在此之前，本目录是**证据与教训的存档**，不是待实施的方案。
