# 论文交接与中断恢复

本记录区分 2026-10-15 最初接手时读取的三条聊天状态，以及随后本机只读日志调查得到的证据。它解释工作为何反复中断，并给出可执行的恢复顺序；论文结论以逐案例数据为准，最终验证以当次完整命令的退出状态为准。协调状态继续维护于根目录 [plan.md](../../../plan.md) 的 ITER-062。

## 本轮落盘检查点

完整中文论文、英文摘要、参考文献和复现附录已保存于 [paper.md](paper.md)，PDF 位于 [成稿](../../../output/pdf/memory-deletion-study.pdf)。本轮不再依赖恢复长聊天才能继续。2026-10-15 20:47:29（Asia/Shanghai）的 schema 2 报告及图表已经替换早期证据；最早旧报告保留在本地 `artifacts/memory-deletion-inherited-results`，主线整合前的报告保留在 `artifacts/memory-deletion-before-main-sync`，不再作为论文数据。当前 62 项来源哈希一致，主实验为 80 个正确性案例、96 条计时、4 个错误回写和 2 个终止探针。

本轮进一步修复了独立 oracle 对额外修订、扩展载荷及已知事件来源字段丢失的漏检，并将相应墓碑条件纳入生产验证器。计时样本保存完成观察，源码漂移先落盘再失败；研究回归已进入代码门禁。5 个生产测试文件共 38 项、研究 runner 共 11 项定向检查通过。首次交付的全量门禁见 `artifacts/memory-deletion-validation/full-ci.exit`；主线整合后以 `artifacts/memory-deletion-integrated-validation/full-ci.exit` 为准，不能用旧日志尾部推断成功。最终移交状态见研究入口。

## 最初交接的故障统计

下表时间均为 2026-10-15、Asia/Shanghai；统计对象为明确标记 `failed` 的执行轮次，不包含用户中断和成功的选题、诊断轮次。

| 聊天 | 失败轮次与时间范围 | 直接错误证据 |
|---|---|---|
| 探索该项目值得落成论文的设计（`01a13d2a-e33f-7bb0-91d1-32730460782d`） | 10 次，13:45:20–15:39:16 | 10 次均含 `stream disconnected ... error decoding response body`；其中 15:01、15:09、15:16 开始的 3 次明确为 `Error running remote compact task` |
| 找出论文那个对话为什么一直成问题并评估是否可以接手过来继续（`01a13e7f-8ae1-7ad1-ac90-0f0eec5a007b`） | 3 次，15:49:54–16:29:24 | 相同响应流传输/解码错误 |
| 接手论文分支（`01a13eaf-e7c0-7c63-9d43-985dfb65c65d`） | 2 次，16:31:32–17:11:46 | 首次明确为 `You've hit your usage limit`；第二次为响应流传输/解码错误 |

这三条聊天在最初交接时合计 14 次传输/压缩链路失败、1 次配额失败；这不是后续全天故障总数。原探索聊天最后 5 次失败没有执行工作命令，重复发送“继续”没有产生新的磁盘产物。聊天状态只能定位到响应流或远程压缩环节，不能证明上下文超限。配额错误有独立的直接证据，不能归因为同一个网络故障。

早期还出现过两项已修复的环境/脚本错误：实验入口相对导入多退一级导致 `ERR_MODULE_NOT_FOUND`，以及当前 Python 未安装 `matplotlib`。后续实验命令已成功。这些错误与反复发生在 turn 终止处的传输错误分开记录；`rg` 在目录尚未创建时的退出码也不属于研究失败。

## 后续本机日志复核

随后以只读 SQLite 连接复核了本机 Codex 日志；脱敏的行号、请求 ID 和时序证据另存本机诊断产物，不作为论文实验数据。复核确认：

- WebSocket 曾明确报 `peer closed connection without sending TLS close_notify`，随后回落 HTTP。最新历史失败轮次在 17:05:55 回落，HTTP/1.1 返回 200 响应头后仍反复发生响应体读取错误，17:11:46 最终失败。收到响应头不等于整个响应流完成。
- 这些 HTTP 响应记录没有 HTTP/2 或响应解压缩失败的明确证据；请求侧 zstd 压缩日志不能解释为响应侧解压缩失败。可见间隔并不固定，日志也缺少最后一个 SSE 数据事件时间，不能据此认定固定时长或 idle timeout。
- 并非每个失败轮次都保留了完整的 TLS EOF 到 HTTP 回落链路。当前库中原探索线程实际只有 1000 条记录，最早为 14:10:20；缺失的更早链路不能靠推断补齐。
- 历史失败轮次与后来的诊断使用过不同模型；当前诊断的 `gpt-6.1-sol` 和工作目录位于记忆维护目录的独立任务也出现相同错误。这反驳了故障仅由某份论文内容或某个模型名称引发的解释。

这些证据把故障定位到了传输链路，但仍不足以区分本机网络、代理、Cloudflare 与后端中的责任段。论文仓库中的修复与检查点只能减少中断损失，不能宣称修复了 Codex 的通信链路。

## 最初交接暴露的流程缺口

外部传输和配额决定了执行能否继续，仓库无法保证它们不再发生。最初接手的历史检查点暴露了交付顺序问题：三条聊天反复恢复环境、读取历史和启动验证，当时已有实验数据与图表，却尚未保存正文及成稿。此处描述历史缺口，当前交付状态以研究入口、论文文件和最终验证记录为准。长时间执行最终只依赖聊天中的进度承诺，会让一次中断再次留下相同缺口。这是根据磁盘产物与聊天操作顺序作出的流程判断，不是对通信故障底层原因的推断。

采用以下恢复约束：

1. 以当前分支、文件、数据、命令日志为检查点；恢复时只读本记录、研究说明与 `plan.md`，按需追溯单项证据，避免再次搬运完整聊天历史。
2. 先将完整正文保存，再渲染 PDF；文献、方法、结果和局限每完成一个阶段就落盘。长验证在后台运行并保留日志和会话标识，恢复后先检查进程与退出状态。
3. 实验数据作为固定证据保存。代码或协议未变时先校验数据与源文件哈希，能够复用就直接写作；源文件改变或校验失败时才重新生成结果，并同步图表和正文。观察到意外结果或实验错误时，先保存原始 JSON/CSV，再以非零退出状态拒绝通过，不丢弃失败证据。
4. 对同一种传输失败，先检查是否已有产物和运行中的命令；连续重试无新产物时，使用精简磁盘检查点重新接手。明确的配额失败遵循错误给出的重置状态，不当作依赖错误反复安装或重跑。
5. 先跑受影响的定向检查，再在待提交内容稳定后完成全量终审。工具输出被中断或仅有末尾进度不能记作“全量通过”；保存退出码和日志路径。
6. 完成态拆开陈述：正文/PDF 已生成、实验复现通过、代码/文档门禁通过、PR 已创建与审查、正式发布各有各的证据。15 个安全完成加 5 个残留阻塞不能表述为 20 个删除成功。

## 可复用资产及实现审查

工作区为 `feat/memory-deletion-paper`，实现基线为 `99c82924`。以下文件在接手时已存在：

- [实验入口](../../../scripts/memory-deletion-research/runner.mjs)、[夹具与残留检查](../../../scripts/memory-deletion-research/fixture.mjs)、[真实进程终止探针](../../../scripts/memory-deletion-research/crash-child.mjs)。
- [逐案例报告](results/report.json) 和 [CSV](results/cases.csv)：4 个消融臂各 20 个固定案例，共 80 个正确性案例；每臂 24 条耗时样本，共 96 条；另有错误回写与两处终止恢复探针。固定案例不是独立同分布抽样。
- [参考文献](references.bib)、[结果图](figures/outcomes.png)、[耗时图](figures/latency.png)；图表由已保存数据生成，不能独立替代原始证据。
- [Outbox 修复](../../../packages/repositories/src/repositories/sqlite/outbox-repository.ts) 与 [回归测试](../../../packages/repositories/test/outbox-deletion-guard.test.ts)。

代码审查确认：`markFailed` 与 `markDeadLetter` 将 Memory 来源存在且未删除、事件未标记删除的条件放入同一条 `UPDATE`，因此检查和含敏感内容的错误回写共享 SQLite 写入原子边界。仅在方法入口查一次、或仅检查工作者已取出的载荷，都会留下清理后迟到错误回写的窗口。其他事件类型继续保留原有失败与死信行为。该原子补丁保持范围；14 项回归覆盖迟到回写、先写后清理、来源缺失/墓碑、事件标记、正常重试升级和其他事件类型。生产完成验证器的后续加强另见本轮检查点及论文 §4.3。

2026-10-15 接手复核通过的命令：

```bash
mise exec -- pnpm --filter @aervox/repositories exec vitest run \
  test/outbox-deletion-guard.test.ts test/outbox-transaction.test.ts \
  test/memory-compaction.test.ts
```

结果为 3 个测试文件、18 项测试通过。这只证明所覆盖行为，不构成一般并发证明或产品发布验收。

## 从仓库继续的最短路径

所有命令均从仓库根目录执行。先检查 `git status --short --branch`，保留已有研究文件和其他人的改动；已有数据先验证，再决定是否重跑。依赖统一在根安装；使用 `mise.toml` 工具链。

```bash
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  docs/explanation/memory-deletion-study/results --check-source
mise exec -- node --test scripts/memory-deletion-research/runner.test.mjs
```

验证器独立重算汇总、检查完整案例矩阵、CSV 与 JSON 一致性、错误回写及崩溃探针，并在 `--check-source` 下核对已记录的源码及构建产物哈希。它不调用生产删除验证器。若构建产物缺失，或源码已变化而哈希不匹配，再串行构建依赖、重跑到新的目录；不要在实验进行时并行修改源码或重建包：

```bash
mise exec -- pnpm exec turbo run build --filter=@aervox/repositories... --concurrency=2
mise exec -- node scripts/memory-deletion-research/runner.mjs \
  --out=/tmp/aervox-memory-deletion-reproduction --repetitions=24
mise exec -- node scripts/memory-deletion-research/validate-report.mjs \
  /tmp/aervox-memory-deletion-reproduction --check-source
```

实验入口默认拒绝覆盖已有报告；复现时选择新输出目录。只有明确要替换证据时使用 `--overwrite`，并同步更新图表与正文。

绘图和 PDF 的依赖锁定于 [requirements.txt](../../../scripts/memory-deletion-research/requirements.txt)。使用独立 Python 虚拟环境并显式调用其解释器；不要假定终端默认 Python 已有这些包。研究脚本提供 `plot-results.py --report ... --out ...` 与 `render-paper.py --source ... --out ...`；渲染后仍须逐页视觉检查。

提交前先运行定向测试，再执行 `./aervox ci all` 并记录完整退出状态。若修改了研究代码，重新生成报告、图表及正文中的数值；若只修改论文文字或排版，复用已校验的实验数据。经 PR 审查合入，禁止直接提交或推送 `main`。
