---
id: ADR-016
decision_status: accepted
---

# ADR-016 底座边界冻结：Kernel Substrate 与能力层的依赖边界

## Context

底座的依赖方向不能只靠文档和人工评审约束。内核、共享组件与可选能力必须通过 Port 访问宿主资源，避免导入数据库或应用 Shell；方向遵循 [ADR-014](ADR-014-modular-monolith-structure.md) 与[能力组合规范](../capability-composition.md)。本决定于 2026-08-28 接受。

## Considered options

| 方案 | 取舍 |
|---|---|
| 仅文档或人工评审 | 拒绝；无法及时阻止反向依赖 |
| 引入 ESLint 全套 | 未采用；现有工程未使用，简单禁词规则不能充分表达来源与目标矩阵 |
| dependency-cruiser | 当时拒绝；与仓库 TypeScript 版本兼容失败，实际违规注入漏检 |
| 自有规则脚本与专用 AST 解析器 | 采用；`@babel/parser` 只解析语法，不承担 TypeScript 编译，可表达矩阵与 Vue 源码规则 |

## Decision

以 [import-boundary.mjs](../../../scripts/import-boundary.mjs) 为可执行规则真源，纳入代码门禁；规则、负向样例与受影响契约在同一 PR 修改。正则抽取不能完整识别 Vue、动态字面量、类型导入和重新导出，采用 AST。

| 边界 | 不变量 |
|---|---|
| Contracts | 叶子契约包，不依赖其他 `@aervox/*` |
| Schema / Repositories | 数据真源底座，分别负责结构与仓储；禁止恢复旧 database 巨包 |
| Core | 宿主无关，零运行时依赖，不导入 SQLite、Drizzle 或仓储；具体发行边界见 ADR-021 |
| UI / API Client | 只承载展示、传输与共享契约，不导入数据库或宿主 Shell |
| Apps | 单向消费底座，具体业务通过显式装配与 Port 组合 |
| 能力与插件 | 不直连数据库或宿主内部，只使用受限公共接口；目录变化须保持同一依赖方向 |

当前确切扫描范围与规则名通过 `mise exec -- node scripts/import-boundary.mjs --list` 查询，本文不复制不断变化的禁词与路径清单。动态表达式、CommonJS 或无法静态求值的行为不能仅凭静态扫描证明安全，仍需运行验证与审查。

## CR-056 模块边界门禁（2026-09-28）

API `src/modules/<domain>/<module>` 的跨模块引用仅允许公开 `index.ts`。组合根不获目录级豁免；历史私有引用精确登记源/目标、Owner 与删除条件于 [module-boundary-exceptions.json](../../../scripts/module-boundary-exceptions.json)，迁移后移除。门禁通过不代表全部历史 Port 迁移完成。

模块扫描识别类型导入、TSImportType、re-export、动态字面量、目录入口及 `.js` 到 `.ts`；纳管源码的解析失败、缺失相对目标及非字面量动态导入阻断。测试可以验证私有实现，原包级扫描范围保持原边界。

<a id="cr-060"></a>

## 第一方插件与宿主分工

原 CR-060 的已接受修订将专注模式声明与实现内聚于 `plugins/focus-mode/`。API/Web/Desktop 组合根显式注入，宿主提供通用注册表、事件、状态、元数据与受限服务，不解释插件身份或持有插件样式、状态机、提示词和工具业务。插件只从公共入口消费 UI 与 `@aervox/host-plugin-api`；数据库、仓储和实时总线由宿主封装为窄端口。

模型工具、guidance、Hook 和插件 HTTP 入口统一按启用记录与可用性拒绝式准入；没有记录或实现缺席不能默认启用。缺包不等于卸载，保留配置、Secret、授权历史、数据导出与删除入口，恢复包不恢复已撤销授权。具体贡献、消息合并、投影与生命周期合同只维护在[插件规范](../plugin-config-and-pages.md#03-插件与宿主分工)。

本决定不把学习闭环变为可选模块：`CAP-001～013` 继续进入标准 Profile 与默认构建，学习事实表、仓储、复习排期及其服务留在主仓。插件经 `learningFacts` 访问，不能自建第二真源；本次无表结构或数据迁移。内核产品提纯及 Apache-2.0/AGPL 分层由 [ADR-021](ADR-021-aervox-core-standalone-package.md#amendment) 承接。

第一方源码随主仓编译；`.aervox-plugin` 只打包明确允许的声明和资源，不含源码、依赖或构建产物。通用分发器不因目录内有实现而执行第三方代码。

## Consequences and verification

边界违规可在 CI 阻断；代价是维护 AST 解析、精确例外和契约。验证包括真实违规注入、动态/类型导入与 Vue 场景、插件停用/缺包、端点失败可观测、投影归属和组合根编译；详见[边界测试](../../../scripts/import-boundary.test.mjs)、[插件契约测试](../../../packages/contracts/test/plugin-api-registry.test.ts)及[物理移除演练](../../../scripts/run-removability-drill.mjs)。

插件移除演练须删除实现并剥离包清单和三处装配后冷构建 API/Worker、检查 Web/Desktop 类型与数据权利入口。纯净性棘轮零命中仅证明已登记规则未命中，不证明语义上没有领域知识。分发清单与字节可重现性独立验证，结果以相关 PR 为证，不在本文累积运行日志。

## Migration / rollback

依赖重组按可审查 PR 切片推进，边界测试随接口迁移。停用插件或移除装配只影响其贡献，保留数据和管理入口；回退源码须恢复一致的两端准入与注册生命周期，不能因缺包体验回退直接降为默认允许。跨文件分发升级的回退另按插件生命周期处理，本决定没有数据库换库步骤。
