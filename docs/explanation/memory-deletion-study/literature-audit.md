# Literature audit

The six entries in [references.bib](references.bib) were checked against the
following primary sources on 15 October 2026. Author lists, titles, years,
available venue metadata, and identifiers match. The two 2026 sources are arXiv
version 1 preprints; the citations do not assert peer-reviewed publication.

| Key | Primary source | Role in this study |
| --- | --- | --- |
| `buneman2001whywhere` | [University of Edinburgh record and accepted manuscript](https://www.research.ed.ac.uk/en/publications/why-and-where-a-characterization-of-data-provenance/) | Database provenance distinguishes why an output exists from where its values originated. |
| `garg2020deletion` | [IACR ePrint 2020/254](https://eprint.iacr.org/2020/254) | Formal deletion definitions address guarantees beyond removing a stored record. |
| `musuvathi2008chess` | [USENIX OSDI 2008 proceedings record](https://www.usenix.org/conference/osdi-08/finding-and-reproducing-heisenbugs-concurrent-programs) and [paper](https://www.usenix.org/legacy/event/osdi08/tech/full_papers/musuvathi/musuvathi_html/index.html) | Controlled scheduling makes concurrency failures reproducible. |
| `mohan2018bounded` | [USENIX OSDI 2018 proceedings record and paper](https://www.usenix.org/conference/osdi18/presentation/mohan) | Bounded workload generation and crash injection expose crash-consistency bugs. |
| `yao2026forgetting` | [arXiv:2609.04875v1](https://arxiv.org/abs/2609.04875v1) and [full text](https://arxiv.org/html/2609.04875v1) | Execution-state unlearning restores a counterfactual agent trajectory by replay. |
| `ouyang2026memlineage` | [arXiv:2605.14421v1](https://arxiv.org/abs/2605.14421v1) and [full text](https://arxiv.org/html/2605.14421v1) | Signed provenance and derivation lineage govern sensitive actions using persistent memory. |

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
