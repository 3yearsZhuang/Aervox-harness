# Aervox｜思隅

Aervox 是一个以桌宠为入口的“主动智能” Agent 系统。基于 TypeScript 全栈 Monorepo 与 Rust 原生运行时构建，秉持**交互减法、全域感知、自进化分层记忆与纯本地数据主权**设计理念，帮助学习者构建从目标设立、引导式探究到练习与复习的认知闭环。

产品定位与核心理念见 [产品需求 (PRD)](docs/reference/PRD.md)，可观察系统行为见 [系统需求说明 (SRS)](docs/reference/SRS.md)，架构决策与演进见 [系统架构说明书 (SAD)](docs/reference/ARCHITECTURE.md)，能力交付状态见 [需求追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)，全局文档入口见 [文档导航](docs/README.md)。

---

## 核心系统特性

以下概览已有实现的代码切片；整项能力的验收与发布状态以[需求追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)为准。

* **多端与多根界面 (Multi-Surface Architecture)**
  * **桌面宠 (Desktop Live2D)**：基于 Electron 的透明窗口交互、情绪反应、语音联动与轻量伴学。
  * **标准与紧凑工作台 (Workbench UI)**：多根界面试验田，集成会话树、工具审批卡片与任务中心。
  * **思隅·主动陪伴（`proactive-ui`）**：视觉小说（Galgame）式打字机对话盒、Live2D 舞台与主动建议卡。
  * **终端连接版 (Siyu CLI)**：命令行直连本地服务，支持流式消息消费与写工具非 TTY 审批拦截。
  * **常驻 Bot 适配器**：已实现微信本人扫码私聊与 QQ 群 `@bot` 白名单接续的适配代码，兼顾独立会话与个人记忆边界隔离。
* **独立解耦内核与执行管线 (Agent Core & Harness)**
  * **独立内核 `@aervox/core`**：分层 Apache-2.0 许可，运行时零外部依赖，统一 Provider 抽象与规范化中断原因。
  * **执行管线防御**：终态争抢防御、密集流限时刷新、准备阶段取消传播与基于事实源（Grounding Facts）的上下文压缩。
  * **Turn 中断与工具审批**：支持可中断的 Turn 状态机、多步只读工具免审批及高危写操作 SPI 拦截。
* **纯本地单用户数据主权 (Local-First Data Sovereignty)**
  * **本地 SQLite（WAL 模式）**：作为永久单用户业务唯一真源，彻底摒弃共享数据库多租户。
  * **统一数据拓扑**：`@aervox/schema`（Drizzle ORM 表定义）与 `@aervox/repositories`（仓储访问与 FTS5 全文检索）。
  * **离线安全检索**：SQLite FTS5 与向量搜索端口（VectorSearchPort）混合检索，支持全本地模型离线重建。
  * **可靠异步调度**：本地 SQLite Outbox 持久化队列 + 独立 Worker 进程异步重试与投递。
* **科学认知与自进化记忆 (Cognitive Loop & Memory System)**
  * **四段式分层记忆**：工作记忆、短期情境、长期情境与系统记忆，配备严格的记忆来源链与可审计异步删除机制。
  * **间隔复习排期**：按连续答对次数安排 1/2/4/8/15 天的固定间隔，支持 IANA 时区与夏令时边界（`@aervox/practice-review`）。
  * **真实记忆日记**：基于执行事实的 AI 记忆日记生成（`@aervox/diary`）。
* **第一方插件与扩展沙箱 (Ecosystem & Page Sandbox)**
  * **清单驱动插件**：基于声明式 `plugin.manifest.json` 与 Aervox Config Schema v1 规范注册。
  * **Page 沙箱隔离**：受限 iframe 页面运行，基于 `postMessage`、密码学 Nonce 及窗口来源严格校验。
  * **MCP 出站扩展**：内置标准 MCP（Model Context Protocol）HTTP 客户端桥，支持按需接入外部工具。

---

## 项目阶段与当前进展

Aervox 目前处于 **开发者预览阶段（Developer Preview / MVP+ 迭代期）**。API 契约与本地存储格式仍可能发生不兼容变更，运行前请备份本地数据。

### 已交付的实现切片

* **内核独立解耦**：独立的 `@aervox/core` 核心包运行时零外部依赖，宿主通过公开出口接入执行与 Provider 能力。
* **多根界面插件化**：落地 `UISurfaceManifest` 契约，支持薄 UI 宿主装配完整工作台、紧凑工作台、桌宠及思隅陪伴根界面。
* **Bot 平台接入**：微信私聊与 QQ 群适配器代码及自动化测试已交付，共用会话执行链路，按来源隔离个人派生数据与记忆。真实微信配对与连续对话、NapCat 多成员与重连，以及本机/独立部署恢复仍待环境具备后验收，见 [ITER-062](plan.md#iter-062)。
* **思隅终端连接版**：交付 `apps/cli`，打通纯传输连接与工具往返集成。
* **工程架构治理与审计整改**：文档体系按 Diátaxis 精简，完成本轮仓库卫生整改，配置受跟踪文件防护与 AST 级导入边界守卫。
* **记忆删除研究与故障测试工具**：两轮记忆删除研究已归档；异步删除故障测试生成、反例重放与证据一致性校验已实现，并完成一次修订后的工程验证。方法发现收益尚未建立，研究边界与负结果见 [ITER-066](plan.md#iter-066)。

### 当前协调与后续演进

工作进展与依赖顺序直接维护在 [当前计划 (plan.md)](plan.md)；历史缺口与功能发布门槛见 [需求追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)。

* **历史 API 规范化收敛**：分批补齐历史 HTTP 接口的共享 Schema、OpenAPI 描述与客户端契约校验。
* **声明包原子激活**：推进插件独立资源准备、短事务激活与可恢复升级机制。
* **Page 资源通道加固**：打通 Token 模式下受限 Page 资源通道与跨窗口撤权实时失效。
* **硬件与移动端形态探索**：推进桌面实体入口选型、离线协同机制与移动端运行策略评估。

---

## 仓库结构

代码库采用全栈 Monorepo 组织，具备 `package.json` 的内部包由 pnpm workspace 管理；`plugins/` 同时包含声明式插件和第一方源码插件：

```text
Aervox-harness/
├── apps/                         # 应用程序宿主
│   ├── api/                      # Fastify 5 API 组合根
│   ├── cli/                      # 思隅终端连接版（siyu）
│   ├── desktop/                  # Electron 桌面端（Live2D 桌宠、透明窗口与安全 IPC）
│   ├── mobile/                   # Capacitor 移动端封装壳
│   ├── web/                      # Vue 3 伴学工作台（Vite，端口 5173）
│   └── worker/                   # 后台任务进程（SQLite Outbox 投递与批处理调度）
├── packages/                     # 共享能力包
│   ├── core/                     # 独立 Agent 内核（Apache-2.0 分层许可，零外部运行时依赖）
│   ├── host-agent/               # 异步 Agent Host（任务领取与心跳续租）
│   ├── host-runtime/             # API 与 Worker 共用的产品宿主、MCP 客户端与模块 Port
│   ├── host-plugin-api/          # 第一方插件宿主扩展契约与 SPI
│   ├── ui-host/                  # 根界面与设置面板的装配契约（UISurfaceManifest）
│   ├── contracts/                # Zod 契约事实源与 OpenAPI 3.1 元数据
│   ├── schema/                   # Drizzle ORM 表结构单一真源（SQLite 业务表）
│   ├── repositories/             # SQLite 仓储访问层（DDL、短事务、迁移与 FTS5）
│   ├── practice-review/          # 固定间隔复习排期与练习反馈
│   ├── diary/                    # AI 记忆日记生成共享包
│   ├── ui/                       # Web 与 Desktop 共享的 Vue 3 组件库与设计令牌
│   ├── api-client/               # Web、Desktop 与 CLI 共享的 API 客户端
│   ├── native-runtime/           # 原生能力进程绑定与跨平台协议桥
│   ├── config/                   # 运行时环境配置加载与严格校验
│   ├── observability/            # Pino 结构化日志与审计导出
│   ├── live2d/                   # Live2D Mizuki 模型静态资产与构建期复制
│   └── public/                   # 共享公共资产与宣讲页
├── plugins/                      # 第一方业务与扩展插件
│   ├── anki-sync/                # Anki 文本导入与可选 MCP 接入声明
│   ├── bot-onebot/               # QQ 平台适配器（OneBot v11 / NapCat）
│   ├── bot-weixin/               # 微信个人私聊适配器（扫码授权与配对确认）
│   ├── diary-distillers/         # 记忆与对话日记蒸馏流水线
│   ├── focus-mode/               # 启发式教学、概念探索与现场刷题
│   ├── health-guard/             # 基于键鼠空闲元数据的久坐与休息提醒
│   ├── home-assistant/           # Home Assistant 智能家居网关桥接
│   ├── multimodal-ocr/           # 多模态图文与题目识别
│   └── xiaomi-health/            # 小米运动健康数据同步
├── surfaces/                     # 编译期第一方根界面与面板实现
│   ├── companion-ui/             # 桌面常驻桌宠窗口（Live2D、快捷对话与功能坞）
│   ├── workbench-ui/             # 标准与紧凑工作台根界面
│   ├── panels-ui/                # 外观、语音、模型、身份等设置面板
│   └── proactive-ui/             # 思隅·主动陪伴根界面（打字机对话盒与主动建议卡）
├── native/                       # Rust 原生运行时、高性能进程与跨平台协议
│   ├── crates/runtime/           # 原生宿主运行时
│   ├── protocol/                 # 二进制与 IPC 协议定义
│   └── tools/                    # 原生工具链支撑
├── research/                     # 私有研究 workspace（根安装，产品包禁止依赖）
│   └── deletion-fault-testing/   # 固定历史版本的集成适配器与研究依赖
├── docs/                         # Diátaxis 架构全量技术文档
└── scripts/                      # 架构守卫、导入边界检查与持续集成辅助脚本
```

---

## 快速开始

### 准备工具链

项目由 [mise.toml](mise.toml) 严格锁定工具链版本（Node.js 24 LTS、pnpm 11、Vale、markdownlint-cli2）。安装 [mise](https://mise.jdx.dev) 后在仓库根目录执行初始化：

```bash
git clone https://github.com/3yearsZhuang/Aervox-harness.git
cd Aervox-harness
./aervox setup
```

`./aervox setup` 安装锁定的工具链，并在仓库根以 `--no-frozen-lockfile` 重新解析和安装依赖，可能更新 `pnpm-lock.yaml`。日常启动以 `--frozen-lockfile` 检查并安装依赖，失败时保留原错误并退出；仅需按现有锁文件安装时可运行 `mise tasks run install`。

### 运行全栈开发环境

```bash
./aervox dev
```

该命令将在本地同时启动：

* **API 服务**：`http://127.0.0.1:3000`
* **Web 工作台**：`http://127.0.0.1:5173`
* **Electron 桌面端**：桌宠悬浮窗口与宿主容器
* **Worker 进程**：后台持久化队列处理与调度

常用轻量按需启动命令：

```bash
./aervox dev web       # 仅启动 API 与 Web 工作台
./aervox dev desktop   # 仅启动 API 与 Electron 桌面端
./aervox dev cli       # 启动 API 与终端连接版客户端（siyu）
./aervox dev worker    # 仅启动后台任务 Worker 进程
./aervox help          # 查看全部命令与高级选项
```

环境变量参考示例见 [.env.example](.env.example)。

---

## 工程质量与门禁体系

项目采用严格的自检与 CI 质量门禁，禁止直接向 `main` 分支提交或推送变更。所有代码必须通过 AST 级导入边界与架构纯净性检查。

### 常用门禁命令

```bash
./aervox ci             # 本地极速自检（防漂移守卫 + 增量代码测试 + 增量文档检查）
./aervox ci all         # 全量终审门禁（全量类型检查/构建/测试 + 全量文档检查）
./aervox test           # 运行受变更影响的智能增量测试
pnpm run check:boundary # 验证依赖边界（TS AST 解析，遵循 ADR-016 规则矩阵）
pnpm run check:guards   # 运行架构守卫（禁用标识符、领域纯净性、依赖提升与受跟踪文件卫生）
```

### 产物与环境维护

```bash
./aervox clean --dry-run # 预览将被清理的生成物范围
./aervox clean           # 清理构建缓存与生成物（严格保留数据库、本地模型与用户配置）
```

---

## 文档导航

文档遵循 [Diátaxis](https://diataxis.fr/) 架构组织：

* **入门指南**：[从哪开始](docs/getting-started.md)
* **需求与产品标准**：[产品需求 (PRD)](docs/reference/PRD.md) · [系统需求说明 (SRS)](docs/reference/SRS.md) · [需求追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)
* **架构与核心契约**：[系统架构说明书 (SAD)](docs/reference/ARCHITECTURE.md) · [数据库契约](docs/reference/DATABASE.md) · [流式协议](docs/reference/STREAMING_PROTOCOL.md) · [API 约定](docs/reference/API_CONVENTIONS.md)
* **架构决策记录**：[ADR 决策索引](docs/reference/adr/README.md)
* **扩展与开发指南**：[插件与 UI 扩展开发](docs/how-to/develop-plugin-ui-extension.md) · [连接机器人](docs/how-to/connect-bots.md)
* **协作与贡献**：[贡献指南](CONTRIBUTING.md) · [AI 助手协作规则](AGENTS.md) · [当前计划](plan.md)

---

## 开源许可

本项目采用清晰的分层许可机制：

* **独立内核 `packages/core`**：基于 [Apache License 2.0](packages/core/LICENSE) 授权。
* **其余应用、插件与功能包**（`apps/`、`packages/`（除 `core`）、`plugins/`、`surfaces/`、`native/`、`scripts/`）：基于 [AGPL-3.0-or-later](LICENSE) 授权。
* **文档与规范资产**（`docs/`、`README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`plan.md`）：基于 [CC BY-NC-SA 4.0](docs/LICENSE) 授权。
