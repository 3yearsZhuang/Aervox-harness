---
id: AVX-EXPL-006
type: explanation
scope: baseline
owner: platform
doc_status: draft
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
review_triggers:
  - Agent Harness Loop 阶段计划或工具机制变更
  - CAP-027 本地优先或 CAP-020 插件机制变更
  - 新数据实体（HA 凭据、实体目录、事件日志）进入数据字典前
sources:
  - docs/reference/agent-harness-loop.md
  - docs/reference/capability-registry.md
  - docs/reference/PRD.md
---

# Home Assistant 集成评估

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

本文评估为 Aervox｜思隅引入 [Home Assistant](https://www.home-assistant.io/)（以下简称 HA）支持的可行性与方案取舍。本文是评审输入，不是已批准的生产规格、接口契约或新增 CAP；决策落地须按[追踪基线 §11 变更控制](../reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)先建 `CR-*` 再冻结 `ADR-*`。

## 一句话模型

HA 作为 Aervox 可选的"家庭环境事实与执行层"：Agent 经受控工具读取环境状态、执行经审批的家居操作；HA 不是 Aervox 的业务真源，不在 HA 上驻留模型与学习数据，HA 的删除、撤权与恢复遵循 Aervox Data Rights。

## 1. 评估目标与边界

### 1.1 为什么此时评估

1. Agent Harness Loop 已具备工具执行管线（只读/写审批/特权三级）与受控收件箱，接外部系统的事实与执行面已经具备扩展点（见 [AVX-HAR-001 §9](../reference/agent-harness-loop.md#9-工具执行管线) 与 [§7.2](../reference/agent-harness-loop.md#72-agentinboxitem)）。
2. "主动智能"与"陪伴"需要感知真实世界：家庭环境的温度、光照、作息、学习时段是桌宠与工作台可以安全消费的低敏信号。
3. 本地优先（`ADR-008` / `CAP-027`）与 HA 自托管、局域网直连的形态天然一致，不需要走云。

### 1.2 本评估产出与不产出

- 产出：接入能力盘点、与现有构件的契合点、三到四个候选方案的对比、推荐方案的设计要点、阶段路线、风险与未决问题。
- 不产出：不写协议契约、不建 schema、不开 CR/ADR、不承诺任何发布批次。

### 1.3 不变量（与 [AVX-HAR-001 §3](../reference/agent-harness-loop.md#3-在能力组合模型中的位置) Kernel 不变量对齐）

- HA 状态不是学习、记忆、日记或会话事实源；
- 模型请求控制设备 ≠ 授权：写操作必须绑定可审计授权快照；
- HA 凭据视为敏感数据，只存加密凭据存储，不落日志、不进模型上下文原文；
- HA 不可用时不影响 Web/Desktop 核心学习流程；
- 撤销或删除连接后，不得用本地缓存的 HA 数据恢复执行。

## 2. Home Assistant 能力与接入面

### 2.1 产品事实

HA 是自托管的家庭自动化中心，本地运行，聚合数千种品牌集成（Zigbee/Z-Wave/Matter/蓝牙/各厂商云），统一暴露实体（entity）与领域服务（domain/service）。用户自建实例，默认端口 8123（HAOS 环境为 80）。

### 2.2 接入面对比

| 接入面 | 能力 | 实时性 | 适用场景 | 备注 |
|---|---|---|---|---|
| REST API（`/api/*`） | 查状态、调服务、读历史 | 轮询 | 一次性查询与低频操作 | Bearer Token；官方文档 `developers.home-assistant.io/docs/api/rest` |
| WebSocket API（`/api/websocket`） | `get_states`、`call_service`、`subscribe_events`（如 `state_changed`） | 推送 | 持续事件订阅、低延迟控制 | 官方客户端库 `home-assistant-js-websocket` |
| OAuth 2 + IndieAuth | 完整授权码流程 | — | 面向运行用户的正式授权 | client_id 为应用网站；native app 可用 `redirect_uri` link 标签 |
| 长生命周期访问令牌（LLAT） | Profile 页生成、10 年有效、无刷新流 | — | 轻量集成/开发期 | 令牌不在 HA 侧留存，必须用户自行保管；可用于 REST 与 WebSocket |
| MQTT 桥 | HA 事件总线 → MQTT topic | 推送 | 已有 MQTT 基础设施或低客户端依赖场景 | 需在 HA 侧配置桥接与 topic 规则 |

评估结论：

- **读状态**：REST 与 WebSocket 都能满足；需要订阅变化时 WebSocket 是唯一低延迟路径。
- **写控制**：统一走 `call_service`（domain/service + 参数），REST 与 WebSocket 语义一致。
- **授权**：正式产品优先 OAuth 授权码流（可撤销、可审计）；R0 原型可用 LLAT 加白名单约束过渡，但须在文档与 UI 中明示其 10 年有效期与手动撤销义务。
- **事件流**：WebSocket `subscribe_events` 是注入 Aervox Inbox 的首选来源；MQTT 作为备选桥，避免为每个 HA 实例强加 broker 依赖。

注意：`state_changed` 事件与实体属性均来自 HA，是不可信外部输入，进入模型前必须经过结果安全校验（对齐 [AVX-HAR-001 §9 管线](../reference/agent-harness-loop.md#9-工具执行管线)的"结果 safety/大小验证"）。

## 3. Aervox 现有构件的契合点

| 现有构件 | 位置/依据 | 与 HA 集成的关系 |
|---|---|---|
| 工具执行管线 | [AVX-HAR-001 §9](../reference/agent-harness-loop.md#9-工具执行管线)（`read_only` / `write_with_approval` / `privileged`） | "查状态=只读，控制设备=写"的天然映射 |
| 主仓工具注册表 | `apps/api/src/modules/tools/runtime.ts`（阶段 2d 起静态接线） | HA 工具在此登记并复用主仓契约，不另起平行注册表 |
| AgentInboxItem | [AVX-HAR-001 §7.2](../reference/agent-harness-loop.md#72-agentinboxitem)（阶段 5a 已落地） | HA `state_changed` → Inbox `steer/inject`，实现"环境感知的主动对话" |
| 本地优先 | `ADR-008`、`CAP-027` | 局域网直连 HA，数据不外送云 |
| Electron Host / ESP32 设备协议 | [ESP32 硬件延伸](esp32-s3-hardware-extension.md)（AVX-EXPL-005） | 未来物理桌宠可作为"执行确认/触发面"，但仍不持有 HA 凭据 |
| 插件机制 | `CAP-020`、[AVX-PLUG-001](../reference/plugin-config-and-pages.md) | 远期可将 HA 工具集作为可分发插件载体 |

## 4. 集成方案对比

### 4.1 方案 A：Agent Loop 工具（推荐）

把 HA 读/写能力实现为 `ToolProviderPort` 的扩展工具，按 §9 管线执行：

- 只读工具（如 `ha_get_entity_state`、`ha_list_entities`）：按已批准策略自动执行；
- 写工具（如 `ha_call_service`）：绑定 `write_with_approval` 授权快照 + 参数 hash；
- `privileged`（如重启 HA、执行脚本）默认拒绝，仅由管理员通道放行。

优点：复用成熟的工具管线（审批、幂等、账本、限额）；模型只见白名单工具与授权实体；与 Loop 阶段计划同频演进。
缺点：Aervox 主动发起才有轮询能力（无事件面）；写操作天然串行、受 Loop 限额约束；不适合大批量状态抓取。

### 4.2 方案 B：独立物联网关 Service（事件订阅面）

在 Worker/Host 侧新增"HA 事件订阅器"：WebSocket 长连接订阅 `state_changed`，过滤授权实体，转为 Inbox `steer/inject`；读/写仍走方案 A 的工具。

优点：补足方案 A 缺的实时事件面；订阅器与 Loop 解耦，故障不影响 Turn 主流程；天然适配《5.5 事件订阅 → Inbox 注入》。
缺点：多一个长连接生命周期管理（认证、重连、背压）；阈值判定放在网关还是模型侧需要裁决，避免"持续噪音污染 Inbox"。

> 方案 A 与 B 不是互斥，而是推荐组合：**A 提供执行面，B 提供感知面**。

### 4.3 方案 C：HA Custom Integration（Aervox 作为 HA 里的集成）

把 Aervox 做成 HA Custom Integration / Dashboard，让用户在 HA 界面里配置 Aervox。

优点：HA 生态熟悉、事件天然即达。
缺点：反向依赖——Aervox 事实源与发布节奏会被 HA 侧拖住；双向数据回流 Aervox 数据库后再写回，反而破坏【1.3 不变量】；维护成本高。**否决**。

### 4.4 方案 D：CAP-020 运行时插件

把 HA 工具集做成插件包（Manifest + Config + Page 桥），由用户在设置里启用。

优点：与"双"启用方式的插件机制一致；边界清晰。
缺点：CAP-020 插件系统本身仍属候选、MVP 不承诺外部插件兼容（见[能力注册表 CAP-020](../reference/capability-registry.md#p2r4-连接智能化)）；HA 集成作为第一个插件客户会放大插件框架的未定型风险。**降级为远期载体**，配合【4.1】在插件框架稳定后迁移。

### 4.5 综合对比

| 维度 | A：Loop 工具 | B：事件网关 | C：Custom Integration | D：运行时插件 |
|---|---|---|---|---|
| 事件实时性 | 无（轮询） | 有（推送） | 有 | 无（无变化） |
| 权限映射 | 复用三级管线 | 独立 | HA 侧自治 | 复用管线 |
| 开发成本 | 低 | 中 | 高 | 中（受 CAP-020 拖累） |
| 安全边界 | 明确 | 需补 | 双向复杂 | 明确 |
| 对 Loop 演进的影响 | 同频受益 | 低 | 高 | 待定 |

**推荐结论**：R0 采用方案 A 覆盖读/写执行面；R1 叠加方案 B 提供事件感知面；方案 D 作为插件框架稳定后的迁移载体；方案 C 不进入候选。

## 5. 推荐设计要点（A+B 组合）

### 5.1 分层与组件

```text
Model / Loop（Turn/Step）
      │ 工具调用（A）
      ▼
HA 工具集（ToolSpec 注册于 apps/api/src/modules/tools/runtime.ts）
      │ 只读走已批准策略 │ 写走 write_with_approval 授权快照
      ▼
HA Client（REST + WebSocket，统一 Bearer 凭据）
      ▲
HA 事件订阅器（B）── state_changed ──> 授权实体过滤 ──> Inbox steer/inject ──> Loop
```

- `HA Client` 封装协议细节（认证、重连、超时、错误分类），对上层只暴露实体读取与服务调用；
- 事件订阅器独立于 Loop 运行，阈值与去重规则先硬编码、后策略化；
- 所有出入 HA 的调用都写入 `tool_executions` 账本（对齐 [AVX-HAR-001 §4](../reference/agent-harness-loop.md#4-核心对象) ToolExecution）。

### 5.2 认证与凭据治理

- 首选 OAuth 授权码流（可撤销、可刷新）；R0 允许 LLAT 过渡，但 UI 必须明示有效期与撤销路径；
- 凭据只存加密凭据存储，租户隔离；不进环境变量明文、不进日志、不进模型上下文；
- 撤销 = 停订阅器 + 清事件队列 + 删除实体目录缓存，回退由 [RecoveryControlLedger](../reference/adr/ADR-013-recovery-control-ledger.md)（`ADR-013`）记录。

### 5.3 授权与审批映射

| HA 操作 | 工具级别 | 审批 |
|---|---|---|
| 读实体状态/属性 | `read_only` | 已批准策略自动放行（实体白名单内） |
| 调用 domain/service（灯光、温控、窗帘等） | `write_with_approval` | 授权快照 + 参数 hash 匹配 |
| 执行脚本/自动化/重启 | `privileged` | 默认拒绝，仅管理员通道 |

实体白名单由用户在授权流程中勾选，`entity_id` 与 domain 白名单是同一安全边界，缺省 fail-closed。

### 5.4 幂等与限额

- `call_service` 幂等键建议 `attemptId:stepNo:callId`（对齐 [AVX-HAR-001 §9](../reference/agent-harness-loop.md#9-工具执行管线)）；HA 结果不可靠时回退 `ToolExecution unknown outcome` 收敛流程；
- 限额：单实体读 30 s（对齐 `maxToolDurationMs`），写调用串行；订阅器每实体每分钟事件去重上限，超出进入静默降采样并审计。

### 5.5 事件订阅 → Inbox 注入

- 只订阅用户授权实体；阈值场景（温度越界、漏水、门窗异常）才注入 Inbox，普通开关事件不注入；
- 注入项带 `source`、`occurredAt`、实体与保护级别，消费走既有 Inbox 消费闭环（阶段 5a），不改 Loop 状态机；
- 频控与免打扰复用 `CAP-030`（主动提醒深化）的口径，避免环境噪音变成默认打扰。

### 5.6 实体目录与防注入

- 实体属性是外部不可信输入：进入模型前做大小、敏感字段与 Prompt injection 检查（对齐 §9 结果安全门）；
- 目录缓存只存 entity_id、domain、device_class、受限属性，不缓存 Key/凭据；删除来源即失效。

## 6. 安全、隐私与数据

### 6.1 威胁模型新增项（进入编码前须补入 [THREAT_MODEL](../reference/THREAT_MODEL.md)）

| 威胁 | 控制 |
|---|---|
| LLAT/凭据泄露（日志、模型上下文、传输） | 加密存储、脱敏、TLS、凭据不出 UI 之外 |
| 未授权实体被模型读取 | 实体白名单 fail-closed + 审计 |
| 模型幻觉执行危险服务 | 写工具审批 + domain 白名单 + 参数校验 + 幂等 |
| HA 事件注入伪造状态 | 只信订阅器来源、校验 occurredAt、上限与去重 |
| 局域网内中间人 | 局域网 TLS、证书固定可选 |
| 撤销滞后导致残留执行 | 撤销即停订阅器与清缓存，走 RecoveryControlLedger |

### 6.2 数据分类与保留

- 新增数据实体：HA 租户配置（凭据引用）、实体目录缓存、事件注入记录；
- 事件注入记录视为低敏派生日志，保留期短（建议 ≤ 30 天），不进入学习事实；
- 凭据与实体白名单按 [DATA_PRIVACY](../reference/DATA_PRIVACY.md) 门禁评审后再建表。

### 6.3 撤销与删除

- 用户撤权 → 停止订阅器、清空事件队列与实体缓存、撤销 OAuth/删除 LLAT 引用（HA 侧重由用户执行）；
- 删除工作区 → 联动清理上述全部数据；不得保留影子副本。

### 6.4 未成年保护

学习陪伴场景下家庭环境感知需克制：默认只开放低敏实体（学习区照明、环境温度/湿度），默认不开启室内人员、摄像头、儿童房传感器；相关实体类型纳入"默认拒绝"清单，与[社交健康发展边界](../reference/PRD.md)一致。

## 7. 分阶段路线与 CAP 映射

### 7.1 能力基线建议

建议以新 CAP 承载（示例 `CAP-034`，"家庭环境接入"，最终编号在 CR 阶段与 ESP32 设备能力的 `CAP-033` 提议一并裁决），不静默扩写 `CAP-018/027`；若判定为纯工具集，也可暂不建 CAP、随 Loop 工具注册表演进，由 CR 裁决。

### 7.2 阶段表

| 阶段 | 交付 | 准入 | 退出 |
|---|---|---|---|
| R0（执行面） | 方案 A：HA Client + 只读工具 + 写工具审批 + 配置页面 | CR/ADR 批准、威胁与隐私评审 | 白名单内实体可查、授权服务可调、账本可查 |
| R1（感知面） | 方案 B：事件订阅器 + Inbox 注入 + 阈值去重 | R0 证据、频控口径（CAP-030 对齐） | 授权实体变化可注入、噪音受控、撤销即清 |
| R2（账户流） | OAuth 授权码流替代 LLAT、可撤销、多实例 | 账户与凭据评审 | 撤权/删除闭环、令牌轮换通过 |
| R3（生态） | 插件载体迁移（方案 D）、与 ESP32/Electron 联动 | 插件框架稳定（CAP-020） | 插件安装/卸载/回滚通过 |
| R4（智能） | 场景感知对话（如"学习时段自动调光"建议） | 阈值策略化、评估集 | 无未授权副作用、推荐可解释可关闭 |

### 7.3 需要建立的 CR 与 ADR（R0 编码前）

1. `CR-*`：登记受影响 CAP/FR/NFR/DATA/SEC/PRIV/OPS/AC/TC（对齐 [AGENTS.md 硬约束](../../AGENTS.md)）；
2. `ADR-*`：冻结 HA Client 接入形态（REST/WS、OAuth vs LLAT、凭据存储、实体白名单、事件订阅与 Inbox 语义）；
3. 数据字典与威胁模型更新，[DATA_PRIVACY 隐私门禁](../reference/DATA_PRIVACY.md#privacy-gates)评审后进入实现。

## 8. 未决问题

1. 写工具的授权粒度：按 domain（如 `light.*`）还是精确到 entity_id？（倾向 entity 粒度，需评审）
2. 事件阈值：硬编码先行还是首版就要策略化？
3. 多 HA 实例（书房/办公室/家庭）是否首版就要支持？
4. 是否复用 `插件生态` 的 `Page Bridge` 做配置页，还是先走现有设置体系（参考 `CR-014/015` 配置页模式）？
5. HA 版本漂移与实体兼容策略（HA 每季度频繁升级）。

## 9. 参考资料

- [Home Assistant REST API 官方文档](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant WebSocket API 官方文档](https://developers.home-assistant.io/docs/api/websocket/)
- [Home Assistant Authentication API 官方文档](https://developers.home-assistant.io/docs/auth_api/)
- [home-assistant-js-websocket（官方客户端库）](https://github.com/home-assistant/home-assistant-js-websocket)

仓库内事实源（外部资料只作产品与 API 事实；范围、权限、数据处理、威胁与门禁以仓库内文档为准）：[AVX-HAR-001](../reference/agent-harness-loop.md)、[能力注册表](../reference/capability-registry.md)、[ADR-008](../reference/adr/ADR-008-cloud-first-local-port.md)、[CR-015](../reference/changes/CR-015-llm-provider-config-webui.md)、[ESP32 硬件延伸](esp32-s3-hardware-extension.md)。
