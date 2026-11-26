# 第 0 批验证记录：PRoot 运行时可行性

**结论：PRoot 路线在真机验证通过。** 本文记录实际命令、环境与未验证项，不含推断。

## 环境

| 项 | 值 |
|---|---|
| 设备 | OPPO PMA110 |
| Android | 17 / API 37 |
| ABI | arm64-v8a |
| 页大小 | 4096（4 KiB，无 16 KiB 兼容问题） |
| SELinux | Enforcing |
| root | KernelSU，`su -c id` 返回 uid=0 |
| PRoot | Termux `5.1.107.102`（aarch64 deb） |
| 依赖库 | `libtalloc.so.2`、`libandroid-shmem.so`、`libandroid-support.so` |
| rootfs | `ubuntu-base-24.04.3-base-arm64.tar.gz` |
| Node | `v22.19.0-linux-arm64` |

## 验证结果

| 项 | 结果 | 证据 |
|---|---|---|
| PRoot 二进制可执行 | ✅ | `./proot --version` 输出 `5.1.107.102` |
| rootfs 挂载并可运行静态二进制 | ✅ | PRoot 内 `/bin/echo` 输出 `STATIC-TEST` |
| rootfs 内动态二进制 | ✅ | `/usr/bin/env` 正常运行 |
| **Node 启动** | ✅ | `node --version` 输出 `v22.19.0` |
| Node 读取系统信息 | ✅ | `os.totalmem()` 返回 `15957643264`（15.9 GB） |
| 内置原生模块 crypto（OpenSSL） | ✅ | sha256 计算正确 |
| 内置原生模块 zlib | ✅ | gzip 成功 |
| 内置 SQLite（`node:sqlite`） | ✅ | 建表、插入、查询往返正确，中文正常 |
| HTTP 服务监听 | ✅ | `127.0.0.1:38203` 监听并响应 |
| 本机 fetch 回环 | ✅ | 返回 `ok` |
| 事件循环 | ✅ | 100 ms 定时器准时（实测 102 ms） |
| 启动耗时 | ✅ | 约 120 ms |

## 关键发现：必须显式指定 PROOT_LOADER

初测时 rootfs 内所有动态二进制都失败，报 `interpreter (ld-linux.so) was not found`。我一度误判为 Android 17 的 seccomp 拦截，并建议降低 `targetSdk`。**这个判断是错的**，实际情况是：

PRoot 按安装前缀自动探测 loader（期望 `<prefix>/libexec/proot/loader`），在非标准布局下探测失败。显式设置后一切正常：

```sh
PROOT_TMP_DIR=<rootfs>/tmp \
PROOT_LOADER=<prefix>/libexec/proot/loader \
LD_LIBRARY_PATH=<prefix>/lib \
./bin/proot -r <rootfs> -0 <command>
```

**不需要降低 `targetSdk`。** 根因是我的目录布局，不是系统限制。

## 一条容易踩空的细节

`LD_LIBRARY_PATH` 必须同时包含 PRoot 自身依赖（`libtalloc` 等）与 rootfs 内库路径；若为验证 Node 而覆盖它，PRoot 自身会链接失败。正确做法是把 PRoot 的库放在独立目录，不要把 rootfs 的库路径塞进同一个变量。

## 未验证项

以下仍是开放问题，不能由上述结果推出：

- **第三方原生模块**：只验证了 Node 内置模块。`sharp`、`sqlite-vec`、`@vscode/ripgrep`、`sherpa-onnx-node` 未测。
- **Aervox API 实际启动**：只验证了其依赖的三项基础能力（SQLite、HTTP、事件循环），未部署 `node_modules`（约 1.1 GB）实测。
- **App 内运行**：以上全部通过 `adb shell`（uid 2000）执行，**未在应用进程内验证**。应用进程的 seccomp、SELinux 域与 shell 不同，这是最大的剩余风险。
- **运行时升级保留数据**：未测。
- **功耗与发热**：未测。
- **前台服务保活**：未测。

## 下一步

1. 把 PRoot 与 rootfs 装进 App 私有目录，在**应用进程内**重复上述验证。这是 ADR-001 退出条件 1 的真正判据。
2. 部署裁剪后的 `node_modules`，实测 Aervox API 启动。
3. 逐个验证第三方原生模块。
