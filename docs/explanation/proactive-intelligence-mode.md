---
id: AVX-EXPL-008
---

# 为什么主动智能需要四条独立状态轴

主动智能由 CAP-033 承载：用户在完全访问之外确认当前版本的全量画像与动作授权，系统在本地形成可纠正、可撤销、可导出的画像并执行已授权动作。一个 UI 开关无法同时表示“用户想要什么”“授权了什么”“操作系统允许什么”和“现在能否运行”，因此需要拆开这些事实。

本文只解释状态与权限设计；行为和验收见 [SRS CAP-033](../reference/SRS.md#8-cap-033-全域感知与个人画像主动智能模式)，数据边界见 [ADR-018](../reference/adr/ADR-018-proactive-local-privacy-host.md) 与[数据隐私](../reference/DATA_PRIVACY.md)。能力状态、原 `DEC-PRO-*` 与 `PRO-BLOCK-*` 集中在[追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md#proactive-decisions)，不在这里再维护一份实施清单。

## 1. 四维状态模型

工具权限、画像授权、设备能力和实际可运行状态必须保持分离：

- **工具轴**：`ask | full_access`，行为以 [BR-CONV-001](../reference/SRS.md#br-conv-001-代码执行边界) 为准；
- **画像期望状态**：`none | enabled | paused | revoking | revoked`，持久化在 `ProactiveModeRevision`；只有用户显式暂停才写 `paused`；
- **设备能力集**：版本化的 `ProfileAuthorizationRevision + DeviceCapabilityGrantSet`，记录当前平台所有可用的应用、文件、输入、屏幕、音视频、位置和其他来源；
- **有效运行状态**：`inactive | configuring | active | limited | suspended | revoking`，由期望状态、授权包、OS grant、激活事件/租约和 `local-ready` 派生。

`effectiveGrantSet` 绑定一份精确授权修订；mandatory 集只包含当前版本已接入来源。尚不具备的平台能力显示缺口，不伪称已获权限；完整判定由 [BR-PRO-001](../reference/SRS.md#br-pro-001-激活前置与状态) 维护。

```text
ask + desired=enabled
  -> effective=suspended，显示「操作需确认 + 主动智能已挂起」

full_access + none/revoked
  -> 完全访问

full_profile device grant + device activation epoch + desired=enabled + effectiveGrantSet + local-ready + deny-watermark-clear
  -> 主动智能模式

full_access + desired=paused
  -> 完全访问 + 主动智能已暂停

full_profile device grant + desired=enabled + 能力不齐/本地处理/政策前置不满足
  -> effective=limited/suspended，显示「主动智能模式受限」

full_access + 全量 revoking
  -> 完全访问 + 主动智能关闭进度
```

关闭完全访问、激活事件过期或设备能力被撤销时，立即停止新观察、召回、分析、提醒和主动任务，但已授予且未撤销的 Consent、本地数据/索引和用户期望状态保留；前两者只使 effective state 转为 `suspended/limited`，不自动改写 `paused` 模式修订。用户显式暂停则写入 `desired=paused`，必须由用户显式恢复。

用户显式暂停仍需显式恢复；已授权的自启、休眠和重启恢复遵循 [BR-PRO-006](../reference/SRS.md#br-pro-006-后台恢复与通知)，政策或来源修订变化重新确认。原 `DEC-PRO-013` 已确认方向与其余未决项集中在[决定索引](../reference/REQUIREMENTS_TRACEABILITY.md#proactive-decisions)。

单个 scope/source 的 `revoking` 是 scope 级清理状态。如果剩余 `effectiveGrantSet` 仍满足激活条件，主状态可继续显示「主动智能模式」，管理面板单独显示该 scope 的关闭/清理进度。只有全量关闭或剩余授权不再满足最小集合时，才整体回退。

画像授权和工具执行仍是两个检查：后台本地观察只需激活 epoch + 有效画像 grant；每次实际调用工具时，仍按 CR-022 的 Turn 策略和该工具的安全级别重新决定。

## 2. 为什么 `local-ready` 需要证明

端点叫 localhost、Ollama 或“本地模型”不足以证明数据不出本机。画像的限制必须沿原始来源、观察、推断、确认记忆、树投影、触发和 ContextManifest 继承；用户确认推断只改变其认知状态，不授予上传权限。正文之外，授权、动作、日志、备份和撤权水位也需要同样的存储与出网边界。

Host 身份、同设备绑定、处理器传输、出网阻断、激活租约和 deny 水位共同决定可运行性。Token 只识别控制面调用者，不授予来源或动作权限；lease 只维持生命周期，不延长 Turn 或 ToolApproval。任一必要前置失效就挂起，导出已保存数据的权利仍然有效。具体检查由 [BR-PRO-003](../reference/SRS.md#br-pro-003-本地处理边界) 和 [SEC-PRO-001](../reference/SRS.md#sec-pro-001-受信-host-与-os-权限) 定义。

## 3. 为什么暂停、撤权与删除不同

暂停表达“现在不要运行”，保留未撤销授权与数据；撤权改变允许访问的集合，立即停止对应来源或动作；删除在 deny 生效后传播清理与来源失效。它们不能共用一个布尔值，否则临时故障会误写用户意愿，关闭开关可能误删数据，旧任务也可能在恢复时重新获得权限。

单一来源撤权只影响该来源；剩余授权仍满足激活条件时，其余能力可继续。全量关闭提供保留、导出或删除选择。删除和恢复由[数据隐私契约](../reference/DATA_PRIVACY.md#8-删除传播)定义，不能由组合 Profile、人格偏好、模型推断或外部插件绕过。
