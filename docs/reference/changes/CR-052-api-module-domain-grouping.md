---
id: CR-052
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.1.0
updated_at: 2026-09-16
reviewed_at: 2026-09-16
review_interval_days: 90
sources:
  - docs/reference/adr/ADR-014-modular-monolith-structure.md
  - docs/reference/standards/naming-conventions.md
  - docs/reference/PRD.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-052 apps/api 模块领域分组（25 模块 → 6 域两层结构）

- 提出人：3yearszhuang · 2026-09-16
- 修改人：3yearszhuang · 2026-09-16

关联：[ADR-014 演进式模块化单体](../adr/ADR-014-modular-monolith-structure.md) · [需求追踪基线](../REQUIREMENTS_TRACEABILITY.md) · [命名标准 AVX-STD-002](../standards/naming-conventions.md)

- 状态：Implemented（PR-C1 `refactor/cr-052-domain-grouping`）
- 提出人 / 日期：3yearszhuang / 2026-09-16
- 目标版本：当前开发阶段（C 档目录组织治理）
- 关联能力：`CAP-001~035`（横向结构治理，不改任何 CAP 行为）

## 1. 变更原因与证据

ADR-014（2026-08-31 Accepted）确立 `modules/<module>/` 单层结构时，API 层仅 8 个模块；截至今日已增长至 **25 个扁平模块**，单层结构出现：

1. **认知负荷**：目录列表无领域语义，新成员与 AI Agent 无法从路径判断模块归属（AVX-STD-002 §4 目录组织原则的落地缺口）；
2. **注册发散**：`app.ts` 需按无序清单注册 25 个模块，领域边界不可视；
3. **同类先例已验证**：A 档（PR #203）已将 `apps/worker/src/proactive-*` 10 个扁平文件收拢为 `proactive/` 子目录；`packages/repositories` 的 `sqlite/conversation/`、`sqlite/proactive/`（PR #207/#208）也已按领域子目录组织，API 模块层是唯一残留的扁平大目录；
4. **架构文档漂移**：ARCHITECTURE.md C4 组件图与实际 25 模块清单已不对齐，分组后可按域呈图。

## 2. 当前行为 vs 目标行为

- **基线**：`apps/api/src/modules/<module>/` 一层扁平，25 模块并列；
- **目标**：`apps/api/src/modules/<domain>/<module>/` 两层结构，25 模块按 6 个业务域归组（见 §3 归属表）；域目录不承载代码，只承载子模块；
- **不变量**：ADR-014 核心规则（模块自管仓储、对外入口唯一、shared 严格受限、跨模块经事件总线）**全部保持**；模块内文件组织（`routes.ts` + `index.ts`）不变；HTTP 路由路径、OpenAPI 契约、测试行为零变化。

## 3. 受影响范围与契约

### 3.1 域归属表（25 → 6）

| 域 | 模块 | 数量 | 归属依据 |
|---|---|---|---|
| `companion/`（陪伴与对话） | conversation、persona、memory、inbox、branch | 5 | 会话核心、人格、记忆、命令收件箱、消息分支 |
| `learning/`（学习与练习） | learning、study-materials、terms、diary | 4 | 错题/练习/复习、学习资料、伴学词典、每日反思日记 |
| `knowledge/`（知识与内容） | knowledge、content、project | 3 | 知识库、内容库、项目上下文（CR-043） |
| `ecosystem/`（扩展生态） | plugins、tools、mcp、skills、llm | 5 | 插件、工具运行时、MCP、AstrBot 兼容技能、模型路由与预设 |
| `proactive/`（主动智能） | proactive、notification | 2 | 主动回合编排、主动关怀通知落库（CR-032） |
| `platform/`（平台基础） | preferences、privacy、safety、voice、feedback、analytics | 6 | 偏好、隐私、安全门禁、语音、反馈、埋点 |

归属表为提案基准，实施 PR 评审期可对个别模块微调（如 diary 亦可论证归 companion），调整需同步更新本表与 ADR-014。

### 3.2 代码与配置改动面

1. **目录移动**：`git mv` 25 个模块目录至对应域（三个域内同名模块 knowledge/learning/proactive 经临时路径两步归位）；
2. **import 重写**：跨域平级引用 `../<module>/` → `../../<domain>/<module>/`（同域保持）；模块内引用平层 `context.ts` / `shared/` 的相对路径按新深度 +1 级；`import.meta.dirname` / `import.meta.url` 解析仓库根的相对层级同步 +1（typecheck 抓不到的运行时 fs 路径，共 4 处：plugins/index.ts ×2、skills/skill-manager.ts、knowledge/content/index.ts）；测试文件 `src/modules/<module>/` → `src/modules/<domain>/<module>/`；
3. **`app.ts`**：import 按六域分组重排；注册顺序**保持既有依赖序**（Fastify hook/路由注册顺序敏感，tools→llm 先于 conversation、voice/skills 先于 persona），逐行标注域归属注释；
4. **`scripts/import-boundary.mjs`**：经核实零改动——现有 5 条规则全部按包级 `fromDir`（`packages/*`、根层能力目录）匹配，不涉及 `apps/api/src/modules` 路径形态，两层结构对规则判定透明；
5. **零改动**：`@aervox/contracts` OpenAPI、路由路径、schema、仓储层、worker、前端、HTTP 契约与测试行为。

### 3.3 范围外（明确声明）

- **`packages/domain` 不在本次范围**：PRD §14.2（PR #203 对齐版）已声明 11 个设想包由现有包承载；当前无第二个消费方需求，待出现时按 AVX-STD-002 §4「先修订 PRD 再动包」流程另行立项；
- 不合并/拆分任何模块，不改模块间通信方式；
- `apps/worker`（A 档已分组）与 packages 层不动。

## 4. 验证与测试标准

1. `apps/api` typecheck 0 错误、全量测试通过（零行为变化，测试计数与基线一致）；
2. `node scripts/import-boundary.mjs` 升级后零违规；
3. `e2e` 套件通过（HTTP 契约不变的端到端证明）；
4. `rg "modules/[a-z-]+/" --glob "!*modules/<domain>*"` 抽样确认无残留一层引用（实施期自检）；
5. `mise tasks run ci-docs` 通过（ARCHITECTURE.md C4 组件图与 getting-started 目录注释同步后）。

## 5. 回滚条件与应急方案

- 纯目录移动 + import 重写，单 PR `git revert` 即完整回滚；
- 不涉及数据库、契约、运行时行为，无数据迁移与兼容层；
- 若合并后发现遗漏 import（CI 会拦截 typecheck），以 fix PR 补齐，无需回滚整包。

## 6. 实施拆分

1. **PR-C0（本 CR + ADR-014 修订）**：立项文档合入；
2. **PR-C1**：25 模块 `git mv` + import 重写 + app.ts 聚合 + import-boundary 升级 + ARCHITECTURE.md / getting-started 同步 + §4.2 落地登记。

- 决策：Accepted / Implemented
- 更新的文档和测试：`docs/reference/adr/ADR-014-modular-monolith-structure.md`（0.3.0 修订随本 CR 提案）、`docs/DOC_REGISTRY.md`、`docs/README.md`
