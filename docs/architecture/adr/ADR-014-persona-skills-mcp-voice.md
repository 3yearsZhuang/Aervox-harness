# ADR-014 人格、Anthropic Skills、MCP 与 GPT-SoVITS 组合边界

- 状态：Proposed
- 日期：2026-08-24
- Owner / 评审人：待指定
- 关联：`CAP-019`、`CAP-020`、`SEC-PLG-001`、`PRIV-CONS-001`、`RISK-002`、`RISK-006`

## Context

Aervox 需要让用户创建和切换人格，并将人格 Prompt、Skills、MCP 工具和 GPT-SoVITS 语音模型组合到后续对话中。当前仓库是 TypeScript-first 模块化单体骨架，AI Runtime、Skills、MCP 与语音供应商尚未拥有实现；现有架构要求模型可替换、插件通过适配器接入、外部内容不能覆盖系统指令、插件不能直接写核心数据。

## Decision drivers

- 人格只影响后续表达和上下文选择，不能成为安全、隐私、删除或工具授权的事实源；
- Anthropic Skills 使用标准 `SKILL.md` 目录格式，并采用元数据到资源的渐进式加载；
- Skills 的筛选是提示词层面的控制，MCP 工具授权必须由服务端 ToolPolicy 最终决定；
- 人格导出必须可迁移且可复现，实际生效 Skills 应随包导出，但凭据、绝对路径和模型权重不能外泄；
- GPT-SoVITS 要同时兼容本地模型和外部服务，语音故障不能阻断文本学习流程。

## Considered options

1. **Persona 核心 + 受控 Skill/MCP/Voice Port（选定）**：适合当前骨架，保留替换实现和安全边界。
2. 将第三方 Agent/Skill 运行时作为核心内核：集成快，但会改变数据所有权和权限边界。
3. 把全部能力放入独立可选子仓：隔离清晰，但当前没有可消费的 Web/数据库/插件宿主基础设施。

## Decision

- Persona 使用 `Persona`、不可变 `PersonaRevision`、`ActivePersonaSelection` 和 Turn 级 `PersonaContextSnapshot`。
- `systemPromptAppend` 追加到 system prompt 的人格区；不可覆盖策略区放在最终 Prompt 中，并由服务端重新组合。
- Skills 枚举激活 Skills 与工作区 Skills；工作区同名定义覆盖激活定义。人格未配置 Skills 列表时使用全部有效 Skills，空列表清空，非空列表按 `name` allowlist 过滤；过滤结果经 `buildSkillsPrompt()` 注入，不授予工具权限。
- MCP 未配置工具列表时从所有已注册、已授权、未撤权、健康且未 kill switch 的工具中选择；空列表禁用全部；非空列表按工具 ID allowlist 选择。最终结果还要与用户同意、工作区策略和安全策略求交集。
- Persona Bundle 为 ZIP，包含 `manifest.json`、`persona.json` 和 `skills/skills.zip`。Skills 导出范围是人格实际生效集合：未配置时全部有效 Skills，空列表时零个，allowlist 时只导出有效命中项；保留完整目录和 checksum。
- 导入必须先校验 ZIP 路径、大小、文件数、压缩比、符号链接、YAML frontmatter、checksum 和版本；不执行 Skill 脚本，不自动授予 MCP 或其他权限。
- GPT-SoVITS 通过 `VoiceProviderPort` 提供本地 allowlist 模型和 HTTP/WS 外部服务适配；人格包只存引用与 Secret Reference 之外的非敏感配置，不包含凭据和模型权重。
- 当前实现先使用内存仓储与 Fastify 契约，后续 PostgreSQL/Outbox/Worker 实现必须保持这些 Port 和三态语义不变。

## Positive consequences

- 人格切换和配置历史可追踪、可回滚；导出的实际 Skills 集合可重建上下文。
- MCP 选择和真正授权分离，Skill Prompt 注入不能提升工具权限。
- 本地语音、外部语音和文本主流程彼此隔离。

## Negative consequences and risks

- 当前 V1 需要新增 Skill ZIP 解析、YAML 校验和供应商适配维护成本；正式生产仍需数据库、Secret Manager、沙箱和审计实现。
- 完整导出实际 Skills 会增加包体积、许可证审查和导入冲突处理成本。

## Migration / rollback

Persona、Skill、MCP 和 Voice 通过独立 Feature Flag 发布。禁用 Persona 后核心对话回退中性人格；禁用 Skills 后只移除 Skill Prompt；MCP kill switch 立即阻断调用；语音 Provider 故障回退文本。数据库落地时使用 expand/contract，保留 Revision checksum 和导入包 schema 版本。

## Verification evidence

- `TC-UNIT-PER-001`、`TC-CONTRACT-SKILL-001`、`TC-SEC-PLUG-001`、`TC-SEC-PROMPT-001`；
- Persona API 创建/切换/Turn Context Snapshot/导出导入 E2E；
- Skills ZIP 路径穿越、符号链接、压缩炸弹、YAML 校验、checksum 和脚本不执行测试；
- GPT-SoVITS 本地路径 allowlist、远程服务超时和文本回退测试；
- G4 前完成 AI Prompt 回归、安全、隐私、许可证和删除传播评审。
