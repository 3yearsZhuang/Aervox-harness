# Android 工程

此工程按 [ADR-022](../../docs/reference/adr/ADR-022-mobile-runtime-access.md) 的 Android 先行方向维护。当前可构建共享移动 Web UI、同步原生工程和显式生成 debug APK；手机本地持久化、凭据与模型桥尚未接线，安装壳不代表电脑关闭后的独立业务闭环已经完成。默认 UI 仍使用 API Transport，手机的 `127.0.0.1` 不指向电脑。

在仓库根通过 mise 运行命令，依赖统一在根安装：

```sh
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @aervox/mobile build
mise exec -- pnpm --filter @aervox/mobile preview
```

`build` 只验证移动 Web 构建，不调用 Gradle。需要更新 Android 中的 Web 资源时运行：

```sh
mise exec -- pnpm --filter @aervox/mobile cap:sync:android
mise exec -- pnpm --filter @aervox/mobile cap:doctor
```

Android 原生编译使用仓库锁定的 JDK 21 和 Gradle wrapper，要求 SDK platform API 36、Build Tools 35.0.0。SDK 路径可用 `ANDROID_HOME`、兼容的 `ANDROID_SDK_ROOT` 或本机 `apps/mobile/android/local.properties` 中的 `sdk.dir` 指定；两个环境变量同时设置时必须一致。脚本不会安装 SDK、接受许可或修改用户配置，Gradle 自动 SDK 下载也已关闭。

```sh
mise exec -- pnpm --filter @aervox/mobile android:check
mise exec -- pnpm --filter @aervox/mobile android:build
```

`android:build` 先预检，再依次构建 Web、同步 Android、运行 `assembleDebug`；任一步失败均停止。首次 Gradle 构建需要网络获取已声明的 Gradle/Maven 依赖。debug APK 输出在 `apps/mobile/android/app/build/outputs/apk/debug/`。它使用调试签名，不是发布包。

设备检查需要一个已开启 USB 调试并授权的目标，多个目标时通过 `ANDROID_SERIAL` 选择：

```sh
mise exec -- pnpm --filter @aervox/mobile android:check:device
```

预检成功仅证明所检查前置；APK 编译、真机安装、生命周期、业务持久化和发布分别验收。原生工程默认关闭自动备份和明文网络；不在源码或构建配置写模型密钥、签名凭据。生成的 Web assets、Gradle 输出、SDK 本机路径及 keystore 不进入 Git。

工程基于 `@capacitor/cli@8.5.1` 的官方 Android 模板，运行时为 `@capacitor/android@8.5.1`。模板版权与 MIT 许可见 [LICENSE.capacitor](android/LICENSE.capacitor)；Gradle wrapper 保留其内置许可。平台要求参考 [Capacitor 环境文档](https://capacitorjs.com/docs/getting-started/environment-setup)，版本升级时同时核对 [Gradle JVM 兼容表](https://docs.gradle.org/current/userguide/compatibility.html)。
