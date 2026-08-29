---
id: AVX-EXPL-008
type: explanation
scope: proposal
owner: product-platform
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.4.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 60
review_triggers:
  - docs/reference/PRD.md
  - docs/reference/SRS.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/THREAT_MODEL.md
  - docs/reference/adr/ADR-008-cloud-first-local-port.md
  - docs/reference/changes/CR-022-full-access-tool-permission.md
  - docs/reference/adr/ADR-018-proactive-local-privacy-host.md
  - docs/reference/changes/CR-024-proactive-intelligence-suite-integrations.md
  - docs/reference/adr/ADR-019-proactive-integrations-local-gateway.md
  - docs/explanation/health-data-integration-assessment.md
  - docs/explanation/home-assistant-integration-assessment.md
  - packages/database/**
  - packages/agent-loop/**
  - apps/desktop/**
  - apps/web/**
  - packages/ui/**
  - packages/api-client/**
sources:
  - docs/reference/PRD.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/capability-composition.md
  - docs/reference/capability-registry.md
  - docs/reference/adr/ADR-008-cloud-first-local-port.md
  - "docs/reference/adr/ADR-009-electron-plugin-sandbox.md"
  - docs/reference/changes/CR-022-full-access-tool-permission.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/adr/ADR-018-proactive-local-privacy-host.md
---

# 主动智能模式设计方案

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-08-29

关联：[CR-023](../reference/changes/CR-023-proactive-local-intelligence-mode.md)、[CR-022 完全访问](../reference/changes/CR-022-full-access-tool-permission.md)、[需求追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)、[数据与隐私](../reference/DATA_PRIVACY.md)

## 1. 结论

「主动智能模式」是用户明确打开「全量画像授权包」后的广域本地模式，不再限定为只观察 Aervox 内部行为。经 CR-023 接受后，它由新建的 `CAP-033 全域感知与个人画像（主动智能模式）` 承载，并与既有能力组合为一个可持久、可撤销、可导出的用户权限包：

```text
设备级 FullProfileGrant + 激活 epoch（证明用户已在当前设备确认 full_access）
  + 版本化全量画像授权包与设备能力授权
  + 全量画像来源（应用、浏览器、键鼠、剪贴板、屏幕、文件、音视频、位置与其他私人资料）
  + 可验证的本地存储/本地处理/出网边界
  + 本地持续观察、归纳与已授权动作
  + 撤权、导出、删除与审计不变量
  = 主动智能模式
```

用户先开启「完全访问」，再经过独立授权向导一次性确认当前版本支持的全量画像范围。该范围可包括 Aervox 使用与操作、系统应用与窗口、浏览器、键鼠与输入信号、屏幕/剪贴板、全部用户文件、通信资料以及平台可提供的音视频、定位和其它私人资料。产品可以一次确认整包，但服务端仍按来源和用途保存可撤销记录，并由操作系统逐项弹出能力授权。当授权包、本地工作区、本地处理器和设备激活状态均有效时，输入区的「完全访问」显示为「主动智能模式」。该文案只是 Host 有效状态的投影，不是权限事实源。

CR-022 当前仍把 `full_access` 作为每次 CreateTurn 请求的快照；本分支已增加可供后台 Host 使用的本地 activation lease/epoch 和 owner-only loopback token，但完整设备仲裁与生产证明仍待验证。

本方案会将广域画像与本地全权处理作为 CAP-033 的目标方向；当前已实现本地 Vault、授权/lease、全动作授权运行时、Aervox activity/operation、剪贴板、屏幕/浏览器/显式文件根适配器、Worker 提炼、本地画像上下文、导出和后台 heartbeat，CAP-033 仍为 partial/Not Ready。应用活动正文、通信、音视频、位置和传感器仍 limited/待签名 provider；`CAP-022/024/026/027/030` 仍为 `Mapped`，关联 CAP 的原子需求和实现门禁继续推进。

## 2. 已经确认的方案输入

本轮可直接进入方案的要求仅包括：

- 主动智能模式以完全访问为前置；
- 需要用户额外、独立授权，不把完全访问视为数据同意；
- 授权后，用户可见状态从「完全访问」变为「主动智能模式」；
- Aervox 可在获授权范围内理解用户的使用习惯、操作习惯和私人文档；
- 「完整画像」方向允许将可用的广域使用/操作信号和私人资料纳入同一个主动智能授权包，包括需要 OS 权限弹窗的能力；
- 授权后可以在本地持续观察、建模、归纳并执行授权范围内的主动操作，不仅是被动回答；
- 全量画像可以覆盖当前设备能力清单中的应用/窗口/进程活动、浏览器、键鼠和剪贴板、屏幕视觉、文件与目录、通信资料、音视频、位置和其他传感器；每一类都由版本化授权包和对应 OS 授权表明；
- 相关数据和派生推断只在本地持久化，不上传云端；
- 用户可以导出这些数据。
- 用户确认：授权包同时允许开机自启、应用退出后常驻、休眠恢复和重启自动恢复，并在启用、恢复和异常时告知用户；原始副本保留七天且完成记忆提炼后才可删除；本地文件、浏览器/家居控制、外部消息、特权和不可逆动作均可在 `FullProfileActionGrant` 下执行；该能力正式新建 `CAP-033` 并关联既有 CAP。

本文后续出现的实现选择如未被上述要求、现有文档或用户后续确认直接覆盖，均标记为「待确认」，不得直接进入代码。

## 3. 现有能力组合

| 现有能力 | 主动智能模式中的责任 | 当前边界 |
|---|---|---|
| `CAP-033` 全域感知与个人画像 | 拥有全量画像授权、来源观察、画像提炼、后台生命周期、全动作授权、本地持久化、导出、撤权和删除传播；「主动智能模式」是其有效运行状态 | 独立生命周期能力；依赖下列 CAP 和本地/OS 基础设施，不静默改写其状态 |
| `CAP-005` 四段记忆 | 保存来源可追溯的习惯/偏好候选与已确认记忆 | 推断只能先成为 `inference` 候选；用户事实和敏感偏好需确认 |
| `CAP-010` 主动程度偏好 | 表达与提醒节奏 | 偏好不是权限，不能代替 Consent/ToolPolicy |
| `CAP-018` 桌面端 | 提供签名的本地高权限 Host、OS 能力授权代理、后台运行与文件/设备访问 | 必须依赖操作系统授权、签名、隔离和可见指示；不能绕过受保护进程或 Secure Input |
| `CAP-002/007` + AVX-HAR-001 基础设施 | 提供原生 Agent Loop、Host、Inbox 与受控任务边界 | Inbox 属对话/Agent 基础设施，不由 `CAP-020` 创建授权 |
| `CAP-020` 工具/技能 | 把工具和插件以受限 Contribution 接入既有 Host/Inbox，并按清单授予外部来源和主动动作 | 第三方插件不因主动智能模式自动获得画像数据；仍需 Manifest、沙箱、动作授权和撤权 |
| `CAP-022` 兴趣分析 | 从全量授权行为、内容和环境信号中生成可解释、可纠正、可关闭的完整画像推断 | 推断可以本地包含高敏感信息，但不得用于商业定向、情感操控或临床结论 |
| `CAP-024/026` 文档/知识库 | 连续索引全量授权文件、浏览与其他私人内容，保留来源、修订、引用和导出 | 外部内容仍是不可信输入，Prompt injection 不能提升工具权限 |
| `CAP-027` 本地优先 | 提供本地工作区、隔离、快照、导出和恢复边界 | 仍为 `Mapped`；当前 SQLite 实现不等于已承诺数据不出本机 |
| `CAP-030` 主动提醒 | 根据完整画像主动触发提供本地提醒、建议与已授权任务执行 | 每条输出保留触发原因、频控、免打扰、暂停和关闭入口，不做情感施压 |
| CR-022 完全访问 | 为当前 Turn 内普通写工具提供可审计预授权，并与 CAP-033 的动作授权组合 | `full_access` 仍不是画像同意；CAP-033 的 `FullProfileActionGrant` 单独决定主动动作，激活租约和 loopback token 不代替 Turn 模式 |

该组合不改变 Kernel 不变量：租户隔离、逐用途同意、撤权、导出、纠错、删除传播和审计不能被自选模式关闭。本文中的「组合模式/Overlay」是产品概念，不表示能力组合文档中的目标 Resolver 已经实现。

## 4. 四维状态模型

工具权限、画像授权、设备能力和实际可运行状态必须保持分离：

- **工具轴**：`ask | full_access`，继续以 CR-022 为事实源；
- **画像期望状态**：`none | enabled | paused | revoking | revoked`，持久化在 `ProactiveModeRevision`；只有用户显式暂停才写 `paused`；
- **设备能力集**：版本化的 `ProfileAuthorizationRevision + DeviceCapabilityGrantSet`，记录当前平台所有可用的应用、文件、输入、屏幕、音视频、位置和其他来源；
- **有效运行状态**：`inactive | configuring | active | limited | suspended | revoking`，由期望状态、授权包、OS grant、激活事件/租约和 `local-ready` 派生。

`effectiveGrantSet` 必须绑定某一个 `ProfileAuthorizationRevision` 的精确 grant/source 修订集。「全量」指当前版本授权包中的所有 mandatory 来源均已明确授予；缺失能力时显示 `limited` 而不静默称为完整画像。mandatory 集合由服务端 manifest 定义，只含**当前版本已接入探测/适配器**的来源：通信、位置、传感器和敏感私人资料尚无平台 Provider（保持可见、状态待验证），不计入最小激活集，否则 `active` 永远不可达、集成与主动动作全链路被闸死；其中传感器与敏感资料在用户连接 Home Assistant / 小米运动健康等外部连接时视为对该来源的显式授权（显式撤销后同步重新被阻断）。导出是 Kernel Data Rights，对已保存主动数据始终可用，不是可选授权。

```text
ask + desired=enabled
  -> effective=suspended，显示「操作需确认 + 主动智能已挂起」

full_access + none/revoked
  -> 完全访问

full_profile device grant + device activation epoch + desired=enabled + effectiveGrantSet + local-ready + deny-watermark-clear
  -> 主动智能模式

full_access + desired=paused
  -> 完全访问 + 主动智能已暂停

full_profile device grant + desired=enabled + 能力不齐/本地处理/政策前置不满足
  -> effective=limited/suspended，显示「主动智能模式受限」

full_access + 全量 revoking
  -> 完全访问 + 主动智能关闭进度
```

关闭完全访问、激活事件过期或设备能力被撤销时，立即停止新观察、召回、分析、提醒和主动任务，但已授予且未撤销的 Consent、本地数据/索引和用户期望状态保留；前两者只使 effective state 转为 `suspended/limited`，不自动改写 `paused` 模式修订。用户显式暂停则写入 `desired=paused`，必须由用户显式恢复。

暂时的 `tool_mode`、`lease_expired` 或 `local_unavailable` 挂起是否在条件恢复后自动继续，以及 `policy_mismatch/source_revision_changed` 何时强制重新确认，属 `DEC-PRO-013`。未批准前保守基线为：用户暂停始终需显式恢复；政策/来源修订变更始终重新确认。

单个 scope/source 的 `revoking` 是 scope 级清理状态。如果剩余 `effectiveGrantSet` 仍满足激活条件，主状态可继续显示「主动智能模式」，管理面板单独显示该 scope 的关闭/清理进度。只有全量关闭或剩余授权不再满足最小集合时，才整体回退。

画像授权和工具执行仍是两个检查：后台本地观察只需激活 epoch + 有效画像 grant；每次实际调用工具时，仍按 CR-022 的 Turn 策略和该工具的安全级别重新决定。

### 4.1 `local-ready` 与激活权威

`local-ready` 不等于 endpoint 名称中出现 localhost/Ollama。最少准入条件为：

1. 运行在受信且签名可验证的桌面/本地 Host，并绑定同设备本地工作区与设备能力授权快照；
2. 主动正文、控制面、审计和撤权投影均进入强制本地私密存储；
3. 源适配器、LLM、Embedding、OCR/ASR 和提醒/记忆写入宿主都通过身份、进程或传输准入验证，且有进程级出网阻断、禁止 redirect 和远程降级；
4. 全量画像授权包与设备能力授权均由用户明示确认，并以设备级 `FullProfileGrant` + activation epoch/heartbeat 维持生命；窗口关闭、租约过期或任一必要 OS grant 被撤回时挂起主动处理；
5. 该激活权只证明本地观察/处理生命周期，绝不得代替任何 Turn 的 `toolApprovalMode`、命中 ToolApproval、批准写工具或延长已开始 Turn 的授权；
6. 删除/撤权水位已追平，授权政策版本、来源修订和本地处理能力与模式修订一致。

未绑定同设备受信本地 Host 的 Web 客户端必须隐藏或拒绝主动智能模式；如未来支持 Web 与本地 Host 配对，配对协议、设备所有权、租约与断连收敛必须另行冻结。当前分支已提供本地激活 lease/epoch 和 loopback token 控制面，但完整设备仲裁仍见 `PRO-BLOCK-008`。

## 5. 全量画像授权包

授权向导可以在一个界面中让用户一次确认当前版本支持的全量画像范围，同时将每个 source/purpose 写入可独立撤销的 `ConsentGrant`。这不是无限期的通配同意：新增来源、用途或版本必须升级授权包并重新确认。

向导进入 `configuring` 后只保存不生效的 draft。用户最终确认时，服务端原子激活 `ProfileAuthorizationRevision + DeviceCapabilityGrantSet`；任一 grant/source 持久化失败都保持非 active，中途取消丢弃 draft。

| 授权面 | 可纳入全量画像的来源 | 授权与运行记录 |
|---|---|---|
| Aervox 使用与操作 | 使用的功能、学习时段、任务时长、提醒响应、工具与界面操作序列 | `aervox.activity` + `aervox.operation`；可持续采集、本地归纳与导出 |
| 系统应用与窗口 | 前台应用、窗口、进程、焦点和活动时长 | `device.app_activity`；需操作系统授权与签名 Host |
| 浏览器与网页 | 历史、标签页、URL/标题、用户明确连接的页面上下文 | `device.browser_activity`；通过扩展或受信桥接访问 |
| 键鼠与剪贴板 | 键盘/指针序列、输入内容和剪贴板变更，供习惯建模 | `device.input_content`、`device.clipboard`；必须尊重 Secure Input 与受保护输入 |
| 屏幕与视觉 | 单屏/多屏截图、持续帧、OCR 和视觉上下文 | `device.screen_capture`；原始帧只进加密缓冲，不跳过系统权限 |
| 文件与目录 | 用户授权的全部可读文件、挂载卷、修订和持续 watcher | `filesystem.full_disk_watch`；按操作系统权限、canonical path 和变更重验 |
| 通信与个人数据 | 邮件、消息、联系人、日历和其它用户明确连接的来源 | `external.communication` 等单独 scope；用户可撤销 |
| 音视频、位置与传感器 | 麦克风、摄像头、位置、环境和其它平台可提供的信号 | `device.microphone` / `device.camera` / `device.location` / `device.sensors`；每项仍需 OS 授权 |
| 健康与敏感私人资料 | 用户明确选择的健康、情绪、关系或其他 Restricted 资料 | `restricted.profile` 单独 scope；不用于商业定向、临床诊断或操控 |
| 后台与主动操作 | 本地守护、任务调度、提醒，以及用户在全量画像授权包中明示的本地、外部、特权和不可逆动作 | `background.persistent` / `action.local` / `action.external` / `action.privileged`；每类动作保留独立可撤销快照 |

用户可一次确认整个包，但不同来源仍保留独立的 `ConsentGrant` 、OS 状态、设备 ID、版本和撤销记录。密码、Token、私钥、Secure Input 和应用加密保护区域不作为画像资料持久化，也不跳过操作系统或应用的保护机制。

## 6. 本地私密数据流

```text
用户确认 `full_profile_v1` 完整画像授权包
  -> 受信、签名的 Privileged Observation Host 取得 OS grant 快照
  -> 应用/浏览器/键鼠/剪贴板/屏幕/文件/设备 Source Adapter 持续采集
  -> 加密短期捕获缓冲（secret/Secure Input filter + TTL）
  -> 本地 OCR/ASR/parser/FTS/Embedding
  -> 本地画像时间线、习惯图谱与 inference claim
  -> 本主动规划器与已授权动作
  -> 用户查看、纠正、导出、暂停、撤权或删除
```

不上传云端不能只由一个界面开关声明，必须由可验证的技术边界保证：

1. 主动正文与控制面必须进入强制本地的独立存储边界，不继承可指向远端 libSQL 的普通 `DATABASE_URL`。该边界覆盖模式修订、Consent、来源范围、观察、推断、确认后记忆、投影、提醒/触发历史、审计与撤权水位投影；
2. `processingBoundary=local_only` 与 grant/source provenance 必须从 `SourceArtifact -> BehaviorObservation -> HabitInsight -> confirmed Memory -> TreeProjection -> ProactiveTrigger -> ContextManifest` 单向继承。合并、晋升、压缩和用户确认只能改变内容/验证状态，不得移除本地处理边界；
3. 原始屏幕帧、音频、键入、剪贴板、文件正文、分块、Embedding、习惯推断、派生摘要、已确认记忆、触发历史、日志、遥测、崩溃报告和备份都不能进入远端 LLM、远端 Embedding、分析、错误监控或远端日志；
4. 处理器必须校验实际 endpoint/transport、Provider 身份/进程来源和出网策略，禁止 redirect、DNS/代理转发和远端降级；不以「Ollama」等配置名称代替连接验证；
5. 本地 Embedding 不可用时，降级为本地 FTS 或禁用该索引，不得降级上传；
6. 私密存储必须静态加密，密钥不入库、日志或导出；存储位置必须排除已知云同步目录和自动系统云备份，密钥保管与操作系统备份语义由本地私密存储 ADR 冻结；
7. 网络插件和远端 Provider 不可见主动数据来源；只有不携带用户数据权限的更新器可访问公开网络；
8. 用户导出到本地文件是独立显式操作。对已知云同步目录的处理仍属 `DEC-PRO-012`，未批准前默认拒绝作为导出目标。

控制面认证还必须经过 owner-only `proactive-access.token`（私密目录 `0600`），只接受字面 loopback 请求并拒绝 redirect；该令牌只证明本机控制面调用者，不授予任何来源或动作权限，也不进入主动数据导出。

`ADR-008` 当前仍采用 Cloud-first 基线且状态为 Proposed。实现本方案前必须修订 `ADR-008` 或新建并接受「本地私密存储 + 特权观察 Host + OS 授权代理」 ADR，再冻结存储位置、密钥、文件权限、后台生命周期和备份边界。

## 7. 逻辑数据模型（未冻结 Schema）

| 逻辑记录 | 作用 | 安全/生命周期要求 |
|---|---|---|
| `ProfileAuthorizationRevision` | 版本化「全量画像授权包」、用户期望状态与有效 source/purpose 集合 | 设备级、可撤销，新增来源/用途必须升级修订并重新确认 |
| `ProactiveModeRevision` | 记录模式 enabled/paused 等用户期望状态与 policyVersion | 只表示用户期望与模式配置，不代替 Consent；前置条件失效只生成 effective `suspended/limited`，不改写该修订 |
| `DeviceCapabilityGrant` | 记录应用/窗口/浏览器/键鼠/剪贴板/屏幕/文件/传感器的 OS 授权快照 | 与 deviceId、政策版本、状态、lastVerifiedAt 和 collectorVersion 绑定；OS 撤销即停用 |
| `LocalActivationLease` | 绑定本地 Host/后台 helper、设备、full_access 确认与 heartbeat/expiry | 当前未实现；过期/断连立即使 effective state suspended；不能代替 Turn 级工具授权 |
| `ConsentGrant` | 按 purpose/scope 记录主动数据授权 | 包含来源界面、证据、政策版本、本地处理边界与撤权时间；属本地私密控制面 |
| `AuthorizedLocalSource` | 记录 Aervox、应用、浏览器、设备、文件或目录来源及 allowedOps | 资源引用需加密；每个来源可单独撤销，不自动扩大范围 |
| `RawCaptureSegment` | 加密保存屏幕/音频/输入/剪贴板/文件等原始观察分段 | `observedAt + 7 天` 为保留期限，且必须完成记忆提炼后才可物理清理；用户主动删除可提前触发；不进入普通日志或分析 |
| `BehaviorObservation` | 用途受限的本地规范化行为观察 | 不复用 `analytics_optional` 或 AuditRecord；从原始观察留下 provenance |
| `SourceArtifact/Revision` | 文档与行为批次的来源/修订链 | 删除或撤权后使索引、摘要和推断失效；传播 `local_only` 与 grant provenance |
| `HabitInsight` | 使用/操作/兴趣模式的 inference 候选 | 带证据、置信度、适用范围和状态；用户可确认/纠正/拒绝；确认不移除 `local_only` |
| `ProfileClaim/ProfileSnapshot` | 画像实体、习惯、关系、时间线和版本快照 | 每条 claim 保留 `observed`, `inferred`, `user_asserted`, `confirmed`, `rejected`、evidence、confidence、source/grant provenance；只在本地处理 |
| `LocalProcessingAttestation` | 记录当次 OCR/ASR/Embedding/LLM 和出网策略的实际本地身份 | 不以配置名称代替证明；失效后主动模式不得继续 |
| `ConfirmedMemory/Projection` | 复用既有长期记忆/系统投影表达已确认习惯 | 必须写入本地存储绑定，保留来源、grant 与 `local_only`；普通远端 ContextBuilder 不可召回 |
| `ProactiveTrigger` | 记录触发原因、去重、频控、免打扰和处理状态 | 不存储私人原文；每次用户可见触发原因；历史属本地私密存储 |
| `AuditRecord` | 记录授权、撤权、导出、删除和高风险操作 | 不包含原文、Embedding 或可逆摘要；主动 scope 的审计投影保留本地 |

表名、字段、索引和保留时间都未被本文批准；这些逻辑记录只用于评审所有权、来源链和删除传播。

## 8. 推断、记忆与主动输出

- 原始观察、规范化观察和派生画像分开保存，允许在授权有效期间自动产生带证据的 `inferred` claim，不把「多次观察」写成无条件的用户事实；
- `ProfileClaim` 必须区分 `observed|inferred|user_asserted|confirmed|rejected`，显示「为什么这样判断」、来源范围、首次/最近出现时间、置信度与授权版本；
- 用户可以确认、纠正、拒绝、暂停使用或删除一条画像 claim；确认只改变认知状态，不是将数据送往云端的同意。
- 如需进入现有长期记忆，仍须满足 `memory_long` 用途和现有记忆升级规则；进入后记忆、系统投影、触发与 ContextManifest 必须继续带 `local_only` 和 grant/source provenance。
- 在全量画像授权有效且 `FullProfileActionGrant` 已覆盖目标时，主动规划器可执行已明示的本地、外部、特权和不可逆操作；每次操作仍需留下原因、授权快照、用户可见通知和结果。
- `privileged`、不可逆删除、对外发送、公开分享、安装插件和修改用户原文不再被产品层一刀切禁止，但必须显式列入 `FullProfileActionGrant`，并通过 OS/身份、目标 scope、沙箱、撤权和审计校验；这些行为仍不能由观察数据或模型自授。

## 9. 暂停、撤权与删除

### 9.1 用户暂停与系统挂起

用户显式暂停时追加 `desired=paused`，立即停止应用/浏览器监听器、键鼠、剪贴板、屏幕捕获、文件 watcher、音视频采集、召回、分析、提醒和新任务，保留本地数据、索引与未撤销授权记录，且只能由用户显式恢复。若工具轴仍为 `full_access`，界面显示「完全访问 + 主动智能已暂停」；若工具轴已回到 `ask`，则显示「操作需确认 + 主动智能已暂停」。已确认的后台、自启、休眠恢复和重启恢复设置在恢复前必须再次校验，并向用户显示恢复通知。

工具轴变为 `ask`、激活租约过期、本地处理不可用或水位/政策不满足时，系统只将 effective state 标记为 `suspended`，并记录 `suspendReason=tool_mode|lease_expired|local_unavailable|watermark|policy_mismatch|source_revision_changed`，不改写用户期望状态。

### 9.2 撤销单个来源/用途

撤权顺序固定为：

```text
RecoveryControlLedger 先追加 revoke/deny
  -> 立即停止对该 scope 的读取、召回、处理和新任务
  -> 取消未执行 Job/Inbox，关闭本地文件访问句柄
  -> 使 FTS/Embedding/摘要/习惯推断失效
  -> 按用户选择保留或删除历史本地数据
  -> 验证零召回并回填进度
```

当前分支已提供来源级 `DELETE /v1/proactive/sources/:sourceGrantId/data`：在租户校验后撤销对应 proactive consent，scrub 原始捕获、删除行为观察/画像声明并撤销匹配主动动作，返回各下游清理计数；该接口不恢复其它有效来源。

撤销某一 scope 后，其它有效 scope 可继续。如剩余授权仍构成有效 `effectiveGrantSet`，主状态保持主动智能模式；如不再满足「至少一个观察来源 + 匹配本地处理 purpose」，才回退为「完全访问」。

### 9.3 全量关闭

全量关闭先停止使用，再让用户选择导出、保留但不再召回，或删除本地数据。原始捕获副本按 `observedAt + 7 天` 保留，完成记忆提炼后才可清理；用户主动删除可以提前触发。物理清理可异步，但 deny 必须同步生效，清理进度必须对用户可见。

## 10. 导出

主动智能模式的用户导出必须是本地显式操作，格式不依赖 Aervox 专有客户端。最小导出包含：

- 模式修订与同意/撤权回执；
- 原始捕获分段（按七天保留策略、提炼状态和导出风险提示）与观察的可读结构化记录；
- 完整画像时间线、习惯/兴趣候选、已确认记忆、证据链与纠错历史；
- 已授权文档的来源清单、修订、哈希、索引状态和缺失/撤权状态；
- 主动触发原因、提醒/建议历史、设备能力状态、OS 授权回执和最小审计记录；
- schema 版本、`manifest` 和 `checksum`。

结构化部分使用 UTF-8 JSON/CSV/Markdown。原始文件是否包含在导出中、是否记录绝对路径以及是否生成密码加密包仍属待确认决策。导出不得包含密钥、凭据、未脱敏安全事件或可恢复已删内容的 tombstone。

### 10.1 十二项派生与外部信号落地

[CR-024](../reference/changes/CR-024-proactive-intelligence-suite-integrations.md) 已在 CAP-033 下实现统一个人时间线、项目与意图图谱、操作流程学习、情境触发、动作验证、画像冲突、主动准备、注意力/疲劳、行为漂移、关系上下文、场景模型和日/周回顾。上述输出均进入本地 Vault，并通过桌面设置页查看。

同一变更新增 CAP-034/035：Home Assistant 通过私网 REST/WebSocket、实体/service 白名单和受控 Agent 工具接入；小米运动健康通过用户自有且获准的官方开放平台配置同步每日步数、睡眠和静息心率。连接凭据不进入模型、日志或导出，撤销连接删除凭据和对应缓存。架构边界见 [ADR-019](../reference/adr/ADR-019-proactive-integrations-local-gateway.md)。

## 11. 当前实现阻断项

| 阻断 ID | 当前缺口 | 进入实现前的最少处置 |
|---|---|---|
| `PRO-BLOCK-001` | `aervox_memory_store` 仍是普通工具注册表路径，尚未完成与 CAP-033 `profile_observation/profile_action` grant 的全链路一致性校验 | 记忆工具执行前校验 purpose/scope；推断只写未验证候选和证据，不直接成为长期事实；已接入的本地提炼器先写 CAP-033 claim |
| `PRO-BLOCK-002` | CAP-033 已使用独立本地 Vault 和加密 Port，但生产部署仍需证明连接不会回退到远程 `DATABASE_URL`，并完成全量实体准入 | 建立强制本地的私密存储 Port 和连接准入校验，覆盖正文、控制面、确认后记忆与触发历史 |
| `PRO-BLOCK-003` | CAP-033 确定性本地提炼器已接入；通用 LLM/Embedding/OCR/ASR Provider 仍可指向远端 | 在 ContextBuilder 和处理器入口校验 Provider 身份/进程/传输与出网策略，禁止 redirect/代理转发，非本地 Provider fail closed |
| `PRO-BLOCK-004` | 当前附件以 objectKey/S3 形态建模 | 为私人文档提供独立本地文件适配器，禁止隐式进入远程对象存储 |
| `PRO-BLOCK-005` | 已建立独立的 CAP-033 observation/claim 数据面，但 `aervox_memory_store` 与普通分析/审计旁路的隔离仍需验证 | 在 `CAP-022` 下建立用途受限的本地行为来源，不复用分析/审计旁路 |
| `PRO-BLOCK-006` | 当前桌面端已具备本地 Host、后台 helper/heartbeat 和部分生命周期控制，但系统级观察适配器、生产签名、OS entitlement、功耗和崩溃恢复仍不完整 | 完成受信首方 helper、操作系统 entitlement/usage description、权限降级、后台生命周期和平台测试 |
| `PRO-BLOCK-007` | CAP-033 已增加 owner-only loopback token；测试注入可显式关闭，生产配置与代理/redirect 禁止仍需部署验证 | 本地私密模式需绑定受信 IPC/loopback + 本地身份，不以开发默认值作为产品边界 |
| `PRO-BLOCK-008` | CR-022 的 `full_access` 仍是 CreateTurn 请求快照；本分支已实现本地 ProfileRevision/activation lease/heartbeat/token，但 Web+Host 多窗口/设备所有权与断连收敛未完整验证 | 完成 `FullProfileGrant`/激活 epoch/heartbeat/expiry、多窗口/设备所有权与断连收敛；不以该状态代替 Turn 级 ToolApproval |
| `PRO-BLOCK-009` | 广域捕获可包含 symlink/path escape、隐藏凭据、压缩炸弹、未知类型、Secure Input 或旁观者数据 | 冻结 canonical path/time-of-read 复验、symlink 边界、类型/大小/解压比、secret/Secure Input filter、旁观者处理、未知分类 fail closed 和分类测试 |
| `PRO-BLOCK-010` | 当前已接入 Aervox activity/operation、剪贴板、屏幕、浏览器历史元数据、显式文件根、HA 授权实体事件和小米健康每日指标；应用活动正文、通信、音视频、位置及其它平台传感器尚未完成 | 为剩余来源建立签名 provider、权限状态机、收集失败降级和功耗/磁盘配额测试；HA/健康仍须生产兼容门禁 |
| `PRO-BLOCK-011` | 当前已建立原始捕获、行为观察、画像声明、权限回执和导出模型；全量来源时间线、外部动作历史和生产迁移仍未完整验证 | 完成 `RawCaptureSegment` 七天/提炼门、`ProfileClaim` 证据链、画像版本和导出 manifest/checksum 验证 |
| `PRO-BLOCK-012` | 当前已建立本地 Vault、动作授权器和确定性提炼器；全链 `local_only`、Provider 本地证明、远端旁路隔离和零外传故障注入仍待验证 | 完成全链 provenance 传播、本地 Provider 证明、控制面隔离和零外传故障注入 |

上述阻断未关闭前，主动智能模式不得进入 `Ready`，也不得通过改 UI 文案对外声称已满足「不上传云端」。

## 12. 已确认方向与待冻结细节

本次已确认的方向是「完整画像 + 广域本地权限」，而不是只做 Aervox 内部统计。以下是把 CAP-033 冻结成可实现合同所需的工程细节；当前允许数据面和 UI/Host 契约骨架，真实采集和动作执行仍须通过第 13 节门禁：

| 决策 ID | 待确认问题 | 当前基线 | 状态 |
|---|---|---|---|
| `DEC-PRO-001` | 完整画像授权包的实际清单是否包含应用/窗口、浏览器、键鼠/剪贴板、屏幕、音视频、位置和其他来源，以及原始内容的粒度 | 全部列入版本化 manifest，用户可一次确认；受保护输入和凭据仍不持久化 | 已确认 |
| `DEC-PRO-002` | 授权包是否允许设备重启、开机自启、应用退出后持续和休眠恢复 | 允许；启用、恢复和异常必须告知用户 | 已确认 |
| `DEC-PRO-003` | 关闭后默认保留还是删除本地数据 | 立即停止使用，由用户在保留/导出/删除中显式选择 | 部分确认 |
| `DEC-PRO-004` | 文件是一次性导入、持续 watcher 还是两者同时支持 | 支持用户明确授权的持续 watcher，并显示每个来源状态 | 已确认 |
| `DEC-PRO-005` | 源文件离线后是否保留加密原文副本，原始屏幕/音频/输入缓冲保留多久 | 原始捕获副本保留 7 天，且完成记忆提炼后才可删除；用户主动删除可提前触发 | 已确认 |
| `DEC-PRO-006` | 「本地」是否允许局域网模型/自托管主机 | 首版只允许同机 loopback/本地进程 | 待确认 |
| `DEC-PRO-007` | Restricted 文档、健康/情绪内容是否进入主动分析 | 可纳入专用 `restricted.profile` scope，仅本地分析并单独展示高敏风险提示；不做商业定向、临床诊断或操控 | 部分确认 |
| `DEC-PRO-008` | 是否允许习惯推断自动持久化并参与个性化，什么状态才叫 verified | 允许自动保存 `inferred` 并参与本地个性化；`verified` 仍需用户确认 | 部分确认 |
| `DEC-PRO-009` | 主动输出是否包含后台自动执行普通本地操作 | 允许全部声明动作，包括本地、外部、浏览器/家居、特权和不可逆动作；均以用户确认的 `FullProfileActionGrant` 为授权来源 | 已确认 |
| `DEC-PRO-010` | 导出是否包含原文件/绝对路径，是否增加密码加密包 | 默认只导出可读结构化数据和来源清单，不包含密钥 | 部分确认 |
| `DEC-PRO-011` | 哪个设备/安装实例拥有主动激活权，多窗口/Web+桌面如何仲裁，后台 helper 是否保持常驻 | 设备级 `FullProfileGrant` + activation epoch；只允许用户可见的受信 Host 持有 | 部分确认 |
| `DEC-PRO-012` | OS/iCloud/OneDrive 自动备份和用户将导出写入云同步目录是否违反「不上传云端」 | 主动存储不进入自动云备份；用户显式导出是独立行为，目标清单与提示待冻结 | 部分确认 |
| `DEC-PRO-013` | 非用户原因的 `suspended` 在前置恢复后是否自动继续，哪些原因必须重新确认 | 允许在用户已授权的自启/休眠/重启设置下自动恢复并告知用户；显式暂停仍需手动恢复 | 已确认 |
| `DEC-PRO-014` | 继续作为现有 CAP Overlay，还是新建「全域感知与个人画像」 CAP | 新建 `CAP-033`，并与既有 CAP 建立显式关联 | 已确认 |
| `DEC-PRO-015` | 当前平台的 mandatory 权限不完整时，是否禁止模式，还是显示「主动智能模式受限」 | 纳入当前平台全部可用能力；缺失 OS 能力必须显示缺口，不静默声称已获得该能力 | 已确认 |

## 13. 进入实现的门禁

在任何运行时代码开始前，至少完成：

1. CR-023 已接受；第 12 节中标记为「已确认」的 CAP-033 范围决策进入需求基线，剩余「待确认/部分确认」细节在进入对应实现前补齐；
2. 为 `CAP-033` 及其关联 `CAP-002/005/007/008/009/010/012/013/018/020/022/023/024/026/027/030` 补齐 FR/BR/AC/TC，明确失败、取消、暂停/挂起、撤权、删除、迁移和回滚路径；
3. 修订/新增并接受本地私密存储、特权观察 Host 与 OS Permission Broker ADR，关闭 `PRO-BLOCK-002/003/004/006/007/008/009/010/011/012`；
4. 更新 `DATA_PRIVACY`、`THREAT_MODEL`、`DATABASE` 和导出/删除责任矩阵；
5. 为记忆工具接入 Consent、候选和证据链，关闭 `PRO-BLOCK-001/005`；
6. 定义本地出网阻断、远端 Provider 拒绝、`local_only` 边界晋升/合并传播、OS 权限撤销、广域捕获零外传、撤权零召回、导出可读性、跨工作区隔离、特权 helper 逃逸、旁观者数据和本地文件安全测试；
7. 评审 UI 授权回执、来源管理、推断纠错、暂停/撤权和导出原型；
8. 完成控制面、原始捕获、画像、确认后记忆、提醒历史和 ContextManifest 全链路不出本机的出网/存储故障注入验证。

达到上述门禁前，只允许继续文档评审、静态原型、schema/契约骨架和不读取用户数据的测试；不得启用真实广域采集、私人文档索引或后台主动动作。

## 14. 平台能力清单（提案）

完整画像授权包不应只有一个布尔值。Host 必须对当前平台上的每一项能力报告请求、操作系统授权、当前状态和最后验证时间：

| 能力面 | macOS 示例 | Windows/Linux 适配方向 | 无权限时的展示 |
|---|---|---|---|
| 应用/窗口/进程活动 | Accessibility/Automation 等平台授权 | 前台窗口与进程信息的平台 API | 画像受限 |
| 键鼠与输入 | Input Monitoring；Secure Input 不得绕过 | 输入辅助功能、受保护窗口策略 | 仅保留可见、可验证元数据 |
| 屏幕与 OCR | Screen Recording | Desktop capture/portal | 无画面数据 |
| 全部文件与 watcher | Full Disk Access + 文件系统权限 | ACL、portal、挂载卷与文件系统 API | 无法访问的清单项 |
| 浏览器与通信 | 签名扩展、Automation、联系人/日历 entitlement | 扩展、应用注册和用户授权连接器 | 不展示未授权源 |
| 音视频/位置/传感器 | Microphone/Camera/Location 权限 | 系统隐私设置与传感器服务 | 显示缺失原因 |
| 后台生命周期 | Login Item、Launch Agent、休眠恢复 | 开机启动、服务或休眠恢复机制 | 模式挂起 |
| 主动动作 | 本地文件/Automation/消息与设备控制授权 | 文件 ACL、应用自动化、连接器和服务权限 | 动作受限 |

上表只是能力名称与验收面，不是对平台 entitlement 的代码实现承诺。每项能力的请求、授权、撤销、休眠、重新启动和共享设备行为需在相应 ADR 和平台测试中冻结。
