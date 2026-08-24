# CR-001 人格插件迁移为独立可选模块

- 状态：Implemented
- 提出日期：2026-08-24
- 提出人：待指定
- 目标版本：R2/R4（CAP-019/CAP-020）
- 关联：`CAP-019`、`CAP-020`、`FR-PER-004~007`、`SEC-PLG-002`、`PRIV-EXPORT-002`、`AIQ-PER-001`、`ADR-014`

## 变更原因

原始实现直接位于主仓 `packages/*`，与 `docs/architecture/optional_modules.md` 要求的“可选功能独立仓库 + `modules/*` submodule + workspace 包消费”不一致。人格插件不属于 P0 学习闭环，必须遵循可选模块治理。

## 目标行为

- 独立仓库：`https://github.com/KashiwagiEri233/aervox-persona-plugin-module.git`；
- 主仓挂载：`modules/persona-plugin`；
- workspace 包：`@aervox/mod-persona`；
- 固定 commit：`57fa711e11ab20f5ecd2679fe3d289ee9cb610da`；
- 主仓 API 通过 workspace 依赖消费模块；
- 主仓删除 Persona/Skills/MCP/Voice 的平行实现；
- CI 初始化并显式验证 submodule，模块自身执行 build/typecheck/test。

## 范围外

- 不把 `reference/*` 提升为运行时依赖；
- 不改变 P0 核心学习、记忆、删除、隐私和安全数据所有权；
- 不在模块内绕过主仓授权、删除和导出规则；
- 不导出 MCP 凭据、GPT-SoVITS 权重或用户业务正文。

## 迁移与回滚

迁移前模块仓库已完成独立提交和测试。主仓固定 submodule 指针并更新 workspace/CI/API。回滚时恢复主仓到迁移前 commit，并移除 `modules/persona-plugin` 指针；模块仓库保留，避免数据和代码不可逆删除。

## 验收证据

- 模块 commit `57fa711e11ab20f5ecd2679fe3d289ee9cb610da`；
- 模块独立 `pnpm build`、`pnpm typecheck`、`pnpm test` 全部通过；
- 主仓 `git submodule status --recursive` 显示 pinned commit；
- 主仓 API 仅依赖 `@aervox/mod-persona`；
- 主仓 `packages/*` 不存在 Persona/Skills/MCP/Voice 平行包；
- 主仓 build/typecheck/test 通过。
