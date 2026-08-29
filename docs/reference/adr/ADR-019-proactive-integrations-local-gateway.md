---
id: ADR-019
type: reference
scope: decision
owner: product-platform
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 60
review_triggers:
  - apps/api/src/modules/proactive/integration-*.ts
  - packages/database/src/schema/proactive-intelligence.ts
  - Home Assistant REST/WebSocket 或小米 OAuth 契约变化
sources:
  - docs/reference/changes/CR-025-proactive-intelligence-suite-integrations.md
  - docs/reference/adr/ADR-018-proactive-local-privacy-host.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/THREAT_MODEL.md
---

# ADR-019 主动智能外部连接采用本地网关与受控工具

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-08-29

## Context

主动智能需要消费家庭环境和运动健康信号，并在用户授权后控制家庭设备。外部系统既包含局域网 Home Assistant，也包含用户获准使用的小米云 API；二者的凭据、实时性、敏感级别和撤销方式不同，不能直接暴露给 renderer 或模型。

## Decision drivers

- 凭据和私人信号必须留在本地 Vault，不能进入模型上下文或普通日志；
- 家居写操作必须复用 Agent 工具授权、动作审计和精确实体/服务白名单；
- HA 事件需要实时订阅，小米健康只需要低频每日汇总；
- 连接失败不能阻断对话、学习和 CAP-033 其它来源。

## Considered options

1. 模型直接调用外部 API：无法可靠隔离凭据和授权，拒绝。
2. 全部通过云端 Aervox 中转：违反 CAP-033 本地边界，拒绝。
3. 本地集成网关 + 受控工具 + 加密连接仓储：复用本地 Vault、ToolRuntime 和动作授权器，接受。
4. 首版即做 HA Custom Integration 或通用插件：增加双端发布和插件框架耦合，延后。

## Decision

API 本地进程承载 `ProactiveIntegrationManager`。Home Assistant 使用 REST 执行同步/读取/服务调用，使用 WebSocket 订阅 `state_changed`；只接受私网、回环或 `.local` 地址，拒绝 redirect。实体目录默认禁用，用户逐实体启用并设置允许的 service；`ha_call_service` 还必须通过 `ProactiveActionAuthorizer` 的 `action.external` 校验。

小米运动健康使用可配置的 HTTPS OAuth2/Token 适配器，支持 Access Token、Refresh Token 和用户自己的 Client 配置。只保存按日规范化的步数、睡眠分钟和静息心率，不保存完整供应商响应；不采用逆向协议，也不声称厂商审批。

两类连接统一存入 `proactive_external_connections`，凭据和私密设置使用 CAP-033 Vault cipher。连接撤销采用先停用运行时、再删除凭据与缓存的顺序。Worker 只消费规范化本地投影，生成十二项能力结果；外部调用失败按连接隔离并记录无凭据错误摘要。

## Positive consequences

- 模型只看到授权后的结构化工具和结果，不接触 Token；
- HA 的感知面和执行面复用同一实体白名单，撤销立即收敛；
- 健康信号能进入注意力、触发和回顾，但不复制原始云响应；
- 外部连接可独立失败、同步和删除。

## Negative consequences and risks

- API 进程承担 WebSocket 生命周期，需处理重连、休眠恢复和版本漂移；
- LLAT 有效期长，用户仍需在 HA 侧手动撤销；
- 小米开放平台可用性、审批和字段契约由用户账号与厂商政策决定；
- 本地健康样本和家庭状态扩大了设备被攻破时的敏感资产范围。

## Migration / rollback

采用新增表和新增路由的 Expand 迁移。回滚时先停止 Manager 与工具，再删除连接记录和缓存；不删除 CAP-033 其它画像数据。未来 OAuth、移动端 HealthKit/Health Connect 或插件载体通过新的 CR/ADR 扩展，不修改本 ADR 的凭据隔离和授权不变量。

## Verification evidence

- `apps/api/test/proactive-integrations.test.ts`：凭据不回显、HA 白名单与动作审计、小米健康同步、工具注册和撤销删除；
- `apps/worker/test/proactive-intelligence-worker.test.ts`：十二项能力及日/周回顾；
- `packages/database/test/proactive-intelligence.test.ts`：租户隔离、字段加密、HA/健康仓储和导出；
- Contracts OpenAPI 生成与 Database/API/Worker/UI/Desktop typecheck。
