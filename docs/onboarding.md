# 新成员 / 新 Agent 上手指南（Onboarding）

> 文档编号：AVX-GUIDE-005  
> 版本：v0.1  
> 更新日期：2026-08-24  
> 状态：Draft  
> 关联：[文档索引](README.md) · [PRD](../PRD.md)

本文面向新成员或首次接触本仓库的 AI Agent，说明“仓库里有什么、从哪里开始、提交前要自检什么”。规则详情以[文档索引](README.md)和 [PRD](../PRD.md) 为准。

## 1. 仓库结构

```text
PRD.md                 # 产品需求事实源（AVX-PRD-001）
docs/
  README.md            # 文档索引 + 权威顺序 + 生命周期登记表
  ARCHITECTURE.md      # 系统架构设计（AVX-SAD-001）
  requirements/        # SRS（AVX-SRS-001）
  REQUIREMENTS_TRACEABILITY.md   # 需求追踪与交付基线（AVX-TRC-001）
  contracts/           # 流式协议契约（AVX-SPC-001）
  operations/          # 运行手册（AVX-OPS-001）+ 值班/演练模板
  security/            # 威胁模型（AVX-SEC-001）
  qa/                  # 测试策略（AVX-QA-001）
  architecture/adr/    # ADR 001~013（AVX-SAD 配套决策记录）
  how-to/              # 任务型操作指南（新增需求/ADR/发布/演练）
  onboarding.md        # 本文件
reference/             # 4 个固定 commit 的子模块（详见 PRD 15.1）
demos/                 # 纯前端原型，非交付物
```

## 2. 从哪里开始

1. 先读 [docs/README.md](README.md) 的文档体系表与权威顺序，弄清每份文档回答什么问题、冲突时谁优先。
2. 读 [PRD](../PRD.md) 第 1 节产品决策摘要与功能地图，了解产品边界。
3. 按需进入对应 how-to：[新增需求](how-to/add-requirement.md)、[写 ADR](how-to/write-adr.md)、[过发布门禁](how-to/release-gates.md)、[执行演练](how-to/run-drill.md)。

## 3. 写作与改动的硬性规则

- 能力/需求 ID 一经建立不改；`P0~P3` 是优先级、`R0~R5` 是阶段，两者不得混用。
- 修改已批准文档：先建 `CR-*` 再修订，不得静默改正文（见[追踪基线 §11](../REQUIREMENTS_TRACEABILITY.md#11-变更控制)）。
- 新增/修改文档必须同步[文档生命周期登记表](README.md#11-文档生命周期登记表owner-指派与核验)的核验日期与责任角色。
- 参考仓库只作设计验证，MVP 不得依赖其运行时（见 [PRD 15](../PRD.md#15-参考项目与借鉴边界)）。

## 4. 提交前自检（Docs CI 门禁）

改动 `docs/**` 或 `PRD.md` 的 PR 必须通过：

- **Markdown lint**：`npx markdownlint-cli2 --config .markdownlint-cli2.json "PRD.md" "docs/**/*.md"`（配置关闭 MD013/033/060）；
- **链接检查**：`lychee --no-progress PRD.md docs`（CI 中由 lychee-action 执行）；
- 本地先跑 lint，确保 0 问题再提交。

## 5. 需要介入时

- 文档冲突：停止相关发布，按[权威顺序](README.md#2-权威顺序与冲突处理)仲裁；
- 生产问题：按[运行手册](../operations/RUNBOOK.md) 与[值班矩阵](operations/ONCALL.md)升级；
- 变更请求：走[变更流程](../REQUIREMENTS_TRACEABILITY.md#113-变更流程)。
