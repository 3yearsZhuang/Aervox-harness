# 记忆删除质量研究包

本研究将本地单用户 SQLite 记忆的逻辑删除作为软件质量案例，检查完成时残留、完成后回写、验证合同升级及生产工作者恢复。全部实验使用合成内容和新临时数据库，结论限于具名写入口、所列调度和终止边界。

- [中文论文](paper.md)、[完整英文稿](paper.en.md)、[中文 PDF](../../../output/pdf/memory-deletion-study.pdf)与[英文 PDF](../../../output/pdf/memory-deletion-study.en.pdf)。英文稿是投稿准备材料，尚未套用目标期刊版式。
- [主报告](results/report.json)、[逐案例 CSV](results/cases.csv)与[生产补充报告](results/supplement.json)。报告是数值真源，图表由报告生成。
- [完成结果图](figures/outcomes.png)、[操作耗时图](figures/latency.png)，同目录保留矢量 PDF。
- [参考文献](references.bib)、[一手来源与投稿定位](literature-audit.md)。建议优先准备 Software Quality Journal 的工程质量案例路线，强化测试方法后可考虑 Software Testing, Verification and Reliability；这不是录用预测或已投稿声明。
- [交接检查点](handoff.md)，协调状态见根目录 [plan.md](../../../plan.md) 的 ITER-062。

## 2026-10-18 大修范围

本轮按 PR #285 审查扩展了生产修复和研究覆盖。修订后的主报告与补充报告已经测量、校验并归档；此前四臂 80 案例报告不作为当前结果。测量代码提交为 `bd19a16c`，主报告时间字段为 2026-10-18 02:05:15（Asia/Shanghai），两份报告的 97 项输入哈希一致。

| 审查问题 | 本轮处理 |
| --- | --- |
| 来源仓储的修订、证据及审计入口可恢复正文 | 来源检查与插入放入同一写事务；按具名入口扩展矩阵 |
| 当前修订引用或删除标记可恢复旧状态 | 条件更新要求来源存活及修订归属；删除标记单调；保留墓碑约束同身份创建 |
| 增强验证仍信任 v2 完成证明 | 集中定义 `memory-local-v3`，闸门、工作选择和消费逻辑重选旧或无效证明 |
| 缺少只验证、无守卫的消融 | 新增 `verified-cleanup`，区分当前状态检查与完成后写入限制 |
| 原终止探针未进入生产清理内部 | 保留原探针并补八处真实清理变更及四处提交/证明/请求边界 |
| 定序实验不足以覆盖工作者执行 | 补五种跨进程生产循环调度，包含两个缓存工作者、错误和持锁竞争 |
| 两记录计时不足以说明规模或守卫成本 | 三个联合规模 profile 各三次新进程；单列旧/新修订写入各 12 次，并声明计时边界 |
| 论文新颖性和相关工作定位过强 | 补 DELF 等直接先例；贡献收敛为写入覆盖和验证合同演化案例，提供完整英文稿 |

完整机制在 35 个案例中有 **30 次安全完成、5 次正确阻塞、0 次错误完成、0 次复活**；只验证、无守卫的臂仍有 10 次完成后复活。12 个生产终止、五种跨进程调度、九个规模样本及 24 个实际写入样本均通过报告校验。主矩阵的 175 个案例、120 条计时及原有四个错误回写/两个恢复探针也通过校验。这些分母分别解释，不能相加计算可靠率。

## 实验单元与分母

| 实验 | 固定设计 |
| --- | --- |
| 主消融 | `soft-delete`、`cleanup-only`、`verified-cleanup`、`guarded-cleanup`、`verified-guarded` |
| 主正确性 | 十个写入口 × 三个位置 + 五个清理遗漏 = 每臂 35 个，共 175 个 |
| 主计时 | 每臂 24 条，共 120 条；`fts:before-clean`；进程已加载 |
| Outbox 错误回写 | 两种方法各比较旧 SQL 与补丁后的生产 API，共四个 |
| 原有恢复 | 手工未提交事务与生产清理提交后各一个；仍留在主报告 |
| 生产 SIGKILL | 八个 `clean()` 未提交变更 + 提交后/目标证明前后/请求完成后，共 12 个 |
| 生产调度 | 五种跨进程调度；其中一种使用两个缓存同一事件的工作者 |
| 规模 | 三个 profile 各三个新子进程，共九条；分别计清理、验证 |
| 修订写入 | 旧 SELECT+INSERT 和生产事务 API 各 12 条，共 24 条 |

主矩阵的十个入口详见论文 §4.2 和 [协议清单](../../../scripts/memory-deletion-research/protocol.mjs)。它包括五个原派生入口、修订、证据、来源审计、当前修订引用及向量适配器；其他入口有单独回归或明确排除。具名仓储与适配器之外的原始 SQL、插件、外部存储和另一生命周期拥有的共享投影不在本切片保证内。

独立 SQL oracle 检查八类逻辑存储，并精确比较未删除对象快照。目标必须保留一条已清空墓碑，不能以目标行丢失令查询空结果通过。`falseCompletion` 是完成时有残留；`resurrection` 是完成时干净、迟到写入后出现残留；`safeCompletion` 还要求保留对象不变。验证拒绝的遗漏案例仍含残留，属于阻塞。

主计时只包括清理和可选验证，排除夹具、迟到写入和 oracle。`cleanup-only` 与 `guarded-cleanup` 在此区间调用相同函数，差异不能解释为守卫成本。单列写入比较包含整个旧/新 API 路径，不能分离出谓词本身成本。规模 profile 同时改变背景记录、目标修订和内容长度，未逐项隔离，也未按比例增加所有派生扇出。新进程不保证文件系统缓存冷启动。

生产终止屏障在实际 awaited 数据库操作后暂停子进程；不改生产事务边界。SIGKILL 不模拟断电或磁盘损坏。五种生产调度和主矩阵都是有限枚举，不能推导任意并发正确性、真实模型遗忘、备份删除或物理页擦除。

## 校验归档证据

以下命令从仓库根运行，Node 与 pnpm 使用 [mise.toml](../../../mise.toml) 固定工具链。无需启动模型或重新实验即可检查归档结果：

```bash
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  docs/explanation/memory-deletion-study/results
mise exec -- node scripts/memory-deletion-research/validate-supplement.mjs \
  docs/explanation/memory-deletion-study/results/supplement.json
```

主 schema 3 报告保存写入口、排除边界、验证器版本、原始观察及环境；补充 schema 1 报告独立保存生产路径探针。主校验器仍能检查历史 schema 1/2 报告，但当前论文依据修订后的 schema 3。

schema 3 的主校验入口同时读取同目录 `supplement.json`，核对补充证据和两份报告的来源哈希。重新测量时应先运行两个实验，再校验主报告，不能在补充报告尚未生成时宣称整包通过。

严格校验当前源码和执行产物，先构建依赖，再为两个命令增加 `--check-source`：

```bash
mise exec -- pnpm exec turbo run build --filter=@aervox/worker... --concurrency=2
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  docs/explanation/memory-deletion-study/results --check-source
mise exec -- node scripts/memory-deletion-research/validate-supplement.mjs \
  docs/explanation/memory-deletion-study/results/supplement.json --check-source
```

报告保存测量前后关键源码、执行 JavaScript、schema、脚本与工具链的 SHA-256。HEAD 不能代表无未提交补丁；报告同时记录工作区。改变输入后严格检查应失败，不应改写旧哈希令其通过。

## 重新测量

先检查分支和工作区，保留其他人的改动。缺依赖时仅在根安装。测量期间不要修改相关源码或并行重建：

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm exec turbo run build --filter=@aervox/worker... --concurrency=2
mise exec -- node --test scripts/memory-deletion-research/runner.test.mjs \
  scripts/memory-deletion-research/supplement.test.mjs
study_run="$(mktemp -d /tmp/aervox-memory-deletion.XXXXXX)"
mise exec -- node scripts/memory-deletion-research/runner.mjs \
  --out="$study_run" --repetitions=24
mise exec -- node scripts/memory-deletion-research/supplement.mjs \
  --out="$study_run/supplement.json" --repetitions=3
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  "$study_run" --check-source
mise exec -- node scripts/memory-deletion-research/validate-supplement.mjs \
  "$study_run/supplement.json" --check-source
```

每次选择新输出目录，入口拒绝覆盖旧证据；不要为复现添加覆盖参数。源码漂移或意外案例发生时，原始证据先保存，再非零退出。完整运行回归使用较少计时样本，只证明程序行为，不能替代论文测量。耗时、时间戳和环境可随运行变化，无需整份 JSON 字节相同。

## 绘图与生成 PDF

Python 依赖固定于 [requirements.txt](../../../scripts/memory-deletion-research/requirements.txt)。使用固定版本和独立虚拟环境：

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
"$study_venv/bin/python" scripts/memory-deletion-research/render-paper.py \
  --source docs/explanation/memory-deletion-study/paper.en.md \
  --out output/pdf/memory-deletion-study.en.pdf
```

图表输出 PNG 与矢量 PDF。正文使用研究包 `figures/` 中经审阅的图，因此新测量获采纳时必须同时更新 JSON、CSV、补充报告、图表与双语正文。PDF 是可重建产物，不代替原始证据。渲染后逐页检查分页、字体、表格和图；成功退出不等于版面验收。非 macOS 平台可用 `--font` 指定中文 TrueType 字体，发布前仍须检查嵌入和字形。

## 验证与交付

定向生产回归、研究脚本检查、归档校验、文档门禁和全量终审分别记录完整退出状态。推送前按贡献指南运行 `./aervox ci all`。论文准备、合成升级回归、真实用户数据库重验、PR 合入及正式发表分别陈述；代码支持 v3 重选不代表已有用户数据库已完成重验。

2026-10-18 本轮 `./aervox ci all` 退出 0，构建、类型、全量测试、研究回归、原生专项与文档门禁通过；API 724 项、仓储 476 项、Worker 126 项，研究回归 14 项通过。主/补充报告的 97 项来源哈希在最终构建后再次校验一致。中文 10 页、英文 13 页 PDF 已逐页检查，文本可提取。完整日志位于本地 `artifacts/memory-deletion-review/ci-all.log`，远端检查以 PR 当前提交为准。

历史 2026-10-15 日志仅用于追溯，不能替代本轮退出状态。作者、单位、披露及稳定归档 DOI 由实际信息补充后再按目标期刊要求准备投稿。
