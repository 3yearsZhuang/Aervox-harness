# ADR-010 DSH/pi 仅为可选适配器

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

- 状态：Proposed（P2 前必须 Accepted）
- 日期：2026-08-23
- 关联：`CAP-020`、`CAP-027`、`RISK-006/010`

## Context

本文中的 `DSH` 专指 DeepSeek Harness（`reference/deepseek-harness`）。`dsh-synapse` 是运行在 DSH 上的独立 Web 视图插件，不是 DSH 本体；它展示了会话分支和画布投影的价值。pi/DSH 展示了可替换模型与扩展接口，但它们版本快速变化，运行时/插件权限和数据所有权不应成为 Aervox 核心依赖。BaiShou-Next 为 AGPLv3，不能未经许可复制或链接。

## Decision drivers

- Aervox Session/Message/学习数据必须是唯一真源；
- 参考运行时版本快速变化，不能成为核心依赖；
- 第三方代码/插件需版本锁定、契约测试与权限控制；
- AGPLv3 代码不能未经许可进入核心服务。

## Considered options

1. **可选适配器接入（adapter-dsh/pi/mcp）**：保留生态与试验空间（选定）。
2. **以 DSH/pi 为应用内核**：复用能力强，但核心数据所有权与运行时稳定性风险高。
3. **整体引入参考代码**：与 AGPL 边界和许可证评审冲突，风险不可控。

## Decision

通过 `adapter-dsh`、`adapter-pi`、`adapter-mcp` 接入；Aervox Session/Message/学习数据仍是唯一真源。`dsh-synapse` 画布只保存布局、锚点、折叠和真实 ID。版本精确锁定、契约测试、权限代理、超时、配额、审计和 kill switch 必须存在；MVP 不安装这些运行时也必须完整可用。统一 Manifest/Profile/Contribution 的目标扩展见 [能力组合与可选化目录规范](../capability-composition.md)。

## Positive consequences

- 保留生态选择和 P2 试验空间；
- 核心数据所有权与插件权限边界清晰；
- 无适配器时 MVP 完整可用，降低交付风险。

## Negative consequences and risks

- 适配器维护与版本兼容成本；
- 插件不能直接写核心数据库，能力需经适配层；
- 上游升级需要持续契约/安全/许可证回归。

## Migration / rollback

适配器以独立包和 Feature Flag 发布；上游升级先在隔离环境跑契约/安全/许可证测试。异常时禁用适配器，保留 Aervox 原生会话和导出；不做不可逆数据转换。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- 固定 SHA 复核与版本升级回归（`TC-CONTRACT-STREAM-001`）；
- 画布/内容分离、权限撤销与插件越权测试（`TC-SEC-PLUG-001`）；
- 无适配器核心流程与删除传播测试（`TC-PRIV-DEL-001`）。
