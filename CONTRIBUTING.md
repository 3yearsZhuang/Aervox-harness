# 贡献指南 · Contributing to Aervox

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-13

> [简体中文](#简体中文) · [English](#english)

---

## 简体中文

感谢你愿意为 **Aervox｜思隅** 贡献！

Aervox 是一款面向未来的“主动智能” Agent：以桌面伴侣（桌宠）为入口，采用视觉小说 + Web 工作台双形态交互，承载情感陪伴与深度学习双重任务。技术栈为纯正的 TypeScript 全栈 monorepo（Fastify 5 API + 独立后台 Worker + Electron 桌面端 + Vue 3 Web 工作台），底层以纯本地永久单用户 SQLite (WAL 模式) 为唯一真源（[CR-030](docs/reference/changes/CR-030-pure-local-sqlite-database.md)），支持 Model Context Protocol ([MCP](https://modelcontextprotocol.io/)) 出厂预设接入。

所有类型的贡献都受到高度欢迎与重视：报告 Bug、完善文档、贡献插件与提出架构优化。动手前请阅读下方指南，它能让协作更加顺畅，也能避免你的 Pull Request 在门禁中被拦截。

### 目录

- [功能开发首选途径：插件扩展体系（推荐）](#功能开发首选途径插件扩展体系推荐)
- [我该如何贡献](#我该如何贡献)
- [报告问题](#报告问题)
- [提议新功能](#提议新功能)
- [提交代码：环境准备与命令速查](#提交代码环境准备与命令速查)
- [提交代码：分支与 Commit 规范](#提交代码分支与-commit-规范)
- [提交代码：质量门禁与落地登记](#提交代码质量门禁与落地登记)
- [新功能开发流程（从立项到发布）](#新功能开发流程从立项到发布)
- [参考项目与版权边界](#参考项目与版权边界)

---

### 功能开发首选途径：插件扩展体系（推荐）

在 Aervox 中，我们**强烈建议并倡导所有具体的业务功能均以“插件（Plugin）”形式进行开发与接入**，而非直接修改系统底层内核代码。

#### 1. 为什么首选插件扩展，而非底层内核开发？

| 考量维度 | 底层内核开发（Core Engine） | 插件扩展开发（CAP-020 插件体系） |
|---|---|---|
| **代码侵入性** | 侵入核心数据库表（122 张 SQLite 表结构）、Agent Loop 调度状态机或 API 组合根 | **零核心侵入**：业务代码完全封装在 `plugins/<plugin-id>/` 独立目录中 |
| **准入门槛与流程** | 必须撰写 `CR-###` 变更提案并经架构委员会评审，涉及复杂的数据库迁移与回滚验证 | **极简上手**：声明清单即可运行，无需感知底层复杂的持久化细节与事务机制 |
| **故障爆炸半径** | 内核缺陷可能引发主库损坏、并发 Fencing 死锁或全服务崩溃 | **强隔离与安全**：享有 ADR-009 独立沙箱防线，支持按插件即时启用、禁用与全局紧急熔断 |
| **复审与合入周期** | 必须跑通全仓 53 套回归测试，门禁严苛，评审周期长 | 聚焦插件自身单元测试与 UI 插槽测试，审查轻量，极速合入 |

#### 2. 插件能做到什么？——全链路端到端闭环能力

Aervox 的插件系统（`CAP-020` / `CR-006`）绝非仅仅是几个零散的函数钩子，而是具备完整商业化产品体验的**一体化功能单元**：

1. **大脑与 SOP（提示词与专业技能）**：通过插件内置的 `SKILL.md`，为大语言模型注入领域专家身份、上下文规范与严谨的思考链路，彻底根治模型在调用纯工具时的目标漂移与传参幻觉；
2. **工具与手脚（原生工具与 MCP 深度绑定）**：插件可声明自身所需的工具集，亦可直接绑定 Aervox 的出厂预设或第三方 MCP 服务器（如 `dsh-mcp` 研发工具箱、`mcd-mcp` 生活服务）。所有工具统一纳入系统 PET-05 安全分级（读操作自动放行，写/执行操作受审批门控）；
3. **会话生命周期切面（Server Turn Pipeline）**：实现 `ServerTurnPlugin` 接口，在会话回合前（`beforeTurn`）动态注入系统提示词，在回合后（`afterTurn`）执行增强后处理（如错题归纳、日记提炼、进度排期）；
4. **可视化交互（UI 插槽与扩展页面）**：利用 `packages/ui` 插件插槽系统，在 Web 工作台与桌面端直接挂载专属面板（Tab）、侧边抽屉（Drawer）、浮动状态卡片，或加载无依赖的静态扩展页面（`PluginPage`），让工具调用产出优雅可视化；
5. **声明式配置（无代码表单）**：编写 `config.schema.json`，前端设置中心将自动渲染出类型安全的设置表单（开关、文本、路径选择、密钥加密输入），配置变更自动触发插件热更新；
6. **沙箱权限管控（ADR-009 最小权限壳）**：插件权限在清单中显式声明并由用户授权（`plugin_grants`），杜绝恶意越权与系统文件逃逸。

#### 3. 插件极速开发三步法

1. **创建插件 Bundle 目录**：
   在 `plugins/<plugin-id>/` 下建立标准文件结构：
   - `plugin.manifest.json`：声明插件 ID、版本、展示名称、权限与入口；
   - `config.schema.json`：声明用户配置项的 JSON Schema；
   - `SKILL.md`：定义赋予模型的专业技能指引与 SOP 约束。
2. **挂载前端 UI 扩展（可选）**：
   在 `packages/ui/src/plugins/` 编写对应的插槽组件或浮动交互逻辑（参考现有的 `focus-mode` 插件）。
3. **运行并本地自检**：
   执行 `./aervox dev full` 启动全栈，在工作台「扩展中心」中一键开启插件，实时观察控制流与 UI 表现。详细指引参见：[开发插件 UI 扩展操作指南](docs/how-to/develop-plugin-ui-extension.md) (`AVX-GUIDE-008`) 与 [插件配置与扩展页面参考](docs/reference/plugin-config-and-pages.md) (`AVX-REF-007`)。

#### 4. 何时才应该进行底层内核开发？

**仅在以下场景才建议触碰底层代码**：

- 破坏性底层模型变更：需要修改 SQLite 基础持久化 Schema / DDL（必须走 [CR 变更工作流指南](docs/how-to/cr-workflow.md) 与 [换库演练指南](docs/how-to/run-database-migration-drill.md)）；
- 核心调度引擎重构：重写 Agent Loop 核心状态机、Turn 级 SSE Pub/Sub 内存总线（CR-031）或 API 核心鉴权关口；
- 基础设施加固：修复底层构建管道、mise 规则或自动化门禁脚本。

---

### 我该如何贡献

| 贡献方式 | 当前状态 | 说明 |
|---|---|---|
| **新增功能插件（推荐）** | **最推荐** | 遵循 [插件扩展体系](#功能开发首选途径插件扩展体系推荐)，开发独立插件包 |
| **可复现的 Bug 报告** | 最欢迎 | 走 [报告问题](#报告问题) 模板，提供详细复现步骤与上下文日志 |
| **文档纠错与知识补全** | 最欢迎 | 遵循 [文档治理规范](docs/reference/document-governance.md) 与 [文档写作规范](docs/reference/standards/doc-standards.md) |
| **底层 Bug 修复 PR** | 欢迎 | 须附带完善的单元测试与回归证据，通过全量双门禁 |
| **底层核心架构变更** | 需先立项 | 严禁直接提 PR，必须先提出 Issue 并进入 `CR-###` 变更评审流程 |
| **未经测试或未经理解的 AI PR** | 不予受理 | 贡献者**必须完全理解并能解释所提交的代码** |

---

### 报告问题

1. **先搜索**：在 [GitHub Issues](https://github.com/3yearsZhuang/Aervox-harness/issues) 中检索是否已有类似报告，避免重复建单；
2. **新建 Issue**：提供问题简述、最小复现步骤（Minimal Reproducible Example）、预期结果、实际表现以及关键的错误日志/控制台截图；
3. **标注环境信息**：操作系统（macOS / Windows / Linux）、Node.js 版本、浏览器或 Electron 运行状态。

---

### 提议新功能

- **新功能请先开 Issue**，与核心维护团队对齐产品边界与架构可行性后再行编码，杜绝无效劳动；
- 提议新功能时，请明确说明它解决了哪一项[学习结果 / 数据隐私 / 用户可用性](docs/reference/PRD.md#16-问题证据与差异化边界)痛点；单纯以“新出的大模型能力更强”为由的提案通常不予采纳；
- 建议在 Issue 中明确说明该功能**是否可作为插件独立承载**。

---

### 提交代码：环境准备与命令速查

本项目对开发工具链版本实行严格受控治理：

1. **拉取子模块**（缺少参考子模块将导致编译受阻）：

   ```bash
   git submodule update --init --recursive
   ```

2. **工具链统一初始化**：
   工具版本以根目录 [mise.toml](mise.toml) 为唯一真源（锁定 Node.js 24 / pnpm 11 / Vale 3.18）。严禁使用未经 mise 激活的系统全局 Node.js：

   ```bash
   ./aervox setup
   ```

3. **高频常用命令速查**：

   | 目标场景 | 推荐命令 | 说明 |
   |---|---|---|
   | **启动全栈开发** | `./aervox dev full` | 一键拉起 API (:3000) + Web (:5173) + Desktop (:5174) + Worker |
   | **仅启动 Web 工作台** | `./aervox dev web` | 仅运行 API 与 Web 工作台 |
   | **仅启动桌宠桌面端** | `./aervox dev desktop` | 运行 API 与 Electron 桌面端 |
   | **本地代码门禁** | `mise tasks run ci-code` | 依赖锁定安装 + 边界检查 + 编译 + 类型检查 + 全仓单测 |
   | **本地文档门禁** | `mise tasks run ci-docs` | Markdownlint + Vale 散文术语检查 + 文档治理校验 |
   | **完整双门禁自检** | `./aervox ci` | PR 发起前必跑：同时执行代码与文档双门禁 |
   | **清理编译缓存** | `./aervox clean` | 清理 dist / out / .turbo 产物（保留 node_modules） |

---

### 提交代码：分支与 Commit 规范

- **Git 分支命名规范**：
  - 插件与新特性：`feat/<feature-name>`，如 `feat/plugin-code-companion`
  - 缺陷修复：`fix/<issue-number>-<summary>`，如 `fix/1234-turn-timeout`
  - 文档维护：`docs/<summary>`，如 `docs/contributing-rewrite`
- **严禁直推 `main`**：全仓库禁止直接向 `main` 分支提交或推送代码，必须经由功能分支并通过 Pull Request 评审合并；
- **Commit 规范**：
  - 遵循语义化提交规范（`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:` 等）；
  - 建议使用简明准确的中文描述改动动机与核心内容；
  - 保持精细的 Commit 粒度，使用显式 `git add <file>` 暂存，避免滥用 `git add .`。

---

### 提交代码：质量门禁与落地登记

提交与合并前，必须在本地通过双门禁自检；任何未通过门禁的 PR 将在自动化 CI 中被直接阻断：

1. **代码门禁 (`mise tasks run ci-code`)**：
   - 全仓编译（`turbo run build`）与类型检查（`turbo run typecheck`）0 错误；
   - 底座架构依赖边界校验（`check:boundary`）0 违规；
   - 单元与集成测试全量通过。
2. **文档门禁 (`mise tasks run ci-docs`)**：
   - Markdownlint-cli2：0 语法与格式错误（列表项内代码块前后必须各保留一行空行，遵循 MD031 / MD032）；
   - Vale 术语合规：正文散文中严禁使用全小写专有名词（如 `SQLite`、`Vue`、`Electron`、`Fastify` 等必须严格规范大小写，代码标识符用反引号包裹）；
   - 文档治理校验（`scripts/docs-governance.mjs --strict`）：元数据与日期校验 100% 通过。
3. **架构事实源保护红线**：
   - **契约先行**：API 契约以 `packages/contracts` 的 Zod schema 为唯一事实源，禁止手写 OpenAPI JSON；
   - **依赖统一治理**：新增依赖必须在根目录执行 `pnpm add -w <pkg>`，严禁在子包目录私自安装；
   - **落地实现登记（闭环铁律）**：任何功能性实现与架构改动，**必须**在 [需求追踪与质量基线 §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记一条完成记录（包含关联 CAP、实现文件清单、完成日期、验证命令、来源编号）。**未登记者视为未闭环，PR 将被直接打回**；
   - **PR 描述要求**：在 Pull Request 说明中显式标注你所登记的 §4.2 序号与行内容，并附带本地双门禁通过日志。

---

### 新功能开发流程（从立项到发布）

负责较大新功能时，须经历标准的质量推进阶梯（完整规约见 [需求追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)）：

#### 阶段一：立项与需求定义（G0 → G1）

1. **立案（G0）**：明确用户痛点、挂靠的 `CAP-*` 编号、假设与边界，填写 [原子需求模板](docs/reference/REQUIREMENTS_TRACEABILITY.md#5-原子需求字段模板)；
2. **拆解原子需求**：细化为 `US/FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS` 字段，严禁留空；
3. **确立验收用例（AC/TC）**：每个验收准则采用 Given/When/Then 原子化表述，覆盖正常、边界与异常分支；
4. **通过就绪评审（DoR / G1）**：核对 [Definition of Ready](docs/reference/REQUIREMENTS_TRACEABILITY.md#6-definition-of-ready)，状态推进至 `Ready`。

#### 阶段二：实现与落地（G3）

1. **检出功能分支**：按规范创建分支；
2. **编写代码与自动化测试**：以插件优先原则落地功能，补齐定向单测；
3. **本地双门禁跑通**：执行 `./aervox ci`；
4. **登记落地矩阵**：在 [落地实现登记 §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记落地条目；
5. **发起 PR 审查**：审查通过后以 Squash 模式合入 `main`，状态推进至 `Implemented`。

#### 阶段三：验证与发布（G4 → G6）

1. **候选版本验收（G4）**：回填测试证据至 `TC-*`，状态进入 `Verified`；
2. **生产发布门禁（G5）**：确认 [演练与备份证据](docs/reference/operations.md#10-演练与证据) 齐备，状态进入 `Released`；
3. **线上健康巡视（G6）**：验证运行时指标与错误预算，完成交付结项。

---

### 参考项目与版权边界

- `reference/` 目录为只读 Git submodule，固定特定提交哈希，仅供架构参考与规范对齐；
- 借鉴参考项目（`T-*` / `AST-*` / `PET-*` / `DSH-01` / `PI-01`）时，必须在 §4.2 登记表的“来源”列如实标注编号，并遵循开源许可要求（参见 [PRD §15.1](docs/reference/PRD.md#151-参考实现要求)）；
- 本仓库代码遵循 **AGPL-3.0-or-later** 许可开源，设计文档遵循 **CC BY-NC-SA 4.0** 许可。

---

## English

Thank you for contributing to **Aervox｜Siyu**!

Aervox is an open-source, proactive intelligence desktop agent: featuring a desktop companion (pet) as the primary entrance, utilizing visual-novel + workbench dual-mode interaction, and delivering emotional companionship and in-depth learning. The technical stack is a TypeScript full-stack monorepo (Fastify 5 API + independent background Worker + Electron desktop pet + Vue 3 Web workbench), rooted strictly in a local-only single-user SQLite (WAL mode) database ([CR-030](docs/reference/changes/CR-030-pure-local-sqlite-database.md)) with out-of-the-box Model Context Protocol ([MCP](https://modelcontextprotocol.io/)) preset support.

All contributions are appreciated: reporting bugs, improving docs, contributing plugins, and proposing architectural refactoring. Please read this guide before starting.

### Contents

- [Recommended Path: Plugin Extension System](#recommended-path-plugin-extension-system)
- [How to Contribute](#how-to-contribute)
- [Reporting Issues](#reporting-issues)
- [Proposing Features](#proposing-features)
- [Submitting Code: Environment & CLI](#submitting-code-environment--cli)
- [Submitting Code: Branch & Commit Standards](#submitting-code-branch--commit-standards)
- [Submitting Code: Gates & Landbook](#submitting-code-gates--landbook)
- [Feature Development Workflow](#feature-development-workflow)
- [Reference Projects & Licensing](#reference-projects--licensing)

---

### Recommended Path: Plugin Extension System

In Aervox, **we strongly recommend implementing all concrete user features as Plugins rather than hacking the low-level core engine**.

#### 1. Why Plugins Over Core Engine Development?

| Consideration | Core Engine Development | Plugin Extension System (CAP-020) |
|---|---|---|
| **Blast Radius** | Touches 122 SQLite tables, agent loop state machines, or transactional boundaries | **Zero core pollution**: All code resides cleanly in `plugins/<plugin-id>/` |
| **Barrier to Entry** | Requires formal `CR-###` proposals, database migration verification, and strict ADR review | **Lightweight onboarding**: Declarative manifest, zero database internals needed |
| **Runtime Safety** | Bugs can cause database corruption, fencing deadlocks, or server boot failure | **Sandboxed & Resilient**: ADR-009 process isolation, independent enable/disable and global kill switch |
| **Review & Merge** | Must pass 53 monorepo test suites and comprehensive regression checks | Focused plugin-level unit & UI slot tests, rapid review and merge |

#### 2. What Can a Plugin Do? (End-to-End Capabilities)

Aervox plugins (`CAP-020` / `CR-006`) are not just hooks, but self-contained product units:

1. **Brain & SOP (`SKILL.md`)**: Injects domain expertise, context guidelines, and rigorous chains of thought into the model, preventing hallucination during tool invocation;
2. **Tools & MCP Integration**: Declaratively exposes tools or binds to preset/external MCP servers (`dsh-mcp`, `mcd-mcp`), automatically governed by PET-05 security tiers (read-only auto-allowed, write/exec approval-gated);
3. **Turn Lifecycle Hooks (`ServerTurnPlugin`)**: Implements `beforeTurn` to inject dynamic prompts and `afterTurn` to handle post-turn effects (such as review items or diary extractions);
4. **Visual UI Slots (`packages/ui`)**: Registers custom tabs, drawers, or floating cards directly into the workbench and desktop companion;
5. **Declarative Settings (`config.schema.json`)**: Automatically renders dynamic, type-safe setting forms in the frontend settings drawer;
6. **Least Privilege Sandboxing (ADR-009)**: Explicit user-consented permissions (`plugin_grants`) prevent unauthorized filesystem or network escape.

#### 3. 3-Step Quickstart for Plugin Development

1. **Create Bundle Directory**:
   Create `plugins/<plugin-id>/` with `plugin.manifest.json`, `config.schema.json`, and `SKILL.md`.
2. **Mount UI Slots (Optional)**:
   Implement slot components in `packages/ui/src/plugins/` (see existing `focus-mode`).
3. **Launch & Verify**:
   Run `./aervox dev full`, open the Extension Center in the workbench, and test live.
   See details in [Develop Plugin UI Extensions](docs/how-to/develop-plugin-ui-extension.md) (`AVX-GUIDE-008`) and [Plugin Config & Pages Reference](docs/reference/plugin-config-and-pages.md) (`AVX-REF-007`).

#### 4. When Should Core Engine Development Be Used?

**Only modify the core engine when**:

- Making breaking database schema/DDL changes (must follow [CR Workflow](docs/how-to/cr-workflow.md) and [Migration Drill](docs/how-to/run-database-migration-drill.md));
- Upgrading the Agent Harness Loop state machine or Turn Pub/Sub stream hub;
- Hardening infrastructure, authentication gates, or CI scripts.

---

### How to Contribute

| Contribution | Status | Details |
|---|---|---|
| **New Feature Plugin** | **Most Recommended** | Follow [Plugin Extension System](#recommended-path-plugin-extension-system) |
| **Reproducible Bug Report** | Most Welcome | Use the [Reporting Issues](#reporting-issues) template |
| **Documentation Fixes** | Most Welcome | Follow [Document Governance](docs/reference/document-governance.md) & [Doc Standards](docs/reference/standards/doc-standards.md) |
| **Core Bug Fix PR** | Welcome | Include unit tests and pass dual gates |
| **Core Architectural Refactoring** | Issue Required | Do NOT open direct PRs; submit `CR-###` proposal first |
| **Unverified AI-Generated PR** | Rejected | Submitters **must fully understand and explain their code** |

---

### Reporting Issues

1. **Search First**: Check [GitHub Issues](https://github.com/3yearsZhuang/Aervox-harness/issues) to avoid duplicates;
2. **Open an Issue**: Provide a minimal reproducible example, expected vs actual behavior, and relevant logs;
3. **Include Environment Details**: OS (macOS / Windows / Linux), Node.js version, and browser/Electron state.

---

### Proposing Features

- **Open an Issue first** to align on product scope before coding;
- Clearly identify which [learning outcome / data privacy / usability](docs/reference/PRD.md#16-问题证据与差异化边界) problem it solves;
- Clarify whether the proposed feature can be packaged as a plugin.

---

### Submitting Code: Environment & CLI

Toolchain versions are strictly controlled:

1. **Pull Submodules**:

   ```bash
   git submodule update --init --recursive
   ```

2. **Initialize Toolchain**:
   The single source of truth is [mise.toml](mise.toml) (Node.js 24 / pnpm 11 / Vale 3.18). Run:

   ```bash
   ./aervox setup
   ```

3. **Common CLI Commands**:

   | Task | Command | Description |
   |---|---|---|
   | **Start Full Stack** | `./aervox dev full` | API (:3000) + Web (:5173) + Desktop (:5174) + Worker |
   | **Start Web Workbench** | `./aervox dev web` | API + Web workbench only |
   | **Start Desktop Pet** | `./aervox dev desktop` | API + Electron desktop pet only |
   | **Code Gate** | `mise tasks run ci-code` | Install + boundary check + build + typecheck + test |
   | **Docs Gate** | `mise tasks run ci-docs` | Markdownlint + Vale terminology + governance validator |
   | **Full Dual Gate** | `./aervox ci` | Runs both code and documentation gates |
   | **Clean Build Cache** | `./aervox clean` | Cleans dist / out / .turbo build artifacts |

---

### Submitting Code: Branch & Commit Standards

- **Branch Naming**: `feat/<name>`, `fix/<issue>-<summary>`, `docs/<summary>`
- **No Direct Push to `main`**: Always use feature branches and merge through Pull Requests;
- **Commit Standards**: Use conventional prefixes (`feat:`, `fix:`, `docs:`, etc.) and keep commits focused. Stage explicitly with `git add <path>`.

---

### Submitting Code: Gates & Landbook

Before submitting a PR, ensure local dual gates pass completely:

1. **Code Gate (`mise tasks run ci-code`)**:
   - Build (`turbo run build`) and typecheck (`turbo run typecheck`) must pass with 0 errors;
   - Import boundary (`check:boundary`) must pass with 0 violations;
   - All unit and integration test suites must pass.
2. **Docs Gate (`mise tasks run ci-docs`)**:
   - Markdownlint-cli2: 0 errors (keep empty lines before/after code blocks in lists per MD031/MD032);
   - Vale prose: Case-sensitive proper nouns (`SQLite`, `Vue`, `Electron`, `Fastify` must be capitalized or backtick-enclosed);
   - Governance validator (`scripts/docs-governance.mjs --strict`): 0 warnings, 0 errors.
3. **Architectural Red Lines**:
   - **Contract-First**: API contracts live in `packages/contracts` Zod schemas; never hand-edit OpenAPI JSON;
   - **Monorepo Dependency Governance**: Always run `pnpm add -w <pkg>` from root;
   - **Landbook Registration**: All landed implementations **must** register an entry in [Traceability Baseline §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记). Unregistered changes will be rejected;
   - **PR Description**: Reference the registered row from §4.2 and attach local CI test results.

---

### Feature Development Workflow

Larger features follow three quality maturity phases (see [Requirements Traceability](docs/reference/REQUIREMENTS_TRACEABILITY.md)):

#### Phase 1: Charter & Requirements (G0 → G1)

1. **Charter (G0)**: Define the problem, target `CAP-*`, and fill the [Atomic Requirement Template](docs/reference/REQUIREMENTS_TRACEABILITY.md#5-原子需求字段模板);
2. **Decompose Requirements**: Break down into `US/FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS` fields;
3. **Define Acceptance Criteria**: Atomic Given/When/Then scenarios covering normal, boundary, and error cases;
4. **Pass DoR (G1)**: Verify against the [Definition of Ready](docs/reference/REQUIREMENTS_TRACEABILITY.md#6-definition-of-ready), advancing to `Ready`.

#### Phase 2: Implementation & Landing (G3)

1. **Branch Checkout**: Create a feature branch;
2. **Code & Test**: Prioritize the plugin extension path and write unit tests;
3. **Pass Dual Gates**: Run `./aervox ci` locally;
4. **Register in Landbook**: Add a row to [Traceability Baseline §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记);
5. **Open Pull Request**: Squash-merge into `main` after review, advancing to `Implemented`.

#### Phase 3: Verification & Release (G4 → G6)

1. **RC Verification (G4)**: Backfill test evidence into `TC-*`, advancing to `Verified`;
2. **Release Gate (G5)**: Verify [Operations & Drill Evidence](docs/reference/operations.md#10-演练与证据), advancing to `Released`;
3. **Post-Release Monitoring (G6)**: Verify runtime metrics and error budgets to close the cycle.

---

### Reference Projects & Licensing

- `reference/` contains pinned-commit read-only git submodules for design reference only;
- Borrowed designs (`T-*` / `AST-*` / `PET-*` / `DSH-01` / `PI-01`) must register their source ID in §4.2 per [PRD §15.1](docs/reference/PRD.md#151-参考实现要求);
- Codebase is licensed under **AGPL-3.0-or-later**, documentation under **CC BY-NC-SA 4.0**.
