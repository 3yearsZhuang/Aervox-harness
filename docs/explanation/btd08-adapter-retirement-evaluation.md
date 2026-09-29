---
id: AVX-EXPL-014
type: explanation
scope: guide
planning_role: evidence
owner: ecosystem
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.2
updated_at: 2026-09-29
reviewed_at: 2026-09-29
review_interval_days: 90
review_triggers:
  - packages/agent-loop/**
  - packages/host-agent/**
  - docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md
sources:
  - docs/reference/changes/CR-056-build-to-delete-pi-style-architecture.md
  - docs/reference/adr/ADR-010-dsh-pi-adapters.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/ARCHITECTURE.md
---

# BTD-08 适配器去留评估与结项说明

- 提出人：3yearszhuang · 2026-09-29
- 修改人：3yearszhuang · 2026-09-29

本文记录 [CR-056](../reference/changes/CR-056-build-to-delete-pi-style-architecture.md) 的条件性 pi 适配器范围。2026-09-29 合并前复核撤回此前“原生能力全面覆盖”“全部切片验收完成”及“Verified/Released”的结论；历史复核见 [CR-056 §10.3](../reference/changes/CR-056-build-to-delete-pi-style-architecture.md#103-pr-231-合并前复核2026-09-29)，后续修复证据见 [§10.4](../reference/changes/CR-056-build-to-delete-pi-style-architecture.md#104-pr-231-缺陷修复切片2026-09-29)，不在本文另设问题清单或排期。

## 1. 准入与当前选择

CR-056 §5.9 要求先有原生扩展无法满足的具体用例，并具备 BTD-05/07 的边界证据；缺少用例时只作参考设计，不安装真实运行时。当前保留不启动条件性真实 pi 实验的选择，不因修复本次 PR 而增加进程外适配器或第二套会话真源。

这一选择只界定 BTD-08 的实验范围，不能证明原生控制、权限、恢复、生命周期和客户端均已完成。现有 Adapter 的约束继续由 [ADR-010](../reference/adr/ADR-010-dsh-pi-adapters.md) 和 [ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md) 承载；本文不替代已接受的隔离与准入要求。

## 2. 已有构件与证据边界

PR #230 已修复工具释放、Driver 关闭竞态与私有导入守卫，并完成物理退出、三阶段冷构建和真实临时 SQLite 数据权利演练。PR #231 已接线执行预算、父子控制和本地路由，统一带 fencing 的原子终态及实时/回放安全投影，补充 Fetch 重连、真实组件隔离和 CLI 工具闭环回归。完整权限/模型窗口、生产停机资源与跨进程恢复仍需独立验收；不能据这些修复断言业务全覆盖或生产可发布。

是否存在值得接入的外部生态用例仍需具体需求和固定轨迹比较。此前对“当前及可见未来均无需求”以及“原生全面超越”的绝对判断没有对应实测记录，不作为本次审查结论。

## 3. 状态与后续验收

CR-056 保持 Accepted / Implemented（部分实现），尚未 Verified 或 Released。ITER-014 的试点移交及 ITER-007/013 的剩余要求在[唯一当前队列](../../plan.md)和[追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)维护；BTD-08 的范围选择不关闭这些条目，也不降低原验收。

未来只有实际用例成立时才重新评估真实 pi 接入，并分别记录文本、流式、取消、工具与恢复的支持矩阵、固定版本及隔离证据。本次没有新增真实 pi 运行时、性能对比或生产发布验收。
