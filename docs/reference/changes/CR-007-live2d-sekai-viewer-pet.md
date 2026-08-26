# CR-007 引入可替换 Live2D 桌宠渲染层

- 提出人：jiyun233 · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

> 文档编号：CR-007  
> 类型：Reference  
> 版本：v0.3  
> 更新日期：2026-08-26  
> 状态：More Evidence Required  
> 关联：[PRD](../PRD.md) · [架构设计](../ARCHITECTURE.md) · [需求追踪](../REQUIREMENTS_TRACEABILITY.md) · [CR-002](CR-002-fairy-desktop-module.md)

## 变更

- **原因**：将桌面端占位桌宠升级为可替换的 Live2D 表现层，并保留 Aervox 的桌面窗口、主题和 API 数据边界。
- **当前行为**：Electron 主工作台左侧区域不显示桌宠；独立 `PetWindow` 与 Web 工作台均使用共享 Live2D 控制层，资源加载失败、减少动画偏好或运行环境不支持时回退 `PetHero`。
- **目标行为**：Web 工作台显示居中、自适应容器的 Live2D；Electron 主工作台保持无左侧桌宠，独立 `PetWindow` 继续以 Pixi 7 + `@sekai-world/pixi-live2d-display-mulmotion` 加载模型描述。
- **兼容范围**：实现兼容同类 Cubism 3 `model3.json` 文件结构（`Version`、`FileReferences.Moc`、`Textures`、可选 Motions/Expressions/Physics），并提供 Aervox 自有解析、路径校验与控制器接口；不复制 Sekai Viewer 的业务代码。
- **完整表现接口**：支持标准动作组/表情索引与名称、外部动作元数据合并、自动呼吸、底层眨眼/物理、点击动作、注视点、口型参数和 SSE `emote/gesture/react/move` 命令映射；Mizuki 测试包额外提供 243 个身体动作、54 个 facial 动作的 TypeScript Enum，以及 `window.aervoxLive2D.playMotion/playExpression/playPose` API。
- **本次回归修复**：Electron 主页面补齐 Live2D 运行时脚本并将渲染器动态导入，避免共享 UI 在桌面主窗口白屏；Web 的桌宠显示不再受桌面端偏好开关影响；独立桌宠按可见模型边界重新居中，并将阴影锚定到舞台水平中心。
- **自适应布局重构**：Web 与 Electron 共享 `fitLive2DModelToViewport`，先以安全比例完整入镜，再扫描渲染结果的非透明像素范围计算缩放与中心，消除模型透明留白造成的左右偏移和尺寸失真。
- **范围外**：将 Project Sekai 模型文件复制进 Aervox、离线打包、商业再分发、Live2D 资产编辑、语音口型和系统级常驻权限。

## 许可证与资产边界

`sekai-viewer` 软件仓库为 GPL-3.0；本实现只借鉴其公开的 model3.json 加载形态，不复制其代码、角色模型或资源地址。底层运行库为 MIT 许可；Aervox 模型由 `DEFAULT_AERVOX_MODEL` 清单注入，正式资源可替换为拥有明确权利的本地或远程模型。

## UX、技术和安全影响

- Live2D 只负责表现，不拥有会话、学习、记忆、人格或隐私数据。
- API/SSE、IPC 隔离、`nodeIntegration=false`、`sandbox=true` 和 Web/Electron 工作台与独立桌宠窗口的边界不变。
- 资源不可用时显示本地占位形象，不伪造对话或业务状态；页面保留来源链接。
- `prefers-reduced-motion` 下不创建动画模型，确保无障碍降级。
- 固定资产：Mizuki `model3.json`、Moc、纹理、Physics、`BuildMotionData.json`、243 个动作文件和 54 个 facial 文件已固定到 `apps/desktop/src/renderer/public/live2d/mizuki/` 与 `apps/web/public/live2d/mizuki/`，默认模型直接使用 `/live2d/mizuki/mizuki.model3.json`。资产来源为 `storage.sekai.best` 的 `20mizuki_normal_3.0_t04` 条目；模型使用权和商业再分发许可仍需在正式发行前完成确认，并保留运行时许可清单、超时与缓存策略、资源预算、崩溃恢复和供应链扫描。

## 验证与回滚

- `mise x -- pnpm install`
- `mise x -- pnpm --filter @aervox/desktop typecheck`
- `mise x -- pnpm --filter @aervox/desktop build`
- `mise x -- pnpm typecheck`
- 固定资产完整性检查：模型清单引用的 Moc、纹理、Physics、243 个动作和 54 个 facial 文件全部存在；Web 与 Desktop 构建产物各包含 302 个模型文件。
- 本地 Web 工作台与 `http://localhost:5173/pet.html` 冒烟检查：Web 左侧显示 `Live2DPet` 且模型居中，独立桌宠页显示 Live2D；外部资源不可用时显示 `PetHero` 回退和降级日志。
- 回滚方式：移除 `Live2DPet` 引用和 Pixi 依赖，恢复 `PetHero`，不涉及数据迁移。

## 决策

More Evidence Required。代码原型已完成；模型资产许可、正式发行资源策略、运行时性能/崩溃恢复、Live2D 状态到 `emote/gesture` 的完整映射和自动化 Electron E2E 仍待评审。
