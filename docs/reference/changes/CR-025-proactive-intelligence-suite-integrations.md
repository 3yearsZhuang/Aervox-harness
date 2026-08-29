---
id: CR-025
type: reference
scope: change
owner: product-platform
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 60
review_triggers:
  - apps/api/src/modules/proactive/**
  - apps/worker/src/proactive-intelligence-worker.ts
  - packages/database/src/schema/proactive-intelligence.ts
  - Home Assistant 或小米开放平台政策变化
sources:
  - docs/reference/changes/CR-023-proactive-local-intelligence-mode.md
  - docs/explanation/home-assistant-integration-assessment.md
  - docs/explanation/health-data-integration-assessment.md
  - docs/reference/adr/ADR-019-proactive-integrations-local-gateway.md
---

# CR-025 主动智能能力套件与外部环境连接

- 提出人：3yearszhuang · 2026-08-29
- 修改人：3yearszhuang · 2026-08-29

本变更接受在 `CAP-033` 下落地十二项主动智能能力，并新增 `CAP-034 Home Assistant 家庭环境连接` 与 `CAP-035 运动健康信号连接`。机器可验证事实源是 `packages/contracts`、`packages/database`、`apps/api/src/modules/proactive`、`apps/worker/src/proactive-intelligence-worker.ts` 及对应测试。

## 变更范围

`CAP-033` 新增以下本地派生能力：统一个人时间线、项目与意图图谱、操作流程学习、情境主动触发、计划/执行/验证、画像冲突纠正、主动准备包、注意力与疲劳模型、行为漂移检测、关系与沟通上下文、本地场景模型、每日与每周自动回顾。

`CAP-034` 采用 Home Assistant REST + WebSocket 组合：读取和同步实体目录、订阅授权实体的 `state_changed`、提供 `ha_list_entities`、`ha_get_entity_state`、`ha_call_service` 工具。写操作必须同时满足当前主动动作授权、实体启用状态和服务白名单；脚本、重启和未列入白名单的服务默认拒绝。

`CAP-035` 采用可配置的小米官方开放平台云 API 适配器，同步每日步数、睡眠时长和静息心率，提供 `health_get_daily_steps` 与 `health_get_sleep_summary` 只读工具。用户必须提供自己有权使用的开发者配置和 Token；本变更不代表 Aervox 已获得小米厂商审批，也不使用逆向私有协议。

## 数据与授权

- 三项 CAP 均以有效的 `CAP-033` 主动智能模式和本地 Vault 为前置；HA 使用 `device.sensors`，健康数据使用 `restricted.profile`。
- 连接凭据与设置使用本地 Vault 加密；凭据不进入日志、模型上下文、普通分析、API 响应或导出。
- HA 连接只允许私网、回环或 `.local` 端点；HTTP redirect 被拒绝。小米健康端点要求 HTTPS，回环地址仅用于本地测试。
- 撤销连接立即停止订阅/同步，并删除本地凭据、HA 实体缓存或健康样本；派生时间线和画像继续按来源撤权与删除传播规则处理。
- 健康原始供应商响应不持久化，只保存按日规范化指标和最小元数据；睡眠与心率按 Restricted 处理。

## 交付证据

- 数据结构与仓储：`proactive-intelligence.ts`、`SqliteProactiveIntelligenceRepository`，覆盖 17 张本地表、租户隔离、字段加密、连接撤销和导出。
- 运行时：主动智能 Worker、Home Assistant Client/事件订阅器、小米健康 Client/Token 刷新、集成路由、五个 Agent 工具和桌面设置页。
- 测试：Database 主动智能仓储测试、API 集成测试、Worker 十二能力测试，以及 Contracts/UI/Desktop/API/Worker typecheck。

## 回滚

停用主动智能 Worker 和五个集成工具，停止 HA WebSocket，撤销连接并删除连接缓存；保留 `CAP-033` 原授权、画像和数据权利接口。数据库表采用 Expand 方式保留，不在回滚中破坏用户导出或删除权。
