# 贡献指南 · Contributing

<a id="AVX-STD-001"></a>

<a id="AVX-DOC-GOV-001"></a>

环境准备见[从哪开始](docs/getting-started.md)，按[文档导航](docs/README.md)查阅任务相关的事实源。

## 开发流程

| 改动 | 需要维护的内容 |
|---|---|
| 普通 Bug 修复、内部重构 | 代码、必要回归测试、PR；现有合同未变时无需文档或计划登记 |
| 用户行为或接口变化 | 对应需求、契约及必要的使用说明；能力状态发生变化时更新追踪基线 |
| 重大架构、权限或数据责任变化 | 新建或修订 [ADR](docs/reference/adr/README.md)，保留决定与取舍，再按获批准范围实施 |
| 文档勘误 | 修改该文档；无需更新日期、版本或登记表 |

报告问题时提供复现步骤、预期与实际行为和环境。新增功能先明确用户问题与范围；已经获得维护者授权的工作可直接推进。适合插件的功能复用[插件扩展点](docs/how-to/develop-plugin-ui-extension.md)，不要把安装声明包解释为任意代码的沙箱执行。

使用 `feat/<name>`、`fix/<name>` 或 `docs/<name>` 分支，禁止直接提交或推送 `main`。提交采用 `feat:`、`fix:`、`docs:`、`refactor:` 等 Conventional Commits 前缀。PR 描述问题、最终行为、相关验证及实际剩余限制，提交者应能解释所提交的代码；经审查后合入。

贡献者只署名真人账号，提交信息、PR 与文档不得添加 AI 作者或 `Co-authored-by` AI 署名。

<a id="plan-maintenance"></a>

## 当前迭代

直接编辑 [plan.md](plan.md)。只登记需要排序、依赖协调或持续跟踪的工作；普通小修复无需入队。保留已有 ITER 编号和依赖，在范围、状态或待决定事项变化时更新相应条目。完成项保留结果和 PR 证据，详细运行日志由 PR/CI 保存。计划不替代需求或发布验收，也不授予执行全部建议的权限。

<a id="development-constraints"></a>

## 开发约束

- 工具版本只取 [mise.toml](mise.toml)，命令通过 `./aervox` 或 `mise exec --` 执行。新增依赖在根运行 `mise exec -- pnpm add -w <pkg>`，开发依赖用 `-Dw`；不在子包单独安装。
- 本地单用户使用 `LocalContext`，不引入 `tenantId` / `TenantContext`。SQLite 写入走写者连接，事务结果测试通过写者连接断言；禁止嵌套事务及事务内耗时 I/O。libsql 事务 BEGIN 不自动重试，细节见[数据库契约](docs/reference/DATABASE.md)。
- 破坏性数据库变更按[迁移演练](docs/how-to/run-database-migration-drill.md)完成停写、备份、明确数据范围、staging 构建、校验、原子换库和回滚保留。
- Fastify 路由与中间件使用 `async/await`；中间件重构只修改所需路由范围。OpenAPI 使用锁定的 `zod-to-openapi` v9 与 `OpenApiGeneratorV31`；定义 Zod Schema 前先调用 `extendZodWithOpenApi(z)`。
- 模块导入、宿主纯净性、类型、依赖和实现可移除性由代码守卫检查。变更边界需同步其权威合同，不另写目录副本。

<a id="documentation"></a>

## 写作与事实源

保留 Diátaxis 的职责区分：教程带读者完成一次任务，How-to 解决具体操作，Reference 定义合同，Explanation 解释背景与取舍；不要求为同一主题凑齐四份文件。新增内容优先放入现有合适文档，仅在确有独立读者任务时拆分。

普通文档无需 Front Matter；现有稳定 `id` 可以保留，不重用编号。作者、修改日期和历史由 Git 维护。ADR 使用 `id`、`decision_status` 和必要的 `superseded_by`，格式见 [ADR 索引](docs/reference/adr/README.md)。实际草案在正文明确标注；取消元数据不会将草案变成批准基线。

PRD 定义产品价值与范围，SRS 定义可观察行为和验收，架构/ADR 解释技术边界，Schema/OpenAPI/协议定义实现合同，[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)记录 CAP 状态、证据和未关闭门槛。优先链接真源，不复制字段表、状态和测试日志。法律、安全、隐私承诺不能被实现便利覆盖；冲突时明确受影响范围并取得决定。

移动或删除文档时同步入站链接，保留被引用的稳定编号和必要锚点。导航只在读者入口变化时更新。列表中的代码块前后留空行；专有名词按[术语表](docs/reference/standards/terminology.md)书写，代码标识符使用反引号。

<a id="validation"></a>

## 验证与交付

| 目标 | 命令 |
|---|---|
| 日常增量检查 | `./aervox ci` |
| 定向测试 | `./aervox test`、`./aervox test api`、`./aervox test repos` |
| 文档增量 / 全量检查 | `mise tasks run docs-lint-affected` / `mise tasks run ci-docs` |
| 全量代码检查 | `mise tasks run ci-code` |
| 全量终审 | `./aervox ci all` |
| Markdown 排版修复 | `mise exec -- markdownlint-cli2 --fix <files>` |
| 插件分发包恢复 | `mise tasks run package-plugins` |

Markdownlint 必须使用 mise 注入的固定版本，不用 `npx` 临时下载。纯文档 PR 运行文档门禁；代码或 CI 工具变更按影响范围验证，推送代码 PR 前运行全量终审。CI 配置变更本身需要相应脚本回归。测试通过证明所覆盖行为，不能代替实机、签名、迁移或发布验收。

外部参考子模块不属于默认构建前置条件；完整代码门禁中的 DSH 适配测试要求先运行 `git submodule update --init reference/deepseek-harness`。其他参考代码按需初始化。工具版本、测试选择及脚本入口以配置为准，不在本文手工维护用例数量和耗时。

## 参考项目与许可

固定参考版本、来源、许可证及借鉴要求见[参考设计评估](docs/explanation/reference-design-transfer.md)。引用代码保留原许可、版权和来源；重新实现需说明接口与边界，不因改写变量名而免除许可责任。

主仓源码采用 AGPL-3.0-or-later，独立 `packages/core` 采用 Apache-2.0，文档采用 CC BY-NC-SA 4.0；具体以各目录许可证为准。

## English

Use the toolchain pinned by mise and work on a feature, fix, or documentation branch. Submit changes through a reviewed PR; never push directly to main. Ordinary fixes need code and relevant tests, behavior changes update their canonical contracts, and significant architecture, permission, or data decisions use ADRs. Edit the current iteration plan directly only when coordination is needed. Git owns document history; routine metadata and registry updates are not required. Keep implementation, verification, and release evidence distinct. Human contributors retain sole authorship credit.
