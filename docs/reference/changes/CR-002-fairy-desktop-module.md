# CR-002 引入 Fairy Agent Electron 桌面端

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

> 更新日期：2026-08-31

- 状态：More Evidence Required
- 提出人 / 日期：Codex / 2026-08-24
- 目标版本：R3 原型验证（CAP-018）
- 变更原因与证据：用户要求将本地 `fairy-agent` 的 Electron/Vue 桌面 UI 与桌宠体验接入 Aervox；现已将 UI 源码移植到主仓 `apps/desktop`，原目标仓库仅作为实现来源，不再作为运行时或 Git 子模块依赖。
- 关联能力与需求：`CAP-018`、`CAP-001`、`CAP-002`、`CAP-008`、`FR-UX-001`、`FR-UX-003`、`FR-UX-004`、`NFR-A11Y-001`、`NFR-SEC-001`、`SEC-TEN-001`、`ADR-002`、`ADR-009`、`AVX-CAP-001`
- 当前行为 / 目标行为：主仓通过 `apps/desktop` 的 `@aervox/desktop` Electron/Vue 应用提供桌面入口和桌宠窗口，并通过 Aervox `/v1` Turn/SSE 接口承载对话；桌宠窗口为表现层，不拥有核心业务数据。
- 范围外：Live2D 正式模型、系统级常驻/开机启动、屏幕/麦克风/摄像头捕获、插件执行、本地数据真源、日记/记忆独立存储、真实模型直连。
- UX/API/数据/AI/安全/隐私影响：UI 复用 Fairy Agent 的桌面与桌宠表现；对话改用 Aervox contracts 的 POST Turn + Fetch SSE；模块不直接写 PostgreSQL，不保存核心会话副本；IPC 保持 contextIsolation、nodeIntegration=false、sandbox=true，仅暴露 schema 化窗口/主题操作；通知、置顶等权限默认关闭并逐项授权。
- 迁移与向后兼容：新增入口不改变 Web/API 数据模型；API 不可用时桌面端显示可重试故障态，不伪造已完成回答；桌面端可单独构建/启动，核心 API 仍可构建运行。
- 测试、埋点和验收影响：模块自身执行 typecheck/build；主仓执行 workspace build/typecheck；补充 Electron IPC、renderer 安全、API SSE framing/重连、重复提交、撤权断流、键盘可达和模块禁用测试证据。
- 风险与成本：源 UI 原先为内存占位聊天，已移除本地假回复并适配 Aervox API；Electron 依赖版本与 Node 24 兼容性需验证；第三方依赖执行许可证/漏洞扫描。
- 灰度、回滚和用户通知：默认不加入核心默认产物；通过桌面构建开关灰度。构建或运行失败时禁用模块并保留 Web/API；不执行不可逆数据迁移。
- 决策：More Evidence Required（代码、契约、构建和基础联调证据已完成；平台签名、权限矩阵、崩溃恢复、可执行安全/E2E 测试仍需评审）
- 更新的文档和测试：`docs/reference/capability-registry.md`、`docs/DOC_REGISTRY.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`、`.github/workflows/ci.yml`、模块测试与集成证据（实施后回填）
- 已完成证据：主仓 `pnpm install`、`pnpm typecheck`、`pnpm build`；API POST Turn/SSE 联调；Electron preview 双窗口启动；`apps/desktop` 普通源码目录构建通过。
- 发布后结果：待发布
