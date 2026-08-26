# 教程：构建并运行你的第一个对话

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

> 文档编号：AVX-TUT-001
> 类型：Tutorials
> 版本：v0.1
> 更新日期：2026-08-25
> 状态：Review Candidate
> 关联：[从哪开始](../getting-started.md)、[流式协议契约](../reference/STREAMING_PROTOCOL.md)

本教程面向首次接触仓库的新成员：从一次干净 clone 起，把 API、Worker 与桌面/Web 客户端跑起来，并发出第一条对话。它是 [从哪开始](../getting-started.md) 的可执行版本，本页只讲步骤，规则细节以各专项文档为准。

## 前置条件

- 一台可联网的开发机，命令按 macOS/Linux 给出；
- 已安装 mise（Node 24 / pnpm 11 由 [mise.toml](../../mise.toml) 锁定）。

## 第 1 步 · 拉取仓库与子模块

```bash
git clone <你的仓库地址> aervox-harness
cd aervox-harness
git submodule update --init --recursive
```

验证：`git submodule status` 无报错。子模块缺失会导致 `pnpm build` 缺 `@aervox/mod-*` 失败（见 [可选模块协作指南](../how-to/submodule-collaboration.md)）。

## 第 2 步 · 安装工具链与依赖

```bash
./aervox setup
```

该命令完成 mise 解析与依赖安装（lockfile 一致时自动跳过）。

验证：`mise tasks run ci-code` 可跑通（可选，包含 build + typecheck + test，较慢）。

## 第 3 步 · 启动开发栈

```bash
./aervox dev                 # 全栈：API(:3000) + Web(:5173) + Desktop + Worker
```

只需部分组件时可用变体（如 `./aervox dev web` 仅 API + Web，desktop / worker / api 同理）。

验证：终端出现 API 监听与 Worker 首轮 tick 日志。

## 第 4 步 · 发起第一条对话

- 桌面端：打开桌宠窗口，输入"你好"并发送，应看到逐句流式回复；
- Web 端：打开 `http://127.0.0.1:5173` 后同样发消息。

> 桌面端需要 `AERVOX_API_URL='http://127.0.0.1:3000'` 与 `AERVOX_SESSION_ID='<现有会话 ID>'`；会话 ID 必须指向 API 有权访问的会话（见 [README 快速开始](../../README.md#快速开始)）。

## 第 5 步 · 验证（可选，CLI 视角）

消息发出后，服务端按 [流式协议契约](../reference/STREAMING_PROTOCOL.md) 工作：

1. API 幂等创建 Turn：`POST /v1/sessions/{sessionId}/turns`；
2. 返回 `eventsUrl` 与 `cancelUrl`，其中 eventsUrl 形如 `/v1/turns/{turnId}/events`；
3. 拉取事件流（等价命令见下）；
4. 观察 Worker 终端：应看到形如 `[worker:...] outbox=N ...` 的投递计数增长。

拉取事件流的等价命令：

```bash
curl -N http://127.0.0.1:3000/v1/turns/<turnId>/events
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 端口被占用 | 换端口，或 `./aervox dev api` 单独起 API |
| 子模块缺失导致 build 失败 | 回到第 1 步补齐 `git submodule update --init --recursive` |
| 桌面端无法连接 | 确认 `AERVOX_API_URL` 指向 :3000 且会话 ID 有效 |

## 下一步

- 按 [从哪开始](../getting-started.md) 的阅读顺序浏览；
- 想理解消息端到端如何流转，见 [数据流总览](../explanation/data-flow-overview.md)；
- 写文档前先过一遍 [文档写作规范](../reference/standards/doc-standards.md)。
