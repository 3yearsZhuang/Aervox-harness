---
id: AVX-SRS-002
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.0
updated_at: 2026-09-10
reviewed_at: 2026-09-10
review_interval_days: 90
sources:
  - docs/reference/SRS.md
  - docs/reference/PRD.md
  - docs/reference/prd-cap-acceptance.md
---

# Aervox｜思隅 主动智能模式与外部信号需求规格（SRS 附录）

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-09-10

产品事实源：[PRD.md](PRD.md) · [能力验收标准附录](prd-cap-acceptance.md)

主需求规格：[SRS.md](SRS.md)

追踪矩阵：[REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)

本文件从 [SRS 主文档 §8～§9](SRS.md#8-cap-033-全域感知与个人画像主动智能模式) 拆分而来，归档 CAP-033（全域感知与个人画像/主动智能模式）、CAP-034（Home Assistant 连接）与 CAP-035（运动健康信号连接）的原子级功能需求、业务规则、数据实体定义、质量要求、安全控制及验收条件。

---

<a id="srs-pro-001-全量画像授权与激活"></a>

## 1. CAP-033 全域感知与个人画像（主动智能模式）

本节把用户确认的 CAP-033 方向拆成可测试的授权、观察、画像、后台、动作、数据权利和运行要求。CAP-033 必须以 `full_access` 为前置，但 `full_access` 本身不代表画像或主动动作同意。

### FR-PRO-001 全量画像授权与激活

- **Parent CAP**：`CAP-033`
- **触发**：用户在 Turn 级完全访问已开启后进入主动智能授权向导。
- **必须**：展示当前版本 `full_profile_v1` 的全部可用来源、动作范围、后台生命周期、七天原始副本/记忆提炼策略、处理边界和导出权利；用户确认后原子写入 `ProfileAuthorizationRevision`、逐来源/逐动作 grant 和激活状态；向导取消或任一持久化失败不得激活。
- **异常**：`toolApprovalMode=ask`、Host 未受信、OS grant 被拒、版本冲突、处理边界不可证明或重复确认。
- **数据**：`ProfileAuthorizationRevision`、`DeviceCapabilityGrant`、`LocalActivationLease`、`ConsentGrant`；每条记录绑定 `(workspaceId, subjectUserId, deviceId, policyVersion)`。
- **验收**：
  - `AC-FR-PRO-001-01`：Given `toolApprovalMode=ask`，When 用户确认全量画像，Then 不创建 active revision，显示必须先开启完全访问。
  - `AC-FR-PRO-001-02`：Given 所有必需 grant、受信 Host 和本地处理证明有效，When 用户确认，Then 原子激活 revision/lease 并显示「主动智能模式」。
  - `AC-FR-PRO-001-03`：Given 任一 grant 或写入步骤失败，When 向导结束，Then revision 保持 draft/inactive，不遗留部分生效权限。
  - `AC-FR-PRO-001-04`：Given 用户取消或重复提交相同 revision，When 处理，Then 不产生第二份 active 授权且审计结果可追溯。
- **测试**：`TC-API-PRO-001`、`TC-E2E-PRO-001`、`TC-SEC-PRO-GRANT-001`。

<a id="fr-pro-002-全量来源观察"></a>

### FR-PRO-002 全量来源观察

- **Parent CAP**：`CAP-033`、`CAP-012`、`CAP-023`、`CAP-024`、`CAP-026`
- **触发**：主动智能 revision 和对应 source grant 处于有效状态。
- **必须**：按 manifest 观察当前平台全部可用的 Aervox 使用/操作、应用/窗口/进程、浏览器、键鼠/输入、剪贴板、屏幕、可读文件/目录、通信、音视频、位置/传感器及用户选择的 Restricted 私人资料；支持持续 watcher，并为每个捕获写入来源、时间、grant 和处理边界。
- **异常**：来源适配器不可用、OS 权限撤销、文件路径变化、连接器断开、重复事件或容量达到配额。
- **数据**：`RawCaptureSegment`、`BehaviorObservation`、`SourceArtifact/Revision`；原始副本不得进入普通分析事件或远端服务。
- **验收**：
  - `AC-FR-PRO-002-01`：Given 来源在 manifest 且 OS grant 有效，When 来源产生事件，Then 只写入对应本地捕获并保留 provenance。
  - `AC-FR-PRO-002-02`：Given 来源不在 manifest、grant 被撤销或适配器失效，When 来源产生事件，Then 不读取/不持久化，并记录可见的拒绝原因。
  - `AC-FR-PRO-002-03`：Given watcher 重启或重复事件，When 恢复处理，Then 使用幂等键去重，不重复形成画像事实。
- **测试**：`TC-INTEG-PRO-SOURCE-001`、`TC-SEC-PRO-SOURCE-001`、`TC-RES-PRO-LIFECYCLE-001`。

<a id="fr-pro-003-本地画像与记忆提炼"></a>

### FR-PRO-003 本地画像与记忆提炼

- **Parent CAP**：`CAP-033`、`CAP-005`、`CAP-022`
- **触发**：本地观察批次达到处理条件或用户请求查看画像。
- **必须**：仅在本地处理观察，形成带证据、置信度、授权修订和来源范围的 `ProfileClaim`；允许自动生成 `inferred` 候选并提炼为既有用户记忆，但不得跳过记忆层级、来源链或用户确认规则；支持查看、确认、纠正、拒绝和删除。
- **异常**：本地模型/Embedding 不可用、证据冲突、来源已撤权、提炼失败或记忆写入失败。
- **数据**：`ProfileClaim`、`MemoryRecord/Revision/Event`、`MemoryEvidence`；所有派生记录继承 `processingBoundary=local_only`。
- **验收**：
  - `AC-FR-PRO-003-01`：Given 多个有效本地观察，When 处理，Then 生成 `inferred` claim 并显示证据、置信度和适用范围。
  - `AC-FR-PRO-003-02`：Given 用户确认 claim，When 提炼为长期记忆，Then 保留来源捕获、grant revision 和提炼事件，且不覆盖原始事实。
  - `AC-FR-PRO-003-03`：Given 用户纠正或拒绝 claim，When 后续召回/画像处理，Then 该 claim 不再按原结论参与个性化，并保留纠正历史。
  - `AC-FR-PRO-003-04`：Given 本地处理不可用或证据冲突，When 运行提炼，Then 保留待处理/冲突状态，不向远端降级或写成用户事实。
- **测试**：`TC-AIEVAL-PRO-001`、`TC-INTEG-PRO-MEM-001`、`TC-SEC-PRO-LOCAL-001`。

<a id="fr-pro-004-后台生命周期与恢复"></a>

### FR-PRO-004 后台生命周期与恢复

- **Parent CAP**：`CAP-033`、`CAP-018`、`CAP-027`
- **触发**：用户在授权向导中启用后台生命周期，或设备发生退出、休眠、唤醒、重启和登录事件。
- **必须**：经用户确认后支持开机自启、应用退出后常驻、休眠恢复和重启自动恢复；每次启用、恢复、挂起、异常和关闭均向用户告知并显示当前状态；恢复必须重新校验 grant、lease、版本和 deny 水位。
- **异常**：OS 禁止自启、Host 未签名、lease 过期、设备锁定、应用崩溃或系统资源不足。
- **数据**：`LocalActivationLease`、后台状态和 `ProactiveAuditEvent`；后台状态不得代替 Turn 级授权。
- **验收**：
  - `AC-FR-PRO-004-01`：Given 用户已勾选后台、自启、休眠恢复和重启恢复，When 应用退出/系统重启/唤醒，Then 按授权恢复并显示恢复通知。
  - `AC-FR-PRO-004-02`：Given 用户未授权某项生命周期，When 发生对应事件，Then 不常驻/不自启/不恢复，并显示未启用原因。
  - `AC-FR-PRO-004-03`：Given lease 或任一必要 grant 失效，When 后台尝试恢复，Then 先挂起观察和动作，再显示待用户处理状态。
- **测试**：`TC-RES-PRO-LIFECYCLE-001`、`TC-E2E-PRO-LIFECYCLE-001`、`TC-E2E-PRO-NOTICE-001`。

<a id="fr-pro-005-主动动作执行"></a>

### FR-PRO-005 主动动作执行

- **Parent CAP**：`CAP-033`、`CAP-002`、`CAP-007`、`CAP-020`、`CAP-030`
- **触发**：主动规划器根据有效画像生成动作请求。
- **必须**：用户确认 `FullProfileActionGrant` 后，可在声明的范围内执行本地文件修改、浏览器/家居控制、外部消息、特权和不可逆动作；动作请求必须绑定授权修订、目标 scope、当前 lease、OS/身份授权和 deny 水位，并记录请求、结果、通知和可撤销状态。模型或外部内容不得自行扩大动作范围。
- **异常**：动作未声明、目标超 scope、授权过期/撤销、OS 拒绝、连接器不可用、执行结果未知或用户关闭主动智能。
- **数据**：`ProactiveAction`、`ToolInvocation/ToolExecution`、`ProactiveAuditEvent`；不得把动作结果隐式写入其他主体或工作区。
- **验收**：
  - `AC-FR-PRO-005-01`：Given 用户已确认覆盖目标的 `FullProfileActionGrant`，When 规划器请求合法本地/外部/特权/不可逆动作，Then 在当前授权快照下执行并向用户显示动作与结果。
  - `AC-FR-PRO-005-02`：Given 动作目标超出授权 scope 或 grant 已撤销，When 请求执行，Then 拒绝且不产生副作用，记录拒绝原因。
  - `AC-FR-PRO-005-03`：Given 执行中用户撤权或 lease 过期，When 动作尚未完成，Then 停止可停止步骤、禁止后续步骤并记录最终状态。
  - `AC-FR-PRO-005-04`：Given 外部内容包含要求扩大权限的提示，When 规划动作，Then 保持原授权范围，不因 Prompt injection 扩权。
- **测试**：`TC-SEC-PRO-ACTION-001`、`TC-E2E-PRO-ACTION-001`、`TC-SEC-PROMPT-001`。

<a id="fr-pro-006-暂停撤权与删除"></a>

### FR-PRO-006 暂停、撤权与删除

- **Parent CAP**：`CAP-033`、`CAP-005`、`CAP-013`、`CAP-026`、`CAP-027`
- **触发**：用户暂停、撤销单个来源/动作、关闭完整画像或请求删除。
- **必须**：暂停立即停止读取、召回、画像处理、提醒和动作但保留未撤销本地数据；撤权先写 deny，再停止相关句柄/任务、失效派生索引和记忆证据；全量关闭提供保留、导出或删除选择与进度。
- **异常**：重复撤权、清理失败、后台任务竞态、恢复点早于撤权账本。
- **数据/API**：`RecoveryControlLedger`、`DeletionRequest/Target`、来源/记忆/动作状态；来源级删除经 `DELETE /v1/proactive/sources/:sourceGrantId/data` 同步撤销对应 consent、scrub 捕获、删除 observation/claim 并撤销匹配动作；清理过程幂等可重试。
- **验收**：
  - `AC-FR-PRO-006-01`：Given 用户暂停，When 新事件或任务到达，Then 不再读取、召回或执行，且界面显示已暂停。
  - `AC-FR-PRO-006-02`：Given 用户撤销单个 scope，When deny 事件持久化，Then 该 scope 立即零召回/零动作，其他有效 scope 不被误撤销。
  - `AC-FR-PRO-006-03`：Given 用户请求删除来源，When 调用来源级删除接口并运行清理，Then 撤销对应 consent，scrub 捕获、删除 observation/claim、撤销匹配动作，并显示进度。
  - `AC-FR-PRO-006-04`：Given 清理失败或恢复旧快照，When 系统对账，Then 保持 deny、重试清理并禁止来源复活。
- **测试**：`TC-PRIV-PRO-REVOKE-001`、`TC-RES-PRO-REVOKE-001`、`TC-RES-LEDGER-001`。

<a id="fr-pro-007-主动画像导出"></a>

### FR-PRO-007 主动画像导出

- **Parent CAP**：`CAP-033`、`CAP-026`、`CAP-027`
- **触发**：用户在本地控制面请求导出。
- **必须**：提供不依赖专有客户端的本地导出，包含用户选择的原始捕获副本、观察、画像 claim、记忆、授权/撤权、后台状态、动作/触发历史和来源 manifest；结构化数据使用 UTF-8 JSON/CSV/Markdown，并附 schema、manifest 和 checksum；不得导出密钥、凭据或可恢复已删正文的 tombstone。
- **异常**：导出范围为空、清理进行中、磁盘不足、checksum 不一致或目标路径不可写。
- **数据**：导出任务及 `ProactiveAuditEvent`；导出目标由用户显式选择，不自动上传。
- **验收**：
  - `AC-FR-PRO-007-01`：Given 用户选择导出范围，When 导出完成，Then 文件可独立读取且包含版本、来源、授权状态和 checksum。
  - `AC-FR-PRO-007-02`：Given 主动 Consent 被暂停或撤销，When 用户导出已保存数据，Then 导出权仍可用且不恢复召回/动作。
  - `AC-FR-PRO-007-03`：Given 导出中发生来源删除，When 生成 manifest，Then 标记缺失/撤权状态，不重新包含已删正文。
- **测试**：`TC-API-PRO-EXPORT-001`、`TC-PRIV-PRO-EXPORT-001`。

<a id="br-pro-001-激活前置与状态"></a>

### BR-PRO-001 激活前置与状态

- **Parent CAP**：`CAP-033`、`CAP-002`、`CAP-007`、`CAP-018`、`CAP-020`
- **规则**：工具轴 `ask|full_access`、画像期望状态、设备 grant/动作 grant 和有效运行状态独立保存。只有 `full_access`、用户确认的 profile revision、匹配的 full action grant、受信本地 Host、有效 activation lease、必要 OS grant、本地处理证明和 deny 水位同时满足时，才显示「主动智能模式」；缺失时显示受限/挂起原因。
- **验收**：
  - `AC-BR-PRO-001-01`：Given 任一前置条件失效，When 计算状态，Then 不显示完整主动智能模式并给出具体缺口。
  - `AC-BR-PRO-001-02`：Given 用户显式暂停，When 计算状态，Then 期望状态为 paused，必须由用户恢复；系统临时故障只改变 effective state。
  - `AC-BR-PRO-001-03`：Given 工具轴从 full_access 变为 ask，When 后台处理，Then 停止主动观察/动作，不篡改用户授权修订。
- **测试**：`TC-UNIT-PRO-STATE-001`、`TC-E2E-PRO-STATE-001`。

<a id="br-pro-002-授权修订与撤销"></a>

### BR-PRO-002 授权修订与撤销

- **Parent CAP**：`CAP-033`、`CAP-020`、`CAP-023`、`CAP-027`
- **规则**：来源、用途、动作和后台能力均写入版本化 manifest 与独立 grant；新增来源/用途/动作或政策版本必须创建新 revision 并重新确认；任一 scope 可独立撤销，旧 revision 不得继续命中。
- **验收**：
  - `AC-BR-PRO-002-01`：Given manifest 增加来源或动作，When 保存，Then revision 递增并要求重新确认，旧 revision 不自动扩大。
  - `AC-BR-PRO-002-02`：Given 用户撤销一个 scope，When 其他 scope 仍有效，Then 仅该 scope 停止，主状态按剩余 grant 重新计算。
  - `AC-BR-PRO-002-03`：Given grant 已过期或设备变更，When 请求处理/动作，Then 旧快照不命中并写入审计。
- **测试**：`TC-SEC-PRO-GRANT-001`、`TC-PRIV-PRO-CONSENT-001`。

<a id="br-pro-003-本地处理边界"></a>

### BR-PRO-003 本地处理边界

- **Parent CAP**：`CAP-033`、`CAP-005`、`CAP-022`、`CAP-026`、`CAP-027`
- **规则**：`processingBoundary=local_only` 和 grant/source provenance 从捕获、观察、画像、记忆、提醒到动作/ContextManifest 单向继承；本地 Provider、存储或出网策略不可证明时 fail closed，不得远程降级、重定向或进入普通分析/日志。
- **验收**：
  - `AC-BR-PRO-003-01`：Given 任一派生记录缺少 local-only provenance，When 写入或召回，Then 拒绝并记录错误。
  - `AC-BR-PRO-003-02`：Given 本地 LLM/Embedding/OCR/ASR 不可用，When 处理请求，Then 降级为本地可验证路径或挂起，不上传数据。
  - `AC-BR-PRO-003-03`：Given 发生 redirect、代理转发或远程 endpoint，When 准入校验，Then 阻断处理并保留最小审计。
- **测试**：`TC-SEC-PRO-LOCAL-001`、`TC-RES-PRO-LOCAL-001`。

<a id="br-pro-004-原始副本保留与提炼"></a>

### BR-PRO-004 原始副本保留与提炼

- **Parent CAP**：`CAP-033`、`CAP-005`、`CAP-026`
- **规则**：屏幕、音频、输入、剪贴板和文件原始副本按 `observedAt + 7 天` 写入 `retentionUntil`；达到期限且 `distillationStatus=distilled` 后才可物理删除。提炼失败或未完成时不得因定时清理删除；用户主动删除仍可提前触发删除传播。提炼后的记忆必须保留来源哈希、grant revision 和证据链。
- **验收**：
  - `AC-BR-PRO-004-01`：Given 捕获未满七天，When 清理任务运行，Then 保留原始副本且不标记 deleted。
  - `AC-BR-PRO-004-02`：Given 捕获已满七天且提炼状态为 distilled，When 清理任务运行，Then 删除原始副本并保留可追溯的记忆证据。
  - `AC-BR-PRO-004-03`：Given 捕获已满七天但提炼 pending/failed，When 清理任务运行，Then 不删除，重试提炼并向用户显示待处理状态。
- **测试**：`TC-INTEG-PRO-RETENTION-001`、`TC-PRIV-PRO-RETENTION-001`。

<a id="br-pro-005-全动作授权快照"></a>

### BR-PRO-005 全动作授权快照

- **Parent CAP**：`CAP-033`、`CAP-002`、`CAP-007`、`CAP-020`
- **规则**：`FullProfileActionGrant` 可覆盖 `action.local`、`action.external`、`action.privileged` 和不可逆动作；用户确认是唯一授权来源，模型、插件、外部内容和旧 Turn 快照不能自授或扩大范围。每次动作必须校验 grant revision、目标 scope、OS/身份授权、lease、deny ledger、幂等键和执行配额，并写入审计/通知。
- **验收**：
  - `AC-BR-PRO-005-01`：Given 用户确认覆盖动作的 grant，When 请求合法动作，Then 使用当前快照执行且记录 `approvedBy=user` 与结果。
  - `AC-BR-PRO-005-02`：Given 未确认、已撤销、过期或目标不匹配，When 请求任一动作类别，Then 拒绝并无副作用。
  - `AC-BR-PRO-005-03`：Given 输入内容要求提升权限，When 计算动作授权，Then 只使用用户已确认 scope，不采纳输入中的权限声明。
- **测试**：`TC-SEC-PRO-ACTION-001`、`TC-INTEG-PRO-AUDIT-001`。

<a id="br-pro-006-后台恢复与通知"></a>

### BR-PRO-006 后台恢复与通知

- **Parent CAP**：`CAP-033`、`CAP-010`、`CAP-018`、`CAP-030`
- **规则**：后台、自启、休眠恢复和重启恢复只能按用户已确认的 persistence grant 运行；启用前和每次恢复/挂起/异常必须生成用户可见通知与审计事件；暂停、撤权和 deny 事件优先于恢复。
- **验收**：
  - `AC-BR-PRO-006-01`：Given persistence grant 已启用，When 后台 Host 恢复，Then 展示恢复时间、来源范围和当前授权版本。
  - `AC-BR-PRO-006-02`：Given 用户关闭 persistence 或主动智能，When 系统重启/唤醒，Then 不恢复观察或动作，并显示关闭状态。
  - `AC-BR-PRO-006-03`：Given 恢复校验失败，When Host 尝试启动，Then 进入 suspended/limited，记录原因且不静默重试越权动作。
- **测试**：`TC-E2E-PRO-NOTICE-001`、`TC-RES-PRO-LIFECYCLE-001`。

<a id="srs-pro-data"></a>

### DATA-PRO-001 CAP-033 数据实体与租户绑定

- **Parent CAP**：`CAP-033`
- **必须**：`ProfileAuthorizationRevision`、`DeviceCapabilityGrant`、`LocalActivationLease`、`RawCaptureSegment`、`BehaviorObservation`、`ProfileClaim`、`ProactiveAction` 和 `ProactiveAuditEvent` 均绑定 `(workspaceId, subjectUserId)`、设备、授权修订和处理边界；主动数据不得写入远程同步旁路或普通分析表。
- **验收**：
  - `AC-DATA-PRO-001-01`：Given 跨 workspace/subjectUserId 请求，When 读取或导出 CAP-033 数据，Then 返回 404/无权且不泄露存在性。
  - `AC-DATA-PRO-001-02`：Given 派生记录缺少来源 grant 或 revision，When 写入，Then 事务拒绝并不产生孤儿数据。
  - `AC-DATA-PRO-001-03`：Given 删除或撤权一个来源，When Worker 重试，Then 仅处理对应租户和 revision，不影响其他主体。
- **测试**：`TC-INTEG-PRO-SCHEMA-001`、`TC-SEC-TENANT-001`。

<a id="aiq-pro-001-画像推断质量"></a>

### AIQ-PRO-001 画像推断质量

- **Parent CAP**：`CAP-033`、`CAP-005`、`CAP-022`
- **必须**：画像声明区分 `observed|inferred|user_asserted|confirmed|rejected`，保存证据范围、置信度、首次/最近观察时间和算法/模型版本；未经用户确认的敏感属性不得写为用户事实或用于未授权动作。
- **验收**：
  - `AC-AIQ-PRO-001-01`：Given 画像候选生成，When 展示，Then 可定位证据和授权版本并显示推断状态。
  - `AC-AIQ-PRO-001-02`：Given 用户拒绝或纠正，When 重新召回，Then 原结论不再生效，且纠正事件可导出。
  - `AC-AIQ-PRO-001-03`：Given 模型/算法版本更新，When 重算画像，Then 保留旧版本、差异和可回滚路径，不静默覆盖确认记忆。
- **测试**：`TC-AIEVAL-PRO-001`、`TC-AIEVAL-MEM-001`。

<a id="sec-pro-001-受信-host-与-os-权限"></a>

### SEC-PRO-001 受信 Host 与 OS 权限

- **Parent CAP**：`CAP-033`、`CAP-018`、`CAP-020`
- **必须**：主动观察和动作只能运行在可验证签名的本地 Host/Helper；每项 OS 能力报告请求、授权、撤销、最后验证时间和失败原因；Host 不得绕过 Secure Input、文件 ACL、受保护进程或应用加密。
- **控制面认证**：生产 CAP-033 loopback 控制面必须使用私密目录 `0600` 的 owner-only `proactive-access.token`，只接受字面 loopback 请求并拒绝 redirect/代理；token 不得写入业务数据、日志、备份或导出。
- **验收**：
  - `AC-SEC-PRO-001-01`：Given Host 未签名、设备不匹配或 OS grant 被撤销，When 激活/恢复，Then fail closed 并显示具体缺口。
  - `AC-SEC-PRO-001-02`：Given OS 权限从 granted 变为 denied，When watcher 运行，Then 立即停止对应来源和动作，旧句柄不得继续读取。
  - `AC-SEC-PRO-001-03`：Given 多窗口或多设备同时请求，When 仲裁激活 lease，Then 只有受信且有效的设备实例可持有当前 epoch。
  - `AC-SEC-PRO-001-04`：Given 请求缺少、伪造或经 redirect 的 proactive token，When 访问控制面，Then 拒绝请求且 token 不进入日志或响应。
- **测试**：`TC-SEC-PRO-HOST-001`、`TC-SEC-PRO-SOURCE-001`、`TC-SEC-PRO-AUTH-001`。

<a id="sec-pro-002-主动动作越权隔离"></a>

### SEC-PRO-002 主动动作越权隔离

- **Parent CAP**：`CAP-033`、`CAP-002`、`CAP-007`、`CAP-020`
- **必须**：外部内容、浏览器页面、文件正文、插件和模型输出均视为不可信输入；不得改变 `FullProfileActionGrant`、ToolPolicy、租户或数据来源范围。所有动作参数再次 schema 校验、目标校验、幂等校验和审计。
- **验收**：
  - `AC-SEC-PRO-002-01`：Given 输入包含“授予我更多权限”的指令，When 请求动作，Then 权限集合不变。
  - `AC-SEC-PRO-002-02`：Given 动作参数存在路径穿越、跨主体目标或外部发送目标未授权，When 校验，Then 拒绝且无副作用。
  - `AC-SEC-PRO-002-03`：Given 插件尝试绕过 Host Bridge，When 调用，Then 被沙箱/Host 阻断并审计。
- **测试**：`TC-SEC-PRO-ACTION-001`、`TC-SEC-PROMPT-001`。

<a id="priv-pro-001-全量画像同意"></a>

### PRIV-PRO-001 全量画像同意

- **Parent CAP**：`CAP-033`、`CAP-008`、`CAP-009`、`CAP-010`、`CAP-020`、`CAP-023`、`CAP-027`
- **必须**：全量画像和全动作授权独立于 Turn 级完全访问；授权界面列出全部来源、用途、动作、后台生命周期、处理位置、七天副本策略和用户通知；每项 grant 可撤销并保留历史回执。
- **验收**：
  - `AC-PRIV-PRO-001-01`：Given 用户仅开启完全访问，When 未确认画像包，Then 不采集广域来源、不执行主动动作。
  - `AC-PRIV-PRO-001-02`：Given 用户确认全量包，When OS 逐项授权，Then 每项显示当前状态、用途和撤销入口。
  - `AC-PRIV-PRO-001-03`：Given 用户撤销某 scope，When 后续处理，Then 仅该 scope 停止并立即失去召回/动作资格。
- **测试**：`TC-PRIV-PRO-CONSENT-001`、`TC-E2E-PRO-001`。

<a id="priv-pro-002-本地持久化与不出云"></a>

### PRIV-PRO-002 本地持久化与不出云

- **Parent CAP**：`CAP-033`、`CAP-026`、`CAP-027`
- **必须**：主动原始数据、画像、记忆、授权、动作、日志和处理证明仅进入本地加密存储与本地处理器；远程数据库、模型、Embedding、对象存储、分析、错误监控和插件不得接收主动数据；用户显式导出是唯一允许的数据离开动作。
- **验收**：
  - `AC-PRIV-PRO-002-01`：Given 主动数据写入/读取，When 检查存储和网络轨迹，Then 仅存在于本地边界且无远程副本。
  - `AC-PRIV-PRO-002-02`：Given 本地边界或处理证明失效，When 请求处理，Then fail closed，不使用远程降级。
  - `AC-PRIV-PRO-002-03`：Given 用户显式导出，When 写入目标文件，Then 记录导出审计，不自动同步到云端目录。
- **测试**：`TC-SEC-PRO-LOCAL-001`、`TC-PRIV-PRO-EXPORT-001`。

<a id="priv-pro-003-保留删除与导出"></a>

### PRIV-PRO-003 保留、删除与导出

- **Parent CAP**：`CAP-033`、`CAP-005`、`CAP-013`、`CAP-026`、`CAP-027`
- **必须**：原始副本遵循七天且完成记忆提炼后删除的规则；用户主动删除优先于保留策略；撤权/删除立即停止召回和动作，并在本地派生数据、索引、备份恢复和导出 manifest 中传播状态；导出权不因暂停或撤权失效。
- **验收**：
  - `AC-PRIV-PRO-003-01`：Given 捕获未提炼，When 到达七天，Then 保留并显示提炼待处理，不丢失原始副本。
  - `AC-PRIV-PRO-003-02`：Given 用户主动删除来源，When 请求确认，Then 立即 deny/零召回，异步清理可见且可重试。
  - `AC-PRIV-PRO-003-03`：Given 用户撤销主动同意，When 导出历史数据，Then 可导出但不会恢复任何读取、召回或动作。
- **测试**：`TC-PRIV-PRO-RETENTION-001`、`TC-PRIV-PRO-REVOKE-001`。

<a id="ops-pro-001-后台运行与恢复"></a>

### OPS-PRO-001 后台运行与恢复

- **Parent CAP**：`CAP-033`、`CAP-018`、`CAP-027`、`CAP-030`
- **必须**：后台 Host 维护 activation heartbeat/expiry、崩溃恢复、重启/休眠恢复、队列幂等和优雅关闭；暂停、撤权、deny 和设备解绑必须优先于恢复；所有状态变化可告知用户并可审计。
- **验收**：
  - `AC-OPS-PRO-001-01`：Given Host 心跳过期，When Worker/Helper 检查，Then 主动状态进入 suspended，停止新观察和动作。
  - `AC-OPS-PRO-001-02`：Given Host 崩溃后重启，When 恢复候选被扫描，Then 重新校验授权和水位，幂等恢复，不重复执行已完成动作。
  - `AC-OPS-PRO-001-03`：Given 用户暂停或撤权发生在恢复竞争期间，When 两者并发，Then deny/暂停获胜，旧恢复任务无副作用。
- **测试**：`TC-RES-PRO-LIFECYCLE-001`、`TC-PERF-PRO-001`。

---

## 2. CAP-033～035 主动智能派生与外部信号

### FR-PRO-013 十二项主动智能派生

- **Parent CAP**：`CAP-033`
- **必须**：本地 Worker 从有效画像修订、观察、声明、动作和外部规范化信号中生成统一个人时间线、项目与意图图谱、操作流程、主动触发、动作验证、声明冲突、准备包、注意力/疲劳、行为漂移、关系上下文、场景快照和日/周回顾；所有输出绑定租户、画像修订和 `local_only`。
- **验收**：
  - `AC-FR-PRO-013-01`：Given 重复操作与项目事件，When Worker 运行，Then 生成时间线、项目和候选流程，并保留证据 ID。
  - `AC-FR-PRO-013-02`：Given 冲突声明、已完成动作、临近承诺和停滞项目，When Worker 运行，Then 分别生成冲突、验证、准备、漂移和去重触发。
  - `AC-FR-PRO-013-03`：Given 当日或当周有本地活动，When Worker 运行，Then 同一周期回顾幂等更新，不重复创建提醒。
- **测试**：`TC-INTEG-PRO-INTELLIGENCE-001`。

### FR-HA-001 Home Assistant 连接与感知

- **Parent CAP**：`CAP-034`、`CAP-033`
- **必须**：仅接受私网、回环或 `.local` HA 端点；凭据加密保存且不回显；同步实体目录并允许逐实体启用；WebSocket 只消费已授权实体的 `state_changed`，转为本地场景/时间线信号。
- **验收**：
  - `AC-FR-HA-001-01`：Given 公网或 redirect 端点，When 连接，Then 拒绝且不持久化 Token。
  - `AC-FR-HA-001-02`：Given 实体未启用，When 状态变化，Then 不进入时间线和模型工具结果。
  - `AC-FR-HA-001-03`：Given 连接撤销，When 后续事件或同步发生，Then 订阅停止，凭据与实体缓存被删除。
- **测试**：`TC-INTEG-HA-001`、`TC-SEC-HA-SSRF-001`。

### FR-HA-002 Home Assistant 受控执行

- **Parent CAP**：`CAP-034`、`CAP-033`、`CAP-002`、`CAP-007`
- **必须**：`ha_call_service` 仅能作用于已启用实体和允许的 service，并通过当前 `FullProfileActionGrant` 的 `action.external` 校验；调用结果进入动作账本和验证队列。
- **验收**：
  - `AC-FR-HA-002-01`：Given 实体或 service 不在白名单，When 请求调用，Then 返回 403 且 HA 无副作用。
  - `AC-FR-HA-002-02`：Given 白名单与主动动作授权有效，When 调用，Then 强制目标 `entity_id`、记录 running/executed 或 failed，并可追踪结果。
- **测试**：`TC-SEC-HA-ACTION-001`。

### FR-HEALTH-001 小米运动健康按日同步

- **Parent CAP**：`CAP-035`、`CAP-033`
- **必须**：使用用户自己有权使用的官方开放平台 HTTPS 配置同步每日步数、睡眠分钟和静息心率；支持 Token 刷新；不持久化完整供应商响应，不采用逆向私有协议，不宣称 Aervox 已获厂商审批。
- **验收**：
  - `AC-FR-HEALTH-001-01`：Given 有效配置，When 同步指定日期，Then 三类可用指标按 `(tenant, connection, metric, date)` 幂等更新。
  - `AC-FR-HEALTH-001-02`：Given Access Token 过期且 Refresh Token 可用，When 返回 401，Then 刷新后重试且新 Token 仍只存本地 Vault。
  - `AC-FR-HEALTH-001-03`：Given 连接撤销，When 查询或同步，Then 凭据和健康样本删除，只读工具不再返回数据。
- **测试**：`TC-INTEG-HEALTH-001`、`TC-PRIV-HEALTH-001`。

### PRIV-EXT-001 外部连接凭据与数据最小化

- **Parent CAP**：`CAP-034`、`CAP-035`、`CAP-033`
- **必须**：连接 Token、Refresh Token、Client Secret 和私密设置不得进入日志、模型上下文、普通分析、API 响应或导出；HA 只缓存受限属性，健康只保存规范化每日指标；按连接撤销执行本地删除。
- **验收**：`TC-PRIV-EXT-CREDENTIAL-001`、`TC-PRIV-HEALTH-001`。
