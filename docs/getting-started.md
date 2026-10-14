---
id: AVX-DOC-002
---

# 从哪开始

<a id="AVX-TUT-001"></a>

本页带你完成安装、启动和首次对话。协作规则见[贡献指南](../CONTRIBUTING.md)，任务相关契约从[文档导航](README.md)进入。

<a id="avx-tut-001"></a>

## 1. 准备工具链

安装 mise 后，在仓库根运行：

```bash
./aervox setup
```

工具版本由 [mise.toml](../mise.toml) 锁定。外部 `reference/` 子模块是设计输入，默认构建无需全部拉取；阅读参考代码或运行要求真实适配库的专项测试时再按需初始化。

## 2. 配置与启动

按根 [README](../README.md) 的启动说明配置模型和会话，可配置键见 [.env.example](../.env.example)。桌面连接参数 `AERVOX_API_URL` 指向本地 API，`AERVOX_SESSION_ID` 指向已有会话；不要把未配置模型造成的失败解释为对话已验证。

```bash
./aervox dev
```

该命令启动 API、Worker、Web 和桌面端。只需要浏览器时用 `./aervox dev web`，API 默认地址为 `http://127.0.0.1:3000`，Web 为 `http://127.0.0.1:5173`。检查终端中的监听及 Worker 启动结果。

## 3. 发起第一条对话

在工作台输入“你好”并发送，检查流式回复与取消。模型连接失败时先查看 API 的错误信息和配置。协议入口是创建 Turn 后消费其事件流，细节见[流式协议](reference/STREAMING_PROTOCOL.md)；Worker 的投递状态由其日志提供。

| 现象 | 检查 |
|---|---|
| 端口被占用 | 停止自己启动的冲突进程，或按配置选择可用端口 |
| 桌面无法连接 | 核对 API 地址、会话是否存在及 Token 配置 |
| 跨包导入出现 TS2307 | 先完成依赖安装及相关包的拓扑构建，不在子包重复安装 |
| 缺少原生制品 | 按[原生组件操作](how-to/run-native-components.md)构建；区分开发合同与平台实机验收 |

## 4. 继续开发

- 了解产品与行为：[PRD](reference/PRD.md)、[SRS](reference/SRS.md)。
- 了解组件关系：[架构](reference/ARCHITECTURE.md)、[数据流](explanation/data-flow-overview.md)。
- 开发插件或工具：[扩展指南](how-to/develop-plugin-ui-extension.md)。
- 处理迭代依赖：[当前计划](../plan.md)；提交和检查：[贡献指南](../CONTRIBUTING.md#validation)。

<a id="7-常用开发环境变量"></a>

数据库路径与数据目录规则见[数据库契约](reference/DATABASE.md#3-本地存储拓扑)，不在入门页复制默认值表。
