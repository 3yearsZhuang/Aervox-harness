---
id: CR-000
type: reference
scope: baseline
owner: maintainers
doc_status: approved
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.0
updated_at: 2026-10-01
reviewed_at: 2026-10-01
review_interval_days: 90
---

# 变更请求索引与归档导航 (Change Requests Index)

本目录承载 Aervox 项目的架构性变更请求（Change Request, CR）。

---

## 1. 变更请求治理原则

根据 [文档治理与事实源规范](../document-governance.md)，Aervox 遵循**“现行真源轻量化，历史过程冷归档”**原则：

- **活跃提案 (Active Proposals)**：处于讨论、评审或分步实施中的 CR 保留在本目录（例如 `CR-055`）；
- **已闭环变更 (Implemented / Closed)**：一旦变更全部实施完成并合入主线，技术事实直接固化至 `PRD.md`、`ARCHITECTURE.md` 与代码/测试真源中。阶段性实施计划与历史文本移交至独立外部归档仓库 **[`Aervox-docs-archive`](https://github.com/3yearsZhuang/Aervox-docs-archive)**，主仓不保留历史膨胀副本。

---

## 2. 现行活跃变更提案 (Active Proposals)

| 编号 | 标题 | 状态 | 交付规划 |
|---|---|---|---|
| `CR-055` | [CR-055 移动端落地范围与分阶段交付规划](CR-055-mobile-delivery-plan.md) | Proposed | Planned |
| `CR-057` | [CR-057 实施 HLS 本地智能体验证执行器](CR-057-hls-local-agent-validation.md) | Accepted | Implemented |
| `CR-060` | [CR-060 专注模式宿主去领域化与插件实现内聚](CR-060-focus-mode-host-decoupling.md) | Accepted | Implemented |

---

## 3. 已闭环历史变更归档 (Archived in Aervox-docs-archive)

以下变更均已完整实现并进入系统基线，详细提案与阶段性切片记录已归档至外部归档仓库：

| 阶段 | 涵盖 CR 范围 | 核心主题 |
|---|---|---|
| **桌面端与初期闭环** | `CR-002` ～ `CR-016` | Fairy Electron 桌面端、Live2D、语音配置、练习会话、离线 ASR |
| **文档与功能补全** | `CR-017` ～ `CR-029` | 错题工作流、主动智能初步接入、在线语音、预设与思隅设置 |
| **纯本地架构重构** | `CR-030` ～ `CR-045` | **全面去租户化**，确立 SQLite WAL 为永久本地单用户真源；态势内核与本地降级阶梯 |
| **工作台与领域重组** | `CR-046` ～ `CR-052` | 标准工作台形态（W1~W3）、UI 基础控件库、API 领域分组 |
| **本地运行时与架构演进** | `CR-053` ～ `CR-054` | llama.cpp 运行时 Provider 与模型生命周期托管 |
| **类 pi 分层与终端连接** | `CR-056`、`CR-058`、`CR-059` | Build to Delete 分层架构、思隅 CLI 连接版 (@aervox/cli)、共享客户端传输加固 |

> 👉 查阅已归档 CR 原文，请访问外部归档仓库：`Aervox-docs-archive/changes/`
