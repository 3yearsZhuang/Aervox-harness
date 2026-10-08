---
id: CR-057
type: reference
scope: change
owner: platform
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.3.0
updated_at: 2026-10-05
reviewed_at: 2026-10-05
review_interval_days: 14
review_triggers:
  - scripts/hls-agent/**
  - scripts/hls-agent.test.mjs
  - packages/core/**
sources:
  - docs/explanation/hls-agent-competition-plan.md
  - docs/reference/agent-harness-loop.md
  - docs/reference/capability-composition.md
  - plan.md
---

# CR-057 实施 HLS 本地智能体验证执行器

- 提出人：3yearszhuang · 2026-09-29
- 修改人：3yearszhuang · 2026-10-05

关联：[HLS 规划](../../explanation/hls-agent-competition-plan.md) · [ITER-021](../../../plan.md#iter-021) · [执行规范](../agent-harness-loop.md) · [实现登记](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)

## 1. 授权、基线与范围

2026-09-29 用户明确要求实施 HLS 规划，并确认 GPU/Vitis 环境尚未配置。本 CR 接受该授权范围内的独立研究执行器、协议修复和可复现实验基础设施；正式比赛提交、采购、微调及产品化继续按规划的条件门槛决定。源码基线为 `dd5afcc`，现有 Headless 内核已经可独立调用，不再重复搭建 API 或数据库。

实现位于 `scripts/hls-agent/`，作为主仓内核的研究验证消费者，不注册新的可选业务 CAP，也不宣称已完成可选模块交付。若后续产品化，仍按能力组合规范采用独立子仓及 `modules/*`。本轮不改变 API、数据库或默认产品启动路径。

## 2. 差量与执行合同

- 修复 Loop 的 assistant 工具调用历史，保留每个调用的 ID、名称、参数和该步骤的推理内容，使下一轮与 tool 结果配对；兼容 Provider 无跨请求共享历史。
- 命令行提供环境诊断、单题 Agent/裸跑、批量对照和证据汇总。裸跑只发题目一次；Agent 注入固定工具与实验性技能。两者共用模型参数，禁用隐式模型重试。
- 模型服务仅接受回环地址并拒绝重定向；SSH 环境通过用户配置的本地端口转发连接。配置不包含明文凭据，日志不写入授权头。
- Vitis 只通过显式指定且本地已存在的容器镜像运行；禁网、只读根目录、最小挂载、资源上限和强制清理。生成代码不在宿主执行；公开测试只读挂载，私有评分器与参考实现不进入容器。
- 本地 Vitis 适配以 C 仿真和综合验证为开发证据，不假装已实现赛事未公布的完整四级评分接口。真实官方评分与私有测试继续由外部评测系统持有。
- 每题和每次样本独立目录、截止时间与执行状态；保存模型调用、候选、工具报告、配置哈希及最终结果。失败、超时、缺失结果均计入分母。
- 配置的数值为内部开发预算。上下文使用保守字节预算，实际 token 用量只有服务返回时才记录，不能把字节计数冒充 token。

## 3. 验收与去留

首轮验证必须覆盖：裸跑一次且无工具/技能；真实 HTTP 协议下多轮调用配对；有界失败/取消；候选不重复验证；原始证据写盘；测试夹具只读、无私有路径挂载；批跑独立样本与配对统计；缺少 Vitis/模型时明确报告环境不可用。模拟 HTTP/EDA 只验证合同，结果必须带模拟标识，不能成为真实 HLS 通过率或正增益证据。

P0/P1/P2 的真模型、真实 Vitis、最终 GPU、留出题集和官方环境验收仍需用户配置环境后完成；在这些证据缺席时 ITER-021 不能标为整项已移交，ITER-022 不自动启动。

## 4. 回滚与交付记录

研究执行器不接入默认应用启动；可停止相关命令并回退脚本，实验产物保留在指定输出目录。协议修复通过独立回归保护既有调用；回退代码不更改用户数据库。每个可验证切片完成后立即同步本节、规划、§4.2 和队列，并执行文档门禁。

2026-09-29 本地实现切片：`scripts/hls-agent/` 包含配置校验、诊断、双入口、Loop 消费者、Vitis 容器适配、候选与事件证据、四组对照和汇总。新增源码不依赖 API、数据库或新的第三方包。`packages/agent-loop` 补齐多工具历史、逐消息推理字段、可选采样种子及原始流字节上限。`mise tasks run hls-check` 接入增量与全量代码门禁。

已验证：依赖拓扑构建通过；`scripts/hls-agent.test.mjs` 14/14；Agent Loop 31 个文件、206/206；HTTP 测试使用真实回环服务校验请求体，EDA 使用显式 `simulated` 适配，不启动 Vitis。覆盖一次裸跑、多调用配对、修复/重复候选、保留已验证代码、C1 无反馈独立生成、流截断、进程超时/取消/日志上限、Docker 参数/强制清理、无综合报告拒绝通过、固定分母与证据混用拒绝。

真实环境诊断：2026-09-29 在 Darwin arm64 主机运行示例配置，Docker 服务 29.3.0 可用；回环模型不可达，`eda.image` 未配置；退出码 2、`ready=false` 符合预期。尚无 GPU 或真实 EDA 运行证据。API、数据库、默认应用启动和业务 CAP 合同复核无变化。

补充验证：运行时清单记录研究脚本与已构建内核、Contracts、依赖锁文件、工具链配置的文件哈希及 Node 版本；汇总拒绝跨运行时混算。新增独立 `pass@5` 计数、正在执行的 EDA 取消排空与进程树清理回归。子进程测试通过启动握手后再取消，避免把繁忙主机的启动延迟误判为清理失败。兼容 Provider 的非成功 HTTP 响应同样限制读取长度，避免错误正文无限增长。

最终本地门禁：`./aervox ci` 通过（增量选择器因共享输入命中全仓，构建/类型检查 33/33、测试任务 27/27）；其中 API 485、Repositories 270、Agent Loop 206、Host 90 项通过，Host 的 2 项真实模型/库环境测试按既有条件跳过，HLS 合同 14/14。`mise tasks run ci-docs` 全量通过，文档治理 33、队列 9 项通过，82 个 Markdown 文件排版/术语无问题；保留已有 ITER-005/004 的 S5 次序提示。固定版本 DSH 参考子模块已初始化以完成既有回归，未修改其版本或构建真实模型适配库。`docs-triggers` 的本次协议命中已由执行规范、本 CR、规划和 §4.2 覆盖；其余来自基础分支的数据库/产品/移动端差量没有在此重复实施。

2026-10-05 内核迁移与合流：研究执行器自 `feat/hls-local-agent` 工作树整体移植到基于 main（`a94c72b6`）的功能分支；内核协议修复随之迁入 `@aervox/core`（ADR-021 独立内核包，原 `packages/agent-loop` 已由 ITER-037 移除）：多工具 `tool_calls` 历史逐项配对、`reasoning` 改由每条 assistant 历史持有（Provider 不再跨请求共享推理状态）、可选采样种子 `seed`、原始流字节上限 `maxResponseBytes` 与错误正文 200 字节截断。运行时清单与 `check:hls` 的构建过滤由 agent-loop/contracts 改指 `packages/core/dist`。原规划新增的产品化候选因 ITER-029 编号已被 CLI 条目占用，重登记为 ITER-043。验证：`packages/core` 40 文件 270/270（含逐消息推理隔离与错误正文截断 2 项新增回归）；`scripts/hls-agent.test.mjs` 14/14；`mise tasks run hls-check` 通过。真实 GPU/Vitis、官方评分与留出集增益差量保持不变。

剩余差量：官方入口 ABI 与评分器、目标环境断网复现、许可与容器兼容、实际资源峰值、独立留出题及统计增益。容器的 CPU/内存/进程数有上限，宿主产物目录尚无磁盘配额；真实环境需配置专用有配额文件系统。实验产物为本地公开题与模型输出，未实现加密存储、跨进程续跑或防人为篡改账本；强制退出后由批次清单保留缺失样本，重新运行必须使用新目录。当前报告不能作为正式赛分或产品发布结论。

## 5. 运行路径与环境接力

在此功能分支工作树根目录执行，使用 `mise.toml` 的 Node / pnpm。实现不要求启动 Aervox 桌面端或 API。

```sh
mise exec -- pnpm install --frozen-lockfile
mise tasks run hls-check
mise tasks run hls-agent -- doctor scripts/hls-agent/examples/config.json
```

1. 环境负责人先复制示例配置到工作树外，填写真实模型 ID、模型摘要、量化格式、服务上下文容量及本地已有的 Vitis 2025.2 镜像。显卡或云主机未配置时，先保留诊断失败证据。模型仅通过回环兼容端点访问；云端模型需由团队显式建立 SSH 本地端口转发。执行器不处理密码、密钥或云账号。
2. HLS 负责人核对 `examples/vector-add.json` 的公开题格式，再准备开发题与按家族隔离的留出题 JSON 数组。字段仅允许 ID、家族、划分、题目、顶层函数及公开测试源码，不能传入私有测试或参考实现。当前参考样例只有向量加法，不能据此评估泛化。
3. Agent 负责人运行下面的单题与批次命令。`run.sh` 固定 A2，`run_baseline.sh` 固定 B0；两者调用同一配置与兼容 Provider。批次在同一进程按任务/样本轮换四组顺序；每次生成有独立上下文，内部修复不增加独立样本数。

```sh
scripts/hls-agent/run_baseline.sh /absolute/config.json scripts/hls-agent/examples/vector-add.json /absolute/results/b0-001
scripts/hls-agent/run.sh /absolute/config.json scripts/hls-agent/examples/vector-add.json /absolute/results/a2-001
mise tasks run hls-agent -- batch /absolute/config.json /absolute/tasks.json /absolute/results/batch-001
mise tasks run hls-agent -- report /absolute/results/batch-001
```

输出目录的父目录需先存在；每次 OUT 必须未占用，禁止覆盖旧结果。CLI 在实际运行前复核模型列表、Docker 及 Vitis 版本，将镜像标签解析为内容摘要。诊断通过只代表这些探针通过；模型量化、GPU、上下文配置与官方环境仍需独立核验。

### 5.1 产物与指标口径

| 产物 | 用途 |
|---|---|
| `metadata.json`、`task.public.json`、`inventory.json` | 单次配置/题目/技能与运行时代码哈希、目标与环境探针；批次环境在 `manifest.json` |
| `events.jsonl`、`loop-events.json` | 逐次模型请求、返回、工具摘要及 Loop 事件；裸跑无 Loop 事件文件 |
| `candidate-N.cpp`、`selected.cpp` | 完整候选与最终选择；有通过公开验证的候选时优先保留 |
| `check-N/report.json`、`check-N/work/` | C 仿真与综合进程结果、限长日志及综合报告 |
| `manifest.json`、`result.json`、`report.json` | 执行前固定全部任务、单次终态与配对汇总；缺失任务保持失败分母 |

`generationMs` 包含生成与 Agent 内部工具时间；`judgeMs` 是最终候选在生成结束后的公开验证时间；`wallMs` 从建立独立运行目录之后开始，到结果落盘之前结束，覆盖生成、检查与过程证据写入，不含环境预检、目录建立及最终结果落盘。冷启动与官方时钟边界仍须单独测量。缺失结果不以零耗时计算。`usageTokens` 仅在每次调用均返回实际用量时给出；`inputBytes` / `outputBytes` 为字节统计，不能解释为 token。采样种子是向服务发送的可复现提示，不保证各后端确定性。

B0 为单次题目裸跑；A1 为普通诊断；A2 为结构化诊断加固定实验技能；C1 为相同最大调用数、检查数及时间预算内的独立采样，按公开检查选取候选。C1 不保证实际 token 消耗相同，也不是正式 `pass@k`。B0/A1/A2 的独立最终样本提供开发口径 `pass@1`；每题至少五次独立样本才计算 `pass@5`，采用 `1 − C(n−c,k)/C(n,k)`，样本不足返回空值。报告另给出按题目聚类的配对增益区间和描述性 Wilson 区间；重复样本不被当成独立题目。开发题与留出题分批运行，模拟与真实开发证据禁止混算，官方完整分级通过率待评分接口公布后实现。

### 5.2 真机验收顺序

先让 doctor 通过，再验证向量加法的 C 仿真/综合及失败样例，核对器件和时钟、测试源码不可写、越界路径不可达、超时后无残留容器。随后固定模型/技能/题集，跑 B0/A1/A2/C1 的公开开发批次；确认统计和费用后才能开启留出题。目标 GPU 上的显存峰值、离线运行和官方四级判定均需独立证据。最后按规划 P2 去留条件决定 ITER-022，当前不自动进入提交或产品化。
