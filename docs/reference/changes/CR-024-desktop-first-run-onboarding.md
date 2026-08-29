---
id: CR-024
type: reference
scope: change
owner: desktop
doc_status: review-candidate
decision_status: proposed
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/SRS.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/changes/CR-007-live2d-sekai-viewer-pet.md
  - docs/reference/changes/CR-015-llm-provider-config-webui.md
---

# CR-024 桌面端首次启动引导

- 提出人：kikoyida · 2026-08-29
- 修改人：kikoyida · 2026-08-29

关联：[PRD CAP-001/018](../PRD.md#prd-cap-map)、[需求追踪](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)、[CR-007](CR-007-live2d-sekai-viewer-pet.md)、[CR-015](CR-015-llm-provider-config-webui.md)

## 变更原因

Electron 桌面端此前启动后直接进入工作台。新用户无法在第一次使用时理解 Aervox 的陪伴、主动智能、记忆与开放能力，也缺少在进入对话前完成大语言模型配置的连续入口。

## 目标行为

- 未完成引导的桌面端首次启动显示四步窗口内流程：品牌序章、主动智能概念、原生能力与生态、模型连接；
- 第一屏复用现有 Mizuki Live2D 渲染层；模型不可用或用户启用减少动态效果时使用静态回退，不阻断引导；
- 模型连接复用 CR-015 的提供商预设、连通性测试和配置保存 API，不新建第二份配置事实源；凭据存储边界以 CR-015 和当前服务部署方式为准，引导页不承诺仅在当前设备持久化；
- 保存模型配置成功后播放短暂启动过渡，再写入版本化的本机完成标记并进入工作台；保存失败时保留当前输入和错误提示，不结束引导；
- 用户可以选择快速开始。快速开始不创建虚假模型配置，只写入完成标记并进入工作台；
- 完成标记只控制当前设备是否展示引导，不进入学习记录、记忆、日记或租户数据；版本升级如需重新引导，必须使用新的完成标记版本。

## 验收边界

1. 空存储时展示引导；只有值严格为 `true` 的当前版本标记可跳过；
2. 提供商切换同步更新默认 Base URL 与推荐模型，用户仍可编辑自定义值；
3. 需要密钥的提供商在密钥为空时阻止测试和保存；Base URL 或模型 ID 为空时同样阻止；
4. 连通性失败和保存失败均在当前页面显示，不写完成标记；
5. 快速开始和保存成功最终都只写一次当前版本完成标记；
6. 动画遵守 `prefers-reduced-motion`，键盘左右键不拦截输入框内操作。

## 范围外与回滚

- 本变更不新增账户注册、云同步、隐私同意或人格问卷；这些流程必须单独立项；
- 不复制或迁移 CR-015 的 LLM 配置表、契约与 API；
- 回滚时移除 `OnboardingFlow` 挂载并直接显示工作台。既有本机完成标记可安全保留，模型配置不受影响。

## 原型结论与验证

- 视觉问题：首次启动如何同时体现桌面产品、陪伴角色与主动智能，而不呈现为网页落地页；
- 结论：采用四步电影化桌面序章；人物只出现在第一屏，能力页使用真实工作台结构作为证据，第四屏承担模型配置与启动过渡；
- 原型证据：`feat/onboarding-ui-prototype` 分支提交 `050f1f0`；
- 自动验证：桌面端首次启动状态单元测试、既有运行时配置单元测试、Vue/TypeScript 类型检查和文档门禁。
