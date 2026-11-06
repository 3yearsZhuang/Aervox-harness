# Android 工程

此工程按 [ADR-022](../../docs/reference/adr/ADR-022-mobile-runtime-access.md) 的 Android 先行方向维护。当前分支将默认 Android 入口接到固定 APK 资产、本机 SQLite、共享仓储/Core 和原生持钥模型请求，继续交付前台文本对话原型。普通浏览器的移动 Web 预览仍使用 API Transport；手机的 `127.0.0.1` 不指向电脑。代码接线、真机闭环、真实模型与签名发布分别验收，不能由安装成功推定整个 M0 已完成。

在仓库根通过 mise 运行命令，依赖统一在根安装：

```sh
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @aervox/mobile build
mise exec -- pnpm --filter @aervox/mobile preview
```

`build` 只验证移动 Web 构建，不调用 Gradle。以下命令仍用于 Capacitor 工程同步和检查，不更新默认独立入口的 `m0/` 资产；构建可运行的独立调试包使用后面的 `android:build`：

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

`sqlite:restore` 是显式网络恢复步骤，仅从固定的 SQLite 官方 HTTPS 地址读取 3.54.1 AAR，按固定长度及 SHA3-256 验证后发布到忽略的 `android/vendor/`；既有无效文件保留并报错，不自动覆盖。`sqlite:check` 只做本地校验。`android:build` 先预检与校验 SQLite 制品，在仓库根校验产品子模块并按依赖图构建 Web 上游包，再生成唯一 Schema 资产、按 `/m0/` 基址构建移动 Web、同步 Android、验证并准备固定原生资产，最后运行 `assembleDebug`；任一步失败均停止，缺失或篡改的制品不会触发隐式下载。直接运行 Gradle 也会在 preBuild 校验固定长度与摘要。首次 Gradle 构建需要网络获取已声明的 Gradle/Maven 依赖。debug APK 输出在 `apps/mobile/android/app/build/outputs/apk/debug/`。它使用调试签名，不是发布包。

执行中强停的确定性测试使用独立包名 `com.aervox.mobile.terminationprobe`，在根运行 `mise exec -- pnpm --filter @aervox/mobile android:build:termination-probe`，APK 输出到 `android/app/build/outputs/apk/deterministicProbe/`。专用模型只提交一个固定安全前缀后等待取消，其他模型操作拒绝；SQLite、Core、租约与原生消息通道仍走实际实现。测试资产仅进入该 variant，普通 debug/release 使用生产资产。探针与日常安装的库、凭据槽及进程隔离；其结果只证明确定性场景，不能代替真实 Provider 或完整终止矩阵。

设备检查需要一个已开启 USB 调试并授权的目标，多个目标时通过 `ANDROID_SERIAL` 选择：

```sh
mise exec -- pnpm --filter @aervox/mobile android:check:device
```

预检成功仅证明所检查前置；APK 编译、真机安装、生命周期、业务持久化和发布分别验收。原生工程默认关闭自动备份和明文网络；不在源码或构建配置写模型密钥、签名凭据。生成的 Web assets、Gradle 输出、SDK 本机路径及 keystore 不进入 Git。

工程保留 `@capacitor/cli@8.5.1` / `@capacitor/android@8.5.1` 的官方 Android 模板与构建依赖，默认 `MainActivity` 继承自独立 `NativeRuntimeActivity`，不注册 Capacitor 插件或远程页面。模板版权与 MIT 许可见 [LICENSE.capacitor](android/LICENSE.capacitor)；Gradle wrapper 保留其内置许可。平台要求参考 [Capacitor 环境文档](https://capacitorjs.com/docs/getting-started/environment-setup)，版本升级时同时核对 [Gradle JVM 兼容表](https://docs.gradle.org/current/userguide/compatibility.html)。

## 首次独立对话

1. 使用 `android:build` 生成并安装调试包，打开“设置 → 本机运行”，核对本机存储状态。
2. 点击“配置模型服务”，在原生界面填写 HTTPS 基础地址、模型名和密钥。地址不包含 `/chat/completions`；当前前台原型不接受 IP 字面量、localhost、自定义请求头或重定向。
3. 保存后可点击“测试连接”，由原生层向当前配置发起有界诊断。再返回对话页，新建会话并发送文本；密钥缺失时拒绝接单并保留输入，不生成一条假失败消息。
4. 回复期间可停止或回看；删除正在执行的会话须先停止并等待执行结束。模型流先经 Core 与仓储安全提交，再进入共享客户端投影。

原型只运行前台文本请求，提供截止、大小与事件数量限制。离开前台会请求取消原生网络；不承诺后台续跑或定时常驻。无处理器的接口明确拒绝，不回退到电脑 API、浏览器数据库或模拟成功。当前能力与后续系统授权、Shizuku、root 边界见 [ADR-022 的分级](../../docs/reference/adr/ADR-022-mobile-runtime-access.md#能力交付与授权分级)。

## 向用户提问

模型可调用 `ask_user_question` 暂停本轮并等待回答。手机没有独立服务端，挂起由 [提问桥](../web/src/mobile/native-question.ts) 在同进程持有：问题直接交给正在观察的界面（不伪造持久事件），用户提交答案后原轮次继续，工具结果按普通工具回执写入事件流。同一时刻只允许一个待答问题；切换会话、停止、进入后台或宿主退休都会以固定错误码释放等待，不会让循环悬停。提问预算为 120 秒，工具声明自带该预算而不沿用设备动作的 12 秒；本轮总预算仍是 180 秒。进程被杀死时挂起随进程消失，重新打开后该轮按既有恢复规则收敛，不会自动重放提问或工具。

每条输入最多 32 KiB UTF-8，JSON 字符串正文编码后最多 120 KiB，超限在接单前拒绝。每次回复正文的累计 JSON 编码最多 48 KiB（均不含字符串两端引号），中文、emoji、引号和控制字符按实际编码计量；思考字段另受现有流总量预算约束。越界分片不提交，已接收的安全前缀保存为带 `model_length` 原因的 `Interrupted` 回合，界面显示未完成，重开后仍可回看。此预算同时给原生 SQL 绑定、接单 Outbox 和单轮历史回执保留空间，不依赖模型服务遵守请求的 token 参数。

## 固定原生资产

默认独立入口只加载 APK 内第一方脚本，禁止外部脚本、网络页面和 Service Worker。Live2D 使用本地固定 Cubism Core 制品，不依赖运行时 CDN；缺失或摘要不符时准备步骤失败。冷检出用 `pnpm --filter @aervox/mobile prepare:native:restore` 显式恢复：脚本只接受固定官方地址、207155 字节与 SHA-256 `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f` 的字节，已存在但不匹配的文件会被拒绝而不是覆盖。构建本身仍只核验、不隐式下载或改写业务库；CI 的 [Android 工作流](../../.github/workflows/android.yml) 与 `sqlite:restore` 按同样顺序恢复固定制品。

Cubism Core 保留 Live2D 原始版权和许可头，适用 [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。本分支调试和设备验证不等于正式分发许可、签名发布或商店验收；发布前另核对 Live2D 与角色资产的适用条款。

## SQLite 隔离探针

固定制品为 [SQLite 官方 Android 3.54.1](https://sqlite.org/download.html)，SHA3-256 为 `3afb0568a107d753b640e4d65cdb1d9a2247e9833c25e72ca7d1086b78365de1`。AAR 不进入 Git，恢复失败不会改写业务数据库。SQLite 核心为 public domain，Java 绑定和静态链接的 LLVM 运行时分别保留其许可，随 APK 分发的原文见 [licenses](android/app/src/main/assets/licenses)。

`SQLiteCapabilityProbe` 仅建立应用 no-backup 目录下的唯一临时库，验证实际引擎版本、RETURNING、JSON/NUL、FTS5、外键、事务回滚与关闭重开，最后清理库文件；不接收外部路径、SQL 或业务 Schema，不注册 Capacitor Bridge，也未由 MainActivity 调用。设备测试入口为 `:app:connectedDebugAndroidTest`，先运行 `android:check:device` 并明确选择已授权目标。仅编译 `:app:assembleDebugAndroidTest` 不代表探针执行成功。

官方 AAR 的默认 Manifest 允许备份，本应用显式覆盖为 false，明文网络继续关闭；合并 Manifest 和设备断言分别取证。制品包含 arm64-v8a、armeabi-v7a、x86、x86_64 四 ABI；静态 ELF 检查中两个 64 位库的 LOAD 对齐为 16 KiB，两个 32 位库为 4 KiB。Android 17/API 37、arm64、16 KiB 隔离模拟器已实际通过完整原生仪器测试，默认入口冷启动、本机存储与 Live2D 渲染另有验证，证据见 [ITER-009](../../plan.md#iter-009)。APK ZIP 对齐、单一模拟器和隔离探针不代表物理手机、其他 ABI/版本或正式平台矩阵通过。

主库 Schema 资产由根命令 `mise exec -- pnpm mobile:schema` 从唯一仓储声明生成，包含现有版本/发布指纹、空库 DDL、参数化 journal 和可重建 FTS；不复制业务数据，不生成手机恢复账本。资产仅作构建输入，Git 忽略；生成回执的 SHA256 是字节证据，不是认证。`NativeBusinessDatabase` 只对独占新建文件执行该资产的 DDL、FTS 和版本回执事务；既有库必须通过归属、版本和完整物理结构检查，未知旧库继续拒绝写入，不自动采用或迁移。

`NativeExecutionProbe` 接续验证原生执行 API，仍只接受 Context 并建立唯一临时库，不接受外部 SQL/路径或注册桥。独立写者线程绑定原生类型，只取一次 CursorWindow 并直接复制首窗：整结果不在首窗时拒绝，在事务内回滚，避免 Cursor 补窗重跑 RETURNING。它还验证 NUL、浮点位、大整数、BLOB、协作取消、关闭重开和线程 drain；固定 64 KiB 窗口实验显式要求 API 28，不能据此宣称 Android 正式最低版本。

可移植空库测试以 `NO_LOCALIZED_COLLATORS` 开库，保留空库/物理结构断言；默认 opener 会生成 `android_metadata`，另有设备反例，不能把默认开库后的额外表忽略为通过。原生 Java API 尚未提供完整声明列类型、prepare-tail/authorizer/autocommit 证明，本探针不替代通用 SQL 权限与生产初始化。

## 原生凭据存储前置

`NativeCredentialStore` 仅供受信原生调用者使用，固定 `PRIMARY_MODEL` 槽位，不接受外部路径或任意 Keystore alias。`NativeModelService` 使用同一槽保存原子的端点、模型和密钥记录；配置输入在原生弹窗内处理，WebView 只读取无密钥摘要。它用 Android Keystore 的不可导出 AES-256 包装密钥加密最多 8192 字节凭据，AES-GCM 的 AAD 绑定用途、槽位和版本；密文保存在应用 no-backup 私有目录。调用者负责及时擦除拿到的明文 byte[]；明文暂存于原生内存不等于可从 WebView 读取。原生配置窗口开启 `FLAG_SECURE`，错误不返回模型服务正文或凭据。

进程锁与固定文件锁串行化读写，替换前必须认证既有密文；丢失密钥、认证失败或未知版本保留文件并返回固定错误码。base/backup/stage 都算已有证据，不会因主文件缺失创建替代密钥；中断文件返回 `RECOVERY_REQUIRED`，不自动猜测恢复。显式 clear 只删除该槽的三类密文并保留包装密钥，覆盖旧 Android AtomicFile 对 staging 文件的版本差异。写入失败先恢复旧版；全部断电/目录元数据持久性与设备 Keystore 行为仍待实际验证。

设备测试为每项创建随机隔离目录和测试专用 alias，覆盖非导出密钥、随机 nonce、丢密钥、篡改、AAD、版本/大小、提交前失败和 backup/stage；清理不触及真实槽。`:app:assembleDebugAndroidTest` 只编译这些测试，实际执行与真实模型网络分别验收。

## 原生值与消息通道前置

`NativeSqliteValues` 只转换受限类型：有限 REAL 输入、规范 int64、文本/NUL、空值和十六进制 BLOB；结果另保留负零和正负 Infinity。它不创建连接或执行 SQL，与仓储的 `/native-sqlite-values` 共用值约定。Android `org.json` 的往返与拒绝测试属于设备测试，编译通过不代表原生运行已通过。

`NativeMessageChannel` 由固定原生宿主在首个页面加载前注册，只使用 AndroidX WebKit 的 WebMessageListener，固定 HTTPS localhost，并逐消息检查 WebView 身份、主帧与来源；功能不支持或注册失败即关闭，不回退到 JS interface。请求/响应分别限制 1 MiB/4 MiB、JSON 深度 32、同时在途 8 项；严格流式预校验先于 JSONObject 解析，错误只返回固定码。完成后回包仍核对活动票据；close 撤销回包，不代表已接受原生工作被撤销或回滚，执行器须另行 drain。

通道限于一个 WebView 的完整生命周期，同一个实例不重装；换文档时调用者必须关闭并销毁/重建 WebView，来源信息不能证明文档代际。启用前还须固定 APK 资产来源并排除不受信脚本，不能把固定 origin 当成资产认证或同源脚本沙箱。默认独立入口只注册受限 SQLite、模型、UI 偏好和运行摘要命令；凭据读取、任意文件路径、shell 命令及第三方插件均不开放。纯 JVM 策略、原生测试编译与真实 WebView 设备验证分别记录。

## M0 运行时接线

`NativeSqliteSession` 是只在原生代码中构造的单线程写者，初始化回调必须交付固定且已验证 Schema 的私有库；该回调不向 JS 暴露。它独立核对原生生成的 epoch/事务身份，事务持有者排他，根语句自带 IMMEDIATE 事务。结果只读取一个 1 MiB 首窗，超过 512 行/128 列或 3 MiB 编码结果即拒绝；参数、SQL 和队列另有上限。声明列类型明确为未知空串，不伪造完整 libsql 元数据。只接受受信仓储的有限 positional 数据语句，拒绝路径/DDL/PRAGMA/ATTACH/脚本/扩展，词法子集不当通用 SQLite authorizer。

5 秒信号只请求协作取消，不承诺原生强杀或提交硬截止；终态异常隔离连接，不根据 Java inTransaction 判断原生提交结果。dispose 只在已接受任务退出、游标/事务/连接池实际关闭后确认 drain；未知先前 commit 仍须查原回执，不能自动生成新业务键或重新发模型。固定业务初始化由 `NativeBusinessDatabase` 完成，SQLite 消费者限定为第一方捆绑的中性仓储装配。

`NativeBusinessDatabase` 固定打开应用 no-backup 下的 `aervox-m0/main.db`，进程/文件所有权持续到 SQLite actor 确认 drain。首次只采用独占新建的文件，DDL、FTS 与版本回执在同一事务；数据库与外部归属标记持久化后才开放使用。既有库须有本方完整标记、匹配 inode/设备与固定 Schema。有效归属下的热/冷 rollback journal 由 SQLite 自行恢复；未知库、无效标记、外来 WAL/SHM、额外表或结构不符均保留并拒绝，不清库或猜测修复。该归属边界不抵抗 root 或任意同 UID 篡改。

`NativeAssetWebViewHost` 由默认独立入口创建，固定只读 APK `m0/` 资源；首文档前建立全新独立 Profile、禁该 Profile 的 Service Worker 及外部网络，再注册消息通道。不支持 MULTI_PROFILE 或消息功能直接不可用，不使用默认 Capacitor Profile。导航/重载/渲染进程退出会关闭通道并销毁旧 WebView；原生工作仍须另行 drain。仅清理私有登记的随机 Profile，保留失败记录并限制累计数量；删除请求可能异步，不能作为磁盘擦除证明。

## 设备操作（Root）

默认入口只在用户明确授权后向助手声明设备动作。没有任何授权（或 root 不可用）时，请求里不出现设备工具声明，只有无副作用的 `ask_user_question` 始终可用；普通文本对话不受设备授权影响。

固定动词只有 `input tap`、`input swipe`、`input keyevent`、`input text` 与按包名启动的 `monkey` 调用。坐标、按键名、文本与包名在 [原生策略](android/app/src/main/java/com/aervox/mobile/runtime/NativeDevicePolicy.java) 层逐项校验，命令行由固定动词与已校验 token 拼成，不接受脚本、路径、管道或额外参数，模型无法提交新的动词。文本只接受可打印 ASCII（最多 200 字符），中文等字符直接拒绝而不是静默打错。

“控制手机”和“打开应用”两项授权默认关闭，逐项开启，开启前要求 root 可用。每次工具清单与审批都重新读取原生授权，应用不在前台时执行请求被拒绝；命令串行执行、8 秒超时、输出最多 4 KiB，非零退出明确返回失败。root 只是这些固定动作的执行通道，不提供任意 shell、第二执行器或系统设置修改，[ADR-022 的能力分级](../../docs/reference/adr/ADR-022-mobile-runtime-access.md#能力交付与授权分级)保持不变。设备动作只在助手被明确要求操作手机时使用；模型未收到工具声明时，界面不会假装执行。

## Android 界面

启动使用 Android 系统启动屏及现有品牌标识，浅色/深色背景与 Material 3 界面一致；本机数据库和实际界面组件就绪后淡出交接，不另显示纯文字等待页，也不等待 Live2D 资源全部加载。初始化失败会显示原有数据保留提示；30 秒仍未交接时停止启动并提示重开，已有数据按原有关闭规则保留。

显式 mobile 构建采用 [Material 3](../../docs/reference/DESIGN.md#11-androidmaterial-3)：官方 Material Web 按钮、开关、弹窗和设置标签配合品牌色生成的浅色/深色角色，统一 Roboto/系统中文排版、48 px 触控、tonal surface 与状态反馈。仅开启 mobile 构建不会改变普通 Web/桌面外观；系统主题和已有手动选择继续有效，未接壁纸动态色或外部字体服务。

应用自建的原生模型配置与不可用页使用官方 Material Android 1.13.0 和同源品牌色角色，系统栏随浅/深色调整对比。模型表单使用清晰标签、outlined 字段、行内错误和保存进度，键盘下可滚动；密钥继续在受保护的原生窗口中输入。不可用页保留数据提示、滚动和安全区，并提供关闭应用动作。桌面图标、启动屏和通知复用现有 Aervox 品牌标识，桌面图标支持自适应遮罩及 Android 13 主题图标；系统权限、文件选择和分享窗口保持 Android 原生流程。

默认原生入口展示已接入的会话、学习、记录、日记及本机运行设置，保留输入/IME 和取消/观察。角色区域加载时显示状态，Mizuki 就绪后显示真实模型；加载失败提供重试入口。既有表单与抽屉使用语义令牌适配；视觉统一与原生独立业务接线分别验收。

未配置模型服务时，发送前的明确拒绝在角色对话框中提示，并提供配置入口；待发送草稿保留。完成配置后由用户再次发送，不自动重放。

输入和语音、发送/停止操作位于同一个玻璃输入栏，语音键紧邻发送/停止键，不叠加上方标签或提示行。配置提醒、接收失败与恢复操作、语音状态留在角色气泡内；文本附件在工具卡查看和移除。

手机常规竖屏放大角色，对话框可覆盖下半身，输入区保持在前景；软键盘或短视口出现时收起角色并解除叠放，优先保留对话和输入空间。

手机设置采用全屏布局，固定标题、关闭与分类入口。默认原生入口的“本机运行”按存储、前台运行、模型与功能范围分组；“已保存配置”不表示网络已连通，“测试连接”只证明当前配置的一次有界原生请求，实际对话与持久化仍另行验证。模型地址、模型名和密钥通过明确按钮打开原生配置弹窗。普通 Web 的模型/角色/语音面板仍使用单列表单和一致的记录、操作组；键盘弹出时按可见视口滚动，面板切换保留已有草稿。新建/删除提示独立处理返回，操作和校验反馈显示在当前页面。

## 移动操作

- 底部会话、回看和设置在同一移动界面操作，不要求跳转到桌面工作台。回看读取已保存的分页记录，不切换当前会话、不触发模型或取消。
- 已显示完的回复可一键复制或朗读：朗读交给系统 TTS 引擎，只接受当前显示的文本（最多 4000 字符），仅前台可用、退后台停止；引擎缺失或初始化失败时按钮不出现或给出固定提示。
- 设备动作支持逐次审批：设置授权是前置门槛，每一次新动作仍生成待决授权并中断为
  `Interrupted(pending_approval)`，界面卡片批准/拒绝后续跑执行；相同 (工具, 参数) 的动作
  复用既有授权不再询问，全部决定落共享授权账本可审计。
- 输入框支持一次性语音输入：麦克风按钮调起系统识别器（仅前台、12 秒预算、单结果），识别文本追加到草稿后可继续编辑或发送，取消或退后台立即结束待决识别；RECORD_AUDIO 在首次使用时按用途请求，拒绝或无识别器时给出固定提示，不静默吞错。
- 回看面板可把整段对话导出为可读文本并交给系统分享面板：只包含当前可显示的记录，被撤权内容标记为“不可显示”，中断轮次注明状态；单次上限约 256 KiB，超出会截断并注明。分享只交给系统选择器，应用不写入外部存储。
- 人格设置读写本机 SQLite：新建后启用，保存后启用最新修订；对话与审批续跑读取已激活的修订，单次执行内保持设定一致。人格设定不替代设备授权与逐次审批。
- 首页可读取、按需生成或改写今日日记，改写保留历史版本；未配置模型时明确使用模板。模型截断或异常终止不会发布半篇日记，也不会被学习计划当作完整模型结果。
- “设置 → 学习与复习”可开始或恢复 3 题练习，逐题作答并查看完成报告；也可完成今日复习、查看已有目标与计划。题库为空时引导到数据管理导入；未知作答结果复用同一答案和幂等键重试。
- 今日复习在本地业务真源上闭环：到期清单、按本地日界汇总（逾期/今日/预计分钟）、完成历史，以及完成后的掌握度更新与间隔重排；排期策略与桌面共用 `@aervox/practice-review`，重放同参返回同一回执、异参拒绝。
- 学习面其余端点亦已接入本地仓储：学习目标（含幂等创建）、题目创建与作答历史、练习会话（3–5 题、断点恢复、完成报告）、作答判分与幂等重放、错题本（筛选/错因/掌握度处置）、知识点读取、学习计划读取/任务勾选/归档。判分、排期、报告组装与桌面共用 `@aervox/practice-review` 纯函数。
- 从文件或链接导入题库：系统文件选择器单文件授权（不索取存储权限），或粘贴 https 链接，后台读取 2 MiB 内的 JSON/CSV 文件，提供方或网络读取有 12 秒总预算；入库内容另受 1 MiB UTF-8 预算约束。
- 复习提醒：每天 9 点的本地通知（POST_NOTIFICATIONS 开启时按用途请求，不精确对时、可随时关闭）。
- 备份导出：本机业务数据在单一快照中分页导出为自描述备份（每表列形状 + SHA-256 摘要），通过有序分片写入应用缓存并分享 JSON 文件，上限 16 MiB；模型密钥、插件凭据、设备连接和派生搜索索引不进入备份。已分享文件至少保留 1 小时供接收方读取，后续导出时清理过期文件，总缓存上限 64 MiB。超过当前原生单值或窗口预算的记录明确拒绝导出，不能将此原型视为任意大小数据库的完整备份方案。
- 备份恢复暂不可用：旧版会话删除未保留完整的历史删除事实，空的删除记录表不能证明旧备份不会带回已删除内容。所有本机安装的 `importBackup` 都固定返回 `409 BACKUP_RESTORE_HISTORY_UNVERIFIED`，在解析、恢复准入和原生 SQL 之前拒绝；界面禁用恢复入口，现有数据、导出和日常读写继续可用。重新开放须先明确可信历史边界及持久删除/拒绝记录的重放责任，旧安装的历史缺口不能靠新增记录追补；相关工作由 [ITER-003](../../plan.md#iter-003)、[ITER-010](../../plan.md#iter-010) 与 [ITER-011](../../plan.md#iter-011) 协调。
- 题库外部导入（CAP-023 SPI）同样接通：内联 JSON/CSV 文本按注册提供方解析（支持格式提示与内容嗅探），逐题入库并带解析/难度/标签；内容上限 1 MiB，与桌面 Fastify 体限制对齐。
- 学习计划的 AI 生成（`/v1/learning-plans/generate`）经原生模型桥做单次结构化调用，与桌面共用同一条生成管线（提取 JSON → 结构校验 → 带 gaps 定向重试一次 → hydrate）；两次仍不合法返回 `PLAN_GENERATION_FAILED`，模型桥错误按其固定码透传。
- 会话列表可改名或删除已保存的会话：改名只有宿主确认后才更新标题，删除需二次确认；删除当前会话后切换到剩余会话，列表为空时新建对话，该会话未发送的草稿随删除一并清除。正在回答或等待交互的当前会话须先停止再删除。
- 常驻多行输入，Enter 换行，点击发送（外接键盘可 Ctrl/Cmd+Enter）；中文组合回车不发送。草稿按会话保存，切换和重开可恢复；接单回执只清理它拥有的旧草稿，保留后来编辑的内容。
- 提交、观察、待答、待批和未知回执期间可浏览列表与历史；实际新建/切换需等待当前操作结束或明确停止。未知提交的重试复用原请求预留；明确拒绝不把用户锁在失效会话。
- Android 返回先收软键盘，再经 WebView 同文档历史关闭最上层弹窗或抽屉，根页面交还系统。手机输入框常驻，不额外注册输入编辑返回层；草稿在切换和重载后恢复，不增加历史步数。返回不调用业务取消；现有系统栏/IME inset 来源保持不变。整页界面切换先等待已请求的历史清理，失败时保留当前页面。

独立原生入口使用受限 `NativePreferences` 保存当前会话选择与未发送草稿，启动时先恢复同步内存适配；普通浏览器仍使用原有 localStorage。偏好缓存不存模型密钥，不作为会话、执行或幂等回执的业务真源。草稿持久化不等于持久执行断点；控制器的观察和重试预留仍有生命周期，进程恢复只退休过期执行，不重放模型或工具。完整 M0 的一次工具问答、真实模型、进程终止与设备矩阵仍须单独验收。
