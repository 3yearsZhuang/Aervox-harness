---
id: ADR-031
decision_status: accepted
---

# ADR-031 第一方插件组织仓库与受信构建

维护者已接受在 `Aervox-agent` 组织建立 `Aervox-plugins` 集合仓，整体以固定提交的 Git submodule 挂载到主仓 `plugins/`，保留现有包名、接口和默认产品组成。实施状态与验收证据只在 [ITER-073](../../../plan.md#iter-073) 维护。

## 背景与当前证据

本决定以 Core 迁移已合入的主线 `119dbf2067337153724830094fc304e096bfdf28` 为基线。Core 已由 [PR #348](https://github.com/3yearsZhuang/Aervox-harness/pull/348) 接入必需子模块，但插件依赖和生命周期不同，不能直接复制其独立安装结论。

| 当前范围 | 实际载体与依赖 | 迁仓判断 |
|---|---|---|
| `plugins/bot-onebot` | 服务端适配器，只经 `@aervox/host-plugin-api` 类型契约消费宿主；7 个受跟踪文件，约 30 KB | 随集合仓保留，真实 QQ 账号验收另计 |
| `plugins/bot-weixin` | 同类 Bot 适配器；7 个文件，约 42 KB | 随集合仓保留，不能用 fake transport 宣称真实登录完成 |
| `plugins/focus-mode` | 服务端、Vue UI、术语 Schema、声明与测试；40 个文件，约 167 KB；消费 Core、Contracts、Host Plugin API、API Client、UI 公共出口 | 按本决定整体迁出，保留双端接口与默认学习组成 |
| 其余 6 个 `plugins/*` | `anki-sync`、`diary-distillers`、`health-guard`、`home-assistant`、`multimodal-ocr`、`xiaomi-health` 的声明、配置和技能；合计 17 个文件，约 26 KB | 随集合仓保留；声明存在不能证明其外部连接或业务能力已经实现 |
| `surfaces/*` | workbench、companion、proactive、panels，共 4 个受信根界面或设置包 | 属 [ADR-025](ADR-025-ui-surface-hosts.md)，留待后续独立决定 |
| FlowCampus | [PR #347](https://github.com/3yearsZhuang/Aervox-harness/pull/347) 的并行业务交付，尚未进入上述主线 | 本批冻结提取不包含该 PR；后续交付须重基到集合仓与主仓集成 PR，不从并行分支或未提交内容提取 |

当前 `plugins/` 受跟踪内容合计约 265 KB，分仓的主要价值是组织所有权、审查与版本边界。主仓保留既有 Git 历史，因此不能承诺迁仓会显著降低完整克隆大小。

接口边界已有基础：[Bot 合同](../../../packages/host-plugin-api/src/bot-adapter.ts)、[贡献合同](../../../packages/host-plugin-api/src/contribution.ts)与[宿主服务 Port](../../../packages/host-plugin-api/src/host-services.ts)允许插件不直连数据库或宿主私有实现。实际缺口是三个代码插件仍用 `workspace:*`，Host Plugin API 又依赖 Core 和 Contracts；测试与部分 TypeScript 配置还继承主仓配置。这些包尚未向 npm 发行，插件独立仓不能脱离宿主直接冻结安装。

## 备选方案

| 方案 | 收益 | 成本与结论 |
|---|---|---|
| 继续同仓 | 原子修改和本地开发最简单 | 不满足本轮组织仓库目标，保留为失败回退 |
| 一个 `Aervox-plugins` 集合仓，整体挂载 `plugins/` | 一次固定提交保留现有 `plugins/<id>`、workspace 发现、组合根与声明路径；共享契约变动较易协调 | 第一阶段采用；仓库统一版本引用不等于各 Manifest 共用一个版本 |
| 每个插件单独一个仓库，挂载原插件目录 | 可独立维护、授权团队和发行节奏 | 当前规模下增加多份 gitlink、CI 与兼容配对；待出现独立团队或发行需求后再拆，不先建立九个仓库 |
| 先发行 SDK/npm 插件或建立动态代码市场 | 可进一步解耦开发与分发 | 涉及 SDK 版本政策、供应链、信任和运行边界，超出本轮源码迁仓；不是迁仓前置 |

集合仓为 [Aervox-agent/Aervox-plugins](https://github.com/Aervox-agent/Aervox-plugins)，仓根直接包含 `bot-onebot/`、`bot-weixin/`、`focus-mode/` 等现有插件目录，主仓用一个 `plugins` gitlink 引用确定提交。仓根的 README、CI、许可和 Git 元数据位于单插件目录之外。建仓、切换和验证状态以 ITER-073 与对应 PR 为准。

## 决定

### 源码托管与产品组成

1. 第一阶段只改变源码托管位置。保留插件 ID、包名、公开 exports、HTTP 路径、Manifest 版本和默认 Profile；`plugins/*` 仍由主仓构建，组合根继续显式注入。源码不在启动时从浮动分支下载。
2. Core、Contracts、Host Plugin API、UI Host、API Client、共享 UI、Schema、Repositories、API/Worker 与平台 Shell 本轮继续由现有所有者维护。不能为独立仓构建复制 DTO、端口或宿主业务实现。
3. `surfaces/*` 最初暂缓独立分仓。随插件规范（AVX-PLUG-002）确立，第二阶段已正式整体迁入 `Aervox-plugins` 集合仓根下的 `surfaces/*`（含 `companion-ui`、`panels-ui`、`proactive-ui`、`workbench-ui`），复用主仓既有 `plugins` 子模块挂载于 `plugins/surfaces/*`，保留既有 31 次历史提交；其受信构建属性和 `UISurfaceManifest` 第一方界面责任保持，不作为 `.aervox-plugin` 声明式包分发。
4. 保持源码现有 AGPL-3.0-or-later、文档既有许可及第三方版权；提取时补齐相应 LICENSE/NOTICE 和来源说明，不将插件改用 Core 的 Apache-2.0。按 `plugins/` 过滤保留历史和真人作者；过滤不能完整追踪更早从其他目录移动而来的历史，需记录原仓入口和基线，不宣称保留了所有跨路径历史。

### 已接受的合同差量

本决定修订 [ITER-026](../../../plan.md#iter-026) 原先不允许 `focus-mode` 成为 submodule 的源码托管限制：允许 `plugins/` 集合仓在原路径固定挂载，仍随主仓构建。[ADR-016](ADR-016-base-boundaries.md#cr-060) 的 P0、默认构建、依赖方向及宿主数据责任继续有效；学习事实、仓储和复习排期保持主仓所有权。

[能力组合合同](../capability-composition.md) 中 `modules/*` 指向已裁决为自选交付的非核心模块。本轮保留 `plugins/<id>`，不把源码迁仓等同于能力转为自选，也不宣称 `modules/*` Resolver 已经实现。第三方执行、Page Token、运行期升级与独立 UI 开放仍分别由既有 ITER-019/006/005/056 验收。

### 子模块与构建准入

[产品子模块脚本](../../../scripts/core-submodule.mjs) 登记受审查的产品源码依赖，绑定路径、固定远端、预期包集合和构建用途；Git 索引中的 gitlink 是代码提交真源，不另建手工 SHA 锁。`reference/` 不自动成为产品依赖。

标准构建需要登记的 `packages/core` 和 `plugins`，缺失、冲突、错误版本或无效 checkout 必须明确失败，不能用 warm cache 或旧 `dist` 掩盖。workspace 发现、架构扫描、依赖审计、受跟踪文件卫生检查、清理保护和文档链接检查都覆盖集合仓真实内容。嵌套子模块保持拒绝；未声明的其他目录不能因通用递归而取得产品身份。

裸 `plugins` gitlink 变化不会报告每个子文件，需要显式覆盖所有插件包、实际宿主消费者、UI、分发包和集市输入。第一版可保守触发全量代码及插件分发检查；不能只选三个 workspace 包而遗漏六个声明式目录。用真实 Turbo dry-run 和实际声明变化反例证明覆盖，而非仅断言过滤字符串。

完整宿主 CI 精确初始化登记产品，DSH 等参考夹具只在必要 job 初始化。独立插件仓的治理文件必须被识别为仓库级元数据；任何未来单插件仓的元数据分类需要单独验证，不能普遍忽略隐藏文件。

### 两仓开发与兼容验证

短期目标是独立托管和可重复的宿主内开发，不宣称插件仓单独 `pnpm install` 已可用。插件仓 CI 固定一个公开、可获取的宿主 SHA，检出宿主和 Core，再把待测集合仓提交挂载到宿主 `plugins/`；在临时索引登记候选 gitlink，随后只在宿主根按根锁文件安装、构建和测试。README 应提供同一工作流，不能让开发者手工改两份类型或在各插件目录安装依赖。

集合仓根第一阶段不建立第二套安装或构建权威。若增加治理用 `package.json` 或其他工具配置，必须显式界定用途，不将仓根误纳入宿主 workspace、不改变预期插件包集合，也不绕过宿主根锁和依赖审计。

迁仓初始保持依赖声明不变，因此两仓对相同根锁输入可冻结安装。未来插件变更若增加依赖或更改安装输入，先推送可获取的插件候选 SHA，再在宿主集成 PR 的同一提交原子更新候选 gitlink 与匹配根锁；插件 CI 通过显式输入固定该宿主集成提交，验证候选插件 manifest 与根锁配对。宿主集成提交可以来自尚未合入的兼容分支，不先单独合入只匹配未来插件的根锁；向后兼容的 SDK 准备可提前独立交付。

配对检查通过后，先合入插件 PR，再将宿主 gitlink 更新到子仓最终合并 SHA，核对文件树及依赖输入不变并复验，最后合入宿主 PR。宿主测试 SHA 通过 CI 参数或外部配对记录传入，不在插件提交中硬编码一个反向引用自身候选的宿主提交，以免形成循环。禁止为消除失败默默非冻结安装。宿主与插件的源码、锁文件、配置及测试 SHA 配对保存在 CI/PR；CI 启动失败和依赖不兼容必须可见。

`ServerPluginRegistration` 目前没有独立代码 SDK 的版本协商。声明包 `requires.hostApiVersion` 不能替代 TypeScript 编译和真实宿主合同测试；先验证最低支持宿主与目标宿主的明确配对，不承诺任意主线版本兼容。SDK 分离或 npm 发行若成为实际需求，再独立决定其版本政策。

### 分发、生命周期与数据

批量[分发脚本](../../../scripts/export-plugins.mjs)、[内置插件 HTTP 导出](../../../packages/host-runtime/src/modules/ecosystem/plugins/package-bundle.ts)与集市就地安装统一声明资源边界，修正内置 HTTP 导出原先递归读取全部出厂插件源码的差异。验证源码、依赖、仓库元数据、构建产物与凭据不进入分发包；未知条目、符号链接和越界资源按合同拒绝。已安装 generation 的原始归档原样导出分支保持原义，不能重打包改变历史 checksum。

集合仓根元数据不应被误认作插件，单插件目录新增资源必须继续显式分类。LICENSE/NOTICE 等许可材料哪些应随声明资源分发，须与包校验合同一起决定；不能为通过打包而一概忽略许可文件。比较迁移前后分发内容及字节差异，现有 HTTP 导出多打内容的修复应记录为批准的差异，不要求继续产出错误归档。

以下责任不随仓库改变：

- 第一方代码仍是受信编译输入；`.aervox-plugin` 仍为声明和资源，不获得执行 TypeScript/Vue 的能力，也不构成 OS 沙箱。
- 宿主持有模型调用、执行账本、授权/取消、幂等/fencing、连接凭据、数据库、数据权利和恢复责任。插件版本不能放宽这些门禁。
- 缺少源码、运行停用、撤权和显式卸载是不同操作；缺包不删除配置、Secret、授权历史或业务数据，恢复代码不恢复已撤销授权或覆盖用户启停选择。
- 包导出、业务数据导出和卸载清理分别验收。缺包后仍有数据管理入口是责任要求，不能以旧物理移除演练推定所有插件已完成；发现实际缺口则先闭合再迁出对应插件。
- [ADR-028](ADR-028-plugin-atomic-activation.md) 的资源代际/原子激活不等于 Git 源码升级回退。gitlink 回退必须恢复配对根锁与宿主兼容版本，且不回滚用户数据库或悄悄执行配置降级。

## 后果与回退

集合仓增加一次跨仓审查和固定版本更新，但当前不承担九套独立仓库的治理成本；各插件 Manifest 仍可独立演进。单仓内方便的跨包原子变更变为配对 PR，宿主仍是接口和集成裁决者。

迁移先保留并验证公开可获取的历史，再通过主仓 PR 将普通目录替换为 gitlink。本批冻结提取 `119dbf2067337153724830094fc304e096bfdf28` 的 9 个插件，不等待或捎带尚未合入的 FlowCampus PR #347；其后续交付须重基到新的集合仓边界，分别提交插件源码与主仓集成。切换前再次核对主线及并行 PR，禁止让旧目录分支合并覆盖 gitlink，也不将活跃工作树纳入提取。

源代码缺席演练应在隔离克隆中显式构造不装配该插件的测试组成，移除其包依赖和组合根；默认登记产品不能靠删除目录绕过准入。演练后验证 gitlink、HEAD 与文件恢复，保留默认产品 P0 的独立验收，不把测试裁剪当成正式裁剪 Profile。

迁出失败时，首次接入可经主仓回退 PR 恢复迁出前树和原锁；后续回到已验收的集合仓提交及其配对锁。都应保留原始仓库、历史与校验记录，不通过复制第二份长期实现回退。回退无需业务数据库换库，也不恢复旧授权；若出现配置格式变化，则先满足既有升级合同，不能只回退源码。

## 验证与证据

决定已接受，迁移完成仍须由验证证据确认。必须分别取得迁移前树与许可清单、候选仓历史来源、真实公共接口编译、插件与宿主测试、分发包安全和可重现性、缺失/错 SHA/旧缓存拒绝、缺席与恢复的数据权利、取消撤权、两仓公开冷检出、根冻结安装、全量与精确提交远端 CI，以及 Git 回退的证据。Bot 真实账号、原生移动接线、Page Token 与正式发布继续单列。

本轮按已接受范围实施，建仓、gitlink、两仓兼容与冷检出验证分别记录在 ITER-073 及对应 PR；未取得的验证不计为通过。
