# 学习模式卡片联动 · 每日一题 · AI 提问选项卡

## 概要

三个联动改动，全部落在现有工作台卡片系统上：

1. **学习模式卡片联动**：开启学习模式 → 侧边卡片自动替换为「今日学习 + 番茄钟」；关闭 → 恢复原卡片配置（原配置仅存内存，不持久化）。卡片替换带切换动画。
2. **今日学习卡片富内容**：学习模式下今日学习卡片显示学习统计信息（目标/复习/错题），并新增「每日一题」等快捷按钮。每日一题采用**纯跳转方案**（用户已确认）：点击后经系统浏览器打开牛客每日一题页面 `https://www.nowcoder.com/problem/tracker`，不抓取牛客数据。
3. **AI 提问临时选项卡**：SSE 收到 `user_question_required`（现有 UQ-01 机制）时，第一个卡片临时切换为「回答提问」卡片（显示问题与选项按钮，点击即作答），作答完成后自动恢复原卡片，同样带切换动画。

## 现状分析（Phase 1 探索结论）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 卡片槽位 | `packages/ui/src/components/AervoxWorkbench.vue` L157 `cardSlots` | 2 槽位 `ref<Array<CardId|null>>`，持久化 `localStorage('aervox-side-cards')`（仅 `selectCard` L1235 写入） |
| 卡片目录 | 同上 L251-260 `cardCatalog` | 8 张卡：study/todo/timer/history/review/mistake/diary/notifications；`slotCards` computed L262 映射渲染 |
| 卡片模板 | 同上 L1486-1537 | `aside.side-cards > .side-card-slot > (article.side-card | div.side-card-placeholder)` 两分支 |
| 学习模式开关 | 同上 L1296-1306 `toggleStudyMode()` | 切换 `studyModeEnabled`、埋点、桌宠反馈；`saveSettings()` L1308 持久化 |
| AI 提问机制 | 同上 L576-580 `onUserQuestion`、L598-609 `handleQuestionSubmit`、L1562-1568 `UserQuestionComposer` | 契约已存在：`packages/contracts/src/schemas.ts` L108-157（`AskUserQuestionItem` 含 question/options/multiSelect/intent；`submitQuestionAnswers` POST）。消息面板内已有提问卡片组件，保留不动 |
| 番茄钟状态 | 同上 L232-236、L254 | `timerRunning/timerSeconds/formattedTime` 已有 |
| 卡片样式 | `packages/ui/src/theme/workbench.css` L317-400 | 玻璃卡片、`side-card-grid` 占位卡按钮网格可复用为富卡片按钮网格 |
| Electron 外链 | `apps/desktop/src/preload/index.ts` L8-27、`src/main/index.ts` L812-826 | preload 暴露 `fairyDesktop`（window/dialog/settings/aervox），**无 openExternal**，IPC 模式为 `ipcMain.handle('window:xxx')` |
| 落地登记 | `docs/reference/REQUIREMENTS_TRACEABILITY.md` §4.2 | 表头：落地实现 / 关联 CAP / 实现位置 / 日期 / 验证 / 来源 |

牛客无官方公开「每日一题」API（官方 API 为企业版招聘接口），故按用户确认采用纯跳转方案，无后端改动、无新依赖。

## 改动方案

### 1. AervoxWorkbench.vue — 卡片联动状态机

新增状态（script 区，靠近 `cardSlots` L157）：

- `savedCardSlots: Array<CardId | null> | null` — 学习模式开启前的槽位快照（内存，不持久化）。
- `questionSavedSlot0: CardId | null | null` — AI 提问卡覆盖第一槽前的原值（`undefined` 表示未覆盖，用 `ref` 区分 `null`）。

逻辑改动：

- `toggleStudyMode()`（L1296）：开启时 `savedCardSlots = [...cardSlots.value]`、`cardSlots.value = ['study', 'timer']`；关闭时若 `savedCardSlots` 存在则恢复并置空。直接改 `cardSlots.value` **不写 localStorage**（刷新后回落到持久化配置，符合"临时替换"语义）。
- 设置初始化处（L1372 附近恢复 localStorage 卡片之后）：若持久化设置 `studyModeEnabled === true`，同样执行替换并记录快照（保证刷新后仍呈学习模式卡面）。
- `onUserQuestion`（L576）：现有赋值 `activeQuestion.value = qData` 触发临时卡，**不在此处改 cardSlots**——临时卡在 `slotCards`/模板层以 override 方式渲染（见改动 2），避免污染持久化的 `CardId` 类型与 `selectCard` 逻辑。
- 恢复时机用 `watch(activeQuestion)`：从非空 → 空时（`onDone` L572 或 `handleQuestionSubmit` 成功 L603 均会置空）清除 override，卡片自动切回。无需触碰 `cardSlots`，天然带动画。

### 2. AervoxWorkbench.vue — 模板改动（L1486-1537 卡片区）

- 第一槽 override：`v-if="slotIndex === 0 && activeQuestion"` 时渲染专用「提问卡」`article.side-card.side-question-card`，替代该槽原卡片：
  - 头部：图标（`HelpCircle`，lucide）+ 标题「思隅想问你」（复用 `assistantDisplayName`）。
  - 正文：`activeQuestion.questions[0].question`（超出截断，完整内容仍看消息面板内 `UserQuestionComposer`）。
  - 选项网格：复用 `side-card-grid` 样式，按钮为 `option.label`；**单选**（`multiSelect` 为 false，默认）点击即调 `handleQuestionSubmit([{id: question.id, selected: [option.label]}])`；**多选**（`multiSelect === true`）本地 `ref` 暂存选中项并显示「提交」按钮。
  - 底部小字：`正在等待你的回答…`，提交期间 `questionSubmitting` 时禁用按钮。
  - 桌宠反馈：override 出现时 `petReactKind('tilthead', {lookAtEl: '.side-cards', lookDuration: 3200})`（放在 `onUserQuestion` 回调里即可，不引入新 watch）。
- 今日学习富卡片：`v-if="card.id === 'study'"` 的卡片在学习模式（`studyModeEnabled`）下追加两块内容（非学习模式保持现状，避免普通态卡片拥挤）：
  - 统计行（复用 `card.summary()` 已有文案即可，位于 `side-card-summary`，无需新结构）。
  - 按钮网格 `div.side-card-grid.side-card-actions`（复用占位卡网格样式）：
    - 「每日一题」→ `openDailyProblem()`（新函数，见下），图标 `CircleHelp`；
    - 「开始专注」→ `openTool('timer')`，图标 `Clock3`（`@click.stop`）；
    - 「错题重练」→ `openTool('study')`，图标 `Puzzle`（`@click.stop`）。
  - 卡片整体点击仍走 `activateCard` → `openTool('study')`，所有按钮 `@click.stop` 防穿透。
- 新函数 `openDailyProblem()`：
  - 桌面端（`window.fairyDesktop` 存在）优先 `fairyDesktop.openExternal('https://www.nowcoder.com/problem/tracker')`；Web 端 fallback `window.open(url, '_blank', 'noopener')`。
  - 调用 `recordProactiveActivity('aervox.operation', 'workbench.daily_problem_opened')` 埋点 + `petReactKind('forward', {lookAtEl: '.side-cards'})`。
- 注意遵守既有规范：卡片操作期间 gazes/反馈已有模式照抄；不引入新组件文件（`UserQuestionComposer` 保留，双入口）。

### 3. AervoxWorkbench.vue — 卡片切换动画（模板 L1486-1537）

- 在 `.side-card-slot` 内包一层 `<Transition name="card-swap" mode="out-in">`，其内部为单根 `div.side-card-slot-inner`，`:key` 取 `slotIndex === 0 && activeQuestion ? 'question' : (card?.id ?? 'placeholder')`，把现有 `article / div` 两分支 v-if/v-else 移入 inner 内（Transition 要求单根）。第二槽 `:key` 为 `card?.id ?? 'placeholder'`。
- key 变化（学习模式替换、AI 提问覆盖/恢复、用户手动换卡）都会触发过渡。

### 4. theme/workbench.css — 动画与富卡片样式

在 `.side-card` 区块（L317-400 附近）后追加：

- `.card-swap-enter-active / .card-swap-leave-active`：`transition: opacity .28s cubic-bezier(.2,.8,.3,1), transform .28s`；**过渡期间 `pointer-events: none`**（遵守项目规范「菜单项过渡动画期间需设置 pointer-events: none 防残影误触」）。
- `.card-swap-enter-from`：`opacity: 0; transform: translateY(10px) scale(.985)`（新卡上浮淡入）。
- `.card-swap-leave-to`：`opacity: 0; transform: translateY(-8px) scale(.985)`（旧卡上移淡出）。
- `.side-card-actions`：复用 `side-card-grid` 的按钮网格视觉（两列、扁平、雾蓝 accent），限制按钮高度使其在卡片 `1fr` 网格行内不溢出（`overflow: hidden` 已有）。
- `.side-question-card` 选项网格样式复用；提交中按钮 `opacity .6; cursor: default`。
- 风格约束：扁平轻量（无渐变、无立体位移），hover 抬升不超过 1px，雾蓝 accent（`var(--accent)`），与现有 `.side-card-grid-item` 一致。

### 5. Electron openExternal 桥（3 个小文件）

- `apps/desktop/src/main/index.ts`（L812 `window:minimize` 附近）：新增 `ipcMain.handle('window:open-external', (_event, url: unknown) => ...)`——校验 `url` 为 `https://` 协议后 `shell.openExternal(url)`（import `shell` from electron）。
- `apps/desktop/src/preload/domains/window-api.ts`：新增 `openExternal: (url: string): Promise<void> => ipcRenderer.invoke('window:open-external', url)`。
- `apps/desktop/src/preload/index.ts` L8-27：`fairyDesktop` 增加 `openExternal: windowApi.openExternal`。
- `apps/desktop/src/renderer/src/env.d.ts`（L27 `fairyDesktop` 类型）：补 `openExternal?: (url: string) => Promise<void>`。

### 6. 落地登记与门禁（仓库硬约束）

- `docs/reference/REQUIREMENTS_TRACEABILITY.md` §4.2 表格新增一行：「学习模式卡片联动、今日学习富卡片与每日一题跳转、AI 提问选项卡」，关联 CAP 填 UQ-01（提问交互）+ 学习工作台相关 CAP（按 §4.2 现有学习域行的惯例），实现位置 `packages/ui/src/components/AervoxWorkbench.vue`、`packages/ui/src/theme/workbench.css`、`apps/desktop/src/main/index.ts` 等，日期 2026-08-29，验证「dev:desktop 手动验证 + ci-code」，来源「原生功能」。登记前先读该表当前格式对齐列。
- 文档签名：更新该 md 的 `- 修改人` 为当前账号与日期（编辑性更新仅过 ci-docs，不动 DOC_REGISTRY）。
- 分支与提交：新建 `feat/study-mode-card-switch` 功能分支（执行前先 `git status` 检查工作区残留——memory 提示 fix/ui-adaptive-layout 有历史未提交变更，若有无关残留需先单独提交或确认后再切分支，避免混入）；提交信息中文 `feat(workbench): 学习模式卡片联动与每日一题入口`；本地过 `mise tasks run ci-code` 与（文档改动后）`mise tasks run ci-docs`；不直接推 main（上游保护，推送目标为 fork）。
- 全程使用 mise 工具链（`mise x -- pnpm ...`），不新增任何依赖。

## 假设与决策

1. 学习模式替换为**强制两槽 `['study', 'timer']`**（用户原话"自动切换为今日学习与番茄钟的卡片"）；退出恢复内存快照；不写 localStorage。
2. 每日一题为**纯跳转**（用户已确认）：卡片按钮 → 系统浏览器打开 `https://www.nowcoder.com/problem/tracker`；不抓牛客数据、无后端路由、无缓存。
3. AI 提问临时卡只覆盖**第一槽**（用户原话"将第一个卡片临时切换为回答提问选项的卡片"）；多题时只展示第一题（questions 契约 min(1)，实际单题场景为主），完整交互仍可用消息面板内 `UserQuestionComposer`（保留为兜底入口）。
4. 提交回答复用现有 `handleQuestionSubmit` / `submitQuestionAnswers` 契约，不新增 API。
5. 今日学习富卡片仅在 `studyModeEnabled` 时展示按钮网格，非学习模式保持原卡片形态（避免普通态拥挤，也满足"切换学习模式后卡片自动切换"的叙事）。
6. 动画用 Vue `<Transition mode="out-in">` + CSS（~280ms，扁平风格，过渡期 `pointer-events: none`）。

## 验证步骤

1. `git status` 确认工作区干净（或先处理既有残留），新建 `feat/study-mode-card-switch` 分支。
2. 实现上述改动后：`mise x -- pnpm run dev:desktop` 手动验证：
   - 右上角开关切学习模式 → 两卡片带动画替换为今日学习+番茄钟；再切回 → 恢复原卡片；
   - 今日学习卡显示统计与按钮网格；「每日一题」在 Electron 下唤起系统浏览器、Web 下开新标签页；
   - 触发一次 AI 提问（学习模式对话中让模型发起 `ask_user_question`，或对已会话复放）→ 第一槽带动画变为提问卡 → 点选项 → 流继续、卡片带动画恢复；
   - 刷新页面且学习模式为开 → 卡片仍为今日学习+番茄钟。
3. 门禁：`mise tasks run ci-code`（typecheck + test）；文档登记后 `mise tasks run ci-docs`。
4. 按 §6 提交并推送 fork。
