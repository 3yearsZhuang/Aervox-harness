# 仓库卫生与代码质量审计 · 2026-10-13

本次审计发现 **14 项需要处置的问题：1 项 P1、10 项 P2、3 项 P3**。其中包括 9 项通过隔离实验复现的行为缺陷、1 项静态确认的门禁覆盖缺口、1 项依赖告警治理问题，以及 3 项死代码、过时残留和重复维护问题。现有全量代码、文档及补充集成测试均通过，说明这些缺陷主要位于现有断言没有覆盖的路径。

最先应修复桌面端会话 ID 丢失，然后处理会话写入失败反馈、录音取消、配置选择、技能所有权和进程退出。重复实现已经把同一个配置选择错误复制到四份仓储，也使三套 ZIP 入口的资源限制不一致。已确认 7 个无调用函数，但没有足够证据宣布某个整文件或整个包可以删除。

第 1～7 节保留整改前审计快照；用户授权后的实现与验证见第 8 节，原位置行号对应基线提交。协同状态只维护 [plan.md](../../plan.md#iter-060)；行为变化同步现有合同。

## 1. 基线、范围与方法

| 项目 | 本次口径 |
|---|---|
| 日期 | 2026-10-13，Asia/Shanghai |
| 审计提交 | `511f9d1ed8da263855dd4337cd1beb4680dc6bdd` |
| 来源分支 | `feat/plugin-lifecycle-reliability`，审计开始时工作区干净 |
| 与本地远端引用的关系 | `origin/main` 当时为 `151c36bf4a47859ea8f3dc5e5aefd85ac27ca9b8`；审计包含其后插件生命周期提交，不能称为远端 main 审计 |
| 原审计工作分支 | `docs/repository-hygiene-audit-2026-10-13`；后续授权整改转入 `fix/repository-hygiene`，见第 8 节 |
| 工具链 | 经 mise 使用 Node 24.21.0、pnpm 11.22.0；Rust 版本由 `mise.toml` 锁定 |
| 文件边界 | `git ls-files` 的主仓文件；8 个 reference 子模块只核对引用与构建接线，不把第三方源码计入主仓质量指标 |
| 人工检查方式 | 全仓清单、导入图、克隆与残留扫描，再按风险追踪真实调用链、测试断言与权威合同；不是逐行形式化证明 |

扫描覆盖 `apps/`、`packages/`、`plugins/`、`scripts/`、`native/`、两套 E2E、工作流、工具配置与文档导航。深查路径包括会话 UI → 传输 → Electron IPC、录音生命周期、预设仓储、技能安装与注册表、stdio Adapter、Worker 停机、压缩包处理及 CI 调度。

CLI 补跑真实 API 与文件 SQLite 集成，Web 补跑 Chromium E2E。Native 核查 Cargo 模块/平台选择并运行现有 Rust 与主管测试；没有进行 Windows/Linux 实机、Electron 安装包、移动实机、真实模型、生产迁移、长时间压力或外部渗透测试。Contracts、Schema、Config、Observability 等包有全仓扫描和现有门禁证据，但不声称其每个业务分支均已人工深审。

本报告没有扫描 Git 全历史密钥，也没有把文本级 `tenant`、`any`、长文件或零引用导出直接判成漏洞/死代码。公开 API、动态注册、测试夹具、历史兼容迁移和按平台编译的实现分别核查。

### 1.1 仓库规模

基线共 **1,628 个 Git 条目**：1,620 个普通文件、8 个子模块；**27 个 workspace 包**。下表源码口径限定为上述业务与脚本目录下的 `.ts/.tsx/.vue/.rs/.mjs/.cjs/.js/.sh`，排除 `.d.ts`、压缩第三方 JS 和 vendor 路径。行数含注释、空行，Vue 含模板和样式，不等于逻辑代码行数。

| 区域 | 文件数 | 行数 | 独立测试文件数 | 独立测试行数 |
|---|---:|---:|---:|---:|
| apps | 309 | 55,408 | 105 | 22,262 |
| packages | 597 | 92,818 | 178 | 27,993 |
| plugins | 79 | 16,556 | 18 | 2,481 |
| scripts | 50 | 7,685 | 15 | 2,009 |
| native | 16 | 1,811 | 0 | 0 |
| e2e | 8 | 1,305 | 8 | 1,305 |
| e2e-ui | 5 | 356 | 5 | 356 |
| 合计 | **1,064** | **175,939** | **329** | **56,406** |

Rust 内联 `#[test]` 包含在 native 行数中，“独立测试文件 0”不表示没有 Rust 测试。总量包含 641 行生成的 Native 协议文件；克隆与死代码判断排除生成代码。独立 CSS、HTML、JSON、SQL、根启动脚本及资源文件参与清单/接线检查，但不混入这张行数表。

### 1.2 重复与引用扫描

| 扫描 | 结果 | 如何解释 |
|---|---|---|
| 函数克隆扫描 | Babel 成功解析 716 文件，0 解析错误；2,102 个至少 6 行且至少 60 token 的函数；19 组跨文件克隆候选 | 忽略注释并归一化标识符；包含父函数与嵌套函数重叠，不是重复率，也不是 19 个独立缺陷 |
| 导入图 | 1,040 文件，0 解析错误 | 含测试，追踪静态 import/export、字面量动态 import 与 require，再人工补充包出口、别名、HTML 和动态 UI 注册 |
| 导出文本初筛 | 578 个导出无外文件同名文本引用，其中 24 个运行时导出仅出现定义 | 绝大部分属于公开 API、类型或 Schema；不能直接批量删除 |
| 人工确认死函数 | 7 个，共 44 行函数声明及函数体 | 见 HYG-12；独占导入与再导出另行核对 |
| 空条件残留 | 32 处 `and()`、14 个仓储文件 | 见 HYG-13；是可读性问题，不代表应恢复租户过滤 |

## 2. 发现总表

P1 表示应优先修复的核心行为错误；P2 表示明确缺陷或需要安排的风险治理；P3 表示低风险清理和维护改善。优先级不是依赖公告的 CVSS 等级。

| 编号 | 优先级 | 发现 | 证据类型 |
|---|---|---|---|
| HYG-01 | P1 | 桌面端丢弃调用方会话 ID，多会话发送归入默认会话 | 源码链路＋隔离复现 |
| HYG-02 | P2 | 会话创建/重命名/删除失败仍返回本地成功状态 | 源码链路＋HTTP 失败模拟 |
| HYG-03 | P2 | 延迟麦克风授权可越过取消；工作台卸载缺少录音清理 | 延迟授权复现＋卸载接线检查 |
| HYG-04 | P2 | 四份预设仓储复制 `LIMIT 50` 错误，读写非激活配置 | 临时 SQLite 复现＋四实现对照 |
| HYG-05 | P2 | 同名本地 Skill 导入可改写只读插件技能注册 | 临时 SQLite/目录复现 |
| HYG-06 | P2 | Adapter 握手拒绝后子进程仍存活 | 子进程复现 |
| HYG-07 | P2 | Adapter 提前结束迭代未清理超时，之后误杀驱动 | 子进程复现 |
| HYG-08 | P2 | Worker stop 不等待在途任务，入口随即关闭数据库 | 屏障任务复现＋入口追踪 |
| HYG-09 | P2 | 三套 ZIP 实现资源边界分裂，Skill/Persona 同步无展开预算 | 有界压缩样本复现＋源码对照 |
| HYG-10 | P2 | UI E2E 与启动脚本未进入 CI 触发/执行覆盖 | 工作流解析与任务链检查 |
| HYG-11 | P2 | 锁文件依赖存在 55 条告警记录，缺少持续审计入口 | pnpm audit，非利用证明 |
| HYG-12 | P3 | 7 个已无调用函数及独占导入残留 | 引用图＋模板/装配人工核查 |
| HYG-13 | P3 | 去租户化后空条件、旧术语和 E2E 旧请求头残留 | 精确扫描＋当前合同对照 |
| HYG-14 | P3 | 构建拆包策略与守卫遍历器重复维护 | AST 克隆＋调用范围对照 |

## 3. 已复现行为缺陷

### HYG-01 · 桌面端丢弃当前会话 ID

**位置**：[desktop-transport.ts](../../packages/api-client/src/desktop-transport.ts) 115–123 行；[preload API](../../apps/desktop/src/preload/domains/aervox-api.ts) 29–56 行；[桌面主进程](../../apps/desktop/src/main/index.ts) 650–673 行。调用方[工作台组件](../../plugins/workbench-ui/src/AervoxWorkbench.vue) 337 行传入 `activeSessionId`。

`desktopTransport.streamTurn` 将第一个参数命名为 `_sessionId` 并丢弃；桥协议没有传递该字段，主进程改用 `resolveDesktopSessionId(env)`，通常得到 `desktop_default`。在会话 A、B 间切换后，发送请求仍落到同一个后端会话，历史与项目上下文无法按所选会话区分。

**复现**：内存打包真实传输源码，用记录入参的 bridge 分别执行 `streamTurn('ses_A', ...)`、`streamTurn('ses_B', ...)`，两次桥参数的 `sessionId` 均为空。既有 [desktop-transport.test.ts](../../packages/api-client/test/desktop-transport.test.ts) 使用 `session_ignored`，没有断言会话透传。

**建议与验收**：把会话 ID 贯通 typed IPC，并在主进程校验；缺省值仅用于确实未提供的场景。增加跨 bridge 的双会话断言，确认后端 URL、历史和项目关联分别落在 A/B。该问题是实际功能接线错误，不能靠删除 `_sessionId` 参数解决。

### HYG-02 · 服务端写失败被本地成功状态掩盖

**位置**：[useAervoxSessions.ts](../../packages/api-client/src/useAervoxSessions.ts) 116–129、160–174、179–198 行；[会话侧栏](../../packages/ui/src/components/workbench/WorkbenchSidebar.vue) 184–205 行。

创建失败后生成虚拟会话；重命名失败后仍改本地对象并返回对象；删除失败后仍移除列表项并返回 `true`。调用 UI 主要依赖 `catch` 展示错误，未消费这里的 `sessions.error`，因此操作完成的表象与 SQLite 真源不一致。刷新后旧名称/会话可能重新出现，删除尤其容易被用户误解为已完成。

**复现**：传输固定抛 `HTTP 503`，rename 返回标题 `changed`，delete 返回 `true` 且列表移除了 `ses_A`，同时内部 error 为 `HTTP 503`。

**建议与验收**：统一成功/失败返回合同，保存成功再落本地状态，或显示可回滚的 pending/失败状态；不要无提示制造“成功降级”。复用 [useAervoxProjects.ts](../../packages/api-client/src/useAervoxProjects.ts) 的失败表达经验，验证 401/503、断连、刷新后的状态，以及新建失败后的发送行为。

### HYG-03 · 录音启动不感知取消，卸载不收回资源

**位置**：[voice-input-recorder.ts](../../packages/api-client/src/voice-input-recorder.ts) 49–89 行；[useWorkbenchComposer.ts](../../packages/ui/src/composables/useWorkbenchComposer.ts)；[工作台组件](../../plugins/workbench-ui/src/AervoxWorkbench.vue) 516–526 行。

`start()` 等待 `getUserMedia` 后直接启动资源，直到末尾才置 `isRunning=true`；授权尚未返回时 `stop()` 因 `isRunning=false` 直接退出。另一个缺口是 Composer 没有 scope dispose，工作台卸载只清附件，没有停止录音及其后续转写。

**复现**：延迟权限 Promise，执行 start → stop → grant，实际得到 `activeAfterStop=true`、`tracksStopped=0`。此实验没有使用真实麦克风；卸载后的资源风险另由调用链确认。现有 [voice-input.test.ts](../../packages/api-client/test/voice-input.test.ts) 主要验证构造，缺少生命周期断言。

**建议与验收**：引入 starting/running/stopped 及代次/取消判定；迟到的授权立即关闭 track，启动失败在 finally 释放已分配资源。scope dispose 应停止采集并取消转写，明确“用户停止并提交最后片段”和“组件卸载丢弃片段”的区别。覆盖延迟授权、连续点击、授权后初始化失败和切换界面。

### HYG-04 · 重复的预设仓储共同读写错误配置

**位置**：仓储 [LLM](../../packages/repositories/src/repositories/sqlite/llm-config-repository.ts) 39–51 行、[本地语音](../../packages/repositories/src/repositories/sqlite/voice-config-repository.ts) 36–48 行、[语音输入](../../packages/repositories/src/repositories/sqlite/voice-input-config-repository.ts) 39–51 行、[远程语音](../../packages/repositories/src/repositories/sqlite/voice-remote-config-repository.ts) 43–55 行。

四处都先按创建时间升序取前 50 条，再在内存找激活项，找不到就用第一条。创建接口没有 50 条上限，因此第 51 条以后即使成功激活，读取也可能回退到第一条；`saveConfig` 接着修改错误记录。`updatePreset`、`activatePreset`、`deletePreset` 还具有同形生命周期实现，容易复制同类缺陷。

**复现**：临时 SQLite 创建 51 项，用确定时间排序，激活最后一项后读取并保存：

```json
{
  "presetCount": 51,
  "expectedActiveModel": "model-50",
  "getConfigModel": "model-0",
  "saveModifiedActivePreset": false,
  "activeModelAfterSave": "model-50"
}
```

**建议与验收**：SQL 明确查询激活项，并定义无激活项时的稳定回退。保留四种配置的字段与事务责任，共享预设选择/激活/删除机制；同一组测试分别覆盖四种仓储的 51 项、无激活项、删除激活项与更新目标。不要用新增 UI 上限掩盖已存数据的问题。

### HYG-05 · 只读插件 Skill 可被同名本地安装改写

**位置**：[skill-manager.ts](../../apps/api/src/modules/ecosystem/skills/skill-manager.ts) 129–179 行；[skill-registry-repository.ts](../../packages/repositories/src/repositories/sqlite/skill-registry-repository.ts) 42–64 行；入口为 `POST /v1/skills`。

本地安装只检查 `<skillsRoot>/<name>` 是否存在，没有检查同名注册记录。插件技能位于不同的插件子目录，因而文件路径检查不能保护其注册身份。注册表遇到同 ID 就更新元数据，同时保留旧 readonly/pluginId，使本地 ZIP 替换插件技能的读取路径与正文。

**复现**：临时目录/数据库中登记插件只读技能，再安装同名本地 ZIP，不传 overwrite，安装成功，读回 `readonly:1, source:"local", pluginId:"plugin-x"` 与本地替换正文。

**建议与验收**：写文件前检查注册身份、readonly 和 owner，拒绝跨 owner 覆盖；明确全局唯一名称冲突如何返回，不因文件路径不同绕过保护。保持[插件契约](../reference/plugin-config-and-pages.md)现有命名要求，若改变 ID/命名空间则单独评审迁移。覆盖本地/插件互相冲突、overwrite 两值、失败后的原内容与注册表不变。

### HYG-06 · 握手失败未清理 Adapter 子进程

**位置**：[stdio-adapter.ts](../../packages/host-agent/src/stdio-adapter.ts) 101–130、161 行；实际 API 经 [dsh-adapter.ts](../../apps/api/src/modules/companion/conversation/dsh-adapter.ts) 使用该实现。

`await handshake()` 失败直接抛出，缺少 kill/readline/listener 清理，调用方尚未取得 close 句柄。源码注释及测试名称声称“失配 kill”，但现有测试只断言 rejection。

**复现**：模拟 Adapter 的 SHA 与预期不一致，收到 `adapter_admission_failed: sha_mismatch`，子进程仍为 `killed:false, exitCode:null`。实验进程随后已手动清理。

**建议与验收**：把握手成功前的进程所有权保留在工厂，任何拒绝、EOF、超时均执行有界清理；测试除异常外断言实际退出和资源释放。防止连续准入失败累积孤儿进程。

### HYG-07 · 迭代提前退出留下会误杀驱动的超时

**位置**：[stdio-adapter.ts](../../packages/host-agent/src/stdio-adapter.ts) 213–235 行。

超时只在迭代正常完成后 `clearTimeout`，finally 仅删 streams。消费者在首个 delta 后 break、主动 return 或错误退出时，旧超时仍会 kill 子进程并设置 closed，影响之后的请求。

**复现**：消费第一个 delta 后结束迭代，等过旧 request timeout，再执行新请求，得到 `adapter_unavailable`。

**建议与验收**：计时器在 finally 无条件清理；请求取消、驱动禁用与进程终止的责任分别明确。验证 break、return、协议错误后旧计时器不会影响后续请求。可与 HYG-06 在同一生命周期修复中处理，但两个触发条件应保留独立断言。

### HYG-08 · Worker 停机先关闭依赖，未等待在途任务

**位置**：[worker-host.ts](../../apps/worker/src/worker-host.ts) 517–546 行；[Worker 入口](../../apps/worker/src/index.ts) 223–234 行。

stop 只停止未来调度、清定时器和 IPC，没有等待 `isTaskRunning` 对应任务。入口 await stop 后立即关闭两个数据库并 `process.exit(0)`。SIGTERM 到达任务执行窗口时，任务可能访问已关闭连接或被中断，不能把日志中的正常退出等同于工作已完成；这里只证明生命周期缺口，不宣称必然数据库损坏。

**复现**：用屏障阻塞一个 job，等待它开始后调用 stop，返回时任务仍未完成：`stop returned while job unfinished: true`。

**建议与验收**：记录在途 Promise，停接新任务后 bounded drain，截止后按任务的取消/恢复合同收敛，再关闭依赖。覆盖在途写入、任务永久挂起、重复 stop 和退出码。此项延续 [ITER-013](../../plan.md#iter-013) 的 drain 未完成范围，不再创建平行队列。

### HYG-09 · 三套 ZIP 处理产生不同的资源边界

| 路径 | 当前机制 | 差异 |
|---|---|---|
| [skills/zip.ts](../../apps/api/src/modules/ecosystem/skills/zip.ts) 71–143 行 | 自行解析 ZIP，133 行 `inflateRawSync` | 无累计展开/单条目/条目数业务预算，同步占用 API 事件循环；解压后才核对尺寸 |
| [persona/bundle.ts](../../apps/api/src/modules/companion/persona/bundle.ts) 138、165、215 行 | `fflate.unzipSync`，还展开嵌套 Skill ZIP | 同步解压，未传入展开过滤预算 |
| [plugins/archive-worker.ts](https://github.com/3yearsZhuang/Aervox-harness/blob/511f9d1ed8da263855dd4337cd1beb4680dc6bdd/apps/api/src/modules/ecosystem/plugins/archive-worker.ts) 14–80 行 | Worker、展开过滤、并发限额、10 秒截止和取消 | 已有独立资源控制，不能据此宣称另外两个入口也受保护 |

**复现**：Skill 解包接受 8,308 字节的合法压缩样本，展开为 8,388,608 字节；样本有界，未执行内存耗尽攻击。HTTP 压缩请求体上限无法约束这种展开倍数。Persona 差异由源码确认，没有另行进行大包压力实验。

**建议与验收**：在中立模块提供共享归档解析/预算执行能力，各领域声明自己的允许内容、限额和嵌套预算。先检查预算再分配大输出，使用受控异步执行，保留路径规范化和格式兼容。覆盖高压缩比、伪造尺寸、重复路径、嵌套包、取消及并发拒绝；不要让 Persona 直接依赖插件业务模块来复用工具。

## 4. 验证入口与依赖治理

### HYG-10 · 本地测试存在，但 CI 没覆盖对应入口

**位置**：[ci.yml](../../.github/workflows/ci.yml) 8–51、148–151、157–226 行；[package.json](../../package.json) 的 `test:e2e:ui`；[mise.toml](../../mise.toml) 的 `ci-code`。

工作流路径过滤未包含 `e2e-ui/**`、`playwright.ui.config.ts`、`aervox`、`run-cli`、`siyu-chat.command`。调用仓库自己的 `readWorkflowPaths` 与 `matchesGlob`，上述代表路径在 pull_request/push 均返回 false。现有主 CI 执行 API E2E，但不执行 UI E2E；API E2E job 仍为 `continue-on-error: true`。

因此只改 UI 测试/配置或根启动脚本不会触发代码工作流；即使业务改动触发主 CI，四项浏览器回归也不会自动运行。本次手动运行 4 项并通过，证明入口可用，不能证明它已成为持续门禁。API E2E 的非阻断属于已写明的观察期策略，本次没有擅自认定必须立即提升为阻断。

**建议与验收**：补触发路径，添加独立的 UI E2E job 及浏览器安装；将触发路径和实际 testDir/配置纳入 `ci-scope` 测试。根启动脚本至少具备语法/调度回归。结合稳定性证据决定 API E2E 是否结束观察期。验证只改每一个入口文件时工作流均被选择，并记录 UI E2E 的执行结果。

### HYG-11 · 依赖审计产生 55 条记录，未纳入持续验证

`mise exec -- pnpm audit --json` 退出 1，返回 **55 条记录、39 个不同 GHSA**：critical 2、high 29、moderate 20、low 4。记录按包/版本范围拆分，不能描述为 55 个独立可利用漏洞。统计对应本次 registry 响应，会随公告更新。

| 优先核查依赖 | 检出版本 | 告警与适用条件 |
|---|---|---|
| Vitest | 4.0.18 | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)，critical，涉及启动 UI server；默认 `vitest run` 不等于已触发该路径。另有公告要求至少 4.1.11 |
| shell-quote | 1.10.0 | [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)，critical，来自 `drizzle-kit` → `gel` 开发工具链；公告修复下限 1.11.0 |
| Fastify | 5.12.1 | API 运行依赖，多项 high/moderate；此次公告集合的修复下限至 5.12.5，仍需核实具体配置与路径 |
| `drizzle-orm` | 0.39.3 | [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)，high，标识符转义；公告修复下限 0.45.2，不等于仓库已存在可控 SQL 标识符输入 |
| Electron | 43.4.1 | [GHSA-qmv3-fv6v-rmhq](https://github.com/advisories/GHSA-qmv3-fv6v-rmhq)，high；虽然包列在 devDependencies，却会形成实际桌面运行时，不能因 dev 标签忽略 |
| fflate | 0.8.2 | [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98)，moderate；压缩包是实际业务路径，公告修复下限 0.8.3，与 HYG-09 一并核查 |
| fast-uri、qs、Vue server-renderer 等 | 见证据快照 | 需区分解析/校验/SSR 路径是否可达；浏览器使用 Vue 不自动证明 SSR 公告可利用 |

[证据快照](../_meta/repository-hygiene-audit-2026-10-13.json)保留全部 55 条精简记录、GHSA、检出版本、公告修复范围和代表依赖路径。修复范围来自公告，不是已经验证可升级的目标版本。

当前 package/mise/工作流没有依赖审计步骤。建议拆分直接运行依赖、桌面运行时与构建工具的升级，先验证可达路径及兼容性，再锁定新版本；建立能区分已评估例外的审计入口。不要直接执行自动修复、跨大版本升级或把所有传递依赖强行 override。本次未更改锁文件，也未证明公告可在部署中利用；RustSec 依赖公告扫描未执行。

## 5. 死代码、过时残留与维护性重复

### HYG-12 · 7 个已无调用函数

以下核查包含 Vue 模板、测试、宿主装配和包出口，不仅是文本初筛。共 44 行函数声明及函数体；独占导入和再导出应在删除时一起复核。

| 文件与行 | 函数 | 依据与删除前条件 |
|---|---|---|
| [config-schema.ts](../../apps/api/src/modules/ecosystem/plugins/config-schema.ts):214 | `resolveI18n` | 只定义；实际 UI 使用 panels 的 localize。删除后不能让 UI 反向依赖 API 来“统一”本地化 |
| [gpt-sovits.ts](../../apps/api/src/modules/platform/voice/gpt-sovits.ts):288 | `voiceReferenceFingerprint` | 无生产/测试消费；voice barrel 通配再导出，先确认不承诺外部 API；createHash 仅服务此函数 |
| [proactive/routes.ts](../../apps/api/src/modules/proactive/proactive/routes.ts):82 | `validDistillationStatus` | 模块内部未调用，对应类型导入仅供此函数 |
| [proactive-source-adapters.ts](../../apps/desktop/src/main/proactive-source-adapters.ts):1376 | `createProactiveCapabilityProbe` | 当前 main 124 行自行装配，额外处理来源；删除前以实际装配为准 |
| [配置字段组件](../../plugins/panels-ui/src/plugin/PluginConfigFieldInput.vue):54 | `onInputChange` | 模板 137 行已内联 |
| 同文件 57 行 | `onTextChange` | 模板 144 行已内联 |
| 同文件 60 行 | `onNumberChange` | 模板 150 行已内联 |

**建议与验收**：按所属包小批删除，运行对应类型检查与已有测试，保留行为快照；无需先做大规模架构重构。新增 unused 检查宜从内部模块开始建立可审阅基线，不应依据导出扫描一次性删 578 项。

复核命令：

```sh
git grep -n -E 'resolveI18n|voiceReferenceFingerprint|validDistillationStatus|createProactiveCapabilityProbe|onInputChange|onTextChange|onNumberChange' -- apps packages plugins scripts
```

### HYG-13 · 去租户化后的空过滤器与过时说明

仓储中仍有 **32 处空 `and()`、分布于 14 文件**，四份配置仓储各 4 处。例如 [LLM 仓储](../../packages/repositories/src/repositories/sqlite/llm-config-repository.ts) 44、92、158、189 行。空条件实际表示全实例操作，保留层层 `.where(and())` 容易误导读者认为存在过滤责任。

同文件 6 行还写“同租户”和旧 `tenant_active_idx`，40 行使用 `tenantRows`。[playwright.config.ts](../../playwright.config.ts) 11–14 行仍注入 `x-workspace-id` / `x-user-id` 测试头；现行本地上下文不依赖这些头。不要把带旧头的用例通过理解成验证了隔离。

`src` 中 `tenant/tenantRows/tenantA/tenantB` 的宽泛文本统计为 836 次、62 文件，含历史说明、变量和其他字符串，**不是 836 处租户逻辑或漏洞**。全部空条件位置保存在证据快照。

**建议与验收**：删除无意义过滤层，改成表达本地单用户语义的变量和注释，清除不承担兼容断言的 E2E 请求头。保留已命名索引、历史迁移、兼容测试与持久化格式，除非另有迁移授权；尤其不能从此项推导出恢复租户过滤的任务。

### HYG-14 · 构建和守卫内部存在重复维护点

| 重复点 | 位置 | 判断与建议 |
|---|---|---|
| `manualChunks` | [Electron Vite 配置](../../apps/desktop/electron.vite.config.ts):34 与 [Web Vite 配置](../../apps/web/vite.config.ts):18 | 19 行、78 token 完全相同；可共享构建辅助函数，验证两端产物与入口加载 |
| `collectSourceFiles` | [禁用标识符守卫](../../scripts/check-banned-identifiers.mjs):44 与 [导入边界守卫](../../scripts/import-boundary.mjs):250 | 函数体 156 token 相同；与 host-domain-purity 内部 walk 也有克隆 |
| 守卫内部 walk | 上述两处及 [宿主纯净性守卫](../../scripts/check-host-domain-purity.mjs):143 | 110 token 同形；默认根目录、扩展名、排序并不完全相同，应共享参数化机制，保留策略差异 |

这几项是确定的维护重复，尚未证明造成运行错误。优先级低于 HYG-04 的错误复制与 HYG-09 的预算差异。重复的几行 Vitest 配置属于声明性包装，不建议为了减少行数引入复杂抽象。

### 5.1 维护热点，不单独计为缺陷

| 非生成文件 | 行数 | 后续审查重点 |
|---|---:|---|
| `scripts/worker-write-contention-drill.mjs` | 1,852 | 演练编排、采样与报告责任，保留作为证据工具的完整性 |
| `packages/repositories/src/sync/p2p-transport.ts` | 1,748 | 协议状态、重试、资源释放与安全回归 |
| `packages/repositories/src/sync/p2p-changeset.ts` | 1,547 | 变更选择、校验与应用边界 |
| `packages/contracts/src/openapi.ts` | 1,458 | 手工注册与 Schema 真源的对应关系，不按长度直接拆分 |
| `apps/desktop/src/main/proactive-source-adapters.ts` | 1,383 | 平台实现与来源生命周期 |
| `packages/repositories/src/repositories/sqlite/learning-repository.ts` | 1,317 | 查询投影、统计与写入责任 |
| `apps/desktop/src/main/index.ts` | 1,313 | IPC、窗口、采集与退出编排，优先围绕 HYG-01 补跨层测试 |
| `plugins/panels-ui/src/llm/ModelRuntimePanel.vue` | 1,000 | 异步操作、轮询、错误和资源状态 |

建议随着具体修复抽离责任，不把“大文件”当作必须重写的证据。全仓已有 strict TypeScript、边界和可移除守卫，当前未配置通用死代码/克隆棘轮；可先对内部 unused 符号和新增重复建立增量基线，再决定工具，避免大规模误报阻断工作。

### 5.2 不应直接删除的内容

- 公开的 Contract Schema、`TEXT_ONLY_STEP`、`deleteMemoryFts`、`serializeSnapshot`、`performP2PSyncExchange`、`findLive2DModelCatalogEntry`：内部零消费不能替代公开 API 支持期判断。
- [P2P 配对](../../packages/repositories/src/sync/p2p-pairing.ts) 905/927/979 行的 deprecated 握手仍有安全测试及[兼容说明](p2p-local-sync-exploration.md)，默认 fail closed；须先取消兼容合同再删除。
- Native Windows/Linux 模块按 `cfg` 选择；Rust vector pilot 在 mise check/benchmark 有入口；TS/Rust Top-K 的对照用于独立性能验证，不属于生产责任重复。
- `@aervox/live2d`、`@aervox/public` 通过 Turbo 依赖边恢复资源；两者 `cache:false` 有跨目录产物责任，不能作为“缓存没开”卫生问题直接修改。
- Vue 动态组件、UI surface 注册、`declare global` 类型文件、Capacitor CLI 和 mobile → web 构建依赖均有入口。
- proactive-ui 的 `@aervox/contracts`、`lucide-vue-next` 在包源码/测试/配置中没有直接文本消费，保留为依赖删除候选；需独立构建、类型及 peer/锁文件验证后决定，本次未计为确定死依赖。
- 已登记的 Embedding Worker 历史列/接线、Resume、迁移和发布门槛继续见[既有架构评估](architecture-implementation-review.md)及计划；未把旧审计原文复制成新的确定发现。

## 6. 验证结果与证据边界

| 验证 | 本次结果 | 限制 |
|---|---|---|
| `mise tasks run ci-code` | **退出 0**；build 27/27、typecheck 阶段 46/46、test 阶段 45/45 Turbo 任务成功；包含守卫、Rust fmt/test/clippy、Native 生命周期 smoke | 对应阶段分别复用 24、44、39 个缓存任务；任务数含依赖，不是包数或用例数；没有重跑 frozen install |
| `mise tasks run ci-docs`（原基线） | **退出 0**；22 个脚本测试通过，66 文档，Markdown/Vale/本地链接 0 错误 | 不代替远端链接可达性审计 |
| API E2E | **退出 0，45 passed** | 真实 API + 临时文件 SQLite，不使用生产数据库 |
| UI E2E | **退出 0，4 passed** | Chromium、窄窗口/界面切换/草稿/焦点；没有覆盖 Electron IPC 或真实麦克风 |
| CLI 集成 | **退出 0，2 passed** | 打包 CLI、认证 API、文件 SQLite、重启和工具审批；模型为测试环境 |
| `pnpm audit --json` | **退出 1，55 条告警记录** | registry 公告匹配，不是已验证利用；未自动升级 |
| 隔离行为实验 | **9 项行为缺陷复现** | 前端为真实源码＋模拟 bridge/HTTP/权限；仓储使用临时库；Adapter/Worker 为受控子进程/屏障，不接触用户数据 |

完整代码门禁中 Host Agent 有 1 项条件跳过，未提升为真实模型验收。日志里的预期 HTTP 错误与 Live2D fallback 不是测试失败。判断门禁成功依据命令最终退出码，不依据日志中某个通过片段。

补充验证的标准入口：

```sh
mise tasks run ci-code
mise tasks run ci-docs
mise exec -- pnpm test:e2e
mise exec -- pnpm test:e2e:ui
mise exec -- pnpm test:cli:integration
mise exec -- pnpm audit --json
```

本次两个 Playwright 命令额外传入不同的 `--output` 临时目录，避免并行运行覆盖产物。门禁日志与临时复现脚本保存在交付 worktree 的 `artifacts/repository-hygiene-2026-10-13/`，该目录不入 Git；可长期追溯的摘要、文件列表、依赖告警与复现输出见[证据快照](../_meta/repository-hygiene-audit-2026-10-13.json)。日志是本地审计证据，不是远端 CI 运行记录。

## 7. 处置顺序与验收

| 顺序 | 范围 | 可验收结果 |
|---|---|---|
| 1 | HYG-01～03 | 两个桌面会话分别写入；失败操作有一致反馈；授权迟到/卸载后没有残留采集 |
| 2 | HYG-04～05 | 四种预设的选择/更新目标正确；同名技能不能跨 owner 覆盖 |
| 3 | HYG-06～09 | 握手失败/迭代结束释放资源；Worker bounded drain；归档入口预算与取消均可验证 |
| 4 | HYG-10～11 | 工作流覆盖真实入口；依赖逐组完成可达性判断、兼容升级及锁文件验证 |
| 5 | HYG-12～14 | 小批删除 7 个函数与空条件；抽取确定重复，维持边界与现有测试 |

普通修复分别提交代码、必要回归和 PR。HYG-08 与 ITER-013 对齐；涉及技能身份迁移、归档跨模块归属或新的退出语义时先核对现有合同，仅对真正改变权威决定的部分追加 ADR。已存在的迁移与发布门槛继续由原计划/追踪基线承载。

关闭发现需要相应触发条件的回归证据，不能只引用原有全量门禁通过；删除候选需要确认公开 API/动态入口，不能只引用零引用数字。本文交付完成表示审计与文档完成，**不表示上述问题已修复或产品已具备发布条件**。

## 8. 授权后的整改记录

实施分支 `fix/repository-hygiene` 基于 `511f9d1e`，保留插件生命周期前置变更；原始主工作区未改动。整改提交 `e5316da` 见 [PR #277](https://github.com/3yearsZhuang/Aervox-harness/pull/277)，以 `feat/plugin-lifecycle-reliability` 为基线单独评审，尚未合入。本节记录整改，不把基线测试通过当作修改后的验证。

**2026-10-14 自查更正：不能认定 HYG-01～14 已全部关闭。** 下表是首轮实现与已有测试；逐项重读验收后确认了录音入口、Skill 目录所有权、Adapter 坏协议清理的残留问题，以及归档取消接线和部分验收证据缺口，见 §8.3。此前“整改完成”仅能表示首轮修改和门禁完成，不代表发现全部解决。

| 编号 | 实现结果 | 回归证据 |
|---|---|---|
| HYG-01 | 会话 ID 穿过 transport/preload/主进程；仅缺省字段使用默认值，显式非法值拒绝 | `apps/desktop/test/turn-session.test.ts`：两会话与非法 ID |
| HYG-02 | HTTP 写入失败拒绝 Promise、显示错误、保持本地列表与活跃会话；已完成删除不因替代会话创建失败而回滚 | `packages/api-client/test/sessions.test.ts`：401/503 与删除后创建失败 |
| HYG-03 | 权限申请使用代次失效；初始化失败逐资源清理；scope 释放丢弃片段并取消转写 | `packages/api-client/test/voice-input-lifecycle.test.ts`：迟到授权、重启、清理失败、卸载 |
| HYG-04 | SQL 先按激活状态排序再限制结果；四类仓储共用事务激活/删除逻辑和稳定回退 | `packages/repositories/test/preset-lifecycle.test.ts`：第 51 个预设、激活、删除、无激活回退 |
| HYG-05 | 本地安装在写盘前拒绝插件/只读注册冲突；仓储更新校验原所有权并以条件更新避免覆盖已变更归属 | API Skill 与仓储 Skill 测试：overwrite 两种取值、跨所有者冲突与合法更新 |
| HYG-06/07 | 握手失败等待子进程终止；幂等 close 有截止与强制终止；迭代 finally 清理请求 timer | stdio Adapter 测试：PID 存活检查、真实请求超时、提前退出后再次运行 |
| HYG-08 | 停止调度后限时排空任务与 IPC；成功排空后关闭 DB，超时非零退出；成功停止后可重启 | WorkerHost 屏障任务、重复 stop、超时、禁止重排与重启用例 |
| HYG-09 | Plugin/Skill/Persona 使用共享归档 Worker；声明与实际展开均有界、校验 CRC，Persona 内嵌 ZIP 消耗剩余预算 | archive-worker、skills、persona-api、plugin-distribution 回归 |
| HYG-10 | 补 UI/launcher 触发路径、独立 Chromium E2E job、启动脚本语法与参数透传守卫 | `scripts/ci-scope.test.mjs`、`scripts/check-launchers.test.mjs` |
| HYG-11 | 升级直接依赖，精确重定向受影响间接版本；适配 Drizzle cause 错误与 SQL 参数脱敏补丁；增加独立依赖审计 CI 与限期例外机制 | `pnpm check:dependency-audit`；剩余项见下表 |
| HYG-12 | 删除报告确认的 7 个函数及独占导入 | 引用复查、构建与全量代码门禁 |
| HYG-13 | 清除全部 32 处空条件、当前实现中的失效租户描述及 Playwright 旧请求头 | 精确扫描；保留历史迁移、兼容测试与持久化格式 |
| HYG-14 | Vite vendor 拆包策略单源化并进入 Turbo 哈希；三个守卫共用遍历器并保留各自策略 | Web/Desktop 构建、边界守卫和 CI scope 回归 |

### 8.1 依赖复查

整改前为 55 条公告记录，2026-10-14 复查后为 **3 条中危记录、0 高危、0 严重**，共覆盖 4 条已审阅依赖路径。这不是可利用性证明；开发依赖也包含会随桌面产品交付的 Electron，已单独升级。当前 `[公告, 包, 版本, 路径]` 的临时例外保存在[审计例外文件](../../scripts/dependency-audit-exceptions.json)，到期日均为 **2026-11-13**；新增命中、过期或已失效例外使门禁失败。失效路径逐条检查，不因同一例外的其他路径仍命中而忽略；非法日历日期和错误例外结构同样拒绝。

| 剩余包 | 范围与判断 | 下一步 |
|---|---|---|
| esbuild 0.18.20 | Drizzle Kit 的旧 loader 传递依赖；已核对调用 transform，未开放公告涉及的开发服务器 | 跟踪上游 loader 替换，不跨主版本强制覆盖 |
| uuid 7.0.3 | Capacitor/Xcode 构建工具调用 v4 生成本地工程 ID；公告涉及提供外部 buffer 的 v3/v5/v6 | 跟踪 xcode 兼容升级，移动发行前复查 |
| sprintf-js 1.1.3 | Electron 构建工具可选下载代理日志链；global-agent 使用固定格式文案与结构化网络字段 | 本次查询 registry 尚无公告所述 1.1.4；桌面打包发行前复查 |

### 8.2 修改后的验证与交付

2026-10-14 接续复核并完成最终验证，以下命令均已记录退出码 0：

| 验证 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 根目录锁文件安装通过，包含 Drizzle 脱敏补丁 |
| `./aervox ci all` | 全量代码和文档门禁通过；build 27/27、typecheck 46/46、test 45/45 个 Turbo 任务成功，分别复用 24、44、39 个缓存任务；含 Rust fmt/test/clippy 与 Native smoke |
| API / 仓储全量测试 | API 81 文件、575 项；仓储 67 文件、402 项；本轮实际运行 |
| 文档门禁 | 22 个脚本测试、67 份文档，Markdown/Vale/本地链接 0 错误 |
| API / UI / CLI 集成 | 45 / 4 / 2 项通过；两个 Playwright 入口使用独立临时产物目录 |
| `pnpm check:dependency-audit` | 0 未审阅路径，4 已审阅路径，0 过期或失效例外；余项见 §8.1 |
| 依赖审计脚本回归 | 4 项通过，含部分失效路径、非法日期、错误结构和错误响应拒绝 |

Drizzle 升级后的回归同时验证底层原因、事务回滚数据和 ESM/CJS 参数脱敏。Desktop 会话、录音迟到授权/卸载、stdio Adapter、Worker 排空、四类预设、Skill 所有权和共享归档测试均已纳入全量门禁。精确扫描确认报告中的 7 个死函数和 32 处空 `and()` 已清除；Host Agent 保留 2 项既有条件跳过，不计为通过。

整改验证摘要追加在[证据快照](../_meta/repository-hygiene-audit-2026-10-13.json)的 `remediation` 字段；本轮日志存于工作树 `artifacts/repository-hygiene-2026-10-14/`，不入 Git。原始审计数据保持为整改前快照；本地终审不等同于远端 CI 或 PR 已合入。

验证不代表真实模型、麦克风硬件、操作系统打包/签名或正式发布验收，也不代表 ITER-013 等关联迭代整体完成。未执行数据库迁移、生产停机或数据删除。

### 8.3 逐项自查：未完整关闭

本轮审查提交为 `f63a3c86`。其远端 CI、Docs、API/UI E2E、依赖审计和三平台 Native 检查均已成功；以下残留仍能复现，说明现有门禁不足以证明发现全部关闭。本轮只复核和更正状态，未修改这些生产实现。

| 编号 | 自查结论 | 尚缺内容或依据 |
|---|---|---|
| HYG-01 | 原会话 ID 丢弃已修；跨层验收未齐 | 双会话测试止于模拟 IPC 和 ID 解析，未断言真实主进程请求 URL、两份历史和项目关联 |
| HYG-02 | 原写入失败伪成功已修 | 401/503 保留原状态，删除成功但替代创建失败保留删除结果；UI 有错误展示 |
| HYG-03 | 部分修复，仍有入口缺陷 | 底层 stop 和 scope dispose 已修；工作台等待授权时的键盘输入、再次点击和收起输入框均未触发取消 |
| HYG-04 | 原选择错误已修；写入验收未齐 | 四类仓储覆盖第 51 项读取、激活、删除和无激活回退；专门回归尚未断言 `saveConfig` 修改第 51 项且第一项不变 |
| HYG-05 | 部分修复，目录所有权仍可越界 | 同名注册保护有效；本地 Skill 名称与插件 ID 重合时，覆盖操作仍能递归删除插件技能目录 |
| HYG-06 | 原握手拒绝泄漏已修 | 工厂拒绝会等待进程退出；准入后的异常清理仍有 HYG-07 所列差量 |
| HYG-07 | 原旧计时器误杀已修，协议失败清理未齐 | 提前结束迭代会清 timer；坏协议只标记 unavailable，finally 随后清 timer，子进程继续存活 |
| HYG-08 | 原排空缺口已修；入口验收未齐 | 在途任务、挂起、重复 stop 与重启已有回归；真实退出信号下数据库关闭顺序和非零退出码尚无进程级断言 |
| HYG-09 | 预算已统一，业务取消未接通 | 共享 Worker 支持 signal 且有测试，但 Plugin/Skill/Persona 业务入口未把取消信号传入；不能据 helper 测试宣布三个入口均支持取消 |
| HYG-10 | 原 CI 覆盖缺口已修 | 触发路径与启动脚本回归已补，远端 UI E2E 成功；API E2E 保持原观察期策略 |
| HYG-11 | 治理已补，依赖告警未清零 | 仍有 §8.1 的 3 项中危限期例外，不能记为告警消除 |
| HYG-12 | 报告指定的删除项已完成 | 7 个死函数及其独占导入已删除；未扩大为公开 API 的批量删除 |
| HYG-13 | 报告指定的残留已清理 | 32 处空条件、指定旧描述和 Playwright 全局旧请求头已清除；不等于全仓历史术语归零 |
| HYG-14 | 指定重复实现已收敛 | 拆包策略进入 Turbo 哈希；三类守卫共享遍历机制并保留参数策略 |

#### 已确认的实现残留

1. **P1 · HYG-05：本地覆盖能删除插件技能正文。** [安装逻辑](../../apps/api/src/modules/ecosystem/skills/skill-manager.ts) 130～145 行只查询与本地 Skill 同名的注册，再递归删除 `<skillsRoot>/<name>`；[插件写盘](../../apps/api/src/modules/ecosystem/plugins/service.ts) 使用 `<skillsRoot>/<pluginId>/<skillName>`。临时 API/SQLite 实验先安装 `flashcards` 插件和只读 `flashcard-review`，再以 `name=flashcards, overwrite=true` 安装本地 ZIP：接口返回 201，原技能注册仍为 readonly=1，正文文件已不存在。须在删除/替换前核对整个目录的所有权，覆盖插件 ID 与本地名称碰撞场景。
2. **P2 · HYG-03：工作台无法取消等待中的录音。** [Composer](../../packages/ui/src/composables/useWorkbenchComposer.ts) 的 toggle、键盘和收起逻辑只判断 `isListening`。分别执行启动→等待授权→键盘输入/再次点击/收起→授权返回，三次均观察到 `isListening=true`、已停止音轨数为 0。底层有代次失效并不足够；应把等待配置/权限阶段纳入 UI 生命周期和停止接线。
3. **P2 · HYG-07：坏协议使驱动失效但不终止进程。** [stdio Adapter](../../packages/host-agent/src/stdio-adapter.ts) 151～155 行在解码失败时只调用 `failUnavailable`；迭代 finally 又清除请求截止。受控子进程完成准入后发送非法 JSON，消费端收到 `adapter_unavailable`，超过原请求截止后 PID 仍存活，直至实验显式调用 close。不可恢复的协议失败应进入统一有界关闭路径。

#### 接线与证据缺口

[Skill 安装](../../apps/api/src/modules/ecosystem/skills/skill-manager.ts) 87～88 行调用 `unzip(zipData)`，[Persona 解包](../../apps/api/src/modules/companion/persona/bundle.ts) 141～142 行和[插件解包](../../apps/api/src/modules/ecosystem/plugins/package-bundle.ts) 43～44 行均不传 signal；路由也未建立相应取消传递。HYG-09 的静态缺口与已复现实现残留分别记录，未声称已经完成断连实验。HYG-01/04/08 的证据缺口同样不直接等同于确认运行失败。

5 个隔离复现用例（录音 3、目录所有权 1、Adapter 1）均成功复现坏行为；这些断言不是修复验收通过。用例、日志和结果保存在 `artifacts/repository-hygiene-selfcheck-2026-10-14/`，未把“期望坏行为”的临时用例加入正常测试套件；实验使用临时目录/库，结束后关闭音轨和子进程。长期摘要追加在证据快照的 `remediation.selfReview` 中。
