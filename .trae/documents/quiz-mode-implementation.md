# 刷题模式（Quiz Mode）整体实现计划

## 总结

在学习对话中实现完整刷题闭环：用户在专注模式下输入「来几道题」「刷题」等关键词，或点击前端「刷题」一次性按钮时，AI 进入刷题模式 —— 由 AI 现场生成题目，通过已有的 `ask_user_question` 工具向用户出题（选择题带选项 / 简答题自由输入），收到用户回答后由 AI 判定对错，并调用新增的 `record_practice_attempt` 工具持久化作答事实；判定为 `incorrect` 的作答自动进入错题本（`GET /v1/mistakes` 由 `question_attempts` 派生，无需额外写入）。

整个刷题过程（出题 → 作答 → 判定 → 反馈 → 下一题）在**同一个 Turn 内**完成，依赖 `ask_user_question` 工具的挂起等待机制（`UserQuestionCoordinator`）。

## 现状分析（Phase 1 探索结论）

| 能力 | 现状 | 结论 |
|---|---|---|
| AI 向用户提问 | `ask_user_question` 工具已完备（[user-question-tool.ts](../../packages/agent-loop/src/user-question-tool.ts)）：挂起等待、SSE 事件、前端 `UserQuestionComposer` 答题组件、超时/取消/持久化恢复 | 直接复用 |
| 模式注入 | [agent-executor.ts L424-437](../../apps/api/src/modules/conversation/agent-executor.ts) 检测 `[模式：专注模式]` 等前缀 → `buildBaseSystemPrompt({ studyMode })` 注入专注模式提示词（[base-prompt.ts](../../packages/agent-loop/src/base-prompt.ts)） | 扩展出 `quizMode` |
| 题目/作答持久化 | `questions` / `question_attempts` 表与仓储方法已存在：`createQuestion` / `recordAttempt`（[learning-repository.ts](../../packages/database/src/repositories/sqlite/learning-repository.ts)），REST API 已有 `POST /v1/questions/:questionId/attempts` | AI 侧缺工具入口 |
| 错题本 | `listMistakes` 从 `question_attempts` 中 `judgement='incorrect'` 派生，REST `GET /v1/mistakes` 已存在 | 作答落库即自动进错题本 |
| 前端入口 | 专注模式 toggle（`studyModeEnabled`）给消息加 `[模式：专注模式]` 前缀（[AervoxWorkbench.vue L285-291](../../packages/ui/src/components/AervoxWorkbench.vue)） | 新增一次性「刷题」按钮 |

**缺口**：① 无刷题模式系统提示词与触发检测；② AI 无法将判定结果落库（缺 `record_practice_attempt` 工具）；③ 前端无刷题入口。

## 整体流程设计

```
用户点击「刷题」按钮 ──发送 "[模式：刷题模式] 来几道题"──┐
专注模式下输入 "来几道题"/"刷题" ──────────────────────┤
                                                        ▼
                        agent-executor 检测（前缀 或 专注模式+关键词）
                                                        ▼
                     buildBaseSystemPrompt({ studyMode, quizMode: true })
                                                        ▼
        ┌─── Loop 循环（同一 Turn 内）──────────────────────────┐
        │ 1. AI 生成题目（基于对话上下文/学习主题）                 │
        │ 2. AI 调用 ask_user_question（一次一道）                │
        │    → user_question_required SSE → UserQuestionComposer │
        │ 3. 用户提交回答 → coordinator 唤醒 Loop，答案回填模型    │
        │ 4. AI 判定对错 → 调用 record_practice_attempt 落库      │
        │    → incorrect 自动进入错题本                           │
        │ 5. AI 给出反馈（答错附解析）→ 回到 1（共 3~5 题）          │
        └──────────────────────────────────────────────────────┘
                                 ▼
                    AI 输出本轮刷题总结（对错统计、薄弱点）
```

## 改动清单

### A. packages/agent-loop（工具 + 提示词）

**A1. [ports.ts](../../packages/agent-loop/src/ports.ts) — 新增 PracticeAttemptPort**

```ts
export interface PracticeAttemptPortRequest {
  turnId: string;
  prompt: string;            // 题干
  questionType?: string;     // "choice" | "short_answer" | "fill_blank"（展示用）
  userAnswer: string;        // 用户原始回答
  correctAnswer: string;     // 标准答案
  judgement: "correct" | "incorrect" | "partial";
  explanation?: string;      // 解析（答错时的纠正说明）
  knowledgeConcept?: string; // 可选知识点概念描述
}

export interface PracticeAttemptPortResult {
  questionId: string;
  attemptId: string;
  judgement: "correct" | "incorrect" | "partial";
  enteredMistakeNotebook: boolean; // judgement === "incorrect"
}

export interface PracticeAttemptPort {
  recordAttempt(req: PracticeAttemptPortRequest): Promise<PracticeAttemptPortResult>;
}
```

**A2. `packages/agent-loop/src/practice-attempt-tool.ts`（新文件）— 工具提供者**

仿照 [user-question-tool.ts](../../packages/agent-loop/src/user-question-tool.ts) 的结构：

- `RECORD_PRACTICE_ATTEMPT_TOOL = "record_practice_attempt"`，`ToolSpec` 描述中写明参数结构；
- `readOnly: true`（决策见「假设与决策」#3）；
- `createPracticeAttemptToolProvider({ practiceAttemptPort })`：
  - 校验：`prompt`/`userAnswer`/`correctAnswer` 非空字符串；`judgement` 必须是三值枚举；
  - 从 `input.turnId` 透传，委托 `practiceAttemptPort.recordAttempt()`；
  - 返回 `{ ok: true, output: { questionId, attemptId, judgement, enteredMistakeNotebook } }`；异常映射为 `{ ok: false, error }`。

**A3. [base-prompt.ts](../../packages/agent-loop/src/base-prompt.ts) — 刷题模式提示词 + 工具指引**

- 新增 `QUIZ_MODE_SYSTEM_PROMPT` 常量（中文，与 `STUDY_MODE_SYSTEM_PROMPT` 同级），核心规则：
  1. **一次一道**：每次只通过 `ask_user_question` 提出一道题（选择题提供 2~4 个 options 且不标注 Recommended；简答题不提供 options，让用户自由输入）；
  2. **题目生成**：基于当前对话上下文 / 用户学习主题现场出题，由易到难，一轮 3~5 题；
  3. **判定与落库**：收到用户回答后先自行判定对错，**必须**调用 `record_practice_attempt` 记录（judgement 只能是 correct/incorrect/partial），再给出反馈；答错时温和指出偏差并附正确答案与解析；
  4. **结束总结**：全部题目完成后输出本轮统计（对/错数、薄弱知识点）；
  5. 刷题期间此规范优先于苏格拉底式「不直接给答案」规则（刷题目的就是检验，判定后必须给出正确答案）。
- `BaseSystemPromptOptions` 增加 `quizMode?: boolean`；`buildBaseSystemPrompt` 在 `quizMode` 时追加该段（与 `studyMode` 可叠加，刷题段置后以覆盖教学规则）。
- `BASE_TOOL_GUIDANCE` 追加 `record_practice_attempt` 条目（何时使用：刷题模式下每次用户作答判定后；约束：judgement 枚举、题干与标准答案必填）。

**A4. [index.ts](../../packages/agent-loop/src/index.ts) — 导出新模块**

追加 `export * from "./practice-attempt-tool.js";`。

### B. apps/api（接线）

**B1. [agent-executor.ts](../../apps/api/src/modules/conversation/agent-executor.ts)**

- 模式检测扩展（现 L424-428 处）：
  ```ts
  const hasQuizPrefix = input.userMessage.includes("[模式：刷题模式]");
  const quizKeywords = /来几道题|来几道|刷题|出几道题|考考我|出题/;
  const isQuizMode = hasQuizPrefix || (isStudyMode && quizKeywords.test(input.userMessage));
  ```
  （关键词触发仅在专注模式下生效，避免日常聊天误触发；按钮前缀任何模式都生效。）
- `baseSystemPrompt` 选项追加 `quizMode: isQuizMode`；
- Contribution 组合处（现 L411-413 旁）追加：
  ```ts
  if (deps.practiceAttemptPort) {
    contribution.push(createPracticeAttemptToolProvider({ practiceAttemptPort: deps.practiceAttemptPort }));
  }
  ```
- `runLoopTurnOnce` 的 deps 类型新增 `practiceAttemptPort?: PracticeAttemptPort`。

**B2. `apps/api/src/modules/conversation/practice-attempt-port.ts`（新文件）— 端口实现**

`createPracticeAttemptPortFactory(learningRepo: SqliteLearningRepository)` 返回 `(tenant) => PracticeAttemptPort`，实现 `recordAttempt`：

1. `learningRepo.createQuestion(tenant, { id: "q_…", prompt, answerSpec: { answer: correctAnswer, type: questionType, explanation }, knowledgeId: null })`；
2. `learningRepo.recordAttempt(tenant, { id: "att_…", sessionId: turnId, questionId, answer: userAnswer, judgement, evidence: { explanation, source: "quiz-mode", turnId } })`；
3. 返回 `{ questionId, attemptId, judgement, enteredMistakeNotebook: judgement === "incorrect" }`。

> 说明：MVP 不联动 `knowledge_items` / `review_items`（那需要知识点归一，且 CAP-016 调度走 REST 作答路由已有逻辑）；错题本派生不依赖 knowledgeId，可正常工作。

**B3. [routes.ts](../../apps/api/src/modules/conversation/routes.ts)**

- deps 类型新增 `practiceAttemptFactory?: (tenant: TenantContext) => PracticeAttemptPort`；
- POST `/v1/sessions/:sessionId/turns` 内（现 L133 旁）按 request 租户创建端口并传入 `runLoopTurnOnce` deps（与 `uqPort` 同款模式）。

**B4. [index.ts](../../apps/api/src/modules/conversation/index.ts)**

实例化 `SqliteLearningRepository(db)`（模块自管仓储，符合 ADR-014 模式），用 B2 工厂创建 `practiceAttemptFactory` 注入 `registerConversationRoutes` deps。

### C. packages/ui（前端入口）

**C1. [AervoxWorkbench.vue](../../packages/ui/src/components/AervoxWorkbench.vue)**

- 在 `floating-top-actions` 区（专注模式开关旁，现 L982-1006）新增「刷题」一次性按钮（lucide 图标如 `ClipboardList`，含 aria-label「开始刷题」）；
- 新增 `startQuiz()` 处理函数：
  - `streaming.value` 时忽略；
  - 调用既有 `sendMessage()` 发送 `[模式：刷题模式] 来几道题`（消息前缀规则与专注模式一致：story 中展示用户原文「来几道题」）；
  - 若专注模式开启，本条消息用刷题前缀**取代**专注模式前缀（修改 `sendMessage` 的前缀组装逻辑：quiz 触发优先）。
- 无需新增答题 UI：`UserQuestionComposer` 已能渲染 AI 的题目与选项。

**C2. 样式**

在专注模式开关样式同文件（`workbench.css` / 组件样式）中追加 `.floating-quiz-btn` 样式，与 `floating-study-switch-wrap` 视觉对齐。

### D. 测试

- **packages/agent-loop/test/practice-attempt-tool.test.ts**（新）：仿 [user-question-tool.test.ts](../../packages/agent-loop/test/user-question-tool.test.ts)——参数校验（空 prompt / 非法 judgement 拒绝）、端口委托成功、端口抛错映射 `{ ok: false }`；
- **packages/agent-loop/test/base-prompt.test.ts**（若已有则扩展，无则新增）：`quizMode: true` 注入 `QUIZ_MODE_SYSTEM_PROMPT`；默认不注入；
- **apps/api/test/quiz-mode.test.ts**（新）：仿 [user-question-persistence.test.ts](../../apps/api/test/user-question-persistence.test.ts) 的 scripted/replay provider 模式——带 `[模式：刷题模式]` 前缀的 Turn 能使 `record_practice_attempt` 工具可见并执行落库；落库 `incorrect` 后 `GET /v1/mistakes` 可见该错题。

### E. 落地登记（仓库硬约束）

按 [REQUIREMENTS_TRACEABILITY.md §4.2](../../docs/reference/REQUIREMENTS_TRACEABILITY.md) 在落地实现登记表中登记：关联 CAP-016（自适应刷题）、实现位置（上述各文件）、日期、验证方式（`mise tasks run ci-code` + 上述测试）。该文档属内容更新：更新 `修改人` 签名与核验日期即可，无需同步 DOC_REGISTRY。

## 假设与决策

1. **题目来源 = AI 现场生成**（用户已确认）：基于当前对话上下文出题，不预置题库；错题本积累后可在后续迭代支持重刷。
2. **入口 = 一次性按钮**（用户已确认）：点击即发一条 `[模式：刷题模式] 来几道题` 消息；不做持续开关。
3. **`record_practice_attempt` 标记 `readOnly: true`**：与 `ask_user_question` 先例一致（该工具同样持久化事件）。理由：写入的是用户自己作答产生的不可变学习事实（非破坏性、非用户资产外泄），若走写工具审批门（`createApprovalGatedToolProvider` 按参数哈希逐次授权）会把刷题流程打碎。若审阅者不认可，可改为 `readOnly: false` 并依赖前端 `toolApprovalMode=full_access` 放行。
4. **判定权在 AI**：复用 REST 路由的字符串比对 `judgeAnswer` 无法处理简答/同义表达，故工具直接接收 AI 给出的 `judgement`；`partial` 不进错题本（`listMistakes` 只筛 `incorrect`）。
5. **sessionId 使用 turnId**：`question_attempts.session_id` 为必填的会话标识，直接用触发刷题的 Turn ID，天然可追溯且不随会话删除级联。
6. **关键词触发仅在专注模式下生效**（`isStudyMode && 关词命中`），避免日常对话提到「刷题」误触发；按钮前缀则无条件触发。
7. **一次一道题**：`ask_user_question` 的 `questions` 数组虽支持多题，但刷题提示词约定一次一道以获得逐题判定-反馈节奏；组件无需改动。
8. **60s 默认作答超时沿用**：`UserQuestionCoordinator` 默认 60s，选择题场景足够；如后续需要更长时间可给工具提供者加配置。

## 验证步骤

1. `mise x -- pnpm test`（或 `mise tasks run ci-code`：install + build + typecheck + test）全绿；
2. 新增单测/集成测试（D 节）通过；
3. 手动端到端：`./aervox dev` 启动 → 专注模式开关打开 → 输入「来几道题」或点击「刷题」按钮 → AI 出题卡片出现 → 作答 → 收到判定反馈与下一题 → 结束后 `GET /v1/mistakes` 中出现答错题目；
4. 回归：普通对话（无前缀无关键词）不注入刷题提示词、不出现 `record_practice_attempt` 工具；`ask_user_question` 既有流程（计划审批等）不受影响。

## 实施顺序

1. A1+A2+A4（agent-loop 端口与工具）→ 2. A3（提示词）→ 3. B1-B4（API 接线）→ 4. C1+C2（前端入口）→ 5. D（测试）→ 6. E（落地登记）→ 7. `mise tasks run ci-code` 全量验证。
