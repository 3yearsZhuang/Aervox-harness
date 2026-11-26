# 第 1 批验证记录：应用进程内的 exec 限制

> **本文结论已被 [第 2 批](targetsdk28-node.md) 修正。**
>
> 本批在 `targetSdk 36` 下测得「PRoot 无法引导 glibc 二进制」，但当时未排除一个自身引入的变量：`copyAsset` 写出的 glibc 库权限为 `-rw-------`，PRoot 的 loader 无法读取，报错同样是 `Permission denied`。
>
> 修正后（`targetSdk 28` + 显式设置库权限），应用进程内可完整运行 Node v22.19.0。本文保留为失败证据与教训。

**原结论：PRoot 可在应用进程内执行，但 PRoot 要引导的 glibc 二进制（Node）无法在 App 私有目录内 exec。** 这是 Android 的 W^X 限制，dsh-Go 通过 `targetSdk 28` 规避。

本文记录实测证据，不含推断。

## 与第 0 批的差别

第 0 批全部通过 `adb shell`（uid 2000）执行，结论是「PRoot + Node 可用」。
本批改用**真实应用进程**（uid `u0_a555`，SELinux 域不同），结论不同。

这个差别正是第 0 批留下的最大风险项，现已验证。

## 测试方法

构建最小探针 APK（`dev.aervox.execprobe`），在 `Activity` 内：

1. 在 `getFilesDir()` 写 shell 脚本并执行
2. 从 assets 复制 PRoot 到 `getFilesDir()` 并执行
3. 把 PRoot 作为 `libproot.so` 放进 `jniLibs`（`useLegacyPackaging = true`），从 `nativeLibraryDir` 执行
4. 用 `nativeLibraryDir` 的 PRoot 引导 App 私有 rootfs 内的 Node
5. 直接执行 `nativeLibraryDir` 内的 `libnode-bin.so`

APK 配置：`minSdk 24`、`targetSdk 36`、`compileSdk 36`、`useLegacyPackaging = true`。

## 实测结果

| # | 测试 | 结果 | 证据 |
|---|---|---|---|
| 1 | App 私有目录内 shell 脚本 | ❌ | `error=13, Permission denied` |
| 2 | assets 复制 PRoot 到私有目录 | ✅ | `copied=true` |
| 3 | 私有目录内 PRoot 执行 | ❌ | `error=13, Permission denied` |
| 4 | `nativeLibraryDir` 内 `libproot.so` 存在且可执行 | ✅ | `exists=true exec=true` |
| 5 | **`nativeLibraryDir` 内 PRoot 执行** | ✅ | `exit=0`，输出 `5.1.107.102`，`seccomp_filter = yes` |
| 6 | PRoot 引导私有 rootfs 内 Node | ❌ | `execve("/opt/node"): Permission denied` |
| 7 | 直接执行 `nativeLibraryDir` 内 `libnode-bin.so` | ❌ | `error=2, No such file or directory`（缺 glibc 加载器） |

## 结论

### 已验证成立

**PRoot 本身可以在应用进程内运行**，前提是把它作为 `lib*.so` 放进 `jniLibs` 并开启 `useLegacyPackaging`。这是 dsh-Go 采用的做法，本批证实它在 `targetSdk 36` 下同样有效。

`nativeLibraryDir` 是 App 唯一可执行的位置；私有目录（`filesDir`）内的任何二进制都被内核拒绝执行。

### 已验证不成立

**PRoot 引导 glibc 二进制这一步在 `targetSdk 36` 下被阻断。** rootfs 内 Node 有 `rwx--x--x` 权限，`execve` 仍返回 `Permission denied`。

原因是 Android 10+ 的 W^X 策略：`/data` 分区不可执行，PRoot 无法绕过对 rootfs 内文件的 execve 限制。

### 待澄清

第 7 项 `error=2` 是另一个问题：glibc 二进制依赖 `/lib/ld-linux-aarch64.so.1`，Android 没有该路径。这不能单独证明任何结论，需要完整 rootfs 才能测。

## 与 dsh-Go 的差异

dsh-Go 的 `targetSdk = 28`（`app/android/app/build.gradle.kts` 注释：*"targetSdk 28 is deliberate; not a Play build"*，架构文档说明「与 Termux 同，避开 Android 10+ 对私有目录 exec 的限制」）。

本批在 `targetSdk 36` 下测试，结论与上述说明一致：**36 下 PRoot 无法引导 rootfs 内二进制**。

## 下一步选项

| 方案 | 做法 | 代价 |
|---|---|---|
| A | `targetSdk` 降到 28 重测 | 放弃 Play 上架；需确认 Android 17 仍尊重该兼容行为 |
| B | rootfs 放 `/data/local/tmp` 或外部存储 | 需 root；普通用户不可行 |
| C | 放弃 PRoot，改用 bionic Node | 原生模块需重编译 |
| D | 限制能力集，不依赖 shell | 放弃终端、工作区、插件 |

**方案 A 是唯一可能保留「全部能力」的路径**，但它把整个产品绑定在旧版兼容行为上，且需要独立 ADR 说明安全边界变化。

## 未验证项

- `targetSdk 28` 下本批各项是否通过
- 应用进程内的完整 Ubuntu rootfs（本批只复制了 lib 与 node，未复制 `/bin`、`/usr`）
- 前台服务、功耗、升级保留数据
