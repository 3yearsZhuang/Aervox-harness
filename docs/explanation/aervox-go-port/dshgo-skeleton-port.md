# 第 6 批：以 dsh-Go 骨架移植成功，App 内完整运行 Aervox API

**结论：以 dsh-Go 的 Android 运行时骨架为基座，Aervox API 在 App 进程内、由 App 自身启动的 PRoot 中完整运行，并已通过 WebView 访问。**

这是本仓库的核心目标达成。此前手工装配方案（见 [runtime-feasibility.md](runtime-feasibility.md) 与 [targetsdk28-node.md](targetsdk28-node.md)）反复卡在 tar 解压、符号链接与权限上，改用 dsh-Go 骨架后一次性解决了全部基础设施问题。

## 做法

以 [dsh-Go](https://github.com/ccch1mneyyy/dsh-go) `f2d589c4` 的 `app/android` 为基线：

1. **保留** `runtime/` 的 43 个 Kotlin 类（安装器、PRoot 启动、生命周期、安全模式、升级事务）
2. **移除** 40 个依赖 Flutter 的插件目录（`phone`、`pet`、`speech`、`update` 等）
3. **替换** 入口：`RuntimePlugin.kt`（Flutter 通道）→ 纯 Android `MainActivity`（WebView）
4. **替换**运行时清单：DSH 启动命令 → Aervox API 启动命令
5. **补齐**必要的桩：`PhoneControl`、`PhoneGuest`、`DiagnosticsTool`、`manage`/`phoneSkills` 系列

## 关键改造点

### 1. 运行时清单的 `launch.argv` 必须内嵌 PRoot

dsh-Go 的清单不是「guest 命令」，而是**完整的 PRoot 命令行**，且必须含 `/usr/bin/env` 作为分割点（`DirectLaunch.prootArguments` 依赖它插入 bind 与 env）：

```json
"launch": {
  "argv": [
    "{NATIVE_LIB_DIR}/libproot.so", "--kill-on-exit", "--link2symlink",
    "--sysvipc", "-L", "-0", "--rootfs={ROOTFS}", "--cwd=/root",
    "-b", "/dev", "-b", "/proc", "-b", "/sys", "-b", "/system", "-b", "/apex",
    "/usr/bin/env", "-i", "HOME=/root", "PATH=...",
    "{GUEST_ENV}",
    "/bin/sh", "-c", "exec /opt/node /app/dist/index.js"
  ],
  "env": { "PROOT_LOADER": "{NATIVE_LIB_DIR}/libproot-loader.so", ... }
}
```text

写成裸 `/opt/node` 会导致 `Cannot run program "/opt/node"`。

### 2. `libtalloc.so.2` 必须二进制打补丁

APK 只能携带 `lib*.so` 形式的库，而 proot 的 `DT_NEEDED` 是 `libtalloc.so.2`。dsh-Go 的做法是**等长替换 ELF 的 dynstr**：

```python
old = b"libtalloc.so.2\x00"
new = b"libtalloc.so\x00\x00\x00"
# 同时补丁 libproot.so 的 DT_NEEDED 与 libtalloc.so 的 DT_SONAME
```

不改这一步会报 `CANNOT LINK EXECUTABLE ... library "libtalloc.so.2" not found`。

### 3. 必须移除 dsh-Go 的 DNS 补丁注入

`DirectLaunch.prootNodeOptions()` 会无条件追加 `--import=/opt/dsh-go/direct/proot-dns.mjs`，Aervox 的 rootfs 不含该文件，会直接崩溃：

```text
ERR_MODULE_NOT_FOUND: file:///opt/dsh-go/direct/proot-dns.mjs
```

### 4. 资产必须用未压缩 `.tar`

Gradle 会把 `.tar.gz` 解压成 `.tar` 再打包，导致清单里的字节数与摘要失配，安装报 `install failed: runtime/rootfs-*.tar.gz`。

**解法**：归档本身就是 `.tar`（不套 gzip），清单声明 `.tar` 与真实字节数。

### 5. flavor 的 assets 路径是 `runtime/out/<abi>/assets`

dsh-Go 的 `build.gradle.kts` 从 `../../runtime/out/arm64-v8a/assets` 取资产，不读 `src/main/assets`。放错位置会导致 APK 内没有 assets。

## 实测结果

设备：OPPO PMA110 / Android 17 / API 37 / arm64 / KernelSU

| 项 | 结果 |
|---|---|
| APK 体积 | 417 MB（含 382 MB rootfs tar） |
| 首次安装（解压 rootfs） | **7 秒**（verify 408ms、extract 6602ms、sync 431ms、activate 441ms） |
| PRoot 在 App 内启动 | ✅ |
| Node 在 PRoot 内运行 | ✅ PID 23154，153 MB RSS，17 线程，`epoll_wait` |
| **Aervox API 监听** | ✅ `127.0.0.1:3000` |
| **读取会话列表** | ✅ 返回既有会话 |
| **创建会话（写库）** | ✅ `ses_mwwjuzys_xubux0` |
| WebView 访问 API | ✅ |

Node 进程的实际参数为 `--kill-on-exit ... --rootfs=... /opt/node /app/dist/index.js`，即清单 argv 被正确展开。

## 已知缺陷

| 缺陷 | 影响 |
|---|---|
| 两个插件装配失败（`ap-tool-anki-sync`、`ap-workflow-diary-distillers`） | `plugin_runtime_identity_unavailable`，不阻塞 API |
| 端口以 3000 为准 | 清单的 `{PORT}` 占位符未生效（Aervox 用默认端口），MainActivity 已按 3000 对齐 |
| 手机操控、语音、桌宠、更新等模块已移除 | 保留桩实现，返回不可用 |
| APK 417 MB | 尚未做增量更新或资产拆分 |

## 未验证项

- WebView 内的完整前端（仅验证了 API 可访问）
- SSE 流式对话（宿主机曾验证，App 内未测）
- 真实模型调用
- 应用被杀后的恢复、后台保活
- 运行时升级保留数据
- 冷启动耗时（热启动已测）
- 与 dsh-Go 的 `targetSdk 28` 一致性（当前继承其配置）

## 下一步

1. 把现有 Vue 前端构建产物放进 APK，让 WebView 加载完整界面
2. 在 App 内跑通一次真实对话（含 SSE）
3. 修复两个插件装配失败
4. 资产瘦身：把 382 MB rootfs 拆成 base + 变更层，或用 gzip 并正确声明格式
