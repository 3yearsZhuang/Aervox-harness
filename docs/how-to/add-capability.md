---
id: AVX-GUIDE-007
---

# 新增与规格化 CAP 业务能力

CAP 表示用户可完成的业务闭环，不为单张表、路由或按钮分配 CAP。已有行为的 Bug 修复直接通过 PR，无需重走立项。

1. 在[追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)核对现有能力，新增时分配未使用的 CAP 编号，不重用已退役编号。
2. 在 [PRD](../reference/PRD.md)明确用户问题、范围、价值与优先级；在 [SRS](../reference/SRS.md)定义对应 FR、BR 和 AC，覆盖正常结果、异常、取消与实际涉及的数据责任。
3. 选择现有载体与扩展点，按[能力组合](../reference/capability-composition.md)明确所有权。涉及重大架构、权限或数据承诺时提出 [ADR](../reference/adr/README.md)，待相应决定后实施。
4. 修改实际涉及的机器契约和代码，补必要测试。在 PR 中记录验证范围及剩余限制；有依赖协调需求时直接维护[当前计划](../../plan.md)。
5. 能力状态或证据变化时更新追踪基线。`Implemented`、`Verified` 与 `Released` 分别需要实现、验证和发布证据，不因一个切片通过测试而推进整个 CAP。

验收应可观察，例如“来源撤权后不再召回对应内容”，避免仅写“效果良好”。不强制给每项能力填无关字段，也不为文档勘误维护日期或登记表。验证命令见[贡献指南](../../CONTRIBUTING.md#validation)。
