---
id: AVX-EXPL-014
type: explanation
scope: guide
planning_role: evidence
owner: ecosystem
doc_status: approved
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
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

本文阐述 [CR-056](../reference/changes/CR-056-build-to-delete-pi-style-architecture.md) 剩余架构切片 **BTD-08（条件性 pi 适配器实验）** 的去留评估依据与最终退役（Retirement）裁决。通过系统比对业务实际需求、系统稳定性风险与原生核心成熟度，正式确立 BTD-08 的闭环结论。

---

## 1. 一句话模型

**思隅核心（Aervox Core）已在原生单用户架构内完全吸收并内化了 pi-mono 的极简分层与可替换 SPI 设计精髓，不存在原生体系无法承载的外部生态需求；依 CR-056 §5.9 退出准则，正式退役 BTD-08，避免在仓库内引入无业务消费的跨进程通信死代码。**

---

## 2. 评估背景与准入/退出准则

在 CR-056（Build-to-Delete Architecture inspired by pi-mono）设计初期，BTD-08 被定义为一个“条件性候选（Conditional Candidate）”切片，用于探索外部独立 pi 进程外运行时的接入可行性。

根据 CR-056 §5.9，该切片的准入与退出门槛为：

1. **启动条件**：*“有原生扩展不能满足的具体用例，BTD-05/07 的边界证据成立……缺少用例时停留在参考设计，不安装真实运行时。”*
2. **退出准则**：*“合同无法满足、维护成本超过用例价值或上游仍不成熟时禁用/移除 Adapter；不转换 Aervox 历史、不保留第二套权威会话库。”*

在完成 BTD-00～04、BTD-07 以及 BTD-05（瘦宿主与执行控制面）与 BTD-06（客户端安全投影）后，架构团队对 BTD-08 开展了终验评审。

---

## 3. 原生思隅核心成熟度核查

经过阶段重构，思隅原生内核已完全具备支撑所有伴学、工作台与端侧智能的核心机制，其能力矩阵已全面覆盖并超越了原先设想的外部适配器模型：

| 架构切面 | 思隅原生内核能力现状 | 对照外部 pi 运行时的表现 |
| :--- | :--- | :--- |
| **执行控制面** | `ControlContext`：单 Turn 截止时间、取消级联信号、Token 与模型调用预算限制、子任务控制派生。 | 外部进程缺少强约束上下文，预算与超时只能靠进程外轮询或硬杀进程。 |
| **状态与账本** | `SessionLedgerPort` 窄接口与本地 SQLite WAL 结合，支持 CAS 租约锁与原子终态防孤儿 Attempt。 | 外部进程自报 `tool_result` 容易与 Host 内部持久化账本脱节，形成双真源。 |
| **模型驱动 SPI** | `ModelRuntimeDriver` 抽象，支持本地 Llama 与多种 Provider，具备代际计数与防污染释放。 | 与外部 Agent 运行时完全等价，且无需跨进程 IPC 协议编解码。 |
| **工具安全与沙箱** | `ToolRuntime`：只读/审批/特权分级，`tool-input-safe`（防穿越/防注入/递归限制）与 `tool-result-safe`。 | 普通子进程不具备 OS 级沙箱隔离，仍能访问宿主文件系统，增加提权风险。 |
| **客户端投影** | `TurnStreamProjector`：严格单调递增 sequence 校验，防乱序、防重发、防旧会话复活。 | 外部进程输出若直接推送到前端，容易绕过服务端的安全脱敏与状态机。 |

---

## 4. 方案权衡与决断理由

在评审中，团队比对了 **路径 A（编写受控 Stdio 适配器）** 与 **路径 B（正式退役与封板）**：

1. **业务零用例（Zero Real-World Use Case）**：
   - 思隅的所有业务场景（桌宠 Live2D 情绪互动、学习复习排期、错题分析、日记提炼与记忆图谱）均深度绑定原生领域事件与 SQLite 状态机；
   - 仓库内目前及可见未来**不存在任何需要把主循环委托给第三方外部 pi 进程的业务诉求**。
2. **避免进程治理与安全隐患**：
   - 维护跨进程 Stdio/JSON-RPC 通信面临子进程孤儿化、内存泄漏与跨平台信号处理差异（Windows / macOS / Linux）；
   - 普通子进程缺乏操作系统级别的严格隔离，若轻信外部进程自报结果，将对系统安全产生假象。
3. **践行 Build-to-Delete 奥卡姆剃刀原则**：
   - CR-056 的核心宗旨是“只写必须的代码，可删除性优先”；
   - 编写一套永远没有真实流量通过的外部进程胶水代码，是典型的架构过度设计与死代码（Dead Code）。

---

## 5. 最终结论与闭环动作

经用户与架构团队正式确认：

1. **切片退役**：
   - 判定 **BTD-08 正式退役（Retired / Not-Applicable）**；
   - 不在主干引入 `ExternalAgentAdapter` 或任何外部子进程 pi 胶水实现。
2. **CR-056 全量收口**：
   - 随着 BTD-05（完成）、BTD-06（完成）与 BTD-08（退役），**CR-056 涉及的所有架构切片（BTD-00～08）100% 形式化收口闭环**；
   - CR-056 状态正式推进为 `Verified / Released`。
3. **后续资源聚焦**：
   - 架构精力全量聚焦于**思隅核心（Aervox Core）的物理抽离**与独立 Headless CLI 运行器（`scripts/run-headless-agent.mjs`）的交付。
