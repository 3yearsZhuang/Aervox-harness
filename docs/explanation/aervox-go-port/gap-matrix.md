# 差距矩阵：dsh-Go 客户端 × Aervox 引擎

本表是本仓库的产出。它回答一个问题：把 dsh-Go 的 Flutter 客户端指向 Aervox 引擎时，101 个远端端点里有多少能如实工作、多少需要新实现、多少注定是空壳。

## 取证方式

- dsh-Go 侧：固定提交 `f2d589c4a7f415f0d0a9f3c3a1a57a94ac0e11f4`，端点由 `packages/dsh_client/lib/src/*.dart` 中的 `DshRpc.call` 调用点穷举，得 101 个，跨 28 个命名空间。
- Aervox 侧：`packages/host-runtime/src` 下实际注册的路由，唯一路径 **177** 条、注册路由 **173** 条。
- 判定分两级：先看有无处理器，再看**请求/响应字段形状**是否可直接套用。后者决定 A 与 B 的分界。
- 所有数字由 `scripts/measure.py` 产出并断言，不手工填写。

### 本表修订记录

初版有两处定量错误，成因是取证正则的同一缺陷两次发作：

| 项 | 初版 | 实际 | 成因 |
|---|---:|---:|---|
| Aervox 路由数 | 112 | **177** | 正则 `[a-z0-9/:{}-]` 不含大写，含 `:attachmentId` 的路径被静默漏掉 |
| dsh-Go 命名空间 | 21 | **28** | 手工计数，未复核 |
| 判定 A（直接对应） | 4 | **0** | 只核了处理器存在性，未核字段形状 |

修订后，四个原判为 A 的端点在字段级核对下全部需要适配：`session/create` 的入参 `{workspaceId, cwd, sessionId, agentPreset}` 与 Aervox 的 `{title, id, projectId}` 无一对应；`session/rename` 的 dsh-Go 用 `{sessionId, title}`，Aervox 用路径参数加 `{title, projectId}`。

## 结论先行

按 `host-runtime` 实际注册的路由逐项核对后，101 个端点的分布是：

| 判定 | 数量 | 占比 |
|---|---:|---:|
| A 直接对应（零适配） | 0 | 0% |
| B 需适配或新增 | 23 | 23% |
| C 无对应能力 | 75 | 74% |
| D 不应暴露（凭据类，Aervox 刻意不进前端） | 3 | 3% |

**没有任何端点可以零适配直接接上。** 全部 23 个可对齐端点都需要重写请求/响应映射；其余 75 个在 Aervox 侧没有承载能力。

这个比例比初看更严峻。真正的结论是：**缺口集中在「客户端形态所依赖的环境能力」上**——终端、工作区文件、插件宿主、Cordis 运行时。这些不是写几个接口就能补的，它们依赖 dsh-Go 的 PRoot Linux 环境。放弃它们意味着 dsh-Go 的界面会有大块永久空壳；实现它们意味着 Aervox 要引入一整套运行时，那已经不是移植客户端，而是移植整个产品架构。

## 逐域矩阵

图例：**A 直接对应**（Aervox 有等价处理器且字段可原样套用；本表实测为 0）／**B 需新实现**（Aervox 有同域能力但接口不同，或需新增端点）／**C 无对应**（Aervox 无此能力，且依赖其不具备的运行时）／**D 应删除入口**（客户端入口在 Aervox 上无意义）

### 对话与会话（核心闭环）

| dsh-Go 端点 | Aervox 对应 | 判定 | 说明 |
|---|---|---|---|
| `session/create` | `POST /v1/sessions` | B | 入参无一对应：dsh-Go 用 `{workspaceId, cwd, sessionId, agentPreset}`，Aervox 用 `{title, id, projectId}` |
| `session/list` | `GET /v1/sessions` | B | Aervox 返回 `SessionItem` 形状不同，需适配 |
| `session/rename` | `PATCH /v1/sessions/:id` | B | dsh-Go 用 `{sessionId, title}`，Aervox 用路径参数加 `{title, projectId}` |
| `session/page` | 历史分页 | B | Aervox 分页游标与页大小语义不同 |
| `session/prompt` | `POST /v1/sessions/:id/turns` | B | 受理模型不同：Aervox 先建 Turn 再走 SSE |
| `session/cancel` | `POST /v1/turns/:id/cancel` | B | 路径参数名与返回体不同，需映射 |
| `session/projections` | 无单一对应 | B | dsh-Go 的投影聚合需 Aervox 拼装 |
| `session/search` | 无 | B | 需新增；Aervox 手机端当前只过滤已加载 |
| `session/fork` | 无 | C | Aervox 无对话分叉 |
| `session/attachment` | `POST /v1/attachments` | B | Aervox 手机端明确拒绝附件 |
| `session/modelCatalog` | 无 | C | 单槽位模型配置，无模型目录 |
| `session/selectModel` | 无 | C | Aervox 固定 `PRIMARY_MODEL` 单槽 |
| `session/updateQueue` | 无 | C | 无排队语义 |
| `userQuestions/answer` | `POST /v1/turns/:id/questions/answers` | B | 答案载荷与幂等键形状不同 |
| `commands/execute` | 无 | C | 斜杠命令未接线 |
| `permissionPresets/catalog` | 无 | C | 无权限预设体系 |
| `credentials/describe`、`set`、`unset` | 原生 Keystore 槽位 | D | Aervox 密钥不进 WebView/前端，接口不应暴露 |

### 事件流与审批（决定界面可信度）

| 项 | 判定 | 说明 |
|---|---|---|
| `$events` mux 流（非 REST） | **B，高风险** | 这是最大的单点工作：dsh-Go 的 UI 依赖 mux 的世代、seq 连续、断线重同步。Aervox 用 POST + SSE + `Last-Event-ID`，语义可映射但**不是同一套**，需完整复刻适配层 |
| `approval/request`、`approval/decided` | B | Aervox 有 `POST /v1/turns/:id/tool-approvals`，但事件形状与「本对话都允许」等语义不同 |
| 工具调用事件 `tool_request`、`tool_result` | B | 事件名一致但载荷字段不同，需映射 |

### 工作环境（最大的空洞）

| dsh-Go 端点 | 判定 | 说明 |
|---|---|---|
| `terminal/*`（8 个） | **C** | Aervox 无终端、无 PTY、无 shell。这 8 个端点没有落点 |
| `workspaceFiles/*`（4 个） | **C** | 无工作区文件系统；手机端只有 SAF 单文件选择 |
| `workspace/*`（7 个） | **C** | 无工作区概念 |
| `directoryPicker/*`（2 个） | **C** | 同上 |
| `fileUploads/upload` | **C** | 无上传通道 |

### 插件与扩展

| dsh-Go 端点 | 判定 | 说明 |
|---|---|---|
| `pluginManager/*`（10 个） | **C** | Aervox 手机端 `pluginDefinitions = []`，无插件宿主、无安装器 |
| `dynamicCordisRunner/*`（3 个） | **C** | 无 Cordis 运行时 |
| `pluginInventory/list` | B | Aervox 有插件清单，但手机端 `pluginDefinitions = []`，需装配 |
| `skills/list` | B | Aervox 有技能域，语义与 dsh-Go 不同 |

### 设置与主机

| dsh-Go 端点 | 判定 | 说明 |
|---|---|---|
| `settings/describe`、`mutate`、`update` | **B** | Aervox 设置为固定面板，无通用声明式设置协议 |
| `agentPresets/*`（3 个） | **C** | 无 agent 预设 |
| `appAuth/*`（7 个） | **C** | 无账号体系 |
| `llm/listProviders`、`listConfigurableProviders` | **C** | 单 Provider 单槽位 |

### 其它

| dsh-Go 端点 | 判定 | 说明 |
|---|---|---|
| `speech/*`（5 个） | **B** | Aervox 有系统 TTS 与一次性识别，无引擎侧语音套件 |
| `schedule/*`（6 个） | **C** | 无定时任务 |
| `goals/*`（7 个） | **C** | 无目标体系（Aervox 的学习目标不通用） |
| `subagents/*`（2 个） | **B** | 有 `GET /v1/turns/:id/subagents`，无 prompt/interrupt |
| `messageFeedback/*`（3 个） | **C** | 无消息反馈 |
| `cotTranslation/*`（2 个） | **C** | 无 |
| `officeToPdf/render` | **C** | 无 |
| `job/kill` | **C** | 无后台任务 |
| `fileReferences/list`、`sessionReferenceResolver/candidates` | **C** | 无引用体系 |

## Aervox 有而 dsh-Go 无入口的能力

采用 dsh-Go 界面后，这些在手机上**没有位置**，除非新增端点与界面：

学习目标、题库与导入、练习会话、今日复习与排期、错题本、知识点、学习计划、日记（生成/版本/往期）、人格设定与修订、知识关系、练习报告。

这不是「接口没对上」，而是**产品身份不同**。dsh-Go 是通用 agent 客户端，Aervox 是学习+陪伴的个人助手。

## 三种可能的范围

| 范围 | 保留的 dsh-Go 界面 | 需要的工作 | 结果形态 |
|---|---|---|---|
| **最小闭环** | 对话页 + 会话抽屉 + 审批 + 提问 | 约 13 个端点 + mux/SSE 适配层 | 一个能对话的客户端，其余入口必须用能力协商隐藏 |
| **含工作环境** | 上述 + 终端 + 文件 + 插件 | 需先给 Aervox 引入运行时（PTY/文件系统/插件宿主） | 不再是移植客户端，而是移植架构 |
| **保留 Aervox 自有域** | 上述 + 学习/日记面板 | 新增端点与 Flutter 页面 | 事实上的新客户端，与 dsh-Go 分叉 |

## 由本矩阵支撑的判断

1. **「换驱动」这个说法不成立。** 只有约四分之一的端点能直接对应；核心的 mux 事件流需要重写适配层，工作环境的 25 个端点没有落点。
2. **最小闭环有可行性**，但产出是一个**大量入口被隐藏的对话客户端**，不是 dsh-Go 的体验。它的价值主要是验证适配层，不是获得 dsh-Go 的功能。
3. **真正的成本在事件流适配**，不在 REST 端点数量。REST 是机械工作；mux 的世代与重放语义错了会直接表现为消息重复或丢失。
4. **如果目标只是学到 dsh-Go 的做法**，性价比远高于移植的是：流式渲染修补、能力协商与诚实降级、设置索引单一来源。这三项在 Aervox 主仓的既有形态下就能做，已记录在 [Android 独立端迭代建议](../../proposals/mobile-iteration-2026/README.md)。

## 附：端点全表（逐项判定）

自动化产出，与上文归并表述互为校验。A=直接对应，B=需新实现，C=无对应，D=不应暴露。

| 端点 | 判定 |
|---|---|
| `agentPresets/list` | C |
| `agentPresets/read` | C |
| `agentPresets/select` | C |
| `appAuth/answer` | C |
| `appAuth/begin` | C |
| `appAuth/cancel` | C |
| `appAuth/list` | C |
| `appAuth/poll` | C |
| `appAuth/signOut` | C |
| `appAuth/usage` | C |
| `commands/execute` | C |
| `cotTranslation/limits` | C |
| `cotTranslation/translate` | C |
| `credentials/describe` | D |
| `credentials/set` | D |
| `credentials/unset` | D |
| `directoryPicker/createDirectory` | C |
| `directoryPicker/list` | C |
| `dynamicCordisRunner/inventory` | C |
| `dynamicCordisRunner/stopFromPanel` | C |
| `dynamicCordisRunner/undefineFromPanel` | C |
| `fileReferences/list` | C |
| `fileUploads/upload` | C |
| `goals/clear` | C |
| `goals/complete` | C |
| `goals/create` | C |
| `goals/edit` | C |
| `goals/get` | C |
| `goals/pause` | C |
| `goals/resume` | C |
| `job/kill` | C |
| `llm/listConfigurableProviders` | C |
| `llm/listProviders` | C |
| `messageFeedback/delete` | C |
| `messageFeedback/list` | C |
| `messageFeedback/put` | C |
| `officeToPdf/render` | C |
| `permissionPresets/catalog` | C |
| `pluginInventory/list` | B |
| `pluginManager/cancelInstall` | C |
| `pluginManager/inspect` | C |
| `pluginManager/installBundle` | C |
| `pluginManager/listBundles` | C |
| `pluginManager/listPlugins` | C |
| `pluginManager/registries` | C |
| `pluginManager/removeBundle` | C |
| `pluginManager/setBundleEnabled` | C |
| `pluginManager/setPluginEnabled` | C |
| `pluginManager/waitForInstall` | C |
| `schedule/catalog` | C |
| `schedule/delete` | C |
| `schedule/edit` | C |
| `schedule/history` | C |
| `schedule/run` | C |
| `schedule/update` | C |
| `session/attachment` | B |
| `session/cancel` | B |
| `session/create` | B |
| `session/fork` | C |
| `session/list` | B |
| `session/modelCatalog` | B |
| `session/page` | B |
| `session/projections` | B |
| `session/prompt` | B |
| `session/rename` | B |
| `session/search` | B |
| `session/selectModel` | C |
| `session/updateQueue` | C |
| `sessionReferenceResolver/candidates` | C |
| `settings/describe` | B |
| `settings/mutate` | B |
| `settings/update` | B |
| `skills/list` | B |
| `speech/cancelPreparation` | B |
| `speech/catalog` | B |
| `speech/configure` | B |
| `speech/prepare` | B |
| `speech/transcribe` | B |
| `subagents/interruptByParent` | B |
| `subagents/prompt` | B |
| `terminal/close` | C |
| `terminal/create` | C |
| `terminal/environment` | C |
| `terminal/list` | C |
| `terminal/rename` | C |
| `terminal/resize` | C |
| `terminal/shells` | C |
| `terminal/write` | C |
| `userQuestions/answer` | B |
| `workspace/archiveSession` | C |
| `workspace/create` | C |
| `workspace/delete` | C |
| `workspace/insertBefore` | C |
| `workspace/pinSession` | C |
| `workspace/rename` | C |
| `workspace/unarchiveSession` | C |
| `workspace/unpinSession` | C |
| `workspaceFiles/list` | C |
| `workspaceFiles/read` | C |
| `workspaceFiles/readBytes` | C |
| `workspaceFiles/stat` | C |

## 未做的事

- 未实际运行任何适配代码，本表是静态对照结果。
- 未核对 Flutter 侧 UI 对每个端点的调用频率与降级行为（例如某端点缺失时是隐藏入口还是报错）。
- 未评估 Flutter 与 Aervox 现有 Vue 界面的并存成本。
- 未做许可证层面的翻检（是否含 `sdk/`、`examples/` 的 MIT 片段）。

下一步若继续，应先做**最小闭环的适配层原型**，用它验证第 3 条判断，而不是先补端点。
