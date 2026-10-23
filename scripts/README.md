# Aervox 仓库脚本工具集 (scripts/)

本目录包含 Aervox 项目的架构守卫、门禁分析、契约验证、领域专项研究套件及基准测试工具。

所有脚本均遵循统一工具链锁定规范。优先使用 `./aervox` 或 `mise tasks run <task>`；下表中的 `pnpm`、`node` 指令需加 `mise exec --` 前缀，或在已激活 mise 的终端中执行。

---

## 1. 架构守卫与门禁 (Guards & Hygiene)

用于保障模块解耦、单向依赖及本地单用户架构不变量：

| 脚本文件 | 对应的测试 | 职责说明 | 执行指令 |
|---|---|---|---|
| `check-banned-identifiers.mjs` | `check-banned-identifiers.test.mjs` | 本地单用户架构守卫，严禁引入多租户隔离概念 | `node scripts/check-banned-identifiers.mjs` |
| `check-host-domain-purity.mjs` | `check-host-domain-purity.test.mjs` | 宿主去领域化守卫，确保宿主不含特定插件领域概念 | `node scripts/check-host-domain-purity.mjs` |
| `check-type-boundary.mjs` | `check-type-boundary.test.mjs` | 类型边界守卫，强制复用 `@aervox/contracts` DTO | `node scripts/check-type-boundary.mjs` |
| `check-dep-hoisting.mjs` | `check-dep-hoisting.test.mjs` | 依赖提升守卫，各包依赖严格在各自 `package.json` 声明 | `node scripts/check-dep-hoisting.mjs` |
| `check-removable-implementation.mjs` | `check-removable-implementation.test.mjs` | 可移除插件实现守卫，防止外部代码直接引用可移除私有模块 | `node scripts/check-removable-implementation.mjs` |
| `check-tracked-files.mjs` | `check-tracked-files.test.mjs` | 追踪文件卫生守卫，防止大文件、密钥或本地临时文件被提交 | `node scripts/check-tracked-files.mjs` |
| `import-boundary.mjs` | `import-boundary.test.mjs` | AST 依赖边界分析器，严格保护分层单向依赖架构 | `node scripts/import-boundary.mjs` |
| `check-dependency-audit.mjs` | `check-dependency-audit.test.mjs` | 依赖安全性审计，与 `dependency-audit-exceptions.json` 校验 | `pnpm check:dependency-audit` |
| `ci-scope.mjs` | `ci-scope.test.mjs` | CI 与增量门禁作用域计算器，防止包外输入变更漏选 | `node --test scripts/ci-scope.test.mjs` |
| `check-affected.mjs` | `check-affected.test.mjs` | 极速本地增量代码门禁执行器 | `pnpm check:affected` |

> 快速运行上述全部守卫的单元测试：`pnpm test:guards` / `./aervox test guards`。

---

## 2. 打包与契约治理 (Packaging & Standards)

| 脚本文件 | 职责说明 | 执行指令 |
|---|---|---|
| `export-plugins.mjs` | 遍历 `plugins/`，生成字节可重现的 `.aervox-plugin` 分发包 | `pnpm package:plugins` |
| `plugin-cli.mjs` | 声明式插件开发与本地预检 CLI | `pnpm plugin` |
| `openapi-compat.mjs` | OpenAPI 模式向后兼容性守卫与基线校验 | `pnpm check:standards` / `pnpm update:api-baseline` |
| `docs-governance.mjs` | 文档规范性校验器（稳定 ID、ADR 状态、本地链接与锚点） | `node scripts/docs-governance.mjs` |
| `docs-lint-affected.mjs` | 增量文档格式、术语与一致性检查调度器 | `node scripts/docs-lint-affected.mjs` |

---

## 3. 原生运行时与工具链 (Native & Rust Tools)

| 脚本文件 | 职责说明 | 执行指令 |
|---|---|---|
| `native-runtime.mjs` | 原生平台能力探测与执行监管 | `mise tasks run native-runtime` |
| `build-native-runtime.mjs` | 原生共享库与可执行体构建包装 | `mise tasks run native-runtime-build` |
| `generate-native-protocol.mjs` | 从原生契约自动生成 TypeScript IPC 协议类型 | `mise tasks run native-protocol-generate` |
| `install-native-tools.mjs` | 为锁定的 Rust 工具链安装格式化与静态检查组件 | `mise tasks run native-toolchain-setup` |
| `native-search-fixture.mjs` | 向量搜索确定性合成测试数据生成 | 供基准测试内部调用 |

---

## 4. 领域专项套件 (Domain Research Suites)

| 目录/套件 | 职责说明 | 关联指令 |
|---|---|---|
| `deletion-fault-testing/` | 跨系统记忆删除故障注入测试引擎与可重现调度器 | `pnpm check:deletion-fault-testing` |
| `memory-deletion-research/` | 记忆删除可验证性与学术复现基准套件 | `pnpm check:memory-deletion` |
| `hls-agent/` | 高层次综合 (HLS) 自主 Agent 研究 CLI 与评测流程 | `pnpm check:hls` / `mise tasks run hls-agent` |

---

## 5. 性能基准与可靠性演练 (Benchmarks & Drills)

| 脚本文件 | 职责说明 | 执行指令 |
|---|---|---|
| `benchmark-core.mjs` | 假 Provider 与内存存储下的流首段可见、取消和采样堆内存基准 | `pnpm benchmark:core` / `mise tasks run core-benchmark` |
| `benchmark-native-runtime.mjs` | 临时 SQLite 上的只读向量、音频预处理与 ZIP 路径对照，不替换生产数据库或索引 | `mise tasks run native-runtime-benchmark` |
| `benchmark-native-search.mjs` | 固定种子合成向量的 TypeScript/Rust 计算与进程 IPC 对照 | `mise tasks run native-search-benchmark` |
| `worker-write-contention-drill.mjs` | 多进程 SQLite 跨进程写锁冲突与退避演练 | `pnpm drill:worker-contention` |
| `run-removability-drill.mjs` | 插件模块物理移除、独立编译、数据保留与恢复全流程演练 | `pnpm drill:removability` / `mise tasks run drill-removability` |

---

## 6. 通用辅助模块 (Utilities)

- `source-files.mjs`: 通用源码文件遍历与过滤辅助函数。
- `workspaces.mjs`: `pnpm-workspace.yaml` 解析与包归属判定辅助函数。
- `test-package.mjs`: 按真实 workspace 名称解析测试目标，拒绝无匹配或未声明测试的选择（`./aervox test <pkg>`）。
- `clean-generated.mjs`: 清理构建产物与 `.turbo` 缓存（`./aervox clean` / `pnpm run clean`）；可用 `--dry-run` 预览，pnpm 传参时使用 `pnpm run clean --dry-run`。
- `vendor-chunks.ts`: Vite 构建 chunk 分块共享策略配置。
