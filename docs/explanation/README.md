---
id: AVX-EXPL-000
type: explanation
scope: baseline
owner: maintainers
doc_status: approved
version: 1.0.0
updated_at: 2026-10-01
reviewed_at: 2026-10-01
review_interval_days: 90
---

# Explanation 概念与架构解释索引 (Diátaxis)

根据 Diátaxis 文档架构，本目录承载**理解导向（Understanding-oriented）**的解释性内容：回答“为什么这样设计”、“系统的核心机制如何运作”以及“重要技术探索的权衡与结论”。

---

## 1. 长青系统机制 (Living Architectural Explanations)

此类文档解释 Aervox 的核心运作机理，随着架构演进而持续更新：

| 文档 | 负责回答 | 核心主题 |
|---|---|---|
| [数据流总览](data-flow-overview.md) | 一次对话与 Turn 如何在各进程间流转 | 跨进程通讯、生命周期、持久化时序 |
| [桌宠角色与多人格组织](persona-organization.md) | 桌宠设定、提示词注入与人格切换如何运作 | 人格资产、Prompt 分层、本地持久化 |
| [主动智能模式设计方案](proactive-intelligence-mode.md) | 主动智能、环境感知与免打扰机制的设计理念 | 四轴状态、画像构建、动作提议闭环 |
| [Web 工作台实现说明](web-implementation.md) | Vue 单栈下 Web 与桌面端如何共用组件 | 共享工作台、无桌宠形态、响应式适配 |

---

## 2. 技术探索与评估生命周期矩阵 (Explorations & Assessments)

技术调研与方案论证具有明确的生命周期。为避免历史过程文档污染现行真源，所有调研按以下三态分类维护：

### 2.1 [已落地] (Adopted / Implemented)

调研结论已转化为现有架构、核心代码或固定基线：

| 调研文档 | 转化成果与落地位置 | 状态 |
|---|---|---|
| [当前架构实现与演进评估](architecture-implementation-review.md) | ARC-01（Outbox 可靠派发）、ARC-14（CI 校验）已在 ITER-001/002 落地并进入基线 | 已落地部分，其余推进中 |
| [底层优化审阅与建议](foundation-optimization-review.md) | FND-01（Outbox 消费隔离）、FND-05 调度切片已闭环 | 已落地 |
| [参考项目能力迁移与借鉴评估](reference-design-transfer.md) | DSH、pi、AstrBot 上游版本固定已在 ITER-030 落地并完成准入固定 | 已落地 |
| [Pi AI 竞品差距分析与改进建议](pi-competitive-gap-improvements.md) | 差距分析已转化为 CR-056（Build to Delete）与 ITER-032 / 033 任务队列 | 已转化入队 |

### 2.2 [未落地 / 候选待决策] (Pending / Candidate)

调研结论成立、技术方案完备，作为未来迭代的候选储备池，等待排期或前置决策拉起：

| 调研文档 | 候选储备内容与拉起条件 | 对应规划条目 |
|---|---|---|
| [配套硬件方向评估](companion-hardware-directions.md) | 9 个硬件陪伴形态比较与成本边界；待硬件决策拉起 | ITER-009 / ITER-016 |
| [ESP32-S3 硬件延伸笔记](esp32-s3-hardware-extension.md) | 开发板原型笔记与串口协议验证；待硬件方向敲定 | 配套候选 |
| [HLS 本地智能体竞赛规划](hls-agent-competition-plan.md) | 三人团队、C++ 与 RX 9070 XT 实测方案；待资源到位拉起 | ITER-021 |
| [纯本地多端点对点加密同步架构探索](p2p-local-sync-exploration.md) | 承诺-揭示握手与 SQLite Changeset 局域网同步；待跨端同步启动 | ITER-028 |

### 2.3 [已放弃] (Abandoned / Rejected)

技术调研后证明不适用、成本过高或被新决策推翻的方向，负责记录“为什么不这么做”，防范重复踩坑：

| 放弃方向 | 放弃原因与替代结论 | 归档位置 |
|---|---|---|
| **早期云端多租户架构 (PostgreSQL + Redis + BullMQ + S3)** | 与本地单用户隐私底线冲突，运维沉重；已由 CR-030 彻底放弃，全面重构为纯本地 SQLite WAL | 图表已归档至 `Aervox-docs-archive/archive/` |
| **全局分布式事务与全局单写锁** | 引入全局锁导致性能雪崩；已由 ITER-027 改为本地自愈连接 + 压力租约机制替代 | 见 `client-self-heal.test.ts` |
