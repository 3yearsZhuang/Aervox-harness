# 参考项目上游源码审查（2026-10-14）

这次更新覆盖 `reference/` 内全部八个项目。最值得思隅学习的是已有能力在失败、取消、恢复和长时间使用中的具体处理方式：资源何时真正释放、摘要失败怎样告诉用户、每次模型调用的成本如何留下证据，以及语音和长会话视图如何保持连续体验。建议以这些边界做小范围改进和验证。

本文依据更新区间的提交、实现与测试，并对照思隅实际代码。历史[参考评估](reference-design-transfer.md)只用于定位来源；其中的能力状态和优先级没有直接沿用。本次交付是参考版本更新与审查，建议尚未实施，也不新增执行队列；后续经选择的工作仍进入 [plan.md](../../plan.md)。

## 1. 更新范围与可复核证据

更新目标为 **2026-10-14 抓取时各上游默认分支的 HEAD**，不是最大版本标签或稳定发布承诺。八个旧提交均为新提交的祖先；各子模块更新前后工作树干净，更新后以 detached HEAD 固定；本地 `refs/archive/reference-upstream-2026-10-14` 保留旧提交，原本的本地分支未重置。

| 项目 | 默认分支 | 更新前 → 更新后 | 区间提交数 | 新提交的包版本 |
|---|---|---|---:|---|
| DeepSeek Harness | `master` | [`639ed015` → `d7432673`](https://github.com/deepseek-ai/deepseek-harness/compare/639ed015397290b3745d163aafe02ffee4aa3f84...d743267388641bc76f17c45ce8b4c231aed1d32c) | 935 | `0.2.1-alpha.2` |
| pi | `main` | [`5257d0d5` → `6374c2ba`](https://github.com/earendil-works/pi/compare/5257d0d5f3ab7d42550804f32c67a77b49f485d4...6374c2baf432419ccb4541a99ce4958ecd03dae0) | 360 | coding-agent `1.2.0` |
| AstrBot | `master` | [`b53999e9` → `6ca39319`](https://github.com/AstrBotDevs/AstrBot/compare/b53999e959cfc3b71d7b74713ddee837be843fcb...6ca3931925ab60a05c638fd66cb3c977b0d97f39) | 82 | `4.29.0-beta.2` |
| BaiShou-Next | `main` | [`d95bae0f` → `91c8d9fc`](https://github.com/foxletters-hq/BaiShou-Next/compare/d95bae0f6f3184a94bbc3a77eb71ca987bfcadba...91c8d9fcf5bf6524e67f96b1c5146eb107b736ca) | 27 | Desktop `1.2.17` / Mobile `1.2.25` |
| OpenMAIC | `main` | [`9a28ca39` → `ecb940c1`](https://github.com/THU-MAIC/OpenMAIC/compare/9a28ca39d556f759bf3e62f83b8b58a2319a4ff2...ecb940c136cc5b4ea56dc81b2505e64eff1dea29) | 228 | `1.2.0-rc.2` |
| Petra | `master` | [`b629b295` → `d34e6add`](https://github.com/Wumiu/Petra/compare/b629b295b5ae535d80e09cd59bd3d515bcd8150f...d34e6add082ff388ff57b0e4a0da931770067bd0) | 120 | `0.3.1` |
| archify | `main` | [`06dd0526` → `c21c31ff`](https://github.com/tt-a1i/archify/compare/06dd052602dd9a369e4d034e24faef0917b5a60c...c21c31ffb879668900c5487ea24993bf45d89b15) | 1,238 | `3.1.0` |
| dsh-synapse | `main` | [`a323f76b` → `847b712b`](https://github.com/liangmianya/dsh-synapse/compare/a323f76b0c47ffad59194d8ac7efacb3aa6bdfba...847b712b14579ca5e5c5fcf414f4559589c44d93) | 19 | `0.4.2` |

提交数为 `git rev-list --count old..new`，包含合并历史，不能当作功能数量。完整固定 SHA 与许可证统一见[参考清单](reference-design-transfer.md#101-参考实现要求)。DSH、pi、OpenMAIC 和 archify 的变更量较大，本次审查聚焦与思隅相关的控制流、存储、模型请求和交互故障路径，不声称逐行审完全部变更。

思隅代码对照基线为 `151c36bf`（抓取时 `origin/main`）；另外只读检查了原工作分支 `feat/plugin-lifecycle-reliability` 的 `511f9d1e`，该分支已有的插件生命周期改进也计入判断。本次在独立 `docs/reference-upstream-audit-2026-10-14` 分支交付，没有将该并行改动带入提交。

## 2. 先纠正对思隅现状的判断

| 历史评估中的判断 | 本次实际检查 | 真正剩余的问题 |
|---|---|---|
| ContextManifest 只保存首个 Step | [recording-provider](../../packages/core/src/recording-provider.ts) 已对每次实际请求复制消息、工具和生成参数；[多 Step/重试测试](../../packages/core/test/context-manifest.test.ts)已覆盖 | 诊断写入仍为 best effort，不能当作恢复或授权账本；新建议应聚焦实际使用的策略版本及消费链路 |
| 规则压缩只留首尾并伪称生成摘要 | [context-builder](../../packages/core/src/context-builder.ts) 已保留 system 和完整工具组，并明确提示被省略的消息没有生成摘要；[测试](../../packages/core/test/audit-provider.test.ts)验证配对 | 仍未实现保真摘要；应验证学习目标、错因、承诺和来源的保留，以及摘要失败后的明确降级 |
| 需要新增缓存 Token 分账字段 | [Provider](../../packages/core/src/openai-compat-provider.ts) 已解析缓存读写用量，[存储工具](../../packages/repositories/src/token-usage.ts)也已有分账 | [ModelRunRecord](../../packages/core/src/types.ts)没有 usage，recording-provider 未向记录传递用量，[API 装配](../../apps/api/src/modules/companion/conversation/agent-executor.ts)结束记录只传状态和耗时；需接通实际调用到数据库的链路 |
| 插件注册失败没有 owned lifecycle | `511f9d1e` 已增加 owned activation、暂存注册、失败回滚和 scope 失效 | 注册生命周期和分发包升级是不同问题；仍应独立审查安装目录、持久状态、恢复日志和进程崩溃，不能重复建设已有注册层 |

## 3. 各项目实际增量与借鉴价值

### 3.1 DeepSeek Harness：资源活到最后一项工作退出

`8d488a66ac` 收紧 Agent 关闭顺序：先停止接单，再等活动 Agent 和尚未完成的创建任务全部结算，最后释放会话投影；个别释放失败不能提前撤掉其他任务仍需要的资源。回归专门构造 0、1、2 个失败 teardown，验证维护任务退出时投影还存在，随后才卸载。思隅[Host](../../packages/host-agent/src/agent-host.ts)已有停止领取和 drain，借鉴点是补“创建中停止、释放抛错、父子同时关闭”的资源所有权夹具，并保留有界停机；不能只复制 `allSettled` 后无期限等待。

证据：[停止接单并等待全部结算](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/index.ts#L145)、[失败 teardown 与投影存活测试](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/tests/resource-lifecycle.spec.ts#L19)。

`9c679b21f4` 将运行环境刷新推迟到真正发起模型请求时，覆盖组装后、Provider 准备期间目录和权限变化；测试直接断言最终请求与会话投影重建结果相等且冻结。思隅已经逐请求保存快照，值得补的不是第二个 ContextManifest，而是“排队或准备期间撤权/换目录/切模型之后，最终输入、实际执行与记录仍一致”的夹具。权限提示不能替代工具执行时的授权校验，也不需要迁入 DSH JSONL 或 Cordis。

证据：[最终请求前刷新上下文](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L400)、[目录/权限变化与请求投影一致性](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/working-directory/tests/admission.spec.ts#L14)。当前是 alpha 版本且变更面很大，采用某个模式和验证整套宿主兼容必须分开。

### 3.2 pi：收敛核心职责，让阻塞失败可见

架构变化比版本号更值得关注：`7fd478a2e` 删除 `pi-agent-core` 中实验 Harness、会话存储等入口，低层包保留 Agent、loop、proxy 和类型；持久会话放到独立的 `pi-durable`。不能再照历史文档把已删除的 lane Harness 当作当前可接入接口。对思隅的启发是保持低层执行与持久化宿主的边界，并允许淘汰实验路线；这与现有 core/host/repositories 分工相符，没有证据支持再次更换全部内核。`pi-durable` 的包版本和新增实验客户端也不等同于思隅的恢复、授权及产品验收。

证据：[当前 agent 导出面](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/agent/src/index.ts)、[独立 durable 包及存储出口](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/durable/package.json)。

`89e5c2c07` 修复阻塞式压缩失败后仍发出超大请求、只得到空回答的问题：等待的压缩失败就让本次生成明确失败，并将最新失败保留到成功生成摘要。对思隅应落实为摘要错误有独立可见状态、可恢复操作和有界重试；现有规则裁剪没有真实摘要，不能把这项当作已经实现。上游“没有可压缩内容”或拒绝压缩仍可能继续请求，也需要按思隅最终输入窗口合同单独判断。

证据：[阻塞失败处理](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/durable/src/harness/generation.ts#L129)、[失败与恢复状态测试](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/durable/test/harness-compaction.test.ts#L1064)。

`8c911797c` 则把 MCP 的“连接中”也纳入关闭：中止初始化、取消重试等待、等待连接尝试结算后再返回。思隅 [MCP service](../../apps/api/src/modules/ecosystem/mcp/service.ts)的同步包含异步 initialize/listTools，而断开会禁用并注销工具；应验证两者竞争时迟到同步不会重新挂回工具。借鉴这一故障夹具即可，不把 pi 的 transport 管理直接替换进现有服务。

证据：[连接中的取消与关闭](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/coding-agent/src/extensions/mcp/runtime.ts#L359)、[初始化及重试中关闭测试](https://github.com/earendil-works/pi/blob/6374c2baf432419ccb4541a99ce4958ecd03dae0/packages/coding-agent/test/mcp-extension.test.ts#L628)。

### 3.3 AstrBot：生成器清理和摘要降级的失败路径

`33ef43be3` 把异步工具生成器的推进和关闭放在同一个 owner task，按消费者需求推进，并在取消时等待清理完成；测试覆盖重复取消、清理抛错、取消后又 yield 和后台工具关闭。这比“加一个取消信号”更接近真实资源语义。思隅[abortableStream](../../packages/core/src/abortable.ts)已经能结束本地等待并丢弃迟到结果，但 `iterator.return()` 是异步尽力清理；应由持有资源的宿主明确跟踪清理完成、容量占用和截止后的升级处理。不能为等待不合作的迭代器而重新引入无限停机。

证据：[owner task 与清理](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/astrbot/core/utils/async_generator.py#L9)、[取消与清理反例](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/tests/unit/test_async_generator.py#L59)、[真实工具处理器回归](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/tests/unit/test_tool_generator_lifecycle.py#L129)。Python task/context 的机制不直接移植到 TypeScript，借鉴的是所有权和结束时序。

`a8bb0803e` 修复摘要 Provider 配额耗尽时长时间退避：摘要只请求一次，失败后逐轮裁剪并重新计数，保留工具配对。思隅当前规则裁剪已保留配对，下一步应在真实摘要接入时补独立预算、超时和失败状态。上游保留最新一轮，即使它仍超窗口也照发并警告；这不是最终输入窗口的硬保证，不能照搬为思隅预算合同。

证据：[单次摘要请求](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/astrbot/core/agent/context/compressor.py#L280)、[逐轮降级及仍超限分支](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/astrbot/core/agent/context/manager.py#L88)、[摘要失败与最新轮过大测试](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/tests/agent/test_context_manager.py#L651)。

### 3.4 BaiShou-Next：先让缓存收益可测量

`cc9c8278` 将具体时刻移出稳定 system 前缀，`5c9c0886` 又移除日记格式规则中的实时日期渲染，保留模板占位符。这能减少无关变化破坏提示缓存，但不能从源码推断实际节约比例。思隅可利用已有 ContextManifest 比较相邻请求的稳定部分和易变部分，先确认学习状态、记忆和工具变化中哪些确实需要刷新，再做同模型、同材料的配对实验。

同一提交修复缓存写入字段和多步骤计费：逐 Step 累计，结束时使用 SDK 的整轮 `totalUsage`，避免仅统计最后一步。思隅的真实差距是 §2 所述 usage 落库链路未接通。建议先保存每次 Provider 调用的最后权威用量，再按回合聚合；区分缺失与零、单次累计与跨请求求和。BaiShou 的 SDK finish 语义不能直接套在思隅的流式 chunk 上。

证据：[稳定的日记规则](https://github.com/foxletters-hq/BaiShou-Next/blob/91c8d9fcf5bf6524e67f96b1c5146eb107b736ca/packages/shared/src/utils/diary-template.util.ts#L101)、[逐步与整轮用量处理](https://github.com/foxletters-hq/BaiShou-Next/blob/91c8d9fcf5bf6524e67f96b1c5146eb107b736ca/packages/ai/src/agent/stream-accumulator.ts#L171)、[多步及缓存分账回归](https://github.com/foxletters-hq/BaiShou-Next/blob/91c8d9fcf5bf6524e67f96b1c5146eb107b736ca/packages/ai/src/__tests__/token-usage.util.test.ts#L109)。

### 3.5 OpenMAIC：区分响应失败、提交失败与资源释放

`9d2eface` 修复导入已持久化但响应丢失时误删数据：聚合文档写入是提交点，失败后尝试读回，不能仅因 Promise 拒绝就按 ID 删除；消费方成功回调也放到回滚范围之外。思隅[附件入口](../../apps/api/src/modules/knowledge/content/routes.ts)已有幂等键与读回能力，值得补“提交成功后连接断开、同 key 重试、读回也失败”的故障夹具，保证不重复创建、不删除已提交内容，不确定状态明确可见。

证据：[提交与失败处理](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/lib/import/use-import-classroom.ts#L539)、[三种读回结果测试](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/tests/import/server-backed-import-flow.test.ts#L158)。

`bceb7d12`、`02194d1b` 将预览和视频导出的执行容量隔离，幂等释放配合断连、失败和超时处理。可用于思隅昂贵的文档解析/渲染：取消响应后，必须等底层清理完成才能宣称执行槽空闲。当前没有必要为了借鉴容量控制引入它的 server-first 存储或多 owner 架构；上游 rc 版本也不提供思隅平台实测保证。

证据：[预览准入与释放](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/render-service/src/main.ts#L428)、[隔离与故障测试](https://github.com/THU-MAIC/OpenMAIC/blob/ecb940c136cc5b4ea56dc81b2505e64eff1dea29/render-service/test/preview-route.test.ts#L652)。

### 3.6 Petra：学习语音顺序的验收场景，保留对实现的质疑

`aac255b` 把并发预取和 FIFO 播放分开：后一句先合成完成，也要等待队首；静音通过音量处理，使结束回调和气泡收尾继续运行。对伴学解释很重要，否则“因此……”可能先于推导被读出。思隅已有[合成入口](../../apps/api/src/modules/platform/voice/service.ts)和[语音试听](../../plugins/panels-ui/src/persona/VoiceAbilityCard.vue)，应基于这些入口测试分段顺序、打断、静音和迟到结果。

但该实现仍有缺口：`preload()` 的失败分支只标记 ready，没有唤醒播放队列；本次以原源码和隔离的合成替身复现了唯一队首失败后不推进、idle 回调不触发。创建的 blob URL 也未见对应释放，`stop()` 未取消在途合成。现有“中间段失败”测试不能覆盖全部时序。适合借鉴测试设计并补反例，不宜直接复制播放器。

证据：[入队、预取失败与 FIFO](https://github.com/Wumiu/Petra/blob/d34e6add082ff388ff57b0e4a0da931770067bd0/src/tts/TTSPlayer.ts#L109)、[乱序合成测试](https://github.com/Wumiu/Petra/blob/d34e6add082ff388ff57b0e4a0da931770067bd0/tests/tts-order.test.js#L114)、[静音测试](https://github.com/Wumiu/Petra/blob/d34e6add082ff388ff57b0e4a0da931770067bd0/tests/tts-mute.test.js)。新增麻将、歌词和天气等功能没有直接证明对思隅伴学目标的收益，不据此扩大范围。

### 3.7 archify：让源码引用真的绑定固定对象

`0857afc8` 禁用 Git replacement refs，`abd6b367` 阻止 partial clone 读取对象时隐式联网。普通与批量读取都使用原始 Git 对象，校验完整 SHA、来源仓库和对象存在性；对象缺失时明确失败，保留旧成品。测试还模拟旧 Git 忽略 `GIT_NO_LAZY_FETCH` 的情况，验证禁用传输协议的兜底确实生效。

这直接适用于思隅的参考源探针：[dsh-reference](../../packages/host-agent/src/dsh-reference.ts)目前核对父仓 gitlink，但版本和许可证声明取自工作树 `package.json`，没有把实际子模块 HEAD、工作树内容及 LICENSE 字节都绑定到该 SHA。值得独立补探针和反例：HEAD 漂移、脏文件、replace refs、缺失对象均准确报告，只读检查不隐式下载。本次八仓工作树和 HEAD 已另做 Git 核验，但没有因此更改探针行为。

证据：[本地对象读取与容量上限](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/archify/renderers/shared/repository-evidence.mjs#L23)、[替换对象反例](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/test/repository-evidence-replacement.test.mjs#L15)、[缺失对象与禁止联网测试](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/test/repository-evidence-partial-clone.test.mjs#L11)。

`e2c44ce5` 的另一点价值是按输入顺序一次返回多项可修复诊断，并限制读取字节、只验证需要的行，失败不替换旧 HTML。思隅可以将此用于知识导入和来源报告。它保证的是来源与结构检查，不能证明架构图的语义正确，也没有必要为此引入整套绘图引擎。

证据：[诊断次序、旧成品保留及读取上限测试](https://github.com/tt-a1i/archify/blob/c21c31ffb879668900c5487ea24993bf45d89b15/test/repository-evidence.test.mjs#L37)。

### 3.8 dsh-synapse：宿主升级要验证引用生命周期

`b6554a5` 适配 DSH 0.1.7-rc.2 的 retain/ready/release：发送路径等待会话就绪，并在 finally 释放；观察会话按 generation 更换绑定，停止或销毁时清理引用。思隅[工具运行时](../../packages/core/src/host-tool-runtime.ts)已有 owner/generation 保护，新增价值是对真正采用的宿主协议做关闭、替换、超时和迟到事件夹具。Synapse 声明适配的宿主版本与本次 DSH `0.2.1-alpha.2` 不同；八仓各自更新到最新不等于它们已作为一套系统兼容。

证据：[会话持有与释放](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/client.js#L37)、[generation 与销毁测试](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/test/client-bridge.test.js#L415)。

`6988021`、`bfd0535` 增加按视口挂载卡片与动画帧合并更新。思隅[标准会话视图](../../packages/ui/src/components/workbench/StandardConversation.vue)仍是线性列表，先测长会话挂载数量、内存和滚动延迟，再决定是否应用虚拟化。上游仍扫描全体卡片，连线并未等量虚拟化，部分测试是源码断言，不能据此宣称大图帧率达标，也不能推导思隅必须新增无限画布。

证据：[按相机与缩放计算视口](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/app.js#L989)、[画布测试](https://github.com/liangmianya/dsh-synapse/blob/847b712b14579ca5e5c5fcf414f4559589c44d93/test/canvas-runtime.test.js)。

## 4. 建议的取舍

优先选择能够对已有路径给出明确前后对照的切片。以下是本次研究建议，不是批准实施的任务单。

| 建议顺序 | 切片 | 最小验收 |
|---|---|---|
| 1 | 接通每次模型调用的权威 usage 与缓存分账 | 多 Step、重试、缺失 usage、最后一次 usage 覆盖、失败流都可追溯；缺失值不冒充零成本；稳定前缀的收益用同模型配对测量 |
| 2 | 将取消结束与资源清理完成分开验证 | 连接建立中取消、工具生成器清理变慢、释放抛错、旧任务迟到完成后，无新副作用、无泄漏、无虚假空闲容量 |
| 3 | 保真摘要与失败降级 | 长伴学夹具保留目标/错因/承诺/来源；摘要失败有明确状态且重试有界；保留 system 和工具组、不声称已总结未知内容 |
| 4 | 语音分段顺序与长会话展示 | 第二段先合成完成仍按原文播放；静音与取消语义分清；长会话离屏内容不持续渲染，选中项和失败回合仍可定位 |

思隅已有 SQLite/Port、执行管线、取消信号、请求快照和插件隔离接口。这些基础继续保留。对照上游时，采用故障场景、状态划分和测量方法最容易产生收益；整体替换会话存储、引入另一套宿主或照搬上游产品面，需要单独证明必要性。

## 5. 验证与采用边界

本次同步 DSH 固定 SHA、准入测试及 runner manifest。当前 [DSH runner](../../packages/host-agent/test/fixtures/dsh-turn-runner.mjs) 的 `modelTurn` 直接调用 OpenAI 兼容 `/chat/completions`；`DSH_LIB_MODE` 仅检查库导出，未组装 Cordis 或执行 DSH 内核。因此主仓准入与协议测试通过，只能证明思隅的固定版本登记和适配协议，没有证明新 DSH 运行时完整兼容。此次库符号加载测试使用工作区既有构建产物，不能作为新 SHA 已构建的证据。

已完成的验证：

- 主仓 `./aervox ci all` 完整退出码为 0，包含代码、构建、类型、测试、原生专项与文档门禁；其中 Host Agent 为 76 passed、1 skipped，真实模型条件测试未运行。
- Synapse `node --test test/*.test.js`：89/89 通过，退出码 0；这些测试包含源码断言，不能等同于浏览器性能验证。
- archify 的 `repository-evidence`、`repository-evidence-replacement`、`repository-evidence-partial-clone` 三个 Node 测试文件：43/43 通过，退出码 0。
- Petra 使用 Node 24 读取原始 TypeScript、仅替换 Tauri 合成入口和浏览器对象的隔离探针，复现队首失败后队列不推进；这不是 Tauri 实机或完整上游测试。

其余上游测试链接表示已阅读的行为证据。没有安装上游依赖或构建八仓完整产物，也未验证真实模型、操作系统权限或发布包。参考更新不构成生产发布验收。

源码与资产分别核验许可：六仓顶层为 MIT，AstrBot/BaiShou 为 AGPLv3；BaiShou 美术资产和 Petra 新增第三方资源有各自条款。本文未复制上游实现或素材。实际采用时仍按文件来源处理许可，不能将顶层软件许可证推及所有资产。

回退时一起恢复父仓 gitlink、DSH 常量、runner manifest 和当前清单；本次没有修改业务数据库。
