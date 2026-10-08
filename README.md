# Aervox｜思隅

Aervox 是一个以桌宠为入口的“主动智能” Agent 系统。基于 TypeScript 全栈 monorepo 构建，实现交互减法、全域感知、自进化记忆与纯本地数据主权。

产品定义与核心设计理念见 [PRD](docs/reference/PRD.md)，系统架构与技术选型见 [架构设计](docs/reference/ARCHITECTURE.md)。

## 开发者预览

Aervox 处于**开发者预览阶段**，正在快速演进，API 契约与本地数据存储格式可能发生不兼容变更。

运行前请确认数据备份与本地网络环境。

## 快速开始

### 从源码运行

项目由 [mise.toml](mise.toml) 严格锁定工具链版本（Node 24、pnpm 11、Vale 3.18、markdownlint-cli2 0.23.3）。安装 [mise](https://mise.jdx.dev) 后在仓库根目录执行：

```sh
git clone https://github.com/3yearsZhuang/Aervox-harness.git
cd Aervox-harness
./aervox setup
./aervox dev
```

`./aervox dev` 将启动全栈开发环境：API (`:3000`) + Web (`:5173`) + Desktop (Electron) + Worker。

常用轻量开发启动：

- `./aervox dev web`：仅启动 API 与 Web 工作台
- `./aervox dev desktop`：仅启动 API 与 Electron 桌面端
- `./aervox dev worker`：仅启动后台 Worker 进程
- `./aervox help`：查看全部命令与变体说明

## 仓库结构

```text
apps/
  api/              Fastify 5 API 服务（按领域模块组织）
  web/              Vue 3 伴学工作台（端口 5173）
  desktop/          Electron 桌面端（Fairy 桌宠，支持透明窗口与安全 IPC）
  worker/           后台任务进程（SQLite Outbox 投递与批处理调度）
  cli/              终端连接版（siyu）
  mobile/           Capacitor 移动壳
packages/
  core/             独立 Agent 内核（Apache-2.0 分层许可）
  host-agent/       异步 Agent Host（任务领取与心跳续租）
  contracts/        Zod 契约事实源与 OpenAPI 3.1 元数据
  schema/           Drizzle 表结构定义（SQLite 业务表单一真源）
  repositories/     SQLite 仓储层（DDL、迁移与混合检索）
  practice-review/  SM-2 间隔复习排期引擎
  diary/            AI 记忆日记生成共享包
  ui/               Web 与 Desktop 共享的 Vue 3 组件库
  api-client/       Web、Desktop 与 CLI 共享的 API 客户端
  config/           运行时环境配置加载与严格校验
  observability/    结构化日志与审计导出
  live2d/           Live2D Mizuki 模型静态资产
  public/           共享公共资产与宣讲页
  host-plugin-api/  第一方插件宿主扩展契约
plugins/            第一方与扩展插件（focus-mode、home-assistant 等）
```

## 开发与贡献

从 [从哪开始](docs/getting-started.md) 入门，查阅 [架构设计说明书](docs/reference/ARCHITECTURE.md) 与 [ADR 决策索引](docs/reference/adr/README.md)。

全量文档遵循 Diátaxis 架构组织，完整分类索引见 [文档索引](docs/README.md)。当前迭代任务统一维护在根目录 [plan.md](plan.md)。

常用开发自检命令：

```sh
./aervox ci          # 本地极速门禁自检（防漂移守卫 + 增量代码 + 增量文档）
./aervox ci all      # 全量终审门禁（全量 19 包构建/类型/测试 + 全量文档）
./aervox test        # 智能增量测试
```

AI 编码助手协作规则见 [AGENTS.md](AGENTS.md)。代码贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开源协议

本项目采用分层许可机制：

- **独立内核 `packages/core`**：基于 [Apache License 2.0](packages/core/LICENSE) 授权
- **其余源代码**（`apps/`、`packages/`（除 `core`）、`scripts/` 及配置文件）：基于 [AGPL-3.0-or-later](LICENSE) 授权
- **文档资产**（`docs/`、`README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`plan.md`）：基于 [CC BY-NC-SA 4.0](docs/LICENSE) 授权
