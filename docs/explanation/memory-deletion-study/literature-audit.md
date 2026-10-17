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
| Software Testing, Verification and Reliability | [Scope](https://onlinelibrary.wiley.com/page/journal/10991689/homepage/aims.htm) and [author guidance](https://onlinelibrary.wiley.com/page/journal/10991689/homepage/forauthors.html) | Emphasize testing method, oracle sensitivity, write-path coverage and fault injection; an experience report still needs transferable lessons. |
| Software: Practice and Experience | [Overview](https://onlinelibrary.wiley.com/page/journal/1097024x/homepage/productinformation.html) | Reframe around protocol design and implementation. Its scope excludes a primary focus on validation/verification outside design and implementation. |
| SoftwareX | [Publisher research-elements overview](https://www.elsevier.com/en-gb/researcher/author/tools-and-resources/research-elements-journals) | Conditional tool route: first establish a reusable research-software artifact with adapters, documentation and evidence of scientific usefulness. The present repository-specific harness does not by itself establish that contribution. |

A scope match is not a prediction that the present manuscript will be accepted.
Before submission, human authors must supply their own verified identities,
affiliations, contribution and disclosure statements, check the target's current
requirements, and create a stable artifact archive if appropriate. The English
manuscript is preparation material; it is not described as an accepted paper or
a completed external submission.
