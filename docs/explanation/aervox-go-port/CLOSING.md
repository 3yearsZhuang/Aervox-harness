# 结项：移植路线的结论、代价与剩余风险

> 本文汇总第 0–16 批的 18 份验证记录，供决定「是否正式采纳这条路线」使用。
> 所有数字与结论都可追溯到对应批次的文档；本文不引入新证据。

## 一、路线是否成立

**成立。** Aervox 的 Vue 前端 + 完整 API 已在 Android 真机上以 dsh-Go 的 PRoot 骨架运行，具备以下实际能力：

| 能力 | 状态 | 证据 |
|---|---|---|
| 全新安装后一次点击启动 | ✅ 24 秒 | [第 11 批](first-launch-race-fix.md) |
| 已安装后启动 | ✅ 12–14 秒 | [第 11 批](first-launch-race-fix.md) |
| 界面完整渲染（品牌、Live2D、四卡、输入栏） | ✅ | [第 7 批](webview-ui.md) |
| 完全离线可用 | ✅ 断网后角色与界面正常 | [第 7 批](webview-ui.md) |
| 10 个第一方插件装配 | ✅ 0 条失败 | [第 12 批](plugin-layout-fix.md) |
| 运行时升级保留数据 | ✅ | [第 14 批](runtime-upgrade-data-safety.md) |
| 升级中断可恢复 | ✅ 14 秒 | [第 15 批](upgrade-interruption-recovery.md) |
| 故障可自救（保留数据） | ✅ 10 秒 | [第 16 批](runtime-repair.md) |
| 安全策略对齐主仓 | ✅ 外部请求零放行 | [第 8 批](fixed-asset-alignment.md) |

### 未验证的核心功能

**真实对话一次都没跑过。** 所有验证都止于「引擎就绪、界面可交互」，没有验证过模型返回、SSE 流式渲染、工具调用。这是整条路线上唯一的功能性空白，也是最大的剩余风险。

## 二、代价（必须让决定者看到的）

### 2.1 `targetSdk = 28` 是硬前提

`targetSdk ≥ 29` 时 Android 禁止在应用私有目录 exec，PRoot 无法引导 glibc 二进制（[第 1 批](app-domain-exec.md) 记录了完整失败过程，[第 2 批](targetsdk28-node.md) 确认 28 可行）。

**这意味着：**

- **不可能上架 Google Play**（要求 targetSdk ≥ 34）
- 不享受 Android 10+ 的 scoped storage、后台限制收紧等安全加固
- 未来 Android 可能停止尊重旧 targetSdk 的兼容行为，需逐代回归

这是产品级取舍，不是工程细节。采纳需在主仓以独立 ADR 记录安全边界变化。

### 2.2 APK 体积

| 项 | 数值 |
|---|---|
| 最终 APK | **146 MB** |
| 其中 rootfs | 110 MB（压缩后） |
| 解压后 | 382 MB 磁盘占用 |

已从 422 MB 优化到 146 MB（[第 9 批](apk-slimming-and-timing.md)），但仍是普通 App 的数倍。若要做增量更新或资产拆分，是另一项工程。

### 2.3 代码复用与新增

| 项 | 数量 | 说明 |
|---|---|---|
| 保留 dsh-Go 的 Kotlin 类 | **51 个** | `runtime/` 39 个是核心 |
| 我新写的代码 | **441 行** | `MainActivity.kt` 387 行 + `WebAssetHandler.kt` 54 行 |
| 剥离掉的 Flutter 依赖类 | 40 个目录 | 手机操控、桌宠、语音、更新等 |

**441 行换来一个可用的 App**，这个比例说明 dsh-Go 的 runtime 层复用价值很高——它正是我前 5 批手工重写并反复失败的部分。

### 2.4 升级机制的技术债

`EngineUpgradeSpec.validate()` 硬编码了 dsh-Go 的 15 项引擎路径（[第 14 批](runtime-upgrade-data-safety.md)）。当前为了让升级跑通，我把 Aervox 的 `paths` 凑成了 dsh-Go 的列表——**这是绕过，不是解决**。

正确修法是把 `ENGINE_PATHS` 改成从 manifest 读取。这是对上游核心代码的实质改造。

## 三、记录到的真实缺陷（都是必现级）

移植过程中发现并修复了 4 个必现缺陷，它们的共同点是：**上游的 Flutter 客户端不会触发，我们的用法才会触发**。

| # | 缺陷 | 根因 | 批次 |
|---|---|---|---|
| 1 | 前台服务 ANR 杀进程 | `startForeground()` 被包在条件块内，安装完立刻启动时条件不成立 | [第 10 批](foreground-service-anr-fix.md) |
| 2 | 首装后需点第二次 | 安装与启动共用 `DshService`，`stopSelf` 与 `startForegroundService` 竞争 | [第 11 批](first-launch-race-fix.md) |
| 3 | 插件全不装配 | 打包压平了 `plugins/plugins/<cat>` 层级 | [第 12 批](plugin-layout-fix.md) |
| 4 | 失败时白屏无提示 | 启动兜底只写日志，未渲染任何界面 | [第 15 批](upgrade-interruption-recovery.md) |

第 1、2 项说明：**dsh-Go 的这部分逻辑与其 Flutter 时序强耦合**，换成 WebView 入口后时序变了，隐藏假设就暴露出来。

## 四、我做错的判断（保留作为教训）

移植过程中我至少三次判断错误，都已更正并留档：

| 误判 | 实际情况 | 原因 |
|---|---|---|
| 「PRoot 在 Android 17 上失效，建议降 targetSdk」 | PRoot 本身没问题，是我没设 `PROOT_LOADER` | 见 [第 0 批](runtime-feasibility.md) 的更正 |
| 「难以引导 glibc 二进制是 W^X 限制」 | 两个独立障碍被我混为一谈，其一是我的文件权限错误 | 见 [第 2 批](targetsdk28-node.md) |
| 「应用被系统回收，属未验证项不算缺陷」 | 是必现的 ANR 崩溃 | 见 [第 10 批](foreground-service-anr-fix.md) |

共同点是：**看到现象就下结论，没有查 `exit-info`、没有验证排除变量**。这三处的更正都写进了对应文档，没有悄悄改掉。

## 五、与主仓合同的冲突清单

采纳本路线需要主仓同步修订三处（[ADR-001](adr/ADR-001-proot-runtime.md)）：

1. **ADR-022 P3「不提供任意 shell、第二执行器」** —— 终端能力要求受限执行环境
2. **「手机 = 本机 SQLite 唯一真源，App 私有目录」** —— 真源位置迁入 rootfs
3. **`native-runtime.ts` 的「No local HTTP server」** —— 该模块角色需重新定义

此外还有一处**行为差异**尚未对齐：aervox-go 的 WebView 保持 `domStorageEnabled=true`（前端用 localStorage），主仓手机端则把偏好存原生（[第 8 批](fixed-asset-alignment.md)）。

## 六、如果要正式采纳，建议的顺序

1. **先补真实对话验证** —— 这是唯一的功能空白，且成本最低（一个 API Key）。若对话不通，其余都不必谈
2. **改造 `ENGINE_PATHS`** —— 把硬编码改为从 manifest 读取，消掉升级路径的绕过
3. **决定 targetSdk 策略** —— 写主仓 ADR，明确放弃 Play 与旧版兼容行为的接受范围
4. **资产瘦身** —— 146 MB 对分发是实质障碍
5. 其余对齐项（Service Worker 已做、`MULTI_PROFILE` 未做、偏好存储迁移）

## 七、本仓库的定位

这是一个**验证仓**，不是产品分支。它的产出是：

- 18 份带真机证据的验证记录
- 一份差距矩阵（[gap-matrix](gap-matrix.md)），量出 dsh-Go 的 101 个端点里只有 23 个可与 Aervox 对齐
- 一份可运行的 APK 与 441 行适配代码

**它证明的是「能做」，不是「该做」。** 是否该做，取决于第六节第 1、3 项的答案。
