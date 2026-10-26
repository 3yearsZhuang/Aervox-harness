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

Android 原生编译使用仓库锁定的 JDK 21 和 Gradle wrapper，要求 SDK platform API 36、Build Tools 35.0.0。AGP 优先使用本机 `apps/mobile/android/local.properties` 中的 `sdk.dir`，再读取 `ANDROID_HOME` 或兼容的 `ANDROID_SDK_ROOT`；预检始终核对所有已配置来源，绝对路径规范化后必须指向同一 SDK，符号链接可指向同一实际目录。冲突在生成资源之前失败，向子进程注入环境变量不能覆盖 `sdk.dir`。没有显式路径时，预检检查当前平台的默认 SDK 目录并将发现的路径传给构建子进程。脚本不会安装 SDK、接受许可或修改用户配置，Gradle 自动 SDK 下载也已关闭。

JVM 预检分别检查 `JAVA_HOME`/PATH 启动器及 Gradle 实际配置的 JDK。`GRADLE_USER_HOME`（缺省 `~/.gradle`）中的 `gradle.properties` 优先于工程 `android/gradle.properties`，其中 `org.gradle.java.home` 会覆盖 `JAVA_HOME`，也须选择 JDK 21～24。显式 daemon JVM criteria、JVM 启动选项中的 Java/Gradle 用户目录覆盖及 `systemProp.org.gradle.java.home` 不在此预检的解析范围，检测到时明确失败，由调用方先处理本地配置；不把 mise 注入的 JDK 当成覆盖所有 Gradle 设置的保证。

```sh
mise exec -- pnpm --filter @aervox/mobile android:check
mise exec -- pnpm --filter @aervox/mobile sqlite:restore
mise exec -- pnpm --filter @aervox/mobile sqlite:check
mise exec -- pnpm --filter @aervox/mobile android:build
```

`sqlite:restore` 是显式网络恢复步骤，仅从固定的 SQLite 官方 HTTPS 地址读取 3.54.1 AAR，按固定长度及 SHA3-256 验证后发布到忽略的 `android/vendor/`；既有无效文件保留并报错，不自动覆盖。`sqlite:check` 只做本地校验。`android:build` 先预检与校验该制品，再生成唯一 Schema 资产、构建 Web、同步 Android、运行 `assembleDebug`；任一步失败均停止，缺失或篡改的 SQLite 不会触发隐式下载。直接运行 Gradle 也会在 preBuild 校验固定长度与摘要。首次 Gradle 构建需要网络获取已声明的 Gradle/Maven 依赖。debug APK 输出在 `apps/mobile/android/app/build/outputs/apk/debug/`。它使用调试签名，不是发布包。

设备检查需要一个已开启 USB 调试并授权的目标，多个目标时通过 `ANDROID_SERIAL` 选择：

```sh
mise exec -- pnpm --filter @aervox/mobile android:check:device
```

预检成功仅证明所检查前置；APK 编译、真机安装、生命周期、业务持久化和发布分别验收。原生工程默认关闭自动备份和明文网络；不在源码或构建配置写模型密钥、签名凭据。生成的 Web assets、Gradle 输出、SDK 本机路径及 keystore 不进入 Git。

工程基于 `@capacitor/cli@8.5.1` 的官方 Android 模板，运行时为 `@capacitor/android@8.5.1`。模板版权与 MIT 许可见 [LICENSE.capacitor](android/LICENSE.capacitor)；Gradle wrapper 保留其内置许可。平台要求参考 [Capacitor 环境文档](https://capacitorjs.com/docs/getting-started/environment-setup)，版本升级时同时核对 [Gradle JVM 兼容表](https://docs.gradle.org/current/userguide/compatibility.html)。

## SQLite 隔离探针

固定制品为 [SQLite 官方 Android 3.54.1](https://sqlite.org/download.html)，SHA3-256 为 `3afb0568a107d753b640e4d65cdb1d9a2247e9833c25e72ca7d1086b78365de1`。AAR 不进入 Git，恢复失败不会改写业务数据库。SQLite 核心为 public domain，Java 绑定和静态链接的 LLVM 运行时分别保留其许可，随 APK 分发的原文见 [licenses](android/app/src/main/assets/licenses)。

`SQLiteCapabilityProbe` 仅建立应用 no-backup 目录下的唯一临时库，验证实际引擎版本、RETURNING、JSON/NUL、FTS5、外键、事务回滚与关闭重开，最后清理库文件；不接收外部路径、SQL 或业务 Schema，不注册 Capacitor Bridge，也未由 MainActivity 调用。设备测试入口为 `:app:connectedDebugAndroidTest`，先运行 `android:check:device` 并明确选择已授权目标。仅编译 `:app:assembleDebugAndroidTest` 不代表探针执行成功。

官方 AAR 的默认 Manifest 允许备份，本应用显式覆盖为 false，明文网络继续关闭；合并 Manifest 和设备断言分别取证。制品包含 arm64-v8a、armeabi-v7a、x86、x86_64 四 ABI；静态 ELF 检查中两个 64 位库的 LOAD 对齐为 16 KiB，两个 32 位库为 4 KiB。APK zip 对齐和 ELF 静态属性不替代设备加载或 SQL 合同执行，实际 16 KiB 设备仍待验收。当前 UI 仍使用 API Transport，探针及制品编译均不等于手机业务持久化或独立运行完成。

主库 Schema 资产由根命令 `mise exec -- pnpm mobile:schema` 从唯一仓储声明生成，包含现有版本/发布指纹、空库 DDL、参数化 journal 和可重建 FTS；不复制业务数据，不生成手机恢复账本。资产仅作构建输入，Git 忽略；生成回执的 SHA256 是字节证据，不是认证。原生消费者仍须证明空库、原子初始化与物理结构校验后才能写版本回执，未知旧库继续拒绝写入。本切片未将资产应用于手机业务库。
