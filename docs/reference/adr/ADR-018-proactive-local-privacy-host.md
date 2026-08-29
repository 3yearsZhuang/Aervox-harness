---
id: ADR-018
type: reference
scope: decision
owner: product-platform
doc_status: review-candidate
decision_status: proposed
delivery_status: planned
version: 0.1.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 60
sources:
  - docs/reference/changes/CR-023-proactive-local-intelligence-mode.md
  - docs/explanation/proactive-intelligence-mode.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/THREAT_MODEL.md
  - docs/reference/DATABASE.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
---

# ADR-018 CAP-033 本地私密存储与主动能 Host

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-08-29

关联：[CR-023](../changes/CR-023-proactive-local-intelligence-mode.md)、[主动智能设计方案](../../explanation/proactive-intelligence-mode.md)、[数据与隐私](../DATA_PRIVACY.md)、[威胁模型](../THREAT_MODEL.md)、[数据库契约](../DATABASE.md)

## Context

CAP-033 需要在用户确认后持续观察设备全部可用来源、形成完整本地画像、执行用户授权的主动动作，并支持开机自启、应用退出后常驻、休眠恢复和重启自动恢复。现有 API、Worker、普通 SQLite/远程 `DATABASE_URL`、模型 Provider 和 Electron renderer 边界不能证明这些数据始终留在本机，也没有设备级激活租约或统一的 OS 权限回执。

## Decision drivers

- 用户明确要求画像原始数据、派生数据、记忆、动作和控制面不上传云端；
- 用户明确允许全量来源、后台生命周期和全动作授权，但授权必须可见、可撤销、可审计；
- 原始捕获副本保留七天，完成记忆提炼后才允许物理清理；
- 观察内容和模型输出不能改变授权范围、租户边界或删除权；
- 现有 Web/API/Worker 仍需保持可用，CAP-033 失败不得破坏核心学习闭环。

## Considered options

1. **直接复用普通 API/数据库/renderer**：改动少，但无法证明本地边界、后台身份和 OS 权限不会被旁路，拒绝。
2. **把所有数据放入云端并以 UI 承诺本地**：违反产品承诺，拒绝。
3. **受信签名 Local Privacy Host + 独立本地私密存储 + OS Permission Broker（本决策方向）**：在设备上拥有观察、处理、动作和生命周期控制；通过 Port 与主应用交互，便于撤权和回滚。

## Decision

CAP-033 采用受信签名的本地 Privacy Host/Helper 作为唯一主动观察和动作执行宿主，并通过 OS Permission Broker 取得、复核和撤销每项系统能力。Host 维护设备级 `FullProfileGrant`、`FullProfileActionGrant`、activation epoch/heartbeat/expiry 和用户可见状态；普通 Turn 的 `toolApprovalMode=ask|full_access` 仍由 CR-022 独立维护。

主动数据面使用本地加密存储，记录授权修订、来源 grant、捕获、画像声明、动作、租约和审计。所有记录必须绑定 `(workspaceId, subjectUserId, deviceId, revision)` 与 `processingBoundary=local_only`，不得写入远程数据库、远程模型/Embedding、普通分析、错误监控或自动云备份。生产控制面还必须使用私密目录中的 owner-only `proactive-access.token`（文件权限 `0600`），仅接受字面 loopback 请求并拒绝 redirect；令牌不得进入业务表、日志或导出。用户显式导出是唯一允许的数据离开动作。

`FullProfileActionGrant` 可覆盖 `action.local`、`action.external`、`action.privileged` 和不可逆动作。每次动作仍需校验当前 revision、目标 scope、OS/身份授权、Host lease、deny watermark、幂等键和策略配额，并记录用户可见通知与结果；模型、插件和外部内容不能自行授予或扩大权限。

用户确认的 persistence grant 可启用开机自启、应用退出后常驻、休眠恢复和重启自动恢复。恢复前重新校验授权、Host 签名、版本、OS grant 和 deny 水位；暂停、撤权和删除优先于恢复。原始捕获按 `observedAt + 7 天` 计算保留期限，且完成记忆提炼后才可物理清理；用户主动删除可提前触发传播。

当前分支已落地本 ADR 的部分可验证路径：本地 Vault/加密、loopback token、授权/lease、已接入来源采集、动作授权器、提炼 Worker、来源级删除、导出和 heartbeat；其余平台 entitlement、系统级来源适配器、出网阻断、旁观者/凭据过滤和生产灾备语义仍待验证。本 ADR 保持 `Proposed`，在上述门禁完成前不得将 CAP-033 标为 `Ready` 或宣称全量广域能力已发布。

## Positive consequences

- 主动数据的本地边界、授权生命周期和动作审计有单一宿主；
- Web/API/Worker 核心学习闭环与高权限观察面隔离，Host 失败可以降级为普通完全访问或操作需确认；
- 版本化 grant、七天提炼门和本地导出为删除、纠错和迁移提供可验证证据。

## Negative consequences and risks

- 需要维护签名 helper、平台 entitlement、密钥和后台生命周期，跨平台测试成本高；
- 本地存储损坏、磁盘耗尽或 OS 权限变更可能使主动模式挂起；
- 全动作授权扩大误操作和外发风险，必须完成动作目标、撤权和恢复测试；
- 本地备份/导出若进入云同步目录可能违背用户对本地边界的理解，需明确提示和后续决策。

## Migration / rollback

先以 `proactive_*` schema、Port、Host/UI 契约和 Feature Flag 进行 Expand；在本地存储、OS Broker、Provider 出网证明和删除/导出测试完成前保持 `inactive`。若任一门禁失败，停用 CAP-033 flag、结束 activation lease、停止 watcher/动作，保留可导出的控制记录和已确认记忆；不回滚或删除 CR-022 的 Turn 级权限数据。

## Verification evidence

接受前至少提供：

- signed Host/OS Permission Broker 的请求、撤销、休眠、重启和多设备仲裁测试；
- 本地出网阻断、远程 Provider 拒绝、`local_only` 溯源和故障注入证据；
- 原始捕获七天/提炼清理、用户提前删除、零召回/零动作和恢复账本测试；
- `FullProfileActionGrant` 覆盖本地、外部、特权和不可逆动作的目标 scope、幂等、撤权和 Prompt injection 测试；
- 独立可读导出、密钥/凭据过滤、工作区隔离、备份恢复和用户通知验收。
