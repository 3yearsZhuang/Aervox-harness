# ADR-010 DSH/pi 仅为可选适配器

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

- 状态：Proposed（P2 前必须 Accepted）
- 日期：2026-08-23
- 关联：`CAP-020`、`CAP-027`、`RISK-006/010`

> 更新日期：2026-08-31

## Context

本文中的 `DSH` 专指 DeepSeek Harness（`reference/deepseek-harness`）。`dsh-synapse` 是运行在 DSH 上的独立 Web 视图插件，不是 DSH 本体；它展示了会话分支和画布投影的价值。pi/DSH 展示了可替换模型与扩展接口，但它们版本快速变化，运行时/插件权限和数据所有权不应成为 Aervox 核心依赖。BaiShou-Next 为 AGPLv3，不能未经许可复制或链接。

## Decision drivers

- Aervox Session/Message/学习数据必须是唯一真源；
- 参考运行时版本快速变化，不能成为核心依赖；
- 第三方代码/插件需版本锁定、契约测试与权限控制；
- AGPLv3 代码不能未经许可进入核心服务。

## Considered options

1. **可选适配器接入（adapter-dsh/pi/mcp）**：保留生态与试验空间（选定）。
2. **以 DSH/pi 为应用内核**：复用能力强，但核心数据所有权与运行时稳定性风险高。
3. **整体引入参考代码**：与 AGPL 边界和许可证评审冲突，风险不可控。

## Decision

通过 `adapter-dsh`、`adapter-pi`、`adapter-mcp` 接入；Aervox Session/Message/学习数据仍是唯一真源。`dsh-synapse` 画布只保存布局、锚点、折叠和真实 ID。版本精确锁定、契约测试、权限代理、超时、配额、审计和 kill switch 必须存在；MVP 不安装这些运行时也必须完整可用。统一 Manifest/Profile/Contribution 的目标扩展见 [能力组合与可选化目录规范](../capability-composition.md)。

## Positive consequences

- 保留生态选择和 P2 试验空间；
- 核心数据所有权与插件权限边界清晰；
- 无适配器时 MVP 完整可用，降低交付风险。

## Negative consequences and risks

- 适配器维护与版本兼容成本；
- 插件不能直接写核心数据库，能力需经适配层；
- 上游升级需要持续契约/安全/许可证回归。

## Migration / rollback

适配器以独立包和 Feature Flag 发布；上游升级先在隔离环境跑契约/安全/许可证测试。异常时禁用适配器，保留 Aervox 原生会话和导出；不做不可逆数据转换。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- 固定 SHA 复核与版本升级回归（`TC-CONTRACT-STREAM-001`）；
- 画布/内容分离、权限撤销与插件越权测试（`TC-SEC-PLUG-001`）；
- 无适配器核心流程与删除传播测试（`TC-PRIV-DEL-001`）。

## 实施进展（2026-08-28，阶段 6：契约面 + 模拟器；6b/6c：Host 接入 + DSH 固定 SHA 复核真实化）

状态仍为 `Proposed`（真实 DSH/pi 运行时未接入，P2 前完成 Accepted 验收）。已按本 ADR 冻结的约束落地契约面与可机器验证的骨架（AVX-HAR-001 §16.18/§16.19 全量清单）：

- **进程外 Adapter 契约**（`@aervox/agent-loop`）：`AdapterDriverPort`/`AdapterManifest`/`AdapterWireMessage`（JSON 行协议）、纯函数 `concludeAdapterBatch`（上游 any/every 批次收紧为 `all-results-conclude`，混合批次一律拒绝不静默放行）与 `verifyAdapterManifest`（固定 SHA + 许可证白名单 [MIT/Apache/BSD]，AGPL 等拒绝）；
- **子进程 stdio 端口**（`@aervox/host-agent`）：握手（hello → 准入复核）→ 逐 Turn 请求-事件 ping-pong；每 Turn 总超时、kill switch、失败自动禁用（后续 `adapter_unavailable`）；
- **Profile 准入**：`LoopDriverId` 扩 `dsh`/`pi`，未提供已准入 Adapter 时拒绝解析（不安装也完整可用）；adapterId 与 driver 失配拒绝；
- **模拟器**：`createSimAdapterDriver`（dsh-any / pi-every）与 fixture 子进程双实现；`TC-CONTRACT-STREAM-001`（固定 SHA 复核）、`TC-SEC-PLUG-001`（许可证白名单拒绝）与 `TC-PRIV-DEL-001`（缺省 native/replay 完整可用）均有对应测试骨架；
- **6b Host 接入**（`@aervox/host-agent`）：`runAdapterTurn`（claim → adapter 整 Turn → 事件映射既有契约落库 → finalize；all-results-conclude 收紧：concluded→Completed、mixed_batch→Interrupted、异常→Failed）接入 `createAgentHost({ adapter })` 轮询驱动；续跑（resume）仍走原生 executeTurn；客户端 SSE 契约零改动；
- **6c 固定 SHA 复核真实化**（`probeDSHReference`）：父仓库 submodule gitlink 与 `DSH-01` 登记 SHA（`b150a551…`）机器比对 + 子模块 package.json 版本/许可证复核（MIT 白名单通过）。参考仓库为 pnpm monorepo，真实 Turn 需 `git submodule update --init reference/deepseek-harness && pnpm install && pnpm build:lib:host` 后再接入 stdio 端口——本阶段不在测试/CI 内构建该仓库（失败自动禁用语义见 6b），此为该验收证据与「真运行时接入」之间的剩余工程项。
- **6d DSH 真 Turn 接通骨架**（`createDSHAdapterDriver` + `test/fixtures/dsh-turn-runner.mjs`）：固定 SHA 复核通过后 spawn runner 走 stdio 协议；模型回合为真实 LLM（OpenAI 兼容直连，`DEEPSEEK_API_KEY` 或 `DSH_LLM_BASE_URL` 指向任意兼容端点），输出 delta→batch(全结论)→done（all-results-conclude 收敛）；缺前置返回指引性 `dsh_unconfigured`，host 失败自动禁用；本地兼容端点用例整回合机器验证（无外部网络）。DSH 库内 Agent 循环（Cordis 容器）替换仍以参考仓库构建产物为前置（P2 工程项）。
- **6e 库内产物接入证据**（`DSH_LIB_MODE=1` 探测）：`reference/deepseek-harness` 已完成 `pnpm install && pnpm build:lib:host`（本地构建通过），runner 动态 import `packages/core/agent/lib/index.js` 成功并验证公开导出面（`AgentRegistry`/`assembleContextFor`/`installModelSelection`/`emitAgentEvent` 等）——「库内 Agent 循环可加载」的机器证据（`it.runIf(refLibBuilt)` 产物存在时执行）。完整 Cordis 容器组装（llm/model/session/persistence/tools 等 service 注入并驱动 headless turn）仍为 P2 工程项：范围在 DSH 的 inbox/driver 驱动模型之上，非应用层脚本级。

## 验收差距复核（2026-08-31）

- **已满足**：固定 SHA 复核与许可证白名单（阶段 6/6c：`adapter-contract`/`stdio-adapter`/`dsh-reference` 测试）；无适配器核心流程（conversation-loop）与删除传播（conversation-deletion）测试。
- **未满足**：`dsh-synapse` 画布/内容分离与完整插件越权矩阵（画布未实现）。
- **推进路径**：DSH 库内 Cordis 组装（P2）与画布立项时闭环（死线：P2 前）。
