# 贡献指南 · Contributing to Aervox

- 提出人：3yearszhuang · 2026-08-26
- 修改人：Codex · 2026-09-18

> [简体中文](#简体中文) · [English](#english)

---

## 简体中文

感谢你愿意为 **Aervox｜思隅** 贡献！

Aervox 是一款面向未来的“主动智能” Agent：以桌面伴侣（桌宠）为入口，采用视觉小说 + Web 工作台双形态交互，承载情感陪伴与深度学习双重任务。技术栈为纯正的 TypeScript 全栈 monorepo（Fastify 5 API + 独立后台 Worker + Electron 桌面端 + Vue 3 Web 工作台），底层以纯本地永久单用户 SQLite (WAL 模式) 为唯一真源（`CR-030`（已归档）），支持 Model Context Protocol ([MCP](https://modelcontextprotocol.io/)) 出厂预设接入。

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

动手前先读根目录 [plan.md](plan.md)，认领现有条目或补充新的当前迭代建议；工作排序只在该文件维护。条目状态、证据移交和分支协作按[迭代计划治理](docs/reference/document-governance.md#31-当前迭代计划的唯一入口)执行。

适合插件承载的功能优先复用现有扩展点。准确能力与限制见 [Aervox 插件开发规范](docs/reference/plugin-config-and-pages.md)（AVX-PLUG-001），最小可运行示例见[开发指南](docs/how-to/develop-plugin-ui-extension.md)（AVX-GUIDE-004）。声明式分发包、静态 Page 和第一方编译接入的 Turn/UI 扩展各有不同边界，不能把清单声明当作任意代码已隔离运行，也不能省略相关契约与回归验证。

核心缺陷可按授权范围修复；改变已接受架构、权限或数据语义时，按[CR 工作流](docs/how-to/cr-workflow.md)先记录差量，破坏性迁移继续遵守[换库演练](docs/how-to/run-database-migration-drill.md)。详细技术规范只在上述事实源维护，本指南不另列一套插件权限、API 或沙箱保证。

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

Read the root [plan.md](plan.md) before starting work. It is the sole current iteration queue; requirements, accepted decisions, and delivery evidence remain in their existing authoritative documents. See the [maintenance rules](docs/reference/document-governance.md#31-当前迭代计划的唯一入口).

Thank you for contributing to **Aervox｜Siyu**!

Aervox is an open-source, proactive intelligence desktop agent: featuring a desktop companion (pet) as the primary entrance, utilizing visual-novel + workbench dual-mode interaction, and delivering emotional companionship and in-depth learning. The technical stack is a TypeScript full-stack monorepo (Fastify 5 API + independent background Worker + Electron desktop pet + Vue 3 Web workbench), rooted strictly in a local-only single-user SQLite (WAL mode) database (`CR-030`（已归档）) with out-of-the-box Model Context Protocol ([MCP](https://modelcontextprotocol.io/)) preset support.

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

Read the root [plan.md](plan.md) before starting. Claim an existing item or add a current iteration suggestion there; maintain ordering, dependencies, and working status only in that file. Follow the [iteration governance rules](docs/reference/document-governance.md#31-当前迭代计划的唯一入口) when starting, changing, or handing off work.

Use existing extension points for features they can support. The [Aervox Plugin Development Standard](docs/reference/plugin-config-and-pages.md) (`AVX-PLUG-001`) defines current capabilities and limits; the [development guide](docs/how-to/develop-plugin-ui-extension.md) (`AVX-GUIDE-004`) provides a runnable example. Declarative bundles, static Pages, and first-party compiled Turn/UI extensions have different boundaries. A manifest does not establish isolated execution of arbitrary code or remove the need for contract and regression checks.

Fix core defects within the authorized scope. Changes to accepted architecture, permissions, or data semantics follow the [CR workflow](docs/how-to/cr-workflow.md); destructive database changes also follow the [migration drill](docs/how-to/run-database-migration-drill.md). Maintain technical details in those authoritative sources instead of duplicating plugin API, permission, or sandbox guarantees here.

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
