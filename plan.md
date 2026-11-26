# Aervox 当前迭代计划

本文件是唯一协调队列，按风险、依赖和当前产品价值排序；编号不随排序改变。维护规则见[贡献指南](CONTRIBUTING.md#plan-maintenance)及[唯一变更编号](CONTRIBUTING.md#change-numbering)。需求与发布状态仍以[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)为准，已移交只代表对应切片。维护者已要求持续推进整个计划；按依赖执行已有合同下的实现与验证，待定产品路线、ADR 差量、真实环境、用户业务库迁移和发布仍须分别满足各条目的前置，不以单项绿测代替整体完成。

## 1. 当前判断与执行顺序

**当前基线（唯一真源，随 gitlink 更新）：** 主仓 `aa405504`、Core `78510f51`、插件 `3aafc1ef`。历史段落中出现的某个提交是**当时**的验证对象，不代表当前检出版本；需要历史证据时按其中的 PR 与提交号回查。

2026-11-07 合入基线：主仓 `4ae535c7`（[PR #362](https://github.com/3yearsZhuang/Aervox-harness/pull/362)）、Core `208d28ce26de4651a258ef208d21479e22ab315f`、插件 `bad07ef7305c85101c936a99737f67e7940d1f7d`（[集合 PR #12](https://github.com/Aervox-agent/Aervox-plugins/pull/12)）。手机前台对话、学习、人格/日记、系统输入与备份导出已有代码和自动化证据；设备失败回执、导出预算、分享会话身份与删除草稿竞态已修。维护者选择下一阶段聚焦**主动个人助手产品与界面整合**：沿 ITER-053/059/061 先把首页、连续对话、真实建议与行动结果串成一个日常闭环，Android 真机/M0 与签名按 ITER-009 并行接续。主线同版恢复存在已确认的删除历史缺口；[PR #359](https://github.com/3yearsZhuang/Aervox-harness/pull/359) 的统一恢复拒绝已由 `c7ccc736` 合入；所有安装在解析与 SQL 前拒绝恢复。该拒绝防线先于真实数据验收与内测；完整删除事实与安全恢复仍未完成。

共享传输、Attempt、领域事务、Conversation Port、Page 登记代际、LLM/CLI、长期消息及历史分页的既有交付仍保留，但 **ITER-071 尚未完全实现设计**；主线 `f94ebfd6` 及 PR #326/#327/#328/#330/#331/#332/#333 的历史证据由原 PR 保存。下表是接续优先级，规划不代替待决定事项，也不提高 CAP 或发布状态。

**2026-11-02 声明审计接续：** 冻结源码为主仓 `c1af1099`、Core `208d28ce26de4651a258ef208d21479e22ab315f`、Plugins `25bfda3314cc15f635e690d1bd918bb4c640e37d`。35 项 CAP 中，7 项尚无对应产品闭环登记，其余 28 项已有切片或验证证据，完整 CAP 状态仍见[唯一覆盖矩阵](docs/reference/REQUIREMENTS_TRACEABILITY.md)。本次将审计缺口列入本计划，不将未验收等同未实现，也不把 CAP、工具和 ITER 的数量相加。

| 顺序 | 当前目标 | 对应条目与进入下一阶段的条件 |
|---|---|---|
| 接续：恢复拒绝已合入 | 继续补持久删除事实 | [ITER-003](#iter-003)/[010](#iter-010)；主线旧恢复反例已确认，PR #359 已合入解析与 SQL 前统一拒绝；再闭合无正文 deny/tombstone、重开与未知回执。历史硬删安装不能仅靠新记录宣称安全 |
| 当前产品主线，按切片交付 | 整合主动个人助手首页、对话、建议与记录 | [ITER-053/059/061](#iter-053)；设计分支与指标口径已独立复核，第一批 PR #358 和连续会话 PR #361 已合入；第二批首页已由集合 PR #12 与主仓 PR #362 配对合入，全量与浏览器通过；第三批到期复习、知识正文和界面存续期的未知作答请求冻结已由 PR #387 合入，继续未完练习/报告重开与完整来源资格传播。学习是首个可测量域，新增导航不代替真实来源、执行与数据权利 |
| 立即，可按依赖并行 | 消除声明工具无执行接线、模拟 OCR 和附件虚假扫描通过 | [ITER-075](#iter-075) 先兑现真实只读清单工具，再按场景逐个补 8 个工具；[ITER-076](#iter-076) 先拒绝未扫描附件与生产 Mock 回退，真实解析另验；两仓规范已交付不代表工具已可调用 |
| 平台验收并行线，按前置推进 | 将已合入手机端验收为可日常使用的 M0，再准备签名内测 | [ITER-009](#iter-009)；复用产品主线的入口与领域事实，补确定性故障覆盖，普通权限真机和真实 Provider 可并行取证；持久补问、执行中终止及数据保全门槛未通过前不关闭 M0 或发布 |
| 立即 | 交付 Page 配置、资源读取身份及宿主资格观察，继续验收行为缺口 | [ITER-071](#iter-071) 前两批及再审计由 PR #323/#324 合并；[PR #326](https://github.com/3yearsZhuang/Aervox-harness/pull/326) 已合入 GET/reset 身份、资源 I/O 前后复验及静默 Page 观察；剩余资源通道/实时撤权归 [ITER-006](#iter-006) |
| 接续，可按依赖并行 | 闭合删除、撤权、安全恢复及在线运行门槛 | [ITER-003](#iter-003)/[006](#iter-006)/[010](#iter-010)/[011](#iter-011)/[013](#iter-013)；插件升级只推进 [ITER-005](#iter-005) 的必要安全切片。恢复不能先于 deny 账本和水位，性能优化不能先于资源有界 |
| 产品主线的必要服务与接续 | 证明现有个人助手、学习和会话入口真实可用 | 按首个场景收敛本机路径的 [ITER-064](#iter-064)、[033](#iter-033)，CLI [029](#iter-029) 按对应用户路径接续；[015](#iter-015) 必要部署与 [062](#iter-062) 连接验证可并行，Bot 独立运行/恢复在主管能力后验收；再做 [032](#iter-032)/[012](#iter-012) 长会话及索引，[026](#iter-026) 有限评审 |
| 按测量投入 | 消除真实瓶颈和维护成本 | [ITER-017](#iter-017)/[027](#iter-027)/[040](#iter-040)；先固定设备、数据和质量基线，再决定优化或停止，不承诺未测收益 |
| 条件成立后启动 | 扩端、开放生态及研究 | [ITER-016](#iter-016)/[018](#iter-018)/[028](#iter-028)、[019](#iter-019)/[056](#iter-056)、[021](#iter-021)→[022](#iter-022)→[043](#iter-043)；7 项远期能力先由 [ITER-077](#iter-077) 裁决范围；保留决策与环境前置，不挤占当前正确性和产品闭环 |

同一缺口只在对应 ITER 维护；上表用于导航。已有切片、未完成设计、外部环境验收和正式发布分别陈述；不设未经确认的日期、平台顺序或采购承诺。

**本轮接续验证：** `fix/plan-safety-contract-continuation` 的新 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native Search/Runtime 与 文档门禁通过；API 947、仓储 742、Worker 161、Host Runtime 306、Core 501、Host Agent 121、客户端 218、Panels 157、工作台 11 项通过，1 项既有真实模型跳过保留、不计通过。相关 Chromium 3 项和依赖审计另验通过（0 未审阅、2 既有审阅路径、0 过时例外）。全量先捕获 OpenAPI 预算，再捕获工作台旧简化插件夹具造成的 8 项失败；分别通过组件复用和完整响应夹具修复，重新全量通过。随后仅补验证记录并复验文档，新提交远端结果由接续 PR 保存；负载演练的 NOT CLEAN、真实环境及全计划未闭合项仍按各条保留。

<a id="core-repository-migration"></a>

### ITER-035 接续 · 已移交：Core 独立仓库与必需子模块

维护者已授权将 `packages/core` 迁至 `Aervox-agent` 组织下的公开 [Aervox-core](https://github.com/Aervox-agent/Aervox-core)，再以固定提交的 Git submodule 接回原路径，沿用 [ADR-021](docs/reference/adr/ADR-021-aervox-core-standalone-package.md#仓库分离与主仓集成) 与 ITER-035/037，不分配并行编号。

**结果：** Core 保留路径过滤历史、真人提交者与 Apache-2.0；生产源码与公共 API 兼容；主仓经 workspace 消费，业务 Schema 类型兼容证明留在宿主。首次安装与 CI 精确初始化必需 Core，缺失或版本失配明确失败；`reference/` 保持可选，仅完整门禁按需初始化 DSH 夹具。独立仓库与主仓分别核对冷检出、冻结安装、构建/类型/测试与公开远端 gitlink。冷克隆验证了缺 Core 明确拒绝，`mise tasks run install` 只初始化 Core 并冻结安装根依赖，8 个参考子模块保持未初始化。

**边界：** 源码迁移不代表公开 npm 发行或产品发布。精确提交的远端检查与合入状态由 [PR #348](https://github.com/3yearsZhuang/Aervox-harness/pull/348)、[Core PR #1](https://github.com/Aervox-agent/Aervox-core/pull/1)、[PR #2](https://github.com/Aervox-agent/Aervox-core/pull/2) 保存。

<a id="iter-073"></a>

### ITER-073 · 已移交：第一方插件组织集合仓与固定接入

维护者已接受在 `Aervox-agent` 建立 `Aervox-plugins` 集合仓，整体以固定提交 submodule 挂载到 `plugins/`，保留包名、接口与默认产品组成。决定见 [ADR-031](docs/reference/adr/ADR-031-first-party-plugin-repositories.md)，同步修订 ADR-016 与 ITER-026 的源码托管限制。

**结果：** 3 个有代码插件与 6 个声明式插件（71 个受跟踪文件）保留目录过滤历史、真人作者与原许可；集合仓在固定宿主内由根工具链和根锁编排，不在插件目录单独安装。产品子模块准入、受跟踪扫描与清理保护扩展到集合仓；真实 Git 回归覆盖缺失、错 SHA、冲突索引、包名漂移、嵌套 gitlink、凭据漏扫与忽略子模块配置。

**边界：** 本批不等待或捎带 FlowCampus 的并行工作；该工作后续重基到集合仓与主仓集成边界，不从开发分支或未提交工作树提取。交付见 [PR #349](https://github.com/3yearsZhuang/Aervox-harness/pull/349)。

<a id="iter-074"></a>

### ITER-074 · 已移交：UI Surfaces 第一方根界面表面包迁入 Aervox-plugins

第一方根界面表面包迁入集合仓的 `plugins/surfaces/`，主仓以 workspace 消费，保留包名与受信 surface 装配。迁移后根界面与设置面板的发布随集合仓走，主仓只固定 gitlink。

**边界：** 本次迁移不改变界面行为、布局或既有验收结论；表面包的独立构建、分发与装机验证随集合仓 CI 保存。

<a id="iter-075"></a>

### ITER-075 · 规范已实施，声明工具的实际执行接线待补

维护者已要求按集合仓原 PR #2 完成命名、七分类目录、版本、Registry 与发布门禁的实际实现，决定见 [ADR-032](docs/reference/adr/ADR-032-plugin-ecosystem-standard.md)。依赖已移交的 ITER-073/074；不捎带仍待重组的主仓 #346/#347。

- 集合仓恢复目标规范并迁移九个插件源码和标识，保留现有包名与受信 surfaces；宿主同步 Contracts、发现、工作区、打包、市场与消费者。
- Registry 只登记校验过的真实发布，发布与破坏性检查复用共享合同和根锁；没有发布时保持空索引。
- 维护者已选择显式离线身份迁移工具：停写、备份、staging、校验、原子换目录和回滚包；本次只实现和测试工具，不操作用户业务数据。不可变历史和撤权证据不重写为新授权。
- [集合 PR #4](https://github.com/Aervox-agent/Aervox-plugins/pull/4) 已保留历史合入 `85f002f4223cba5e0b3d9eccdd89ff7c10621525`，文件树与已验证候选一致；[主仓 PR #352](https://github.com/3yearsZhuang/Aervox-harness/pull/352) 固定该实际合并提交并交付宿主实现。维护者已授权两仓合并，主仓按最终 gitlink 复验及当前提交远端检查通过后合入。
- 两仓本地全量与远端冷检出检查已通过；主仓 8/8，包括 API E2E 45/45、Chromium UI E2E 37/37 和三平台原生合同。集合作者门禁验证九个身份和可重现分发包，迁移 CLI 30 项及真实完整 Schema 用例通过。没有执行业务库迁移或首次真实发布，相关实际操作继续单独验收。

**声明兑现接续：** `c1af1099` 下，以下 5 个声明式插件共 8 个工具只有 Manifest/SKILL 声明，未找到对应执行 handler。[安装服务](packages/host-runtime/src/modules/ecosystem/plugins/service.ts)只登记工具定义，[Core 工具运行时](packages/core/src/host-tool-runtime.ts)过滤未绑定工具并拒绝直接调用；包安装、配置校验或名字出现在清单中不构成工具可用证据。保留上述已交付的生态规范与迁移结果，本条接续声明到受信执行的兑现，不重新实现另一套运行时。

| 插件声明 | 尚缺执行接线的精确工具名 | 已有能力与保留边界 |
|---|---|---|
| [Anki](plugins/plugins/tool/anki-sync/plugin.manifest.json) | `anki_import_deck` | `anki_list_providers` 已接到真实题库注册表与 HostToolRuntime（集合 PR #14 已合入、主仓 PR #368 最终配对）；CSV/TSV/JSON 已有宿主导入入口，本地导入不等于 OAuth、增量同步、冲突及撤权闭环 |
| [OCR](plugins/plugins/tool/multimodal-ocr/plugin.manifest.json) | `ocr_parse_attachment` | 实际附件解析由 ITER-076 闭合，不能接到 Mock 后宣称完成 |
| [日记风格](plugins/plugins/workflow/diary-distillers/plugin.manifest.json) | `diary_generate_styled` | `diary_list_styles` 已接到真实风格注册表与 HostToolRuntime（集合 PR #14 已合入、主仓 PR #368 最终配对）；生成继续使用已有 `styleId` 入口，不另写日记事实 |
| [Home Assistant](plugins/plugins/tool/home-assistant/plugin.manifest.json) | `homeassistant_call_service`、`homeassistant_get_state` | 已有另名 `ha_*` 内置工具，明确受信映射与参数差异，真实平台验收仍保留 |
| [小米健康](plugins/plugins/sync/xiaomi-health/plugin.manifest.json) | `xiaomi_health_sync_daily` | 已有 `health_get_*` 只读工具；同步写入、厂商账号资格和副本删除须分别取证 |

- **首个工具切片（2026-11-06，本地实施）：** 两个插件的受信 `/server` 包与 Manifest/SKILL/README 统一为 `1.1.0`，通过可选 catalog 窄口读取真实元数据；宿主出厂发现同步登记 Manifest 工具，按同版 Manifest 与安装 version/checksum 绑定精确 ID，只读 handler 复用 Core HostToolRuntime。直接调用和模型入口共用纯判定与一次组合 SELECT，入场固定生命周期及授权 ID，返回快照按原身份复验；相关有效授权最多 256 行，超预算拒绝，NUL 文本与整数身份精确往返。权限按 SQL 快照读取时点观察，取得快照至调用方收到结果之间仍有并发窗口，不承诺墙钟即时强撤权。缺端口不贡献工具，缺配置仍可读，不创建 Turn、审批、业务事实或外部网络请求。
- **本地证据：** Node `24.21.0` 子进程下，[直接/模型组合快照回归](packages/host-runtime/test/plugin-runtime-catalogs.test.ts) 33 项及既有绑定/审批合计 84 项通过，两插件 8 项通过；[真实 API 同源调用](apps/api/test/plugin-runtime-catalogs.test.ts) 与相关 API 36 项通过，最终精确调用复验通过。Repositories、Host Plugin API、Host Runtime、API 构建/类型检查、20 项分发/子模块/可移除回归、边界/纯净/工作区覆盖、插件作者可重现打包、文档与 frozen install 均通过。独立源码复审、33 项回归及最后模型快照前改权限的反例单独复验通过。配对 PR、最终 gitlink、远端冷检出和正式发布验收仍待完成，本条未关闭。
- **联合终审（2026-11-06 至 2026-11-07）：** 最终组合为宿主 `255e671c` 与插件 gitlink `b06e9720`，已合入宿主主线 `7886042f` 和插件主线 `86ea6995`；可选插件合同、资源探针、冷检出守卫与删除账本诊断均进入组合。`./aervox ci all` 全部通过，覆盖 Host Runtime 365、API 1027、Repositories 962、Worker 177 项测试，以及删除故障、Rust 原生和 文档门禁；DSH 真实模型与未构建参考库产物的两个条件分支跳过，不作为本切片验收证据。首次联合门禁在 `07863b0b` 发现新插件缺架构归属、会话总出口形成运行时依赖环，未通过；已有声明准备、scope 与进程修订函数原样抽到共享叶文件，精确登记两插件对 Core/Host Plugin API 的依赖，未增加环豁免或执行器，`0539bdd8` 独立差量复审和此前完整门禁通过。配对 PR、公开宿主 SHA 对应的插件 CI pin 和远端冷检出仍待验证。
- **首页组合复验（2026-11-07）：** [主仓 PR #362](https://github.com/3yearsZhuang/Aervox-harness/pull/362) 已按精确提交 `85e1d8ae` 的 10 项远端成功检查合入 `4ae535c7`，固定首页集合 `bad07ef7`。只读工具候选吸收这组已审主线，宿主 `585c791b` 与集合 `fcfc4aa4` 的 frozen install、`./aervox ci all`、10 个插件分发包和全部插件预检通过，覆盖 API 1029、Repositories 964、Host Runtime 365、Worker 177 项；手机/Web 两个 Chromium 首页回归通过，DSH 两个既有条件跳过保留。[集合 PR #14](https://github.com/Aervox-agent/Aervox-plugins/pull/14) 与 [主仓 PR #368](https://github.com/3yearsZhuang/Aervox-harness/pull/368) 继续按公开兼容 Host、集合先合入、主仓固定最终 gitlink 的顺序交付；旧候选 `bdce8a8c` 的 10 项远端检查不能替代新组合检查。
- **最终配对（2026-11-07）：** 集合 PR #14 的精确 head `5e024d89` 在公开兼容 Host `529fac9c` 完成冷检出全量门禁、文档/工作区及依赖审计后合入 `b494c421edb97764e6397fb2d0f6e03a67fcc9b7`，与已审候选文件树相同；主仓 `529fac9c` 的 10 项远端检查通过。主仓固定该实际集合合并 SHA，frozen install、33 项直接/模型消费者与 10 个分发包复验通过；首次并行复验被构建产物重建与未登记最终 gitlink 拒绝，未执行产品测试，登记 gitlink 并串行后通过。最终主仓 head 远端检查继续取证；两个只读工具交付不关闭余下 6 项声明或正式发布。
- **余下声明：** 本切片后保留 6 个未接线工具；按个人助手场景逐个补写，不关闭整项。插件目前的 desktop/web/cli 声明不等于 mobile 可用，新增 mobile 目标须有实际组合根接线和兼容版本决定。
- **实施与依赖：** 逐个确定声明到现有领域/受信 handler 的映射，统一 Manifest、SKILL、配置、参数和结果；未接通时显示实际不可用并纠正支持说明。依赖 ITER-071 工具身份与审批代际、ITER-006/013 权限和撤权、ITER-003 数据删除；不靠开放任意第三方代码补齐第一方工具。
- **退出条件：** 8 个声明分别提供真实调用结果或明确的暂缓/取消决定；实现缺席不得虚报可用。已接通项验证实际结果与持久副作用、失败/取消、重复请求，以及停用/换代/撤权后旧调用拒绝。以宿主内置入口可用替代精确声明兑现时，须同步清单与兼容决定，不能静默重命名或重复注册。

<a id="iter-071"></a>

### ITER-071 · 执行中，部分实施：共享行为所有权与重复实现整改

维护者已批准 [ADR-030](docs/reference/adr/ADR-030-behavior-ownership.md) 与六批整改方案。此前"消费者均已迁移、完整统一"的表述已撤回，本条只记录**仍然有效的范围与剩余验收**；各批的实现细节、失败与补修过程由 PR 与 CI 保存，不回写为结论。

**已交付（不重复展开）：** 工具 revision 与持久审批绑定、分支请求键贯通 HTTP/插件/领域命令、工作台与桌宠共用待答问题与审批组件、Controller 保存 Turn 与消费游标、模型配置入口统一、实例级 ToolCatalog、HTTP Turn 全路径只消费命令/查询 Port、canonical SQLite 与保守 DDL 比对、术语契约由共享 Schema 派生、共享传输合同覆盖 Fetch 与 Electron IPC、会话长期消息真源。对应交付见 [PR #323](https://github.com/3yearsZhuang/Aervox-harness/pull/323)、[PR #324](https://github.com/3yearsZhuang/Aervox-harness/pull/324)、[PR #326](https://github.com/3yearsZhuang/Aervox-harness/pull/326)、[PR #331](https://github.com/3yearsZhuang/Aervox-harness/pull/331)。

**Page 身份与撤权切片（已合入）：** 配置 GET/save/reset、资源读取与静默观察均绑定 Page 身份与代际，同一 SQL 快照核对插件启用/可用性/生命周期与 capability，返回前复验；失配返回 409 且不改配置、Secret 或审计。静默 Page 按 2 秒串行观察、focus/恢复可见立即复验、本地截止 5 秒，旧文档不因后续授权复活。四种 Bridge 调用逐次复验，不消费观察缓存。

**收尾后的新增整改（2026-11-26 卫生审计）：** 本轮的重复实现整改由 [ADR-035](docs/reference/adr/ADR-035-loopback-endpoint-identity.md) 与下述单点收敛承接，属审计发现而非新范围：`isLiteralLoopbackUrl` 双源且结论相反已统一到 `@aervox/contracts`；SSE 帧解析、凭据脱敏、日记模板标记、集成入参取值助手、四组预设 CRUD 仓储均已收敛到单一实现。

**剩余边界（本条未关闭的原因）：**

- 旧复习缺回执返回 409、旧报告缺可证回执返回 `await_review`；全部主动写者撤权竞态、来源撤权再授权的代际绑定、跨进程自动接管均未完成。
- SQL 快照读取至客户端动作、跨窗口实时撤权、资源代际绑定、完整资源原子发布与 Token 资源通道仍归 [ITER-006](#iter-006)。
- 全链删除与恢复归 [ITER-003](#iter-003)/[010](#iter-010)/[011](#iter-011)。
- 完整文件图的类型依赖 SCC 保留并明确报告；仅精确登记且验证惰性的 Schema 外键运行时环获准，不以目录图无环代替行为解耦验收。

**关闭条件：** 上述缺口逐项有真实入口或等价隔离故障回归，删除旧消费者后完成定向验证与新的 `./aervox ci all`，再核对精确提交远端检查。已有绿测不覆盖后续修订；代码验收不代表生产迁移、真实模型/账号/多设备、移动真机、签名或发布完成。

<a id="iter-076"></a>

### ITER-076 · 拒绝防线已实现，真实附件扫描与 OCR 仍待接线

CAP-012/025、FR-EXT-001/002。`c1af1099` 的[内容模块装配](packages/host-runtime/src/modules/knowledge/content/index.ts)未注入真实解析器；[默认 OCR](packages/host-runtime/src/modules/knowledge/content/parser-port.ts)忽略附件，返回固定数学题与随机置信度；[附件路由](packages/host-runtime/src/modules/knowledge/content/routes.ts)的元数据/二进制上传直接写 `scanStatus=clean`，解析再把 Mock 结果持久为 `completed` 或 `low_confidence`。此为实现缺口，不能以现有上传、解析记录和纠正接口的测试视为真实扫描或 OCR 完成。

- **先闭合扫描准入：** 首个切片先移除上传直接写 `clean` 和生产默认 Mock 回退，不等待真实 Provider 选型。按 [AC-FR-EXT-001-02](docs/reference/SRS.md#fr-ext-001-附件上传与用途声明) 接入真实扫描结果和状态转换；扫描未完成、失败、不可用或未知时阻断解析与模型使用，只有实际通过结果可写 `clean`。两个上传入口复用同一准入，不在重试或恢复时绕过；先拒绝虚假通过，再验证扫描能力。
- **首个拒绝切片：** `fix/iter-076-attachment-admission` 的上传保持 `pending`，生产 ParserRegistry 不装配 Mock 或不支持格式回退；模型附件引用统一返回 `ATTACHMENT_SCAN_UNVERIFIED`，在接单和会话创建前拒绝，输入框保留草稿并提示纯文本继续。解析/删除在写者事务内核对来源，迟到结果不复活已删附件。已知附件回执及损坏回执关联的消息、Memory、FTS、Embedding 与日记来源拒绝模型使用；用户历史保留，未关联/缺失历史来源不补造证明。原语法拒绝候选 `4fd48d49` 的 Node 24 仓储 48、API 45、输入框 1 项最终回归、独立复审及 `./aervox ci all`（退出 0）已通过，后续同步主线仅更新提交元数据。有效 JSON 的损坏意图/消息结构拒绝修复已独立审查并提交为 `d2e0ce9d`；追加摘要差量须重新独立复审和完整门禁，不沿用旧代码的通过证据。
- **回执摘要追加候选：** 实际 SQLite 反例确认，把规范历史附件回执的附件数组改为空但保留旧哈希会开放来源；当前差量在模型来源读取和派生写者快照内，以宿主同步 SHA-256 重算选中回执原文的规范意图摘要。每条原文有界读取 256 KiB，超限拒绝；原生来源标识经 JSON 引用保留完整 NUL 身份。FTS 写入/重建在写者快照逐条验收，排序命中仍回读当前来源；每次模型上下文构建重新读取历史与记忆。生产自动召回的最后正文快照同时核对本机 `memory_long/auto_recall` 未撤销授权，迟到授权回调不能代替真实授权表。旧哈希、工具步骤间缓存、授权检查期间来源变更和本机授权撤销反例已有红/绿证据，API 42 与原生上下文/日记 12 项综合回归通过。SQL 到模型请求/投递仍有观察窗口；泛化外部授权、遗失/未链接历史来源仍独立待验。真实扫描、持久扫描证明、兼容迁移、OCR 和未知来源责任按本条接续，不以拒绝防线关闭整个能力。
- **再接真实解析：** 评审允许格式、扫描/解析 Provider、本地与出网边界、许可和预算；生产装配读取实际附件，未配置或失败明确不可用，Mock 只用于显式测试/演示。保留来源、解析版本、置信度、人工纠正与幂等；低置信识别不得自动计分或更新掌握度。公式/实体抽取的支持声明须逐项有真实输出，不随普通 OCR 自动兑现。
- **依赖：** 与 ITER-075 协同确定 OCR 工具合同；真实扫描/解析独立通过后，由 ITER-075 接线并验收调用。对应共享 API/Schema 由 ITER-064 承接，原图及派生删除依赖 ITER-003，资源/取消门槛依赖 ITER-013。Provider 或出网责任差量先更新对应合同，重大决定进入 ADR。CAP-024 的完整文献阅读另由 ITER-077 裁决，不由 OCR 替代。
- **退出条件：** 不同真实附件产生对应解析结果；待扫描、恶意/失败样本、缺 Provider、超限/超时、取消、重试/回执丢失、低置信纠正与来源删除有可复现证据。未通过扫描的附件不进入模型，迟到扫描/解析结果不得复活已删除内容；夹具与真实 Provider、代码门禁与目标环境验收分别记录。

<a id="iter-003"></a>

### ITER-003 · 切片已交付，全链删除与隐私仍待闭合

Memory 清理、独立验证、迟到写拒绝、召回资格及用途闸门已由 [PR #268](https://github.com/3yearsZhuang/Aervox-harness/pull/268)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)交付；ARC-06/08、CAP-005/013/027/033。将未完成责任从历史切片恢复到活动计划，不将有限 Memory 研究推为全链证明。

- **已补切片：** PR #324 接续将 ContextManifest 新写入投影为白名单请求元数据，Core 仅在进程内保留完整输入；另补首输入恢复资格、执行检查点及 SSE 当前来源读取，具体记录与范围见 ITER-071。不自动改写历史行或清洗 Outbox/派生副本。
- **手机恢复历史反例（2026-11-06）：** 主线 `5a97a960` 的恢复准入只查 `deletion_requests`，而[会话删除](packages/repositories/src/repositories/sqlite/conversation/session-store-neutral.ts)硬删会话却不写删除事实。隔离真实 SQLite/Transport 探针确认：保存带正文会话→导出→实际 DELETE 后，会话/消息版本/删除请求均为 0；导入旧备份成功后会话恢复 1、原消息版本恢复 3，重开后公共历史再次返回已删正文。原回归手动插入删除请求，只证明已有记录会拒绝恢复，未覆盖真实删除链路；这是修复前的失败证据，不能作为当前候选行为。
- **恢复拒绝防线已合入：** [PR #359](https://github.com/3yearsZhuang/Aervox-harness/pull/359) 的 `836af760` 删除恢复写入路径，所有安装的 [importBackup](apps/web/src/mobile/native-runtime.ts) 在解析、准入与原生 SQL 前统一返回 `409 BACKUP_RESTORE_HISTORY_UNVERIFIED`，界面禁用恢复并说明原因，保留导出、现有数据和普通读写。真实 Transport 回归执行导出→实际 DELETE（删除记录仍为空）→旧备份拒绝→退休并重新初始化，证明拒绝不增加原生 SQL 请求、已删会话与正文不返回、其他会话及后续读写保留；定向 3 文件 88 项、当次 `./aervox ci all` 和独立复核通过；当次门禁的子进程版本证据以下方运行时更正为准。完整门禁后仅补通用 Transport 注释，精确提交远端结果由 PR 保存；这是 SQLite/Transport 夹具生命周期证据，不等同物理手机或完整跨进程杀停。PR #359 已合入主线（`c7ccc736`），完整删除与恢复责任仍开放。此前本地门禁通过，但子进程 Node 版本证据需按下方运行时更正复验。
- **后续删除事实切片：** 让实际开放删除路径与无正文 deny/tombstone 在同一写者事务提交，记录不随业务删除或备份恢复消失。恢复必须检查该真实来源；删除后重开、回执丢失、重复操作、迟到写及旧备份反例不复活正文，并保留其他会话。历史硬删已经丢失事实，不能补造；旧安装在缺可信历史边界时仍拒绝恢复，不以仅补新删除记录关闭本项。字段、准入和版本兼容按现有合同评审；当前候选仅交付拒绝防线，不代表 ADR-013 独立账本与完整恢复已完成。
- **本轮接续：** 在 `fix/plan-safety-contract-continuation` 修复删除请求只按幂等键重放、忽略 scope/owner/targets 的反例；同意图按完整去重目标集合返回原回执，异意图 409 且不改原请求、目标或进度。与 ITER-010 共用 21 项控制意图回归，旧实现 18 项失败；修复后仓储相关 33、真实 API 13 项及类型检查通过，整体验证另验。不扩 Worker 的 Memory owner 范围或宣称全链删除已完成。
- **身份完整性补修：** 独立复核发现 HTTP 的 NUL 分隔元组可碰撞，原生驱动又截断文本的 NUL 后缀，未知删除身份可能被当成受支持前缀。现去重归仓储单一命令所有，JSON 转义覆盖删除请求/目标的全部读取和 RETURNING，以及账本回执；不截短、清洗或收窄合法字符串。新增仓储 2、真实 API 4、Worker 5 项反例先红；修复后控制意图 23、真实 API 4 文件 25、Worker 删除 20 项通过，后续完整集成另验。
- **完成判据接续：** 临时 SQLite 反例确认，未知 scope、请求/目标 owner 或目标类型的历史 completed 记录，仅带当前 Memory verifier 就会错误解除阻断且不进入重试。`fix/deletion-completion-owner` 让统一删除阻断与重试 SQL 同时核对实际支持的 `memory` 范围、请求 owner、全部目标 type/owner 及非空身份；比较在 SQL 内完成，NUL 后缀不退化为受支持前缀。十项新反例先全部失败，修复后与控制意图、零召回和 Memory 验证共 53 项、Worker 删除 20 项通过；真实构建产物反例中的四种未知完成记录均恢复阻断并进入重试。`dc60c28c` 获独立审查 PASS，控制意图 33 项独立复验通过。不增加删除 owner、不改变清理证明版本，也不将已存在的完成记录视为独立账本证明。
- **完成判据验证收口：** 吸收已审主线后的 `9c1dab80` 在 Node 24.21.0 / pnpm 11.22.0 下新鲜 `./aervox ci all` 退出 0：构建 35、类型 62、测试 63 个任务以及守卫、依赖审计、HLS、删除故障、Native 和 文档门禁通过，API 1073、仓储 1089、Host Runtime 389、Worker 177 项通过；Host Agent 128 项通过、2 项既有条件跳过不计通过。首次同版全量因漏初始化固定 DSH 参考子模块而有 4 项失败，补齐原 gitlink 后原文件 7 项通过、2 项既有跳过，再重新全量通过，未改产品或断言。随后吸收上下文传播 PR #376 的实际主线 `9428ff15`，产品与测试 blob 保持独审版本，`c63bfb2d` 重建仓储后 7 文件 96 项、Worker 删除 20 项及仓储类型通过；两组删除切片的精确提交远端组合继续随 PR 验收，恢复仍拒绝，不提高整体删除或发布状态。
- **Worker 完成竞态候选：** `fix/deletion-attempt-finalize` 从实际合入主线接续，在两次真实删除 cycle 的四种时序中先复现旧轮虚报完成、重复审计、清空新证明及重做目标；回归 4 项先红。队列 Port 现必填领取回执的 `attemptCount`，目标开始/结果和请求失败均核对当前请求状态及代际，空回执弃轮；仓储在同一写者事务内复验全部证明、CAS 完成并写审计，提交成功才计数。扩展检查另发现领取条件的裸 OR 越过请求身份，两个普通请求及普通/NUL 后缀请求均先红；给共享判据整体加括号后互不污染，不归为驱动截断。最终 Worker 3 文件 35 项、仓储 3 文件 55 项、消费图构建 23 与类型 45 个任务通过，涵盖同代际唯一完成、审计失败整事务回滚、失败重试和精确 NUL 完成。冻结 `6dc643e4` 获独立源码复审 PASS，独立实际复跑 Worker 35 与仓储 55 项通过；同版真实源码的 2 个竞争及 3 个旧回写探针通过，原红证据保留。完整门禁与 PR 仍待接续；重领不建立租约、不扩大清理 owner、证明版本或恢复责任。
- **完成竞态分支整合（2026-11-18）：** 保留上述反例与首次研究失败证据，`0949b9c3` 修订真实崩溃探针以观察原子 finalize 事务，未放宽 SIGKILL 或顺序断言；独立研究复验 20/20、无跳过，覆盖 12 个 SIGKILL、5 个调度与 3 个规模场景、24 次写入。接入依赖安全修复后的 `08e4c106` 新鲜 `./aervox ci all` 退出 0，包测试、原生、删除故障与 文档门禁通过，Host Agent 两项既有条件跳过保留。源码已独立审查；本条只闭合尝试代际与原子完成切片，最终 PR 检查与合入另取证，恢复与全链删除门槛仍开放。
- **下一步：** 继续闭合其余来源→派生传播及 grant 修订绑定，显式覆盖消息/工具结果、事件、摘要、Memory、日记、附件、缓存和错误副本。已关联历史 ContextManifest 清理见下条；未关联历史行、跨会话关系与其余派生类别仍须逐项验证，不能以新写入最小化或诊断 UI 不显示正文代替全链验证。
- **上下文删除传播候选：** `fix/deletion-context-propagation` 在会话/消息身份/消息版本删除的原事务内，以持久 Session→Turn→Attempt→ModelRun 关系清空同会话历史 ContextManifest 的快照、自由文本 selection reason 和 permission snapshot；SQL 内完成身份匹配，不将 NUL 后缀经驱动截成另一会话。`turn:history` 占位引用的新写入仅保留白名单请求计数，不保存两个自由文本注释。真实 SQLite 首轮 5 项反例全部失败；独立复核另发现旧版已软删身份的提前返回跳过清理，现重试清理后仍返回原 null 语义、不改旧删除时间。最终连同平台/消息编辑/FTS 4 文件 43 项通过，涵盖所有删除入口清理失败回滚、软删撤销不重建诊断正文、独立来源证明及其他会话保留；仓储类型、静态守卫和独立复审通过。冻结 `b6356695` 的新 `./aervox ci all` 在 Node 24.21.0 / pnpm 11.22.0 下退出 0：构建 35、类型 62、测试 63 个任务及守卫、依赖审计、HLS、删除故障、Native 和 文档门禁通过；API 1055、仓储 1086、Host Runtime 365、Worker 177 项通过，Host Agent 2 项既有条件跳过不计通过。随后只补本条记录并复验文档，精确提交远端结果随 PR 验收。未关联旧行、跨会话无来源关系、其余派生及账本先行仍开放，恢复继续拒绝。
- **依赖与验收：** 联动 ITER-071 写者门禁、ITER-013 逐帧撤权及 ITER-010 deny 账本；数据库级唯一 sequence 约束经 ITER-011 演练。撤权/删除立即阻断用途，迟到写、重试、备份恢复均不复活；独立验证无召回、无越权动作，失败/未知 owner 不返回完成。权威边界见[隐私合同](docs/reference/DATA_PRIVACY.md#privacy-deletion-sla)及[当前限制](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-证据与适用限制)。
- **Hook 写者准入候选：** 临时 SQLite 审计确认，有效插件代际与 Running Attempt 可在来源软删后继续写入核心 delta，而安全片段写者已拒绝。`fix/deletion-hook-body-admission` 在现有 Hook 写者事务内复用来源检查，校验通过前不分配序号或插入正文；不改原插件代际、全局删除和 fencing 判断。七个删除后可写反例先失败，修复后历史/流式仓储 2 文件 67 项与真实 Hook 生命周期/取消 API 2 文件 19 项通过，其他 Turn 和回滚失败的删除仍保持原写入资格。独立源码复审与探针通过；吸收主线 `9428ff15` 后生产/测试源码不变，冻结 `2fcdbf0c` 的新 `./aervox ci all` 退出 0，构建 35、类型 62、测试 63 个任务及守卫、依赖审计、HLS、删除故障、Native 和 文档门禁全部通过，Host Agent 两项既有条件跳过不计通过。随后只补本条并复验文档，精确提交远端结果随 PR 验收；普通错误载荷、旧事件/片段清理、非首版本物理删除的披露证明及 Outbox 副本继续开放。
- **Worker 轮次组合复验：** 吸收持久问答实际主线 `c20c1be1` 后，`70aae844` 的新 `./aervox ci all` 退出 1；构建 35、类型 62、测试 63 个任务均通过，其中 Worker 190、仓储 1122、API 1076 项通过，Host Agent 两项既有条件跳过保留。失败位于删除研究探针：旧接口拦截未能到达 `before-target-proof`，原研究 20 项中 19 项通过。现仅将故障拦截接到真实轮次结果与原子 finalize 回执，保留事务参数及全部 12 个 SIGKILL、5 个并发时序、3 个独立规模和 24 个写入样本；固定 Node 24.21.0 下原三文件 20 项重新通过、无跳过，产品源码及原验证判据不变。首次全量失败仍保留，不计通过；补修独立审查、新组合全量与精确提交 PR 继续验收。
- **审计定位：** `c1af1099` 的[删除 Worker](apps/worker/src/deletion-worker.ts)仍只接受 Memory 范围；通用来源→派生、grant 修订及历史诊断正文清理沿本条接续，以逐 owner/派生类别的删除与迟到写反例关闭，不扩大有限 Memory 测试的完成声明。
- **终态载荷准入候选：** `fix/deleted-source-terminal-payload` 修复来源删除后普通 fenced `done/error` 与原子终态写者仍持久自由正文的反例。沿同一写者来源/删除判据将新终态投影为固定无正文元数据，保留实际 Attempt 状态、终态 CAS 和水位；查询失败仍回滚，未失去资格的其他 Turn 保留原载荷。首轮真实 SQLite 24 项中 20 项因正文仍被持久化而失败；补齐来源读取失败回滚及固定安全回复兼容后，仓储 5 文件 93 项、真实 API 取消/Hook/错误 4 文件 30 项及 23 个构建任务、仓储类型、守卫和 文档检查通过。吸收实际主线 `fa30ddc7` 后同组仓储 101 项通过；冻结 `a5c9c673` 的独立源码复审、另组 108 项及真实 SQLite/执行 Store/广播桥探针通过，普通事件追加仍保持原 Running 状态，原子终态保留实际状态并将不可用载荷标为未完成。全量和 PR 交付仍待验收。旧正文清洗、未 fenced 兼容写者、原始进程内广播、非首版本硬删来源与完整下游派生资格仍开放，恢复拒绝不变。

- **终态候选整合复验：** 完整吸收来源授权审计 ID 修复后，`ea010597` 的首次全量退出 1：Host Runtime 八项仍期待旧持久原因，其他状态与执行次数断言通过。独立复审确认来源失效后的固定投影应为 `source_unavailable`；仅对应删除场景更新为精确四字段载荷与真实 Turn 水位，来源仍可写的 Core 原因和固定求助回复保留，17 项策略回归通过。协议明确此投影例外；诊断白名单仅接纳两个固定安全常量，真实 SQLite 两项原因丢失先红，修后连同未知正文过滤及终态回归 32 项通过，独立复验通过。新全量和精确提交 PR 检查继续验收，原失败证据保留。

- **终态 HTTP 兼容回归：** `6a12e324` 的新全量退出 1，Host Runtime 389 项通过，API 1073 项通过、1 项仍要求全局待处理删除时的旧持久原因。实际数据库删除闸门同样需要固定无正文终态；该 HTTP 回归改为精确控制字段与真实 Turn 水位，保留零模型/工具产出、唯一终态及 Interrupted 状态，Core 裁决和假 gate 回归不变。实际主线 `6b326c67` 已接入，文件树与预整合的来源审计修复一致；新组合全量继续验收，不将失败计作通过。

- **终态最终组合全量：** 此后完整整合已审持久问答候选 `b7b774dc`，固定 Core `93351196`、插件集合 `fa532343` 与 Schema v2；共享插入原语继续接收来源判据计算后的终态载荷，冲突解决经独立审查。冻结 `e35b4a487b5ac07b90d59e605a3962a43a4cd07e` 的新鲜 `./aervox ci all` 实际退出 0，构建 35、类型 62、测试 63 个任务通过，API 1076、Repositories 1152、Host Runtime 389、Worker 177 项及依赖审计、删除故障、Rust 原生和 文档门禁完成；Host Agent 130 项通过、两项既有环境跳过保留。该结果完成本候选的新组合本地全量，前述两次失败不计通过；终态 PR 必须在持久问答实际合入主线后排除其并行变更，再按精确提交远端检查交付，旧正文、未 fenced 路径及完整删除/恢复门槛继续保留。

<a id="iter-006"></a>

### ITER-006 · 配置与 Page 登记代际切片已补，资源与完整撤权待验收

Page/客户端认证；FND-03、ARC-13，CAP-018/020。Window/source、密码学 nonce、文档会话、全部 Bridge capability、观察到禁用后销毁及 Page 文件启用/symlink 边界已有 [PR #281](https://github.com/3yearsZhuang/Aervox-harness/pull/281)、[PR #283](https://github.com/3yearsZhuang/Aervox-harness/pull/283)；附件 Bearer、ITER-069 合法预检已有交付。

- **接续切片：** PR #324 在配置事务联合检查 enabled/availability/lifecycleGeneration 与 revision/Schema；Page 打开绑定代际，四种 Bridge 调用都查询当前代际和 Page capability，配置返回前再复验。Page 保存另由宿主注入 Page ID，在同一写事务检查当前 `config.write`，预检后能力移除不提交配置或 Secret。每次 Page 登记/资源摘要更新绑定独立持久代际，保存同事务核对；同插件代际撤权再授权/删除再建拒绝旧会话，资源摘要 CAS 不覆盖当前声明。同 ID 换代拒绝旧请求和迟到响应；配置事务竞态及实际旧 Page 调用反例见 ITER-071。
- **下一步：** GET/reset Page 身份已由 ITER-071 补齐，资源文件 I/O 前后资格复验由同条接续；补全实时撤权与资源通道、SQL 至客户端动作、完整资源原子发布和实际平台集成，调用时拒绝与当前能力检查不能证明运行中代码终止或全资源原子撤权。
- **决策前置：** Token 模式下 HTML/嵌套 JS/CSS/图片/Bridge SDK 资源通道，须先决定凭据签发、绑定、期限、轮换、撤销和 Origin 信任；沿用 ITER-063。长期 Bearer 不暴露给插件，不放 URL/日志，不降低认证或 CSP；Page capability 与 scoped sensor grant 分开。
- **验收：** 声明支持的 Web/桌面实际加载及配置操作，覆盖重载、过期/轮换、跨窗口停用、跨插件/来源拒绝、旧会话不能恢复。JSON/SSE/Page/附件均可在合法 Token 模式使用，实际资源和撤权集成证据不能由消息模拟代替。
- **确定性通道探针：** [PR #366](https://github.com/3yearsZhuang/Aervox-harness/pull/366) 已由 `760bb607` 合入真实 Chromium HTML/嵌套资源加载探针；该探针不接生产凭据签发、认证或 CSP，不关闭资源通道验收。
- **审计定位：** 资源 I/O 前后资格核对已实现，剩余是 Page Token HTML/嵌套资源通道、跨窗口实时撤权与完整资源原子发布；分别验证真实资源加载和撤权后的旧窗口/旧资源，不能以调用前拒绝推定整个资源通道完成。

<a id="iter-010"></a>

### ITER-010 · 待实施：控制账本、安全恢复与跨进程续跑

依赖 ITER-002/003/007 的必要切片，ARC-04/06、CAP-007/027/033。Resume 请求/账本覆盖及高水位已有切片，运行中审批续跑不代表跨进程自动恢复；不直接启用旧 Resume Host。

- **先做控制面：** 按[隐私合同](docs/reference/DATA_PRIVACY.md#privacy-deletion-sla)控制操作先取得独立 RecoveryControlLedger 的 durable ack，业务失败由 reconciler 按连续 sequence 幂等补齐；账本不含正文。缺失、验签失败、sequence 缺口、最老备份覆盖不足或水位未追平时，对受影响来源/用途保持 deny。
- **接续次序：** [ITER-003 的统一恢复拒绝 PR #359](#iter-003)已实现防线，已审查合入，不等待完整账本；完整恢复再按“独立故障域/凭据与保留责任 → 单一删除 owner 的账本先行 → 连续 sequence 与业务水位 → 删除/撤权重放 → staging/投影重建 → 零召回与零越权”推进，通过后才解除相应拒绝。控制面首个切片不同时开启自动跨进程续跑。
- **本轮接续：** 账本同键回执原先只比 eventId/eventType，可把另一 target 的请求误报为已完成。现比对完整控制引用、显式时间及规范化 JSON 证明，并发同意图只返回同一 sequence、异意图冲突拒绝；反例和定向证据见 ITER-003。仓储修复不等于账本先行、水位对账或恢复接线，ADR-013 的独立凭据/故障域与当前本地单用户部署仍需明确适配，不能重引租户隔离。
- **有界诊断接续：** `fix/control-ledger-diagnostics` 将一致性检查改为单次只读快照与相邻序列缺口计算，正安全整数以外的持久值拒绝，避免 `Math.max` 展开全部键及按损坏最大序列无限遍历。物化行数和诊断预算见[数据库合同](docs/reference/DATABASE.md)；超预算冲突拒绝，不返回截断的成功报告。真实 SQLite 的边界/损坏/只读反例与控制意图、领域冒烟共 50 项及仓储类型检查通过，最后诊断 15 项独立复验与审查 PASS，`bb914bbc` 的 `./aervox ci all` 退出 0；随后合入主线 `e14ad0da` 的计划证据并复验文档，[PR #363](https://github.com/3yearsZhuang/Aervox-harness/pull/363) 经审查与精确提交检查后已由 `c88fdd57` 合入；仅修内部诊断，账本先行、验签和恢复准入仍未完成。
- **再做恢复：** 旧备份先阻断流量，重放删除/撤权事实和授权期限，验证零召回/零越权后开放；与 ITER-011 的主库/Vault/账本回滚集合联动。续跑、一次性授权/有效期、跨库恢复和保留策略的差量先 ADR。
- **验收：** 缺账本、多工具、跨进程答案/审批、重复接管、旧备份不吞答案或重复副作用；未知结果不盲重放。取消提交后进程退出，过期 CancelRequested 以 fencing 收敛终态并结束重连流。
- **接单切片的保留限制：** ITER-002 的 `subagent_runs` 自身中断恢复及跨进程同幂等键 HTTP 语义尚未验收，纳入接管/恢复故障矩阵；不因 Turn 原子受理已交付而推定这些场景完成。
- **审计定位：** 账本仓储类已有实现，尚缺生产组合根的账本先行与连续 sequence 对账；[恢复派发](packages/host-agent/src/resume-dispatcher.ts)的 opt-in 仅续接已提交结果、默认仍关闭。以真实重启下的答案/审批、水位和旧备份 deny 证明接线，不能靠类存在或进程内补问继续关闭此项。

<a id="iter-011"></a>

### ITER-011 · 基础 staging 已实现，完整版本迁移与演练待完成

ARC-09、CAP-027。ITER-071 已撤旧快照原地恢复、由 Schema 编译目标结构并校验指纹，提供单库 staging/备份/源字节复验/换库/回滚保护；尚未证明所有支持旧版本和整体升级恢复。

- **下一步：** 唯一有序、不可变迁移入口，接线版本 journal/校验和/库外阶段状态；旧原地 helper 已撤下。列、默认、NULL、PK、复合 FK、完整索引及表级 CHECK/STRICT/WITHOUT ROWID 已由 ITER-071 补齐检查，历史版本升级路径仍须逐一演练。明确主库、Vault、控制账本、密钥和状态的备份/回滚集合，证明 API/Worker/后台及未知消费者已停写；维护锁或 `--stopped` 声明不是停写证明。
- **演练顺序：** 停写→验证备份→显式选择数据范围→同文件系统新 staging→完整结构、integrity、FK、行数、索引、FTS 校验→关闭句柄并原子换库→首次写前只读验证→保留回滚包。中断只继续已证明安全阶段或恢复原库，staging 失败源库不变；回滚包按[数据库契约](docs/reference/DATABASE.md#9-cr-030-破坏性迁移)至少保留 30 天或 10 次成功启动。
- **边界与验收：** 每个支持旧版本、失败点、恢复及实际回滚均隔离演练；NULL/重复主键、冲突、坏 JSON、孤儿 FK、行数不符、未知消费者阻断并输出清单，不删除/合并、修改幂等键、选择胜者或补造身份。迁移协调方案先评审，破坏性转换先 ADR；用户业务数据库操作单独验收，不因本计划自动执行。
- **审计定位：** [通用 staging](packages/repositories/src/migration/schema-staging.ts)仍是单库且由调用方提供停写证明；通用版本 journal、整体备份集合和恢复接线沿本条补齐。插件身份专项迁移已有独立 journal/recovery，不将其重复列为无实现，也不以专项工具替代全部版本升级演练。

<a id="iter-013"></a>

### ITER-013 · 进行中：有界运行、逐帧撤权与完整排空

ARC-05/12、FND-05/06/09，CAP-007/018。依赖 ITER-002/008 必要切片，与 ITER-071 生命周期和配置收口协同；先观测后定参数，跨进程通知/新隔离边界先 ADR。

- **已交付：** [PR #316](https://github.com/3yearsZhuang/Aervox-harness/pull/316) 单读取/写入执行者、Hub 唤醒合并、终态/高水位同快照及分页重放；页最多 256 行/256 KiB data 前缀，保留至少一条超预算事件，单事件/元数据/JSON 内存仍可超预算。write=false 等 drain 最多 30 秒，连接总限 10 分钟从重放起计；断连不取消 Turn、不造终态，旧 Attempt 不截断续跑。[PR #317](https://github.com/3yearsZhuang/Aervox-harness/pull/317) 从首信号共享默认 20 秒 Worker 关闭预算，前序释放成功才显式关库；超时/异常非零，数据库关闭可能部分成功。
- **逐帧删除切片：** PR #324 在建流和逐帧发送前查询当前来源状态与持久事件，删除后不继续发送缓存页，空闲轮询也关闭观察；真实 API/独立 SQLite 进程及背压反例见 ITER-071。只覆盖首输入缺失和现存同 Turn 身份软删，完整授权/脱敏、非首输入物理删除传播及网络原子撤权不在完成声明内。
- **Home Assistant 读取接续：** [PR #369](https://github.com/3yearsZhuang/Aervox-harness/pull/369) 已实现迟到 HTTP 结果的单次许可与条件缓存写入，绑定原连接/实体策略、来源及必需来源版本和原租约 ID/epoch；实体禁用/白名单调整、连接删除/同 ID 重建、来源撤销后重授、画像暂停后恢复、同 epoch 租约复用和心跳权限失去后恢复均不能重新准入旧读取。连接内部代际由写者生成，策略变更与代际轮换同事务，公开 DTO/业务导出省略该值。固定来源及实体时间戳的真实本地 HTTP/SQLite 回归、恢复授权后的新读取、稳定授权下的并发读取、加密代际重放和单次许可均已验证；API/SPI 24、仓储 16、审批/特权会话 7 项通过，独立再审查通过。吸收 main `4ae535c7` 后的精确组合 `10a75328` 再跑 `./aervox ci all` 退出 0，API 1046、仓储 966、Worker 177 项及原生、删除故障、文档检查通过；DSH 2 项既有条件跳过保留。契约见 [ADR-019](docs/reference/adr/ADR-019-proactive-integrations-local-gateway.md)。本批只覆盖单实体读取，HTTP 送达仍晚于条件写入准入点；同步、事件订阅、外部服务副作用和其它 Provider 的完整撤权继续验收。
- **本轮有限实施：** [草稿 PR #360](https://github.com/3yearsZhuang/Aervox-harness/pull/360) 将显式 `AERVOX_LOOP_DISPATCH=worker` 的初始委托移入 [delegated-turns 专用 Job](apps/worker/src/turn-consumer.ts)，通用 Outbox 不抢先确认。每个 Worker 的单批并发默认 2、上限 8，整批结束再取后续任务；以原始回执准入和首个 Attempt 终态确认，领取竞争、活动 owner、观测及确认失败不作为执行完成。仍可投递的未领取初始委托超过孤儿阈值后保留排队，已领取过期、取消和无有效回执继续现有恢复；关闭时取消活动执行并等待批次回执处理。契约见 [Agent Harness Loop §12.1](docs/reference/agent-harness-loop.md#121-内部领域事件)。本批不覆盖全进程并发预算、API/审批续跑/子任务限额、持续补位调度、Task/Router 或完整 SuperAgent；不新增隔离或授权边界。
- **本轮本地验证：** Node 24.21.0 直接运行 Worker 6 个定向文件 68/68、宿主 4 个文件 47/47、仓储回执与恢复 4 个文件 66/66，以及配置、任务节拍和受影响包构建/类型检查均通过；覆盖长模型并发、普通 Outbox、超额排队、领取竞争、重投、确认失败后重开、原始 Attempt/审批续跑、坏 JSON/接单凭据/会话政策、过期恢复及关闭排空。最终源码 `./aervox ci all` 通过，含依赖审计、全仓构建/类型/测试、恢复研究、原生和全文档门禁；固定 pnpm 11.22.0 的全量子进程实际使用 Node 26.13.0，与上述 Node 24 定向证据分开陈述。独立代码审查和暂存文件卫生通过。本批仍需 PR 审查合入，不据此宣布真实 Provider 验收、强杀副作用矩阵、生产部署、正式发布或 ITER-013 整体完成。
- **审计定位：** [来源可见查询](packages/repositories/src/repositories/sqlite/conversation/source-visibility.ts)的身份/删除检查尚不覆盖完整同意与授权修订；[事件存储](packages/repositories/src/repositories/sqlite/conversation/stream-event-store.ts)仍允许至少一条历史事件超过单页字节预算。对应补齐授权修订反例、单事件/全局流/累计资源限制和全部写者排空证明，保留已有分页与背压交付。
- **本轮共享模型流候选：** Node Host 在组合根显式持有一个[上游资源 owner](packages/host-runtime/src/modules/ecosystem/llm/model-resources.ts)，默认 4、配置范围 1～32；主对话/审批续跑/子任务/恢复/插件和领域生成共用 factory，实际拉流取得名额，超额 typed 立即拒绝，不排队。取消仅停止调用者等待，实际 `next` 与清理未结束仍占用容量；关闭撤销准入，默认 20 秒未确认 drain 则失败。最终候选在 Node 24.21.0 / pnpm 11.22.0 下通过宿主 31 文件 356 项（含资源/生成与真实 Host HTTP 回归）、配置 44 项、API Provider 3 项、API/Worker/宿主构建及类型检查、架构/透传/文件卫生与文档检查。真实回环 HTTP 在上限 2 时验证主对话与日记共享、额外主对话/实际子执行/恢复闭包零新请求、插件 afterTurn 生成继续共享名额、取消后主动生成可补位、关闭同时取消会话和无调用者信号的领域生成，服务端峰值 2 且最终连接 0；持久 Failed/error 与 ModelRun failed、不补造 usage。Core 模型失败原子提交一个 error 终态事件，既有返回 reason 为 execution error、event code 为 MODEL_UNAVAILABLE，不另写 Turn.error 或追加 done；独立审查与最终全量证据见下条。仅覆盖单进程配置模型流，不覆盖 SSE 观察连接、受理/prepare、Embedding/探针、DSH/headless、跨进程总量或所有写者；Core 通用失败 reason 保持既有语义，专用终态 code 另行薄片。
- **共享模型流验证收口：** 首轮全量发现装配上下文两处类型直引 LLM 私有文件，改为已有公开入口后边界 26 项与宿主类型检查通过；下一轮仅 Bot 策略旧夹具缺少共享 factory，8 项无模型请求失败。补真实 owner/factory、直接执行传递及清理，不改原断言，12 项定向先绿。冻结产品源码摘要 `cde7cb78172e91f93aec1c2b0f5d7a87e3b2ba7a30134e5b4fa99a6611d94561` 获独立审查 PASS，`c28c7a87` 在 Node 24.21.0 / pnpm 11.22.0 下新鲜 `./aervox ci all` 退出 0：API 1054、仓储 1059、宿主 356、Worker 177 项通过，构建、类型、守卫、依赖审计、删除故障、Native 与 文档门禁通过；Host Agent 2 项既有真实模型/参考库跳过仍不计通过。随后只补本条验证记录并复验文档；远端结果按 PR 精确提交继续验收，不提高 ITER-013 或发布状态。
- **下一步：** 优先完整逐帧授权/同意版本及来源传播、全局并发流限额，再覆盖所有 Provider 队列/取消、Host/Worker 全部写者 drain、跨进程终态及累计预算策略。ITER-007 的费用/跨重启计量和一次性授权剩余分别联动 ITER-033/010；不将异步计时器视为同步阻塞或原生强杀时限的保证。
- **验收与证据：** 慢源/慢客户端/日志洪泛资源有界、停机有截止、已提交窗口可读、失败可定位，复用现有 metrics。真实慢 TCP/临时 SQLite、独立 Worker 子进程回归与精确 PR 门禁已通过；error/done、取消幂等及事件保留遵守[流式协议](docs/reference/STREAMING_PROTOCOL.md)。历史失败与样本值保留在[原计划](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-013)，不能外推生产峰值。

<a id="iter-005"></a>

### ITER-005 · 原子激活切片已交付，升级恢复仍待完成

FND-02/04、CAP-020，依赖 ITER-004/063，遵循 [ADR-028](docs/reference/adr/ADR-028-plugin-atomic-activation.md)。缺包保护、预检/解压配额、独立资源准备、短事务激活、失败保留旧版及原始归档导出由 [PR #283](https://github.com/3yearsZhuang/Aervox-harness/pull/283)交付。

- **当前必要范围：** 各分发入口预检/写入/注册/切换失败与崩溃恢复，旧 Config/Secret/授权不丢失，全部声明入口可用、配额有界、重试幂等；同源码导出字节/校验和可重现。与 ITER-071 Catalog 原子登记协同，不把 SQLite 事务当文件系统跨介质原子保证。
- **后续按需求推进：** 运行失败自动回退、复杂配置迁移、旧资源自动回收；升级/卸载及迁移语义先 ADR，既有安全升级合同仍须通过。不将该切片升级为整个插件生态发布完成。
- **审计定位：** [资源原子发布](packages/host-runtime/src/modules/ecosystem/plugins/bundle-store.ts)已有文件/目录 fsync、不可变 generation、事务 CAS 和未知激活回执保护；本次主要补所有分发入口的故障/崩溃恢复取证，不能将已有原子激活算成无实现。自动回退、复杂配置迁移和旧资源回收继续按上述后续范围评审。

## 4. 现有产品闭环与交付

维护者选择以主动个人助手产品与界面整合作为下一阶段主线。首页应让用户看见正在做的事、下一步和实际结果；连续对话保留“发送→流式结果→补问/审批→重启后读取→删除/导出”的真实状态。学习能力作为首个可测量域保留事实真源，先证明一个日常闭环，再按证据扩展生活/工作来源、长会话及额外命令；真实外部账号/设备和发布分别取证。

<a id="iter-053"></a>
<a id="iter-059"></a>
<a id="iter-061"></a>

### ITER-053/059/061 · 第一方界面切片已交付，产品场景待验收

- **ITER-053：** 前端体验与跨端连续对话已有 [PR #260](https://github.com/3yearsZhuang/Aervox-harness/pull/260)、[PR #275](https://github.com/3yearsZhuang/Aervox-harness/pull/275)；历史抽屉已有 ITER-064 持久分页。第二批首页四个真实入口、常驻输入、按会话身份保留草稿与分页接续已由 PR #362 配对合入。其余实时面板接线、真实模型和跨端用户操作闭环继续验收；移动真机按 ITER-009 的平台/运行位置决定后取证。
- **ITER-059：** 陪伴界面、最近会话和固定入口由 [PR #276](https://github.com/3yearsZhuang/Aervox-harness/pull/276) 交付，桌面经典布局/移动陪伴由 [PR #306](https://github.com/3yearsZhuang/Aervox-harness/pull/306) 对齐；仍须验证学习记录推荐来源、真实模型及设备行为。
- **ITER-061：** companionName/userAddress 与旧字段迁移由 [PR #279](https://github.com/3yearsZhuang/Aervox-harness/pull/279) 交付，按维护者决定移除素简文档界面；命名与身份分层保留，服务端统一身份、真实模型/实机仍未验收。

以上原编号分别承接剩余，ITER-071 先修 Controller/问答/观察缺口，各 surface 保留布局。

#### 主动个人助手整合：下一阶段主线

**首个闭环建议：** 用户交代一件具体事 → 必要澄清 → 可用产出或明确下一步 → 用户确认采纳/继续修订 → 重开后回到原会话。复用现有文本、补问、流式结果、复制和持久历史；学习建议作为首个有结构事实的主动切片，不先依赖日程、全域观察、后台运行或新任务引擎。

| 批次 | 归属与最小交付 | 退出条件 |
|---|---|---|
| 第一批：已合入 | ITER-061/053；[PR #358](https://github.com/3yearsZhuang/Aervox-harness/pull/358) 保留 `docs/assistant-vision` 的 6 个提交并完成独立审查，对齐助手身份、首页目标、学习域追踪、指标及实验口径；静态"朝夕"标明模拟来源并在手机/桌面复验 | PRD/SRS/DESIGN/追踪一致；CAP/FR/AC 不重编号；文档与静态演示不构成第二/三批界面交付 |
| 第二批：首页与连续会话已配对合入 | ITER-053/061；`proactive-ui` 补"接着上次""今日""记录""日记"四个真实入口，保留角色、常驻输入及按会话身份的草稿；列表逐页读取，首 100 条之外的 selected 由只读 GET 找回；Android 学习面板由组合根注入，普通 Web 由 `focus-mode` companion 扩展提供入口。手机接缝归 ITER-009，领域/接口差量归 ITER-064 | 从首页找到原会话、完成澄清/产出并回看；刷新不造新 Turn；执行/待回答/待审批/未知受理状态可区分，切会话保留草稿；空数据、缺模型、失败、取消、短屏/IME/返回及读屏均可完成核心操作 |
| 第三批：到期复习已合入，其余场景接续 | ITER-059/053；"今日"只用真实到期复习、未完练习和当前会话状态，每项说明来源与出现原因并可忽略。[PR #387](https://github.com/3yearsZhuang/Aervox-harness/pull/387) 交付"到期项→知识正文→用户自评→完成回执/下次日期→首页刷新与完成历史重开"，并冻结界面存续期间的未知自评/作答请求与原幂等键 | 建议进入原领域操作并按持久回执更新结果；自评与题目判分分别表达，不把模型推断当任务事实；加载/失败/未知不显示为已完成；来源删除/撤权/停用后不可继续显示或执行 |
| 第四批：可用性与真实帮助验证 | ITER-059/061；固定源码、Provider/权限和界面能力，先用隔离样例验证，再拟定小样本连续使用观察。平台真机/M0 由 ITER-009 平行验收，恢复阻断由 ITER-003/010 先关闭 | 核对用户是否得到可用结果、接续入口是否减少卡点；保留失败、修订/拒绝、成本与数据权利证据；可用性记录不能代替受控实验或发布 |

**首页信息架构：** 首页展示角色、当前会话、常驻输入及真实领域入口；会话页承担新建、查询、历史与管理；学习页暴露已实现的练习/错题/复习/报告；日记页提供按需生成和往期读取。模型、人格、数据与系统能力集中在设置，附件/语音/复制/朗读靠近对应操作。手机保留 Material 3 四卡和大角色，原生 `pluginDefinitions=[]` 保持，学习面板由受信 App 组合根注入；普通 Web 的学习入口由 `focus-mode` 的 companion 扩展提供，两端装配分别验证。

**第三批剩余（本条未关闭的原因）：** Focus 未完练习恢复与两端报告重开仍未接线（报告 API 已有，但共享 `PracticeStorePort` 缺读取方法，两端报告仅在内存）；跨崩溃未知意图、完整跳过流程、完整 provenance/撤权传播、用户效果与真实模型仍开放。界面存续期已冻结含耗时、提示、时区的完整作答请求快照与原幂等键，未知回执不换键或重复计分；来源状态不等于外部 Grant，自动建议派生保持关闭。

**指标与实验：** "每周有效帮助会话数"须先在指标字典明确版本与成功判据：真实请求、可用产出/下一步及用户确认采纳，多轮修订去重。模型 Completed、页面打开、复制和未解决的继续对话不自动算成功；WELS 保留为学习域子指标，旧数据不混算。首轮用人工核对的小样本定位卡点，不新建分析数据责任；EXP-004 首轮对照固定 Provider/权限/能力，仅比较接续入口与可解释建议，长期记忆由 EXP-002 单独检验。

**人格形象（已合入）：** Mizuki 是当前唯一默认及内置可选形象。共享渲染、三个第一方界面与桌面引导已删除默认占位组件、样式、导出和降级链；人格设置支持可选 Live2D 绑定，运行按实际激活修订解析，失效引用保留并显示 Mizuki。HTTP/native/client 同步字段与确切修订读取，无 SQL 迁移；桌面保存不自动启用，手机按保存回执启用确切修订，失败保留已保存回执并单独重试。

**首次配置（已配对合入）：** 旧桌面引导重组为共享四步配置，真源迁入 `plugins/surfaces/panels-ui`，Electron、Web 与显式 mobile 由组合根接入。保留实际激活的人格形象、已完成标记、首次明确跳过和回放退出；回放只隐藏已挂载 Surface，保留原会话、草稿和未确认请求所有者。Android 模型步骤注入已有原生设置并消费真实配置回执，不调用未接线 HTTP LLM 配置；原生接缝仍归 ITER-009。

**实施依赖与范围：** 共享 Controller、Client、历史和领域事实继续复用，界面不直接写仓储或复制调度器。第一方 UI 修改走集合仓/主仓配对 PR；声明工具先做 ITER-075 的只读清单接线，附件进入模型前先满足 ITER-076。安全修复与产品设计可并行，恢复拒绝未闭合前不开始真实用户数据验收；后台主动、跨端同步、Shizuku、第三方 UI 和广泛外部连接按各自前置推进。

**各批交付索引：** 第一批 [PR #358](https://github.com/3yearsZhuang/Aervox-harness/pull/358)；第二批 [主仓 PR #362](https://github.com/3yearsZhuang/Aervox-harness/pull/362) 与[集合 PR #12](https://github.com/Aervox-agent/Aervox-plugins/pull/12)；第三批 [主仓 PR #387](https://github.com/3yearsZhuang/Aervox-harness/pull/387) 与[集合 PR #16](https://github.com/Aervox-agent/Aervox-plugins/pull/16)；配套 [PR #361](https://github.com/3yearsZhuang/Aervox-harness/pull/361)、[集合 PR #11](https://github.com/Aervox-agent/Aervox-plugins/pull/11)、[PR #389](https://github.com/3yearsZhuang/Aervox-harness/pull/389)、[集合 PR #18](https://github.com/Aervox-agent/Aervox-plugins/pull/18)。冻结提交、配对 SHA、失败与复验过程由这些 PR 与 CI 保存。

<a id="iter-064"></a>

### ITER-064 · 进行中：历史 API 契约按用户路径收敛

CAP 与合同遵循 [API 约定](docs/reference/API_CONVENTIONS.md)，依赖 ITER-063 的共享声明、认证与兼容门禁。2026-10-15 基线 147 条，现剩 **116 条**；唯一明细是[实际路由例外](apps/api/test/fixtures/openapi-route-baseline.json)，不刷新基线隐藏遗漏。第三批学习闭环补齐 `GET /v1/knowledge-items/{knowledgeId}` 的共享响应并移除其精确例外。

- **顺序：** 先隐私/配置/插件及技能写入口，再补当前会话详情/历史、作答/分支入口和 CLI 所需接口，随后内容/学习/主动模块剩余分组。ITER-071 的鉴权与原子性修复不等待全部历史路由清零。
- **验收：** 精确方法/路径、稳定 operationId、请求与成功/错误 Schema、认证、真实请求和旧客户端行为；新增遗漏/扩大豁免被拒绝，每补一个删除其精确例外。JSON 共享端点不改变 SSE/文件/二进制协议，破坏性变化单列迁移决定。
- **历史真源前置：** 本轮接续普通在线 user 的真实 Message 身份和 assistant 空版绑定，终态/取消/恢复事务发布已提交安全前缀、当前指针及 sequence 水位；审批续接保留已存前缀，人工编辑不被迟到写覆盖。来源/删除资格与日记、FTS 派生同步收口，旧 unlinked/import 不迁移、不从事件猜造正文。模型上下文对新消息改读长期当前版本，清理在线事件后仍能读取；保留 20 轮/32000 字符预算及旧路径边界。用户历史分页 API、CLI 与工作台抽屉由下列切片接续，当前集成与 PR 证据另记。
- **本轮持久历史读取：** 新增共享 `GET /v1/sessions/{sessionId}/history` 与 headless Client，CLI `sessions history` 和工作台“对话回看”读取同一当前版本投影。单页默认 20/最多 50 个候选，按插入顺序显式向前翻页；隐藏候选不额外扫描填充，空页仍可返回游标。单轮 100 消息/256 KiB、整页 512 KiB，超限含游标转义膨胀返回明确 422，不截断成功正文。未完成状态保留、脱敏正文为 null，旧 unlinked 只读，不从事件补造缺失历史；无首 User 的导入轮仍受保守来源门槛阻断。工作台单页替换，关闭/切会话/改页数清正文并释放旧 GET，不改变实时 Controller；完整授权传播、真实模型与移动独立运行仍分别验收。
- **首页会话读取候选：** 配合 ITER-053/061，`GET /v1/sessions` 使用共享 `limit`/`offset`/`projectId` 校验，单页默认/最多 100，`GET /v1/sessions/{sessionId}` 只读取已有概要。HTTP 与原生 Transport 使用同一 DTO，移除内部 executionPolicy；未知参数、重复参数及非法分页在 SQL 前拒绝，missing selected 返回 404。103 条真实 SQLite 回归确认分页与直读不创建会话或 Turn，首 100 条之外的已选身份无需改成新会话；NUL 文本读取/回执修复见第二批记录。本地全量与 Chromium 已通过，配对 PR 待审；列表 offset 是即时投影而非固定快照或完整导出。
- **本轮验证：** 最后代码的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务，API 967、仓储 820、Host Agent 123、Host Runtime 306、Core 501、Worker 161、客户端 234、CLI 148、UI 155 项通过，1 项既有真实模型跳过保留；守卫、OpenAPI 兼容、HLS、删除故障、Native 与 文档门禁通过。打包安装 CLI/真实 Token API/文件 SQLite/重启/清理在线行/分页及隐藏 2 项通过，Chromium 全套 23 项通过，其中 390/1280px 真实浏览器新回看 2 项；依赖审计 0 未审阅、2 既有审阅路径、0 过时例外。独立复核发现合法中文 ID 被旧 CLI 限制，以及 NUL 转义使游标超限，新增反例修复；首次全量因 CLI 直接依赖 Contracts 被架构守卫拒绝，改由 headless Client 暴露共享校验，未放宽依赖规则。随后只补验证记录并复验文档，[PR #332](https://github.com/3yearsZhuang/Aervox-harness/pull/332) 的 `30e75c57` 已通过 5 项远端检查，并已合入主线；完整产品责任仍按下列剩余验收推进。
- **剩余产品责任：** Neo 生命周期；分支来源、完整删除、布局恢复、大图性能；反馈读取预算、回答版本关联和复核队列。图读取行数预算不证明 SQL 排序时间或单布局字节有界。

| 已合并切片 | 保留行为与数量 | 证据 |
|---|---|---|
| 隐私/偏好 8 接口 | 宿主身份审计、默认偏好/版本、删除去重与 202；147→139 | [PR #298](https://github.com/3yearsZhuang/Aervox-harness/pull/298) |
| 插件配置 5 接口 | Schema 深度、revision CAS、Secret 脱敏、generation 不变；原已有声明，不减少例外 | [PR #311](https://github.com/3yearsZhuang/Aervox-harness/pull/311) |
| 基础技能 7 接口 | 整数旗标/信封、204、所有权/只读、归档写前冲突、取消提交门禁；139→134 | [PR #314](https://github.com/3yearsZhuang/Aervox-harness/pull/314) |
| 会话分支 8 接口 | 201/软删 200、必需 JSON/null 布局；图迭代去重/断连，1000 会话/10000 唯一分支超限 422 不部分返回；134→126 | [PR #315](https://github.com/3yearsZhuang/Aervox-harness/pull/315) |
| 质量反馈 2 接口 | actor 取认证上下文、剥离旧 body.actorId；重复查询/类型写前拒绝，扩展字符串/nullable note/201、200/旧 void 行为；126→124 | [PR #318](https://github.com/3yearsZhuang/Aervox-harness/pull/318) |

本轮在 `fix/plan-safety-contract-continuation` 接续插件列表、启停/卸载、授权/有效感知列表/撤权及权限查询 7 个端点，精确例外 124→117；保留完整插件行、整数旗标、nullable/扩展元数据、撤权 200 行与卸载 204。撤权 SQL 同时绑定 grant ID 与 URL 的插件 ID，错误插件路径返回 404 且原行不变；仓储/HTTP 反例先红后绿。定向仓储 5、API 30、Contracts 100、客户端 218 项、相关类型及 OpenAPI 兼容通过，全量与新 PR 另验。首次全量拒绝生成 OpenAPI 超出受跟踪文件预算，现复用命名插件响应与既有 ModelRuntimeState，生成物降至 938288 B，兼容及卫生门禁通过；不扩大预算或删除契约。

本轮接续 LLM 配置读取/保存、连接探测和四个 Preset 端点，共 7 个共享声明；保留已有 operationId、默认配置、可空密钥、首个 Preset 自动激活、删除 200 回执及探测失败 200/ok=false。它们原已列入 OpenAPI，精确例外仍为 117；只补三处历史必需请求体的精确文档纠正，不刷新基线。连接错误使用固定消息，不回传凭据 URL、Provider 错误正文或内部异常；新增泄漏反例；连接探测的既有截止原先只覆盖响应头，现贯通正文与能力读取，真实 200 半截流/慢主响应与 500 不结束正文均验证释放。CLI 编码脱敏及最终集成验证与新 PR 证据另记。

本轮 LLM/CLI 最终新的 `./aervox ci all` 退出 0，构建 32、类型 56 个任务及守卫、OpenAPI 兼容、HLS、删除故障、Native 和 文档门禁通过；API 960、仓储 742、Worker 161、Host Runtime 306、Core 501、Host Agent 121、客户端 230、CLI 131 项通过，1 项既有真实模型跳过保留。独立复核捕获编码密钥路径/标签、响应正文无截止和异常能力元数据三处缺口并补回归修复，真实 API 13、CLI 模型 41 项通过；打包安装的 CLI 连接真实 API/临时文件 SQLite，模型配置及 Preset 跨 API 重启保持，2 项集成通过。依赖审计为 0 未审阅、2 既有审阅路径、0 过时例外；随后仅补本条记录并复验文档，精确提交远端结果由新 PR 保存。

首次旗标构建及客户端 undefined 回归失败与后续修复保留在各 PR/CI 和[原计划](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-064)。

<a id="iter-033"></a>

### ITER-033 · 确定性切片已交付，真实 Provider 与代际接续待评审

CAP-002/007、本地模型基础设施。Core Provider 与本地 Driver 的统一目录、配置/能力接线、Faux 取消/故障、stop reason/usage 落库及通用 ModelRuntime DTO 由 [PR #282](https://github.com/3yearsZhuang/Aervox-harness/pull/282)交付；原 `Llama*` 别名/driver 元数据与完整可移除性仍需复核，不能据夹具宣称真实 llama 可用。

- **下一步：** 先与 ITER-071 统一协议、配置、单次生成的最终输出和预算；固定真实 Provider 验证取消/故障/就绪及完整对话闭环，再补注册 generation 的宿主失效消费、跨 Provider 上下文交接和实现移除演练。用同一 Fake/Replay 轨迹对照终止语义与 usage 分账，新增兼容端点只注册声明，不改执行器/路由。
- **边界：** 依赖 ITER-008 制品/进程安全；Driver 缺省 unavailable，受限本地任务不得静默转远程。新增远程 Provider、制品信任或两栈持久语义改变先 ADR，不建第二注册真源；标准测试桩关联 ITER-040，Core 零运行时依赖保持。
- **本轮目录修复：** 外部输入、getter/list 与工厂共享可变描述符，原本可不递增 generation 就改变能力与本地声明；同 ID 不带工厂重登记还会沿用旧 handler。4 项回归先红后绿，现由注册表持有独立快照、冻结内建种子，并随新登记替换工厂；custom 缺工厂拒绝，内建协议按新声明创建。定向目录 11 项通过；不取消旧实例或在途请求，真实 Provider 与宿主失效消费仍未整体验收。

<a id="iter-029"></a>

### ITER-029 · 执行中：连接版 CLI 补齐现有会话闭环

`@aervox/cli` / `siyu` 只消费本机 API 与 `@aervox/api-client/transport`，CAP-002/007/020。单次/TTY 连续会话、事件补读/终态、诊断、配置读写、JSON/JSONL、Token/幂等、审批/补问/有界取消已由 [PR #308](https://github.com/3yearsZhuang/Aervox-harness/pull/308)、[PR #319](https://github.com/3yearsZhuang/Aervox-harness/pull/319)交付。

- **下一步：** 基于 ITER-064 的持久历史分页，完成真实模型下的跨客户端/API 重启接续与平台矩阵。学习/复习、记忆专用命令、独立运行另验，不扩大首个连接版为独立宿主；不增 Schema、中心服务或第二执行栈。
- **本轮历史入口：** `sessions history <ID> [--limit 1～50] [--cursor …]` 只请求显式一页，JSON/JSONL 保留共享 DTO；TTY 区分有效输入、未完成前缀和只读/隐藏记录并清除控制序列。采用共享 Session 参数校验，支持中文及带斜杠的已有 ID；不创建/取消 Turn、不自动重试或改变上次执行回执。安装制品连接真实 API/文件 SQLite，跨 API 重启及清理在线行后的分页/隐藏读取另验。
- **本轮模型配置入口：** 共享 headless LLM Client 供 CLI 与 Vue 使用；`models` 提供目录、配置、连接探测及 Preset 管理，配置从文件读取，密钥可经环境变量注入，输出仅白名单字段和去除凭据/查询的 URL。省略 apiKey 仍按旧合同清空，命令不存本机模型密钥；不把模拟探测当真实 Provider 验收。
- **验收与边界：** 打包产物+真实 API/文件 SQLite，非交互不自动批准，观察超时/失败不取消已受理回合，中断有界取消；共享包不反向依赖 CLI。列表 limit 有界、offset 安全整数，只翻用户指定页，offset 非快照；不当完整导出。
- **证据：** 重启后 102 个临时会话的默认/末尾/空页和接续、全量及远端检查通过；不等于真实模型/正式平台发布。首次无退出码及旧依赖失败保留在[原计划](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-029)及 PR。

<a id="iter-062"></a>

### ITER-062 · 自动化切片已移交，真实 Bot/部署验收待环境

第一方文字适配器、连接代际、持久队列与来源隔离由 [PR #284](https://github.com/3yearsZhuang/Aervox-harness/pull/284)交付，决定见 [ADR-029](docs/reference/adr/ADR-029-bot-platform-adapters.md)。保留原条目承接剩余，避免在“已移交”表中隐藏。

- **下一步与验收：** 在可用账号/环境下分别验证微信扫码/配对/连续对话、QQ/NapCat 多成员隔离与重连、独立宿主/关闭窗口后运行、Linux 重启恢复；真实模型与平台连接分别记录，依据[接入指南](docs/how-to/connect-bots.md)。缺环境保留未验，不把模拟协议替代实证。
- **边界：** 连接验证可与 ITER-015 必要部署切片并行，独立运行/重启恢复依赖其主管能力及当前授权/恢复门禁；缺 Bot 账号不阻断本机产品交付。回退先停适配器，未知结果不盲重发，不能扩大来源权限或把连接成功当回答成功。

<a id="iter-015"></a>

### ITER-015 · 主管切片已实现，安装升级与分发待评审

ARC-13、CAP-001/018/027。[PR #272](https://github.com/3yearsZhuang/Aervox-harness/pull/272)已有原生主管切片；完整 API/Worker/模型归属、数据目录、端口、Token、版本、就绪与退出仍须整体验收。

- **依赖：** ITER-006/008 与 ITER-011/013 必要门槛，新主管差量先 ADR；与移动运行位置决定协调，不因现有 Helper 自动认可部署方案。
- **验收：** 干净用户目录安装、升级、中断、端口占用、磁盘满、异常退出及卸载保留数据；签名/公证/平台实机矩阵独立记录。ITER-008 的 ETag/If-Range 持久化、磁盘/时长及就绪分级剩余先核对发布所需范围，不能以下载或 HTTP 200 证明模型可用。

<a id="iter-032"></a>

### ITER-032 · 基础投影已交付，长对话保真与真实摘要待评审

CAP-002/005/007，对话质量基础设施。[PR #281](https://github.com/3yearsZhuang/Aervox-harness/pull/281)已有保真事实输入、可注入摘要器、Base 后加载历史、字符预算、零尾部及空摘要拒绝；规则裁剪仍明确“未生成摘要”。

- **下一步：** 先评审必须保真的目标、未解决错因、偏好、承诺与来源，再接产品权威事实加载及真实摘要 Provider；涉及对话契约差量先 ADR。真实摘要默认关闭，不伪造压缩后记忆；最终窗口与 ITER-007/033 协同，测量归 ITER-017。
- **验收：** 固定长对话的事实/来源可追溯，超大工具组不破坏调用/结果配对，最终输入+预留输出不超窗口；每次模型可见投影可从权威历史重建，展示与持久历史分离，旧响应不覆盖终态。压缩不是删除，原文/摘要/索引受 ITER-003/010 全链门槛约束。参考[架构历史来源](docs/reference/ARCHITECTURE.md#upstream-20260929)及[压缩边界](docs/reference/ARCHITECTURE.md#1342-pi收敛核心职责让阻塞失败可见)。
- **审计定位：** [生产执行装配](packages/host-runtime/src/modules/companion/conversation/agent-executor.ts)仍调用无 summarizer 的规则压缩，[Core 上下文构建](packages/core/src/context-builder.ts)明确报告未生成摘要；权威保真事实加载与真实摘要 Provider 尚需接线，以真实长对话的事实/来源保持和失败降级关闭，不能只凭字符裁剪或注入接口存在宣称摘要完成。

<a id="iter-012"></a>

### ITER-012 · 待实施：索引生命周期与可切换投影

ARC-08、CAP-005/026。依赖 ITER-003 删除/召回资格，错误 SQL 可独立修；不恢复旧隔离列。

- **下一步与验收：** dirty/reindex、来源修订、模型/维度版本和可选旧列回填；投影切换/模型版本先评审。故障可追平、A→B→A 切换、资格零越界；固定中文语料单列 Recall@K、空间及重建成本，性能收益归 ITER-017 测量。
- **审计定位：** [向量补齐](apps/worker/src/embedding-migration.ts)按模型 ID 扫描 `e.id IS NULL`，尚无完整来源修订失效重建。补来源修改后旧投影失效、故障追平及模型/维度切换反例；现有 FTS/向量查询和补齐基础不等于生命周期完成。

<a id="iter-026"></a>

### ITER-026 · 已有实现待评审：第一方学习插件边界

S1～S7 及评审修正由 [PR #250](https://github.com/3yearsZhuang/Aervox-harness/pull/250)实施，决定见 [ADR-016](docs/reference/adr/ADR-016-base-boundaries.md#cr-060)，CAP-002/007/016；本条做有限验收，不启动新一轮全宿主改写。学习闭环保留主仓事实真源，`plugins/focus-mode` 不转自选模块，不改 CAP-003/004/006 端点。[ITER-073](#iter-073) 与已接受 [ADR-031](docs/reference/adr/ADR-031-first-party-plugin-repositories.md) 允许 `plugins/` 集合仓整体以固定提交 submodule 挂回原路径，修订原源码托管限制；P0、默认构建与宿主数据责任保持。

- **复核：** 宿主纯净性零违规/零豁免，删除插件实现后三相移除演练与 Web/桌面组合根 typecheck 通过；组合根注入补独立渲染证据。插件禁用无专属请求/工具，旧配置一次迁入 pluginState 不丢失；安装记录/配置/数据管理保留，插件 id 唯一、历史别名全删。
- **兼容与产物：** 通用状态/metadata/流事件/槽位/设置/Composer/工具/路由接缝保留，Core 不含产品提示词/刷题工具；分发只含 manifest/config Schema/SKILL 且 SHA-256 可重现，协议或公开类型破坏性差量按 ADR-016 维护。ITER-071 的端口/DTO/事务剩余由其修复，本条不重复登记。
- **本轮隔离演练：** 精确提交 `4e0e7f39` 在独立临时克隆完成 seed/absent/restored 三相物理移除，0 缓存冷构建分别 21/18/21、Web/桌面类型依赖图 28/22/28 个任务通过；53 个源码/锁文件逐字节恢复、克隆工作区干净。宿主纯净性 470 文件零命中/零豁免、3 个可移除试点通过；数据夹具仅证明 Memory 保留/查询/导出/软删、通用工具、模型文件与 Unavailable 驱动，不涵盖 focus 旧配置迁移、禁用零专属请求、独立 UI 运行或真实模型，不能据此关闭整个 ITER-026/033。

<a id="iter-072"></a>

### ITER-072 · 进行中：FlowCampus 第一方校园规划插件（课表与导入切片已完成本地验收）

维护者要求在新分支以插件形式迁入 FlowCampus。基于主线 `9e4f047a` 在隔离工作区实现，不纳入并行 Android 原生运行时和设置改动。沿用 CAP-020 第一方受信构建、ADR-030 行为所有权与本地单用户 SQLite 数据责任；依赖 ITER-026 的插件生命周期和 ITER-053 的界面接缝。Android 独立宿主接线、系统权限与后台验收仍依赖 ITER-009。

- **本批范围：** `ap-tool-flowcampus` 插件内聚确定性下一站、出发时刻、空档任务预算、具体日期日程/地点/任务与手工路程维护；共享结果供移动陪伴卡片、工作台和只读聊天工具消费。去除固定演示时钟和自动种子数据，不启动第二套 FastAPI 或模型循环。
- **数据与接缝：** 首版有界校园文档复用现有插件配置 SQLite 存储、Schema 校验、revision CAS 与生命周期代际；插件只消费宿主绑定的配置窄端口，不导入仓储或使用浏览器状态作为业务真源。复杂对象数组补持久化回归；停用/缺包保留数据并撤销 UI/工具/端点；插件内导出校园 JSON，恢复默认及显式卸载沿用宿主清除规则。宿主“更多操作”在停用/缺包后保留普通数据导出与确认卸载入口，排除 Secret、orphaned 和默认值，相关 API/界面测试覆盖这项职责。通用陪伴插槽按定义支持范围装配，旧工作台插件不隐式进入移动陪伴根界面。
- **本地全量：** 新的 `./aervox ci all` 退出 0，构建 33、类型 58 个任务，以及守卫、插件/OpenAPI 兼容、HLS、删除故障、Native Search/Runtime 和 文档门禁通过；校园插件 67、API 1010、仓储 893、Host Runtime 306、Core 501、Worker 161 项通过，Host Agent 128 项通过、2 项跳过保留，不计通过。首轮集市夹具仍固定期望 9 个内置插件，更新为 10 并增加校园名称/配置声明断言后定向及全量通过。编辑既有日程保留未修改的秒、毫秒和夏令时回拨时刻，两个反例先红后绿。
- **真实浏览器：** 最终串行 Chromium 9/9 通过，含校园完整维护与预算、独立 HTTP 写者触发真实 CAS 409、提交后丢失回执的稳定 ID、320×360 返回层级/停用保留数据及主动陪伴 5 项回归。此前与全量构建并行时有 1 项超时，trace 确认两次 Vite 整页重载使抽屉消失；保留失败记录，随后串行复验通过。CAS 用例先截获浏览器 PUT，再提交独立写者后继续原请求，避免分钟刷新抢先发现冲突，保留 409/草稿/导出/重载断言，未强制点击或扩大超时。
- **可移除性：** 在独立临时克隆物理移除校园及专注插件代码，API/Worker 冷构建和 Web/桌面类型检查通过；校园 SQLite 配置保留，源码与接线恢复后冷构建及数据断言通过。该演练证明宿主可在缺少实现时运行和保留配置，不替代缺包后的独立数据管理入口验收。
- **生态集成修订：** 按 ADR-031/032 将校园源码迁到集合 `plugins/tool/flowcampus`，主动陪伴改动在集合 `surfaces/proactive-ui`；包名保持，首次生态身份为 `ap-tool-flowcampus`。旧候选 `flowcampus` 试用数据保持原记录，不自动合并，也不扩展九插件身份迁移表。修复数字坐标输入的类型错误并增加真实表单回归；精确配对提交与新一轮验证由 PR 记录。
- **课表与导入接续（2026-11-18）：** 已按现行主线恢复周课程、隔周/跨日、单次到达/取消/调课及有界 CSV/ICS 预览导入。课程草稿、导入预览和保存绑定 revision/生命周期，沿现行配置 Port 与 CAS；稳定来源防重复，跨类型冲突在预览时报错。发行版本 1.1.0 以可选字段扩展校园文档和配置 Schema v1，旧数据读取不改写，配对与回退责任见[插件契约](https://github.com/Aervox-agent/Aervox-plugins/blob/main/plugins/tool/flowcampus/README.md#数据与并发)。日期线周界、跨单次/系列来源冲突、ICS 字面双引号的反例先红后绿，插件 113 项、API 配置消费者 12 项及真实 Chromium 课表/导入用例通过；生态标准与可重现分发包通过，新增私有实现及测试已补精准可移除登记。独立源码和最终三切片合并树审查通过，独立课表及共享引导/删除组合的全量终审均退出 0；远端暴露的异步预览测试竞态已用真实 DOM 完成条件修正，保留所有原断言，插件 113 项、独审及修复后的新完整门禁再次通过。原失败、原件和跳过项保留。[集合 PR #20](https://github.com/Aervox-agent/Aervox-plugins/pull/20) 的精确最终 head 已通过远端全量并合入实际 SHA `3aafc1ef39695642933bc2425269eae55cc53ca5`，合并树与已测候选完全一致；[主仓 PR #391](https://github.com/3yearsZhuang/Aervox-harness/pull/391) 固定该提交并完成五包类型、插件 113 项、API 配置消费者 18 项、11 份分发包与生态标准复验，最终主仓远端结果由 PR 保存；前序共享引导已由 PR #389 合入，未知会话删除恢复已由[集合 PR #19](https://github.com/Aervox-agent/Aervox-plugins/pull/19) 与[主仓 PR #390](https://github.com/3yearsZhuang/Aervox-harness/pull/390) 配对合入，原 ID 的只读 GET 检查与迟到回执所有权保护已交付，不以本地绿测代替正式发布。
- **审查交付：** [PR #347](https://github.com/3yearsZhuang/Aervox-harness/pull/347) 提交首批实现，代码提交 `2780d2cf`；随后仅补本条审查回链并复验文档。精确 PR HEAD 的远端检查在 PR 保存，本条不以本地绿测宣称已经合入或正式发布。
- **剩余验收：** 本批两仓精确提交与远端结果由配对 PR 保存；首批历史验收不替代新增行为。真实高德、定位、系统通知、原生独立端插件存储接线与签名发布继续开放，不以页面可运行代替这些能力。

## 5. 有证据再投入的性能与维护工作

<a id="iter-017"></a>

### ITER-017 · 待评审：统一测量与收益决策

FND-07/08/10、ARC-05/08/12。依赖 ITER-013 的正确性和指标；依据 [ADR-024](docs/reference/adr/ADR-024-native-runtime-boundaries.md)测量代码搜索、向量端到端、三平台活动 Helper 与计算隔离。[PR #272](https://github.com/3yearsZhuang/Aervox-harness/pull/272)已有有界搜索、向量对照、活动 Helper、音频/插件 Worker 及 Cargo/IPC 收敛；ITER-071 另补语义差分与资产归属，不据此宣布生产收益。

- **下一步与验收：** 同设备同数据报告 P50/P95/P99、失败率、内存、质量，分别决定 Prompt/压缩、SQLite 竞争、topK、隔离及资产缓存投入；未达收益门槛就停止，不为表面速度扩大 SQLite 测试并发。生产索引迁移、签名、真实权限/设备单独取证。
- **本轮受控基线：** 在独立克隆 `4e0e7f39`、同一 Core 构建摘要下复跑 large/small-chunks 各 5 样本，均退出 0。macOS arm64 开发机首段 P50/P95 分别 31.575/32.546 ms 与 50.974/52.067 ms，取消 P95 53.662/52.353 ms，最大提交批次 3840/80 B；写入点采样堆峰约 7.54～9.00/7.82～8.91 MB。仅 Fake Provider/内存存储、小样本且非独占机器，不作为真实模型、生产收益或完整内存峰值证明，不新增性能阈值。

<a id="iter-027"></a>

### ITER-027 · 待评审：SQLite 写竞争与后台退避

ARC-05/FND-07，依赖 ITER-002 Outbox 归属、ITER-013/017 指标。IPC 唤醒、写压退避和连接自愈已实现，真实单用户仅部分达成；双写极限仍受 SQLite 单写者吞吐限制。

- **验收：** 固定密集会话/后台任务样本，验证退避至 3s+、避免空写轮询，报告 SQLITE_BUSY、锁冲突、P99 及长周期表现。原零冲突目标仅在明确支持负载下验收，不能承诺任意负载；保留 WAL 快照与短事务，不盲重试 BEGIN，不把外部副作用放入事务。本地 socket/命名管道替代轮询按测量决定。
- **本轮演练差异：** 首次真实演练因脚本仍从仓储旧出口读取 `sendWorkerIpcMessage` 失败，现仅改为进程协调公开出口。保留原失败，在同一隔离克隆、2 写者、15 秒写入+15 秒 drain 下复跑 0/40 ms 节奏，两组写入均成功、逃逸错误均 0，但仍分别剩余 15146/270 个 Outbox，整轮退出 1、NOT CLEAN；未放宽 drain 或成功判据。压力期最小观察间隔 3067/3056 ms，写延迟 P99 4.872/6.988 ms，连接自愈 5473/353 次，零逃逸不等于零竞争。只证明退避与保留积压，排空、长期和支持负载仍未完成。
- **有限负载补测：** 仅将生产节奏改为 500 ms，其他参数和截止相同，双写者共 60 Turn/消息、120 次写入、60 事件全部消费，0 pending/failed/dead-letter/孤儿，整轮 CLEAN、退出 0；写延迟 P50/P95/P99 3.151/7.022/11.045 ms，压力期间隔最小 3346 ms。该设备一次约 4 Turn/s 的有限点通过不覆盖 0/40 ms 失败，不建立生产吞吐区间、零竞争或长周期 SLA。

<a id="iter-040"></a>

### ITER-040 · 建议：标准测试 Provider 与可选重试

依赖 ITER-039，服务 ITER-033 parity。先统一 replay/scripted/adapter-sim/mock 能力声明与标准轨迹，无法合并的桩写明用途；不为统一名字扩大维护面。

- **条件与验收：** 真实需求成立后才做默认关闭、可注入的单请求重试：有界次数、指数退避/jitter、429/5xx/overloaded 与配额/计费错误分类；与宿主跨 Provider 降级只留一处政策，不新增 Provider、不破坏 Core 零运行时依赖。默认关闭时行为不变，重试不能重放未知副作用。

<a id="iter-079"></a>

### ITER-079 · 已实施待评审：测试经济性——并行度、超时与配置断言的实测修订

维护者指出测试投入相对产出偏重。先以可证伪方式定位"过度"，再只改有证据的部分；不删测试、不降低覆盖。

| 假设 | 实测结论 | 处理 |
|---|---|---|
| 每包并发必须固定为 1，否则 SQLite 锁争抢 | 前提部分不成立。测试库一律经 `mkdtemp` 分布于各自目录，HTTP 监听一律 `port: 0`，不存在共享库文件或固定端口。但**共享磁盘带宽争抢确实存在**：fsync 密集型用例 4 workers 比串行慢 20–40%。整体仍净赚：`repositories` 2m47s→1m29s（1.87x）、`api` 3m34s→1m38s（2.18x） | 改为半核数并封顶 4（10 核机 4、CI 4 核机 2），保留原反超订意图；代价由宽裕超时吸收 |
| 默认超时必须 30s，否则并发抖动误红 | 部分成立。初审把分布记成"仅 1 项 ≥10s"，独立复审实测后更正：4 workers 争抢下 `schema-staging` 单项达 8.3–11.6s（同机 ±40%）、`schema-table-contract` 参数化用例 4.4–9.9s 并偶发顶穿 10s。这些用例对**磁盘带宽争抢**敏感，不能靠"找出唯一慢的那个"解决 | 默认收到 15s（覆盖实测最坏 11.6s 并留机器差异余量，仍比 30s 提前一半暴露死锁）；三项长用例就地标注 30s（v1 迁移演练、schema staging 重建、LLM 流上限探测、原生进程生命周期） |
| 守卫断言配置命令文本是必要保护 | 部分成立。它们确实防住"集成套件被悄悄移出门禁"（提交 `4a845b29` 即为此修复），但把参数顺序与空白一并冻结：新增第 6 个补丁测试、或调换 `--test` 顺序即失败，而覆盖未变。初审只估到 20 处，复审后全量清点为 4 个文件 13 处 | 新增 `scripts/gate-config.mjs`：解析门禁实际调用的脚本集合断言成员关系；`assertCommandOrder` 只比较 token 位置以守住"构建先于测试"；`assertCommandIncludes` 断言动作存在而不冻结措辞。4 个文件的 13 处全部改用这些助手，新增/重排不误报，移出或顺序反转仍立即失败且报出具体项 |
| `apps/api` 的私有实现测试应在包内 | 成立但牵动面大。39 个候选中 4 个共用 `conversation-fixture`，其余经 `@aervox/host-runtime-test` 别名访问；全量迁移会移除别名存在意义 | 先迁 3 个零夹具用例建立模式（`ecosystem/mcp`、`companion/memory`、`knowledge/content`），其余留待后续；不批量打散 |

**失败模式判断的补充：** 对 `practice-review` 做变异测试，掌握度增量 `+0.1→+0.11` 被 2 项捕获、复习间隔边界 `streak===3→4` 被 3 项捕获，说明断言有效性充分；问题在分布与单位，不在数量。

**独立复审更正（同日）：** 初版有两处实质缺陷，均已修正而非放宽判据。其一，配置断言助手只做成员判定，`... || true`、`... | cat`、`; echo` 等改写会让脚本"仍在命令里"但失败不再传播，等于覆盖被悄悄废除——现已改为先拒绝这类吞错形态，并补 `scripts/gate-config.test.mjs` 七项回归（该助手此前零覆盖）。其二，10s 默认值在 4 workers 下会真实误红 `schema-table-contract`（复现 2 项失败），且"仅 1 项 ≥10s"的计时分布本身记错，现按实测改为 15s。

**验证：** 全量 `pnpm test` 65/65 任务退出 0；守卫 247/249，2 项失败为既有 mise 临时目录配置解析限制，在未修改树上复现相同；边界与架构守卫通过；Host Runtime 419 项（原 407）、API 1075 项（原 1096，相差即迁出的 21 项）。收紧超时后曾立即暴露 `native-runtime` 一项 10.3s 用例，原先仅因 30s 覆盖而通过，已就地标注而未放宽全局值。

**剩余边界：** 未做全量测试迁移；`check-dev-launcher` 两项失败归环境，未修改；本修订只覆盖测试执行经济性，不改变任何产品行为或测试判据。

## 6. 条件性扩展与研究

以下保留原提案或条件授权；进入实施前满足各自前置。设备/移动定位可做轻量决策准备，当前不分配硬件开发、第三方平台或 HLS 真实环境工期。

<a id="iter-077"></a>

### ITER-077 · 部分范围已裁决：本地能力与后续可选插件

用户已要求将 `c1af1099` 声明审计结果列入本计划。本条协调以下 7 项的范围、优先级和依赖裁决；CAP ID、分类和状态仍以[覆盖矩阵](docs/reference/REQUIREMENTS_TRACEABILITY.md)为准，此轮登记不将全部远期能力视为已经启动开发。相邻功能、Schema、仓储预留和插件安装机制不是完整产品闭环。

**维护者范围决定（2026-11-06）：** 当前主线保持本地单用户；CAP-028 社区、CAP-029 公开名词页、CAP-031 内容与技能市场、CAP-032 机构与监护留作后续独立阶段，并作为可选插件承载。复用现有 Manifest、权限、生命周期和卸载边界；Host 不增加租户隔离。此决定允许继续制定插件契约与隔离验证，不指定公开服务部署、账号、结算或机构数据责任；这些差量沿现有 ADR 和对应能力验收继续完成。CAP-021/022/024 的近期场景与质量边界仍按下表接续。

**契约切片已合入：** [PR #364](https://github.com/3yearsZhuang/Aervox-harness/pull/364)（`84430da4`）交付以下合同：[PRD](docs/reference/PRD.md#optional-ecosystem-scope)、[SRS](docs/reference/SRS.md#optional-ecosystem-plugins)、[ADR-030](docs/reference/adr/ADR-030-behavior-ownership.md) 与 [ADR-031](docs/reference/adr/ADR-031-first-party-plugin-repositories.md#后续-p3-可选插件的适用范围) 已按上述决定形成默认禁用、显式装配、原授权/代际及缺插件时核心数据权利的适用合同；覆盖矩阵四项仍为 `Mapped`、P3/R5。公开发布与撤回、社区审核、市场结算/退款、机构账号/监护同意和外部副本责任继续作为未决门槛，不以空壳插件、Schema 预留或文档检查计为实现。真实环境、运营主体与重大机制须后续独立评审。

| CAP | 待裁决范围与最低闭环 | 已有切片与依赖边界 |
|---|---|---|
| CAP-021 学习路线与视频推荐 | 推荐来源、排序/解释、失效、反馈与商业内容标识 | 已有学习计划生成不代表视频推荐；复用学习事实，不建第二真源 |
| CAP-022 兴趣分析与跨域推荐 | 授权信号、解释、关闭/重置、敏感属性限制与偏差评估 | 画像推断不等于推荐；依赖 CAP-033 授权/本地处理及 ITER-003 删除责任 |
| CAP-024 文献阅读与发散 | 解析格式、页码/段落引用、长文分段、来源/版权与失败恢复 | 通用附件入口和 ITER-076 OCR 不替代完整文献阅读 |
| CAP-028 社区互助 | 发布/回答状态机、角色/信誉、举报申诉、审核与未成年保护 | 后续可选插件；发布/审核/未成年保护的服务与数据责任另行验收 |
| CAP-029 名词解释网页 | 发布、更新、撤回、来源失效、分享/SEO、隐私预览与版权 | 后续可选插件；公开范围、版权及撤回责任仍须契约与部署验收 |
| CAP-031 内容与技能市场 | 商品/版本、审核、许可证、结算/退款、下架与已购兼容 | 后续可选插件；Registry、预检和声明包安装不等于完整市场，依赖 ITER-075/005/006，第三方执行另依 ITER-019 |
| CAP-032 机构与监护模式 | 角色/邀请移除、最小可见、同意、审计与授权报表 | 后续可选插件；Host 保持本地单用户，机构授权与数据责任独立，不得借旧结构恢复租户隔离 |

- **进入条件：** 逐能力决定纳入近期范围、继续保留远期或取消/替代，保留原 CAP 与原因；明确真实用户场景、服务形态、成本、数据/权限/版权责任及可测试验收。重大决定先进入 ADR，未决部分保持待评审；已有实现相关的 28 项继续由覆盖矩阵的剩余条件和原 ITER 承接，不新增 28 项重复任务。
- **退出条件：** 7 项分别有明确范围决定、依赖与后续归属；被选中且达到 Ready 的实际实施再沿用合适 ITER 或按规则分配新号。正式发布仍须目标环境与数据/安全门禁，不以本条范围登记提高实现或发布状态。

<a id="iter-078"></a>

### ITER-078 · 实现已合入，真实用户库与运维待验收：可选 PostgreSQL 主库插件与离线迁移

维护者要求用户自主安装可选数据库插件，将整个实例的业务主库迁到自管本机或远端 PostgreSQL，包含已有 SQLite 数据。SQLite 保持出厂默认；决定见 [ADR-034](docs/reference/adr/ADR-034-postgresql-database-plugin.md)，可观察行为见 [FR-DATA-002](docs/reference/SRS.md#fr-data-002)，操作与兼容限制见[数据库契约](docs/reference/DATABASE.md#postgresql-operations)。本条沿用原编号，协调两仓实现和验证，不提高 CAP 或发布状态。

- **边界：** `ap-tool-postgresql` 为 optional，首次迁移/激活须已安装并启用；宿主持有原生驱动/Session、同源物理 Schema、领域仓储、主库外加密启动配置、迁移和恢复。激活后声明包缺席、停用或卸载不改变所选 PostgreSQL，宿主继续访问和管理主库、保留凭据；实际连接、凭据或目标身份/结构故障拒绝业务并保留离线修复入口，无旧 SQLite 回退。两种后端均保持单用户、单主库与原来源/删除/撤权责任，不恢复租户列或 RLS。
- **已明确的隐私决定：** 保留 BR-PRO-003/PRIV-PRO-002。远端或无法证明本机的目标拒绝主动数据及来源无法分类的历史，关闭画像不使旧数据获得迁出资格；运行时主动激活、处理和派生对话/提醒必须 fail closed。Vault、附件、设备身份与恢复控制账本保持原本机故障域，不通过清空/重标数据或本地 Vault 放行。用户负责自管普通远端主库的运营方、地区、访问、备份、保留和删除。
- **实现：** PostgreSQL 16+ UTF8 原生连接/方言、结构/实例指纹检查及当前仓储表达式适配；可选市场声明与安装语义；离线整库迁移、源锁和已验证备份、全行内容/引用/插入位置/搜索投影核对。启动选择和 CLI `status/migrate/activate/recover/abort` 接线已加入候选，源库保持封存，未知 COMMIT 不重放；凭据不进入普通插件配置，API/Worker 使用同一生效目标。组合根和远端主动拒绝已取得隔离回归证据。
- **依赖：** ITER-071 的领域事务/仓储边界；ITER-003/010 的删除与独立恢复账本；ITER-011 的备份保留和迁移；ITER-005/006/026 的首次声明安装/启用资格及声明生命周期；ITER-073/075 的集合仓兼容。激活后可选声明包不成为业务主库的持续运行依赖。已有安全恢复拒绝继续适用，不因新后端解除水位或数据门禁。
- **验证与证据：** 隔离 PostgreSQL 18.6 已验证物理 Schema/漂移、原生查询/事务、源/备份字节、全表行数与内容哈希、JSON/Unicode/NUL 和非法值拒绝、插入位置、搜索投影、活动源、未知 COMMIT 与 source/Vault/账本绑定。实际 CLI 准备/激活、API 重开与 Worker 持久写入、首次安装/启用拒绝、声明移除后已选主库保持、激活发布中断、连接/凭据/结构故障与远端主动拒绝均已回归。实际空库首次启动只产生结构版本与插件/技能/工具注册行；人格模块不自动写入内置人格，不放宽 `source=builtin` 的正文分类。
- **整体验证状态：** 早期候选 `6876e59a` 基于 `29e4fad2` 修正市场目录数量 10→11，随后整合 `7886042f` 及主线 `69670c95`。最终根冻结安装和 `./aervox ci all` 退出 0，API 1,068、仓储 1,211、Worker 180、Host Runtime 365 项通过；Host Agent 保留 2 项既有跳过，不计通过。守卫、依赖审计、构建、类型、HLS、删除故障、Native 与 文档门禁通过。前序两项迁移测试 30 秒超时在原预算下全量重验通过；删除研究的种子 FTS 正文与持久源不符已修正，并补独立索引前提及实际实现指纹，14 项研究回归含 175 场景报告通过。源与附件准入、权限快照、数据库/事务传递及研究夹具均经独立静态复审。插件候选见[集合 PR #13](https://github.com/Aervox-agent/Aervox-plugins/pull/13)，精确提交远端结果由配对 PR/CI 保存，不宣称发布或真实用户库迁移通过。
- **准入补强与前序验证：** SQLite 客户端绑定真实源路径，调用路径与真实路径的封存锁均生效，悬空文件符号链接和多硬链接拒绝；PostgreSQL 校验包含主键/UNIQUE 实际索引的 tablespace，以及 canonical 表跨 Schema 的继承/分区关系。本机资格绑定当前连接内核对端、OS 父进程和私有 postmaster 身份，真实 UNIX socket 直连通过，同目录响应的 Node 转发拒绝，重连不能继承失效资格。补强后的 `./aervox ci all` 退出 0：仓储 1,244、API 1,068、Worker 180、Host Runtime 365、Native Runtime 45 项通过，Host Agent 保留 2 项既有跳过；守卫、依赖审计、构建、类型、HLS、删除故障、Rust/Native 与 文档门禁通过，打包 CLI 的重启和多步审批集成另有 2 项通过。本轮提交的精确两仓配对与远端结果记录在[宿主 PR #374](https://github.com/3yearsZhuang/Aervox-harness/pull/374)和[集合 PR #13](https://github.com/Aervox-agent/Aervox-plugins/pull/13)，前序远端结果不替代本轮验证。
- **主线合并与最终本地验证：** 候选 `ed16378b` 已整合主线 `fa30ddc7` 的模型流和删除保护。模型流排空、模块清理完成后才释放宿主持有的主库/Vault；启动失败也须确认排空，失败则保留数据库并报告清理错误。三项关闭回归通过；PostgreSQL 删除专项 21 项覆盖历史 Context 清理、事务失败回滚、Hook 来源拒绝及删除完成的 scope/owner/target 限制。主动画像新增 SQLite 表达式继续只在独立本机 Vault 执行，构造器拒绝 PostgreSQL。最终 `./aervox ci all` 退出 0：仓储 1,294、API 1,086、Worker 180、Host Runtime 392、Native Runtime 45 项通过；Host Agent 128 项通过、2 项既有跳过。守卫、依赖审计、构建、类型、HLS、删除故障、Rust/Native 和 文档门禁均通过，最新打包 CLI 的重启与多步审批集成 2 项通过。合并过程一次并行全量运行有 4 项迁移测试达到原 30 秒预算；保留预算与断言，仓储单包及最终全量重验均通过。两仓精确提交的远端结果继续由上述 PR/CI 保存。
- **前序主线兼容补全：** 在独立候选内整合主线 `2a385a26`、删除 epoch/原子完成交付和学习复习交付；PostgreSQL 物理映射升为 v2 并冻结 v1 指纹，普通启动拒绝旧目标且不改写数据。练习、知识、复习及持久提问查询使用显式后端表达式，完成历史的嵌套 JSON 保留对象、布尔和 null 类型。隔离 PostgreSQL 验证已覆盖 v2 调用身份关库重开、v1 结构/回执拒绝、学习回执和关联复习、删除过期 epoch 拒绝与审计失败回滚。实际 CLI 迁移/激活、API 重启、Worker 共享写入和错误凭据无 SQLite 回退的组合回归通过；本轮只做定向验证，尚待最终主线整合、独立审查与两仓全量门禁，前序全量结果不替代本轮结果。
- **本轮配对进展（2026-11-18）：** 冻结宿主 `3650c3b8` 与集合 `866ae332` 的新 `./aervox ci all` 退出 0，实际 PostgreSQL 18.6 测试已启用，API 1,102、仓储 1,365、Host Runtime 398、Worker 193 项通过；Host Agent 的 2 项既有 DSH 条件跳过保留，PostgreSQL 测试跳过为 0。CI 补全后的新配对 `b81f67da / 2779b5b2` 全量也退出 0，集合 `ccbedeb` 保留完全相同的树并接入实际集合主线。其[自动检查](https://github.com/Aervox-agent/Aervox-plugins/actions/runs/44163463725)与[显式宿主配对](https://github.com/Aervox-agent/Aervox-plugins/actions/runs/44163565158)均通过，真实 PostgreSQL 16 的仓储 1,365、API 1,102 项运行成功，无 PostgreSQL 条件跳过。[集合 PR #13](https://github.com/Aervox-agent/Aervox-plugins/pull/13) 已正常合入 `27313cf56aafcf8acbfc71c534b67dc729a18384`，实际树与候选一致。宿主 `ea88a76c` 保留学习及 Android 实际主线、固定此 SHA 后，根 frozen install、实际消费者构建/类型/测试 47 项任务、11 个插件分发包及全部预检通过，打包 CLI 的持久会话/重启与多步审批 2 项通过；最终宿主精确提交门禁、审查与实际合入记录由 PR #374 保存。没有操作真实用户库。
- **最终宿主合入：** 精确宿主 `b2421937` 固定实际集合 SHA 后，10/10 远端检查及独立源码审查通过，[主仓 PR #374](https://github.com/3yearsZhuang/Aervox-harness/pull/374) 正常合入 `dcf8ddceec0de03f1c4d2f7102bdd786e51377ff`。两仓合入、最终 gitlink 和消费者复验已完成；本条只保留真实用户使用与运营的验收。
- **剩余门槛：** 真实用户库与远端证书、服务运营和备份责任另行验收。当前不提供自动反向迁移，SQLite 专用原生缓存/P2P/文件恢复不能直接用于 PostgreSQL。当前非配置历史缺少完整持久分类，保守远端预检可能拒绝；未迁移或修改用户业务库，真实库、远端部署、移动接入与正式发布分别验收。

<a id="iter-019"></a>

### ITER-019 · 建议：第三方可执行插件开放决定

先证明声明式/第一方扩展不足，再决定开放范围、信任根、能力代理、SDK/宿主兼容、配额和生命周期；沿用 [ADR-009](docs/reference/adr/ADR-009-electron-plugin-sandbox.md)进程外隔离、默认无权限和撤权基线，改变须修订 ADR。未选定不建通用平台，第三方 UI 由 ITER-056 承接，安装恢复依赖 ITER-005。

- **实施条件与验收：** 范围/威胁/成本评审后，才拆独立 Host、签名/依赖、授权代理、CPU/内存/时限、强杀/崩溃恢复和撤权清理；覆盖越权/逃逸/篡改/耗尽/兼容，撤权后无新副作用，插件缺席仍可核心使用、导出/删除。现有 Hook 协作取消、iframe 和声明包激活不等于第三方执行完成，平台实机与发布单验。

<a id="iter-056"></a>

### ITER-056 · Proposed：第三方根界面开放

2026-10-13 立项提案，[ADR-026](docs/reference/adr/ADR-026-ui-surface-open-ecosystem.md)未批准实施。信任分级、能力白名单、隔离降级、独立安装/升级/回滚先评审；第一方薄 UI 与 ITER-071 共享 Controller 不构成开放第三方的授权。原生移动范围留 ITER-009 和 [ADR-022](docs/reference/adr/ADR-022-mobile-runtime-access.md)。

<a id="iter-009"></a>

### ITER-009 · 进行中：Android 独立端接续与硬件定位

<a id="mobile-continuation-plan"></a>

#### 移动端接续计划

2026-11-07 首页合入基线为主仓 `4ae535c7`、Core `208d28ce26de4651a258ef208d21479e22ab315f`、插件 `bad07ef7305c85101c936a99737f67e7940d1f7d`。[PR #357](https://github.com/3yearsZhuang/Aervox-harness/pull/357) 与[主仓 PR #362](https://github.com/3yearsZhuang/Aervox-harness/pull/362) 已合入，手机运行与日常入口的自动化检查通过；下文确定性物理手机前台夹具已通过，真实 Provider、执行中终止完整矩阵及签名仍未完成。沿用本条协调和 Android 独立端、Material 3、大角色的既定方向。

产品主线由 [ITER-053/059/061](#iter-053) 统一协调，手机接续负责把该闭环落到独立端，并按“当前路径正确性 → M0 真机闭环 → 数据保全与签名内测”验收。以下是平台批次与退出条件；已有 M0 实现授权继续有效，设备/凭据选择、重大数据责任和签名渠道据实际条件确定。规划不授予执行全部远期建议、操作用户业务库或发布的权限。

| 范围 | 已合入的实际能力 | 当前剩余 |
|---|---|---|
| 会话与执行 | 前台文本、多轮工具、逐次设备审批、会话改名/删除、历史分页和有界导出；列表分页、首 100 条之外的 selected 只读 GET 与共享问题/答案持久化已合入，问题绑定原 Turn/Attempt/invocationId/step | 标题筛选仍只覆盖已加载列表；手机强停、原问题重开与答案提交矩阵仍待真机验收，跨进程自动续跑未开放 |
| 学习与人格/日记 | 本机目标、题库、练习、错题、计划的仓储与路由，判分/排期等共用纯模块；人格进入模型上下文，日记保留版本 | 第二批候选已从首页“今日”直接打开组合根注入的学习面板，复用日记入口并与 chat 互斥，待集成验收；面板仍主要是固定三题练习、报告、今日复习及目标/计划标题，错题再练与计划管理的可达性仍需补；真实素材和模型质量未验收 |
| 数据保全 | 已合入同结构备份导出、凭据/投影排除；[PR #359](https://github.com/3yearsZhuang/Aervox-harness/pull/359) 已禁用恢复入口并在解析/SQL 前统一拒绝，实际删除→旧备份拒绝→Transport 重开回归通过 | 旧恢复的删除历史缺口由保守拒绝封闭，完整删除事实、可信历史边界、独立 deny 重放和跨版本升级仍归 [ITER-003/010/011](#iter-003) |
| 原生系统与界面 | TTS、一次性识别、SAF 文本选择、HTTPS 题库导入、本地复习通知、有界 root 动作；短屏/IME/安全区已有回归 | 普通权限及 root 的拒绝/撤销/退后台需要真机取证；当前 APK 未集成 Shizuku，无图片 OCR、泛用文件/通知工具或后台生成 |
| 工程与设备 | 固定制品与唯一 Schema，Android JVM/debug APK/模拟器仪器测试及主仓 CI 已通过 | API 36 模拟器与此前 API 37/arm64/16 KiB 证据不等于物理设备支持矩阵；目前只生成 debug 包，正式签名、升级/回退与发布未验收 |

源码与合同见 [内部 Transport](apps/web/src/mobile/native-runtime.ts)、[学习面板](apps/web/src/mobile/NativeLearningPanel.vue)、[手机会话列表](plugins/surfaces/proactive-ui/src/MobileSessionsDialog.vue)、[移动工程说明](apps/mobile/README.md)和 [M0 门槛](docs/reference/SRS.md#mobile-proposal-acceptance)。已合入能力不再列为待实现；测试覆盖与真实环境验收分别保留。

##### 下一阶段批次与退出条件

| 批次 | 最小范围与前置 | 退出条件 |
|---|---|---|
| 先决：恢复拒绝已合入 | [ITER-003](#iter-003) 的 PR #359 已由 `c7ccc736` 合入，所有安装保守拒绝恢复；实际删除留痕与完整安全恢复继续独立推进。扫描假通过由 [ITER-076](#iter-076) 并行整改，真实解析 Provider 的选择随后处理 | 真实备份→删除→旧备份拒绝→Transport 重开不复活反例已通过；真实数据验收与内测使用含该防线的版本。未知历史保持拒绝，恢复重开必须另满足可信删除事实与账本/水位门槛 |
| 第一批：隔离验收基线与手机基本可达性 | 固定提交、Schema 指纹、APK 摘要与 Android/WebView/ABI/页大小；证明测试 applicationId、库与凭据槽不触及日常安装。复验已合入产品第二批的超过 100 条会话分页、按身份接续、首页学习入口和原生 Transport 接缝；不另写领域或界面实现 | 测试默认入口与用户数据分离；旧会话可找回，翻页/筛选/改名/删除不串会话或清草稿；主线已交付的练习/错题/复习按真实回执闭环。本批领域定向、浏览器与全量已通过，确定性物理手机前台证据见下文；普通权限实际业务和 M0 仍另验 |
| 第二批：持久补问与故障工具 | 沿 ITER-007/071、010 复用 `pending_user_questions`，先提取中性问题/答案命令；问题登记与事件、答案幂等与原 Turn/Attempt 身份一起验证。Host 与 Native 已接同一中性等待器和共享问题命令；显式续接语义保持现行限制，不开启旧 Resume Host | 重开可识别原问题/答案或明确过期；同答案返回原回执，异答案/过期回答拒绝，丢回执不造新问题或新 Turn。补可控制的分片延迟、提交回执丢失、强停与 renderer 退出工具；持久化不冒称自动续跑 |
| 第三批：真机与真实 Provider 收口 M0 | 第一批隔离目标、第二批必要命令及故障工具；选择获准物理手机、符合当前 HTTPS/SSE 合同且支持工具的 Provider、凭据和调用预算。电脑 API/Worker 关闭，先普通权限，再按实际声明单独验 root | 多轮文本、一次补问、取消/历史/重开及下方终止矩阵取证；UI 与 SQLite 身份/安全前缀/终态一致，无双 Turn、重复模型调用或未知副作用重放。缺配、失效和 `local_only` 拒绝通过后才关闭 M0 |
| 第四批：产品主线在手机的日常验收 | 在真机验收 [ITER-053/059/061](#iter-053) 已交付的首个闭环、真实首页来源与学习路径；人格/日记验证实际上下文、素材来源、失败和跨日刷新。缺少数据删除与来源传播的派生能力保持关闭 | 电脑关闭仍完成用户交代、产出/下一步、确认和回看；学习记录按真实作答回执更新，重复不重复计分，模型失败不发布假结果。普通权限系统能力按拒绝/撤销/取消实测；[ITER-075](#iter-075) 的 mobile targets 必须有实际装配证据 |
| 第五批：数据保全与基础签名内测 | M0；数据范围、旧安装/升级责任、签名持有者、包身份、渠道和候选支持矩阵明确。依 ITER-003/010/011 实施必要恢复/迁移切片，签名工程准备可与真机取证并行；不放宽现有阶段门槛 | release 与精确提交绑定，新装、同签名覆盖升级、中断和回退保留数据；许可、隐私、16 KiB、性能/耗电及实际开放能力验收。正式签名若与现有 debug 不同，不能覆盖安装；卸载清数据不能当作升级保全证明 |

**持久补问（已合入）：** Core 原 invocation 身份透传经 [Core PR #3](https://github.com/Aervox-agent/Aervox-core/pull/3) 合入 `93351196`；Schema v2 只追加 nullable `invocation_id`，v1 发布指纹校验、启动拒绝、staging 旧问题/会话保留及字节回滚已通过，旧 NULL 身份不猜回填。共享问题原子命令、Host 等待器与 Native 消费已接线；晚到答案的异步消费、旧回执重放与缺完整身份的回执（只推进消费游标）均有回归。[集合 PR #17](https://github.com/Aervox-agent/Aervox-plugins/pull/17) 与主仓配对合入实际集合 `fa532343`；随后 [PR #379](https://github.com/3yearsZhuang/Aervox-harness/pull/379) 修复了连续撤权再授权时审计 ID 仅依赖毫秒导致的 `proactive_audit_events.id` 主键冲突。当前手机测试安装与业务库未升级，跨进程自动模型续跑继续关闭。

**并行边界：** 第一批手机交互、第二批中性命令/确定性故障工具与设备准备可并行；第三批真实环境按前置收口。数据控制账本及迁移按 ITER-003/010/011 的独立依赖推进，不要求一次实现全部跨库恢复能力，也不允许据此跳过当前删除防线。Shizuku、后台主动运行、跨端同步、iOS 和本机推理继续各自裁定。

**产品与设计接缝：** `docs/assistant-vision` 的评审与首页信息架构统一见 [ITER-053/059/061](#iter-053)。手机复用其场景与来源语义，保持现行 Material 3、大角色、短屏/键盘和返回层级；静态“朝夕”演示不直接替换运行入口，也不构成原生业务插件已装配证明。

##### 执行中终止与恢复矩阵

| 阶段 | 故障注入 | 必须观察的结果 |
|---|---|---|
| 接单前 | 前后台切换、配置回执迟到、进程终止 | 拒绝未接单发送，保留草稿；回到前台不复活旧发送 |
| 接单事务提交前后 | 强杀、SQL 回执丢失、原生 drain 未确认 | 原业务键/回执裁定结果，无双 Turn；未知连接保持隔离，不猜测回滚或重放 |
| 模型首段前与流中 | 断网、超时、锁屏、后台、强杀 | 保留已提交安全前缀，重开状态如实收敛，不自动重跑模型 |
| 取消与终态持久化前后 | 回包丢失、终态分页未消费、重开 | 以持久回执为准，无假完成；同键取消幂等，终态分片完整消费 |
| 补问等待及答案提交前后 | 回执丢失、重复/过期答案、后台与强杀 | 回答或取消命中原问题/Turn，过期回答拒绝，不重复作答或续跑 |
| 删除完成后 | 迟到分片、旧 fencing 写入、重试与重开 | 不返回或复活已删正文，不把拒绝写入伪装为成功 |
| WebView 文档退休 | renderer crash、导航、重载及迟到回调 | 旧文档准入和回包撤销，原生工作另行完成 drain，关闭后不泄露迟到结果 |

##### 依赖与并行安排

- **三条并行线：** 原生生命周期/Provider、手机交互、确定性测试/设备验证，按上述批次进入真机与 M0；控制账本/数据保全和签名准备可并行，内测仍须满足下方门槛。
- **共享正确性：** 接单/意图/幂等回链 ITER-002/071；工具与补问准入、审批取消回链 ITER-007/071；删除/来源回链 ITER-003；持久恢复、租约与有界运行回链 ITER-010/013；Provider 与长上下文按需回链 ITER-033/032。只闭合本次开放路径的必要切片，不把这些迭代整体完成设为前台文本的无条件前置。
- **数据责任：** 手机升级与一致性备份回链 ITER-011；旧备份恢复先满足 ITER-003/010 的删除事实和 deny 水位。主库、Vault、控制账本与密钥按原故障域管理。
- **界面与插件：** 手机界面回链 ITER-053；第一方插件修改走集合仓与主仓配对 PR、gitlink/根锁验证。受信固定 APK 文本界面不等待 ITER-006 的 Page Token 通道；开放插件 Page 时才接资源、代际与撤权合同，第三方开放归 ITER-019/056。
- **系统与跨端：** 语音/文件/通知按系统用途授权；Shizuku/root 沿 [ADR-022 能力分级](docs/reference/adr/ADR-022-mobile-runtime-access.md#能力交付与授权分级)，不提供任意 shell 或第二执行器。跨进程续跑归 ITER-010，双向同步归 ITER-028，不复制活动 SQLite/WAL，不引入多租户业务库。
- **交付验证：** 代码 PR 推送前通过 `./aervox ci all`；Android JVM/lint/构建/仪器测试、真实 Provider、物理设备与签名发布各自保存精确提交和环境证据。纯计划/契约修改只运行文档门禁。

##### 阶段门槛与待决定事项

| 阶段 | 进入或完成条件 |
|---|---|
| M0 完成 | 普通权限、隔离库、电脑关闭、真实 Provider 前台闭环；相同消息身份/安全前缀的进程终止恢复；一次补问作答、取消/删除幂等、迟到写拒绝及凭据/`local_only` 拒绝全部取证。已有未接单与确定性安全前缀后的强停样本，近期有效租约、CancelRequested、补问/答案提交、renderer 和真实 Provider 完整矩阵仍未验收，M0 继续未关闭 |
| 基础签名内测 | M0、实际开放的数据保全/诊断，以及支持矩阵、许可、签名、新装/升级/回退通过；明确列出后台和工具实际能力，不等待完整助手范围 |
| 移动助手 Beta | 基础内测上完成首个日常场景及其数据权利；系统能力逐项按实际完成范围声明，以连续使用记录评估稳定性、任务完成率和成本 |
| 正式发布 | 所声明能力全部通过目标设备、性能/功耗、数据升级/恢复/回滚、签名渠道与许可验收；精确提交 CI 与发行产物对应，保留已知限制和恢复入口 |

合入证据由 [PR #357](https://github.com/3yearsZhuang/Aervox-harness/pull/357)、[集合 PR #9](https://github.com/Aervox-agent/Aervox-plugins/pull/9)及[修复 PR #10](https://github.com/Aervox-agent/Aervox-plugins/pull/10)保存；旧备份恢复、真机、真实 Provider、终止矩阵和正式签名的剩余门槛以本条及 ITER-003/010/011 为准。第 7 节继续维护正式支持范围、发布渠道、后台语义、首批场景、备份/升级责任、同步和 iOS 的待决定事项，不预设工期。

#### 已有交付与历史证据

逐条测试计数、失败与复验过程由 PR/CI 保存；本节只保留能力结论、未覆盖范围与仍开放门槛。

**平台选择：** 比较九个硬件方向、电脑依赖、目标 OS、真实 Provider、成本与数据边界后，维护者选择手机独立运行、电脑关闭后仍可使用，并确认 Android 先行；iOS 工程尚未创建。本轮实时可见 Android SDK API 36 与 adb。关联 [ITER-016](#iter-016)。

**工程与内核前置（已交付）：** 显式 Web 构建、Android 同步/doctor、只读环境预检与 debug 构建命令（Java 21 固定于 mise，Gradle 分发带校验值；模板源码与许可入库，资源复制、SDK 路径、签名密钥与构建产物不跟踪，自动备份与明文网络默认关闭）。独立端内核入口：`@aervox/core/browser`（整包不含 Node/CLI）、`@aervox/host-agent/browser` 的执行 Store 与仓储 Port、`/database` 注入式装配、`/conversation` 共享 SQL 命令、原生候选值协议、未注册的 `NativeMessageChannel` 与 `/native-sqlite-client`。这些入口不导入 Node、SQLite 驱动或 Vue；**严格上游 Drizzle 声明闭包未通过这一限制如实保留**，`skipLibCheck` 消费者检查不算严格声明通过。

**原生能力（已交付）：** 固定 SQLite 3.54.1 官方制品（HTTPS 恢复按长度/SHA3 验证，缺失或篡改阻断构建）；原生隔离临时库；Keystore AES-GCM 凭据槽（私有 no-backup 密文、AAD 身份/版本、进程与文件锁、原子替换，丢密钥不补建）；Java 专用写者（epoch/事务持有者、有限语句/参数/结果/队列、单次首窗、终态隔离、关闭后确认 drain）；固定资产 WebView Host（首次加载前全新随机 Profile、按 Profile 阻断 Service Worker/网络、导航/重载销毁旧所有者）。未接生产初始化，未授予 JS SQL 权限。

**确定性夹具证据：** Android 17/API 37、arm64、4 KiB 物理设备仪器测试 78/78 通过，原生运行时接线批次 46 项全部通过；同规格 16 KiB 隔离模拟器 76 项通过、无跳过。覆盖 RETURNING、JSON/NUL、FTS5、FK、失败事务回滚与重开、Keystore、严格 JSON/WebMessage、跨源 iframe、零列 DML 取消、事务身份、超窗回滚、队列 drain、默认 Cookie 不被改动。默认入口冷启动显示 Mizuki；缺模型发送明确拒绝并保留草稿；实际 force-stop 后新进程恢复选中会话与完整草稿（含 1799 字符）。**这些不证明** 16 KiB 物理设备、其他 ABI/版本矩阵、后台可持续运行、真实 Provider、执行中终止完整矩阵、工具问答、跨版本覆盖升级或正式签名。

**界面与操作（已交付）：** Material 3 统一（官方 Material Web 控件、品牌生成浅/深色角色、48px 触控、tonal surfaces）；同页会话列表/新建/切换/持久回看、常驻多行输入、按会话草稿、原生 IME→WebView 历史→系统返回的逐层返回；短视口收起角色并解除叠放，常规视口角色区 64dvh；缺模型反馈移入独立布局行以免被裁切。WebView 不接收模型密钥、任意 URL/header 或 shell。

**预算与生命周期修复（已交付）：** 文本输入 32 KiB UTF-8 / 120 KiB JSON、回复累计 48 KiB，越界保留安全尾段并提交 `Interrupted(model_length)`。首次就绪前的文档退休观察、后台区间跨过的配置查询拒绝未接单发送、已提交接单的迟到回执经共享取消事务收尾。恢复用例证明有效 Running/CancelRequested 租约不抢占、过期后收敛、拒绝旧 fencing、不重跑模型——但这不是 Android 实际杀进程。

**依赖与安全修复（已交付）：** 普通应用 UID 下硬链接归属标记被 SELinux 拒绝，改为独占创建与保守拒绝；同一短同步区完成 actor 创建与绑定；API 24/25 的 root/Shizuku Process 操作改用有界单调时钟等待，API 26+ 保留原生 timed wait 并请求 destroyForcibly。

**方向约束：** 可为具体增强功能使用系统授权、Shizuku 或 root，基础 P0 不依赖提权；三者各自标注交付/授权状态，不放假按钮或任意提权执行器，边界见 [ADR-022 能力分级](docs/reference/adr/ADR-022-mobile-runtime-access.md#能力交付与授权分级)。手机不复制活动 SQLite/WAL，不引入多租户业务库。

**相关 PR：** 主仓 [PR #353](https://github.com/3yearsZhuang/Aervox-harness/pull/353)、[PR #356](https://github.com/3yearsZhuang/Aervox-harness/pull/356)、[PR #372](https://github.com/3yearsZhuang/Aervox-harness/pull/372)；集合仓 [PR #7](https://github.com/Aervox-agent/Aervox-plugins/pull/7)、[PR #8](https://github.com/Aervox-agent/Aervox-plugins/pull/8)、[PR #15](https://github.com/Aervox-agent/Aervox-plugins/pull/15)。

<a id="iter-016"></a>

### ITER-016 · 建议：所选单设备 PoC

依赖 ITER-009 价值决定，先设备 ADR/单一协议；音频/OCR 必须证明真实产物，独立算力盒另依赖 ITER-015。模拟器+一块开发板验证身份、ACK、幂等、截止、撤权、热插拔；设备缺席核心流程不受损，取得五至十人记录与价值证据，不以接口响应替代实物成功。

<a id="iter-018"></a>

### ITER-018 · 建议：第二终端与样机决策

仅在 ITER-016 价值成立后检验共享生命周期，再决定 PCB/结构/电源/小批；无线、电池、采集、运动另评审，PoC 不自动授权量产。两端不复制宿主，更新/回滚/删除可测；24→72 小时稳定、功耗温升、密钥/追溯/维修取证，发布另验。

<a id="iter-028"></a>

### ITER-028 · 待评审：纯本地加密同步探索

CAP-018/027，遵守[数据库契约](docs/reference/DATABASE.md)和 ADR-022，不引入中心化多租户库。承诺-揭示配对、Ed25519 设备身份、SAS transcript、分向密钥和 Changeset 原型已有，ITER-071 已隔离 sync-runtime/Changeset Port；真实 mDNS/生产接线/多设备未完成。

**当前性质：原型，零生产消费者。** `packages/sync-runtime`（4 988 行）与 `packages/repositories/src/sync/p2p-changeset.ts` 的唯一 import 方是 `packages/repositories/test/` 下的 5 个测试文件；不在 turbo build、CI 或 mise 任务任一处被引用。引用这些文件不等于它们已可用：本条仍未评审通过，接线与否由后续决定。审计基线（2026-11-26）确认该状态自 2026-10-03 审计以来未变。

- **进入条件与验收：** 显式配对、端到端加密、`local_only`/混合来源范围、删除撤权传播先成立；UDP 多播发现+静态对端兜底，验证重放/乱序/篡改拒绝。以行时间水位+显式墓碑代替 Session Extension，接收白名单/漂移隔离/墓碑四向裁决，不复活已删数据；真实 Capacitor/Electron 同网直连学习进度/错题成功，不能据原型宣布多设备可用。

<a id="iter-021"></a>

### ITER-021 · 建议：HLS 可行性真实验证

依赖 ITER-020，[ADR-023](docs/reference/adr/ADR-023-hls-research-execution.md)已接受研究范围，CAP-007/020/027（探索）；研究执行器已合流 Core，真实模型/Vitis 镜像未配置，H1～H4 未启动。按[HLS 阶段条件](docs/how-to/run-hls-agent.md#hls-plugin-delivery) H1→H2→H4，H3 题集/协议可并行，只修实际复用路径。

- **验收：** 固定模型/镜像/环境，真实裸跑与 Agent 双入口、正反样例、隔离/杀停可复现；开发/留出按家族隔离，四组同配置/固定分母/独立样本/增益区间/成本完整。官方未公开判定保留缺口，按专项 §6.3 做继续、限定补证或暂缓决定，证据登记后才移交。

<a id="iter-022"></a>

### ITER-022 · 建议：HLS 扩大验证与冻结提交

仅在 ITER-021 支持继续、正式范围/必要 ADR 已评审且已取得最新细则和窗口后进入 S1～S3；AVX-EXPL-013 P3。正式评分 ABI/反馈、分级判定及独立 pass@1/pass@5 可追溯，最终 32 GB 目标环境满足预算，另一队员在干净断网环境复现双入口/哈希；包、依赖/模型/技能声明、失败/成本报告完整。实际赛事提交依窗口及用户授权，不自动包含产品化、微调或采购。

<a id="iter-043"></a>

### ITER-043 · 条件规划：HLS 可选插件产品化

仅当 ITER-022 竞赛证据完整、有真实学习/调试需求且产品范围/独立 ADR 接受后，进入 M1～M6；新增 CAP 待需求立项，目前未建独立仓/接产品或承诺工期，本条仅获规划授权。

- **范围与验收：** 非核心实现独立子仓经 `modules/*` workspace 消费，主仓单一接口/受信装配，默认不激活、不复制研究内核；公开题导入→生成/验证→诊断→取消/复盘/导出闭环，工具有真实 handler，权限/撤权阻断副作用。仅复用 ITER-004/005/006/007/008/013 必要合同，先补生命周期缺口；安装/升级失败、禁用/缺包/卸载/重装/回滚、实现缺席仍可导出/删除及竞赛双入口回归均需验证。

## 7. 设备与移动端的待决策项

ITER-009 的移动端交付顺序见[接续计划](#mobile-continuation-plan)。已接受的手机独立、Android 先行与 M0 普通实现继续沿原决定推进；以下保留硬件候选和移动端后续待决定事项，不替用户批准采购或实施尚未裁定的扩展：

| 决策 | 建议起点 | 需要的证据 |
|---|---|---|
| 硬件候选的电脑依赖 | 手机已选择电脑关闭后独立使用；硬件配件仍分别比较依赖现有电脑与独立算力盒的方案 | 典型使用时段、成本/能耗、维护能力与本地模型规格 |
| 首个硬件形态 | USB 桌宠、专注旋钮、电子纸卡可优先做低成本概念比较；语音/扫描由真实能力验证决定 | 用户价值、现有外设替代、Provider 真实性、无设备时流程完整性 |
| 移动端正式支持范围 | 已选择独立端、Android 先行；优先验证 arm64、4 KiB/16 KiB 与代表系统设备，以 Android＋WebView 功能组合裁定范围；iOS 后续独立验收 | 当前原生 SQL 桥要求 API 28 及以上，WebView 需 `MULTI_PROFILE` 与 `WEB_MESSAGE_LISTENER`；再取物理手机、真实 Provider、SQLite/密钥、生命周期及升级证据；`minSdk24` 不等于正式下限 |
| 后台执行语义 | 当前退出前台请求取消并在重开复核持久状态；持续后台生成先定义用户开启、可见通知、停止及进程死亡行为，再选择前台服务/系统调度 | 持久所有者、取消/撤权、未知回执、系统调度限制与功耗；安全退休不等于自动续跑 |
| 数据备份与升级 | PR #359 候选已关闭所有安装的恢复准入，保留可读导出；完整恢复再复用停写/drain、staging、校验与回滚，跨机重新配置模型凭据 | PR #359 已合入；历史硬删安装不能补造事实，缺可信历史边界仍拒绝恢复。支持旧版升级、空间不足/中断、主库/账本/密钥故障域和旧备份不复活已删内容须继续取证 |
| 发布渠道与签名 | 明确签名持有者、包身份、发行渠道与旧 debug 安装处理，再形成范围明确的签名内测包 | 支持矩阵、发行签名、版本递增、Live2D/角色许可、依赖审计、新装/同签名覆盖升级和回退；卸载清数据不算升级保全 |
| 同网连接与认证 | 明确发现、证书、设备凭据和撤销；不把同一 Wi-Fi 当作授权 | 当前 Token 与隐私契约中身份要求的差量及威胁评审 |
| 跨设备数据范围 | 普通资料与 local_only/混合来源严格分开 | 导出/同步授权、删除传播、离线期限与来源验证 |
| 首个日常助手场景 | 维护者已选择主动个人助手产品与界面整合，建议先做“交代一件事→必要澄清→可用产出/下一步→用户确认→重开回看”；学习建议从真实复习/错题进入行动 | 首页来源、会话身份、结果确认和成本可核验；学习域保留作答幂等、来源/删除传播及原实验口径；生活/工作新来源与后台主动执行另据价值决定 |
| 增强权限与跨平台时机 | 系统 API 按用途授权；root 已作为固定设备动作（点击/滑动/按键/ASCII 输入/启动应用）的执行通道，逐项关闭与前台限制先行；Shizuku 仍为待接入的独立提供者，不共享任意命令。Android 真实闭环与移动 Host 契约稳定后，再规划 iOS 与本机推理 | root 真机动作与授权撤销、服务死亡与降级、模型不支持工具声明时的回退；Shizuku 的实际 UID/授权；iOS 独立存储/密钥/生命周期/签名及本机推理资源/许可 |

[ADR-022](docs/reference/adr/ADR-022-mobile-runtime-access.md#cr-055) 已接受独立运行、Android 先行及 M0 隔离原型：固定内置 SQLite、复用现有规则、原生持钥模型桥。候选仅准入隔离测试库，正式平台版本范围和工期未裁定，具体取舍在本节维护。

## 8. 已移交切片与历史证据

只保留已交付结果、证据与未关闭边界。ITER-003/053/059/061/062 的活动剩余已移到前文；其它切片的真实模型/设备/签名/发布限制继续有效，不因本次排序提高 CAP 状态。详细实施与失败日志见[计划快照](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md)及各 PR/CI。

<a id="iter-070"></a>

### ITER-070 · 已移交：PR 终审与文档现状归档

原授权 #307～#320 已按依赖顺序合入并清理分支，保留工作树、归档标签、忽略资源与业务数据。[PR #313](https://github.com/3yearsZhuang/Aervox-harness/pull/313) 补 Bundle 祖先 symlink 清理/回滚，[PR #314](https://github.com/3yearsZhuang/Aervox-harness/pull/314) 补 ZIP 文件/目录/大小写冲突，[PR #316](https://github.com/3yearsZhuang/Aervox-harness/pull/316) 补终态/水位一致快照。[PR #321](https://github.com/3yearsZhuang/Aervox-harness/pull/321) 修 Fastify `GHSA-389g-gv7q-r4x8` 至 5.12.6 并删除已撤回的 sprintf-js 豁免；[PR #322](https://github.com/3yearsZhuang/Aervox-harness/pull/322) 交付现行 Markdown 与文档门禁。

历史材料已移出主仓。原字节哈希、稳定编号、失败与剩余验收见[归档包](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation)，无活动入站的 [CR-030 旧目标 ERD](https://github.com/3yearsZhuang/Aervox-docs-archive/blob/397d4b4bc924d1315205577ed4fb88a4df2c0619/archive/database-sqlite-erd-cr030-target.md) 亦按原字节归档。ContextManifest 最小化、Page、恢复及真实环境限制已回到对应活动条目，未提高发布状态。

**已交付条目索引。** 以下编号全部已移交，详细交付、失败与剩余边界由对应 PR 与 CI 保存；保留锚点供历史文档引用。

| 编号 | 结果 | 证据 |
|---|---|---|
| <a id="iter-001"></a>ITER-001 | 冷 CI、插件产物恢复与可重现验证；ARC-14/FND-10；CAP-020 | [PR #221](https://github.com/3yearsZhuang/Aervox-harness/pull/221) |
| <a id="iter-002"></a>ITER-002 | 可靠接单差量：Inbox 确认、Turn/Outbox 与 Attempt 原子接单或可重放恢复；ARC-01；CAP-007。剩余边界见 ITER-071 | [PR #265](https://github.com/3yearsZhuang/Aervox-harness/pull/265)、[PR #228](https://github.com/3yearsZhuang/Aervox-harness/pull/228)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-004"></a>ITER-004 | 消息版本短事务/CAS、Config 与同库 Secret 一致提交、会话锁尾链回收；ARC-07、FND-02/07；CAP-013/020 | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-007"></a>ITER-007 | 父子任务/Driver 继承取消、截止、删除与 local-only；执行时逐项核对 requiredPermissions/grants；动态工具 Schema 快照进入模型请求并在执行时重验；ARC-02/03；CAP-007/020/033 | [PR #267](https://github.com/3yearsZhuang/Aervox-harness/pull/267)、[PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-008"></a>ITER-008 | 模型制品与进程：路径/symlink、响应与续传验证；启动 epoch、有界探针/日志/指标请求；ARC-11/12 | [PR #266](https://github.com/3yearsZhuang/Aervox-harness/pull/266) |
| <a id="iter-014"></a>ITER-014 | 公开 Port、MemoryStore 试点与实现退出演练；ARC-10；CAP-005/007/020 | [PR #230](https://github.com/3yearsZhuang/Aervox-harness/pull/230) |
| <a id="iter-020"></a>ITER-020 | HLS 竞赛验证规划；CAP-007/020/027 | [PR #229](https://github.com/3yearsZhuang/Aervox-harness/pull/229) |
| <a id="iter-023"></a>ITER-023 | Build to Delete 与类 pi 架构规划；CR-056 历史材料见归档导航 | [原交付登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) |
| <a id="iter-030"></a>ITER-030 | DSH、pi、AstrBot 固定版本更新与差异复评；CAP-007/020/027/033 | [原交付登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) |
| <a id="iter-031"></a>ITER-031 | 标准工作台连续对话与雾蓝视觉重构；CAP-001/002/018 | [PR #233](https://github.com/3yearsZhuang/Aervox-harness/pull/233) |
| <a id="iter-034"></a>ITER-034 | ControlContext、abortable 与 ApprovalPolicyPort 内核构件及 executor 接线 | [PR #241](https://github.com/3yearsZhuang/Aervox-harness/pull/241) |
| <a id="iter-035"></a>ITER-035 | 建立独立 `@aervox/core`、内存 HostToolRuntime、轻量出口与分层许可证；ADR-021。独立仓库迁移见[接续条目](#core-repository-migration) | [PR #244](https://github.com/3yearsZhuang/Aervox-harness/pull/244) |
| <a id="iter-036"></a>ITER-036 | 伴学 Prompt、工具契约与宿主 guidance 迁出内核，收窄内核导出面；ADR-021 | [PR #245](https://github.com/3yearsZhuang/Aervox-harness/pull/245) |
| <a id="iter-037"></a>ITER-037 | 移除 agent-loop/cli-approval 过渡壳，下游直连 core，内核类型自持与边界守卫；ADR-021 | [PR #248](https://github.com/3yearsZhuang/Aervox-harness/pull/248) |
| <a id="iter-038"></a>ITER-038 | Provider stopReason 归一与输入/输出 usage 分账 | [PR #247](https://github.com/3yearsZhuang/Aervox-harness/pull/247) |
| <a id="iter-039"></a>ITER-039 | 内核截断 fail-closed（整批拒绝截断工具调用）与 usage 缓存/成本分账 | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-041"></a>ITER-041 | 拆分 executor 流式收集、工具管线与终态收口，统一审批裁决 | [PR #249](https://github.com/3yearsZhuang/Aervox-harness/pull/249) |
| <a id="iter-042"></a>ITER-042 | ExecuteResult interrupted 与 AttemptStatus 对齐，保留 reason；持久化枚举不变 | [PR #251](https://github.com/3yearsZhuang/Aervox-harness/pull/251) |
| <a id="iter-044"></a>ITER-044 | Core 审核整改第 1/5 迭代：执行正确性收口（审批等待后的取消/租约竞态、模型截断工具执行、父子控制传播、next-step Inbox 丢失） | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-045"></a>ITER-045 | 审核整改第 2/5：工具运行时与合同收敛，API 复用 core HostToolRuntime | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-046"></a>ITER-046 | 审核整改第 3/5：上下文与有界流式（动态工具受权快照、最终请求容量检查、工具组压缩、有界安全正文窗口） | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-047"></a>ITER-047 | 审核整改第 4/5：恢复与 Provider 合同（Resume 账本/最新意图/事件高水位；统一模型能力、终止与用量合同） | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-048"></a>ITER-048 | 审核整改第 5/5：性能基线与发行边界 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-049"></a>ITER-049 | 项目代码质量、仓库卫生与文档多源偏移审计 | [PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-050"></a>ITER-050 | 审计发现落地：删除效果验证、原子接单/组合写入、动态工具取消、取消恢复、锁回收与资产单源 | [PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-051"></a>ITER-051 | 参考审计首批正确性修复：消息/配置原子写入、锁尾链回收、Memory 清理验证与召回资格、模型异常终止与逐调用快照 | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-052"></a>ITER-052 | 框架解耦审计整改：事件传输与平台能力注入、插件实例生命周期、API 窄依赖、日记素材访问、内核提示词策略与边界守卫 | [PR #262](https://github.com/3yearsZhuang/Aervox-harness/pull/262) |
| <a id="iter-054"></a>ITER-054 | 薄 UI 宿主、工作台/桌宠插件及平台组合根；ADR-025 | [PR #275](https://github.com/3yearsZhuang/Aervox-harness/pull/275) |
| <a id="iter-055"></a>ITER-055 | UISurfaceManifest、加载重试/降级、设置插件与设计令牌；第三方开放另见 ITER-056 | [PR #275](https://github.com/3yearsZhuang/Aervox-harness/pull/275) |
| <a id="iter-057"></a>ITER-057 | 终态一致、密集正文窗口与准备取消；基准使用假 Provider/内存存储 | [PR #274](https://github.com/3yearsZhuang/Aervox-harness/pull/274) |
| <a id="iter-058"></a>ITER-058 | 文档体系精简、事实源与稳定编号收敛；详细旧记录见归档快照 | [历史记录](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/plan.md#iter-058) |
| <a id="iter-060"></a>ITER-060 | HYG-01～14 卫生整改及插件生命周期前置；Worker 其余预算留 ITER-013 | [PR #277](https://github.com/3yearsZhuang/Aervox-harness/pull/277)、[原审计](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/86d3c85d51fbc22e90cabc26736e17ff9b1dadbc/audits/2026-10-23-document-reconciliation/reading/docs/explanation/repository-hygiene-audit-2026-10-13.md) |
| <a id="iter-063"></a>ITER-063 | 本地认证、Problem Details、共享端点、路由棘轮与插件生命周期；余下分别留 ITER-064/006/019/056 | [PR #281](https://github.com/3yearsZhuang/Aervox-harness/pull/281)、[PR #283](https://github.com/3yearsZhuang/Aervox-harness/pull/283) |
| <a id="iter-065"></a>ITER-065 | 记忆删除质量研究与两轮实验已归档；有界实验不构成完整生产删除或外部独立复现 | [研究归档](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/main/memory-deletion-study) |
| <a id="iter-066"></a>ITER-066 | 异步删除故障测试生成器、输入校验与研究门禁；方法收益结论仍为 NOT ESTABLISHED | [PR #288](https://github.com/3yearsZhuang/Aervox-harness/pull/288)、[归档 PR #2](https://github.com/3yearsZhuang/Aervox-docs-archive/pull/2) |
| <a id="iter-067"></a>ITER-067 | workspace/清理/数据目录/资源/研究依赖/宿主出口/许可及跟踪卫生整改 | [PR #289](https://github.com/3yearsZhuang/Aervox-harness/pull/289)、[PR #320](https://github.com/3yearsZhuang/Aervox-harness/pull/320) |
| <a id="iter-068"></a>ITER-068 | 工具参数合同、开发启动器/URI/终端体验，以及并行 README/经典桌面布局 | [PR #295](https://github.com/3yearsZhuang/Aervox-harness/pull/295)～[PR #308](https://github.com/3yearsZhuang/Aervox-harness/pull/308) |
| <a id="iter-069"></a>ITER-069 | open Host/Origin 与 Token 预检、DSH 文件/命令取消、Electron IPC/导航及 Page 文件/清理边界 | [PR #309](https://github.com/3yearsZhuang/Aervox-harness/pull/309)、[PR #310](https://github.com/3yearsZhuang/Aervox-harness/pull/310)、[PR #312](https://github.com/3yearsZhuang/Aervox-harness/pull/312)、[PR #313](https://github.com/3yearsZhuang/Aervox-harness/pull/313) |
