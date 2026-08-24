# Aervox｜思隅（伴学桌宠）

面向编程初学者的 AI 陪伴式学习产品。本仓库承载产品定义、工程规范与契约种子。

## 文档入口

- [文档索引](docs/README.md)：文档体系、权威顺序、`从哪开始`（§8）· [文档生命周期登记表](docs/DOC_REGISTRY.md)
- [产品需求 PRD](docs/PRD.md)：为什么做、为谁做、全生命周期做什么（AVX-PRD-001）
- [架构设计](docs/ARCHITECTURE.md) · [ADR](docs/architecture/adr/README.md) · [SRS](docs/requirements/SRS.md)
- [可选功能模块化方案](docs/architecture/optional_modules.md)：非核心功能以子仓库开发 + workspace 自选消费（AVX-MOD-001）
- [需求追踪与交付基线](docs/REQUIREMENTS_TRACEABILITY.md)：CAP 状态、DoR、G0~G6 门禁
- [操作指南](docs/how-to/)

## 工程骨架

- pnpm + Turborepo monorepo（`apps/*`、`packages/*`）
- `@aervox/contracts`：流式协议、Persona、Skills、MCP 和 Voice 的机器契约（规则见 [STREAMING_PROTOCOL](docs/contracts/STREAMING_PROTOCOL.md)）
- `@aervox/persona`：人格修订、激活、上下文快照与 Persona Bundle 导入导出
- `@aervox/skill-runtime`：Anthropic `SKILL.md` 解析、三态过滤、渐进式提示和安全 ZIP
- `@aervox/ai-runtime`、`@aervox/mcp-port`、`@aervox/voice-port`：上下文组合、MCP ToolPolicy 与 GPT-SoVITS Provider Port
- 参考仓库 `reference/`（固定 commit 子模块，仅作设计验证）：deepseek-harness / pi / baishou-next / dsh-synapse

## 快速开始

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## 当前状态

需求/架构阶段：P0（CAP-001~013）已 `Specified` 并进入 DoR 评估；工程骨架可构建。详见 [docs/README](docs/README.md)。

## CI 门禁

- **文档**（改动 `docs/**` 或 `README.md`）：markdown lint + 链接检查（[docs.yml](.github/workflows/docs.yml)）
- **代码**（改动 `apps/**`、`packages/**`）：install + build + typecheck（[ci.yml](.github/workflows/ci.yml)）
