---
id: AVX-DOC-002
---

# 从哪开始

<a id="AVX-TUT-001"></a>

本页带你完成安装、启动和首次对话。协作规则见[贡献指南](../CONTRIBUTING.md)，任务相关契约从[文档导航](README.md)进入。

<a id="avx-tut-001"></a>

## 1. 准备工具链

先按 [mise 安装指南](https://mise.jdx.dev/getting-started.html)安装 mise；macOS 也可用 `brew install mise`。然后克隆仓库，在仓库根完成首次初始化：

```bash
git clone https://github.com/3yearsZhuang/Aervox-harness.git
cd Aervox-harness
./aervox setup
```

工具版本由 [mise.toml](../mise.toml) 锁定。`./aervox setup` 先执行 `mise install`，再以 `pnpm install --no-frozen-lockfile` 重新解析和安装依赖，因此可能更新 `pnpm-lock.yaml`。

日常按已有锁文件安装依赖，在仓库根运行：

```bash
mise tasks run install
```

该任务使用 `--frozen-lockfile`；`./aervox dev` 各目标也会先按锁文件检查和安装依赖，失败时保留原错误并退出。需要重新解析依赖时再显式运行 `./aervox setup`，不要在子包重复安装。

外部 `reference/` 子模块是设计输入，默认构建无需全部拉取；阅读参考代码或运行要求真实适配库的专项测试时再按需初始化。安装依赖和启动服务都不会自动下载或安装大语言模型。

## 2. 配置与启动

### 2.1 先用 Web 工作台体验

```bash
./aervox dev web
```

保持终端运行，检查 API 与 Web 的启动结果，然后打开 [Web 工作台](http://127.0.0.1:5173)。API 默认地址为 `http://127.0.0.1:3000`；实际监听地址以终端输出为准。

`dev web` 不启动 Worker。普通对话默认由 API 执行；异步复习、日记等后台任务需要 Worker，可在另一个仓库根终端运行 `./aervox dev worker`。

需要桌宠与完整后台服务时，停止当前开发服务后运行 `./aervox dev`，其默认目标是 `full`。各目标的范围由 [aervox 脚本](../aervox)定义：

| 命令 | 启动范围 |
|---|---|
| `./aervox dev` / `./aervox dev full` | API、Worker、Web 与 Electron 桌面端 |
| `./aervox dev web` | API 与 Web 工作台 |
| `./aervox dev desktop` | API 与 Electron 桌面端 |
| `./aervox dev cli` | API 与终端连接版客户端（`siyu chat`）；可复用已运行的 API |
| `./aervox dev worker` | 仅 Worker 后台任务进程 |
| `./aervox dev api` | 仅 API |

`desktop` 和 `cli` 也不启动 Worker。完整命令与选项用 `./aervox help` 查看。

### 2.2 连接模型服务

在工作台打开“设置”→“模型服务”→“连接配置”，开启“启用大模型服务”，按已准备好的服务填写：

| 字段 | 如何填写 |
|---|---|
| 模型供应商 | 选择对应供应商或自定义兼容端点；选择预设后仍需核对实际服务参数 |
| 服务基址（Base URL） | 填服务的 API 基址；OpenAI 兼容服务通常以 `/v1` 结尾，如 `http://127.0.0.1:11434/v1` |
| 模型名称（Model ID） | 填该服务实际提供的模型标识，预设推荐值不代表模型已经安装或可用 |
| API Key | 填供应商要求的密钥；无需鉴权的本地服务可留空 |

远程服务需要已有账号、可用模型与访问凭据；本地服务需要先准备模型并启动推理服务，也可在“模型服务”→“本地模型”管理模型。仅填写地址不会安装模型。

点击“测试连接”，根据结果修正配置；如果检测到模型列表，选择你实际要使用的模型。随后点击“保存配置”，确认保存成功。连接测试使用当前草稿，不能代替保存；测试成功也需要通过下一步真实对话验证完整链路。

桌面首次引导也提供相同连接字段，可先测试，再“保存并进入思隅”。跳过模型配置后仍需在设置中完成配置才能验证真实模型对话。

### 2.3 按需调整连接参数

默认本地地址即可开始上述流程。需要调整端口、认证或客户端连接时，参考 [.env.example](../.env.example)，在仓库根 `.env` 中设置所需键并重启服务。桌面参数 `AERVOX_API_URL` 指向 API，`AERVOX_SESSION_ID` 若设置则应指向已有会话；Web 使用 `VITE_API_URL` 与 `VITE_SESSION_ID`。开启 Token 认证时也要配置对应客户端凭据。

## 3. 发起第一条对话

回到工作台，新建或选择一个会话，输入“你好，请介绍一下你能怎样帮助我学习”并发送。确认消息成功提交、回复逐步出现并正常结束；再发一条消息，在生成过程中点击停止，检查取消是否生效。

收到真实模型回复才完成首次对话验证。服务启动成功、配置保存成功或连接测试成功，都不能单独证明真实对话已通过。协议入口是创建 Turn 后消费其事件流，细节见[流式协议](reference/STREAMING_PROTOCOL.md)；复习、日记等异步任务还需查看 Worker 日志与任务结果。

遇到问题时先保留终端中的原始错误，再按下表检查：

| 现象 | 检查 |
|---|---|
| 依赖安装失败 | 查看网络与锁文件错误；日常安装保持 frozen，确需重新解析时才运行 `./aervox setup` |
| 端口被占用 | 停止自己启动的冲突进程，或按配置选择可用端口 |
| 连接测试失败或发消息无回复 | 核对模型服务已启动、Base URL、Model ID、API Key、服务启用与配置保存状态，再看 API 错误日志 |
| Web 无法连接 API | 核对 API 实际监听地址、`VITE_API_URL` 与认证配置 |
| 桌面无法连接 | 核对 API 地址、会话是否存在及 Token 配置 |
| 复习或日记未处理 | 确认 Worker 已启动；`dev web` / `desktop` / `cli` 都不会自动启动它，再检查任务日志 |
| 跨包导入出现 TS2307 | 先完成依赖安装及相关包的拓扑构建，不在子包重复安装 |
| 缺少原生制品 | 按[原生组件操作](how-to/run-native-components.md)构建；区分开发合同与平台实机验收 |

## 4. 继续开发

- 了解产品与行为：[PRD](reference/PRD.md)、[SRS](reference/SRS.md)。
- 了解组件关系：[架构](reference/ARCHITECTURE.md)、[数据流](explanation/data-flow-overview.md)。
- 开发插件或工具：[扩展指南](how-to/develop-plugin-ui-extension.md)。
- 清理构建产物与缓存：[运行手册](reference/operations.md#13-生成物与缓存清理)。
- 处理迭代依赖：[当前计划](../plan.md)；提交和检查：[贡献指南](../CONTRIBUTING.md#validation)。

<a id="7-常用开发环境变量"></a>

数据库路径与数据目录规则见[数据库契约](reference/DATABASE.md#3-本地存储拓扑)，不在入门页复制默认值表。
