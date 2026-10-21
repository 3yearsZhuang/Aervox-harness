---
id: AVX-DS-001
---

# Aervox 视觉系统与设计规范 (Design System & Tokens)

关联：[架构设计说明书](ARCHITECTURE.md)、[能力注册表](REQUIREMENTS_TRACEABILITY.md#capability-delivery)、[需求追踪与交付标准](REQUIREMENTS_TRACEABILITY.md)

---

## 1. 视觉主题与设计哲学 (Visual Theme & Atmosphere)

Aervox（思隅）是伴学与成长的双形态桌面智能体，融合“桌宠陪伴”的温度与“专业工程工作台”的秩序感。

- **设计语言定位**：**Ethereal Glass & Neo-Mica（空灵玻璃与新云母）**，结合微结构拟物（Doppelrand 双层边框 / 嵌入高光）、单主色秩序与流体微动效。
- **三向调盘基准（The Three Dials）**：
  - **`DESIGN_VARIANCE: 6`**（控制性非对称：标准工作台严整有序，伴学模式如视觉小说般生动自由）；
  - **`MOTION_INTENSITY: 6`**（流体弹性微动效：触控下沉、弹簧物理曲线 `cubic-bezier(0.16, 1, 0.3, 1)`、呼吸光晕）；
  - **`VISUAL_DENSITY: 5`**（日常应用平衡度：卡片克制，间距适度呼吸，支持紧凑模式切换）。

---

## 2. 色彩校准与角色契约 (Color Palette & Roles)

严格实行**单主色法则（Single Accent Rule）**，饱和度控制在 75% 以下，杜绝 AI 紫/粉霓虹渐变与杂乱色系。色彩严格划分为统一冷灰中性族（Slate / Zinc family），保证全界面冷暖一致。

### 2.1 亮色模式（Light Mode）

- **画布底色 Canvas App**：`#f4f6fa`（极淡雾蓝灰，提供视觉沉淀）
- **主要表面 Pure Surface**：`#ffffff`（核心工作区、抽屉与主要视窗）
- **云母基底 Mica Base**：`#edf0f5`（桌面透光质感）
- **亚克力玻璃 Acrylic Surface**：`rgba(255, 255, 255, 0.72)`（配合 `backdrop-filter: blur(24px)`)
- **主文本 Primary Ink**：`#1e2532`（深墨蓝灰，高对比且不刺眼）
- **次级文本 Secondary Text**：`#4f5b70`（正文说明、辅助信息）
- **弱化文本 Muted Text**：`#8592a6`（时间戳、快捷键、占位符）
- **细发丝边框 Hairline Border**：`rgba(15, 23, 42, 0.08)`（物理分界线）
- **强调色 Accent Cobalt**：`#3b66db`（严谨现代的智性钴蓝）
- **强调色悬浮 Accent Hover**：`#2f54bd`
- **强调色柔底 Accent Soft**：`rgba(59, 102, 219, 0.08)`

### 2.2 暗色模式（Dark Mode）

- **画布底色 Canvas App**：`#0c1017`（深度 OLED 暗色）
- **主要表面 Pure Surface**：`#141923`（主卡片与窗口容器）
- **云母基底 Mica Base**：`#121620`
- **亚克力玻璃 Acrylic Surface**：`rgba(20, 25, 35, 0.72)`（配合 `backdrop-filter: blur(24px)`)
- **主文本 Primary Ink**：`#e6ebf5`（亮柔白灰）
- **次级文本 Secondary Text**：`#a4b0c6`
- **弱化文本 Muted Text**：`#6a778e`
- **细发丝边框 Hairline Border**：`rgba(255, 255, 255, 0.08)`
- **强调色 Accent Cobalt**：`#7899f8`（在深底具有极佳可读性的灵动浅钴蓝）
- **强调色悬浮 Accent Hover**：`#92affc`
- **强调色柔底 Accent Soft**：`rgba(120, 153, 248, 0.12)`

---

## 3. 字阶架构规范 (Typographic Architecture)

全系统彻底剔除 `Inter` 等 AI 模板化泛用字体，采用现代高级无衬线与等宽字体阶梯。

- **主体界面字体族（UI Sans-Serif Stack）**：
  `system-ui, -apple-system, "SF Pro Text", "Plus Jakarta Sans", "Geist", "Segoe UI Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
- **等宽与数字字体族（Mono & Tabular Stack）**：
  `"JetBrains Mono", "Geist Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace`
  （所有数据、倒计时、行号均必须包含 `font-variant-numeric: tabular-nums`）
- **层级与字距（Hierarchy & Tracking）**：
  - **大标题 / Display**：`22px - 26px`，`font-weight: 650`，字距 `-0.025em`；
  - **次标题 / Section Head**：`15px - 17px`，`font-weight: 600`，字距 `-0.015em`；
  - **正文 / Body**：`13px - 14px`，`line-height: 1.55`，字距 `0`；
  - **辅助信息 / Caption**：`11.5px - 12px`，`line-height: 1.4`；
  - **眉标徽章 / Eyebrow Tag**：`10px - 11px`，`font-weight: 600`，字距 `0.06em`，句式或全大写。

---

## 4. 空间与几何圆角律 (Spatial & Radius Scale)

全工程严格遵循**同心圆角嵌套法则（Concentric Curves）**：

- **窗口与外壳（App Shell & Viewport Container）**：`16px`
- **功能卡片与主要视窗（Cards & Panels）**：`12px`
- **次级组件与交互控件（Inputs, Buttons, List Items）**：`8px`
- **悬浮胶囊与状态药丸（Pill Navigation, Badges, Status Dots）**：`9999px`

---

## 5. 组件形态与实体触感 (Component Behaviors & Haptic Feedback)

### 5.1 双层边框结构（Doppelrand Nested Architecture）

卡片与对话流采用外层微透明容器包裹内部核心区域：

- 外层：`p-1.5` 到 `p-2`，带极淡外边框；
- 内层：带有浅色漫射阴影或暗色微光内发光（`box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08)`）。

### 5.2 实体触控反馈（Tactile Push Feedback）

所有可交互按钮与药丸在 `:active` 状态下必须具备实体下沉触感：

```css
button:active,
.interactive-pill:active {
  transform: scale(0.98) translateY(1px);
  transition-duration: 0.08s;
}
```

### 5.3 弹簧动效规范（Spring Motion Choreography）

禁止使用粗糙的 `linear` 或简单 `ease-in-out`，统一采用弹簧物理缓动：
`cubic-bezier(0.16, 1, 0.3, 1)`（优雅展开与平滑收起）。

### 5.4 幽灵控件与嵌入操作（Ghost Controls & Inline Actions）

在药丸与卡片容器内部的折叠/展开、切换等次级交互按钮，统一采用幽灵圆环形态（`border-radius: 9999px; background: transparent; border: 1px solid transparent;`）：
静息态保持低视觉侵入（`color: var(--text-muted); opacity: 0.75`），悬停时以钴蓝微晕渐显（`background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent)`），并在收起态严格垂直居中对齐文本基线。

### 5.5 工作台模式输入区与空态（Workbench Mode Input & Empty States）

标准工作台模式（`.mode-standard`）复用同一套令牌，交互反馈遵循以下基线；陪伴与文档模式不因此改变观感。

**输入区三态。** 发送按钮必须具备三种可区分的形态，不得只靠整体透明度表达禁用：可用态为强调色实心（`background: var(--avx-color-accent); color: var(--avx-color-on-accent)`）并带同色微光；禁用态回到无底色 + `var(--text-muted)`；输入容器在 `:focus-within` 时给出容器级反馈（`border-color` 混入强调色，外圈 `0 0 0 3px var(--avx-color-accent-soft)`）。textarea 自身保持无轮廓，焦点反馈由容器承担。

**快捷键提示不重复 placeholder。** 输入为空且未聚焦时收起「Enter 发送」一类提示：

```css
.composer-dock:has(textarea:placeholder-shown:not(:focus)) .composer-shortcut-hint {
  opacity: 0;
}
```

**空态构成（只适用于真正可能为空的容器）。** 空列表统一为「图标 + 标题 + 单行说明 + 主动作」，禁止只留一行灰字（当前适用：侧栏会话列表）：

```html
<span class="empty-sessions-icon"><MessageSquare :size="16" /></span>
<strong>还没有对话</strong>
<small>新建对话，从卡点开始。</small>
<button type="button">新建对话</button>
```

说明文案必须能在最窄侧栏（200px）内一行排完，避免末行孤字。

**会话流不在空态约束内。** `useWorkbenchConversation` 在初始化与 `resetStory` 时都会写入一条 assistant 问候，`story` 永不为空，消费方只做 `push`；因此 `StandardConversation` 的 `.standard-empty` 与 `HistoryDrawer` 的 `.vn-history-empty` 都是不可达的防御分支。新增空态前先确认容器确实可能为空，不要为空态而造空态。

**次级图标按钮命中区。** 侧栏工具行一类次级图标按钮统一 26px 见方命中区与 8px 圆角，并具备悬停强调色微晕、`:active` 下沉以及 `:focus-visible` 外环；不得只给图标不给命中区。

**未决。** 标准工作台模式的强调色沿用全局 `--avx-color-accent`（钴蓝），与陪伴模式的品牌淡紫色域并存；是否收敛为品牌色域属品牌决策，未决前不得擅自改动全局令牌。

---

## 6. 严厉禁止事项 (Explicit Anti-Patterns)

1. **严禁使用 `Inter` 字体**作为默认无衬线字体；
2. **严禁纯黑背景（`#000000`）**，必须使用带有微冷调的 Slate/Zinc 深色；
3. **严禁混用冷暖灰**（全系统一律锁定同一冷灰阶，禁止在同一界面出现米黄/暖棕与冷青灰交替）；
4. **严禁刺目的 AI 紫粉霓虹发光**或高饱和彩虹渐变；
5. **严禁生硬纯黑无层次阴影**（必须采用带环境漫射的微柔阴影）；
6. **严禁数字跳字**（计时器、指标必须配置 `tabular-nums`）；
7. **严禁按钮无 `:active` 反馈**（杜绝完全没有按压触觉的扁平死气状态）；
8. **严禁在胶囊或圆角卡片中嵌套生硬的有色方框按键**（必须采用同心圆或幽灵无框按钮）。
