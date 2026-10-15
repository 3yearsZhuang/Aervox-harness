# 记忆删除研究包

本研究检查本地单用户 SQLite 记忆删除的可观察完成条件：正文与派生存储是否已清理，迟到写入是否会恢复已删除内容，以及选定进程终止边界后能否恢复。实验使用两个合成记录、固定交错位置和生产仓储组件，结论范围是实现机制与所列场景。

- [论文正文](paper.md)与[成稿 PDF](../../../output/pdf/memory-deletion-study.pdf)。PDF 由正文及本目录的图表生成。
- [原始报告](results/report.json)与[逐案例 CSV](results/cases.csv)。图表数据源是报告中的逐案例观察和独立耗时样本。
- [完成情况图](figures/outcomes.png)、[耗时图](figures/latency.png)；同目录保留对应矢量 PDF。
- [参考文献](references.bib)与[一手来源审计及贡献边界](literature-audit.md)。
- [交接、中断原因与恢复记录](handoff.md)；迭代协调状态见根目录 [plan.md](../../../plan.md) 的 ITER-062。

## 本次修正与实测结果

| 问题 | 修正及验证方式 |
| --- | --- |
| 旧正文尚未落盘，数据仍是早期 schema | 完整中文论文、英文摘要和复现附录已保存；用最终源码重新生成 schema 2 报告与全部图表 |
| Oracle 固定匹配初始修订，漏查其他证据 | 沿目标全部修订查询，并测试额外修订及保留对象的证据变化 |
| 扩展 Outbox 内容或丢失 memoryId 后漏检 | 限制墓碑字段与类型；测量夹具保存已知事件 ID 归属，检查畸形载荷 |
| 生产验证器未核对完整墓碑 | 核对来源引用、摘要/Outbox 状态和载荷字段；嵌套 snapshotId 清空后再验 |
| 删除后的迟到错误回写恢复正文 | 原子 UPDATE 联合检查本事件对应的存活来源与删除标记，正常重试及其他事件回归通过 |
| 计时样本只记录异常，阻塞可能计入成功 | 保存并校验计时案例的完成状态和最终观察；基准臂的失败语义明确保留 |
| 来源哈希覆盖松散，失败时可能丢失证据 | 固定 62 项关键输入，测量前后比较；先保存原始 JSON/CSV，再拒绝漂移或意外结果 |
| 研究测试及纯文档证据曾存在门禁缺口 | `pnpm check:memory-deletion` 接入代码检查；文档门禁独立校验 JSON/CSV，纯结果或说明修改也不能绕过 |

合入主线 `d78b069b` 后已重新测量，补充来源策略和会话 schema 指纹；最终测量于 2026-10-15 20:47:29（Asia/Shanghai）生成，运行环境 Apple M5 / macOS arm64 / Node v24.21.0。80 个固定正确性案例、96 个计时样本、4 个错误回写案例和 2 个 SIGKILL 探针均完成并通过报告校验，62 项来源哈希一致。完整机制的结果为 **15 次安全完成、5 次正确阻塞、0 次错误完成、0 次完成后复活**；五次阻塞是有意遗漏清理的负对照，不是五次删除成功。详细消融与分位数见论文第 6 节。

本轮生产与实验修复不会自动重验历史 `memory-local-v2` 完成记录。模型语义遗忘、备份、物理页擦除和任意并发正确性仍未建立；这些限制也是论文结论的边界。

## 实验范围与分母

| 项目 | 固定设计 |
| --- | --- |
| 消融臂 | `soft-delete`、`cleanup-only`、`guarded-cleanup`、`verified-guarded` |
| 正确性案例 | 每臂 20 个，共 80 个；每个预先声明的组合执行一次 |
| 交错位置 | FTS、向量、摘要、审计、Outbox 五个通道，各在清理前、完成前、完成后写入，共 15 个案例/臂 |
| 遗漏注入 | 每次故意漏清一个通道，共 5 个案例/臂；这是研究用 SQL 变异 |
| 耗时样本 | 每臂 24 条，共 96 条；重复 `fts:before-clean`，按轮次轮换消融臂顺序 |
| 错误回写 | `markFailed`、`markDeadLetter` 各比较旧 SQL 与补丁后的生产方法，共 4 个案例 |
| 终止恢复 | 未提交事务边界、生产清理提交后边界，各 1 个 `SIGKILL` 探针 |

`soft-delete` 只设置记录删除标记；`cleanup-only` 执行清理；`guarded-cleanup` 增加写入守卫；`verified-guarded` 再增加完成前验证。它们是组件消融，不代表四个外部产品或框架。

独立 SQL oracle 检查记录、修订、证据及上述五个派生通道，共八个逻辑存储，并精确比较未删除记录的快照。合格的目标记录必须保留一条已清空的墓碑；缺失目标记录不能靠空结果通过验证。`falseCompletion` 表示宣告完成时仍有残留，`resurrection` 表示完成时干净、迟到写入后恢复残留，`safeCompletion` 还要求最终干净且保留记录不变。验证拒绝完成的遗漏案例属于阻塞，不能记作删除成功。

耗时仅包括清理与可选验证，不包括建库、夹具准备、迟到写入和 oracle；同一 Node 进程已加载，不能解释为进程或磁盘缓存冷启动。报告采用索引 `(n-1)*p` 的线性插值分位数。正确性案例是固定调度而非独立同分布样本，耗时也仅是本机描述性测量。

未提交事务探针在两条手工 SQL 写入之后终止子进程，检查回滚及重试；它不在生产 `clean()` 内部注入中断。另一探针在生产清理已经提交后终止并重开数据库。二者不覆盖所有崩溃位置，也不等价于断电测试。本研究不测量真实模型、KV cache、语义遗忘、备份或存储页安全擦除。

## 校验已保存的证据

以下命令均从仓库根目录执行，Node 与 pnpm 使用 [mise.toml](../../../mise.toml) 的工具链。先检查分支与工作区，保留其他人的改动；若缺依赖，在根目录运行 `mise exec -- pnpm install --frozen-lockfile`。

无需启动模型或重新实验，即可复核已保存 JSON 与 CSV：

```bash
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  docs/explanation/memory-deletion-study/results
```

[校验器](../../../scripts/memory-deletion-research/validate-report.mjs)从原始案例重新计算完成、残留、回写和终止探针结果，从耗时样本重新计算分位数，并逐行核对 CSV。报告使用 schema 2，保存测量时的 HEAD、工作区状态、环境以及源码、构建产物、实验脚本和工具链文件的 SHA-256；HEAD 本身不代表工作区没有未提交改动。

严格核对报告与当前源码、构建产物是否一致，先完成下面的依赖构建，再增加 `--check-source`。62 项输入包括相关 schema 和初始化代码，报告的 `sourceConsistency` 保存结束时哈希、变化列表与读取错误：

```bash
mise exec -- pnpm exec turbo run build --filter=@aervox/repositories... --concurrency=2
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  docs/explanation/memory-deletion-study/results --check-source
```

源码或构建产物改变时，严格哈希校验应当失败。保留旧报告作为原始证据，用新输出目录重新实验，再审阅是否需要更新论文、图表与版本化结果。不要手工改旧报告的哈希或汇总数值。

## 重新运行实验

实验入口导入 `packages/repositories/dist`，必须先从根目录通过 Turbo 构建仓储及其依赖。构建结束后再运行实验，测量期间不要同时修改相关源码或重建依赖。

```bash
mise exec -- pnpm exec turbo run build --filter=@aervox/repositories... --concurrency=2
mise exec -- node --test scripts/memory-deletion-research/runner.test.mjs
study_run="$(mktemp -d /tmp/aervox-memory-deletion.XXXXXX)"
mise exec -- node scripts/memory-deletion-research/runner.mjs \
  --out="$study_run" --repetitions=24
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  "$study_run" --check-source
```

[Runner 回归](../../../scripts/memory-deletion-research/runner.test.mjs)覆盖协议参数、独立 oracle、迟到写入守卫、遗漏阻塞、CSV 解析以及报告篡改和覆盖保护。它的完整运行测试采用每臂 1 条耗时样本，不能替代上面每臂 24 条的论文测量；实际测试数量与退出状态以当次测试输出为准。

`--out=...` 和 `--repetitions=24` 必须按示例传入；默认重复次数是 12。入口会拒绝覆盖目录内已有的 `report.json` 或 `cases.csv`；不要给复现命令增加 `--overwrite`。每次复现使用新的 `study_run`，不会覆盖版本化证据。耗时、生成时间和环境信息可随机器或运行变化，不要求整份报告字节相同。

## 绘图与生成 PDF

Python 依赖固定在 [requirements.txt](../../../scripts/memory-deletion-research/requirements.txt)。以下命令显式选择 Python 3.13.15，建立独立虚拟环境，再调用该环境的解释器；终端默认 Python 可能过旧或缺少依赖。

```bash
study_venv="$(mktemp -d /tmp/aervox-memory-paper-python.XXXXXX)"
mise exec python@3.13.15 -- python -m venv "$study_venv"
"$study_venv/bin/python" -m pip install \
  -r scripts/memory-deletion-research/requirements.txt
"$study_venv/bin/python" scripts/memory-deletion-research/plot-results.py \
  --report "$study_run/report.json" --out "$study_run/figures"
"$study_venv/bin/python" scripts/memory-deletion-research/render-paper.py \
  --source docs/explanation/memory-deletion-study/paper.md \
  --out output/pdf/memory-deletion-study.pdf
```

绘图脚本输出 `outcomes.png`、`outcomes.pdf`、`latency.png` 和 `latency.pdf`。上例将新实验图写入新目录；论文正文引用本研究包 `figures/` 内已审阅的图表，因此 PDF 仍使用归档证据对应的图。若要用新测量替换论文结果，需同时校验并更新报告、CSV、图表及正文数值，再渲染。

最终成稿路径为 `output/pdf/memory-deletion-study.pdf`。渲染成功后仍需逐页检查分页、表格、图和参考文献；脚本成功退出不等价于版面验收。生成物可以重建，不以 PDF 文件替代正文或原始结果。

渲染器在 macOS 自动嵌入系统中文 TrueType 字体；其他平台可使用 `--font /path/to/cjk.ttf` 指定已安装的中文字体。没有可用 TrueType 字体时回退为非嵌入 STSong-Light，发布前仍需检查目标阅读器的字形显示。本次 PDF 嵌入中文字体，逐页预览另存本地检查目录。

## 验证与交付边界

研究脚本检查、生产仓储回归、文档门禁与全量终审分别保留命令和完整退出状态。相关生产回归可运行：

```bash
mise exec -- pnpm --filter @aervox/repositories exec vitest run \
  test/outbox-deletion-guard.test.ts test/outbox-transaction.test.ts \
  test/memory-compaction.test.ts test/memory-deletion-verification.test.ts \
  test/deletion-zero-recall.test.ts
```

2026-10-15 整合主线后的验证结果如下。完整本地日志保存在 `artifacts/memory-deletion-integrated-validation/`；首次交付日志仍保留于 `artifacts/memory-deletion-validation/`，不以旧日志替代本轮退出状态。这些日志不作为新的权威计划。

| 检查 | 结果 |
| --- | --- |
| 生产删除、Outbox、压缩及零召回定向回归 | 5 个文件，38 项通过 |
| 研究 runner 与观察器/数据损坏回归 | 11 项通过 |
| CI 配置与增量接线回归 | 23 项通过 |
| 文档归档一致性及增量失败传播回归 | 27 项通过 |
| 最终实验报告及 CSV、62 项来源哈希 | 80 / 96 / 4 / 2 的各组证据校验通过 |
| `./aervox ci all` | 退出 0，全量代码、研究、原生组件和文档门禁通过；API 724 项、仓储 465 项、Worker 123 项通过 |
| PDF | 8 页，逐页视觉检查通过；中文字体嵌入，代码块引号和全部正文可提取 |

论文、实验与本地全量验证已完成；PR 审查、合入和正式发布仍为独立状态，见根目录计划与对应 PR。历史删除证明和真实用户数据库没有执行迁移或重新验收。
