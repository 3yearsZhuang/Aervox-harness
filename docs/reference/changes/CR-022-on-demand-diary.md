---
id: CR-022
type: reference
scope: change
owner: architecture
doc_status: review-candidate
decision_status: proposed
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/adr/ADR-011-diary-cycle-schedule-revision.md
  - docs/reference/STREAMING_PROTOCOL.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-022 对话触发写日记（aervox_diary_write）与日记契约补全

- 提出人：witchscottishfoldcat · 2026-08-29
- 修改人：witchscottishfoldcat · 2026-08-29

关联：[PRD §6.7 AI 每日日记](../PRD.md#prd-cap-009)、[ADR-011 日记周期](../adr/ADR-011-diary-cycle-schedule-revision.md)、[流式协议](../STREAMING_PROTOCOL.md)、[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)

## 变更原因

CAP-009 的数据层与调度骨架（8 张日记表、事务发布、Worker 轮询）此前已落地，但「AI 真的写」缺失：Worker 生成仍是占位内容，且用户在对话中表达「写篇日记给我」时没有任何触发通道。同时 `/v1/diaries` 与 `tool_approval_required` 已在生产代码中存在但未登记契约（`openapi.json` 缺路径、流事件枚举缺类型），前端传输层也不处理审批事件。本 CR 落地对话触发路径（PRD §6.7 默认桌宠视角：以思思第一人称回顾「今天我们一起经历了什么」），并补齐上述契约债务。

## 目标行为

- **对话触发**：用户说「写篇日记给我」类意图时，模型经 `aervox_diary_write` 工具（`write_with_approval`，PET-05）触发生成；工具指引登记于 `BASE_TOOL_GUIDANCE`（意图识别由模型依指引判断，不新建分类器）；
- **生成核心**：素材 = 当日聊天消息（当前版本、未脱敏）+ 学习目标 + 当日练习记录（`message_versions`/`learning_goals`/`question_attempts` 直查）；Prompt 以思思第一人称写作并施加反虚构守则（仅引用真实素材、素材不足写简短诚实日记、禁止虚构桌宠「后台生活」、不展开敏感/医疗细节）；`AERVOX_LOOP_PROVIDER=llm` 走租户 LLM 配置（OpenAI 兼容），非 LLM 模式确定性模板降级（输出标注 `generatedBy=template`，不冒充模型书写）；
- **发布路径**：当日无日记 → 创建 on-demand 周期（`scheduleEpochId=on_demand:<date>`）并走既有 `publishDiaryWithCycle` 事务（日记 + 周期 CAS + `diary.published` outbox）+ `ai_generated` 版本；当日已有 → `rewrite` 版本落账本 + 主行经 `updateDiaryContent` 推进（version+1、状态转 `edited`），历史版本不覆盖；
- **超时放宽**：Executor 对 `aervox_diary_write` 与 `ask_user_question` 同样放宽至 ≥120s（内含一次完整 LLM 生成）；
- **契约补全**：`GET /v1/diaries` 与 `POST /v1/turns/{turnId}/tool-approvals` 登记 OpenAPI；`tool_approval_required` 加入流事件枚举并定义 `toolApprovalRequiredEventDataSchema`；新增 `diarySchema`/`diaryWriteTool{Input,Output}Schema`；
- **前端链路**：传输层分发 `tool_approval_required`（含 `turnId`）；工作台渲染授权确认卡片（批准/拒绝），批准后经授权接口落 `granted` 并重发相同请求命中授权；回合结束后刷新今日日记卡片；
- **真实 LLM 接线修复**（E2E 实测 DeepSeek 暴露的既有缺口，scripted 回放模式不可见）：
  - `openai-compat-provider` 工具名安全映射：内置工具名含点号（`subagent.delegate` 等）违反 OpenAI/DeepSeek `^[a-zA-Z0-9_-]+$` 校验，出站转下划线、入站还原；
  - 注册表工具进入模型 schema：`createRuntimeToolProvider` 预载 enabled 清单、`composeToolProviders` 并入 fallback 非空清单（此前模型完全看不见注册表工具，含 `aervox_memory_store`）；
  - tool 消息协议序列化：携带 `toolCallId` 的 assistant 消息序列化为 `assistant.tool_calls` 载体，连续 tool 消息缺失载体时合成，满足「role=tool 必须紧跟 tool_calls」协议约束；
  - 思考型模型（DeepSeek v4）`reasoning_content` 跨 Step 回灌：provider 实例捕获上一 Step 思考内容并随 assistant 载体消息回传。

## 范围外

- 每日定时自动生成的 LLM 接入、默认调度种子、时区/静默时段、租约防并发与素材缓冲写入（ADR-011 既有设计，阶段 2 落地）；
- 日记本历史视图、改写/跳过/纠错的完整用户动作 API、outbox → 站内通知、段落来源展示（阶段 3）；
- 对话触发路径的 `localDate` 暂取服务器本地日期（无 `timezoneSnapshot`），跨时区标签以阶段 2 调度机制为准；
- 记忆 FTS 检索作为日记素材（素材授权范围后续按 `contentScopes` 扩展）。

## 数据、契约与回滚

- 数据库：无表结构变更；`SqliteDiaryRepository` 新增 `updateDiaryContent`（改写主行推进，接口同步登记 `IDiaryRepository`）；
- 契约：`packages/contracts` 新增 diary 与审批事件 schema、登记两条路径，`openapi.json` 重新生成并提交；
- 环境兼容：Web/Desktop dev 端口支持 `AERVOX_WEB_PORT`/`AERVOX_DESKTOP_PORT` 覆盖（`turbo.json globalEnv` 声明透传；默认 5173/5174 不变），规避 Windows WinNAT 端口保留段导致 Vite `EACCES`；
- 回滚策略：工具在注册表 `setEnabled(false)` 即从模型 schema 移除且 fail-closed；审批事件为新增枚举值，旧客户端忽略未知事件不受影响；`updateDiaryContent` 仅由新代码路径调用，回滚后数据保留。

## 验证与决策

- 验证：`apps/api/test/diary-ondemand.test.ts` 集成测试 5 项（PET-05 未授权拒绝 / 授权新建 + `GET /v1/diaries` / 同日改写版本与主行推进 / 无素材空日记诚实降级 / `createRuntimeToolProvider` 审批缝挂起-授权-执行）；`openapi-contract.test.ts` 契约断言；`@aervox/agent-loop` 117 测试（含更新后的 provider 协议序列化断言）；全仓 `pnpm build`/`typecheck`/`test` 通过；**真实 DeepSeek E2E**：对话触发 → 审批中断 → 批准 → 重发命中授权 → LLM 生成桌宠视角日记落库 → 工具后续写叙述 → `Completed`；同日改写（version 递增、status `edited`）；预授权命中（同参数哈希免二次审批）。
- 已知边界（本 CR 范围外，待独立修复）：UQ-01 `ask_user_question` 挂起路径存在 `turn_stream_events.sequence` 唯一约束冲突（协调器与执行器各自维护序号），真实 LLM 下模型选择提问时会触发；日记工具指引已注明"一次对话最多调用一次"降低规避成本。
- 决策：Review Candidate，阶段 1（对话触发 + 真实 LLM 接线）已落地；定时路径按阶段 2 推进。
