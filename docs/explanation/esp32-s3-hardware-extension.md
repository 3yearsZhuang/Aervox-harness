---
id: AVX-EXPL-005
type: explanation
scope: baseline
owner: maintainers
doc_status: superseded
decision_status: not-applicable
delivery_status: not-applicable
superseded_by: AVX-EXPL-011
version: 0.3.0
updated_at: 2026-09-18
reviewed_at: 2026-09-18
review_interval_days: 90
sources:
  - docs/explanation/companion-hardware-directions.md
---

# ESP32-S3 硬件延伸方案（已合并）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：Codex · 2026-09-18

本方案已于 2026-09-18 合并至[移动端协同下的硬件规划](companion-hardware-directions.md)（AVX-EXPL-011）。本页仅保留历史编号与迁移导航，ESP32 的产品范围、工程候选与实施顺序统一在新文档维护。

## 1. 从旧方案到新规划

| 旧方案主题 | 新的阅读位置 |
|---|---|
| ESP32 桌宠目标与其它硬件的关系 | [手机重合与九方向处置](companion-hardware-directions.md#2-九个旧方向与手机的重合及处置) |
| Rev-A 屏幕、按键、音频与电源组合 | [一个 USB 实体入口](companion-hardware-directions.md#41-一个-usb-实体入口两种实验配置) |
| 模组、电气、引脚与 PCB | [继承并修订的工程边界](companion-hardware-directions.md#6-从早期-esp32-方案继承并修订的工程边界) |
| DeviceHost、输入输出与隐私 | [端、主机与数据分工](companion-hardware-directions.md#5-端主机与数据的分工) |
| 协议、ACK、时钟、掉电和恢复 | [最小协议语义](companion-hardware-directions.md#62-usb-原型所需的最小协议语义) |
| OTA、无线、音频、机械与产品化 | [按能力分阶段验收](companion-hardware-directions.md#63-固件更新与后续能力分开验收) |
| 路线、实验、BOM 和继续投入条件 | [分阶段计划](companion-hardware-directions.md#7-分阶段计划成本和停止条件) |

旧稿的模组选型与引脚表不再作为冻结规格，旧 R0 中超出 USB 原型范围的无线/量产要求已重新分期。合并只更新规划，不代表固件、DeviceHost 或设备已实现；具体处置与来源见[合并记录](companion-hardware-directions.md#9-合并记录与后续维护)。
