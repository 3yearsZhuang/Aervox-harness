# 受控基准记录

本目录的 JSON 是**特定时点的机器实测快照**，不是现行回归基线，也没有任何脚本读取它们
（消费方式见下）。它们存在的原因是：性能结论需要能追溯到"在什么机器、什么提交、
什么产物摘要上测出来的"，而这些数字当时代码块里放不下。

| 文件 | 测的什么 | 引用它的文档 |
|---|---|---|
| `core-benchmark-baseline.json` | Agent Loop 首段可见、取消延迟、堆内存（大块负载） | [Agent Harness Loop](../reference/agent-harness-loop.md) |
| `core-small-chunks-baseline.json` | 同上，`--scenario=small-chunks` 持续小块负载 | [Agent Harness Loop](../reference/agent-harness-loop.md) |
| `native-runtime-baseline.json` | 文件 SQLite 与原生运行时的对照 | [架构](../reference/ARCHITECTURE.md) |
| `native-search-baseline.json` | 原生向量搜索与 TS 参考实现的对照 | [架构](../reference/ARCHITECTURE.md) |

每个文件都带 `commit`、`implementationSha256` 或 `artifact.sha256` 与环境信息，
用来判定"这次的测量和当时是不是可比"。**不要在文档里引用其中的具体数字**——
需要时链接文件本身，让读者看到完整上下文与限制。

重新生成：`scripts/benchmark-core.mjs`、`scripts/benchmark-native-runtime.mjs`、
`scripts/benchmark-native-search.mjs`（默认输出到 `artifacts/`，需要长期保留时
再手动归档到本目录并更新引用它的文档）。
