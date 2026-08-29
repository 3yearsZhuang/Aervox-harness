---
id: CR-023
type: reference
scope: change
owner: product-platform
doc_status: review-candidate
decision_status: accepted
delivery_status: planned
version: 0.3.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 60
sources:
  - docs/explanation/proactive-intelligence-mode.md
  - docs/reference/PRD.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/capability-composition.md
  - docs/reference/changes/CR-022-full-access-tool-permission.md
  - docs/reference/THREAT_MODEL.md
  - docs/reference/adr/ADR-008-cloud-first-local-port.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/adr/ADR-018-proactive-local-privacy-host.md
  - docs/explanation/health-data-integration-assessment.md
  - docs/explanation/home-assistant-integration-assessment.md
---

# CR-023 广域本地主动智能模式（CAP-033）

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-08-29

关联：[主动智能设计方案](../../explanation/proactive-intelligence-mode.md)、[CR-022 完全访问](CR-022-full-access-tool-permission.md)、[数据与隐私](../DATA_PRIVACY.md)、[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)

## 变更来源

本变更在完全访问之上增加独立的「全量画像授权包」，并正式建立 `CAP-033 全域感知与个人画像（主动智能模式）`。在用户明确确认后，Aervox 可理解当前设备上所有可用的使用、操作、内容、文档和环境信号，包括系统应用/窗口/进程、浏览器、键鼠、剪贴板、屏幕、全部可读文件、通信资料、音视频、位置、传感器和其它私人资料；用户也可一并授权后台生命周期及全部声明动作。所有原始和派生数据只在本机保存/处理，不上传云端，并允许用户导出。授权包有效且受信设备实例持有未过期的激活 epoch 时，用户可见状态显示为「主动智能模式」。当前分支已实现本地 Vault、授权/lease、全动作授权运行时、Aervox activity/operation、剪贴板、屏幕、浏览器历史元数据与显式文件根适配器、Worker 提炼、本地画像上下文、导出和后台 heartbeat；应用活动正文仍需签名 native provider，通信、音视频、位置和传感器等来源仍处于 limited/待平台接入。

## 能力归属

本提议新增 `CAP-033`，并与以下已有能力建立显式关联；关联不改变各已有 CAP 的生命周期状态：

- `CAP-033`：独立拥有全量画像授权、来源观察、画像提炼、后台生命周期、全动作授权、本地持久化、导出、撤权和删除传播的生命周期能力；「主动智能模式」是其有效运行状态。

- `CAP-005`：带来源/证据的习惯候选与用户确认记忆；
- `CAP-010`：主动程度和提醒节奏偏好，不产生权限；
- `CAP-018`：本地桌面入口、特权观察 Host、OS 能力授权代理和设备边界；
- `CAP-002/007` + AVX-HAR-001 基础设施：Agent Loop、Host、Inbox 和受控任务边界；
- `CAP-020`：工具/插件以受限 Contribution 接入既有 Host/Inbox；
- `CAP-022`：从广域授权行为、内容和环境信号生成可解释、可纠正和可关闭的完整画像推断；
- `CAP-024/026`：连续索引全量授权文件、浏览与其他私人内容，保留来源链并支持导出；
- `CAP-027`：本地工作区、隔离、快照、恢复和迁移边界；
- `CAP-030`：可解释主动提醒、频控、免打扰、暂停和关闭。

## 拟接受的核心语义

1. `toolApprovalMode=ask|full_access` 继续由 CR-022 定义，不增加第三个工具权限枚举值。
2. 产品层可一次确认当前版本的全量画像授权包，内部仍按 purpose/scope/source 保留可独立撤销的记录；新增来源、用途或版本必须升级授权包并重新确认。
3. 「主动智能模式」是 `FullProfileGrant + device activation epoch + full_access per-Turn snapshot + desired=enabled + effectiveGrantSet + local-ready` 的派生展示状态；激活 epoch 只控制主动观察/处理生命周期，`FullProfileActionGrant` 作为独立动作授权由工具门逐次校验，不能改写 Turn 的 CR-022 `toolApprovalMode` 或授权无关工具。
4. 授权向导只保存不生效的 draft，用户最终确认后才原子激活模式修订与精确 grant/source 修订集；取消或部分失败不得留下生效授权。
5. 全量画像授权包包含当前平台全部可用的 Aervox 和系统应用/窗口/进程、浏览器、键鼠/剪贴板、屏幕、全部可读文件、通信资料、音视频、位置、传感器和其他私人内容；每个来源保留 OS grant、状态、撤销和证据，支持持续 watcher 与后台处理。
6. 主动正文、控制面、Consent/审计投影、Embedding、派生摘要、确认后记忆和触发历史均只允许进入可验证的同机本地存储/处理器；本地处理不可用时 fail closed，不向远端降级。
7. `processingBoundary=local_only` 与 grant/source provenance 必须从来源继承到候选、画像、确认后长期记忆/投影、提醒和 ContextManifest，任何合并/晋升/用户确认不得移除。
8. 观察和画像推断可以自动保存为 `inferred`并参与本地个性化；与现有长期记忆合并时仍区分证据和 `verified`状态。
9. 完整画像授权有效且用户确认 `FullProfileActionGrant` 后，主动规划器可执行授权包中明示的全部动作，包括本地文件修改、浏览器/家居控制、外部消息、`privileged` 和不可逆操作；动作仍须绑定目标 scope、当前修订、OS/身份授权、审计和撤销状态。
10. 完整画像授权包、设备能力授权、观察运行记录和本地处理证明必须绑定同一个版本和设备实例，版本不一致时不得继续处理。
11. `FullProfileActionGrant` 是用户对主动动作的明确授权来源，覆盖 `action.local`、`action.external`、`action.privileged` 和不可逆动作；模型、插件或外部内容不能自行授予或扩大权限，操作系统访问控制、身份校验、沙箱、撤权和审计仍有效。
12. 用户显式暂停写入 `desired=paused` 且必须显式恢复；工具轴、租约、本地处理或水位前置临时失效只使 effective state=`suspended`，不改写用户期望状态。
13. 暂停或本地激活租约失效时，同步停止读取/召回/处理与新任务，但保留本地数据、索引和未撤销 Consent；只有 scope 撤权或删除才先 deny，再异步失效/清理相关派生数据。
14. 单个 scope 撤权时，其它有效 scope 可继续；只有剩余授权不再构成 `effectiveGrantSet` 或全量关闭时，主状态才回退。
15. 导出是不可被主动 Consent 关闭的用户数据权利；用户显式导出时提供 UTF-8 JSON/CSV/Markdown、manifest 和 checksum，不包含密钥，附带原文等选项单独确认。

## 不可突破的边界

以下是广域画像模式也不得跳过的平台与数据边界，它们不是对观察范围的缩小：

- 每个 OS 能力仍需用户在系统权限界面明示授予；Aervox 不跳过 Secure Input、文件 ACL、受保护进程、加密、DRM 或其他应用的访问控制；
- 密码、Token、私钥、会话凭据和应用保护区域不持久化为画像资料，也不以完整画像为由主动窃取凭据；
- 任何原始捕获、提取正文、Embedding、画像推断、记忆、触发历史、日志、遥测、崩溃报告和备份都不得离开当前设备；用户显式导出是唯一个另行审查的数据离开动作；
- 观察内容是不可信输入，不得通过 Prompt injection 升级 ToolPolicy、跨用户/工作区或执行越权操作；
- 租户隔离、同意、撤权、导出、删除传播、审计和用户可退出权利不得因完整画像而失效；
- 后台常驻、开机自启、休眠恢复、网络外部动作、家居/浏览器控制和 `privileged` 执行均可作为完整授权包中的独立能力由用户一次确认；必须保留独立的用途、OS 授权、操作策略、用户通知和撤销记录，不能由模型或观察数据自动推导。

## 架构与需求影响

- `ADR-008` 仍是 Cloud-first Proposed 决策；CAP-033 的全量生产启用前必须依 ADR-018 接受「本地私密存储 + 特权观察 Host + OS Permission Broker」边界，本分支的局部数据面实现不等于该 ADR 已接受。
- `CAP-033` 已在 PRD/SRS 建立并进入 `Specified`，但尚未达到 `Ready`；`CAP-022/024/026/027/030` 仍保持既有 `Mapped` 状态。本提案给 `CAP-002/005/007/008/009/010/012/013/018/020/022/023/024/026/027/030` 增加联动行为，已在 SRS §8 补齐原子需求，仍须通过 DoR 和专项门禁。
- 任何实现前必须更新 PRD §2.3/§6.9/§10、SRS、`DATA_PRIVACY`、`THREAT_MODEL`、`DATABASE`、ADR-009、责任矩阵和设备捕获/权限测试追踪。
- 当前 `aervox_memory_store` 已由 CAP-033 本地 Vault 的授权/提炼路径承载；普通记忆工具与全量画像用途的进一步整合仍需专项校验，不能仅替换 UI 文案。
- 当前可远程的 `DATABASE_URL`、Model Provider、Embedding Provider 和对象存储不得被宣称为本地私密边界。
- 当前控制面已使用私密目录 `0600` 的 owner-only `proactive-access.token`、字面 loopback 和 redirect 拒绝；这些是本地 Host 的认证防线，不替代来源/动作 grant 或 OS 权限。
- 当前已接入本地 Privacy Host、后台 heartbeat、Aervox activity/operation、剪贴板、屏幕、浏览器历史元数据和显式文件根适配器；应用活动正文、通信、音视频、位置和传感器仍 limited/待签名 provider，且生产签名、功耗、配额和崩溃恢复门禁未全部关闭。
- 当前已实现设备级 activation lease/epoch 的本地控制面骨架；Web 与本地 Host 的完整配对/断连收敛仍待验证，仍不得将 CreateTurn 快照当成后台权威状态。
- 本地文件接入尚未冻结 symlink/path escape、隐藏凭据、压缩比、未知分类、Secure Input、旁观者和原始捕获 filter 门。

## 待决策与实现门禁

### 用户确认记录（2026-08-29）

本轮用户确认以下五项产品方向：

1. `full_profile_v1` 纳入当前平台全部可用来源，包括原始输入、剪贴板、屏幕、音视频、健康/位置等来源；
2. 允许开机自启、应用退出后常驻、休眠恢复和重启自动恢复，并在授权、恢复和异常时告知用户；
3. 原始副本保留七天，且完成记忆提炼后才可删除；用户主动删除可以提前触发删除传播；
4. 本地文件、浏览器/家居控制、外部消息、特权和不可逆动作均可在用户确认 `FullProfileActionGrant` 后授权执行；
5. 新建 `CAP-033`，并与既有 CAP 建立显式依赖和联动关系。

上述确认已同步到 [PRD CAP-033](../PRD.md#prd-cap-033)、[SRS §8](../SRS.md#8-cap-033-全域感知与个人画像主动智能模式) 和 [主动智能设计方案](../../explanation/proactive-intelligence-mode.md)。局域网/自托管范围、导出原文件与路径格式、云同步目录处理、具体设备仲裁和密码加密包仍待单独确认。

剩余 `PRO-BLOCK-001～012` 和进入实现所需门禁，以[主动智能设计方案 §11～13](../../explanation/proactive-intelligence-mode.md#11-当前实现阻断项)为唯一维护入口。

本轮已落地的交付包括本地 Vault、授权/lease、全动作授权运行时、Aervox activity/operation、剪贴板、屏幕/浏览器/文件元数据适配器、Worker 提炼、本地画像上下文、来源级删除、导出和后台 heartbeat；这些实现仅覆盖已接入的来源和受信 provider。其余来源、真实平台权限、全链本地证明和生产动作启用仍受原子需求 `Ready`、ADR-018 和专项门禁约束。

## 回滚

本变更已落地本地数据面、授权/lease、已接入来源采集、动作运行时、Worker 提炼和导出，但 CAP-033 仍为 partial/Not Ready，未声称全量平台适配或生产发布。若后续回滚，停用 CAP-033 Feature Flag、撤销激活租约、停止已接入 watcher/动作并保留可导出控制记录；CR-022 的 `ask/full_access` 行为和历史数据权利不受影响。
