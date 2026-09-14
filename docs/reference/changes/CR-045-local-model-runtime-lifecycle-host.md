---
id: CR-045
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: planned
version: 0.1.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
sources:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/changes/CR-042-local-model-routing-and-fallback.md
  - docs/reference/DATA_PRIVACY.md
---

# CR-045 本地模型运行时生命周期托管

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Planned
- 关联能力：`CAP-020/013`

## 1. 变更与边界

本 CR 为 CR-034 的 N3 切片，作为原生可选增强层，协助用户从零到达 L1 本地模型：

1. **运行时探测与编排**：检测外部 Ollama 安装与运行状态，按需辅助拉起外部进程，宿主内核不嵌入任何推理引擎（遵循「薄宿主 + 外部进程」原则）；
2. **安全引导下载**：提供推荐模型下载向导（推荐 3~4B 陪伴模型与 7~8B+ 进阶模型），仅允许官方渠道白名单与校验和校验；
3. **预设一键写入**：经用户显式确认后，将探测通过的本地回环端点一键写入 `llm_configs`。

## 2. 验收与回滚

- **Feature Flag 隔离**：由独立环境变量 `AERVOX_LOCAL_RUNTIME_HOST` 门控，默认关闭；
- **供应链与安全防护**：覆盖命令注入、路径逃逸与超大模型校验；
- **回滚语义**：关闭开关即停止托管编排，不影响用户已有的本地模型配置与文件。
