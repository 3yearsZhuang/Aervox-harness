# 贡献指南 · Contributing to Aervox

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

> [简体中文](#简体中文) · English

---

## 简体中文

感谢你愿意为 **Aervox｜思隅** 贡献！这里是"主动智能" Agent：以桌宠为入口，视觉小说 + 工作台双形态交互，承载陪伴与学习双重任务。TypeScript 全栈 monorepo（Vue 全栈，Fastify API + Worker + 桌面端 / Web + SQLite 真源）。

所有类型的贡献都受到欢迎与重视：报告 Bug、改进文档、提交代码、参与设计讨论。动手前请阅读下方对应部分，它能让维护更顺畅，也避免你的 PR 被打回。

### 目录

- [我该如何贡献](#我该如何贡献)
- [报告问题](#报告问题)
- [提议新功能](#提议新功能)
- [提交代码：环境准备](#提交代码环境准备)
- [提交代码：分支与 Commit](#提交代码分支与-commit)
- [提交代码：门禁与落地登记](#提交代码门禁与落地登记)
- [新功能开发流程（从立项到发布）](#新功能开发流程从立项到发布)
- [参考项目与版权边界](#参考项目与版权边界)

### 我该如何贡献

| 贡献方式 | 当前是否接受 | 说明 |
|---|---|---|
| 可复现的 Bug 报告 | 最欢迎 | 走 [报告问题](#报告问题) 模板 |
| 文档纠错 / 补全 | 最欢迎 | 先读[文档写作规范](docs/reference/standards/doc-standards.md) |
| 小范围、有测试的 Bug 修复 PR | 视情况接受 | 见[提交代码](#提交代码环境准备) |
| 新功能 PR | 先开 Issue | 见[提议新功能](#提议新功能) |
| 纯 AI 生成、提交者未理解或未遵循规范的 PR | 不审核 | 你**必须理解你的代码**，见[提交代码](#提交代码环境准备) |

### 报告问题

1. **先搜索**：在 [Issues](https://github.com/3yearsZhuang/Aervox-harness/issues) 中确认是否已有类似问题。
2. **新建 Issue**：提供简要描述、复现步骤、预期与实际结果、相关日志或错误信息。

### 提议新功能

- **新功能请先开 Issue**，与维护者对齐范围与方向后再写代码，不要直接开 PR。
- 说明它改善哪一个[学习结果 / 数据权利 / 可用性](docs/reference/PRD.md#16-问题证据与差异化边界)问题，仅凭"模型能力提升了"不足以进入路线图。

### 提交代码：环境准备

1. 拉取子模块（否则 `pnpm build` 缺 `@aervox/mod-*` 失败）：

   ```bash
   git submodule update --init --recursive
   ```

2. 安装工具链与依赖：

   ```bash
   ./aervox setup
   ```

3. 工具版本以 [mise.toml](mise.toml) 为唯一真源；跑 `.ts` 脚本统一 `mise x -- <cmd>`，不要用系统自带 Node。

### 提交代码：分支与 Commit

- **分支命名**：代码用 `feat/` `fix/`，文档用 `docs/`，后接简短描述或 Issue 号，如 `feat/add-user-profile`、`fix/1234-login-typo`。
- **禁止**直接向 `main` 提交或推送；一律走功能分支 + PR 合入 `main`。
- **Commit / PR 标题**：用语义化前缀（`feat:` `fix:` `docs:` `refactor:` `test:` `chore:` 等）+ 简要描述；建议用中文描述变更内容。
- **Commit 粒度**：只暂存你本次修改的文件，用显式 `git add <path>`，不要 `git add .`。

### 提交代码：门禁与落地登记

提交/推送前本地过对应门禁，未过视为未闭环、提交打回：

- 代码改动：`mise tasks run ci-code`（install + build + typecheck + test）
- 文档改动：`mise tasks run ci-docs`（markdownlint + Vale，链接检查在 CI）
- **契约先行**：涉及 API 以 `packages/contracts` 的 Zod schema 为先，OpenAPI 由它自动生成，不要手写契约；涉及数据库先更新 [DATABASE.md](docs/reference/DATABASE.md) 与迁移
- **依赖统一装根**：`pnpm add -w <pkg>`（开发依赖 `-Dw`），禁止子包单独加依赖
- **落地登记**：一切合入改动必须在[追踪基线 §4.2 落地实现登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)登记（关联 CAP、实现位置、日期、验证、来源）。**未登记 = 未闭环，PR 会被打回**。借鉴参考项目时 `来源` 列标注 `T-*`/`AST-*`/`PET-*`（见[参考项目与版权边界](#参考项目与版权边界)）
- **PR 描述**：引用你登记的 §4.2 登记行，并简述改动与验证方式

### 新功能开发流程（从立项到发布）

你负责功能时会走完三个阶段，每个阶段有一个可验证的交付与状态推进（完整字段与规则见[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)，不要在这里复制事实源）：

#### 阶段一：把想法定成需求（G0 → G1）

1. **立案（G0）**：写下用户问题、目标指标、挂靠哪个 `CAP-*`、范围外与风险假设，填[原子需求模板](docs/reference/REQUIREMENTS_TRACEABILITY.md#5-原子需求字段模板)的"来源 / 理由"与"交付信息"。
2. **拆原子需求**：把 CAP 拆成 `US/FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS`，逐字段填；需求用"当……时，系统必须……"表达，无关字段写"不适用"，不要留空。
3. **写验收与测试**：每个 `AC-*` 用 Given/When/Then 原子化（正常/边界/失败各至少一条），让 `AC* → TC* → CI/人工证据`；AI 需求挂版本化评估集。
4. **过 DoR（G1）**：按[Definition of Ready](docs/reference/REQUIREMENTS_TRACEABILITY.md#6-definition-of-ready)逐项核对，阻塞型 `EXP/RISK/DEC/ADR` 关闭或获批豁免后，状态 `Specified → Ready`。

**交付**：一份过 DoR 的原子需求集，状态 `Ready`。

#### 阶段二：实现与落地（G3）

1. **建分支**：见[分支与 Commit](#提交代码分支与-commit)。
2. **结构与契约先行**：见[门禁与落地登记](#提交代码门禁与落地登记)。
3. **过代码门禁**：`mise tasks run ci-code`；改过文档再跑 `mise tasks run ci-docs`。
4. **登记落地**：合入前在[落地实现登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)登记。
5. **提 PR 合并**：PR 描述引用 §4.2 登记行；评审通过后合入 `main`，状态 `Ready → Implemented`。

**交付**：合入的代码 + §4.2 登记行，状态 `Implemented`。

#### 阶段三：验证与发布（G4 → G6）

1. **RC 验收（G4）**：完成产品验收、AI 评估、安全/隐私/性能/无障碍/恢复测试，证据回填 `TC-*`，状态 `Implemented → Verified`。
2. **生产发布（G5）**：确认[季度演练](docs/reference/operations.md#10-演练与证据)证据齐备、监控/灰度/回滚/值班就绪；没有演练证据不能过 G5。
3. **发布后验证（G6）**：关键路径、数据写入、指标、告警与错误预算正常后，状态 `Verified → Released`；结项以 §4.2 登记表为准。

**交付**：一条上线后的功能，状态 `Released`。

### 参考项目与版权边界

- `reference/` 是固定 commit 的只读子模块，用于借鉴设计；落地借鉴改动必须在 §4.2 登记 `来源`。
- 第三方代码须记录来源与版权声明（见 [PRD §15.1](docs/reference/PRD.md#151-参考实现要求)）；本仓库源码 AGPLv3、文档 CC BY-NC-SA 4.0。

---

## English

Thanks for contributing to **Aervox｜Siyu** – a "proactive intelligence" agent: a desktop pet as the entry point, with visual-novel + workbench dual-mode interaction carrying companionship and learning. TypeScript full-stack monorepo (Vue, Fastify API + Worker + Desktop/Web + SQLite as source of truth).

All contribution types are welcomed and valued: bug reports, doc fixes, code, design discussion. Please read the relevant section before contributing so maintainers can move fast and your PR won't be rejected.

### Contents

- [How to contribute](#how-to-contribute)
- [Reporting issues](#reporting-issues)
- [Proposing features](#proposing-features)
- [Submitting code: environment](#submitting-code-environment)
- [Submitting code: branch & commit](#submitting-code-branch--commit)
- [Submitting code: gates & landbook](#submitting-code-gates--landbook)
- [Feature development workflow](#feature-development-workflow)
- [Reference projects & licensing](#reference-projects--licensing)

### How to contribute

| Contribution | Accepted now | Notes |
|---|---|---|
| Reproducible bug report | Most welcome | Use the [Reporting issues](#reporting-issues) template |
| Doc fixes / additions | Most welcome | Read [doc standards](docs/reference/standards/doc-standards.md) first |
| Small, tested bug-fix PR | Case by case | See [Submitting code](#submitting-code-environment) |
| New feature PR | Open an Issue first | See [Proposing features](#proposing-features) |
| Blind AI-generated PR | Not reviewed | You **must understand your code**, see [Submitting code](#submitting-code-environment) |

### Reporting issues

1. **Search first**: check [Issues](https://github.com/3yearsZhuang/Aervox-harness/issues) for an existing report.
2. **Open a new Issue**: brief description, reproduction steps, expected vs actual result, relevant logs/errors.

### Proposing features

- **Open an Issue first** to align scope before writing code; do not open a PR directly.
- State which [learning outcome / data right / usability](docs/reference/PRD.md#16-问题证据与差异化边界) problem it improves. "The model got better" alone is not enough for the roadmap.

### Submitting code: environment

1. Pull submodules (needed or `pnpm build` fails on `@aervox/mod-*`):

   ```bash
   git submodule update --init --recursive
   ```

2. Install toolchain and dependencies:

   ```bash
   ./aervox setup
   ```

3. Tool versions are pinned by [mise.toml](mise.toml); run `.ts` via `mise x -- <cmd>`, not the system Node.

### Submitting code: branch & commit

- **Branch naming**: `feat/` or `fix/` for code, `docs/` for docs, then a short description or issue number, e.g. `feat/add-user-profile`, `fix/1234-login-typo`.
- Do **not** push or commit directly to `main`; always use a feature branch + PR into `main`.
- **Commit / PR title**: semantic prefix (`feat:` `fix:` `docs:` `refactor:` `test:` `chore:` …) plus a short description; Chinese is fine.
- **Commit granularity**: stage only the files you changed in this session with explicit `git add <path>`, never `git add .`.

### Submitting code: gates & landbook

Run the relevant gate before push; failing is "not closed" and the PR will be rejected:

- Code: `mise tasks run ci-code` (install + build + typecheck + test)
- Docs: `mise tasks run ci-docs` (markdownlint + Vale; link check in CI)
- **Contract-first**: define API in `packages/contracts` Zod schemas; OpenAPI is generated, don't hand-write it; update [DATABASE.md](docs/reference/DATABASE.md) and migrations for DB changes
- **Deps at root**: `pnpm add -w <pkg>` (`-Dw` for dev deps); never add deps in a subpackage
- **Landbook**: every merged change must be registered at [traceability §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) (linked CAP, location, date, verification, source). **Unregistered = not closed, PR rejected.** For borrowed reference designs, mark `T-*`/`AST-*`/`PET-*` in the `source` column
- **PR description**: reference your §4.2 registration row, summarize changes and how you verified them

### Feature development workflow

When you own a feature you'll go through three phases, each with a verifiable deliverable and a status transition (full rules live at [traceability](docs/reference/REQUIREMENTS_TRACEABILITY.md), not copied here):

#### Phase 1: Turn ideas into requirements (G0 → G1)

1. **Charter (G0)**: write the user problem, target metrics, which `CAP-*` it hangs on, out-of-scope and risk assumptions; fill "source / rationale" and "delivery info" in the [atomic requirement template](docs/reference/REQUIREMENTS_TRACEABILITY.md#5-原子需求字段模板).
2. **Split atomic requirements**: decompose the CAP into `US/FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS`, fill every field; express requirements as "when…, the system must…"; write "N/A" for irrelevant fields, never leave blank.
3. **Write acceptance & tests**: make each `AC-*` atomic with Given/When/Then (at least one normal / boundary / failure), link `AC* → TC* → CI/manual evidence`; AI requirements hang a versioned eval set.
4. **Pass DoR (G1)**: check against [Definition of Ready](docs/reference/REQUIREMENTS_TRACEABILITY.md#6-definition-of-ready); once blocking `EXP/RISK/DEC/ADR` are closed or exempted, status goes `Specified → Ready`.

**Deliverable**: a DoR-passed atomic requirement set, status `Ready`.

#### Phase 2: Implement & land (G3)

1. **Branch**: see [branch & commit](#submitting-code-branch--commit).
2. **Structure & contract first**: see [gates](#submitting-code-gates--landbook).
3. **Pass code gate**: `mise tasks run ci-code`; run `ci-docs` too if you changed docs.
4. **Landbook**: register at [traceability §4.2](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) before merge.
5. **Open the PR**, reference your §4.2 row, merge after review → status `Ready → Implemented`.

**Deliverable**: merged code + §4.2 registration row, status `Implemented`.

#### Phase 3: Verify & release (G4 → G6)

1. **RC acceptance (G4)**: product acceptance, AI eval, security/privacy/performance/accessibility/recovery tests, evidence backfilled to `TC-*`, status `Implemented → Verified`.
2. **Production release (G5)**: confirm [quarterly drill](docs/reference/operations.md#10-演练与证据) evidence, monitoring/gray/rollback/on-call ready; no drill evidence, no G5.
3. **Post-release check (G6)**: critical path, data writes, metrics, alerts and error budget healthy → status `Verified → Released`; close-out per §4.2.

**Deliverable**: a shipped feature, status `Released`.

### Reference projects & licensing

- `reference/` is a pinned-commit read-only submodule for design borrowing; any landed borrowed change must register its `source` in §4.2.
- Third-party code must record source and copyright (see [PRD §15.1](docs/reference/PRD.md#151-参考实现要求)); this repo's source is AGPLv3, docs are CC BY-NC-SA 4.0.