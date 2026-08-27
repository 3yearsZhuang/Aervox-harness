# CR-011 WebUI 语音输出配置（设置 + 人格语音；目录选择）

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：CR-011
> 类型：Reference
> 版本：v0.4
> 更新日期：2026-08-28
> 状态：Review Candidate
> 关联：[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)、[Persona 重构与独立 Voice 模块](../changes/CR-004-persona-sqlite-persistence.md)、[ADR-003](../adr/ADR-003-postgres-retrieval.md)

- 状态：Implemented（待发布评审）
- 提出人 / 日期：3yearszhuang / 2026-08-28
- 目标版本：当前开发阶段（系统语音输出能力）
- 变更原因与证据：系统语音输出能力（`apps/api/src/modules/voice/`）的本地 provider `GptSovitsLocalProvider` 的 `modelPath/modelId` 由 env 在启动时写死，WebUI 缺少运行时可配置与可持久化的本地语音模型设置；人格编辑弹窗缺少选择语音文件的能力；本地模型路径与音色此前为手输，需改由「选择文件夹」获得。分三阶段落地：阶段 1 设置「语音」分类（本地模型配置 + 白名单 + 持久化）；阶段 2 人格编辑弹窗「语音」能力块（provider/model/speaker + 试听）；阶段 3 模型路径与音色改为系统目录选择（Electron `dialog` 桥 + `pickDirectory`）。参考了既有 Persona 设置的 DB 仓储 + 契约 + UI 组合式 API 落地范式（CR-006/CR-010），原生实现，无外部依赖新增。
- 关联能力与需求：`CAP-019/020`（含独立 Voice 模块）
- 当前行为 / 目标行为：
  - 当前（阶段 1 前）：本地语音模型配置仅能通过 env（`GPT_SOVITS_MODEL_PATH` 等）在启动时设定，无运行时/持久化配置，WebUI 设置无「语音」分类，人格编辑弹窗无语音选择，模型路径与音色需手输；
  - 目标：
    1. 设置新增「语音」分类，面向 `gpt-sovits-local` 配置本地模型路径（受 `allowedRoots` 白名单约束）、模型 ID、音色（speaker）并支持试听；持久化到新增表 `voice_configs`，经 `GET/PUT /v1/voice/config` 读写，按 `(workspace_id, subject_user_id)` 租户隔离；保存后同步本地 provider 生效配置（阶段 1 已完成）；
    2. 人格编辑弹窗新增「语音」能力块，写入 `PersonaRevisionConfig.voice`（enabled/provider/model/speaker + 试听；未启用时交回 undefined 不落库），编辑时回填既有配置（阶段 2 已完成）；
    3. 模型路径与音色均支持**手动输入 + 系统「选择文件夹」并存**（Electron 主进程 `dialog.showOpenDialog` → preload `pickDirectory` → `useAervoxVoice.pickDirectory`），选择音色目录时取其目录名作为 speakerId；Web 无桥环境按钮置灰但仍可直接手输（阶段 3 已完成）。
- 范围外：远程 provider 运行时配置。
- UX/API/数据/AI/安全/隐私影响：
  - API：新增 `GET/PUT /v1/voice/config`（阶段 1）；人格读写复用既有 `POST/PATCH /v1/personas` 的 `config.voice`（既有契约，无需新增 API）；
  - 桌面桥：新增 IPC `dialog:pick-directory` 与 preload `dialog-api.ts`（阶段 3）；
  - 数据：新增 `voice_configs` 表（唯一索引 `voice_configs_tenant_unique_idx`，每租户一行）；人格语音配置随 `persona_revision_configs` 持久化（既有表）；
  - 安全：`modelPath` 服务端按本地 provider `allowedRoots` 白名单校验且须存在，否则 400（`INVALID_VOICE_CONFIG`）；目录选择仅返回路径文本，不读取目录内容；
  - 隐私：配置按租户存储，不跨租户可见。
- 迁移与向后兼容：新表 `CREATE TABLE IF NOT EXISTS`，老库自动补齐；远程 provider 仍由 env 管理，行为不变；既有 `/v1/voice/models`、`/v1/voice/synthesize`、人格路由与契约不改动；`fairyDesktop` 桥 `pickDirectory` 为可选字段，旧 preload 兼容。
- 测试、埋点和验收影响：`packages/database/test/voice-config.test.ts`、`apps/api/test/voice-config.test.ts`（get/set、白名单外路径 400、保存后本地 provider 生效）；UI 通过 `@aervox/ui` typecheck/build、Web/Desktop typecheck/build 验证。
- 风险与成本：本地模型路径白名单误判可能导致配置被拒；试听依赖本地 provider 可用，不可用时由后端返回 503 并在 UI 提示；Web 浏览器无系统目录选择能力（预期降级）。
- 灰度、回滚和用户通知：功能随 API/UI 一起发布；设置「语音」分类与人格弹窗「语音」能力块可关闭回退，不影响既有语音合成与人格路由。
- 决策：Implemented
- 修改人 / 日期：
- 更新的文档和测试：`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`（§4.2 落地登记）
- 发布后结果：待发布
