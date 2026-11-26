# 第 2 批验证记录：targetSdk 28 下应用进程内跑通 Node

**结论：PRoot 路线在应用进程内验证通过。** 前提是 `targetSdk = 28`。

本文纠正 [第 1 批](app-domain-exec.md) 的结论：第 1 批在 `targetSdk 36` 下测得「PRoot 无法引导 glibc 二进制」，但那不是唯一原因；还有一个**权限设置错误**是我自己的问题。

## 两个独立障碍

第 1 批把两件事混在一起，导致结论过于悲观：

| 障碍 | 真实原因 | 解法 |
|---|---|---|
| 私有目录内任何二进制被拒 exec | Android 10+ W^X 策略，`targetSdk ≥ 29` 生效 | `targetSdk = 28` |
| rootfs 内 Node 报 `Permission denied` | **glibc 库文件权限是 `-rw-------`**，PRoot 的 loader 无法读取 | 复制后显式 `setExecutable(true)` + `setReadable(true)` |

第二项是我在探针里 `copyAsset` 时没有设置权限造成的，与 Android 无关。**第 1 批没有排除这个变量就下了结论，方法有缺陷。**

## 实测结果（targetSdk 28，真实应用进程）

| # | 测试 | 结果 |
|---|---|---|
| 1 | App 私有目录内执行 shell 脚本 | ✅ `exit=0 out=APP-EXEC-OK` |
| 2 | assets 复制 PRoot 到私有目录 | ✅ |
| 3 | **私有目录内直接执行 PRoot** | ✅ `exit=0`，`5.1.107.102` |
| 4 | `nativeLibraryDir` 内 PRoot | ✅（`targetSdk 28` 下两条路径都可用） |
| 5 | **PRoot 引导 rootfs 内 Node** | ✅ `exit=0 out=v22.19.0` |
| 6 | **Node 完整能力** | ✅ `ver=v22.19.0 arch=arm64 mem=15957643264 sha=e3b98a4d` |

第 6 项同时验证了：版本、架构、`os.totalmem()`（15.9 GB 可见）、OpenSSL `crypto` 原生模块。

## 关键结论

1. **`targetSdk 28` 是硬前提。** `36` 下私有目录完全不可执行；`28` 下恢复正常。这与 dsh-Go 的注释一致（*"targetSdk 28 is deliberate; not a Play build"*）。
2. **不必使用 `jniLibs` + `useLegacyPackaging` 的手法。** `targetSdk 28` 下直接把 PRoot 放私有目录即可，比 dsh-Go 的做法更简单。第 1 批之所以需要那套手法，是因为 36 下私有目录被封。
3. **库文件权限必须显式设置。** 这是容易踩的坑：`copyAsset` 写出的文件默认 `-rw-------`，glibc 加载会失败且报错信息误导（`Permission denied`，看起来像 W^X）。

## 代价

`targetSdk 28` 的实际影响必须写清楚：

| 项 | 影响 |
|---|---|
| Play 上架 | 不可能，Google 要求 `targetSdk ≥ 34` |
| Android 10+ 安全加固 | 该 App 不享受，包括 scoped storage、后台限制收紧、部分权限变更 |
| 分区存储 | 使用旧行为，可自由写外部存储（需权限） |
| 未来兼容 | Android 可能在后续版本停止尊重旧 targetSdk 的兼容行为，需每代验证 |

这是**产品级取舍**，不是工程细节。若采纳，需在 Aervox 主仓以独立 ADR 记录安全边界变化。

## 未验证项

| 项 | 状态 |
|---|---|
| 完整 Ubuntu rootfs（`/bin`、`/usr`、apt 等） | 未测，本批只复制了 `/opt/node` 与 6 个 glibc 库 |
| 第三方原生模块（`sharp`、`sqlite-vec`、`sherpa-onnx-node`） | 未测 |
| Aervox API 实际启动（`node_modules` 约 1.1 GB） | 未测 |
| 前台服务保活、功耗、升级保留数据 | 未测 |
| WebView → 127.0.0.1 联通 | 未测 |
| Android 后续版本对 targetSdk 28 的兼容 | 未测 |

## 下一步

1. 复制完整 Ubuntu rootfs 进私有目录，验证 apt / bash / 常见工具
2. 部署裁剪后的 `node_modules`，实测 Aervox API 能否启动
3. 逐个验证第三方原生模块
4. 验证 WebView 与本机 API 的联通与 SSE 流
