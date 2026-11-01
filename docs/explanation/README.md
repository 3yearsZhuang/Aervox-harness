---
id: AVX-EXPL-000
---

# 解释与研究

本目录解释机制、研究问题与取舍。当前排期见[计划](../../plan.md)，实现证据与发布限制见[追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)，不在索引重复维护状态。

## 理解现有机制

- [一次对话的数据流](data-flow-overview.md) — 从用户输入到模型响应再到持久化的端到端流程
- [主动智能的四轴状态模型](proactive-intelligence-mode.md) — 工具权限、画像期望状态、设备能力与有效运行状态
- [跨端工作台与平台壳](../reference/ARCHITECTURE.md#32-跨端工作台与平台壳) — 桌面端、Web 端与移动端的宿主分工

## 研究与评估

- [架构设计、参考项目学习与演进候选](../reference/ARCHITECTURE.md#reference-learning) — 参考项目与学习总结
- [记忆删除质量论文与原始证据（已归档）](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/main/memory-deletion-study) — 学术研究成果与复现数据
- [仓库卫生与代码质量审计（2026-10-13，已归档）](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/explanation/repository-hygiene-audit-2026-10-13.md) — 历史代码质量审计记录
- [异步删除故障测试研究与负结果（已归档）](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/main/deletion-fault-testing) — 故障注入实验与分析
- [配套硬件方向](companion-hardware-directions.md) — 9 种硬件形态与技术路线分析
- [HLS 研究执行指南](../how-to/run-hls-agent.md) — 高层次综合 Agent 运行与评测
- [点对点加密同步探索](p2p-local-sync-exploration.md) — 本地多端 P2P 同步方案原型

研究或原型不能直接作为产品承诺。被替代的历史决定通过 [ADR](../reference/adr/README.md)或[外部归档](https://github.com/3yearsZhuang/Aervox-docs-archive)追溯。
