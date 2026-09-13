---
id: AVX-GUIDE-007
type: how-to
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.0
updated_at: 2026-09-13
reviewed_at: 2026-09-13
review_interval_days: 90
review_triggers:
  - docs/reference/PRD.md
  - docs/reference/SRS.md
  - docs/reference/capability-registry.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
sources:
  - docs/reference/PRD.md
  - docs/reference/SRS.md
  - docs/reference/capability-registry.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/how-to/engineering-process.md
---

# 操作指南：新增与规格化 CAP 业务能力

- 提出人：3yearszhuang · 2026-09-13
- 修改人：3yearszhuang · 2026-09-13

关联：[PRD](../reference/PRD.md) · [SRS 原子需求](../reference/SRS.md) · [能力注册表](../reference/capability-registry.md) · [需求追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md) · [工程与发布流程](engineering-process.md#1-新增与修改需求)

本指南指导产品经理、架构师与开发人员如何在 Aervox 中立项、规格化、推进并落地一个全新的业务能力（Capability，简称 CAP）。能力与原子需求的权威定义以 [PRD.md](../reference/PRD.md) 和 [REQUIREMENTS_TRACEABILITY.md](../reference/REQUIREMENTS_TRACEABILITY.md) 为准，本页聚焦操作步骤。

## 目标与前置条件

- **适用场景**：规划全新的用户可见业务功能或核心子系统（如新增跨端同步、新增专项学科评估、接入外部新生态）；
- **核心原则**：
  - CAP 是面向用户或端到端场景的最小业务闭环单位，**禁止**将单一数据表、单一 API 路由或单个 UI 按钮单独作为 CAP；
  - 需求推进遵循严格的生命周期：`Mapped`（规划）→ `DoR`（就绪评审）→ `In Development`（开发中）→ `DoD`（验收完成）→ `Released`（发布）。

## 步骤

### 第一步：分配 CAP 编号与确认依赖

1. **查阅现有能力编号**：
   查看 [能力注册表](../reference/capability-registry.md) 与 [需求追踪基线 §4](../reference/REQUIREMENTS_TRACEABILITY.md#4-cap-001cap-035-覆盖矩阵全部能力状态唯一速览)，获取下一个递增的 `CAP-###` 编号（例如 `CAP-036`）。编号分配后永久固定，不得复用。
2. **确定能力交付批次与依赖顺序**：
   查阅追踪基线 §4.1 的批次划分原则。新能力必须理清前置依赖（例如：依赖对话 Turn、依赖记忆树存储、还是依赖桌面端权限代理）。无前置依赖支撑的能力不得跨批次提前立项。

### 第二步：在 PRD 中定义用户价值与场景

在 [PRD.md](../reference/PRD.md) 中补充能力定义：

1. **定位能力归属**：将能力划分至对应章节（如 §3 核心交互、§4 学习系统、§5 记忆系统或 §16 能力全景）；
2. **描述 3 个核心要素**：
   - **用户问题与痛点**：该能力解决什么具体问题？
   - **核心交互流程**：桌宠入口、工作台界面或后台静默任务的交互体验是什么？
   - **非功能约束（NFR）**：离线可用性、响应时间上限（P95）、本地私密边界等。

### 第三步：在 SRS 中拆解原子需求与验收条件

将宏观的 CAP 拆解为可开发的原子需求项（见 [SRS.md](../reference/SRS.md)）：

1. **定义功能需求（FR）与业务规则（BR）**：
   - 编写 `FR-XXX-###`：定义具体的系统动作与输入输出；
   - 编写 `BR-XXX-###`：定义不可逾越的业务约束（如：离线状态不发起外网请求、删除即物理清除等）。
2. **编写可执行的验收标准（AC）**：
   每个 FR 必须至少配对 1 个遵循 Given-When-Then 格式的 `AC-*` 验收条件，例如：

   ```text
   Given 用户已启用本地离线模式
   When 用户点击触发语音识别
   Then 客户端必须调用本地 whisper.cpp 进程，网络抓包显示 0 字节外网出站流量
   ```

### 第四步：在追踪基线 §4 矩阵中立项

打开 [需求追踪与交付基线](../reference/REQUIREMENTS_TRACEABILITY.md)，在 **§4 能力矩阵** 中追加对应行：

| 字段 | 填写要求 | 示例 |
|---|---|---|
| **CAP 编号** | `CAP-###` | `CAP-036` |
| **能力名称** | 准确的业务中英文名称 | 本地离线 OCR 文档切片（Offline Document OCR Slicer） |
| **所属批次** | 对齐 §4.1 规划 | `第四批（R4）` |
| **原子需求清单** | 关联的 SRS 编号 | `FR-OCR-001`, `AC-FR-OCR-001-01` |
| **当前状态** | 初始统一为 `Mapped` | `Mapped` |
| **DoR 审查** | 记录是否已具备契约/数据模型/权限评审 | `Pending DoR` |

### 第五步：推进 DoR 评审进入开发

进入代码编写前，该 CAP 必须通过就绪门禁（Definition of Ready）：

1. **契约就绪**：在 `@aervox/contracts` 中定义好 Zod Schema 与 OpenAPI 片段；
2. **存储就绪**：若涉及落表，在 `@aervox/schema` 中声明 DDL 并在 [数据库矩阵](../reference/database-coverage-matrix.md) 中登记；
3. **安全与隐私就绪**：明确数据是留在本地还是出网，是否需要用户风险确认。

DoR 评审通过后，追踪矩阵状态改为 `In Development`。

### 第六步：代码落地与 §4.2 终态闭环

开发完成并通过自动化测试后，执行闭环操作：

1. **回填落地登记**：
   在追踪基线 **§4.2 落地实现登记** 表格最上方追加落地记录：
   - 登记完整实现文件路径、完成日期、自动化测试验证结果与来源（原生 / 借鉴编号）。
2. **推进 DoD 验收**：
   将 §4 矩阵的 `当前状态` 推进为 `Verified` 或 `Implemented`，并在 `落地` 列标记 `✔`。

## 验证与门禁

立项与规格化文档完成后，在本地执行验证：

```bash
# 1. 自动同步核验日期
mise tasks run docs-sync

# 2. 刷新机器目录
mise tasks run docs-catalog

# 3. 运行严格文档门禁
mise tasks run ci-docs
```

## 常见问题与陷阱

1. **孤立需求**：在 SRS 中写了需求，但未在 PRD 或追踪基线中建立双向引用。
2. **模糊验收**：AC 描述为“体验流畅、效果良好”等不可测字眼。必须量化为具体事件、返回值或毫秒数值。
3. **跳过 DoR 直接写代码**：未评审数据契约和权限边界直接在 API 中拼装接口，极易导致架构漂移被 PR 驳回。
