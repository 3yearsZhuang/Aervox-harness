# Literature audit

The original six entries in [references.bib](references.bib) were checked on
15 October 2026. The deletion-systems additions were checked against the primary
sources below on 18 October 2026. The two 2026 entries are arXiv version 1
preprints; the citations do not assert peer-reviewed publication. Metadata checks
are distinct from an exhaustive literature search or independent reproduction.

| Key | Primary source | Role in this study |
| --- | --- | --- |
| `buneman2001whywhere` | [University of Edinburgh record and accepted manuscript](https://www.research.ed.ac.uk/en/publications/why-and-where-a-characterization-of-data-provenance/) | Database provenance distinguishes why an output exists from where its values originated. |
| `garg2020deletion` | [IACR ePrint 2020/254](https://eprint.iacr.org/2020/254) | Formal deletion definitions address guarantees beyond removing a stored record. |
| `musuvathi2008chess` | [USENIX OSDI 2008 proceedings record](https://www.usenix.org/conference/osdi-08/finding-and-reproducing-heisenbugs-concurrent-programs) and [paper](https://www.usenix.org/legacy/event/osdi08/tech/full_papers/musuvathi/musuvathi_html/index.html) | Controlled scheduling makes concurrency failures reproducible. |
| `mohan2018bounded` | [USENIX OSDI 2018 proceedings record and paper](https://www.usenix.org/conference/osdi18/presentation/mohan) | Bounded workload generation and crash injection expose crash-consistency bugs. |
| `yao2026forgetting` | [arXiv:2609.04875v1](https://arxiv.org/abs/2609.04875v1) and [full text](https://arxiv.org/html/2609.04875v1) | Execution-state unlearning restores a counterfactual agent trajectory by replay. |
| `ouyang2026memlineage` | [arXiv:2605.14421v1](https://arxiv.org/abs/2605.14421v1) and [full text](https://arxiv.org/html/2605.14421v1) | Signed provenance and derivation lineage govern sensitive actions using persistent memory. |
| `cohngordon2020delf` | [USENIX Security 2020 proceedings record](https://www.usenix.org/conference/usenixsecurity20/presentation/cohn-gordon) and [paper](https://www.usenix.org/system/files/sec20-cohn-gordon.pdf) | Direct deletion-correctness precedent: type annotations, asynchronous deletion, and static/dynamic validation. |
| `athanassoulis2022deletion` | [Author lab publication record](https://disc.bu.edu/papers/debull22-athanassoulis) and [author manuscript](https://cs-people.bu.edu/mathan/publications/debull22-athanassoulis-preprint.pdf) | Application and storage layers require distinct timely, persistent deletion guarantees. |
| `chakraborty2025erasure` | [PVLDB publisher PDF](https://www.vldb.org/pvldb/vol18/p3435-chakraborty.pdf) | P2E2 addresses inference from dependencies after erasure, beyond operational cleanup. |

The IACR record describes the cited Garg et al. item as a minor revision of a
EUROCRYPT 2020 publication. The bibliography deliberately cites that ePrint
version and does not infer unverified proceedings pagination or DOI metadata.

The study's contribution is a bounded implementation study of persistent-memory
deletion, concurrent writes, and restart recovery. It must not claim to introduce
data provenance, lineage-aware agent memory, or the distinction between deletion
and forgetting. Yao et al. already formalize runtime-state unlearning and
checkpoint-and-replay; their exactness result assumes deterministic transitions,
matching counterfactual observations, and a restorable external environment.
The present repository experiments do not establish that result for an LLM or
its KV cache. [Yao et al., sections 3–4](https://arxiv.org/html/2609.04875v1)

MemLineage addresses integrity and action enforcement rather than the deletion
protocol measured here. Its lineage theorem is conditional on recorded parent
edges remaining above the attribution threshold. Parent omission and attribution
loss are explicit limitations, so the present study cannot assume that a stored
derivation graph captures all semantic influence.
[Ouyang and Hou, sections 3, 6.6, and 8](https://arxiv.org/html/2605.14421v1)

CHESS and bounded black-box crash testing motivate controlled schedules and
failure injection. They do not make this study's selected schedules an exhaustive
search of all executions. A reported zero failure count applies to the specified
fixture, schedules, and crash boundaries; it is not a general correctness proof.

## Closest systems work and contribution boundary

DELF is a direct predecessor for treating deletion omissions and incorrect
specifications as software-quality problems. The revised paper therefore does
not claim novelty for deletion validation or asynchronous cascades. Its narrower
case concerns error-write paths and evolving completion checks in local memory
storage. DELF was not run in the experiments: the related-work table compares
research focus, not measured effectiveness or performance.

The deletion-compliance overview separates application contracts from persistent
storage deletion. P2E2 additionally restricts inference using dependencies.
Neither guarantee follows from this study's residual-row oracle. The revised
case retains that distinction even when more schedules and crash barriers pass.

## Publication positioning

These are scope-based suggestions checked on 18 October 2026, not publication,
acceptance, ranking, or quartile claims. The repository has not submitted a
manuscript or obtained an archive DOI.

| Candidate | Primary scope or author information | Required positioning |
| --- | --- | --- |
| Software Quality Journal | [Aims and scope](https://link.springer.com/journal/11219/aims-and-scope) | Current preparation route: a case study of deletion quality, measurement, testing, and verification-contract evolution. Emphasize reusable evidence and retain the single-project limitation. |
| SN Computer Science | [Aims and scope](https://link.springer.com/journal/42979/aims-and-scope) | A pragmatic alternative covering software engineering, databases, verification and privacy, with a sound-science review perspective. Retain the bounded case-study claims and explain the original contribution; this is not an acceptance prediction. |
| Software Testing, Verification and Reliability | [Scope](https://onlinelibrary.wiley.com/page/journal/10991689/homepage/aims.htm) and [author guidance](https://onlinelibrary.wiley.com/page/journal/10991689/homepage/forauthors.html) | Emphasize testing method, oracle sensitivity, write-path coverage and fault injection; an experience report still needs transferable lessons. |
| Software: Practice and Experience | [Overview](https://onlinelibrary.wiley.com/page/journal/1097024x/homepage/productinformation.html) | Reframe around protocol design and implementation. Its scope excludes a primary focus on validation/verification outside design and implementation. |
| SoftwareX | [Publisher research-elements overview](https://www.elsevier.com/en-gb/researcher/author/tools-and-resources/research-elements-journals) | Conditional tool route: first establish a reusable research-software artifact with adapters, documentation and evidence of scientific usefulness. The present repository-specific harness does not by itself establish that contribution. |

A scope match is not a prediction that the present manuscript will be accepted.
Before submission, human authors must supply their own verified identities,
affiliations, contribution and disclosure statements, check the target's current
requirements, and create a stable artifact archive if appropriate. The English
manuscript is preparation material; it is not described as an accepted paper or
a completed external submission.

## 下一篇论文候选（仅研究建议）

以下建议基于 2026 年 10 月 18 日核对的一手来源，不构成新迭代、实现或
大规模实验的启动记录，也不表示已经确认新颖性。下一篇应取得新的跨系统
方法证据，不能仅把当前工程案例的调度、性能或证明版本拆成独立论文。

**主选：从代码与执行轨迹生成异步删除故障测试。** 开发者声明删除对象、
可观察存储和少量适配器，工具识别候选写入口及“读取—派生/异常写入—
完成证明”事件，生成暂停、重试与进程终止计划，输出可重放反例。先限定
主要语言或技术栈；完整写入口发现和语义正确性均作为待验证能力，不承诺
支持任意仓储或无需人工说明。

| 一手工作 | 已有能力与候选方向的边界 |
| --- | --- |
| [DELF，USENIX Security 2020](https://www.usenix.org/conference/usenixsecurity20/presentation/cohn-gordon) | 已有注释驱动异步删除和静态/动态验证；不能把“注释加检查”再次作为新贡献。候选关注既有应用的测试生成、复活反例和接入成本。 |
| [Paralegal，OSDI 2025](https://www.usenix.org/conference/osdi25/presentation/adam) | 已用标记和程序依赖图检查 Rust 隐私策略；仅扫描删除 API 不足以形成差异。候选需验证静态候选与运行轨迹结合后对时序缺陷的实际收益。 |
| [Sieve，OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/sun) | 已有状态扰动、自动计划与差分判据；候选不能声称首次轨迹驱动故障测试，应研究删除生命周期特有的计划选择与判据。 |
| [P2E2，PVLDB 2025](https://www.vldb.org/pvldb/vol18/p3435-chakraborty.pdf) | 已研究依赖导致的推断及最小额外删除；候选检测可观察的残留、复活与误删，不把行级检查解释为推断安全。 |

可证伪的研究问题：RQ1，相比独立人工审计和简单数据库调用扫描，候选
入口发现能否降低漏检且保持可接受误报？RQ2，相同执行预算下，生成计划
能否比现有测试、随机延迟和通用故障注入发现更多独立缺陷根因？RQ3，
接入时间、标记和适配代码是否足够少？RQ4，结果能否在未参与调参的项目
和版本上复现？

最低证据应包含 Aervox 和至少两个独立外部系统，其中一个完整留出，待
方法与参数固定后才用于验证。写入口真值由独立人员复核；真实历史缺陷、
新发现缺陷和人工变异分开报告。基线至少包括原有测试、简单写入口扫描、
随机调度和通用故障注入，并消融入口发现、轨迹引导、错误路径及完成判据。
比较运行与人工预算、误报/漏报、独立根因、反例重放、非目标误删及恢复
时间，不能把变异击杀率当作真实故障发生率。

先在两个外部系统做小规模可行性研究。如果仍需人工枚举全部写入口和
调度，或完整方法在相同预算下不优于简单基线，应停止通用自动化定位，
转为经验研究或工具短文；若缺少独立可观察的外部系统，不能用继续扩大
Aervox 场景替代外部验证。停止条件与正式比较预算应在主实验前固定。

**备选：共享来源派生记忆的选择性删除与效用保持。** 比较整份摘要清除、
血缘清理及基于剩余来源重建，检验独有事实泄漏、共享事实保留和血缘缺失
时的退化；至少需要多系统、多模型和可核验来源关系。已有 2026 年预印本
[Control-Plane Placement Shapes Forgetting](https://arxiv.org/abs/2606.15903)
与 [Deployment-Time Memorization in Foundation-Model Agents](https://arxiv.org/abs/2606.10062)
分别研究控制面遗忘评测及派生记忆删除保真度，不能将该主题视为空白，也
不能将预印本称为已评审论文。若优势仅来自删除更多内容并显著损害保留
事实，选择性删除贡献即未成立；该方向宜在独立语义判据和计算预算具备后
再考虑。
