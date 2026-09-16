---
id: CR-038
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 1.0.0
updated_at: 2026-09-16
reviewed_at: 2026-09-16
review_interval_days: 90
review_triggers:
  - apps/desktop/src/main/index.ts
  - apps/api/src/modules/proactive/proactive/routes.ts
  - packages/repositories/src/repositories/sqlite/proactive-perception-repository.ts
  - apps/worker/src/proactive-intelligence-worker.ts
sources:
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-036-situation-model-shadow-projection.md
---

# CR-038 感知事件流双写与订阅消费

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-16

- 状态：Accepted / Implemented（双跑观察中）
- 关联能力：`CAP-030/033`

## 变更与边界

API 在 `perception_events` 开关下校验活动 revision、设备、activation epoch 与来源授权，再把 capture 双写为最小化感知事件。事件不复制原始文本或屏幕内容。桌面空闲检测改为 5 秒检测：状态变化立即发送，相同状态只保留 5 分钟心跳。

Worker 的蒸馏消费者把事件幂等归一化为 observation；投影消费者在 SituationModel 快照写成功后推进 ACK。安全压缩必须等待所有未过期消费者 ACK。来源撤销同时删除事件和投影，避免撤权后召回。

## 验收、退出条件与回滚

- API 到 Worker 的本地链路具备秒级节拍，真实分位延迟仍须在双跑窗口记录；
- sequence、幂等摄入、消费者单调 ACK、过期游标和全消费者安全压缩已有自动化覆盖；
- 旧 capture 蒸馏管线暂不删除。只有连续观察期内事件与旧管线输出一致、无 DLQ 积压且延迟达标，才另行提交退役变更；
- 关闭 `AERVOX_PROACTIVE_PERCEPTION_EVENTS` 立即停止双写与事件消费，保留旧管线。

本 CR 不能标记 Verified，直到真实双跑证据与旧管线退役评审完成。
