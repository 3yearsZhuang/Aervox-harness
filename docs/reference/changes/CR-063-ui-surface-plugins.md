---
id: CR-063
type: reference
scope: change
owner: frontend
doc_status: review-candidate
decision_status: accepted
delivery_status: planned
version: 0.1.0
updated_at: 2026-10-12
reviewed_at: 2026-10-12
review_interval_days: 90
sources:
  - docs/reference/ARCHITECTURE.md
  - docs/reference/plugin-config-and-pages.md
  - docs/reference/capability-composition.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-063 根界面插件与薄平台宿主

## 1. 决策与范围

维护者于 2026-10-12 授权新建分支实施界面插件化。取号已核对归档目录最大编号 CR-059、主仓 CR-060/061 及并行工作中的 CR-062。本次交付首个切片：工作台和独立桌宠根界面作为随应用构建的第一方插件，由各端组合根选择并交给通用界面宿主加载。当前队列见[根计划](../../../plan.md)。

标准产品继续内置 P0 学习与陪伴能力。保持 Vue 单栈、本地 SQLite、API 与数据权利边界；保留窗口、受限 IPC、连接认证及新手引导的宿主责任。移动端复用 Web 入口，不提升原生平台交付状态。CLI 命令插件、各业务面板进一步拆分和第三方代码独立安装不属于本切片。

## 2. 行为差量

- 原 Web/桌面直接挂载共享工作台，桌宠直接挂载端内组件；改为组合根显式选择界面插件，通用宿主加载根组件。
- 新增独立 `@aervox/ui-host`：版本与平台匹配、异步加载、失败/超时提示、重试与用户触发的窗口重新加载、实例取消信号与 Vue 卸载。不依赖工作台上下文、业务组件、API 或具体插件。
- 工作台组合逻辑迁入 `plugins/workbench-ui`；桌宠根组件、快捷对话与姿态逻辑迁入 `plugins/companion-ui`。共享展示组件、工作台服务及主题继续由 `@aervox/ui` 公共出口提供。
- UI 插件定义区别于可安装的 `PluginManifest`，仅允许受信构建输入，不读取用户提供的代码 URL，不进入插件市场启停记录或声明式分发包。
- 界面卸载会中止该实例的对话订阅并清理监听和定时器；不会替用户取消已受理的服务端回合、删除数据或撤销权限。

## 3. 验证与回滚

验证替代根组件真实渲染、平台与版本不匹配拒绝、加载失败重试、加载超时、旧加载迟到、卸载取消与多窗口实例隔离；复用工作台与桌宠回归，构建 Web 与桌面产物并运行完整代码和文档门禁。共享包不得反向依赖插件或宿主，插件只使用公共包出口。

失败时保留宿主提示与重试入口，旧实例不得覆盖当前界面。回退本次代码与锁文件即可恢复原入口，无数据迁移。Vue 错误边界不承担第三方权限隔离或同步死循环防护，独立安装与升级回滚仍需后续合同。
