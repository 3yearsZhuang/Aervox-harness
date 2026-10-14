# Aervox 当前迭代计划

直接维护本文件；规则见[贡献指南](CONTRIBUTING.md#plan-maintenance)。只登记需要排序、依赖协调或持续跟踪的工作，普通修复无需入队。保留既有 ITER 编号与原有状态；“已移交”只表示相应切片，CAP 状态和发布门槛仍见[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)。建议和依赖不构成对所有工作的执行授权。

## 1. 当前协调工作

<a id="iter-058"></a>

### ITER-058 · 已移交：文档体系精简

合并重复文档与 CR，直接维护计划，退役冗余元数据和生成治理；保留需求、数据责任、未决项与发布门槛。验收包括链接迁移完整、脚本回归、纯文档不启动业务/原生构建及最终双门禁。本次不建设 Skills。实现与验证见 [PR #273](https://github.com/3yearsZhuang/Aervox-harness/pull/273)；包含 Core、根界面与主动陪伴的最终整合基线已通过全量代码和文档门禁，完成链接、编号与未决状态迁移。

<a id="iter-053"></a>

### ITER-053 · 已移交

前端体验优化：大比例 Live2D、轻量聊天输入、跨页面统一开关/卡片/按钮/表单/标签导航、草稿保存和窄窗口导航；CAP-001/002/018/020。

2026-10-13 由 PR #275 统一移交前端体验、根界面与二阶段切片；全量代码/文档门禁及三项浏览器 E2E 通过。UI 决定协调为 CR-065；真实模型、移动实机与发布验收未提升。

证据与边界：[260](https://github.com/3yearsZhuang/Aervox-harness/pull/260)；[275](https://github.com/3yearsZhuang/Aervox-harness/pull/275)

<a id="iter-054"></a>

### ITER-054 · 已移交

根界面插件首个切片：薄 UI 宿主、默认工作台与桌宠插件、跨端组合根；CAP-001/002/018/020；CR-065。

2026-10-13 由 PR #275 统一移交前端体验、根界面与二阶段切片；全量代码/文档门禁及三项浏览器 E2E 通过。UI 决定协调为 CR-065；真实模型、移动实机与发布验收未提升。

证据与边界：[275](https://github.com/3yearsZhuang/Aervox-harness/pull/275)

<a id="iter-055"></a>

### ITER-055 · 已移交

界面插件化二阶段：UISurfaceManifest 清单契约与宿主校验、加载骨架与退避重试、宠物降级链（PetWithFallback）、浏览器级 E2E、五块设置面板迁入 panels-ui、设计令牌单源、紧凑工作台多根界面试验田；修复 workbench 出口主题链缺失；CAP-001/002/018/020；CR-065。

2026-10-13 由 PR #275 统一移交前端体验、根界面与二阶段切片；全量代码/文档门禁及三项浏览器 E2E 通过。UI 决定协调为 CR-065；真实模型、移动实机与发布验收未提升。

证据与边界：[275](https://github.com/3yearsZhuang/Aervox-harness/pull/275)

<a id="iter-056"></a>

### ITER-056 · 建议

界面插件开放评审与实施：第三方 UI 插件信任模型（信任分级/能力白名单/隔离降级）、界面插件独立安装升级回滚合同；CR-064。

2026-10-13 立项提案（CR-064，Proposed）；原生移动真机验收继续由 CR-055 / ITER-009 承载，不在本条目扩张。

证据与边界：[界面开放提案](docs/reference/adr/ADR-026-ui-surface-open-ecosystem.md)；保持 Proposed，未批准实施。

<a id="iter-057"></a>

### ITER-057 · 已移交

内核执行边界修复：终态提交与返回值一致、连续小块正文限时刷新、准备阶段取消传播；CAP-002/007；延续 CR-061 的既有执行合同。

2026-10-13 完成全量终审并由 PR #274 移交；终态争抢、密集流刷新与准备取消回归通过，基准仅为假 Provider 与内存存储。

证据与边界：[274](https://github.com/3yearsZhuang/Aervox-harness/pull/274)

<a id="iter-059"></a>

### ITER-059 · 已移交

思隅·主动陪伴界面：Live2D 舞台、打字机对话盒、最近会话接续、固定专注入口与文字输入；通过设置或查询参数选择，默认入口仍为工作台。依赖 ITER-055，沿用 ADR-025。

由 [PR #276](https://github.com/3yearsZhuang/Aervox-harness/pull/276) 移交；全量双门禁与四项浏览器回归通过。首次发送建会话、连接失败重试与查询参数退出已验证。建议首版仅来自最近会话与固定动作；学习记录驱动的主动推荐、历史消息加载及真实模型/移动实机验收仍待后续。

<a id="iter-060"></a>

### ITER-060 · 已移交：仓库卫生审计整改

用户已授权按[2026-10-13 审计](docs/explanation/repository-hygiene-audit-2026-10-13.md)实施 HYG-01～14。修复会话持久化与录音、预设选择和 Skill 所有权、Adapter/Worker 清理；统一归档预算、CI 入口、依赖审计及重复实现。

- 基线：`511f9d1e`（插件生命周期变更之上），工作分支 `fix/repository-hygiene`；保留原审计数据作为整改前快照。
- 依赖与边界：Worker 排空对应 [ITER-013](#iter-013) 的退出清理差量；不宣称该迭代整体完成。延续本地 SQLite 所有权，不执行迁移或发布操作。
- 验收：定向回归、全量代码/文档门禁、API/UI/CLI E2E；通过 PR 审查。依赖剩余项按具体版本/路径和到期日审阅，不能计为漏洞已消除。
- 当前证据：2026-10-14 已修复自查发现的录音等待取消、Skill 目录所有权和 Adapter 坏协议清理残留，接通归档业务断连取消，并补齐双会话落库、第 51 项配置写入和真实进程退出验收。本地全量终审退出 0，API 598 项、仓储 402 项通过；API/UI/CLI 集成 45/4/2 项通过。依赖保留 3 项中危例外（4 条路径），2026-11-13 到期；不计为告警消除。逐项证据见审计报告 §8.4；[PR #277](https://github.com/3yearsZhuang/Aervox-harness/pull/277) 于 2026-10-15 经审查合入 `main`，包含插件生命周期前置提交；最新提交 `c18c9d7d` 的八项远端检查均成功。

<a id="iter-061"></a>

### ITER-061 · 待评审：素简文档与陪伴命名整合

延续已授权的方向 G 界面与命名分层工作：新增 document-ui 受信根界面，统一 companionName/userAddress、旧 assistantName 迁移、设置双字段、各界面问候和随轮元数据；CAP-001/018。依赖已移交的 ITER-055/059/060，合同见 [ADR-025](docs/reference/adr/ADR-025-ui-surface-hosts.md)、[ADR-027](docs/reference/adr/ADR-027-companion-identity.md)。

- 工作分支：`feat/companion-identity`；保留原提交 `de0357ac` / `1c43ddec`。旧 UI 分支的 ITER-057 / ITER-060 与现行 Core/卫生编号冲突，本条目承接新增差量，已有主线编号不变。
- 验收：设置身份保存与重载、三个界面发送元数据、人格优先级、真实会话创建、失败重试与草稿保留；界面选择/退出、窄屏与键盘浏览器回归；完整终审后提交独立 PR。
- 边界：最近会话与固定建议沿用既有来源。服务端人格与客户端身份统一入册、真实模型与移动实机验收留后续；第三方界面开放仍为 Proposed，不因本次整合提升发布状态。

## 2. 当前建议工作

### 2.1 第一批：正确性、验证入口与方向决策

<a id="iter-005"></a>

#### ITER-005 · 暂停

插件可恢复升级：全部入口校验、展开配额、staging 验证与激活、旧配置/Secret/授权保留；FND-02/04、插件规范；CAP-020。2026-09-18 追加差量：导出分发包可重现（细节见 §4.2 剩余差量，不在本表复述）

- 前置与边界：[ITER-004](#iter-004)；激活依赖 ITER-004；限制资源可先做；升级/卸载状态和迁移语义先 ADR。
- 验收：成功意味着全部声明入口可用；超额包有界失败；任一安装阶段中断后可恢复完整旧/新版；同源码导出分发包的字节与校验和稳定
- 进展与剩余：缺包保护、预检/解压配额与 Page 导出已实施；staging 激活、完整元数据导出和升级回滚仍待完成。保持暂停。

<a id="iter-006"></a>

#### ITER-006 · 建议

Page 与客户端认证：iframe source/nonce/会话/全部 capability、禁用撤权；附件 Bearer、合法预检与受限 Page 资源通道；FND-03、ARC-13；CAP-018/020

- 前置与边界：既有认证漏接可独立修；新页面凭据及 Origin 信任策略先 ADR。
- 验收：错误窗口/旧响应/无权/禁用访问无副作用；合法 Token 模式的 JSON、SSE、Page、附件可用，凭据不进入 URL

<a id="iter-009"></a>

#### ITER-009 · 建议

配套形态决策：比较九个硬件方向、电脑依赖、目标 OS、真实 Provider、成本和数据边界；同时登记移动端草稿待决策事项；CAP-001/012/018/025/030/033

- 前置与边界：本项仅探索与样本验证；不默认批准采购、SKU、固件、移动端顺序或工期。
- 验收：有候选比较、继续/暂缓证据和一至两个验证方向；明确 §3 的待决策项与 ITER-016 范围
- 移动端 M0 先决定运行位置、平台、认证和数据范围；通过后才细化 M1～M6 与工期，原估算不构成承诺。

<a id="iter-021"></a>

#### ITER-021 · 建议

HLS 竞赛可行性验证：规则/环境、真实双入口、公开题集与同模型配对报告；研究执行器已实施，详细剩余步骤见 [HLS 阶段条件](docs/how-to/run-hls-agent.md#hls-plugin-delivery) H1～H4；关联 CAP-007/020/027（探索）

- 前置与边界：[ITER-020](#iter-020)；研究范围已由 CR-057 接受；模型服务与 Vitis 镜像待配置；真实验收按 H1→H2→H4，H3 题集/协议可并行准备；只修实际复用路径。
- 验收：固定模型/镜像/目标环境后，真实裸跑和 Agent 可复现，正反 HLS 样例及隔离/杀停通过；开发/留出题按家族隔离，四组同配置、固定分母、独立样本、增益区间和成本齐全；官方未公开判定明确留缺；按专项 §6.3 形成继续、限定补证或暂缓结论，§4.2 登记后才整项移交
- 进展与剩余：研究执行器已合流到 core；H1～H4 真实环境验收未启动，模型/Vitis 未配置。

<a id="iter-029"></a>

#### ITER-029 · 执行中

思隅 CLI 连接版首个切片：新增终端宿主 `@aervox/cli`（`siyu`）与 `@aervox/api-client/transport` 纯传输构建出口；提供单次问答、仅 TTY 连续会话、事件补读与终态等待、连接诊断、配置读写、JSON/JSONL 机器输出、Token 与幂等键、审批与用户问题、有界取消；CAP-002/007/020；CR-058

- 前置与边界：只消费本机 API 与共享传输层；不修改服务端路由、授权与恢复合同，不新增数据库 Schema，不引入中心化服务或独立宿主。
- 验收：打包产物在真实 API + 文件 SQLite 下完成受理/流式/终态、跨客户端与 API 重启的补读与续会话；非交互路径不自动批准工具；有界取消只在中断时触发，超时或失败不替用户取消已受理回合；依赖边界与文档门禁通过，CLI 不反向依赖共享包，共享包也不反向引用 CLI 宿主
- 进展与剩余：单次/连续会话和共享传输已实施；会话详情/分页、模型配置入口及平台矩阵待补。

<a id="iter-032"></a>

#### ITER-032 · 建议

保真上下文投影与真实摘要压缩：把 Turn 上下文装配改为「模型可见投影从权威历史重建」——先固化伴学必须保真的事实清单（当前学习目标、未解决错因、用户偏好、承诺及其来源），再以真实摘要补足规则裁剪（默认关闭；已保留 system 与完整工具组，并明确省略消息没有生成摘要，见 `packages/core/src/context-builder.ts`）；压缩按工具调用/结果组选择边界，超大结果不破坏配对；参考 PI-01 context_edit 投影设计（[架构历史来源 §14.2](docs/reference/ARCHITECTURE.md#upstream-20260929)）与[当前压缩失败边界](docs/reference/ARCHITECTURE.md#1342-pi收敛核心职责让阻塞失败可见)；CAP-002/005/007；对话质量基础设施

- 前置与边界：压缩不得伪造摘要或声称记得已压缩事实；模型可见投影不等于用户删除，删除仍须覆盖原文、摘要与索引；必须保真事实清单与压缩策略先评审，涉及对话契约差量先 ADR；最终输入窗口验收与 ITER-007 协同、测量口径与 ITER-017 协同，不重复登记。
- 验收：固定长伴学对话夹具：压缩后学习目标、错因、承诺与来源保真可追溯，无占位文本；超大工具结果压缩不断开调用/结果配对；最终输入加预留输出不超 Provider 窗口，超额有明确有界处理；每次请求的模型可见上下文可从权威投影重建并复核，展示内容与持久历史分离、旧响应不覆盖终态

### 2.2 下一批：恢复、生命周期与部署

<a id="iter-010"></a>

#### ITER-010 · 建议

先修 Resume 库覆盖/事件高水位/执行关联/接管；再接审批与答案续跑、撤权账本及恢复水位；ARC-04/06；CAP-007/027/033

- 前置与边界：[ITER-002](#iter-002)、[ITER-003](#iter-003)、[ITER-007](#iter-007)；依赖 ITER-002/003/007 的必要切片；续跑、一次性授权/有效期、跨库恢复和账本保留先 ADR；不直接启用现有 Resume Host。
- 验收：缺账本、多工具、跨进程答案、重复接管与旧备份恢复不重复副作用、不吞答案、不复活撤权；未知结果不盲重放；取消请求提交后进程退出，过期 CancelRequested 能以 fencing 收敛终态并结束重连流

<a id="iter-011"></a>

#### ITER-011 · 建议

完整 Schema 迁移：排除 FTS shadow 表、真源重建；接线版本 journal、校验和、恢复状态；ARC-09；CAP-027

- 前置与边界：完整库失败夹具可立即补；迁移协调方案先评审，破坏性转换先 ADR，生产操作另过门禁。
- 验收：每个支持旧版本升级、失败恢复、回滚通过；主库/Vault/账本归属明确；源库不受 staging 失败影响

<a id="iter-012"></a>

#### ITER-012 · 建议

索引生命周期：dirty/reindex、来源修订、模型/维度版本、可切换投影；修可选回填旧列；中文固定语料；ARC-08；CAP-005/026

- 前置与边界：[ITER-003](#iter-003)；依赖 ITER-003；当前错误 SQL 可先修；投影切换和模型版本合同先评审，不能恢复旧隔离列。
- 验收：故障可追平；A→B→A 可切换；资格零越界；单列中文 Recall@K、空间、重建成本

<a id="iter-013"></a>

#### ITER-013 · 建议

有界运行和观测：Worker/Host drain、Provider 排队/取消、安全文本窗口、SSE 背压/分页、跨进程终态；复用 metrics；ARC-05/12、FND-05/06/09；CAP-007/018

- 前置与边界：[ITER-002](#iter-002)、[ITER-008](#iter-008)；依赖 ITER-002/008 的相关切片；先观测后定参数；跨进程通知/新隔离边界先 ADR。
- 验收：慢源/慢客户端和日志洪泛资源有界；停机有截止；已提交窗口提前可读；故障可定位

<a id="iter-015"></a>

#### ITER-015 · 待评审

单机部署主管：API/Worker/模型归属，数据目录、端口、Token、版本、就绪与退出；ARC-13；CAP-001/018/027

- 前置与边界：[ITER-006](#iter-006)、[ITER-008](#iter-008)、[ITER-011](#iter-011)、[ITER-013](#iter-013)；依赖 ITER-006/008 与 ITER-011/013 的必要部分；新主管先 ADR；与移动端决策协调。
- 验收：干净用户目录安装、升级、异常退出、端口占用、磁盘满、卸载保留数据均验证；签名/公证/平台矩阵另过发布门禁
- 进展与剩余：原生主管切片已实现，见 PR #272；整体安装、升级、签名与三平台实机发布验收未完成。

<a id="iter-016"></a>

#### ITER-016 · 建议

已选方向单设备 PoC：真实能力样本，模拟器与一块开发板，身份/ACK/幂等/截止/撤权/热插拔；硬件评估；复用所选 CAP

- 前置与边界：[ITER-009](#iter-009)、[ITER-015](#iter-015)；依赖 ITER-009 决策；先设备 ADR/单一协议；音频/OCR 先证明真实产物；独立算力盒额外依赖 ITER-015。
- 验收：设备缺席不破坏核心流程；获得五至十人使用记录及方向对应价值证据；不把接口响应当实物成功

<a id="iter-026"></a>

#### ITER-026 · 待评审

伴学业务与会话执行器深度解耦插件化：宿主去领域化——CAP-002/007/016 的实现全部内聚于 `plugins/focus-mode`，宿主只保留通用扩展接缝（插件自有状态、出站 metadata 透传、插件流事件订阅、卡片槽位预设、设置与 Composer 贡献、工具与路由贡献）；清除 Turn 协议失效刷题字段与 `study-mode`/`quiz-mode` 历史别名；内核 `@aervox/core` 出口去除产品域提示词与刷题工具（对齐 Apache-2.0 分层）；建立宿主纯净性棘轮守卫与插件可移除目标（BTD-11，移除演练通过）；CR-060（Accepted / Implemented）；CAP-002/007/016

- 前置与边界：学习闭环为 P0 且属学习事实真源，按 AVX-CAP-001 反向检查保留主仓，沿用 ADR-016 的插件边界、不转自选模块、不新建 `modules/*` submodule；不修改 learning 表结构与 CAP-003/004/006 端点；破坏性契约变更（`streamEventTypeSchema`、`@aervox/ui` 发送选项、`@aervox/core` 出口）按 ADR-016 的 CR-060 修订维护 OpenAPI 契约；插件实现目录不得进入分发包；代码缺席须保留安装记录、配置与数据管理入口。
- 验收：宿主（apps/api、apps/worker、apps/web、apps/desktop、packages/ui、packages/api-client、packages/core）零 domain 命中：check-host-domain-purity 零违规且豁免清单已清空，规则已覆盖 B9 迁出的全部样式类名；物理删除 plugins/focus-mode 的实现目录后宿主仍可编译运行，且保留安装记录、配置与数据管理入口：run-removability-drill 三相位通过（API/Worker 冷构建 + 被剥离的 Web/桌面组合根 typecheck）；分发包只含 plugin.manifest.json / config.schema.json / SKILL.md，SHA-256 仍字节可重现；别名体系整体删除（ServerTurnPlugin.aliases、注册表别名映射与候选 id 探测循环），插件 id 唯一；刷新前旧配置由插件自行一次性迁移至 pluginState 命名空间，不静默丢失；插件禁用时模型工具面不含 record_practice_attempt，/v1/terms/explore 不再注册；@aervox/core 公共出口不含产品域提示词与刷题工具；Web 与桌面组合根的插件注入经编译校验（移除演练的 Web/桌面 typecheck 相位）；宿主通用接缝有渲染回归（standard-workbench 用通用插件桩），组合根注入当前无独立渲染用例
- 进展与剩余：S1–S7 及评审修正已实施，见 PR #250；保持原待评审状态。

<a id="iter-027"></a>

#### ITER-027 · 待评审

多进程 SQLite 写入并发与 Worker 自适应退避：消除高频空轮询，流式会话写入期间后台任务自适应降频与 IPC 唤醒；ARC-05/FND-07；基础设施

- 前置与边界：[ITER-002](#iter-002)；依赖 ITER-002 的 Outbox 消费修复；不破坏 WAL 模式快照隔离与单写者约束。
- 验收：API 执行多轮密集对话与流式写入期间，Worker 自动退避至 3s+ 低频轮询，写锁冲突率降至 0；探索基于本地 Domain Socket 或命名管道的事件驱动触发式唤醒，替代持续空写轮询；长周期运行与压测下无 SQLITE_BUSY 报错与 P99 延迟抖动
- 进展与剩余：IPC 唤醒、写入压力退避与连接自愈已实现；真实单用户验收仅部分达成，极端双写入者负载仍受吞吐边界限制。保持待评审。

<a id="iter-033"></a>

#### ITER-033 · 建议

统一模型 Provider 抽象面：收敛两套模型接入栈——`@aervox/core` 的 OpenAI 兼容 Provider（对话路径，原 `@aervox/agent-loop` 过渡壳已移除）与 `apps/api` model-runtime 的 Driver SPI（本地 llama 侧车）；补齐统一 Provider 目录与代际注册、跨栈 stop reason 归一与 usage 分账（T-10）、跨 Provider 上下文交接与标准化测试 Provider；收敛 BTD-04 剩余 `Llama*` 类型泄漏；参考 PI-01 设计（[架构参考学习 §13.4.2](docs/reference/ARCHITECTURE.md#1342-pi收敛核心职责让阻塞失败可见)）；CAP-002/007；本地模型基础设施

- 前置与边界：保持本地单用户与不出网红线：Driver 缺省仍为 unavailable 明确拒绝，受限本地任务缺合规 Provider 时不静默转远程；新增远程 Provider、改变制品信任等级或合并两栈持久化语义先 ADR；不引入第二套 Provider 注册表真源；与 ITER-008 下载/进程正确性协同。
- 验收：同一 Fake/Replay Provider 轨迹下，对话与本地模型两条路径产出一致的规范化终止语义与 usage 分账（对照 provider-parity 表）；新增一个 OpenAI 兼容端点 Provider 仅需注册与目录声明，无需改动执行器、路由或宿主装配；临时检出移除 llama 具体实现后核心构建与数据权利回归通过（复用可移除性演练口径）；Driver 关闭与迟到启动语义保持 BTD-04 验收
- 进展与剩余：ITER-038 已交付 stopReason/usage 归一；Provider 目录/代际注册、终态消费与 DTO 命名的剩余差量按本条推进。

<a id="iter-040"></a>

#### ITER-040 · 建议

标准化测试 Provider 与重试面（PI-01 对比结论）：①收敛 replay/scripted/adapter-sim/mock 四套测试桩为带能力声明的标准 faux 型 Provider（声明 reasoning/toolCalls/多模态支持），作为 provider-parity 标准夹具；②可选注入的 Provider 重试面（有界次数+指数退避+jitter+可重试错误分类：429/5xx/overloaded 与配额/计费错误区分），与宿主 CR-034 降级阶梯协同而非替代

- 前置与边界：[ITER-039](#iter-039)；core 运行时零依赖不破坏；重试面为可选注入（默认关闭），不与宿主降级阶梯形成双真源（core 重试单请求内、宿主降级跨 Provider）；不新增 Provider。
- 验收：标准测试 Provider 有能力声明且 parity 测试经其驱动；四套测试桩收敛或明确各自存续理由；重试面有错误分类与退避测试；默认关闭时现有行为零变化
- 进展与剩余：候选来自 PI-01 测试 Provider 与重试设计评估。

### 2.3 后续候选：只有证据成立才投入

<a id="iter-017"></a>

#### ITER-017 · 待评审

测量后分别决定 Prompt 预算/保真压缩、SQLite 写竞争、向量 topK、计算隔离和资产归属；FND-07/08/10、ARC-05/08/12；相关基础设施

- 前置与边界：[ITER-013](#iter-013)；依赖正确性修复与 ITER-013 指标；CR-062/063 承接代码搜索、向量端到端对照、三平台原生活动 Helper 与计算隔离；生产索引迁移与发行签名单独取证。
- 验收：同设备同数据报告延迟分位数、失败率、内存和质量；未达收益门槛即可停止；不承诺未测倍数
- 进展与剩余：有界搜索、向量对照、活动 Helper、音频/插件 Worker 与 Cargo/IPC 收敛已实现，见 PR #272；生产测量、签名与实机权限验收仍须取证。

<a id="iter-018"></a>

#### ITER-018 · 建议

第二终端检验共享生命周期，再决策 PCB/结构/电源、样机和小批验证；硬件评估

- 前置与边界：[ITER-016](#iter-016)；依赖 ITER-016 价值成立；新增无线、电池、采集或运动能力分别评审，不因 PoC 成功自动批准量产。
- 验收：两种终端无需复制宿主；更新/回滚/删除可测；24→72 小时稳定性、功耗温升、密钥/追溯/维修验证；发布单列

<a id="iter-019"></a>

#### ITER-019 · 建议

是否开放第三方可执行插件；若开放，按已接受 [ADR-009](docs/reference/adr/ADR-009-electron-plugin-sandbox.md) 的进程外隔离、默认无权限与撤权要求设计 Host、签名信任根、SDK 与依赖解析

- 前置与边界：先证明声明式/第一方扩展不足，再用 ADR 明确实现差量与生命周期；隔离基线不作为自由选项，改变基线须显式修订 ADR；现行规范不代表运行能力已实现。
- 验收：有明确用例、威胁与成本比较，并通过 ADR-009 的拒绝/撤权/隔离/兼容验收；未选定前不建通用平台

<a id="iter-022"></a>

#### ITER-022 · 建议

HLS 参赛方案扩大验证与冻结提交：正式评分 ABI、最终 32 GB 环境、离线包与复现报告；详细步骤见 [HLS 阶段条件](docs/how-to/run-hls-agent.md#hls-plugin-delivery) S1～S3；AVX-EXPL-013 P3

- 前置与边界：[ITER-021](#iter-021)；ITER-021 证据支持继续且正式范围/必要 ADR 已评审；先取得最新细则与提交窗口；本项不自动包含产品化、微调或硬件采购。
- 验收：正式入口与评分/反馈边界适配，官方完整分级判定及独立 pass@1/pass@5 可追溯；最终目标环境满足显存与时间预算，另一队员在干净环境断网复现双入口，冻结哈希一致；提交包、依赖/模型/技能声明、失败与成本报告完整；实际赛事提交按窗口与用户授权执行，产品化另归 ITER-043

<a id="iter-028"></a>

#### ITER-028 · 待评审

纯本地多端点对点加密同步探索：局域网发现（mDNS）、SQLite Changeset 增量对齐与去中心化数据同步；CAP-018/027；CR-030/CR-055

- 前置与边界：坚决不引入中心化多租户云端数据库；同步前必须通过端到端加密与用户显式配对授权。
- 验收：完成多设备同网发现 PoC（UDP 多播信标 + 静态对端兜底）与承诺-揭示零信任配对（Ed25519 身份签名、SAS 绑定完整 transcript、分向密钥与重放/乱序/篡改拒绝），替代原 TLS 证书配对设计；以行时间戳水位线 + 显式墓碑提取增量 Changeset（替代原 SQLite Session Extension 设计），验证无冲突双向合并与对抗性缺陷回归（接收端白名单、漂移行隔离、墓碑四向裁决）；移动端（Capacitor）与桌面端（Electron）局域网直连同步学习进度与错题本成功
- 进展与剩余：承诺-揭示配对、设备身份、分向密钥与 Changeset 原型已实现；真实 mDNS、生产接线、多设备直连及原验收第3项待推进。

<a id="iter-043"></a>

#### ITER-043 · 建议

HLS 可选插件产品化：独立模块、真实工具与权限接线、配置/工作台、数据责任及安装升级；详细步骤见 [HLS 阶段条件](docs/how-to/run-hls-agent.md#hls-plugin-delivery) M1～M6；关联 CAP-007/020/027，新增能力编号待需求立项

- 前置与边界：[ITER-022](#iter-022)；ITER-022 竞赛证据完整且有真实学习/调试需求；产品范围与独立 ADR 接受后实施。仅复用 ITER-004/005/006/007/008/013 中所需子合同，关键权限/撤权/生命周期缺口先补齐；本轮只授权写规划。
- 验收：非核心实现独立子仓并经 modules/* workspace 包消费，主仓保留单一接口/受信装配，默认不激活且不复制研究内核；公开题导入→生成/验证→诊断→取消/复盘/导出端到端可用，工具声明有真实 handler，缺权限或撤权后无继续执行；安装/升级失败、禁用、缺包、卸载、重装与回滚可验证；实现缺席时产物仍可导出/删除，竞赛双入口回归不变
- 进展与剩余：仅有条件规划，未创建独立仓库、注册业务 CAP、接入产品插件或承诺工期。

## 3. 设备与移动端的待决策项

ITER-009 需要给出下面的可审阅结论，目前不替用户选定产品：

| 决策 | 建议起点 | 需要的证据 |
|---|---|---|
| 是否要求电脑关机后独立使用 | 先分别比较依赖现有电脑的配件与独立算力盒 | 典型使用时段、成本/能耗、维护能力与本地模型规格 |
| 首个硬件形态 | USB 桌宠、专注旋钮、电子纸卡可优先做低成本概念比较；语音/扫描由真实能力验证决定 | 用户价值、现有外设替代、Provider 真实性、无设备时流程完整性 |
| 移动端定位与平台 | 先明确配套端还是独立端，再决定 Android/iOS 顺序和版本范围 | 后台/权限限制、目标用户设备、打包与真实平台验收 |
| 同网连接与认证 | 明确发现、证书、设备凭据和撤销；不把同一 Wi-Fi 当作授权 | 当前 Token 与隐私契约中身份要求的差量及威胁评审 |
| 跨设备数据范围 | 普通资料与 local_only/混合来源严格分开 | 导出/同步授权、删除传播、离线期限与来源验证 |
| 第一版交互范围 | 从通知、图片、分享、只读复习中选择最小闭环 | 实际任务完成率与成本，不按接口数量决定范围 |

[CR-055](docs/reference/adr/ADR-022-mobile-runtime-access.md#cr-055) 已纳入主仓，仍是 Proposed/Planned；平台顺序与工期仅为提案输入，具体取舍在本节维护。

## 4. 已移交切片

详细实现、测试与剩余限制归 PR 和[追踪基线](docs/reference/REQUIREMENTS_TRACEABILITY.md)。本表保留旧链接入口，不据此宣布生产发布。

| 编号 | 结果 | 证据 |
|---|---|---|
| <a id="iter-001"></a>ITER-001 | 冷 CI、插件产物恢复与可重现验证；ARC-14/FND-10；CAP-020。 | [PR #221](https://github.com/3yearsZhuang/Aervox-harness/pull/221) |
| <a id="iter-002"></a>ITER-002 | 可靠接单剩余差量：Inbox 确认、Turn/Outbox 与 Attempt 的原子接单或可重放恢复；ARC-01；CAP-007。 | [PR #265](https://github.com/3yearsZhuang/Aervox-harness/pull/265)、[PR #228](https://github.com/3yearsZhuang/Aervox-harness/pull/228)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-003"></a>ITER-003 | 删除效果与召回资格：先做 Memory 及其索引的完整清理/独立验证切片，检查期限、用途、撤权与 Restricted；ARC-06/08；CAP-005/013/027/033 | [PR #268](https://github.com/3yearsZhuang/Aervox-harness/pull/268)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259) |
| <a id="iter-004"></a>ITER-004 | 三个独立修复：消息版本短事务/CAS，Config 与同库 Secret 一致提交，会话锁尾链回收；ARC-07、FND-02/07；CAP-013/020 | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-007"></a>ITER-007 | 三个切片：父子任务/Driver 继承取消、截止、删除/授权修订与 local-only；执行时逐项核对 requiredPermissions/grants 的 scope/revision，由受信宿主映射 guarded/full_access 安全等级；动态工具 Schema 快照进入模型请求并在执行时重验；ARC-02/03、插件规范 §8.1；CAP-007/020/033 | [PR #267](https://github.com/3yearsZhuang/Aervox-harness/pull/267)、[PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-008"></a>ITER-008 | 模型制品与进程：路径/symlink、响应与续传验证；启动 epoch、有界探针/日志/指标请求；ARC-11/12；本地模型基础设施 | [PR #266](https://github.com/3yearsZhuang/Aervox-harness/pull/266) |
| <a id="iter-014"></a>ITER-014 | 公开 Port、MemoryStore 试点与实现退出演练；ARC-10；CAP-005/007/020。 | [PR #230](https://github.com/3yearsZhuang/Aervox-harness/pull/230) |
| <a id="iter-020"></a>ITER-020 | HLS 竞赛验证规划；CAP-007/020/027。 | [PR #229](https://github.com/3yearsZhuang/Aervox-harness/pull/229) |
| <a id="iter-023"></a>ITER-023 | Build to Delete 与类 pi 架构规划；CR-056 历史材料见归档导航。 | [原交付登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) |
| <a id="iter-030"></a>ITER-030 | DSH、pi、AstrBot 固定版本更新与差异复评；CAP-007/020/027/033。 | [原交付登记](docs/reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) |
| <a id="iter-031"></a>ITER-031 | 标准工作台连续对话与雾蓝视觉重构；CAP-001/002/018。 | [PR #233](https://github.com/3yearsZhuang/Aervox-harness/pull/233) |
| <a id="iter-034"></a>ITER-034 | ControlContext、abortable 与 ApprovalPolicyPort 内核构件及 executor 接线；ITER-007/013。 | [PR #241](https://github.com/3yearsZhuang/Aervox-harness/pull/241) |
| <a id="iter-035"></a>ITER-035 | 建立独立 @aervox/core、内存 HostToolRuntime、轻量出口与分层许可证；ADR-021。 | [PR #244](https://github.com/3yearsZhuang/Aervox-harness/pull/244) |
| <a id="iter-036"></a>ITER-036 | 伴学 Prompt、工具契约与宿主 guidance 迁出内核，收窄内核导出面；ADR-021。 | [PR #245](https://github.com/3yearsZhuang/Aervox-harness/pull/245) |
| <a id="iter-037"></a>ITER-037 | 移除 agent-loop/cli-approval 过渡壳，下游直连 core，内核类型自持与边界守卫；ADR-021。 | [PR #248](https://github.com/3yearsZhuang/Aervox-harness/pull/248) |
| <a id="iter-038"></a>ITER-038 | Provider stopReason 归一与输入/输出 usage 分账；ITER-033 拆分切片。 | [PR #247](https://github.com/3yearsZhuang/Aervox-harness/pull/247) |
| <a id="iter-039"></a>ITER-039 | 内核对标增强（PI-01 pi-ai 对比结论，2026-10-03 内核自查）：①截断 fail-closed——消费 `ModelStopReason=length` 并整批拒绝截断工具调用（含参数不完整），补 Provider 边界坏响应夹具；②usage 缓存/成本分账——`ModelUsage` 扩展 cacheRead/cacheWrite（透传 OpenAI `cached_tokens`），支撑 ModelRun 埋点与成本治理（T-10） | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-041"></a>ITER-041 | 拆分 executor 流式收集、工具管线与终态收口，统一审批裁决。 | [PR #249](https://github.com/3yearsZhuang/Aervox-harness/pull/249) |
| <a id="iter-042"></a>ITER-042 | ExecuteResult interrupted 与 AttemptStatus 对齐，保留 reason；持久化枚举不变。 | [PR #251](https://github.com/3yearsZhuang/Aervox-harness/pull/251) |
| <a id="iter-044"></a>ITER-044 | 2026-10-08 Core 审核整改第 1/5 迭代：执行正确性收口。修复审批等待后的取消/租约竞态、模型截断工具执行、父子控制传播和 next-step Inbox 丢失；结构化工具超时原因；原队列相关范围：ITER-007/ITER-039 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-045"></a>ITER-045 | 2026-10-08 Core 审核整改第 2/5 迭代：工具运行时与合同收敛。API 复用 core HostToolRuntime，保留 SQLite 注册表和业务授权；跨内存/API 适配验证门控、撤权与取消；原队列相关范围：ITER-007/ITER-040 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-046"></a>ITER-046 | 2026-10-08 Core 审核整改第 3/5 迭代：上下文与有界流式。动态工具受权快照、最终请求容量检查、工具组完整压缩、有界安全正文窗口与静默源取消；原队列相关范围：ITER-032/ITER-013 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-047"></a>ITER-047 | 2026-10-08 Core 审核整改第 4/5 迭代：恢复与 Provider 合同。修复 Resume 完整账本/最新意图/事件高水位并验证宿主接线；统一模型能力、终止与用量合同；原队列相关范围：ITER-010/ITER-033 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-048"></a>ITER-048 | 2026-10-08 Core 审核整改第 5/5 迭代：性能基线与发行边界。建立首段可见/取消/缓冲内存与 SQLite 写竞争可复跑基线；整理 core 稳定公共出口及兼容说明；原队列相关范围：ITER-017/ITER-027 | [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-049"></a>ITER-049 | 项目代码质量、仓库卫生与文档多源偏移审计；收敛入口规则、当前实现和历史证据，压缩重复叙述。 | [PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-050"></a>ITER-050 | PR #258 审计发现落地：删除效果验证、原子接单/组合写入、动态工具取消、取消恢复、锁回收与资产单源；关联 ITER-002/003/004/007/010/017。 | [PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258) |
| <a id="iter-051"></a>ITER-051 | 参考审计首批正确性修复：消息/配置原子写入、锁尾链回收、Memory 清理验证与召回资格、模型异常终止与逐调用快照、插件包预检；对应 ITER-003/004/005/007/039。 | [PR #259](https://github.com/3yearsZhuang/Aervox-harness/pull/259)、[PR #258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257) |
| <a id="iter-052"></a>ITER-052 | 框架解耦审计整改：事件传输与平台能力注入、插件实例生命周期、API 窄依赖、日记素材访问、内核提示词策略与边界守卫；CAP-002/007/018/020。 | [PR #262](https://github.com/3yearsZhuang/Aervox-harness/pull/262) |

HLS 的 H1～H4、S1～S3、M1～M6 是带条件的验证/交付路径，见[HLS 运行指南](docs/how-to/run-hls-agent.md#hls-plugin-delivery)。未获真实环境证据或产品化决定，不自动推进下一阶段。
