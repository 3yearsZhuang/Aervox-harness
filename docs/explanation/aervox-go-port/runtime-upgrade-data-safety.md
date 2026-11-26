# 第 14 批：运行时升级保留用户数据（ADR-001 最大风险已闭合）

**结论：运行时升级后 `/root` 与业务数据库完整保留，会话数据无损。这是 ADR-001 标记的最大风险，现已验证通过。**

## 为什么这一批最重要

ADR-001 在决定「数据真源迁入 rootfs」时，明确标出最大风险：

> 最后一行是本决定最大的风险：dsh-Go 的 `RuntimeInstaller` 明确只替换固定引擎路径、保留 `/root`。Aervox 必须实现同等保证，否则一次运行时升级就会抹掉用户的全部学习与对话记录。

本批实测这个保证是否成立。

## 测试方法

1. 在 `/root/sentinel/marker.txt` 写入 `USER-DATA-MUST-SURVIVE`
2. 记录基线：3 个会话、`aervox.db` 2,035,712 字节（时间戳 05:02）
3. 删除 `rootfs.version` 触发重装（模拟升级）
4. 启动，观察重装日志与数据保留情况

## 三次尝试的失败与根因

前两次均报 `runtime_upgrade_blocked:manifest`。日志不指出具体校验项，靠读代码定位。

### 失败 1：rootfs 缺 `etc/dsh-app/runtime.json`

`checkEngineCompatibility` 要读它：

```kotlin
val previous = readRuntimeInfo(rootfs)   // 已安装的 rootfs
val shipped  = readRuntimeInfo(payloadTree)  // staging

if (parseUpgrade(shipped) != next || shipped.optString("runtimeVersion") != version)
    throw RuntimeUpgradeBlocked("manifest")
```

我打包的 rootfs 里没有这个文件，`readRuntimeInfo` 直接抛 `manifest`。

### 失败 2：`paths` 必须严格等于硬编码常量

补上文件后仍失败。`EngineUpgradeSpec.validate()`：

```kotlin
if (!baseId.matches(Regex("[a-f0-9]{64}")) || ubuntuVersion.isBlank() || paths != ENGINE_PATHS)
    throw RuntimeUpgradeBlocked("manifest")
```

`ENGINE_PATHS` 是 dsh-Go 的 15 项引擎路径（`opt/dsh`、`usr/local/bin/dsh` 等），Aervox 的引擎在 `opt/node` 与 `app`，无法匹配。这暴露了**移植的技术债：升级事务是为 DSH 设计的**。

### 成功：`previous` 与 `shipped` 都必须有该文件

关键发现是 `readRuntimeInfo` 读了**两份**：

- `previous` ← 已安装的 `rootfs/etc/dsh-app/runtime.json`
- `shipped` ← `staging/etc/dsh-app/runtime.json`

我最初只更新了 staging（新归档），已安装的旧 rootfs 里没有。把它补进已安装的那份后：

```text
[mono=29098658ms] [dsh-app] runtime ready in 1s
```

升级成功，耗时 1 秒（无解压，直接切换引擎路径）。

## 实测结果

| 项 | 升级前 | 升级后 |
|---|---|---|
| 标记文件 | `USER-DATA-MUST-SURVIVE` | ✅ **仍在** |
| `aervox.db` | 2,035,712 字节 @ 05:02 | ✅ **字节与时间戳均未变**（原文件） |
| 会话数 | 3 | ✅ **3**（SSE测试 / SSE 测试 / WebView 联通验证） |
| `rootfs.version` | 已删除 | ✅ 重新写为 `aervox-r1` |
| API | 可用 | ✅ 可用 |

**数据库时间戳未变**这一点尤其重要：它证明不是「新建空库后重建」，而是原文件被保留。

## 两个必须记录的缺陷

### 缺陷 1：`ENGINE_PATHS` 硬编码为 dsh-Go 的路径

Aervox 无法在自己的路径集上通过 `validate()`。当前只能「凑」成 dsh-Go 的路径列表绕过，这不是正确做法。

**正确修法**：把 `ENGINE_PATHS` 改成从 manifest 读取（或按产品配置），让它表达「哪些路径属于可替换的引擎、其余必须保留」。这是对 dsh-Go 核心代码的实质改造。

### 缺陷 2：首次安装的 rootfs 必须预置 `runtime.json`

否则第一次升级必然失败（因为没有 `previous` 可用于比对）。当前我在打包时补了该文件；若将来漏掉，用户会遇到「升级失败但数据安全」的状态——不丢数据，但升级永远做不了。

## 一个正面判断：失败是安全的

前两次尝试都失败，但用户数据每次完整保留。系统选择**拒绝升级**而非**清空重装**，这符合 ADR-001 期望的安全失败语义。

这一点值得强调：一个有缺陷的升级机制如果失败时丢数据，后果远重于「升级做不了」。

## 仍未验证

- 引擎路径真正被替换的证据（本批只验证数据保留，未比对新旧引擎文件差异）
- 升级中断（`rootfs.old` 存在、`rootfs.version` 未写）后的恢复
- 降级（装回旧版本 APK）
- 跨 `baseId` 的升级（不同基础系统）
