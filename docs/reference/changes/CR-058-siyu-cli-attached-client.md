---
id: CR-058
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.2.0
updated_at: 2026-09-29
reviewed_at: 2026-09-29
review_interval_days: 90
sources:
  - plan.md
  - docs/reference/PRD.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/STREAMING_PROTOCOL.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-058 思隅 CLI 连接版首个实施切片

- 提出人：3yearszhuang · 2026-09-29
- 修改人：3yearszhuang · 2026-09-29

## 1. 授权与范围

2026-09-29 用户在完成 CLI 规划后明确要求“新开分支开始落地 CLI 的具体实现”。本 CR 承接[计划 §7](../../../plan.md#siyu-cli-delivery-plan)，固定 ITER-030/031 首个连接版切片；实施分支为 `feat/siyu-cli`，基于 `0478053` 并保留 CLI 规划。CR-057 已由并行能力规划占用，本提案使用后续编号。

接受范围为新增终端表现宿主与共享传输适配，复用现有 API 和单用户 SQLite 权威。独立宿主、数据库迁移、后台主管、第三方执行插件及新增学习/记忆命令仍按后续条目认领。本切片不修改服务端路由、授权和恢复合同，也不通过客户端绕过已有缺口。实施记录和待补证据见[§4.2](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，不等同于发布。

## 2. 接口与产品行为

新增 `apps/cli`（`@aervox/cli`），二进制命令为 `siyu`，Node.js 24+。运行形态固定为连接本机服务，仅接受 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP(S) 根地址；拒绝 URL 凭据、路径、查询参数及重定向。不会因连接失败启动另一宿主或更换模型/数据根。

| 命令 | 首片行为 |
|---|---|
| `ask` | 参数文本、`--file` 或 stdin 单次提问；显式文本优先于 stdin，文件与参数互斥；默认新会话，`--session` 续用指定会话 |
| `chat` | 仅 TTY 连续对话，同一会话内逐轮提交；`/help` 帮助、`/session` 当前会话/上一回合标识、`/new` 切换新会话并保留旧会话、`/exit` 或 `/quit` 退出；Tab 补全命令、行末反斜杠继续多行输入；机器输出可选 JSONL，拒绝单对象 JSON |
| `sessions list` | 读取最近 100 个会话；失败明确返回，不生成虚拟会话 |
| `events <turnId>` | 补读服务器的公开事件并等待终态；不创建回合或重复提交审批/答案 |
| `status <turnId>` | 沿用既有 SSE 查询终态，不输出正文；若尚未终态则等待至限时并明确报告未知，不冒充瞬时状态查询接口 |
| `doctor` | 检查所配地址、认证与会话接口；不宣称已验证真实模型或完整版本兼容 |
| `config show/set` | 仅查看或保存 `apiBase`、`sessionId`；不保存或打印 Token |

地址及会话配置优先级：命令参数 → `SIYU_API_URL`/`SIYU_SESSION_ID` → 用户配置 → 默认值。默认 API 为 `http://127.0.0.1:3000`；配置位于 `XDG_CONFIG_HOME/aervox/cli.json`，未设置时使用用户目录 `.config/aervox/cli.json`，可通过 `SIYU_CONFIG_FILE` 显式覆盖。不读取当前目录配置。Token 只由 `SIYU_API_TOKEN` 注入普通请求、SSE、审批和传输层附件请求；本切片不提供附件命令。

本地 `.last-run` 回执仅保存 API 地址、sessionId、requestId 和收到的 turnId，不保存正文或模型密钥，不是第二套业务真源。文件原子替换，创建权限为目录 0700、文件 0600。每次提交前保存并报告幂等键；`--request-id` 必须同时明确 `--session`，仅供用户对同一会话、同一问题显式重试，客户端不自动重发已受理结果未知的请求。参数或服务变化时应使用新键；服务端幂等冲突处理仍是现行合同的责任。

2026-09-29 用户进一步要求参考 Claude Code 改善终端呈现。交互行为参考[官方交互说明](https://code.claude.com/docs/en/interactive-mode)，未移植其源码。对话内命令在本地处理，不进入模型上下文；未知斜杠命令显示帮助提示，以 `//` 开头可发送字面量 `/`。多行输入合为单轮后统一校验 64 KiB 限额；输入历史只保留在当前进程。`/session` 显示当前客户端已知的恢复标识，不冒充服务端会话详情接口。

## 3. 输出、控制与审批

非交互 stdout 仅承载正文、单个最终 JSON 或逐行 JSONL；诊断、会话标识和交互提示走 stderr。文本 `chat` 仅在 stdout/stderr 均为 TTY 时启用欢迎区、输入分隔、回答角色与发送/等待进度；成功显示真实终态和耗时，内部标识由 `/session` 查看，失败仍给出恢复标识。`NO_COLOR` 关闭呈现颜色，`TERM=dumb` 关闭呈现颜色和进度动画。正文始终过滤终端控制字符，只有客户端拥有的装饰和进度行可生成 ANSI；动画在流式正文、审批、完成和退出前清理。

机器输出带 `version: 1`；JSONL 只输出客户端声明的 submitted/accepted/delta/needs_approval/result 字段（delta 保留 Turn、事件 ID 与序号），不转发完整工具或内部事件。单次输入上限 64 KiB、正文累计上限 2 MiB、SSE 单事件上限 1 MiB；慢输出等待 drain，消费者断管或取消时结束等待。

总超时默认 120 秒，参数范围 1～600 秒；HTTP 请求最多 30 秒，SSE 空闲最多 60 秒，均受总截止约束。普通历史重开、流内游标补读及 Attempt 自动恢复分别处理；本切片不提供自动恢复。Ctrl-C/SIGTERM 停止显示和后续交互，已知本次受理的 turnId 时尝试服务端取消，限时 3 秒；请求取消和确认终态分开报告。单纯查看旧事件或状态不会取消原任务。

| 退出码 | 含义 |
|---|---|
| 0 | 权威 Completed 且没有未完成审批，或查询/配置操作成功 |
| 1 | 服务、协议、模型终态、输出限额或连接失败 |
| 2 | 用法、地址、配置、标识或输入错误 |
| 3 | 认证/授权 HTTP 401/403 |
| 4 | 需要用户交互、写审批未完成，或仅记录审批而未证明工具执行 |
| 5 | 超时或未能确认执行结果 |
| 130 / 143 | SIGINT / SIGTERM；另报告取消是否已请求，不能由退出码推断服务端已终止 |

TTY 写审批展示工具和公开参数指纹，显式 `[y/N]` 后向服务端提交决定。现行服务端批准不保证当前 Attempt 续执行，因此 CLI 不自动重发原问题，并以 `approval_recorded`/非零结果区分“批准已记录”和“任务已完成”。非 TTY 一律不自动批准。用户问题在 TTY 收集答案并调用既有回答端点；非 TTY 有界返回需要交互。工具版本、权限、撤权、删除及 local-only 仍由受信服务端判定。

## 4. 实现边界与兼容

`packages/api-client/transport` 增加纯传输构建出口，根 Vue composables 出口保持。新增配置、回调、信号、幂等键均可选，原调用不要求迁移；`watchTurn` 和 `cancelTurn` 仅由 Fetch 传输扩展接口提供，不强制改 Electron IPC。CLI 复用投影顺序与去重，在事件消费者完成后才继续消费，保留游标重连；只有权威 Completed 可报提问成功。

底座依赖门禁将 CLI 纳入宿主枚举，阻止共享包和能力层反向引用。CLI 使用根目录管理的 esbuild 生成含共享传输代码的 ESM 文件，运行时不依赖 Vue、API、数据库或工作区包。开发依赖与分发闭包分开，安装验收必须从打包产物执行，不能由仓库源码启动代替。

首片开发预览支持本次实际验收的 macOS arm64 + Node.js 24；Windows/Linux 留给后续平台验证。API 兼容基线为本分支服务端 `0478053` 与未修改的 HTTP/SSE 合同，当前没有独立版本握手端点；`doctor` 仅报告连接与会话接口兼容，不能证明任意版本兼容。跨平台、真实供应商工具往返、完整 CLI/API 版本矩阵和生产签名/分发未补证前保持发布门禁；包不发布到公共注册表。

## 5. 验证、剩余差量与回滚

验证共享客户端认证/信号/幂等/事件背压与重连，CLI 真实 HTTP 测试覆盖 JSON/管道/终态失败/交互拒绝/取消/回执/控制字符/配置和超额输入；安装产物检查帮助及实际请求。另用真实 API 与临时 SQLite 验证持久事件闭环；真实 Provider 需要独立运行并保留证据，模拟回归不替代该门槛。

2026-09-29 补充本机真实 DeepSeek 答疑、跨 CLI 进程续会话、会话列表及已完成回合的终态/正文补读验证，TTY 交互入口已启动；详细结果见[§4.2](../REQUIREMENTS_TRACEABILITY.md#cli-attached-20260929)。这只覆盖真实模型问答，不替代工具往返或故障恢复验收。

ITER-031 的剩余部分包括完整会话详情/分页、模型配置入口、跨进程恢复查询、真实 Provider 工具往返及完整平台/版本兼容。首片通过不将整条 ITER-031 或后续发布条目标为已移交。用户文档、架构包拓扑、队列、§4.2、索引与注册表随实现同步；最终测试结果只在实际执行后登记。

回滚可移除 CLI 制品并继续使用既有入口；共享传输新增字段可选，回退后原客户端仍按旧接口工作。没有数据 Schema 或服务端写入合同变更，卸载保留配置回执及业务数据；回执不用于重建或覆盖业务库。
