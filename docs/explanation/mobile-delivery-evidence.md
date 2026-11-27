---
id: AVX-EXPL-018
---

# ITER-009 移动端已有交付与历史证据

本文件是 [plan.md](../../plan.md#iter-009) 中 ITER-009 条目的证据附页。计划本体只保留当前状态、剩余验收与依赖；逐条测试计数、失败复验过程与实现细节在此保存。

**时点性：** 下列能力结论对应各段写明的提交与 PR，**不代表当前检出已通过同样验证**。当前状态仍以 plan.md 的 ITER-009 条目与[追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)为准。

逐条测试计数、失败与复验过程由 PR/CI 保存；本节只保留能力结论、未覆盖范围与仍开放门槛。

**平台选择：** 比较九个硬件方向、电脑依赖、目标 OS、真实 Provider、成本与数据边界后，维护者选择手机独立运行、电脑关闭后仍可使用，并确认 Android 先行；iOS 工程尚未创建。本轮实时可见 Android SDK API 36 与 adb。关联 [ITER-016](../../plan.md#iter-016)。

**工程与内核前置（已交付）：** 显式 Web 构建、Android 同步/doctor、只读环境预检与 debug 构建命令（Java 21 固定于 mise，Gradle 分发带校验值；模板源码与许可入库，资源复制、SDK 路径、签名密钥与构建产物不跟踪，自动备份与明文网络默认关闭）。独立端内核入口：`@aervox/core/browser`（整包不含 Node/CLI）、`@aervox/host-agent/browser` 的执行 Store 与仓储 Port、`/database` 注入式装配、`/conversation` 共享 SQL 命令、原生候选值协议、未注册的 `NativeMessageChannel` 与 `/native-sqlite-client`。这些入口不导入 Node、SQLite 驱动或 Vue；**严格上游 Drizzle 声明闭包未通过这一限制如实保留**，`skipLibCheck` 消费者检查不算严格声明通过。

**原生能力（已交付）：** 固定 SQLite 3.54.1 官方制品（HTTPS 恢复按长度/SHA3 验证，缺失或篡改阻断构建）；原生隔离临时库；Keystore AES-GCM 凭据槽（私有 no-backup 密文、AAD 身份/版本、进程与文件锁、原子替换，丢密钥不补建）；Java 专用写者（epoch/事务持有者、有限语句/参数/结果/队列、单次首窗、终态隔离、关闭后确认 drain）；固定资产 WebView Host（首次加载前全新随机 Profile、按 Profile 阻断 Service Worker/网络、导航/重载销毁旧所有者）。未接生产初始化，未授予 JS SQL 权限。

**确定性夹具证据：** Android 17/API 37、arm64、4 KiB 物理设备仪器测试 78/78 通过，原生运行时接线批次 46 项全部通过；同规格 16 KiB 隔离模拟器 76 项通过、无跳过。覆盖 RETURNING、JSON/NUL、FTS5、FK、失败事务回滚与重开、Keystore、严格 JSON/WebMessage、跨源 iframe、零列 DML 取消、事务身份、超窗回滚、队列 drain、默认 Cookie 不被改动。默认入口冷启动显示 Mizuki；缺模型发送明确拒绝并保留草稿；实际 force-stop 后新进程恢复选中会话与完整草稿（含 1799 字符）。**这些不证明** 16 KiB 物理设备、其他 ABI/版本矩阵、后台可持续运行、真实 Provider、执行中终止完整矩阵、工具问答、跨版本覆盖升级或正式签名。

**界面与操作（已交付）：** Material 3 统一（官方 Material Web 控件、品牌生成浅/深色角色、48px 触控、tonal surfaces）；同页会话列表/新建/切换/持久回看、常驻多行输入、按会话草稿、原生 IME→WebView 历史→系统返回的逐层返回；短视口收起角色并解除叠放，常规视口用舞台裁切（舞台 `clamp(280px, 42dvh, 480px)`、角色盒撑到 `clamp(440px, 72dvh, 720px)` 后被下边界裁切）；缺模型反馈移入独立布局行以免被裁切。WebView 不接收模型密钥、任意 URL/header 或 shell。

**预算与生命周期修复（已交付）：** 文本输入 32 KiB UTF-8 / 120 KiB JSON、回复累计 48 KiB，越界保留安全尾段并提交 `Interrupted(model_length)`。首次就绪前的文档退休观察、后台区间跨过的配置查询拒绝未接单发送、已提交接单的迟到回执经共享取消事务收尾。恢复用例证明有效 Running/CancelRequested 租约不抢占、过期后收敛、拒绝旧 fencing、不重跑模型——但这不是 Android 实际杀进程。

**依赖与安全修复（已交付）：** 普通应用 UID 下硬链接归属标记被 SELinux 拒绝，改为独占创建与保守拒绝；同一短同步区完成 actor 创建与绑定；API 24/25 的 root/Shizuku Process 操作改用有界单调时钟等待，API 26+ 保留原生 timed wait 并请求 destroyForcibly。

**相关 PR：** 主仓 [PR #353](https://github.com/3yearsZhuang/Aervox-harness/pull/353)、[PR #356](https://github.com/3yearsZhuang/Aervox-harness/pull/356)、[PR #372](https://github.com/3yearsZhuang/Aervox-harness/pull/372)；集合仓 [PR #7](https://github.com/Aervox-agent/Aervox-plugins/pull/7)、[PR #8](https://github.com/Aervox-agent/Aervox-plugins/pull/8)、[PR #15](https://github.com/Aervox-agent/Aervox-plugins/pull/15)。
