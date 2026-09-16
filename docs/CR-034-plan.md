---
id: AVX-PLAN-034
type: reference
scope: temporary-plan
owner: maintainers
doc_status: draft
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 30
review_triggers:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - packages/contracts/**
  - packages/agent-loop/**
  - apps/api/src/modules/llm/**
  - apps/api/src/modules/conversation/**
  - apps/worker/**
  - packages/ui/**
  - apps/desktop/**
sources:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/changes/CR-015-llm-provider-config-webui.md
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-032-proactive-intelligence-plugin-ecosystem.md
  - docs/reference/adr/ADR-005-provider-port.md
  - docs/reference/adr/ADR-012-streaming-safety-persistence.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/AI_QUALITY_SAFETY.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# AVX-PLAN-034 临时计划：CR-034 本地模型降级阶梯实施拆分

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-16

> [!WARNING]
> 本文件是临时执行计划，不是 Provider、模型能力或安全策略的事实源。原始提案 [CR-034](reference/changes/CR-034-local-model-fallback-ladder.md) 与 [ADR-005](reference/adr/ADR-005-provider-port.md) 仍是权威基线；本文件不改变 CR-034 的 `Proposed / Planned` 状态。

## 1. 结论与路线

CR-034 与内部 `ProviderPort`、本地 SQLite 和现有 OpenAI 兼容端点架构相容，方向可行；但不能一次性实现三层阶梯。实施决策为 `More Evidence Required`，拆为四片：

| 子片 | 内容 | 交付边界 |
|---|---|---|
| N1 | 健康探测、L0/L1 路由、会话粘滞与回切 | 主干，先不改变工具能力 |
| N2a | 能力等级与服务端工具策略 | N1 稳定后启用 |
| N2b | L2 确定性规则回应 | 与 N2a 分开验收 |
| N3 | Ollama 生命周期托管 | 可延后，默认关闭 |

依赖顺序：

```text
F0/G0-G1 → 共享 ModelRouting 契约 → N1 → N2a → N2b
                                          └→ N3（独立、可延后）
```

## 2. F0：开工前决策与 DoR

1. 冻结 L0 云端、L1 本地端点、L2 规则回应的触发、会话粘滞、探测间隔、连续成功/失败次数、迟滞窗口、手动锁定和恢复语义。
2. 处理契约冲突：`anthropic` 出现在配置枚举，但对话执行器明确不支持。N1 必须明确“本 CR 仅 OpenAI-compatible，Anthropic 另立 CR”或先补独立 Provider ADR/实现，不能静默标为 L0。
3. 定义跨 API、Worker、日记和主动组合器共享的 `ModelRoutingPort` / `LlmDegradationPort`；禁止 Worker 直接导入 `apps/api` service。
4. 定义 `CapabilityTier`、health snapshot、route reason、config revision、ModelRun/PromptVersion/ContextManifest 字段和切换审计事件。
5. 关联 `CAP-002/007/009/013/019/020/033`、`OPS-REL-001`、`RISK-010`，补 AC/TC、模型质量阈值、成本、通知和三片独立 flags：`model_routing`、`capability_tiering`、`rule_response`、`local_runtime_host`。

出口：G0/G1 通过，且 Provider 支持矩阵、local_only 边界、失败语义和回滚路径全部有签字证据。

## 3. 共享路由契约（F1）

- `ModelRoutingSnapshot`：tier、provider/model、config revision、local attestation、reason、health revision、sticky session 和 policy version。
- `HealthSnapshot`：`unknown/healthy/degraded/unavailable`、探测时间、连续成功/失败计数、冷却、错误分类和脱敏 endpoint identity。
- `CapabilityTier`：L0 `full`、L1 `restricted`、L2 `minimal`；明确哪些工具、Prompt 片段、教学能力和主动生成可用。
- 事件和审计：切层/回切不打断进行中的 Turn，新回合才消费新快照；ModelRun、SSE 元数据、日志和账本可追溯 tier 与原因。
- Provider 探测：严格 timeout、redirect/SSRF 防护、literal loopback 和 local processing attestation；不把 API key、完整 URL 或用户正文写入日志。

契约先生成 Zod/OpenAPI 和 stub/replay adapter，再进入 N1 行为改造。

## 4. N1：健康路由与 L1 切换

1. 将现有一次性连通性测试抽成后台探测 Port；探测不能阻塞 Turn，也不能在一个 Turn 中途切层。
2. 为每个 preset 保存健康快照，使用连续失败/成功阈值、节流、迟滞和会话粘滞；手动锁定优先于自动路由。
3. API、Worker、日记和主动组合器统一读取 routing snapshot；主动画像仍必须满足 CR-023/ADR-018 的本地证明，不能因“本地降级”绕过授权或远程边界。
4. Web/Desktop 状态栏、气泡和流事件显示 L0/L1/L2 与切换原因；设置面板允许关闭自动 L1 或固定层级。

验收：端点故障不半途切换；连续 N 次失败后新回合切层；连续 N 次成功后新回合回切；并发更新 CAS/幂等；探测节流；local_only 违规 fail-closed；桌面和 Web 状态契约一致。

## 5. N2a：能力分级

- 在 `@aervox/contracts` 定义 tier 与工具兼容矩阵；L0 行为 100% 保持。
- L1 在服务端 Agent Loop 装配和 ToolRuntime 层过滤工具，至少收紧写工具、敏感工具、插件贡献和高风险操作；不能只在 UI 隐藏按钮。
- 未声明或高危工具一律 fail-closed；CR-022 的审批、ADR-009 沙箱和现有 authorizer 仍是硬门槛。
- 插件 manifest 声明 tier compatibility，拒绝把低能力模型误标为 full。

验收：L1 负向工具矩阵、Prompt injection、审批竞态、插件兼容和旧 L0 回归全部通过；未知 tier 不得自动放行。

## 6. N2b：L2 确定性回应

1. 建立独立 `RuleResponsePort`，覆盖问候、陪聊骨架、主动事件播报和固定安全响应；不要把模板异常伪装成模型完成。
2. 规则回应携带 `source=rule/offline`、模板版本、persona revision 和 safety policy version；复用人格管线，但不自动进入普通模型事实、记忆或日记。
3. 安全分类不可用时使用保守固定响应；危机样本不能进入普通 L2 模板。
4. UI 明示“离线回应”，保留 CR-032 主动侧确定性引擎和模板降级语义。

验收：零模型全链路、人格一致性、危机拦截、删除/导出/审计、重启恢复、可见标识和流事件契约测试通过。

## 7. N3：Ollama 生命周期托管（可后置）

N3 默认关闭，仅负责让 L1 可达，不嵌入 `llama.cpp` 或随包分发模型二进制：

- 检测安装/运行状态、模型目录、版本、磁盘/内存/并发配额；
- 下载只允许官方 URL 白名单，校验 checksum/签名/许可证和模型大小；
- 命令、参数、路径、环境变量和子进程继承全部白名单化，支持取消、超时、kill switch、崩溃恢复和卸载；
- 用户显式确认后才写入 `llm_configs`，失败不影响 L2；
- 记录最小化生命周期审计，不把凭据、正文或未授权网络结果写入普通日志。

验收覆盖 SSRF、命令注入、路径逃逸、恶意/超大模型、磁盘耗尽、进程残留、权限撤销、网络失败、恢复和默认关闭。

## 8. 质量、指标与发布门禁

每片独立通过 G2（架构/威胁/成本/迁移/回滚）、G3（契约/单测/集成/E2E）、G4（AI 质量/安全/隐私/性能/恢复）和 G5/G6（灰度、值班、监控、发布后验证）。

必须建立固定 replay/stub 和离线评估集；建议在 G0 冻结教学正确率、安全召回、TTFT、L1/L2 质量差异、切层抖动、探测失败率、工具拒绝率、成本和本地出网指标。安全召回、删除零召回和 local boundary 是阻断项，不得用平均质量抵消。

## 9. 回滚与数据兼容

- N1 flag off：回到当前“读取激活配置”的路径，保留健康/审计行；
- N2a flag off：回到 L0 旧工具策略，保留旧 policy version，不静默重新开放被阻断工具；
- N2b flag off：回到明确的失败语义或 CR-032 模板，不宣称模型生成；
- N3 flag off：停止托管器并 kill 子进程，保留用户配置/模型文件，继续 L2；
- 所有 schema 采用 additive/幂等补齐，不做破坏性回滚；若 CAP-033 本地证明失败，主动路径必须挂起，不能远程降级。

正式子 CR 实施后同步 [ADR-005](reference/adr/ADR-005-provider-port.md)、STREAMING_PROTOCOL、AI_QUALITY_SAFETY、THREAT_MODEL、DATA_PRIVACY、TEST_STRATEGY、operations，并在 [REQUIREMENTS_TRACEABILITY.md §4.2](reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记 CAP、AC/TC、路径、版本和验证证据。

本临时计划在 N1/N2/N3 子 CR 通过 G1 后失效，需迁移到正式 CR 或删除。
