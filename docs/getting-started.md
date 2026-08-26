# 从哪开始（新成员 / AI Agent 入口）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

> 文档编号：AVX-DOC-002  
> 版本：v0.1  
> 更新日期：2026-08-26  
> 状态：Review Candidate  
> 关联：[文档索引](README.md)（AVX-DOC-001）

面向新成员或首次接触本仓库的 AI Agent：仓库里有什么、从哪里看、提交前自检什么。规则详情以各专项文档为准。

## 1. 仓库结构

```text
docs/
  README.md              # 文档索引 + 权威顺序（AVX-DOC-001）
  DOC_REGISTRY.md        # 文档生命周期登记表（AVX-DOC-CONF-001）
  getting-started.md     # 从哪开始（本文件，AVX-DOC-002）
  tutorials/             # 教程（AVX-TUT-001～002）
  how-to/                # 操作指南（AVX-GUIDE-*）
  explanation/           # 概念讲解（AVX-EXPL-*）/ 实现规划 / 可选模块方案 / 能力拆分路线
  templates/             # 新建文档模板（How-to / Reference / Explanation）
  reference/             # 参考类（AVX-PRD/SRS/SAD/TRC/SPC/DB/DATA/AIQ/SEC/QA/OPS 等）
    adr/                 # ADR-001~015 + 索引
    changes/             # CR-*
    standards/           # 文档写作规范（AVX-STD-001）· 术语表（AVX-TERM-001）
    diagrams/            # 数据库 ERD（.mmd）
    PRD.md · ARCHITECTURE.md · SRS.md · REQUIREMENTS_TRACEABILITY.md
    capability-composition.md
    DATABASE.md · STREAMING_PROTOCOL.md
    plugin-config-and-pages.md
    DATA_PRIVACY.md · AI_QUALITY_SAFETY.md · THREAT_MODEL.md · TEST_STRATEGY.md
    operations.md
reference/               # 固定 commit 的子模块（只读参考，见 PRD 15.1；与上文 docs/reference/ 不同）
demos/                   # 纯前端原型，非交付物
```

## 2. 阅读顺序

1. 先读[文档索引的体系表](README.md#1-文档体系与事实源)与[权威顺序](README.md#2-权威顺序与冲突处理)，弄清每份文档回答什么、冲突时谁优先。
2. 读 [PRD](reference/PRD.md) 第 1 节产品决策摘要与功能地图，了解产品边界。
3. 规划能力宿主或外部插件时，读[能力组合与可选化目录规范](reference/capability-composition.md)；实际迁移从[迁移教程](tutorials/migrate-integrated-capabilities.md)开始。
4. 拉取子模块：clone 后先执行 `git submodule update --init --recursive`，否则 `pnpm build` 会缺 `@aervox/mod-*` 失败（见[可选模块协作指南](how-to/submodule-collaboration.md)）。
5. 贡献者流程见根级 [CONTRIBUTING](../CONTRIBUTING.md)；按需进入 [how-to](how-to)：新增需求 / 写 ADR / 过发布门禁 / 执行演练 / 可选模块 submodule。

## 3. 写作与改动的硬性规则

硬性规则以专项文档为事实源，先读再改：

- ID/优先级/阶段语义与不可改动原则：[追踪基线 §1](reference/REQUIREMENTS_TRACEABILITY.md#1-目的与使用方式)；
- 新增/改版文档的类型、头字段与模板：[文档写作规范 §1-2/§6](reference/standards/doc-standards.md#1-文档分类diataxis-四分类)；
- 已批准文档的变更（含 `CR-*`）与变更豁免：[追踪基线 §11](reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)；
- 登记强度分级（L1/L2/L3）与登记表同步：[文档写作规范 §3.1](reference/standards/doc-standards.md#31-改动等级与同步要求)、[生命周期登记表](DOC_REGISTRY.md)；
- 参考仓库使用边界：[PRD §15](reference/PRD.md#15-参考项目与借鉴边界)。

## 4. 提交前自检（Docs CI 门禁）

改动 `docs/**` 或根 `README.md` 的 PR 必须通过：

- **Markdown lint**：`npx markdownlint-cli2 --config .markdownlint-cli2.jsonc "docs/**/*.md" "README.md"`（配置关闭 MD013/033/060）；
- **链接检查**：`lychee`（CI 中由 lychee-action 执行，排除 `reference/` 与 `demos/`）；
- 本地先跑 lint 与相对链接存在性检查，确保 0 问题再提交。

## 5. 需要介入时

- 文档冲突：停止相关发布，按[文档索引的权威顺序](README.md#2-权威顺序与冲突处理)仲裁；
- 生产问题：按[运行、值班与演练手册](reference/operations.md)升级；
- 变更请求：走[变更流程](reference/REQUIREMENTS_TRACEABILITY.md#113-变更流程)。
