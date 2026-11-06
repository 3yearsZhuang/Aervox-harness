---
id: AVX-REF-000
---

# 参考文档索引

本目录包含 Aervox 的契约、规范与架构决策。按需查阅，不要求通读。

## 产品与需求

- [产品需求 PRD](PRD.md) — 产品面向谁、为什么做
- [软件需求 SRS](SRS.md) — 功能行为与验收标准
- [需求追踪与发布门槛](REQUIREMENTS_TRACEABILITY.md) — CAP 状态与交付证据

## 架构与设计

- [架构设计 SAD](ARCHITECTURE.md) — 模块、技术栈与演进
- [交互设计](DESIGN.md) — 界面与交互决策
- [能力组合](capability-composition.md) — Definition / Provider / Consumer
- [架构决策记录](adr/README.md) — 重大技术决定

## 运行时与协议

- [Agent Harness Loop](agent-harness-loop.md) — 执行循环与控制流
- [流式协议](STREAMING_PROTOCOL.md) — SSE 事件与持久化
- [数据库契约](DATABASE.md) — 默认 SQLite、可选 PostgreSQL、事务与离线迁移规则
- [API 约定](API_CONVENTIONS.md) — HTTP 路由与兼容策略

## 插件与扩展

- [插件契约](plugin-config-and-pages.md) — 配置、Page、Tool 与 Bot 接口

## 安全与隐私

- [AI 质量与安全](AI_QUALITY_SAFETY.md) — 模型安全护栏
- [威胁模型](THREAT_MODEL.md) — 攻击面与缓解
- [数据隐私](DATA_PRIVACY.md) — 数据生命周期与删除

## 运维

- [运行手册](operations.md) — 故障止损与日常运维
- [测试策略](TEST_STRATEGY.md) — 测试分层与覆盖策略

## 标准与规范

- [术语表](standards/terminology.md) — 统一术语与写法
- [代码与 API 命名规范](standards/naming-conventions.md) — 代码与 API 命名
