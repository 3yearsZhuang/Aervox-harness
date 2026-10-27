---
id: AVX-DS-001
---

# Aervox 视觉系统与设计规范 (Design System & Tokens)

关联：[架构设计说明书](ARCHITECTURE.md)、[能力注册表](REQUIREMENTS_TRACEABILITY.md#capability-delivery)、[需求追踪与交付标准](REQUIREMENTS_TRACEABILITY.md)

---

## 1. 视觉主题与设计哲学 (Visual Theme & Atmosphere)

Aervox（思隅）是服务生活、工作与学习的主动智能个人助手，学习是首批验证场景。界面融合桌宠陪伴与专业工作台，产品范围以 [PRD](PRD.md#12-产品定位) 为准；视觉表现不能暗示尚未授权或验收的观察、动作和后台能力。

桌面默认陪伴布局保留左侧大角色、轻量工具区和底部对话/输入；标准工作台为可选模式。手机和平板浏览器默认使用主动陪伴界面，已有手动选择和查询参数优先，缩放桌面窗口不会切换根界面。布局实现见[工作台主题](../../packages/ui/src/theme/workbench-experience.css)与[根界面解析](../../packages/ui-host/src/resolve-web-platform.ts)，短窗口工具可点击、输入不越界的回归见[经典布局测试](../../e2e/ui/classic-workbench.spec.ts)；这些证据不替代移动真机或桌面发布验收。

- **桌面设计语言定位**：**Ethereal Glass & Neo-Mica（空灵玻璃与新云母）**，结合微结构拟物（Doppelrand 双层边框 / 嵌入高光）、单主色秩序与流体微动效。
- **三向调盘基准（The Three Dials）**：
  - **`DESIGN_VARIANCE: 6`**（控制性非对称：标准工作台严整有序，伴学模式如视觉小说般生动自由）；
  - **`MOTION_INTENSITY: 6`**（流体弹性微动效：触控下沉、弹簧物理曲线 `cubic-bezier(0.16, 1, 0.3, 1)`、呼吸光晕）；
  - **`VISUAL_DENSITY: 5`**（日常应用平衡度：卡片克制，间距适度呼吸，支持紧凑模式切换）。

---

### 1.1 Android：Material 3

Android 界面采用 [Google Material 3](https://m3.material.io/)，保留思隅品牌、角色、既有导航和业务行为。显式 mobile 构建在挂载前装配 Material 主题与组件；普通 Web/桌面及仅缩小窗口不启用。以下桌面玻璃、字阶、圆角和下沉反馈规则不覆盖 Android 的本节约定。

- **颜色与主题：** 使用官方 Material Color Utilities 从品牌蓝生成浅色/深色 Tonal Spot 角色。主动作、容器、正文、轮廓、错误及逆色反馈分别消费对应 color roles，Android 表面使用 tonal elevation，去除桌面玻璃模糊、渐变与发光。遵守现有用户主题选择和系统偏好；这是品牌基线，不声称已接 Android 壁纸动态色。
- **排版与形状：** 使用 Android 系统 Roboto 与系统中文回退，不向外部字体服务请求资源。正文 16/24、辅助正文 14/20、标题 22/28 CSS px；控件遵循 4/8/12/16/28/full 形状阶梯，按钮与图标按钮至少 48 CSS px 触控范围，输入保留清晰标签、IME 和焦点状态。
- **组件：** 交互按钮、开关、设置弹窗、标签、波纹及等待进度使用官方 `@material/web`；既有原生表单/抽屉按同一语义令牌适配，保留其键盘和滚动行为。建议仍为真实业务入口，不为凑导航栏添加未实现目的地。普通/禁用/焦点/加载/错误/取消反馈必须可区分，系统减少动态效果时停用非必要动画。
- **二次确认：** 设置与插件面板的确认和输入提示使用独立 Material 模态层，继承宿主返回层级；父界面关闭、卸载或停用时取消未确认的操作。连续确认、取消与输入校验不绕过原数据写入入口；普通 Web/桌面继续使用既有提示服务。
- **移动操作：** 同一移动界面提供会话列表、新建、选择和持久记录回看；底部操作与常驻多行编辑可单手触达，Enter 换行、明确点发送，保留中文组合态与按会话草稿。键盘优先收起，返回只关闭最上层界面，不等同业务停止；运行与未知提交的所有者不能被列表浏览或回看替换。主内容独立滚动，底部输入保持在可见视口内。
- **平台边界：** 主题装配与宿主能力分别验收。Material UI 不代表已接通手机 SQLite、模型、后台或发布；独立原型的固定资产宿主启用时复用同一主题入口，不能因移动标记放开原生权限。

源码入口为[Material 主题与装配](../../packages/ui/src/material3/register.ts)，平台选择位于[Web 组合根](../../apps/web/src/main.ts)。

手机常规竖屏以大角色为主，对话框允许叠在 Live2D 下半身上；头部与上半身保留展示空间，输入区独立固定在底部。软键盘或短视口出现时收起角色并解除对话叠放，保证正文和输入可访问。该布局仅用于显式 mobile 宿主，普通 Web/桌面保持原布局。

手机设置统一使用全屏容器，标题、关闭与分类导航固定，表单单列且独立滚动；模型、语音和角色的非空列表、长名称与保存/测试操作采用同一排版。角色编辑沿用该容器，操作区与正文分开；键盘按可见视口压缩内容区，分类切换保留已有设置草稿。新建和删除使用同一提示原语并按返回层级关闭，成功、错误与校验反馈保留在当前设置表面。完整工作台在手机宿主打开设置时使用同一容器，普通 Web/桌面的弹窗布局保持。

设置的一致性参考 [FlClash 的分组与条目结构](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/ui/list.dart)：页面标题、分组标题、正文说明和记录操作各有固定层级，采用 16px 页边距、24px 分组间距及 8px 标题后间距；导出与删除使用低强调操作，删除保留危险色、确认及触控范围。

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

列表尚未载入时显示骨架及忙状态，读取失败时显示可重试故障态；只有成功载入且无匹配项时才显示空态。不得把接口失败或加载中的空数组解释成用户尚无数据，状态分支见 [WorkbenchSidebar](../../packages/ui/src/components/workbench/WorkbenchSidebar.vue)。

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
