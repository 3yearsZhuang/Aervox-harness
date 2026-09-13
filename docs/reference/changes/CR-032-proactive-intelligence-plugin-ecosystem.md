---
id: CR-032
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 1.0.0
updated_at: 2026-09-13
reviewed_at: 2026-09-13
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/srs-proactive-intelligence.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/changes/CR-006-plugin-config-and-pages.md
  - docs/reference/changes/CR-023-proactive-local-intelligence-mode.md
---

# CR-032 主动智能插件化与触发规则生态架构

- 提出人：3yearszhuang · 2026-09-13
- 修改人：3yearszhuang · 2026-09-13

关联：[PRD](../PRD.md) · [主动智能需求规格附录](../srs-proactive-intelligence.md) · [需求追踪基线](../REQUIREMENTS_TRACEABILITY.md#11-变更控制) · [ADR-009 插件沙箱](../adr/ADR-009-electron-plugin-sandbox.md) · [CR-023 主动智能模式](CR-023-proactive-local-intelligence-mode.md) · [CR-006 插件配置与页面](CR-006-plugin-config-and-pages.md)

- 状态：Accepted / Implemented（2026-09-13）
- 提出人 / 日期：3yearszhuang / 2026-09-13
- 目标版本：R2 学习深化与主动智能演进阶段
- 关联能力：`CAP-020`（插件运行时）、`CAP-033`（主动感知与个人画像）、`CAP-034`（智能家居连接）、`CAP-035`（健康数据连接）、`CAP-019`（桌宠交互与情感表达）

---

## 1. 变更背景与驱动因素

在现行架构基线（[CR-023](CR-023-proactive-local-intelligence-mode.md) 与 [AVX-SRS-002](../srs-proactive-intelligence.md)）中，Aervox 已经建立了主动智能的基础数据链路：包括设备观察（`proactive_observations`）、本地事实提炼（`proactive_profile_claims`）、触发规则（`proactive_trigger_rules`）、动作生成（`proactive_actions`）以及后台 Worker 周期扫描机制。

然而，当前的主动智能架构存在关键瓶颈：**所有的感知源、触发规则逻辑与主动关怀话术均与系统内核代码强耦合**。

具体表现为三大核心矛盾：

1. **场景无限性与系统内核维护成本的矛盾**：
   用户的真实生活与工作场景极度多样（例如：久坐 50 分钟喝水提醒、考研自习时段摸鱼警告、代码提交后 CI 状态回执、Home Assistant 夜间入睡前光线关怀等）。若将所有垂直场景硬编码在 `@aervox/api` 或 `@aervox/worker` 中，内核将迅速臃肿腐化，无法满足千人千面的需求；
2. **被动响应插件与主动智能场景割裂**：
   当前 `CAP-020` 插件系统仅支持被动参与已由用户发起的会话回合（通过 `beforeTurn` 注入提示词），插件无法声明场景触发规则，更无法在适当时机由系统主动调度并唤醒用户；
3. **缺乏端到端桌宠表现与可视化联动契约**：
   主动事件触发后，缺乏标准化协议将插件意图映射到 Electron Fairy 桌宠的骨骼动画、气泡对话库，以及 Web 工作台的卡片插槽。

本变更提案旨在确立**“主动智能插件化（Proactive Plugin Ecosystem）”**的核心技术契约，将主动智能从“系统内置固定规则”升格为“插件声明、内核裁决、多端联动”的开放生态。

---

## 2. 核心架构原则：内核管底线，插件管场景

主动智能若放任插件任意读取系统并随意弹出窗口，极易造成用户隐私泄露与严重打扰。本 CR 确立以下架构边界：

### 2.1 内核坚守的底线（安全中枢，不可插件化）

1. **隐私授权防线（CAP-033 / SEC-PRO-001）**：
   插件安装时必须在清单中显式声明所依赖的感知源（如系统空闲时长、应用进程名、Home Assistant 传感器事件）。在用户未在扩展中心显式授权（`plugin_grants`）前，内核切断所有事件输入；
2. **全局防打扰裁决器（Global Proactive Arbitrator）**：
   由系统内核维护统一的“免打扰防线”（包括 Quiet Hours 静音时段、全屏演示抑制、专注模式水位）。裁决器实施全局频次限制（如同一小时内全系统最多主动打扰 $N$ 次），避免多个插件在同一时刻争抢弹窗；
3. **全局紧急熔断（Kill Switch）**：
   用户可通过桌宠托盘或快捷键一键切断所有主动智能插件的后台调度，立刻回退至纯被动响应模式。

### 2.2 插件自由发挥的领域（场景闭环，声明式驱动）

1. **感知源绑定（Sensors）**：声明所需监听的系统事件或 MCP 资源；
2. **触发规则声明（Trigger Rules）**：通过声明式 JSON 配置触发阈值、冷却时间（Cooldown）与前置条件；
3. **专业关怀心智（Proactive Skill）**：配套专有 `SKILL.md`，定义主动唤醒时的角色性格、关怀话术与执行 SOP；
4. **多端交互表现（UI & Pet Actions）**：声明关联的桌宠动画（如伸懒腰、欢呼、叉腰督促）与工作台专属挂载卡片。

---

## 3. 当前行为 vs 目标行为

| 维度 | 当前行为（Baseline） | 目标行为（Target State） |
|---|---|---|
| **触发规则真源** | 硬编码在 `proactive-intelligence-worker` 内部 | 由插件包通过清单声明，安装时动态同步至 `proactive_trigger_rules` 表 |
| **插件生命周期** | 仅被动监听用户发起的 Turn（`beforeTurn` / `afterTurn`） | 支持声明主动触发器，后台 Worker 扫描命中时直接调度插件逻辑 |
| **工具协同能力** | 插件工具与主动智能互相隔离 | 插件可将自身的原生工具或绑定的 MCP 服务直接作为主动动作（`ProactiveAction`）的执行体 |
| **桌宠交互表现** | 仅支持基础固定动作，无法由外部逻辑定制 | 插件可通过主动动作上下文指定桌宠动画（`petAnimation`）与对白气泡 |
| **权限与隔离** | 无插件级的主动感知源授权模型 | 严格遵循 ADR-009 最小权限沙箱，感知源未获授权时静默拦截 |

---

## 4. 详细技术契约设计

### 4.1 插件清单规范扩展 (`plugin.manifest.json`)

扩展清单的 `spec.proactive` 命名空间：

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginManifest",
  "metadata": {
    "id": "health-guard",
    "displayName": "久坐与健康护航助手",
    "version": "1.0.0"
  },
  "spec": {
    "mcpServers": ["local-system-sensors"],
    "skill": "SKILL.md",
    "proactive": {
      "sensors": [
        {
          "sourceId": "system.idle_state",
          "description": "读取键鼠活动与空闲时长以评估工作专注度"
        }
      ],
      "triggers": [
        {
          "ruleId": "sedentary_alert",
          "name": "连续久坐健康提醒",
          "triggerType": "system_state",
          "condition": {
            "idleMinutesMax": 2,
            "continuousActiveMinutesMin": 50
          },
          "cooldownSeconds": 1800,
          "quietHoursPolicy": "respect_global",
          "petPresentation": {
            "animation": "stretch_body",
            "bubblePreset": "gentle_care"
          }
        }
      ]
    }
  }
}
```

### 4.2 数据库 Schema 演进

在 `proactive_trigger_rules` 表中增加插件归属与声明来源，实现与插件生命周期的联动：

```sql
ALTER TABLE proactive_trigger_rules ADD COLUMN plugin_id TEXT;
CREATE INDEX IF NOT EXISTS proactive_trigger_rules_plugin_idx ON proactive_trigger_rules(plugin_id);
```

- **插件安装**：解析清单并将触发规则持久化，`plugin_id` 标记为该插件；
- **插件启停**：调用 `setPluginEnabled` 时，级联更新对应 `proactive_trigger_rules.enabled`；
- **插件卸载**：清理关联的触发规则、待办主动动作与临时状态，杜绝幽灵规则。

### 4.3 主动回合调度流水线 (Proactive Turn Dispatcher)

当 Worker 扫描到插件声明的规则满足条件，且通过了全局防打扰裁决器后，执行以下调度流程：

1. **生成 Proactive Action**：写入 `proactive_actions` 账本，状态为 `pending`；
2. **构造主动回合上下文**：调用 Agent Harness 核心循环，装配该插件的 `SKILL.md` 与触发上下文快照（包含感知事实证据）；
3. **模型生成关怀话术**：由模型在插件设定的角色下生成亲切得体的语句；
4. **多端直推**：通过 `TurnStreamHub` 将动作指令推向桌面端 Electron 桌宠（执行动作与气泡渲染），并向 Web 工作台推送通知。

---

## 5. 受影响模块与实现切片规划

| 序号 | 规划阶段 | 涉及模块 | 主要职责与交付物 |
|---|---|---|---|
| **S1** | 契约与元数据定义 | `@aervox/contracts` | 扩展 `PluginManifestSchema` 与主动触发规则类型定义，生成最新 OpenAPI 与 JSON Schema |
| **S2** | 持久层与仓储联动 | `@aervox/schema`、`@aervox/repositories` | 仓储层增加按插件批量启停、注销主动触发规则的接口，保障原子性与级联清理 |
| **S3** | 服务端生命周期串联 | `apps/api`（plugins 模块） | `PluginService` 在安装、启用、停用和卸载时，原子级联同步主动触发规则 |
| **S4** | 全局防打扰裁决器 | `apps/worker`（proactive 模块） | 落地 `ProactiveArbitrator`，实现全局打扰频次水位控制、静音时段抑制与优先级仲裁 |
| **S5** | 桌面端多端表现打通 | `apps/desktop`、`packages/ui` | 桌面 Preload IPC 支持接收来自主动插件的动画指令，桌宠渲染对应 Live2D 动作与对话气泡 |
| **S6** | 示范插件孵化与闭环 | `plugins/health-guard` | 落地首个出厂预设级主动智能插件（久坐关怀），跑通从感知到桌宠动作的全链路 |

---

## 6. 验证与门禁计划

1. **类型检查与边界门禁**：
   - `mise tasks run ci-code`：全仓编译与类型检查 0 错误，`check:boundary` 0 违规；
2. **定向单元测试**：
   - 插件清单解析测试（验证非法主动触发规则 fail-closed）；
   - 插件启停与触发规则级联状态同步测试；
   - 全局防打扰裁决器节流与并发抑制测试；
3. **端到端集成演练**：
   - 模拟设备活跃事件，验证 Worker 检测到条件后成功拉起主动关怀回合并向桌宠派发指令；
4. **需求追踪登记**：
   - 在 [REQUIREMENTS_TRACEABILITY.md §4.2](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记落地条目，完成闭环。

---

## 7. 回滚与应急方案

- **向后兼容性**：清单中 `spec.proactive` 为可选字段，未声明该字段的传统被动插件与旧版插件完全不受影响；
- **配置与数据隔离**：所有主动事件、观察与规则依然严格保存在本地 SQLite（WAL 模式）与 `proactive-vault.db` 中，符合 CR-030 纯本地单用户要求；
- **快速故障隔离**：若某主动插件规则异常高频打扰，用户或系统可通过禁用单插件立刻拔除对应规则，无需重启主服务。

---

## 8. 落地实现记录（2026-09-13）

本 CR 已按切片 S1~S6 全量落地于分支 `feat/cr-032-proactive-plugin-ecosystem`。落地过程对第 4 节的两处技术契约做了实现细化（意图与验收语义不变），记录如下：

### 8.1 实现细化：规则真源采用「声明 + 物化」两段式

§4.2 原文为插件安装时直接写入 vault 的 `proactive_trigger_rules`。落地发现该表位于加密 proactive vault 库且以 `revision_id` 强约束（画像修订轮换需重绑定、敏感列透明加密），由 `PluginService` 直写会引入跨库与加密耦合。落地细化为：

- **声明真源**：插件清单 `spec.proactive` 经 `zod` fail-closed 校验后持久化于主库 `plugins.proactive_spec_json`，随插件生命周期天然增删；
- **运行时物化**：Worker 每周期把「已启用且感知源授权齐全」的插件声明物化进 `proactive_trigger_rules`（`plugin_id` 标记归属），停用/卸载插件的规则由物化器自动拔除，幽灵规则零残留；冷却起点 `lastTriggeredAt` 由 upsert 的保留语义跨周期存活。

### 8.2 实现细化：主动话术采用 One-shot 组合器

§4.3 原文为「调用 Agent Harness 核心循环」。主动关怀是单轮生成（无工具循环、无多回合状态），完整回合脚手架（session/turn/attempt）为用户发起对话设计，改造量大且引入后台合成回合的语义问题。落地复用日记生成先例：`ProactiveComposer` 装配插件 SKILL.md 全文与触发证据快照，经 OpenAI 兼容 provider 一次性生成，LLM 未启用或失败时按气泡预设模板诚实降级。

### 8.3 各切片落地对照

| 切片 | 主要落点 |
|---|---|
| S1 契约 | `packages/contracts`：`pluginManifestSchema.spec` 扩展 `mcpServers` / `skill` / `proactive`（sensors / triggers / petPresentation）；`PROFILE_SOURCE_IDS` 与授权包清单新增 `system.idle_state`；`ProactivePresentationEvent` 契约与 OpenAPI 重生成 |
| S2 持久层 | `plugins.proactive_spec_json` 与 `proactive_trigger_rules.plugin_id` 补列（`addColumnIfMissing` 幂等）；`plugin_grants` 唯一索引放宽至 `(plugin_id, permission, scope)`；通知表补 `payload_json`；智能仓储新增按插件批量启停 / 删除 / 单条删除 / 冷却写回 / 时间窗事件查询 |
| S3 生命周期 | `POST /v1/plugins` 与内置插件同步统一走清单 `zod` fail-closed 校验；`ProactiveRuleSyncPort` 级联口（启停级联、卸载清规则）；感知源授权约定 `permission=proactive.sensor`、`scope=sourceId`，`GET /v1/plugins/:id/grants` 列表端点 |
| S4 裁决与调度 | Worker 新增 `ProactiveArbitrator`（授权 → 冷却 → 静音时段 → 每小时全局频次水位，抑制决策可观测）与规则引擎（内置 4 规则保留并纳入裁决；插件 `system_state` 等类型求值）；主动回合调度：vault `proactive_actions` 账本（`action.local`）+ One-shot 话术 + 主库通知（payload 携带表现声明）；API 新增 `GET /v1/proactive/events` SSE 直推（以账本为队列） |
| S5 多端表现 | 桌面 `system.idle_state` 采样（`powerMonitor`，60s 节拍，授权门控）；主动事件常驻 SSE 消费器映射为既有 `pet:command` 指令（渲染层近零改动）；气泡预设注册表（`gentle_care` / `firm_nudge` / `cheer`）与动画别名表；托盘 Kill Switch（暂停/恢复主动智能，复用 desiredState 通道）；扩展中心感知源授权区；Web 端主动关怀 Toast |
| S6 示范插件 | `plugins/health-guard/`（首个携带 `spec.proactive` 的出厂插件：连续久坐 50 分钟且在场即提醒，冷却 30 分钟，桌宠伸懒腰 + 温和关怀气泡） |

### 8.4 验证

- 定向测试：清单契约 fail-closed（未知触发类型 / 未知字段 / 超限规则数拒绝）、生命周期级联（启停 / 卸载清规则、感知源 scope 粒度共存）、裁决器节流与静音抑制、E2E（模拟 idle 观测 → 命中 → 账本 `executed` → 冷却二次周期不重复派发）；
- 门禁：`mise tasks run ci-code` 全量通过（含 `check:boundary` 零违规）。

### 8.5 需求追踪登记

已在 [需求追踪基线 §4.2](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记落地条目，完成闭环。
