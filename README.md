<h1 align="center"><img src="packages/ui/src/assets/brand/aervox-app-icon.svg" width="80" height="80" alt="思隅标识"><br>Aervox｜思隅</h1>

<div align="center">

**属于你的贾维斯，或者属于你的爱弥斯。**

一个记得你、关心当下，并在你的授权下主动提供帮助的个人助手。

![思隅：记得你在意的事，在合适的时候出现，把想法变成行动](docs/assets/readme/hero.svg)

[![技术栈：TypeScript、Vue、Electron、Node.js、Rust、SQLite](https://skillicons.dev/icons?i=ts,vue,electron,nodejs,rust,sqlite)](docs/reference/ARCHITECTURE.md)

[开始体验](docs/getting-started.md) · [文档导航](docs/README.md) · [参与贡献](CONTRIBUTING.md)

</div>

思隅是面向生活、工作与学习的主动智能个人助手：接续对话、整理记忆与每日记录，通过工具和插件帮你处理任务，也以喜欢的角色陪在身边。学习与复习是其中一项能力。

**开发者预览** · 连续对话、记忆、日记与工具扩展已有实现；全域感知、家居与健康连接仍在完善和验收。能力与发布状态见[需求追踪](docs/reference/REQUIREMENTS_TRACEABILITY.md)，升级前请备份本地数据。

## 看看思隅

<a id="工作台把对话和学习放在一起"></a>

### 桌面端：留一隅给陪伴，随时处理手边的事

![思隅桌面工作台：左侧 Live2D 角色，右上轻量工具卡片，底部台词框与独立输入栏](docs/assets/readme/workbench.webp)

大角色、轻量工具卡片、台词框与独立输入栏，让交流保持轻松。继续上次的事、回看对话或调用工具；回复逐步显示，可随时停止并查看运行详情。

桌面默认使用这套“桌宠陪伴”布局；需要侧栏多会话时，可切换到“标准工作台”。[界面切换说明](docs/getting-started.md#21-先用-web-工作台体验)

<a id="主动陪伴从一句问候开始"></a>

### 移动端：从一句问候开始

<img src="docs/assets/readme/proactive-companion.webp" width="390" alt="思隅移动端：角色、打字机对话盒、建议卡与悄悄话输入">

手机和平板默认使用更简洁的主动陪伴界面：接续最近会话、发起专注请求，或展开“悄悄话”提问。顶部可打开设置或返回完整工作台，回复过程中可停止生成。

建议目前来自最近会话与固定动作。截图使用独立演示数据与确定性回复回放，不代表真实模型效果；Live2D 来源与许可见[模型说明](packages/live2d/mizuki/README.md)。原生移动应用仍待发布验收，详见[需求追踪](docs/reference/REQUIREMENTS_TRACEABILITY.md#mobile-decisions)。

## 可以做什么

| 你想做的事 | 思隅的帮助 |
|---|---|
| 接着聊，接着做 | 在工作台、桌宠或终端连接版接续本机服务中的会话，沿用人格与配置 |
| 记住在意的事 | 整理会话记忆与每日复盘，保留来源、纠错和数据管理入口 |
| 把想法变成行动 | 按需启用插件、Skill 与 MCP 工具，通过审批管理需要授权的操作 |
| 在合适的时候得到提醒 | 按已配置的排期，由后台 Worker 处理到期复习与日记；更广泛的主动建议与生活连接持续演进 |
| 学会新东西 | 通过学习插件获得引导、练习、反馈与后续复习 |

以上为已有实现的概览，完整验收状态与剩余限制见[需求追踪](docs/reference/REQUIREMENTS_TRACEABILITY.md)。

## 快速开始

先安装 [mise](https://mise.jdx.dev/getting-started.html)，再在仓库根运行：

```bash
git clone https://github.com/3yearsZhuang/Aervox-harness.git
cd Aervox-harness
./aervox setup
./aervox dev web
```

打开 [Web 工作台](http://127.0.0.1:5173)，进入“设置 → 模型服务”，启用服务并填写供应商、Base URL、Model ID 和必要的 API Key。点击“测试连接”并“保存配置”，即可发起第一条对话。

先准备可用的本地或远程模型服务；安装项目不会自动安装模型。配置步骤与安装细节见[完整入门指南](docs/getting-started.md)。

安装会初始化必需的 `packages/core` 子模块，其源码独立维护于 [Aervox-agent/Aervox-core](https://github.com/Aervox-agent/Aervox-core)，主仓固定到确定提交。其他 `reference/` 仓库按需拉取。

浏览器体验启动 API 与 Web。要同时运行桌宠和处理复习、日记的后台 Worker，停止当前开发服务后运行：

```bash
./aervox dev
```

终端连接版、单独启动 Worker、端口配置与排错见[入门指南](docs/getting-started.md#2-配置与启动)。

## 同一本机服务，多种入口

```mermaid
flowchart LR
    UI[桌宠 / 工作台 / CLI] --> API[本机 API 与 Agent]
    API --> Model[模型服务：本地或远程]
    API --> Tools[工具与插件]
    API --> DB[(本地 SQLite)]
    Worker[后台 Worker] --> DB
```

个人记录以本地 SQLite 为真源；模型调用是否出网取决于服务配置。技术细节见[架构说明](docs/reference/ARCHITECTURE.md)。

## 继续了解

| 想了解什么 | 从这里开始 |
|---|---|
| 安装、配置与首次对话 | [入门指南](docs/getting-started.md) |
| 产品目标、功能与数据责任 | [文档导航](docs/README.md) |
| 模块关系与 Agent 内核 | [架构说明](docs/reference/ARCHITECTURE.md) |
| 开发插件、Page 或 UI 扩展 | [扩展指南](docs/how-to/develop-plugin-ui-extension.md) |
| 提交贡献与运行检查 | [贡献指南](CONTRIBUTING.md) |
| 当前进展与后续安排 | [当前计划](plan.md) · [需求追踪](docs/reference/REQUIREMENTS_TRACEABILITY.md) |

## 许可

独立内核 `packages/core` 使用 [Apache-2.0](packages/core/LICENSE)，其余主仓源码使用 [AGPL-3.0-or-later](LICENSE)，文档使用 [CC BY-NC-SA 4.0](docs/LICENSE)。第三方资源遵循各自许可与来源声明。
