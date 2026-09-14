---
id: CR-034
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 1.0.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
review_triggers:
  - packages/config/src/index.ts
  - packages/contracts/src/model-routing-schemas.ts
  - packages/schema/src/model-routing.ts
  - packages/repositories/src/repositories/sqlite/model-routing-repository.ts
  - apps/api/src/modules/llm/health-prober.ts
  - apps/api/src/modules/llm/degradation-service.ts
  - apps/api/src/modules/conversation/agent-executor.ts
sources:
  - docs/reference/PRD.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/changes/CR-015-llm-provider-config-webui.md
  - docs/reference/adr/ADR-005-provider-port.md
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-032-proactive-intelligence-plugin-ecosystem.md
  - docs/reference/changes/CR-014-voice-config-webui.md
  - docs/reference/changes/CR-042-local-model-routing-and-fallback.md
  - docs/reference/changes/CR-043-local-model-capability-tiering.md
  - docs/reference/changes/CR-044-deterministic-rule-response.md
  - docs/reference/changes/CR-045-local-model-runtime-lifecycle-host.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/capability-registry.md
---

# CR-034 本地模型降级阶梯：无 API 接入时的原生能力基线

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

关联：[PRD](../PRD.md) · [需求追踪基线](../REQUIREMENTS_TRACEABILITY.md#11-变更控制) · [CR-015 模型供应商配置](CR-015-llm-provider-config-webui.md) · [ADR-005 Provider Port](../adr/ADR-005-provider-port.md) · [CR-033 主动智能终局架构](CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md) · [CR-032 插件化生态](CR-032-proactive-intelligence-plugin-ecosystem.md) · [CR-014 本地语音配置](CR-014-voice-config-webui.md) · [数据与隐私](../DATA_PRIVACY.md) · [能力注册表](../capability-registry.md)

- 状态：Accepted / Implemented
- 提出人 / 日期：3yearszhuang / 2026-09-14
- 目标版本：R3 主动智能演进阶段
- 关联能力：`CAP-020`（技能/插件系统）、`CAP-013`（流式对话与 Agent Loop）、`CAP-009`（日记）、`CAP-033`（全域感知与个人画像）、`CAP-019`（桌宠交互）

---

## 1. 变更背景与驱动因素

### 1.1 现状盘点：本地模型地基已备，降级编排缺位

本仓库的模型供给缝隙从设计上就是本地友好的：`createOpenAICompatProvider` 是 Agent Loop 的**唯一**模型契约（`@aervox/agent-loop`，ADR-005 Provider Port），Ollama、LM Studio、llama.cpp server 等一切 OpenAI 兼容运行时均为「一份配置」即可接入；`llm_configs` 已是多预设 + 激活切换 + 连通性测试的结构。此外一批链路已经本地化：日记生成在无配置行时默认走 Ollama 缺省预设、显式禁用才落模板（诚实降级先例）；主动关怀话术复用同一端口语义（CR-032）；语音 ASR/TTS 本地双模式（CR-014/016）；检索 embedding 默认本地特征哈希（T-05）；检索、画像、规则引擎、裁决器全部为纯本地确定性引擎。

**真正的问题是编排缺位**：

1. **对话主链路没有降级**：未配置 LLM 或供应商不可达时，对话回合直接失败——断网时思隅在对话里是「哑」的，与主动侧、日记侧已具备的降级能力形成断裂；
2. **没有降级决策器**：L0（云端）与 L1（本地端点）之间无健康探测、无自动切换、无恢复回切；`llm_configs` 的连通性测试是手动按钮，不是运行时探测；
3. **没有能力分级**：本地小模型的 tool calling 不可靠，降级到 L1 后若仍按全能力运行，Agent Loop 多步工具调用会不可预期地失败；
4. **无运行时生命周期托管**：Ollama 未安装/未启动/模型未下载时，用户没有任何引导路径，L1 实际不可达；
5. **降级不可见**：即便切到本地模型，UI 也无诚实标识，用户对质量衰减没有预期管理。

### 1.2 为什么这是原生能力，而非插件

本 CR 确立一条架构裁决：**模型供给与降级决策是内核原生能力，永不插件化**。理由：

1. **分层归属**：模型是思隅的「心脏」，插件管场景不管心脏——与 CR-033「内核四项不变量」同构，谁掌握降级切换权，谁就掌握产品可用性；
2. **产品承诺**：「断网不哑」是 local_only 叙事的组成部分，L2 规则回应必须**永远存在**——承诺级能力不能取决于用户是否安装了某个插件；
3. **仓库先例**：本地语音（CR-014/016）即以原生能力落地；模型供给缝隙（OpenAI 兼容 + `llm_configs`）本就是原生的；
4. **供给链安全**：模型二进制的下载、校验、来源可信属供应链问题，走受治白名单而非插件发布生态（ADR-009 的不可信资产隔离哲学同理）；
5. **成本**：要新建的恰恰是内核件（决策器、能力分级）；插件化反而需要先造「provider 扩展点」新契约面，负收益。

插件生态的位置因此明确：**插件消费模型层，不供给模型层**——离线场景类插件调用内核既有 LLM 端口；未来若需支持非 OpenAI 兼容运行时，走 `agent-loop` provider port 的受治扩展（新增 provider），仍是内核演进。

## 2. 目标形态：三层降级阶梯

| 层级 | 名称 | 触发条件 | 能力范围 | 标识 |
|---|---|---|---|---|
| L0 | 云端模型 | 激活的 API 预设健康（配置存在且探测通过） | 全能力（工具调用、教学模式、长上下文） | 无特殊标识 |
| L1 | 本地模型 | L0 不可用，且存在可用的本地端点（探测通过） | 收紧能力集：工具白名单收紧、教学模式标注降质、主动关怀与闲聊陪伴全量可用 | 状态栏「本地模型 · 降级中」诚实标识 |
| L2 | 规则回应 | L0 与 L1 均不可用 | 模板/规则话术（主动侧与日记侧既有先例扩展到对话侧）；主动智能确定性引擎不受影响 | 「离线模式」标识 |

阶梯语义：

- **会话级粘滞**：降级切换按会话粘滞而非逐回合探测，避免体验抖动；健康探测节流执行（复用 `llm_configs` 连通性测试的探测逻辑，后台化）；
- **恢复回切**：高层恢复（探测连续 N 次通过）后新回合回切，进行中的回合不中断；
- **每层诚实**：L1/L2 的每一回合都携带降级来源标识，UI 状态栏与气泡元数据双通道可见；日志与账本同步留痕；
- **主动侧不动摇**：主动关怀、提醒、裁决的确定性引擎（CR-032）不依赖任何模型层，L2 下依然完整工作——「断网不哑」的最底线由规则引擎兜底。

## 3. 详细设计方向

### 3.1 降级决策器（内核组件）

- 位置：`apps/api` LLM 域新增 `LlmDegradationService`（与 `LLMConfigService` 并列），Agent Loop 装配层从「读激活配置」改为「向决策器要当前生效配置」；
- 决策输入：激活配置存在性、探测结果（复用连通性测试端点的探测逻辑，节流后台化）、本地端点可用性（`llm_configs` 中 `provider` 标记为本地类或端点为回环地址的预设）、当前会话粘滞状态；
- 决策输出：`{tier: L0|L1|L2, config, reason}`，切层与回切均写审计与日志；
- **降级参数用户可控**：设置面板可关闭 L1 自动降级（仅手动切换）、可固定锁定某层——默认全自动。

### 3.2 能力分级（Capability Tiering）

- 能力等级模型：`full`（L0）→ `restricted`（L1：工具白名单收紧至只读、教学模式入口标注「建议接入云端」、生成预算下调）→ `minimal`（L2：无模型生成，规则回应）；
- Agent Loop 装配层按等级过滤工具白名单与 System Prompt 组装策略；主动组合器按等级选择提示词与模板；
- 分级声明在 `@aervox/contracts` 契约化（端点返回当前能力等级，前端据此渲染 UI 状态与入口可用性）。

### 3.3 对话侧 L2 规则回应（补齐最大空洞）

- 对话域新增规则回应通道：完全无模型时的确定性话术（问候、陪聊骨架、引导性话术 + 主动智能事件的推送播报），风格与人格管线一致但明确标注「离线回应」；
- 复用 CR-033 P5 的方向：规则回应模板纳入人格管线的统一管理，避免出现「第二人格」。

### 3.4 本地运行时生命周期托管（可选增强层，默认关闭）

- 定位：**原生可选增强**，帮助用户从零到达 L1——检测 Ollama 是否安装/运行、按需拉起、引导下载推荐模型（含体积与用途说明）、一键写入 `llm_configs` 预设；
- 边界：宿主**不内嵌推理引擎**（不引入 llama.cpp 等嵌入式运行时——破坏「薄宿主 + 外部进程」边界与包体积）；托管只编排外部进程与配置写入；
- 模型推荐分层：闲聊陪伴 3~4B（默认推荐）、教学/工具 7~8B+（标注完整体验建议云端）；下载来源走官方渠道 URL 白名单 + 校验和验证（供给链安全）；
- 推理服务本身永远原生供给，本层只做「让 L1 可达」的运维编排。

### 3.5 诚实标识与可解释

- 每回合的降级层级写入流事件元数据与日志；UI 状态栏常显当前层级；降级切换事件（切层原因、时间）进设置面板可查；
- 教学模式等高质量场景在 L1 下主动建议回切云端，而非静默衰减。

## 4. 当前行为 vs 目标行为

| 维度 | 当前行为 | 目标行为 |
|---|---|---|
| 无 LLM 配置时对话 | 回合失败，对话哑火 | L2 规则回应（诚实标注离线），L1 可达时自动上探 |
| 云端不可达 | 回合失败 | 会话粘滞切 L1（本地端点），恢复后回切 |
| 降级可见性 | 无 | 状态栏层级常显 + 切层留痕可查 |
| 本地模型接入 | 手动配置 OpenAI 兼容端点 | 不变（配置即用），增加可选的运行时托管引导 |
| 本地模型 tool calling | 按全能力运行，多步调用不可预期 | 能力分级：L1 收紧工具白名单，教学模式标注 |
| 日记/主动话术 | 已有 Ollama 缺省 + 模板降级 | 不变，纳入统一层级标识 |
| 语音/检索/画像/裁决 | 本地 | 不变 |

## 5. 演进路线（各片独立立项、独立验收）

| 阶段 | 内容 | 验收要点 |
|---|---|---|
| N1 | 降级决策器 + L1 切换：探测后台化、会话粘滞切层与回切、诚实标识 | 探测节流可配置；切层/回切测试（模拟端点失效与恢复）；UI 标识契约测试 |
| N2 | 能力分级 + 对话侧 L2：等级契约化、工具白名单收紧、对话规则回应通道 | 等级过滤测试（L1 下写工具/敏感工具不可达）；L2 回应的人格一致性抽检；全链路「零模型」场景测试 |
| N3 | 运行时生命周期托管（可选增强）：Ollama 检测/拉起/模型引导/预设一键写入 | 下载来源白名单与校验和验证；托管默认关闭开关；引导流程端到端测试 |

排序原则：N1 → N2 为主干（N1 是 N2 的前提）；N3 独立可延后；三片均为原生内核增量，不引入插件契约变更。

## 6. 受影响模块与契约面（终态视图）

- `@aervox/contracts`：能力等级类型、降级层级与切换事件、L2 回应事件元数据；
- `apps/api`：`LlmDegradationService`、对话域 L2 回应通道、流事件元数据扩展；
- `packages/agent-loop`：装配层按能力等级过滤工具白名单与提示词策略（provider 契约不变，仍单一 OpenAI 兼容）；
- `packages/ui` + `apps/desktop`：状态栏层级常显、切层通知、托管引导向导（N3）；
- `packages/schema` + `packages/repositories`：切层审计与账本留痕（主库；不涉 vault）。

## 7. 范围外

- 宿主内嵌推理引擎（llama.cpp 嵌入、模型二进制随包分发）；
- 模型供给的插件化或「provider 插件扩展点」（见 §1.2 裁决）；
- 非聊天模态的本地化（本地图像生成、本地 OCR 之外的感知增强）；
- 多模型并行负载均衡、模型微调与训练；
- 云端供应商的新增协议适配（anthropic 等仍不在 Provider Port 范围，属 ADR-005 的独立演进）。

## 8. 安全、隐私与信任影响

- **供给链**：模型下载仅走官方渠道白名单 + 校验和；`llm_configs` 的端点写入保持既有权限面，托管引导不得绕过用户确认；
- **隐私正向收益**：L1/L2 全链路数据不出本机，降级态是隐私姿态最强的运行态；降级不改变 CR-023/CR-033 的 local_only 边界与导出/撤销权；
- **诚实标识即信任**：降级层级对用户全程可见，杜绝「静默降质」；切层决策全留痕可查；
- **能力分级即安全**：L1 收紧工具面与「低能力模型不给高权限工具」原则一致，与 ADR-009 的最小权限哲学同向。

## 9. 风险、成本、灰度与回滚

| 风险 | 缓解 |
|---|---|
| 本地小模型质量不达预期引发口碑反噬 | 诚实标识 + 场景分层推荐（陪伴先上、教学标注）；N3 引导页明示模型体积与用途 |
| 探测抖动导致层级反复切换 | 会话粘滞 + 连续 N 次探测才切层 + 节流；切层有迟滞窗口 |
| Ollama 并发串行造成主动话术与对话排队 | N1 先按「对话优先」排队；N3 托管层暴露并发参数；CR-033 的主动侧确定性引擎不受影响 |
| 工具白名单收紧破坏既有插件场景 | 分级只降不增；L0 行为完全不变；插件文档标注各等级兼容性 |
| 托管引导下载大体积模型体验差 | N3 独立可延后；提供「跳过，稍后手动配置」路径 |

回滚原则：N1/N2 均带 Feature Flag（决策器可退回「仅激活配置」的现行行为）；L2 回应通道独立开关；N3 默认关闭，整层可移除；全链路不引入破坏性 schema 变更（新增列/表均幂等补齐）。

## 10. 与既有基线的关系（差量单声明）

- 对 **ADR-005 / CR-015**：Provider Port 单一 OpenAI 兼容契约与多预设结构**全部继承**，本 CR 只在其上叠加决策器与分级，不新增 provider 形态；
- 对 **CR-033**：L1/L2 是其「人格同源」与「内核不变量」在模型层的落地；能力分级与 CR-033 P4 干预预算共享「内核裁决、诚实可解释」的哲学；主动侧确定性引擎语义不变；
- 对 **CR-032**：主动话术组合器从「读激活配置」改为「向决策器要当前生效配置」，模板降级语义不变；
- 对 **CR-014/016**：本地语音与本地模型共同构成「无 API 完整体验」的两大本地支柱，模式一致（原生 + 引导 + 白名单）；
- 对 **CAP-013/009**：对话与日记的降级行为按本 CR 统一，验收随各切片登记至追踪基线 §4.2。
- 后续 N1/N2/N3 立项时以本 CR 为引用基线，各自携带实现级契约与验收细节。

## 11. 落地进展与子 CR 映射

- **F0/F1 共享契约与底座**：已在 `@aervox/config`（独立 Feature Flag）、`@aervox/contracts`（`model-routing-schemas.ts` 与 OpenAPI）、`@aervox/schema`（`llm_health_snapshots` / `llm_routing_events`）、`@aervox/repositories`（`SqliteModelRoutingRepository`）落地。
- **N1 降级决策器与健康路由**：承接为 [CR-042](CR-042-local-model-routing-and-fallback.md)（Accepted / Verified），落地 `LlmHealthProber` 与 `LlmDegradationService`，支持会话粘滞、迟滞阈值、连续成功恢复回切与诚实标识。
- **N2a 能力分级与服务端工具收紧**：承接为 [CR-043](CR-043-local-model-capability-tiering.md)（Accepted / Planned）。
- **N2b 对话侧 L2 确定性规则回应**：承接为 [CR-044](CR-044-deterministic-rule-response.md)（Accepted / Planned）。
- **N3 本地模型运行时生命周期托管**：承接为 [CR-045](CR-045-local-model-runtime-lifecycle-host.md)（Accepted / Planned）。
