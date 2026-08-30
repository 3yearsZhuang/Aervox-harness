# ADR-016 底座边界冻结：Kernel Substrate 与能力层的依赖边界

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-31

- 状态：Accepted
- 日期：2026-08-28
- 接受日期：2026-08-28（G2 架构与数据门禁）

- 关联：`CAP-001～035`、`ADR-001`（模块化单体）、`ADR-014`（演进式模块化单体）、`AVX-CAP-001`（能力组合与可选化目录规范）、`AVX-HAR-001 §16.2`（Loop 架构验收）、`ADR-018`（CAP-033 主动智能 Host）、`ADR-019`（主动智能连接网关）

> 更新日期：2026-08-31

## Context

底座边界此前只存在于文档声明，没有编码层机器校验：

- [AVX-CAP-001](../capability-composition.md) 规定 Kernel Substrate（Composition/Lifecycle、Contract/Protocol、Policy/Consent、Data Rights、Outbox/Audit、Sandbox/Revocation、Observability/Recovery）不可关闭，能力层不得直写核心数据；
- [AVX-HAR-001 §16.2](../agent-harness-loop.md) 架构验收要求 Loop 应用层不导入 `@aervox/database`/Drizzle/具体 SQLite；
- [ADR-014](ADR-014-modular-monolith-structure.md) 早已提出"ESLint import 规则进一步强制模块边界"，但从未实施，边界约束仍靠评审自觉。

仓库当前没有 `capabilities/`、`providers/`、`adapters/`、`modules/` 目录，但 AVX-CAP-001 的能力组合目标是既定方向。一旦能力层出现，若无机器校验，"能力直写数据库表/宿主 Shell"的违规只会在评审中偶然被发现。AVX-CAP-001 也已预留本决策："接受该目标前必须建立 ADR-016（或等效决策）"。

## Decision drivers

1. **防止未来漂移**：文档约束无法静态阻止 import 反向依赖；必须把底座边界固化为可机器验证的健身函数；
2. **出事方向一致**：依赖方向是底座可演进性的关键不变量，需要在 CI 层 fail-closed；
3. **零负担演进**：能力层未来纳入 `modules/*` 自选时，同一套分层不变式继续生效，不依赖人肉评审；
4. **工具链现实**：仓库 TypeScript 为 7.0.2（mise.toml 唯一真源），主流依赖图工具的 TS 转译器兼容性未跟上（见 Considered options 3）。

## Considered options

1. **零改动（仅文档声明）**：拒绝。与现状无差异，漂移风险不消除，不符合"落地即机器验证"的仓库纪律。
2. **eslint `no-restricted-imports`**：拒绝。仓库无任何 eslint 配置，引入全家桶在 TS 7.0.2 下兼容性未验证；且该规则只按路径 forbid，无法表达"from 目录 × to 包名"的边界矩阵，表达力不足。
3. **dependency-cruiser**：实测后否决。先以 `-w` 安装 v18.2.0 并配置 forbid 矩阵，但运行告警缺失兼容 TypeScript 转译器（其转译支持为 `>=2.0.0 <7.0.0`）。向 `packages/agent-loop/src` 注入 `import "@aervox/database"` 的真实违规后，扫描仍报零违规——**TS 源文件依赖被漏检，门禁形同虚设**。
4. **自写边界脚本 + 解析专用依赖（本决策）**：选定。初版正则提取 import 说明符，经漏检验证后升级为 AST（`@babel/parser`，纯 JS、不承担编译、与 TS 版本无关）；规则矩阵与本文健身函数一一对应，避免引入 eslint/dependency-cruiser 类工具链；注入违规样例实测可拦截并返回非零退出码。

## Decision

采用**自写边界脚本（AST 解析）**，把底座分层固化为 5 条依赖禁令，作为 `ci-code` 的组成部分。

### 底座分层（自底向上）

| 层 | 落点 | 允许依赖 |
|---|---|---|
| L0 | `packages/contracts` | 仅第三方契约库；不得依赖任何 `@aervox/*` |
| L1 | `packages/database` | `@aervox/contracts`、libsql、Drizzle（数据真源底座） |
| L1 | `packages/agent-loop` | `@aervox/contracts`；不得导入 database/libsql/Drizzle |
| L2 | `packages/api-client`、`packages/ui` | 契约/传输/共享组件；不得导入 database/libsql/Drizzle、不得依赖宿主 Shell |
| L3 | `apps/*` | 上述所有底座（宿主单向消费底座） |
| 预留 | `capabilities/`、`providers/`、`adapters/`、`modules/` | 仅经 Port/Contract 与宿主受限接口交互；不得导入 database/libsql/Drizzle、不得依赖宿主 Shell |

### 5 条禁止规则（健身函数）

| # | 规则 | from | 禁止 import 到 |
|---|---|---|---|
| 1 | `contracts-must-be-leaf` | `packages/contracts/` | 任何 `@aervox/*` |
| 2 | `agent-loop-no-db` | `packages/agent-loop/` | `@aervox/database`、`@libsql/*`、`Drizzle ORM` |
| 3 | `packages-no-host-imports` | `packages/*` 的 `src`/`test` | `@aervox/api\|worker\|web\|desktop\|mobile`、`apps/` |
| 4 | `ui-client-no-db` | `packages/ui`、`packages/api-client` | `@aervox/database`、`@libsql/*`、`Drizzle ORM` |
| 5 | `capability-layer-no-db-no-host` | `capabilities/`、`providers/`、`adapters/`、`modules/` | 同 #4 + 宿主 Shell |

### 落地形态

- 规则事实源：[scripts/import-boundary.mjs](../../../scripts/import-boundary.mjs)（`--list` 打印规则）；自测 [import-boundary.test.mjs](../../../scripts/import-boundary.test.mjs)（`node --test`）；
- 门禁：根 `pnpm check:boundary` → `mise tasks run ci-code`；`.github/workflows/ci.yml` 触发路径补充 `scripts/**`；
- 边界增删必须**双写**：同步更新脚本与本文/AVX-CAP-001，任何单一改动视为未闭环；
- **落地点修正（2026-08-28）**：解析器由正则升级为 AST。初版尝试复用根 `typescript@7` 主入口未果——其仅暴露版本号、不再提供运行时 API（API 迁至 `./unstable/ast` 原生绑定）；改用 `@babel/parser`（纯 JS 解析专用包，不承担编译），作为根 devDependency 引入。决策不变，仅解析实现调整：旧正则方案已确认漏检 Vue 单文件组件/export-from 等场景，升级不改动 5 条禁令与分层。

### 明确不在本 ADR 底座的

- 各业务能力（Conversation、Learning、Review……）与[能力注册表](../capability-registry.md)登记的 P1/P2/P3 候选：保留主仓期间同样受上述分层约束；纳入自选机制后由分层不变式（#5）接管，不属于 Kernel Substrate。

## Positive consequences

- **机器可验证**：边界不变量进入 `ci-code`，违规即阻断，不再依赖评审自觉；
- **fail-closed 预置**：能力层目录尚未出现，规则已先行生效（#5），未来迁移不会产生"真空期"；
- **轻依赖**：仅引入解析专用 `@babel/parser`（根 devDependency），不引入 eslint/dependency-cruiser 类工具链，不受 TypeScript 版本影响；
- **可测**：规则矩阵有 14 项自测，覆盖 type import、副作用导入、动态 `import()`、Vue 单文件组件、export-from、相对跨包与合法宿主消费。

## Negative consequences and risks

- **解析依赖**：脚本依赖 `@babel/parser`（根 devDependency），不再是零依赖；取舍理由见落地形态中「落地点修正」。缓解：仅解析不承担编译，无版本耦合（与 TypeScript 7 无关）。
- **仍有解析盲区**：动态 `import()` 为带表达式的模板字符串（拼接变量路径、目标无法静态确定）、CommonJS `require()`、解析不到实际文件的相对引用不在扫描范围。缓解：登记为已知限制并在脚本注释明示，由代码评审兜底；Vue 单文件组件与相对跨包引用已由本次 AST 升级覆盖。

## Migration / rollback

迁移：

1. 新增 `scripts/import-boundary.mjs` 与测试（本决策落地即完成）；
2. 根 `package.json` 增加 `check:boundary`，`mise.toml` 的 `ci-code` 前置执行；
3. `ci.yml` 触发路径含 `scripts/**`（本决策已完成，PR 合入后 CI 生效）。

回滚：

- 代码层：`git revert` 删除脚本与 `ci-code` 前置段即可，零残留依赖；
- 文档层：保留本 ADR 标记为 `Superseded/Rejected`（不复用编号），或同步降级 AVX-CAP-001 关联。
- 回滚不破坏任何既有行为：本改动未修改任何模块的 import 或运行时逻辑，只增加静态检查。

## Verification evidence

决策接受（`Proposed → Accepted`）前至少提供：

- [x] `node scripts/import-boundary.mjs`：全仓扫描零违规（含 Vue 单文件组件源扫描）；
- [x] `node --test scripts/import-boundary.test.mjs`：14/14 通过；覆盖 5 条规则、type import、副作用导入、动态 `import()`、Vue 单文件组件、export-from、纯模板字符串、相对跨包判定、宿主合法消费与已知限制；
- [x] 注入违规实测：`packages/contracts/src` 注入 `@aervox/agent-loop`（#1）、`packages/agent-loop` 注入 database/libsql/Drizzle（#2）、`packages/ui/.../_boundary-sanity.vue` 注入 database（#4）均被拦截且退出码 1（dependency-cruiser 对相同注入漏检）；
- [x] `mise tasks run ci-code` 全量通过（2026-08-28，分支执行）；
- [x] `mise tasks run ci-docs` 通过（2026-08-28，本文与索引登记改动）。
