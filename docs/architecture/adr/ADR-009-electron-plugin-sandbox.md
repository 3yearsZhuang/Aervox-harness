# ADR-009 Electron 最小权限壳与进程外插件

- 状态：Proposed（待安全负责人批准；R3/P2 前必须 Accepted）
- 日期：2026-08-23
- Owner：待指定
- 关联：`CAP-018/020/031`、`SEC-PLG-001`、`RISK-006`

## Context

桌面端需要托盘、通知和可选置顶；插件/DSH/pi 可能执行第三方代码。Electron renderer 和 Node `vm` 都不能被当作安全沙箱。

## Decision drivers

- renderer 与 Node `vm` 均不能作为可信沙箱；
- 第三方插件代码必须在进程外隔离并默认无权限；
- 插件需要可审计、可撤销、可 kill switch；
- MVP 核心端不能依赖任何插件/DSH/pi 运行时。

## Considered options

1. **最小权限壳 + 进程外插件（容器/microVM/受限子进程）**：安全边界清晰（选定）。
2. **仅 renderer 隔离**：实现简单，但 renderer 提权即失守。
3. **Node `vm` 沙箱执行插件**：开发快，但不满足隔离要求。
4. **直接执行本地脚本作为技能**：灵活，但风险不可控，不支持作为默认。

## Decision

Electron 启用 `contextIsolation`、关闭 `nodeIntegration`、schema 化 IPC、签名更新包和逐项 OS 授权。云端插件使用容器/microVM，桌面插件使用受限子进程；manifest 包含签名、权限、Host allowlist、资源配额、超时、撤销和全局 kill switch。插件写记忆只能提交候选。

## Positive consequences

- 安全边界明确，插件越权面受控；
- 插件可签名、审计、配额与一键撤销；
- 核心学习数据不被第三方插件持有。

## Negative consequences and risks

- 插件安装、更新、调试与跨端能力成本较高；
- 不支持任意本地脚本作为默认技能，能力受限；
- 沙箱/配额实现本身需要安全评审与演练。

## Migration / rollback

先发布无插件核心端；插件以 Feature Flag 和适配器灰度。发现越权时立即禁用单插件/全局 Host，保留核心学习数据；桌面包更新可回滚到签名旧版。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- IPC、文件/网络/进程逃逸与 Prompt injection 测试（`TC-SEC-PLUG-001`）；
- 恶意包、资源耗尽、撤权与 kill switch 测试（`TC-SEC-DESKTOP-001`）；
- 无插件核心端 Playwright 流程回归（`TC-E2E-COMPAT-001`）。
